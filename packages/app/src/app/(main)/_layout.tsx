import { Stack } from "expo-router";
import { useColorScheme } from "react-native";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Nested Stack for the auth-gated app surface. Lives inside the
 * `(main)` route group so the root layout can anchor the `/pair`
 * modal to a route name that's ALWAYS accessible — `(main)` itself —
 * without leaking unpaired-vs-paired logic up to the root.
 *
 * Without this layer the anchor had to be either `onboarding` or
 * `(drawer)`, and whichever it was got blocked by Stack.Protected in
 * the opposite state — when that happened the formSheet couldn't
 * find a background to mount on and silently degraded to a fullscreen
 * card. Hoisting the gating one level down sidesteps that.
 *
 * URL paths are unchanged — route groups (parenthesized folders) are
 * URL-transparent in expo-router. `/onboarding`, `/settings`, the `/dev/*`
 * probes and the drawer routes all stay at the same paths.
 */
export default function MainLayout() {
  const { isUnpaired, isProtocolBlocked } = useDaemonClient();
  const scheme = useColorScheme() ?? "light";
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isUnpaired}>
        {/* First-launch / re-pair gate — fullscreen card with the
            in-app QR scanner and paste-payload fallback. */}
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={!isUnpaired && isProtocolBlocked}>
        {/* Protocol-mismatch gate. A version mismatch is TERMINAL (no
            retry fixes it) and the main UI is a dead shell behind it
            (every RPC would hang), so the whole surface gates rather
            than badges. This does NOT violate the identity-axis rule —
            that rule keeps TRANSIENT health states (connecting/offline)
            off the route gate; a terminal mismatch is stable until the
            user updates, retries successfully, or unpairs. */}
        <Stack.Screen name="update-required" />
      </Stack.Protected>
      <Stack.Protected guard={!isUnpaired && !isProtocolBlocked}>
        {/* (drawer) is a route group hosting the main app: Drawer with
            custom session-list sidebar, plus the new-session create page
            (index) and session detail. */}
        <Stack.Screen
          name="(drawer)"
          options={{
            contentStyle: {
              backgroundColor: scheme === "dark" ? "#000000" : "#ffffff",
            },
          }}
        />
        {/* Settings rendered as iOS pageSheet — same physics as the
            tool-detail BottomSheet but as a routable modal (gets a URL,
            supports deep linking). The route is a group
            (`settings/_layout.tsx`) hosting an inner native Stack so
            list → host detail pushes inside the sheet (with native
            back arrow), instead of stacking a second sheet on top. */}
        <Stack.Screen name="settings" options={{ presentation: "pageSheet" }} />
        {/* cwd picker — pageSheet hosting an inner Stack so each folder
            tap pushes a new in-sheet route with native edge-swipe back.
            Tapping ✓ confirms via `setLastUsedCwd.mutate(path)` +
            `router.dismissTo("/")`, which bubbles POP_TO past the inner
            stack and pops the cwd-picker screen from (main). */}
        <Stack.Screen
          name="cwd-picker"
          options={{ presentation: "formSheet", sheetGrabberVisible: true }}
        />
        {/* Dev probe pages — keep as standard pushes, no modal. */}
        <Stack.Screen name="dev/keyboard-extender" />
        <Stack.Screen name="dev/iroh" />
      </Stack.Protected>
    </Stack>
  );
}
