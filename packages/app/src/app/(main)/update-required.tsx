// Button comes from the swift-ui entry, NOT universal: universal Button
// prepends a variant-derived `buttonStyle()` at modifier index 0, and
// SwiftUI's innermost buttonStyle wins — a user-passed
// `buttonStyle("glassProminent")` is silently inert there. swift-ui
// Button injects nothing, so ours is the only one. Host/Column/Icon/Text
// stay universal: their iOS impls are thin swift-ui wrappers (Host is a
// literal re-export), so the mixed tree is native-identical.
import { Column, Host, Icon, Text as UIText } from "@expo/ui";
import { Button } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  controlSize,
  frame,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useCallback } from "react";
import { Alert, Linking, Pressable, Text, View } from "react-native";
import { useDaemonClient } from "@/lib/daemon-client-context";

// Website redirect, not a hardcoded App Store id — the site can point at
// TestFlight today and the store listing later without an app release.
const IOS_UPDATE_URL = "https://thinkite.dev/ios";

/**
 * `/update-required` — protocol-mismatch gate (only reachable while
 * `isProtocolBlocked` is true; see `(main)/_layout.tsx` for why this is
 * a route gate and not a banner).
 *
 * One route for both directions in V0; the copy + primary action branch
 * on `protocolError.outdatedSide`:
 *
 *   - `"app"`    → this app is too old. Primary = open the update page
 *     (the one direction we can never self-heal — iOS apps can't update
 *     themselves). Conceptually this branch is the screen's terminal
 *     identity: in a multi-daemon future, the `"daemon"` branch leaves
 *     the route gate (per-daemon badge + daemon self-update) and this
 *     route narrows to the app-outdated force-update screen.
 *   - `"daemon"` → the Mac app is too old. Primary = Try Again, for
 *     after the user updates the Mac side (menu bar → Check for
 *     updates). Becomes a transient "Mac is updating…" state once
 *     daemon self-update-on-mismatch lands.
 *   - `"unknown"` → no usable daemon version (shouldn't happen against
 *     a real daemon) — neutral both-sides copy, Retry.
 *
 * Layout follows the onboarding idiom: RN owns layout/text/theming,
 * the bottom CTA bar is the only `@expo/ui` Host island so the buttons
 * get the native iOS control look.
 */
export default function UpdateRequiredRoute() {
  const { protocolError, paired, isLoading, reset, unpair } = useDaemonClient();

  const handleRetry = useCallback(() => reset(), [reset]);

  const handleOpenUpdatePage = useCallback(() => {
    void Linking.openURL(IOS_UPDATE_URL);
  }, []);

  const handleForget = useCallback(() => {
    Alert.alert(
      "Forget this Mac?",
      "You'll need to scan its QR code again to reconnect.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Forget", style: "destructive", onPress: () => void unpair() },
      ],
    );
  }, [unpair]);

  // Guard-unmount race: the route can render one frame after a successful
  // retry cleared the error. Render nothing; the gate is about to flip.
  if (!protocolError) return null;

  const side = protocolError.outdatedSide;
  const serviceName = paired?.serviceName;

  return (
    <View className="flex-1 bg-white dark:bg-black px-6 pb-safe-offset-4 pt-safe">
      <View className="flex-1 justify-center">
        <Host matchContents style={{ alignSelf: "flex-start" }}>
          <Icon name="arrow.up.circle" size={56} color="#EE5722" />
        </Host>
        <Text className="mt-4 text-3xl font-bold text-black dark:text-white">
          Update Required
        </Text>
        <Text className="mt-2 text-base text-gray-500 dark:text-gray-400">
          {protocolError.message}
        </Text>
        {serviceName ? (
          <Text className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Paired with {serviceName}.
          </Text>
        ) : null}
        {/* Diagnostics footnote — protocol (wire) versions, not marketing
            versions. Useful in a bug report screenshot. */}
        <Text className="mt-3 text-xs text-gray-400 dark:text-gray-500">
          App protocol {protocolError.appProtocolVersion} · Mac protocol{" "}
          {protocolError.daemonProtocolVersion ?? "unknown"}
        </Text>
      </View>

      {side === "daemon" ? (
        <Text className="mb-3 text-sm text-gray-500 dark:text-gray-400 text-center">
          On your Mac: Thinkite menu → Check for updates.
        </Text>
      ) : null}

      <Host
        matchContents={{ vertical: true }}
        style={{ alignSelf: "stretch" }}
        ignoreSafeArea="keyboard"
      >
        <Column spacing={8}>
          {side === "app" ? (
            <Button
              onPress={handleOpenUpdatePage}
              modifiers={[
                buttonStyle("glassProminent"),
                controlSize("extraLarge"),
                tint("#EE5722"),
              ]}
            >
              <UIText
                textStyle={{ fontWeight: "600", textAlign: "center" }}
                modifiers={[frame({ maxWidth: Infinity })]}
              >
                Get the Update
              </UIText>
            </Button>
          ) : null}
          {/* Primary when it's the only action (daemon/unknown), secondary
              next to Get the Update (app). Secondary is `bordered`, not
              `glass`: plain glass has nothing to refract on this flat
              content-layer background and reads as a barely-visible frosted
              capsule (verified on-device; matches Apple's own practice —
              content-layer CTAs on plain backgrounds stay bordered/filled). */}
          <Button
            onPress={handleRetry}
            modifiers={[
              buttonStyle(side === "app" ? "bordered" : "glassProminent"),
              controlSize("extraLarge"),
              tint("#EE5722"),
            ]}
          >
            <UIText
              textStyle={
                side === "app"
                  ? { textAlign: "center" }
                  : { fontWeight: "600", textAlign: "center" }
              }
              modifiers={[frame({ maxWidth: Infinity })]}
            >
              {isLoading ? "Retrying…" : "Try Again"}
            </UIText>
          </Button>
        </Column>
      </Host>

      {/* Escape hatch — without it a user who wants to pair a different
          (already-updated) Mac is soft-locked on this screen. */}
      <Pressable
        onPress={handleForget}
        hitSlop={8}
        className="mt-4 self-center"
      >
        <Text className="text-sm text-gray-500 dark:text-gray-400">
          Forget this Mac
        </Text>
      </Pressable>
    </View>
  );
}
