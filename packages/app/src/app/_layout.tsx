// Must be first: installs the global crypto polyfills (getRandomValues +
// randomUUID) before any consumer — ed25519 identity, TanStack DB — runs.
import "@/lib/polyfills";
import "@/global.css";
import { BottomSheetProvider } from "@swmansion/react-native-bottom-sheet";
import { QueryClientProvider } from "@tanstack/react-query";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import {
  SafeAreaListener,
  SafeAreaProvider,
} from "react-native-safe-area-context";
import { Uniwind } from "uniwind";
import {
  DaemonClientProvider,
  useDaemonClient,
} from "@/lib/daemon-client-context";
import { initHighlighter } from "@/lib/markdown/code-highlighter";
import { queryClient } from "@/lib/query-client";
import { SafeAreaView } from "@/lib/styled";
import { getThemePreference } from "@/lib/theme-preference";

// Hold the native splash open through the daemon handshake. Per Expo docs,
// preventAutoHideAsync MUST run in module scope (not inside a hook) — by the
// time a useEffect fires, the splash has already auto-hidden.
SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ duration: 200, fade: true });

// expo-router modal anchor: when a deep link / Universal Link lands
// directly on the `/pair` modal (cold-launch from a tapped QR link),
// the router needs a background route to materialize underneath the
// modal — otherwise the iOS formSheet has nothing to attach to and
// silently degrades into a fullscreen card.
//
// The anchor MUST point to a route that's currently accessible. With
// Stack.Protected previously at the root, anchoring to either
// `onboarding` or `(drawer)` broke the opposite state. Hoisting the
// gating one level down into `app/(main)/_layout.tsx` lets us anchor
// to the group itself — `(main)` is always reachable, and its inner
// stack handles the unpaired/paired routing.
export const unstable_settings = {
  anchor: "(main)",
};

export default function RootLayout() {
  const scheme = useColorScheme() ?? "light";

  // Apply the persisted theme preference once on boot. `Uniwind.setTheme` drives
  // the className variants + Appearance.setColorScheme (→ every useColorScheme
  // consumer and the nav ThemeProvider below). Default "system" is uniwind's own
  // default, so a fresh install is a no-op. Brief flash possible: SecureStore is
  // async, so we sit at system for a frame or two before a forced theme lands.
  useEffect(() => {
    void getThemePreference().then((pref) => Uniwind.setTheme(pref));
  }, []);

  // Shiki engine + grammar load (~10-50ms JSON.parse, once per run) at app
  // start — the engine README's recommendation, and the upstream example's
  // exact idiom (initialize() from the root component's effect). Launch is
  // splash-covered, so the parse is invisible here; paying it lazily on the
  // first session-enter navigation was visible jank.
  useEffect(() => {
    initHighlighter();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <DaemonClientProvider>
              <SafeAreaListener
                onChange={({ insets }) => {
                  Uniwind.updateInsets(insets);
                }}
              >
                <ThemeProvider
                  value={scheme === "dark" ? DarkTheme : DefaultTheme}
                >
                  <DaemonGate>
                    {/* BottomSheetProvider hosts the portal that the tool-call
                        `ModalBottomSheet` renders into. It MUST sit ABOVE the
                        navigator (RootStack) so the portal — and its scrim —
                        paint over the native UINavigationBar header: an in-tree
                        RN sheet nested inside a screen renders BELOW that native
                        bar (react-native-screens#525, gorhom#502). It MUST also
                        stay INSIDE SafeAreaProvider — the sheet calls
                        useSafeAreaFrame()/useSafeAreaInsets(), which throw with
                        no provider above them. Inside every app provider, just
                        above RootStack, satisfies both; matches SWM's own
                        example (SafeAreaProvider > BottomSheetProvider > nav). */}
                    <BottomSheetProvider>
                      <RootStack />
                    </BottomSheetProvider>
                  </DaemonGate>
                </ThemeProvider>
              </SafeAreaListener>
            </DaemonClientProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Root Stack — just two siblings:
 *
 *   - `pair` — UL landing modal (formSheet, half-detent). Always
 *     accessible because cold-launch UL has no history to fall back
 *     on; this slot has to be unguarded.
 *   - `(main)` — group hosting the real app surface. Its own
 *     `_layout.tsx` runs the Stack.Protected gating between
 *     `onboarding` (unpaired) and `(drawer) / settings / dev/*`
 *     (paired).
 *
 * Anchor (declared above) points at `(main)` so the formSheet has a
 * stable background regardless of paired state. URL paths are
 * unaffected: route groups are URL-transparent.
 *
 * DaemonGate (below) still gates the entire Stack on `isInitialized`
 * to keep the native splash up until the daemon-client state settles.
 */
function RootStack() {
  const colorScheme = useColorScheme() ?? "light";
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(main)" />
      <Stack.Screen
        name="pair"
        options={{
          presentation: "formSheet",
          // [0.5] = half-screen detent. The named `"medium"` literal is
          // only available on the lower-level react-native-screens type;
          // expo-router's wrapper accepts `number[] | "fitToContents"`.
          sheetAllowedDetents: [0.5],
          sheetGrabberVisible: true,
          title: "",
          // Static `true` so the Stack.Toolbar X-button inside pair.tsx
          // adds an item to an already-visible header instead of
          // flipping headerShown from false→true after mount. Without
          // this, react-native-screens warns "Dynamically changing
          // header's visibility in modals will result in remounting the
          // screen" (validated inside NativeStackView.tsx whenever
          // stackPresentation !== 'push').
          headerShown: true,
          contentStyle: {
            backgroundColor:
              colorScheme === "dark"
                ? "rgba(28,28,30,0.6)"
                : "rgba(255,255,255,0.6)",
          },
        }}
      />
    </Stack>
  );
}

// Boot gate. Three concerns are intentionally separate:
//
//   - `isInitialized` — sticky flag, "have we reached any settled state
//     this launch?" Once true we render the real app shell, which may
//     itself be in an `offline` connection state — that's fine, the
//     session list shows an offline badge and the retry loop heals it.
//   - `isLoading` / `error` — the live status. Drives the first-attempt
//     error UI and the Retry button's pending state.
//   - `graceElapsed` — a short post-mount timer. Within the grace the
//     native splash covers the pre-init window so the sub-second happy
//     path never flashes a connecting screen. Past the grace, if we're
//     still pre-init, we hand the splash off to a rendered Connecting
//     view so a daemon-down boot shows live feedback instead of sitting
//     on a frozen splash / blank screen for the whole CONNECT_TIMEOUT_MS.
//
// Pair-vs-main branching is NOT done here — that lives inside `(main)/_layout`
// via `Stack.Protected` guards on `isUnpaired`.
function DaemonGate({ children }: { children: React.ReactNode }) {
  const { isInitialized, isLoading, error, reset } = useDaemonClient();
  const [graceElapsed, setGraceElapsed] = useState(false);

  // Short grace so the happy path (sub-second connect) stays behind the
  // native splash and never flashes the Connecting view.
  useEffect(() => {
    const t = setTimeout(() => setGraceElapsed(true), 700);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    // Hide the native splash once we reach a settled state, hit an error,
    // OR the grace elapses — whichever is first. Past the grace we own the
    // screen with a rendered view, so the splash must hand off rather than
    // sit on top of it.
    if (isInitialized || error || graceElapsed) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [isInitialized, error, graceElapsed]);

  if (!isInitialized) {
    if (error) {
      return (
        <ConnectError
          message={error.message}
          onRetry={reset}
          retrying={isLoading}
        />
      );
    }
    // Pre-init: stay behind the native splash during the grace, then
    // reveal the Connecting view if the handshake is still in flight.
    return graceElapsed ? <Connecting /> : null;
  }

  return <View className="flex-1">{children}</View>;
}

// Pre-init connecting screen, shown once the splash-grace elapses and the
// initial handshake is still in flight — most visibly when the Mac daemon
// is asleep / not running, where the handshake runs the full
// CONNECT_TIMEOUT_MS before the boot path falls to `offline`. The daemon
// hint appears after a few seconds so a slightly-slow-but-fine connect
// doesn't flash it.
function Connecting() {
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowHint(true), 3000);
    return () => clearTimeout(t);
  }, []);
  return (
    <SafeAreaView className="flex-1 items-center justify-center bg-white px-6 dark:bg-black">
      <ActivityIndicator />
      <Text className="mt-4 text-base font-medium text-gray-900 dark:text-gray-100">
        Connecting to daemon…
      </Text>
      {showHint ? (
        <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
          Make sure the Thinkite daemon is running on your Mac.
        </Text>
      ) : null}
    </SafeAreaView>
  );
}

function ConnectError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <SafeAreaView className="flex-1 items-center justify-center bg-white px-6 dark:bg-black">
      <Text className="text-base font-medium text-red-600 dark:text-red-400">
        Couldn't connect to daemon
      </Text>
      <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
        {message}
      </Text>
      <Pressable
        onPress={onRetry}
        disabled={retrying}
        className="mt-5 rounded-md bg-gray-900 px-4 py-2 dark:bg-gray-100"
        style={retrying ? { opacity: 0.5 } : undefined}
      >
        <Text className="text-sm font-medium text-white dark:text-black">
          {retrying ? "Retrying…" : "Retry"}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}
