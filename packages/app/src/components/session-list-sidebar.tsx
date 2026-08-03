import { Button, Host } from "@expo/ui/swift-ui";
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  font,
  labelStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { router, useGlobalSearchParams } from "expo-router";
import { useMemo } from "react";
import {
  ActivityIndicator,
  SectionList,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionRow } from "@/components/session-row";
import { useSetLastUsedCwd } from "@/hooks/use-last-used-cwd";
import { useSessions } from "@/hooks/use-sessions";
import { useDrawerUI } from "@/lib/drawer-ui";
import { dayKey, formatDaySection } from "@/lib/format";
import type { SessionRow as SessionRowData } from "@/lib/sessions-collection";

interface DaySection {
  title: string;
  data: SessionRowData[];
}

/**
 * Bucket the recency-sorted sessions into calendar-day sections (Today /
 * Yesterday / "Jun 1" / …). `sessions` is already sorted `lastActivityAt`
 * desc by `useSessions`, so a single linear pass keeps both section order
 * (most-recent day first) and within-section recency. `now` is snapshotted
 * once so every row buckets against the same "today".
 */
function groupSessionsByDay(sessions: readonly SessionRowData[]): DaySection[] {
  const now = Date.now();
  const out: DaySection[] = [];
  let currentKey: string | null = null;
  for (const session of sessions) {
    const key = dayKey(session.lastActivityAt);
    if (key !== currentKey) {
      out.push({
        title: formatDaySection(session.lastActivityAt, now),
        data: [],
      });
      currentKey = key;
    }
    out[out.length - 1].data.push(session);
  }
  return out;
}

// Floating-header content height, below the status-bar inset. We set our own
// (instead of react-navigation's getDefaultHeaderHeight, which hardcodes the
// classic 44pt and reads a touch short against the iOS 26 nav bar). Tune freely.
const HEADER_CONTENT_HEIGHT = 52;

/**
 * Custom drawerContent. Replaces the default react-navigation drawer item
 * list with: a floating title/gear header + a day-sectioned recents list
 * (Today / Yesterday / "Jun 1" …, still recency-sorted, no project grouping)
 * + a floating bottom-right "New Chat" button.
 *
 * The trigger row pattern mirrors Claude iOS: tap a session → close drawer →
 * navigate to the session detail. Tap the floating "New Chat" button →
 * close drawer → navigate to "/" (the new-session create page; lives at
 * `(drawer)/(stack)/index.tsx`, sibling of the detail inside the same
 * inner Stack). Tap the header gear → router.push("/settings") → root Stack
 * pushes the modal sheet over (drawer).
 *
 * Drawer control comes from `useDrawerUI()` (the bare-drawer-layout state
 * owned by `(drawer)/_layout.tsx`) — no navigator props.
 *
 * Header chrome: a plain absolute View floats over the list with a
 * linear-gradient scrim (`experimental_backgroundImage`) + the brand title and
 * a settings-gear button (`@expo/ui/swift-ui` Button with a `glass` buttonStyle
 * + SF Symbol, hosted in a `Host matchContents` — the iOS 26 Liquid Glass
 * capsule). The new-session action lives in a separate floating "New Chat"
 * button pinned bottom-right (same Button with the `glassProminent` style).
 * We use the swift-ui namespace, not universal — universal Button hardcodes a
 * `borderedProminent`/`plain` buttonStyle as the innermost modifier, which wins
 * over any `glass` we'd add, so glass is only reachable via swift-ui direct.
 * (Header was a `@react-navigation/elements` Header, dropped — we
 * overrode every slot anyway and its getDefaultHeaderHeight 44pt read short on
 * iOS 26; height is now `HEADER_CONTENT_HEIGHT`.) We also tried the native iOS
 * 26 soft scroll-edge effect (react-native-screens' experimental gamma `Stack`
 * + `ScrollViewMarker`) and an expo-blur `BlurView` — the soft edge works but
 * the gamma header items don't render nested in the drawer, and the blur read
 * as flat — so we keep this simple gradient. See memory
 * `project_sidebar_scrolledge_spike`.
 */
export function SessionListSidebar() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() ?? "light";
  const { closeDrawer } = useDrawerUI();
  // Active session id (the focused detail route's path param) — lets
  // handleOpenSession no-op a tap on the already-open session. useGlobalSearch-
  // Params (not Local: the sidebar isn't a route screen) re-renders this on
  // nav, but the parent already re-renders on every drawer toggle via
  // useDrawerUI, so on the drawer-switch path it costs nothing extra.
  const { cliSessionId: activeSessionId } = useGlobalSearchParams<{
    cliSessionId?: string;
  }>();

  // Full floating-header band = status-bar inset + content height. Shared with
  // the list's contentContainerStyle.paddingTop (see Body) so row 1 starts
  // just below the bar.
  const headerHeight = insets.top + HEADER_CONTENT_HEIGHT;

  // Reserve room at the bottom of the list so the last row can scroll clear of
  // the floating New Chat button. The FAB sits at the safe-area edge
  // (`bottom-safe`), so reserve its ~52pt large-capsule height + a little
  // breathing room on top of the safe inset.
  const footerHeight = insets.bottom + 68;

  // 3-stop scrim: HOLD full opacity through the status-bar + title band
  // (0%→75%), then fade only the bottom edge (75%→100%) so the area under the
  // title stays solid and just the sliver where list rows emerge softens.
  // Knobs: move the 75% breakpoint (higher = more solid, shorter fade) and/or
  // raise the end alpha above 0 to keep the bottom edge tinted. Raw CSS string
  // for RN's `experimental_backgroundImage` (key is still `experimental_`-
  // prefixed in RN 0.85.3; plain `backgroundImage` no-ops).
  const headerScrim =
    scheme === "dark"
      ? "linear-gradient(to bottom, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.8) 80%, rgba(0,0,0,0) 100%)"
      : "linear-gradient(to bottom, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.8) 80%, rgba(255,255,255,0) 100%)";

  // Drawer-style switching uses `router.replace` not `push`: tapping a
  // session in the sidebar should swap the active screen, not accumulate a
  // back stack of session instances. With `push`, switching A → B → A
  // builds Stack [A, B, A] (because the inner Stack's [cliSessionId] route
  // treats different params as different instances by default), and the
  // user gets a back chevron in the UINavigationBar that pops to a session
  // they don't expect to "go back" to.
  const setLastUsedCwd = useSetLastUsedCwd();
  const handleOpenSession = (session: SessionRowData) => {
    // Tapping the already-open session: just close the drawer. router.replace
    // to the same path-param route still mints a fresh route key → remounts
    // ChatPanel + flashes Loading, for no actual navigation. Skip it.
    if (session.cliSessionId === activeSessionId) {
      closeDrawer();
      return;
    }
    // Record the current focus so the next "New session" defaults to
    // the project the user just opened. Mutation is fire-and-forget;
    // the navigation below shouldn't wait on SecureStore I/O.
    setLastUsedCwd.mutate(session.cwd);
    // closeDrawer(targetId) records the gate target in the same batch as the
    // route swap below, so the session navigated TO mounts the cheap
    // TranscriptLoading first — the session screen's drawer-settle gate holds
    // the heavy ChatPanel mount until the close animation finishes. No
    // frame-deferral needed.
    closeDrawer(session.cliSessionId);
    router.replace({
      pathname: "/session/[cliSessionId]",
      params: {
        cliSessionId: session.cliSessionId,
        // No title param — the detail screen reads it from the session's
        // collection row (filtered live query), so it stays correct as
        // the daemon's canonical title lands.
        //
        // Pass cwd so the session screen can hand it to sendPrompt — the
        // SDK derives the project key from cwd to locate the JSONL for
        // `claude --resume`.
        cwd: session.cwd,
      },
    });
  };

  const handleNewSession = () => {
    closeDrawer();
    // Replace, not push: the new-session page is a sibling of the detail
    // inside the same inner Stack ((drawer)/(stack)/index → URL "/"), so
    // switching to it from a detail screen is a top-of-Stack swap (no
    // back stack accumulating).
    router.replace("/");
  };

  // Settings IS a push — it's a modal at the root Stack level, sliding up
  // OVER the drawer + main content as a pageSheet. Stack semantics (push +
  // dismiss) are correct here.
  const handleOpenSettings = () => {
    router.push("/settings");
  };

  return (
    <View className="flex-1 bg-white dark:bg-black">
      {/* Session list — fills the panel and scrolls UNDER the floating
          header. Its contentContainerStyle.paddingTop (see Body) reserves
          the header band so row 1 starts just below it, then rows fade into
          the scrim as they scroll up. */}
      <Body
        onOpenSession={handleOpenSession}
        headerHeight={headerHeight}
        footerHeight={footerHeight}
      />

      {/* Floating header — one absolute band. Gradient scrim fills the box
          (incl. the status bar); `pt-safe` drops the title/gear row below the
          status-bar inset; flex-row + items-center lay them out. `box-none`
          lets taps on empty header area fall through to the list. The gear is
          a `@expo/ui/swift-ui` Button (SwiftUI), so it needs its own `Host`;
          `matchContents` sizes the Host to the button. `buttonStyle('glass')`
          gives the iOS 26 Liquid Glass capsule. */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 top-0 z-10 flex-row items-center justify-between px-4 pt-safe"
        style={{
          height: headerHeight,
          experimental_backgroundImage: headerScrim,
        }}
      >
        <Text className="text-2xl font-semibold text-black dark:text-white">
          thinkite
        </Text>
        <Host matchContents>
          <Button
            label="Settings"
            systemImage="gearshape"
            modifiers={[
              buttonStyle("glass"),
              labelStyle("iconOnly"),
              buttonBorderShape("circle"),
              font({ size: 22 }),
            ]}
            onPress={handleOpenSettings}
          />
        </Host>
      </View>

      {/* Floating "New Chat" button — bottom-right FAB over the list
          (swift-ui Button → `glassProminent` Liquid Glass capsule, tinted by
          the accent). `bottom-safe right-6` pin it above the home indicator at
          the trailing edge; `box-none` lets the rest of the band fall through
          to the list. */}
      <View pointerEvents="box-none" className="absolute bottom-safe right-6">
        <Host matchContents>
          <Button
            label="New Chat"
            systemImage="square.and.pencil"
            modifiers={[
              buttonStyle("glassProminent"),
              controlSize("large"),
              font({ size: 16, weight: "semibold" }),
              tint("#EE5722"),
            ]}
            onPress={handleNewSession}
          />
        </Host>
      </View>
    </View>
  );
}

function Body({
  onOpenSession,
  headerHeight,
  footerHeight,
}: {
  onOpenSession: (s: SessionRowData) => void;
  headerHeight: number;
  footerHeight: number;
}) {
  // Data hooks live here, not in the parent: nothing above Body consumes them,
  // and keeping `useGlobalSearchParams` here scopes the per-navigation
  // re-render to the list — the floating header + FAB (SwiftUI Hosts) don't
  // re-render every time the active route changes.
  const query = useSessions();
  const sessions = query.data ?? [];
  const { cliSessionId: activeCliSessionId } = useGlobalSearchParams<{
    cliSessionId?: string;
  }>();

  // Day-grouped sections. Memoized so the linear bucketing only re-runs when
  // the session set changes. All hooks stay above the early returns to satisfy
  // rules-of-hooks.
  const sections = useMemo(() => groupSessionsByDay(sessions), [sessions]);

  if (query.isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  if (query.isError) {
    // useLiveQuery surfaces error state via `status`/`isError` but not an
    // error object — show a static message (the daemon facade retries the
    // underlying fetch forever, so this is a transient first-load state).
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-base font-medium text-red-600 dark:text-red-400">
          Couldn't load sessions
        </Text>
      </View>
    );
  }

  if (sessions.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
          No sessions yet.
        </Text>
      </View>
    );
  }

  // Day-sectioned, recency-first (Claude Desktop style). Sort is done by
  // useSessions' `orderBy`; groupSessionsByDay just buckets in order. No row
  // separators and non-sticky headers so the whole list flows under the
  // gradient scrim as one quiet column.
  return (
    <SectionList<SessionRowData, DaySection>
      style={{ flex: 1 }}
      sections={sections}
      keyExtractor={(item) => item.cliSessionId}
      renderItem={({ item }) => (
        <SessionRow
          session={item}
          onPress={onOpenSession}
          isActive={item.cliSessionId === activeCliSessionId}
        />
      )}
      renderSectionHeader={({ section }) => (
        <Text className="px-3 pt-2 pb-1 text-sm font-medium text-gray-400 dark:text-gray-500">
          {section.title}
        </Text>
      )}
      stickySectionHeadersEnabled={false}
      // No scroll indicator — it'd run under the gradient scrim and adds visual
      // noise to an otherwise quiet column.
      showsVerticalScrollIndicator={false}
      // Reserve the floating-header band up top (so the first section starts
      // just below it) and the floating-button band at the bottom (so the
      // last row clears the FAB).
      contentContainerClassName="px-2 gap-1"
      contentContainerStyle={{
        paddingTop: headerHeight,
        paddingBottom: footerHeight,
      }}
    />
  );
}
