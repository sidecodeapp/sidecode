// Button from swift-ui, not universal: universal Button's variant prop
// injects a buttonStyle at modifier index 0 (SwiftUI-innermost, wins),
// so glass styles can't be expressed through it. House CTA style is
// `glassProminent` primary + `bordered` secondary (plain `glass` is
// near-invisible on flat content-layer backgrounds). Host/Column/Text
// stay universal — thin swift-ui wrappers, same native tree.
import { Column, Host, Text as UIText } from "@expo/ui";
import { Button } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, frame } from "@expo/ui/swift-ui/modifiers";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router, Stack } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Linking, Pressable, Text, View } from "react-native";
import { ThinkiteMark } from "@/components/thinkite-mark";

/**
 * `/onboarding` — first-launch / re-pair gate (only reachable while
 * `isUnpaired` is true). Single primary action (Scan), paste as a secondary
 * fallback, and a persistent "get the Mac app" footer.
 *
 * Two ways to get a pair offer in:
 *   1. **Scan QR** — `CameraView.launchScanner` opens the iOS 16+
 *      `DataScannerViewController`. We register the result via
 *      `onModernBarcodeScanned` BEFORE launchScanner, then `dismissScanner()`
 *      once we have a value. Permission is requested lazily on first tap.
 *   2. **Paste code** — `Alert.prompt` (iOS-only native prompt). The user
 *      long-press-pastes the base64url payload (or full UL) copied from
 *      sidecode on the Mac. Single-line is fine: it's paste-and-go, and
 *      `/pair` shows the decoded serviceName as the real confirmation.
 *
 * Both route the payload to the `/pair` modal (the single owner of `pair()` +
 * confirmation). UL deep-links land on the same modal, so all paths converge.
 *
 * UI is hybrid: RN owns the layout, text, brand mark, and the footer link
 * (flexbox + uniwind `dark:` theming, `Pressable`/`Image` do links + logos
 * naturally). ONLY the CTA bar is an `@expo/ui` Host island, so the
 * Buttons render the native iOS 26 control look that RN can't reproduce —
 * house style `buttonStyle("glassProminent")` primary + `"bordered"`
 * secondary (see import note).
 * The Host self-sizes its height via `matchContents={{ vertical: true }}`
 * (effective on iOS) and `alignSelf:"stretch"` gives it RN's full width;
 * `ignoreSafeArea="keyboard"` stops the Alert.prompt keyboard from shoving
 * the Host upward.
 */
function extractOfferPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Tolerate any URL whose `o` query param holds the offer — keeps the scanner
  // working if we ever change the canonical host (preview / staging) without
  // re-rolling the iOS app.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const o = url.searchParams.get("o");
      if (o) return o;
    } catch {
      // Fall through — treat a malformed URL as a bare payload.
    }
  }
  return trimmed;
}

export default function OnboardingRoute() {
  // Tuple from useCameraPermissions: [status, request, get]. We only need the
  // request action — the user always taps "Scan" first, which fires it.
  const [, requestCameraPermission] = useCameraPermissions();

  const [error, setError] = useState<string | null>(null);
  // Guards a stale onModernBarcodeScanned callback firing after we've already
  // kicked off the pair modal (the scanner can deliver several results before
  // dismiss completes).
  const handlingScanRef = useRef(false);

  const openPairModal = useCallback((raw: string) => {
    const payload = extractOfferPayload(raw);
    if (!payload) {
      setError("Empty pair code");
      return;
    }
    setError(null);
    // The modal owns busy / error / confirmation UI from here on.
    router.push({ pathname: "/pair", params: { o: payload } });
  }, []);

  const handleScan = useCallback(async () => {
    setError(null);
    try {
      const perm = await requestCameraPermission();
      if (!perm.granted) {
        setError("Camera permission denied. Use “Paste code” instead.");
        return;
      }
      handlingScanRef.current = false;
      const sub = CameraView.onModernBarcodeScanned((event) => {
        if (handlingScanRef.current) return;
        handlingScanRef.current = true;
        sub.remove();
        void CameraView.dismissScanner();
        openPairModal(event.data);
      });
      try {
        await CameraView.launchScanner({ barcodeTypes: ["qr"] });
      } catch (err) {
        sub.remove();
        // launchScanner rejects on simulator (no DataScannerViewController) —
        // point at the paste path instead of a generic error.
        setError(
          `Scanner unavailable on this device. Use “Paste code” instead. (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [requestCameraPermission, openPairModal]);

  const handlePaste = useCallback(() => {
    // iOS-only native prompt; the user long-press-pastes the code. V0 is
    // iOS-only, so no Android fallback is needed here.
    Alert.prompt(
      "Paste pair code",
      "Paste the code shown in Thinkite on your Mac.",
      (value) => openPairModal(value ?? ""),
      "plain-text",
    );
  }, [openPairModal]);

  const openMacDownload = useCallback(() => {
    void Linking.openURL("https://thinkite.dev/mac");
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-white dark:bg-black px-6 pb-safe-offset-4 pt-safe">
        <View className="flex-1 justify-center">
          <ThinkiteMark size={64} />
          <Text className="mt-4 text-3xl font-bold text-black dark:text-white">
            thinkite
          </Text>
          <Text className="mt-2 text-base text-gray-500 dark:text-gray-400">
            Control Claude Code on Mac from your phone.
          </Text>
          <Text className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Peer-to-peer — your code never leaves your devices.
          </Text>
          {error ? (
            <Text className="mt-3 text-sm text-red-500">{error}</Text>
          ) : null}
        </View>

        {/* The precondition first-run users miss: a QR only exists once the
            Mac side opens its Pair window. Name the exact menu item. */}
        <Text className="mb-3 text-sm text-gray-500 dark:text-gray-400 text-center">
          Thinkite Mac menu → Pair new device.
        </Text>

        {/* CTA bar — the only @expo/ui island. Universal Buttons render the
            native iOS 26 Liquid Glass control look; the Host self-sizes its
            height (matchContents) and stretches to RN's full width. */}
        <Host
          matchContents={{ vertical: true }}
          style={{ alignSelf: "stretch" }}
          ignoreSafeArea="keyboard"
        >
          <Column spacing={8}>
            <Button
              onPress={handleScan}
              modifiers={[
                buttonStyle("glassProminent"),
                controlSize("extraLarge"),
              ]}
            >
              <UIText
                textStyle={{
                  fontWeight: "600",
                  textAlign: "center",
                }}
                modifiers={[frame({ maxWidth: Infinity })]}
              >
                Scan QR code
              </UIText>
            </Button>
            <Button
              onPress={handlePaste}
              modifiers={[buttonStyle("bordered"), controlSize("extraLarge")]}
            >
              <UIText
                textStyle={{
                  textAlign: "center",
                }}
                modifiers={[frame({ maxWidth: Infinity })]}
              >
                Paste code
              </UIText>
            </Button>
          </Column>
        </Host>

        {/* Footer link — RN handles tappable links + styling naturally. */}
        <Pressable
          onPress={openMacDownload}
          hitSlop={8}
          className="mt-4 self-center"
        >
          <Text className="text-sm text-gray-500 dark:text-gray-400">
            Need the Mac app?{" "}
            <Text className="text-gray-900 underline dark:text-gray-200">
              thinkite.dev/mac
            </Text>
          </Text>
        </Pressable>
      </View>
    </>
  );
}
