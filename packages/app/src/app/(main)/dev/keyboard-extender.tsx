import {
  getCommandsForContext,
  isWhitelistedCommand,
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashCommandSpec,
} from "@thinkite/protocol";
import * as Burnt from "burnt";
import { GlassView } from "expo-glass-effect";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import {
  KeyboardBackgroundView,
  KeyboardStickyView,
  useKeyboardAnimation,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Dev spike — slash-command UX experiments. Two threads:
 *
 * 1. KeyboardExtender → KSV + KeyboardBackgroundView pivot. Keeps
 *    `/`-button tool row attached to the keyboard via KSV. See the
 *    `<AnimatedKeyboardBackgroundView>` block below for the offset /
 *    opacity / pointerEvents trio that hides it when keyboard is down.
 *
 * 2. Slash-command panel positioning. Two designs we tried:
 *
 *    A) Swap GitStatusBar ↔ SlashPanel in the composer slot.
 *       → REJECTED: composer measured height jumps 40 → up to 240pt,
 *         contentInsetEndAdjustment recomputes, transcript shifts
 *         down ~200pt. Feels like the whole UI lurched.
 *
 *    B) **Current: overlay panel above composer top** (this file).
 *       → GitStatusBar stays mounted, composer measured height stays
 *         stable, transcript doesn't move. Panel floats absolute-
 *         positioned over the composer top with `bottom: COMPOSER_
 *         VISUAL_HEIGHT + 8`. Hard-capped at PANEL_MAX_HEIGHT (~180pt
 *         for 3 two-line rows) so it fits even on iPhone SE under a
 *         keyboard.
 *
 *    Trigger rule (cursor-aware): take the substring from start of
 *    text up to the cursor, panel shows when THAT segment starts with
 *    `/` AND has no space. Lets the user cursor BACK into the command
 *    name (e.g. to fix a typo) and reopen the panel without clearing
 *    parameter text after it. Mid-text `/` after non-whitespace is a
 *    literal slash (the segment won't start with `/`). Space dismisses.
 */
const TOOL_ROW_HEIGHT = 40;

// Eyeballed visual height of the composer block (GitStatusBar + InputBar
// + their padding). Real ChatPanel measures this dynamically via
// composerRef + onLayout; for the spike we hardcode. If you tweak the
// mocks below, re-measure.
const COMPOSER_VISUAL_HEIGHT = 145;

// 3 rows × ~54pt (title text-sm ~20pt + subtitle text-xs ~16pt + mt-0.5
// 2pt + py-2 16pt) + 8pt vertical scroll padding ≈ 170pt. Lock the cap
// regardless of how many commands match so panel height is predictable
// across devices.
const PANEL_MAX_HEIGHT = 180;

export default function KeyboardExtenderDevScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useColorScheme() === "dark";
  const { progress } = useKeyboardAnimation();
  const isKeyboardVisible = useKeyboardState((s) => s.isVisible);
  // Memoize once — recreating the wrapped component each render is wasteful
  // and would defeat React reconciliation.
  const AnimatedKeyboardBackgroundView = useMemo(
    () => Animated.createAnimatedComponent(KeyboardBackgroundView),
    [],
  );
  const [text, setText] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  // Panel detection is CURSOR-AWARE: only the segment from start of text
  // up to the cursor matters. This way:
  //   - typing `/`, then `m`, then `o`... → panel filters as you type
  //   - typing space after the command name → panel dismisses (entered
  //     parameter mode)
  //   - tapping cursor BACK into the command-name segment (e.g. to fix
  //     a typo in `/modle`) → panel reopens with current prefix
  //   - any `/` AFTER text or whitespace → not treated as a command
  //     trigger (literal slash, e.g. in filepaths)
  const beforeCursor = text.slice(0, selection.start);
  const isCommandMode =
    beforeCursor.startsWith("/") && !beforeCursor.includes(" ");
  const commandPrefix = isCommandMode ? beforeCursor.slice(1) : "";
  // In-session picker for the spike — same data flows into the real
  // ChatPanel later. New-session screen will call the same helper with
  // `"new-session"` and get a 2-entry subset (`/init`, `/review`).
  const filtered = useMemo(
    () =>
      getCommandsForContext("in-session").filter((c) =>
        c.name.startsWith(commandPrefix),
      ),
    [commandPrefix],
  );

  const insertSlash = () => {
    const { start, end } = selection;
    const safeStart = Math.max(0, Math.min(start, text.length));
    const safeEnd = Math.max(safeStart, Math.min(end, text.length));
    const next = `${text.slice(0, safeStart)}/${text.slice(safeEnd)}`;
    setText(next);
    const cursor = safeStart + 1;
    setSelection({ start: cursor, end: cursor });
  };

  // Spike submit handler — wires the paperplane button to demo the
  // full pre-send check via burnt toasts. Real ChatPanel will use a
  // shared `useSlashCommandHandler` hook instead of inlining this.
  const handleSubmit = () => {
    const parsed = parseSlashCommand(text);
    if (!parsed) {
      Burnt.toast({
        title: "Would sendPrompt",
        message: text || "(empty)",
        preset: "none",
        duration: 2,
      });
      return;
    }
    if (!isWhitelistedCommand(parsed.name)) {
      // SPIndicator pill is glanceable single-line by design. No message —
      // user finds the supported list by tapping the `/` button → picker.
      Burnt.toast({
        title: `/${parsed.name} isn't available now`,
        preset: "error",
        haptic: "error",
        duration: 2,
      });
      return;
    }
    const spec = SLASH_COMMANDS[parsed.name];
    if (!spec.contexts.includes("in-session")) {
      Burnt.toast({
        title: `/${parsed.name} not on this screen`,
        preset: "error",
        haptic: "error",
        duration: 2,
      });
      return;
    }
    // Real chat-panel splits here: intercept (clear/model) dispatches
    // locally, passthrough (init/review/compact) calls sendPrompt.
    Burnt.toast({
      title: `Would ${spec.handling}`,
      message: `/${parsed.name}${parsed.args ? ` ${parsed.args}` : ""}`,
      preset: "done",
      duration: 2,
    });
  };

  const pickCommand = (cmd: string) => {
    // IDE-style replace: swap ONLY the command-name segment (from `/`
    // through the first space, or to end of text if no space), keep any
    // parameter text after that space. So `/mo|del claude-opus` →
    // pick `/model` → `/model claude-opus`, cursor at start of params.
    const firstSpace = text.indexOf(" ");
    const head = `/${cmd}`;
    const tail = firstSpace >= 0 ? text.slice(firstSpace) : " ";
    setText(head + tail);
    // Cursor lands right after `/cmd ` — at the parameter start.
    const cursor = head.length + 1;
    setSelection({ start: cursor, end: cursor });
  };

  return (
    <>
      <Stack.Screen options={{ title: "KeyboardExtender spike" }} />
      <View className="flex-1 bg-white dark:bg-black">
        <View className="flex-1 items-center justify-center px-6 gap-6">
          <Text className="text-center text-base text-zinc-600 dark:text-zinc-300">
            Focus the input, then type `/` or tap the `/` button in the tool row
            (only colored accent when cursor is at position 0).
            {"\n\n"}
            Panel hovers ABOVE the composer — GitStatusBar stays mounted so
            composer height doesn't jump. Capped at 3 rows + scroll.
            {"\n\n"}
            Type a space (or cursor past it) to dismiss; cursor back into the
            command name to reopen.
            {"\n\n"}
            Tap paperplane to demo the pre-send check via burnt toast.
          </Text>
          {/* Quick burnt visual preview — fires each preset without
              going through the slash flow. Remove once the real
              chat-panel integration replaces this spike. */}
          <View className="flex-row gap-2">
            <Pressable
              onPress={() =>
                Burnt.toast({
                  title: "Done preset",
                  message: "iOS system-pill style",
                  preset: "done",
                  duration: 2,
                })
              }
              className="px-3 py-2 rounded-lg bg-zinc-200 dark:bg-zinc-800"
            >
              <Text className="text-sm text-zinc-900 dark:text-zinc-100">
                Done
              </Text>
            </Pressable>
            <Pressable
              onPress={() =>
                Burnt.toast({
                  title: "Error preset",
                  message: "Red X icon + error haptic",
                  preset: "error",
                  haptic: "error",
                  duration: 2,
                })
              }
              className="px-3 py-2 rounded-lg bg-zinc-200 dark:bg-zinc-800"
            >
              <Text className="text-sm text-zinc-900 dark:text-zinc-100">
                Error
              </Text>
            </Pressable>
            <Pressable
              onPress={() =>
                Burnt.alert({
                  title: "Alert (HUD)",
                  message: "Center-screen Apple-style HUD",
                  preset: "done",
                  duration: 2,
                })
              }
              className="px-3 py-2 rounded-lg bg-zinc-200 dark:bg-zinc-800"
            >
              <Text className="text-sm text-zinc-900 dark:text-zinc-100">
                Alert HUD
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Single KSV holds the whole composer chrome — panel/git-status,
            InputBar, AND tool row stacked bottom-up. The tool row is the
            bottommost child so it eats the safe-area zone (and 6pt past
            the screen edge on iPhone X+) when keyboard is closed.

            Offsets:
            - closed: TOOL_ROW_HEIGHT - insets.bottom
                = push the whole KSV down by `TR - insets.bottom`. Net
                effect: InputBar bottom lands exactly at insets.bottom
                above screen edge (same as it was without the tool row),
                tool row occupies the safe-area band + 6pt off-screen.
                When insets.bottom = 0 (no home indicator) → push down a
                full 40pt → tool row fully hidden.
            - opened: 0
                tool row's bottom flush with keyboard top, no see-through
                strip between them. */}
        <KeyboardStickyView
          offset={{
            closed: TOOL_ROW_HEIGHT - insets.bottom,
            opened: 0,
          }}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        >
          {/* SlashPanel as OVERLAY — absolute-positioned, sits above
              the composer top with an 8pt gap. Doesn't enter the
              composer's measured height in production (here we use a
              static `COMPOSER_VISUAL_HEIGHT` constant; real ChatPanel
              reads it from contentInsetEndAdjustment SharedValue).

              GitStatusBar stays mounted underneath — visually hidden
              by the panel but layout-stable. */}
          {isCommandMode && (
            <View
              pointerEvents="box-none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: COMPOSER_VISUAL_HEIGHT + TOOL_ROW_HEIGHT + 8,
              }}
            >
              <SlashPanel
                commands={filtered}
                isDark={isDark}
                onPick={pickCommand}
              />
            </View>
          )}

          {/* Composer chrome — always rendered, stable height */}
          <GitStatusBarMock isDark={isDark} />

          <View className="px-4 pb-2">
            <View
              style={{
                borderRadius: 24,
                paddingVertical: 8,
                backgroundColor: isDark
                  ? "rgba(28,28,30,0.6)"
                  : "rgba(255,255,255,0.6)",
              }}
            >
              <TextInput
                multiline
                value={text}
                onChangeText={setText}
                selection={selection}
                onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
                placeholder='Type "/" or tap the / button below'
                placeholderTextColor={isDark ? "#71717a" : "#a1a1aa"}
                autoCorrect={false}
                autoCapitalize="none"
                style={{
                  color: isDark ? "#fafafa" : "#0a0a0a",
                  borderRadius: 12,
                  marginHorizontal: 8,
                  minHeight: 40,
                }}
                className="text-base px-3 py-2"
              />
              <View className="px-3 flex-row items-center justify-between">
                <Text className="text-xs text-zinc-500 dark:text-zinc-400">
                  {isCommandMode
                    ? `/${commandPrefix} · ${filtered.length} match${filtered.length === 1 ? "" : "es"}`
                    : "—"}
                </Text>
                <Pressable className="p-1.75" onPress={handleSubmit}>
                  <SymbolView
                    name="paperplane.fill"
                    size={22}
                    weight="regular"
                    tintColor={isDark ? "#e4e4e7" : "#3f3f46"}
                  />
                </Pressable>
              </View>
            </View>
          </View>

          {/* Tool row — bottommost child of the single KSV. Geometrically
              it occupies the safe-area zone + 6pt off-screen when keyboard
              is closed (see header comment), but visually that band would
              still show the backdrop blur and look like a bug.

              Two-layer hide when closed:
              1. `opacity` animates from 0 → 1 with keyboard progress
                 (lib's documented Android-fallback pattern via
                 `useKeyboardAnimation`).
              2. `pointerEvents` gated on `isKeyboardVisible` — opacity 0
                 alone doesn't block taps in RN, so the invisible band
                 would still capture presses on the `/` button. */}
          <AnimatedKeyboardBackgroundView
            style={{ height: TOOL_ROW_HEIGHT, opacity: progress }}
            pointerEvents={isKeyboardVisible ? "auto" : "none"}
          >
            <View
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                gap: 8,
              }}
            >
              <Pressable
                onPress={insertSlash}
                hitSlop={8}
                style={({ pressed }) => ({
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: pressed
                    ? isDark
                      ? "#3f3f46"
                      : "#e4e4e7"
                    : "transparent",
                })}
              >
                <Text
                  style={{
                    fontSize: 18,
                    fontWeight: "600",
                    // Accent when cursor is at position 0 — tap will
                    // start a slash command (inserted `/` becomes the
                    // first char, panel opens). Muted otherwise — tap
                    // just inserts a literal `/` mid-text.
                    color:
                      selection.start === 0
                        ? "#007aff"
                        : isDark
                          ? "#71717a"
                          : "#a1a1aa",
                  }}
                >
                  /
                </Text>
              </Pressable>
              <Text className="text-xs text-zinc-500 dark:text-zinc-400">
                tools (+ later: 📎 🎤 ctx-meter)
              </Text>
            </View>
          </AnimatedKeyboardBackgroundView>
        </KeyboardStickyView>
      </View>
    </>
  );
}

function SlashPanel({
  commands,
  isDark,
  onPick,
}: {
  commands: readonly SlashCommandSpec[];
  isDark: boolean;
  onPick: (cmd: string) => void;
}) {
  return (
    <View className="px-4">
      <GlassView
        isInteractive
        style={{
          borderRadius: 18,
          borderCurve: "continuous",
          backgroundColor: isDark
            ? "rgba(28,28,30,0.55)"
            : "rgba(255,255,255,0.55)",
          maxHeight: PANEL_MAX_HEIGHT,
        }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingVertical: 4 }}
        >
          {commands.length === 0 ? (
            <View className="px-4 py-3">
              <Text className="text-sm text-zinc-500 dark:text-zinc-400">
                No matching commands
              </Text>
            </View>
          ) : (
            commands.map((c) => (
              <Pressable
                key={c.name}
                onPress={() => onPick(c.name)}
                className="px-4 py-2"
              >
                {/* Row 1: `/cmd [argHint]` — argHint muted (POSIX
                    placeholder convention). Single Text so the hint
                    chunk inherits baseline. */}
                <Text className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  /{c.name}
                  {c.argHint && (
                    <Text className="text-zinc-400 dark:text-zinc-500 font-normal">
                      {" "}
                      {c.argHint}
                    </Text>
                  )}
                </Text>
                {/* Row 2: description subtitle */}
                <Text
                  className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5"
                  numberOfLines={1}
                >
                  {c.description}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </GlassView>
    </View>
  );
}

function GitStatusBarMock({ isDark }: { isDark: boolean }) {
  return (
    <View className="px-4 pb-2">
      <GlassView
        isInteractive
        style={{
          borderRadius: 18,
          borderCurve: "continuous",
          backgroundColor: isDark
            ? "rgba(28,28,30,0.55)"
            : "rgba(255,255,255,0.55)",
        }}
      >
        <View className="flex-row items-center gap-2 px-4 h-10">
          <Text className="text-sm text-zinc-500 dark:text-zinc-400">
            thinkite
          </Text>
          <Text className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            main
          </Text>
          <View className="flex-1" />
          <Text className="text-sm font-medium text-green-600 dark:text-green-500">
            +12
          </Text>
          <Text className="text-sm font-medium text-red-600 dark:text-red-500">
            -3
          </Text>
        </View>
      </GlassView>
    </View>
  );
}
