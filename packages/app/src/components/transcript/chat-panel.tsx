import { Button, Host, Image } from "@expo/ui/swift-ui";
import { buttonBorderShape, buttonStyle } from "@expo/ui/swift-ui/modifiers";
import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import {
  type Collection,
  eq,
  useLiveQuery,
  useLiveQueryEffect,
} from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import type { ImageAttachment } from "@thinkite/protocol";
import * as Crypto from "expo-crypto";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useColorScheme,
  useWindowDimensions,
  View,
  type ViewProps,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GitStatusBar } from "@/components/transcript/git-status-bar";
import { InputBar } from "@/components/transcript/input-bar";
import { TextBlock } from "@/components/transcript/text-block";
import { ThinkingIndicator } from "@/components/transcript/thinking-indicator";
import { ToolBlock } from "@/components/transcript/tool-block";
import { useToolCallSheet } from "@/components/transcript/tool-call-sheet";
import { haptics } from "@/lib/haptics";
import { sessionStateCollection } from "@/lib/sessions-collection";
import type { RenderBlock } from "@/lib/transcript-blocks";
import {
  type OrderedTimelineItem,
  sendUserMessage,
} from "@/lib/transcript-collection-factory";

// ToolBlock row height, derived from its styles (keep in sync with
// tool-block.tsx): Pressable py-1.5 (12) + one text-base line (lineHeight
// 24). The verb+summary row is single-line by construction
// (numberOfLines={1}). The text line scales with Dynamic Type; the
// vertical padding doesn't.
const TOOL_ROW_PADDING_V = 12;
const TOOL_ROW_LINE_HEIGHT = 24;

type ChatPanelProps = {
  cliSessionId: string;
  cwd: string | undefined;
  blocks: RenderBlock[];
  /** The raw per-session transcript collection (from useSessionTranscript).
   *  Threaded in rather than re-derived via the factory so the onEnter
   *  haptics effect runs over the exact instance the screen already
   *  subscribed — same object, no second cache lookup. */
  collection: Collection<OrderedTimelineItem, string>;
};

/**
 * Chat surface: virtualized transcript list + sticky composer
 * (GitStatusBar + InputBar) above the keyboard, plus the
 * composer-inset wiring that keeps the last message visible above the
 * composer no matter how it grows or the keyboard toggles.
 *
 * Mounted only in the parent's `ready` branch (loading / error
 * render their own placeholders) — the whole chat surface mounts and
 * unmounts as a unit per session. That single boundary fixes a chain
 * of issues we hit while iterating:
 *
 *   1. `initialScrollAtEnd` always sees non-empty data on first
 *      commit. The list relies on a per-frame rAF ticker to retarget
 *      to true end as items measure; that needs non-empty data to
 *      have somewhere to land. (Before: list mounted under
 *      ListEmptyComponent with data=[] during loading, retarget never
 *      fired, last message stayed hidden behind composer until user
 *      toggled keyboard.)
 *
 *   2. The composer-inset SharedValue (via `useKeyboardChatComposerInset`) is
 *      measured from the composer wrapper in a mount-time useLayoutEffect
 *      (before paint) and reported as the list's bottom inset; see the call
 *      site for the seed history.
 *
 *   3. KeyboardChatScrollView vs. iOS automatic contentInset
 *      adjustments: must disable both
 *      `contentInsetAdjustmentBehavior` and
 *      `automaticallyAdjustContentInsets`. Per the
 *      react-native-keyboard-controller chat-app guide, iOS's
 *      automatic adjustments double-count safe area against KCSV's
 *      own management. (Before: visible clipping under composer of
 *      ~insets.bottom = the home-indicator zone.) Side effect: iOS
 *      no longer auto-pads the top either, so we manually apply
 *      `style={{ paddingTop: headerHeight }}` to keep content from
 *      starting under the transparent Stack.Header. Both ends become
 *      our responsibility once auto-adjust is off.
 *
 *   4. The list's `keyboardOffset` mirrors `KeyboardStickyView.offset.opened`
 *      (both `insets.bottom - 8`): with the keyboard up it drops the
 *      safe-area band baked into the inset (via the composer's `pb-safe`)
 *      and leaves the last message ~8pt above the keyboard top. Without it
 *      the last message sits a touch low above the composer.
 *
 * Per-session lifecycle: because this whole surface mounts fresh per
 * session (the detail screen swaps it on the loading→ready transition),
 * `initialScrollAtEnd`, the composer-inset measurement, the KCSV keyboard
 * scroll-state, and the daemon live-fanout registration all start clean on
 * every switch — no cross-mount state to reset by hand. (A persistent
 * ChatPanel was tried and removed: it saved the mount cost but left
 * LegendList/KCSV's per-mount keyboard + scroll state stale across
 * switches, which couldn't be re-seeded from outside the wrapper.)
 *
 * Trade-off: brief no-composer flash during the loading transition
 * (typically <300ms for an in-flight subscribe). Mirror of how
 * Claude Desktop / ChatGPT handle session-switch loading — input is
 * hidden until the session is ready to receive it.
 */
export function ChatPanel({
  cliSessionId,
  cwd,
  blocks,
  collection,
}: ChatPanelProps) {
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { fontScale } = useWindowDimensions();
  const listRef = useRef<LegendListRef>(null);

  // Authoritative height for tool rows (v3's getFixedItemSize — trusted as
  // KNOWN, not an estimate, so it must be exact). Pinning the most numerous
  // row kind removes it from size estimation entirely, shrinking the
  // correction shifts that cause transient row overlap when scrolling up
  // through unmeasured content. Text rows return undefined → measured.
  const getFixedItemSize = useCallback(
    (item: RenderBlock) =>
      item.kind === "tool"
        ? TOOL_ROW_PADDING_V + Math.round(TOOL_ROW_LINE_HEIGHT * fontScale)
        : undefined,
    [fontScale],
  );
  const composerRef = useRef<View>(null);
  const isDark = useColorScheme() === "dark";
  // Tap the workspace status bar → open the working-tree diff in the shared
  // sheet (the provider wraps this screen, see session/[cliSessionId].tsx).
  const { openGitDiff } = useToolCallSheet();
  // Git changes → invalidate the diff query so an OPEN diff sheet refetches
  // (no-op while closed → query inactive). Wired through GitStatusBar's
  // onStatusChange (the single gitStatus subscriber) rather than re-subscribing.
  const queryClient = useQueryClient();
  // Composer → list bottom-inset wiring (library hook). Reports the composer
  // wrapper's measured height (GitStatusBar + InputBar) as the list's bottom
  // inset, both via the `contentInsetEndAdjustment` SharedValue (drives KCSV's
  // visual padding) and an imperative `reportContentInset` (drives LegendList
  // virtualization). No manual `+ insets.bottom`: the composer owns its
  // safe-area band via `pb-safe`, so its measured height already includes it.
  // Seed defaults to 0 — the real composer height lands in the hook's mount-time
  // useLayoutEffect (before paint) and on every onComposerLayout thereafter. We
  // used to seed a near-miss (180) to force the post-measure inset delta non-zero
  // so initialScrollAtEnd's bootstrap retarget converged within its frame budget;
  // that budget was only ever starved by the drawer-close animation competing for
  // frames, and the drawer-settle gate (transitioningSessionId) now defers this
  // mount until after the close lands — so a 0 seed converges fine.
  const { contentInsetEndAdjustment, onComposerLayout } =
    useKeyboardChatComposerInset(listRef, composerRef);

  // Idiomatic scroll-on-send (LegendList chat pattern). `scrollMessageToEnd`
  // brings the just-sent message into view no matter where the user had
  // scrolled to; `freeze` (passed to the list) suspends
  // maintainVisibleContentPosition during the animation so it doesn't fight it.
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });

  // isThinking: the turn is running (daemon-pushed activity, #17) but the last
  // block isn't Claude's text yet — the initial think window + tool gaps. Drives
  // the resident footer.
  const { data: sessionRow } = useLiveQuery(
    (q) =>
      q
        .from({ s: sessionStateCollection })
        .where(({ s }) => eq(s.cliSessionId, cliSessionId))
        .findOne(),
    [cliSessionId],
  );
  const isRunning = sessionRow?.activity === "running";
  const lastBlock = blocks[blocks.length - 1];
  const isThinking =
    isRunning &&
    !(lastBlock?.kind === "text" && lastBlock.role === "assistant");

  // Message haptics, driven from the on-screen ChatPanel (not the collection
  // sync, which can run off-screen within gcTime and buzz a session you're not
  // in). skipInitial mutes the open-backlog; a reconnect re-ingests as one batch
  // so unchanged rows are updates, not re-enters. Per message that enters:
  // user_message → send, assistant_message → genStart (each agent segment buzzes).
  useLiveQueryEffect<OrderedTimelineItem>(
    {
      query: (q) => q.from({ t: collection }),
      skipInitial: true,
      onEnter: (e) => {
        if (e.value.type === "user_message") haptics.send();
        if (e.value.type === "assistant_message") haptics.genStart();
      },
    },
    [collection],
  );

  // genEnd on the turn ending — not a transcript delta, so it tracks the
  // daemon-pushed activity flag going running→idle. Transition-guarded: fires
  // once, and never on unmount (navigating away mid-turn stays quiet).
  const prevRunning = useRef(false);
  useEffect(() => {
    if (prevRunning.current && !isRunning) haptics.genEnd();
    prevRunning.current = isRunning;
  }, [isRunning]);

  // anchoredEndSpace anchor for the just-sent message: the streaming reply fills
  // reserved space below it instead of shoving the scroll target (overshoot fix).
  // Set in rawSend at send time (the activity flag lags a round-trip) and kept
  // ACROSS turns (the upstream AiChatExample idiom): clearing on idle collapses
  // the reserved blank space below a short reply, which jumps the viewport.
  // The next send simply re-anchors.
  const [anchorIndex, setAnchorIndex] = useState(-1);

  // Written by the list on the UI thread (reanimated integration) — drives the
  // scroll-to-end FAB without a single JS-side re-render.
  const isNearEnd = useSharedValue(true);
  // Gates the FAB until the list's initial scroll settles. During boot the
  // list sits at the top for a few frames, so checkAtBottom legitimately
  // reports isNearEnd=false (the library's hasActiveInitialScroll skip only
  // guards isEndReached, not isNearEnd) — without this gate the FAB flashes
  // on every session open. `onLoad` fires exactly once, when containers have
  // laid out AND the initial scroll finished.
  const fabReady = useSharedValue(false);
  const scrollFabStyle = useAnimatedStyle(() => ({
    opacity: withTiming(fabReady.value && !isNearEnd.value ? 1 : 0, {
      duration: 160,
    }),
  }));
  const scrollFabProps = useAnimatedProps<ViewProps>(() => ({
    pointerEvents:
      fabReady.value && !isNearEnd.value
        ? ("box-none" as const)
        : ("none" as const),
  }));

  // The "real send" handed to InputBar. InputBar already intercepts slash
  // commands; only plain text + whitelisted passthroughs (/init, /review,
  // /compact) reach here.
  const rawSend = useCallback(
    (text: string, images: ImageAttachment[] | undefined, model: string) => {
      // Optimistic insert (instant paint) + sendPrompt under one client uuid the
      // daemon reuses, so the synced row dedupes by key. cwd/model ride along for
      // --resume project-key resolution and the daemon-restart respawn seed.
      const userMessageUuid = Crypto.randomUUID();
      void sendUserMessage({
        cliSessionId,
        userMessageUuid,
        text,
        cwd,
        images,
        model,
      }).isPersisted.promise.catch((err) => {
        console.error("sendPrompt failed", err);
      });
      // Anchor the new message and scroll synchronously — scrollToEnd is
      // "committed" since @legendapp/list 3.0.4: the list queues the scroll
      // until the data commit lands and the anchored tail has measured, and
      // the hook holds `freeze` until BOTH the scroll and the keyboard
      // dismissal finish. No rAF needed; closeKeyboard:true is the supported
      // pattern (the old "dismiss fights the scroll target" race is fixed
      // upstream).
      setAnchorIndex(blocks.length);
      void scrollMessageToEnd({ animated: true, closeKeyboard: true });
    },
    [cliSessionId, cwd, blocks.length, scrollMessageToEnd],
  );

  // No first-send-after-create effect here anymore: the new-session
  // screen fires the first sendPrompt itself via `createSession` (the
  // daemon seeds an empty settled snapshot for the new query, so that
  // pre-subscribe send is race-free — see index.tsx). ChatPanel only
  // owns subsequent in-session sends (rawSend above).

  return (
    <>
      <KeyboardAwareLegendList<RenderBlock>
        ref={listRef}
        // Suspends maintainVisibleContentPosition while `scrollMessageToEnd`
        // animates on send, so the chat-pattern scroll isn't fought by the
        // resting scroll manager (LegendList chat guide).
        freeze={freeze}
        // Reserve blank space below the just-sent user message for its turn so
        // the agent's reply has a full initial display area to render into (the
        // prompt pinned near the top), instead of starting cramped above the
        // composer. The reply fills this reserved space without moving the
        // scroll (no stick-to-bottom); the FAB jumps to the latest on demand.
        // Undefined when idle → normal layout.
        anchoredEndSpace={
          anchorIndex >= 0
            ? { anchorIndex, anchorOffset: headerHeight }
            : undefined
        }
        data={blocks}
        keyExtractor={(b) => b.id}
        // Resident "Thinking…" footer — always mounted at constant height,
        // `active` just fades the label. Constant footerSize is the point: a
        // mount/unmount changes anchoredEndSpace's contentBelowAnchor without
        // triggering its recompute, which jumped the anchored message. Also
        // doubles as the gap below the last message.
        ListFooterComponent={<ThinkingIndicator active={isThinking} />}
        renderItem={({ item, index }) => {
          if (item.kind === "text")
            return (
              <TextBlock
                block={item}
                // The streaming message = the LAST block, assistant role,
                // while the daemon-pushed activity says the turn is
                // running. No protocol settle signal exists; this
                // derivation is correct at every boundary (tool_call
                // append → no longer last; interrupt/idle → not running;
                // cold resume → not running). Worst case of a wrong beat:
                // one extra remend pass + a deferred exact re-measure.
                streaming={
                  isRunning &&
                  item.role === "assistant" &&
                  index === blocks.length - 1
                }
              />
            );
          if (item.kind === "tool") return <ToolBlock block={item} />;
          // `compact_divider` — placeholder renders nothing for this
          // commit. Actual divider component (horizontal line + caption)
          // lands in the next Slice 2 commit alongside the reducer
          // wiring that materializes the item.
          return null;
        }}
        // Manual top inset to clear the transparent Stack.Header.
        // With `contentInsetAdjustmentBehavior="never"` below, iOS no
        // longer auto-pads the top; we have to do it ourselves.
        style={{ paddingTop: headerHeight }}
        // Per-kind type (user / assistant / tool / divider — text split by role
        // since a user bubble and assistant text size very differently) → a
        // running-average size PER type instead of one global average, learned
        // per mount. Steady-state win: once a few rows of a kind measure, the
        // rest land close to real (helps the initialScrollAtEnd reveal converge
        // → fewer "convergence bounds" warns). Also keys the recycle pool so a
        // text row isn't recycled into a tool.
        getItemType={(item) => (item.kind === "text" ? item.role : item.kind)}
        getFixedItemSize={getFixedItemSize}
        // Disable iOS's automatic contentInset adjustments — they
        // fight KeyboardChatScrollView's own inset management and end
        // up double-counting safe area. Per react-native-keyboard-
        // controller chat-app guide: "Always set these to false when
        // using KeyboardChatScrollView inside virtualized lists."
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        // Bottom inset = the composer wrapper's measured height (already
        // includes the home-indicator band via the composer's `pb-safe`).
        // Drives KCSV's visual padding *and* LegendList virtualization via
        // the imperative reportContentInset — both wired by the hook above.
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        // Workaround for facebook/react-native#54123 — on iOS + RN
        // ≥0.81, the `contentInset` area created by extraContentPadding
        // doesn't respond to touch/scroll. This swizzles UIScrollView's
        // hit-test container at runtime; KCSV docs warn it's fragile,
        // accepted as the price of having a tappable composer band
        // until the upstream fix ships. RN issue closed 2026-05-12,
        // should land in 0.86/0.87 — DELETE this prop after upgrading
        // and verifying scroll/tap in the inset zone.
        applyWorkaroundForContentInsetHitTestBug
        // Mirrors `KeyboardStickyView.offset.opened` (both `insets.bottom - 8`).
        // KCSV's `keyboardOffset` (renamed from `offset` in @legendapp/list 3.0.0)
        // is "distance from ScrollView bottom to screen bottom" and, on
        // keyboard-open, "by how much to reduce the keyboard push." We want
        // the list to leave a touch of room above the keyboard matching how
        // composer is lifted (-8pt above keyboard top); `insets.bottom`
        // cancels the safe area already accounted for in
        // `contentInsetEndAdjustment` so it isn't counted twice while open.
        // Without this the last message sits ~insets.bottom too low above
        // composer when the keyboard is shown.
        keyboardOffset={insets.bottom - 8}
        // Scrolling model:
        //   - initialScrollAtEnd: boot at the latest message on session
        //     re-open. Runs a per-frame rAF ticker that retargets to true
        //     end as items measure and the inset settles (LegendList
        //     retargets the initial scroll after inset changes). Re-fires
        //     per session because the whole surface mounts fresh each switch.
        //     This same boot path caused sidecode#22: on a NON-first mount the
        //     initial settle landed before the async contentInset commit, so
        //     KCSV's internal scroll tracker stayed stale by insets.bottom and
        //     the FIRST keyboard-open over-scrolled a safe-area gap above the
        //     composer (self-healed on the 2nd open). Fixed by the
        //     @legendapp/list 3.1.x initialScrollAtEnd timing rework (now on
        //     3.2.0) — NOT by keyboard-controller: its PR #1496 (shipped in
        //     1.21.12) only swallows the mount {0,0} contentOffset clobber,
        //     which #22 had already shown doesn't touch the keyboard-lift path.
        //   - on send: anchoredEndSpace reserves the reply's initial display
        //     area below the just-sent prompt (prompt pinned near the top) so
        //     it renders into a full viewport instead of cramped above the
        //     composer. From there maintainScrollAtEnd (see below) follows the
        //     stream tail while you're at the end; the scroll-to-end FAB
        //     (`isNearEnd`) jumps to the latest when you've scrolled up.
        //
        // DELIBERATELY OMITTED:
        //   - `alignItemsAtEnd`: a Telegram/iMessage idiom (sparse messages
        //     stick to the bottom of the viewport via `flexGrow:1 +
        //     justifyContent:flex-end`). For our ChatGPT layout messages
        //     flow top-down from the header, and enabling it caused two
        //     bugs: (1) contentContainer forced to fill the viewport even
        //     with one short message, making the list scrollable into the
        //     composer inset zone; (2) the bottom-aligned single message
        //     rendered behind the composer backdrop because the alignment
        //     didn't account for `contentInsetEndAdjustment`.
        initialScrollAtEnd
        // Stick-to-bottom: while the user is at (or near) the end, keep the
        // viewport pinned to the tail as the reply streams in (follow-the-stream).
        // History: omitted before — tried in 84ca2a9 and reverted because it
        // collided with MVCP + KCSV's keyboard lift fighting over the same scroll
        // offset, and we preferred read-from-top for long coding replies. Re-
        // enabled per product call. anchoredEndSpace still pins the just-sent
        // prompt near the top on send (you're not at the end then, so this stays
        // dormant until you scroll/jump to the tail), and the FAB still catches up
        // on demand. Re-verified on device 2026-06-16: the old MVCP/keyboard-lift
        // collision no longer reproduces on @legendapp/list 3.0.4 (keyboard
        // open/close + streaming item growth stay stable). If the stream ever
        // stops following the tail, MVCP's `data: false` blocking the per-add
        // retarget is the first suspect → try `data: true`.
        maintainScrollAtEnd
        // List → UI-thread state mirror (reanimated integration). `isNearEnd`
        // gates the scroll-to-end FAB; no JS re-render involved.
        sharedValues={{ isNearEnd }}
        // Initial render + initial scroll settled → un-gate the FAB.
        onLoad={() => {
          fabReady.set(true);
        }}
        // Stabilize the visible position on size/layout changes (keyboard
        // toggle, streaming item growth) but NOT on data adds — new data moves
        // nothing by design: the anchored end space owns in-turn growth (the
        // reply renders into the reserved area below the pinned prompt) and the
        // FAB owns catch-up to the latest.
        maintainVisibleContentPosition={{ size: true, data: false }}
        // iOS pull-down-to-dismiss for the keyboard.
        keyboardDismissMode="interactive"
        // Recycling DISABLED (verified on device 2026-06-12): with it on,
        // scrolling up through rows with large height variance (tool rows
        // ~36pt vs assistant chunks up to thousands) produced visible row
        // overlap — a recycled container carries the previous item's
        // size/position for a beat before the new content's layout lands
        // (LegendApp/legend-list#301 is the same combo). Off = every
        // entering row is a fresh mount (enriched parse + TextInput);
        // scroll fps acceptable on device. Revisit only with an upstream
        // fix in hand, verified against the same long-session repro.
        recycleItems={false}
        // Only push the list up by the keyboard height when the user
        // is already pinned at the bottom; anywhere else the keyboard
        // floats over the content so what they're reading stays put.
        keyboardLiftBehavior="whenAtEnd"
      />
      {/* InputBar floats over the list so transcript content can scroll
          behind it — Liquid Glass needs content underneath to actually blur.
          The composer sits flush at the screen bottom (no closed offset); its
          own `pb-safe` pads GitStatusBar + InputBar above the home indicator.
          `offset.opened: insets.bottom - 8` — when the keyboard is up it drops
          that now-unneeded safe-area band and leaves the input ~8pt above the
          keyboard top.

          The inner `composerRef` View wraps everything that needs to
          be measured for list bottom-inset — currently GitStatusBar +
          InputBar; future error banners / attachment rows should go
          inside this same wrapper so the list auto-adjusts.
          `collapsable={false}` is required for `measure` / `onLayout`
          to fire reliably on Android.

          `pointerEvents="box-none"`: the KSV now also contains the
          transparent FAB strip above the composer — the wrapper itself
          must not eat list touches in that strip. */}
      <KeyboardStickyView
        offset={{ opened: insets.bottom - 8 }}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        pointerEvents="box-none"
      >
        {/* Scroll-to-end FAB — appears when the user is away from the end
            (at the end, maintainScrollAtEnd follows the stream; this catches
            you up once you've scrolled up off the tail). Lives INSIDE the KSV,
            laid out above the composer: it rides keyboard transitions for
            free, and staying within the KSV's bounds keeps it tappable
            (RN doesn't hit-test children outside parent bounds). NOT part
            of `composerRef`, so it doesn't inflate the measured list
            inset. Visibility + hit-testing both ride `isNearEnd` on the
            UI thread. Liquid Glass circle via swift-ui Button (universal
            Button injects its own innermost buttonStyle and eats `glass`
            — see onboarding.tsx). */}
        <Animated.View
          animatedProps={scrollFabProps}
          style={[{ alignItems: "center", paddingBottom: 12 }, scrollFabStyle]}
        >
          <Host matchContents>
            <Button
              onPress={() => {
                void listRef.current?.scrollToEnd({ animated: true });
              }}
              modifiers={[buttonStyle("glass"), buttonBorderShape("circle")]}
            >
              <Image
                systemName="arrow.down"
                size={17}
                color={isDark ? "#fafafa" : "#0a0a0a"}
              />
            </Button>
          </Host>
        </Animated.View>
        <View
          ref={composerRef}
          collapsable={false}
          onLayout={onComposerLayout}
          className="pb-safe"
          style={{
            experimental_backgroundImage: isDark
              ? "linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0))"
              : "linear-gradient(to top, rgba(255,255,255,0.8), rgba(255,255,255,0))",
          }}
        >
          <GitStatusBar
            cwd={cwd}
            onPress={cwd ? () => openGitDiff(cwd) : undefined}
            onStatusChange={
              cwd
                ? () =>
                    queryClient.invalidateQueries({
                      queryKey: ["workingTreeDiff", cwd],
                    })
                : undefined
            }
          />
          <InputBar cliSessionId={cliSessionId} onSend={rawSend} />
        </View>
      </KeyboardStickyView>
    </>
  );
}
