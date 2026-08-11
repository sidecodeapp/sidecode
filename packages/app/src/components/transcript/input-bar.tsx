import { eq, useLiveQuery } from "@tanstack/react-db";
import {
  type CommandContext,
  DEFAULT_MODEL,
  getCommandsForContext,
  type ImageAttachment,
  MODELS,
} from "@thinkite/protocol";
import { ContextMenu, type MenuAction } from "@yyq1025/react-native-nitro-menu";
import { GlassView } from "expo-glass-effect";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { SymbolView } from "expo-symbols";
import { useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { SlashPanel } from "@/components/transcript/slash-panel";
import { useContextUsage } from "@/hooks/use-context-usage";
import { useSlashCommandHandler } from "@/hooks/use-slash-command-handler";
import { statusColor, useDaemonClient } from "@/lib/daemon-client-context";
import { useSessionTurnResult } from "@/lib/session-turn-result";
import {
  sessionStateCollection,
  updateSessionModel,
} from "@/lib/sessions-collection";
import { Image } from "@/lib/styled";

/** Stable no-op passthrough for the (theoretical) no-`onSend` case, so the
 *  internal slash-handler's callback identity doesn't churn per render. */
const NOOP_SEND = () => {};

/**
 * Local-only id so the pill row can have stable React keys + a cheap
 * remove path; never sent to the daemon (protocol's ImageAttachment
 * is just {data, mediaType}). Generated with a monotonic counter so we
 * don't pull in a UUID lib for what's effectively a render hint.
 */
interface DraftAttachment extends ImageAttachment {
  id: string;
}

/**
 * Color for the context meter fill on the model picker chip. Three
 * tiers tuned to feel informational at low usage and clearly warn near
 * the cap:
 *
 *   - <70%: iOS system blue — visible as a "this exists, it's
 *     tracking" signal without alarming. Lighter opacity in light
 *     mode (chip background `bg-black/5` is pale, so blue at 0.30
 *     reads too saturated); kept at 0.30 in dark mode (chip
 *     `bg-white/10` needs more contrast).
 *   - 70–90%: amber — "you should consider /compact soon."
 *   - ≥90%: red — "next turn likely to auto-compact or get clipped."
 *
 * Warning tiers (amber/red) use a single opacity on both themes — both
 * read as alarming enough either way. Only the informational blue
 * needs the theme-aware split.
 *
 * Thresholds are picked to roughly mirror Claude Code's auto-compact
 * heuristic — Claude Code starts surfacing context warnings in the
 * mid-70s and aggressively compacts in the high 80s/90s.
 */
function meterFillColor(percentage: number, isDark: boolean): string {
  if (percentage >= 90) return "rgba(239, 68, 68, 0.50)"; // red-500
  if (percentage >= 70) return "rgba(245, 158, 11, 0.40)"; // amber-500
  // iOS systemBlue (#007aff)
  return isDark ? "rgba(0, 122, 255, 0.30)" : "rgba(0, 122, 255, 0.18)";
}

/** Format a token count as a short string for the picker menu's
 *  `Context usage: 145k / 200k` header. Switches to `M` once values
 *  hit a million so the 1M-context variant reads as "1M" rather than
 *  "1000k". Round (not floor) so the displayed number tracks intuition
 *  near boundaries; the meter bar's fill width carries the fine-
 *  grained accuracy visually. Drops `.0` so `1_000_000` shows as `1M`
 *  not `1.0M`; keeps one decimal for non-integer M values
 *  (e.g. `1_500_000` → `1.5M`). */
function formatTokensK(n: number): string {
  if (n >= 1_000_000) {
    return `${Number((n / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(n / 1000)}k`;
}

/** Compose Anthropic Claude 4.x's vision input cap: long edge 2576px,
 *  ≤3.75MP. We resize the long edge then let JPEG q0.85 do the bytes
 *  work; SDK accepts base64 inline so daemon writes nothing to disk. */
const MAX_LONG_EDGE = 2576;
const JPEG_QUALITY = 0.85;
/** Total draft attachment cap per message. 8 = Opus 4.7 high-res
 *  budget headroom (4K tok/image × 8 = 32K of a 200K window) +
 *  matches PHPicker's single-pick max so users hit the cap in one
 *  Photos tap, not by re-tapping `+` repeatedly. Tune in one spot. */
const MAX_TOTAL_IMAGES = 8;

async function compressToAttachment(
  uri: string,
  width: number,
  height: number,
): Promise<ImageAttachment> {
  // Resize only when needed — sub-2576px shots skip the manipulator
  // round-trip entirely. Supplying just one of width/height preserves
  // aspect ratio automatically.
  const needsResize = Math.max(width, height) > MAX_LONG_EDGE;
  const actions = needsResize
    ? [
        width >= height
          ? { resize: { width: MAX_LONG_EDGE } }
          : { resize: { height: MAX_LONG_EDGE } },
      ]
    : [];
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: JPEG_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG, // HEIC / PNG auto-transcoded
    base64: true,
  });
  return {
    data: result.base64 ?? "",
    mediaType: "image/jpeg",
  };
}

/**
 * Chat input bar — pill-shaped GlassView with optional attachment
 * pill row + text input + action row (plus + model chip | spacer | send).
 *
 * Self-sourcing: pass `cliSessionId` and InputBar derives EVERYTHING it
 * can from it — the model picker / context meter / running state (from the
 * session's collections, or a local draft when `cliSessionId` is null =
 * new-session), the slash-command context + interception (internal
 * `useSlashCommandHandler`, context derived from cliSessionId presence),
 * and interrupt (`daemonClient.interrupt(cliSessionId)`). The ONLY prop is
 * `onSend` — the screen-specific "what does sending mean here" action
 * (new-session: createSession + navigate; detail: optimistic sendPrompt),
 * which InputBar can't own (routing / pre-create cwd are screen state).
 * `onSend` receives only REAL sends — slash commands are intercepted
 * internally and never reach it.
 *
 * The send button has two icon states (+ a disabled/dimmed idle):
 *   - `arrow.up` (active): user has text OR attached images, tap → onSend.
 *     Empty composer → same arrow, but disabled + dimmed (`sendActive`).
 *   - `stop.fill` (running): turn is in flight, tap → interrupt (internal)
 * Offline → disabled + dimmed in every state (write gate); a status dot
 * sits just left of the button. (The old `waveform` voice slot was dropped.)
 *
 * Attachment flow: `+` button opens a native attachment menu (Camera
 * / Photos via the nitro tap menu `@yyq1025/react-native-nitro-menu` —
 * a pure-UIKit UIButton+UIMenu, NOT @expo/ui/community/menu, which wraps
 * SwiftUI Menu in a UIHostingController and conflicts with iOS 14+ auto
 * keyboard avoidance, drifting the trigger above sibling icons on first
 * keyboard show under system IME); picked assets are compressed (long
 * edge 2576 / JPEG q0.85) and shown as a horizontal pill row above the
 * TextInput until the user sends or removes them. Cap: 8 images per
 * message (Opus 4.7 vision token budget).
 *
 * Liquid Glass requires iOS 26+. On older iOS / Android the GlassView
 * silently falls back to a plain View; the inline `backgroundColor`
 * provides the fallback fill so the surface stays visible.
 */
export function InputBar({
  cliSessionId,
  onSend,
}: {
  /** The session this composer drives, or `null` on the new-session
   *  screen (no session exists yet). The single source InputBar derives
   *  everything from:
   *    - non-null → model + running state from the #17
   *      `sessionStateCollection` row, context meter from the
   *      transcript-fed `sessionTurnResultCollection` (latestUsage),
   *      slash context = "in-session", interrupt = interrupt(cliSessionId).
   *    - null → local draft model (seeded DEFAULT_MODEL); not running; no
   *      context meter; slash context = "new-session"; no interrupt. The
   *      draft pick rides out on `onSend`'s `model` arg. */
  cliSessionId: string | null;
  /** Fired ONLY on a real (non-slash) send — slash commands are
   *  intercepted internally and never reach here. `images` carries the
   *  compressed base64 payloads (local DraftAttachment ids stripped);
   *  `model` is the current picker selection — the parent forwards it into
   *  `createSession` (new-session) / `sendPrompt` (resume seed). Send is
   *  gated by hasText OR images.length > 0 so an images-only message is
   *  valid (Claude vision accepts that).
   *
   *  This is the one prop InputBar can't self-source: "what sending means
   *  here" is screen-specific orchestration (new-session: createSession +
   *  router.replace to the new session, using the cwd picked on that
   *  screen; detail: optimistic sendUserMessage). Return `false` is
   *  unused by callers today but kept in the type for symmetry. */
  onSend?: (
    text: string,
    images: ImageAttachment[] | undefined,
    model: string,
    // biome-ignore lint/suspicious/noConfusingVoidType: optional-return callback — `| undefined` would reject the void-returning handlers callers pass
  ) => boolean | void;
}) {
  const { client, connectionStatus } = useDaemonClient();
  // Write gate: only an established transport (online) accepts sends /
  // interrupts. connecting / offline / error all gate. The facade also
  // fail-fasts these RPCs (OfflineError) as a backstop, but disabling the
  // affordance here is the primary prevention — no optimistic bubble, no
  // hung promise. Reads (model draft, attachments) stay usable offline.
  const online = connectionStatus === "online";
  const [text, setText] = useState("");
  const [images, setImages] = useState<DraftAttachment[]>([]);

  // ─── Self-sourced session state ─────────────────────────────────────
  // Detail (cliSessionId non-null): derive the picker model + running
  // state from the session's #17 sessionStateCollection row, and the
  // context meter from the transcript-fed sessionTurnResultCollection
  // (latestUsage). New-session (null): local draft model, not running, no
  // meter. A picked model commits via `updateSessionModel` (optimistic +
  // RPC) when a session exists, else just updates the draft (which leaves
  // on `onSend`'s model arg).
  const [draftModel, setDraftModel] = useState(DEFAULT_MODEL.model);
  const { data: sessionRow } = useLiveQuery(
    (q) =>
      cliSessionId
        ? q
            .from({ s: sessionStateCollection })
            .where(({ s }) => eq(s.cliSessionId, cliSessionId))
            .findOne()
        : null,
    [cliSessionId],
  );
  const turnResult = useSessionTurnResult(cliSessionId);
  const model = cliSessionId
    ? (sessionRow?.model ?? DEFAULT_MODEL.model)
    : draftModel;
  // Running-state is daemon-authoritative (#17 sessionState.activity), not
  // a separate client signal anymore.
  const isRunning = cliSessionId ? sessionRow?.activity === "running" : false;
  const contextUsage = useContextUsage(
    cliSessionId ? turnResult.latestUsage : null,
    model,
  );
  const onPickModel = (m: string) => {
    if (cliSessionId) updateSessionModel({ cliSessionId, model: m });
    else setDraftModel(m);
  };

  // ─── Slash-command interception (internal) ──────────────────────────
  // Context is derived 1:1 from cliSessionId presence; the handler wraps
  // `onSend` so slash commands (/clear, /model) are intercepted +
  // dispatched here and never reach `onSend` (only real sends do). Tap-to-
  // send calls `handleSend`, not `onSend` directly.
  const slashContext: CommandContext = cliSessionId
    ? "in-session"
    : "new-session";
  const handleSend = useSlashCommandHandler(
    cliSessionId
      ? {
          context: "in-session",
          sessionId: cliSessionId,
          onPassthrough: onSend ?? NOOP_SEND,
        }
      : { context: "new-session", onPassthrough: onSend ?? NOOP_SEND },
  );

  // Tracks the TextInput's text cursor / selection range. Powers the
  // cursor-aware slash trigger: panel opens only when the segment from
  // start-of-text up to the cursor starts with `/` and has no space.
  // Lets the user cursor BACK into a command name to re-open the picker
  // after they've typed parameter text (e.g. fix a typo in `/modle`).
  const [textCursor, setTextCursor] = useState({ start: 0, end: 0 });
  const draftIdRef = useRef(0);
  const colorScheme = useColorScheme() ?? "light";
  const hasText = text.length > 0;

  // ─── Slash-command picker state ──────────────────────────────────────
  // Compute the prefix segment (start-of-text → cursor) and whether
  // we're in slash mode at all. Both are cheap O(n) string ops; no
  // need to memoize.
  const beforeCursor = text.slice(0, textCursor.start);
  const isCommandMode =
    beforeCursor.startsWith("/") && !beforeCursor.includes(" ");
  const commandPrefix = isCommandMode ? beforeCursor.slice(1) : "";
  // Filter the context's allowed commands by the live prefix. Memoize
  // since the filter result drives a list render — stable identity
  // helps the panel skip work when only `text` after a space changes.
  const filteredCommands = useMemo(
    () =>
      getCommandsForContext(slashContext).filter((c) =>
        c.name.startsWith(commandPrefix),
      ),
    [slashContext, commandPrefix],
  );

  // IDE-style replace on pick: swap ONLY the command-name segment (from
  // `/` through the first space, or to end of text if no space), keep
  // any parameter text after that space. So `/mo|del claude-opus` +
  // pick `/model` → `/model claude-opus`, cursor at start of params.
  const pickCommand = (cmdName: string) => {
    const firstSpace = text.indexOf(" ");
    const head = `/${cmdName}`;
    const tail = firstSpace >= 0 ? text.slice(firstSpace) : " ";
    setText(head + tail);
    const cursor = head.length + 1; // right after `/cmd ` — at param start
    setTextCursor({ start: cursor, end: cursor });
  };

  const currentModel = MODELS.find((m) => m.model === model);
  // Cap is enforced in three places: PHPicker's selectionLimit
  // (per-pick), Camera early-return guard, and the attachment menu's
  // `disabled` attribute. We DON'T dim the `+` button itself — the menu
  // will grow other non-image items (doc, snippet, etc.) that
  // shouldn't be blocked just because the image cap is hit.
  const remainingSlots = MAX_TOTAL_IMAGES - images.length;
  const canAdd = remainingSlots > 0;

  const addAttachments = (atts: ImageAttachment[]) => {
    setImages((prev) => [
      ...prev,
      ...atts.map((a) => ({ ...a, id: `att-${draftIdRef.current++}` })),
    ]);
  };

  const removeAttachment = (id: string) => {
    setImages((prev) => prev.filter((a) => a.id !== id));
  };

  const pickFromCamera = async () => {
    if (!canAdd) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 1, // full quality from native picker; we compress after
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    const att = await compressToAttachment(
      asset.uri,
      asset.width,
      asset.height,
    );
    addAttachments([att]);
  };

  const pickFromLibrary = async () => {
    if (!canAdd) return;
    // PHPicker (iOS 14+) doesn't require library permission for read,
    // but `launchImageLibraryAsync` still pings the permission API on
    // older flows / Android — letting it self-prompt is the cleanest path.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      // Dynamic cap: only let the user pick the remaining slots so they
      // can't blow past MAX_TOTAL_IMAGES in a single multi-select pass.
      selectionLimit: remainingSlots,
      quality: 1,
    });
    if (result.canceled) return;
    const compressed = await Promise.all(
      result.assets.map((a) => compressToAttachment(a.uri, a.width, a.height)),
    );
    addAttachments(compressed);
  };

  // Images-only messages are valid (Claude vision can answer "what's
  // in this image" without any text), so the send button activates as
  // soon as EITHER text OR images is non-empty.
  const canSend = hasText || images.length > 0;

  const handlePress = () => {
    // Write gate: offline → no send, no interrupt (both need a live
    // round-trip to the daemon and would otherwise hang / accidental-queue).
    // The button is also visually disabled below; this is the logic guard.
    if (!online) return;
    if (isRunning) {
      // Interrupt the in-flight turn (only a session that exists can be
      // running). Best-effort — interrupt is idempotent daemon-side.
      if (cliSessionId) {
        void client.interrupt(cliSessionId).catch((err) => {
          console.error("interrupt failed", err);
        });
      }
      return;
    }
    if (!canSend) return;
    // Strip local-only `id` field before handing off — daemon protocol
    // only knows {data, mediaType}.
    const payload: ImageAttachment[] | undefined =
      images.length > 0
        ? images.map(({ data, mediaType }) => ({ data, mediaType }))
        : undefined;
    // `model` rides out so `onSend` can seed createSession (new-session)
    // / sendPrompt (resume respawn-inherit). Mid-session model APPLY is
    // owned by `updateSessionModel` at pick time (onPickModel); this arg
    // is only the seed value.
    // `handleSend` (internal slash pipeline) returns `false` to signal
    // "rejected, keep input" (slash command not whitelisted / wrong
    // screen / invalid arg). Anything else = "consumed, clear input".
    // Real (non-slash) sends pass through to `onSend`.
    const result = handleSend(text, payload, model);
    if (result === false) return;
    setText("");
    setImages([]);
    // textCursor doesn't need an explicit reset: iOS clamps the
    // selection when value shrinks and fires onSelectionChange with the
    // clamped position, which React then writes back into state.
  };

  const sendIconName: "arrow.up" | "stop.fill" = isRunning
    ? "stop.fill"
    : "arrow.up";
  // The send button is actionable only when online AND there's something
  // to do (text/images to send, or a running turn to interrupt). Empty
  // composer or offline → dimmed + disabled. (Replaces the old `waveform`
  // idle state — the voice/recording slot was dropped.)
  const sendActive = online && (canSend || isRunning);

  return (
    <View className="px-4">
      {/* SlashPanel as absolute overlay above the composer.
          `bottom-full` anchors the panel's bottom edge to the top of
          this wrap (outside, above); `pb-2` adds the 8pt gap to the
          GlassView below. Briefly obscures GitStatusBar (a sibling
          above InputBar in ChatPanel) — acceptable trade since slash
          mode is a focused state. `pointerEvents="box-none"` lets
          taps outside the panel's rows pass through (e.g. dismissing
          the keyboard). */}
      {isCommandMode && (
        <View
          pointerEvents="box-none"
          // `bottom-full` = bottom:100% → panel's bottom edge sits at
          // the top of this wrap (outside it, above). `left-4 right-4`
          // matches the wrap's px-4 padding so the panel aligns with
          // the GlassView below. `pb-2` adds the 8pt visual gap.
          className="absolute left-4 right-4 bottom-full pb-2"
        >
          <SlashPanel commands={filteredCommands} onPick={pickCommand} />
        </View>
      )}
      <GlassView
        isInteractive
        glassEffectStyle="regular"
        style={{
          borderRadius: 24,
          borderCurve: "continuous",
          // Fallback for iOS<26 / Android — GlassView degrades to plain
          // View, this color shows through. On iOS 26+ it sits behind the
          // Liquid Glass material and is mostly invisible.
          backgroundColor:
            colorScheme === "dark"
              ? "rgba(28,28,30,0.6)"
              : "rgba(255,255,255,0.6)",
        }}
      >
        <View className="py-3 gap-3 rounded-3xl border-continuous overflow-hidden">
          {/* Attachment pill row — only when there are draft images.
              Horizontal scroll so 8 thumbs fit on narrow screens. The
              X badge sits INSIDE each thumbnail's bounds (not negative
              margin) so the ScrollView doesn't clip it. */}
          {images.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 px-3 min-w-full"
            >
              {images.map((img) => (
                <View key={img.id} className="relative">
                  <Image
                    source={{
                      uri: `data:${img.mediaType};base64,${img.data}`,
                    }}
                    className="size-20 rounded-xl border-[0.5px] border-gray-300 dark:border-gray-700"
                    contentFit="cover"
                  />
                  <Pressable
                    onPress={() => removeAttachment(img.id)}
                    hitSlop={8}
                    className="absolute top-1 right-1 size-6 items-center justify-center rounded-full bg-black/75"
                  >
                    <SymbolView
                      name="xmark"
                      size={12}
                      weight="bold"
                      tintColor="#ffffff"
                    />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          <TextInput
            multiline
            numberOfLines={5}
            value={text}
            onChangeText={setText}
            // Track cursor / selection so the slash picker can detect
            // command mode (start-of-text→cursor prefix). Cheap — fires
            // on any cursor move incl. typing.
            selection={textCursor}
            onSelectionChange={(e) => setTextCursor(e.nativeEvent.selection)}
            placeholder="Reply to Claude"
            // placeholderTextColor is a native prop with no className
            // equivalent — keep the colorScheme ternary for this one.
            placeholderTextColor={
              colorScheme === "dark" ? "#71717a" : "#a1a1aa"
            }
            className="text-base px-3 py-[2.5px] text-zinc-950 dark:text-zinc-50"
          />
          <View className="px-3 flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              {/* `+` button → native attachment menu via the nitro tap menu
                  (a transparent showsMenuAsPrimaryAction UIButton + UIMenu on
                  iOS, PopupMenu on Android — pure UIKit, no UIHostingController,
                  so it stays put on first keyboard show; that immunity is why
                  we don't use @expo/ui here). The trigger content renders under
                  the overlay button (so a plain View, not a Pressable); tapping
                  fires `onPressAction` with the `actionKey`. No `imageColor`
                  needed — UIKit template-tints the SF Symbol. */}
              <ContextMenu
                trigger="tap"
                menuConfig={{
                  items: [
                    {
                      actionKey: "library",
                      title: "Photos",
                      image: { systemName: "photo.on.rectangle" },
                      attributes: canAdd ? [] : ["disabled"],
                    },
                    {
                      actionKey: "camera",
                      title: "Camera",
                      image: { systemName: "camera" },
                      attributes: canAdd ? [] : ["disabled"],
                    },
                  ],
                }}
                onPressAction={(actionKey) => {
                  if (actionKey === "camera") pickFromCamera();
                  else if (actionKey === "library") pickFromLibrary();
                }}
              >
                <View className="p-1.75 rounded-full bg-black/5 dark:bg-white/10">
                  <SymbolView
                    name="plus"
                    size={22}
                    weight="regular"
                    tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
                  />
                </View>
              </ContextMenu>
              {/* Model picker chip — flat nitro tap menu (UIMenu on iOS,
                  PopupMenu on Android). One row per non-deprecated model from
                  the bundled MODELS table; `state: "on"` on the active row
                  gives the native ✓. Effort isn't exposed (sidecode V0 trusts
                  SDK adaptive thinking + per-account Settings.effortLevel). */}
              <ContextMenu
                trigger="tap"
                menuConfig={{
                  // Menu-level title — the root UIMenu's `title` renders as a
                  // greyed header above the action rows. Surfaces the meter's
                  // exact numbers (the chip fill alone reads as % only).
                  // Omitted when contextUsage is undefined so the menu doesn't
                  // show an empty header on new-session / pre-first-turn states.
                  title: contextUsage
                    ? `Context usage: ${formatTokensK(contextUsage.used)} / ${formatTokensK(contextUsage.max)}`
                    : undefined,
                  items: MODELS.map<MenuAction>((m) => ({
                    actionKey: m.model,
                    title: m.displayName,
                    state: m.model === model ? "on" : "off",
                  })),
                }}
                onPressAction={(actionKey) => {
                  onPickModel(actionKey);
                }}
              >
                {/* Context meter — fills the chip background left→right
                    proportional to context-window usage. `overflow-hidden`
                    clips the absolute fill to the rounded-full silhouette;
                    the fill is the FIRST child so the Text label naturally
                    layers on top (RN sibling order = z-order). No extra
                    layout cost when `contextUsage` is undefined — the
                    null branch skips the absolute View entirely. */}
                <View className="relative flex-row items-center gap-1 px-3 py-2 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                  {contextUsage && (
                    <View
                      className="absolute inset-y-0 left-0"
                      style={{
                        width: `${contextUsage.percentage}%`,
                        backgroundColor: meterFillColor(
                          contextUsage.percentage,
                          colorScheme === "dark",
                        ),
                      }}
                    />
                  )}
                  <Text className="text-sm text-zinc-700 dark:text-zinc-200">
                    {currentModel?.displayName ?? "Model"}
                  </Text>
                </View>
              </ContextMenu>
            </View>
            <View className="flex-row items-center gap-3">
              {/* Write-gate status dot — sits just left of send, shown only
                  when NOT online (connecting/offline = gray, error = red, per
                  statusColor). Signals "composer can't send right now"; the
                  send button beside it is disabled + dimmed. */}
              {!online && (
                <View
                  className="size-2 rounded-full"
                  style={{ backgroundColor: statusColor(connectionStatus) }}
                />
              )}
              <Pressable
                onPress={handlePress}
                disabled={!sendActive}
                style={{ opacity: sendActive ? 1 : 0.4 }}
                className="p-1.75 items-center justify-center rounded-full bg-zinc-900 dark:bg-zinc-100"
              >
                <SymbolView
                  name={sendIconName}
                  size={22}
                  weight="semibold"
                  tintColor={colorScheme === "dark" ? "#0a0a0a" : "#fafafa"}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </GlassView>
    </View>
  );
}
