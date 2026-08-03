import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Heading } from "@astryxdesign/core/Heading";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { createFileRoute } from "@tanstack/react-router";
import { toDataURL } from "qrcode";
import { useCallback, useEffect, useState } from "react";
import thinkiteLogo from "../assets/thinkite-logo.svg";
import { DRAG_REGION, isDesktopShell } from "../lib/desktop-shell";

// Pairing window content — loaded by the tray's "Pair New Device…" item in
// its own BrowserWindow (the menubar PairView, carried over).
//
// Mints the offer via GET /api/pair/offer and encodes it into the Universal
// Link form `https://thinkite.dev/pair?o=<base64url>` so pointing the
// iPhone's built-in Camera at the QR opens the iOS app directly at its
// `/pair` modal route. The offer is pure (same daemon → same payload), so we
// mint once on mount — no refresh. The admission gate is driven by this
// window's open/close in main.ts (daemon.setPairing), so the QR "always
// works" while the window is open and stops admitting the moment it closes.
//
// QR: the `qrcode` lib renders plain modules to a data URL; the center logo
// is a CSS overlay on a white pad (replaces menubar's react-qrcode-logo —
// zero extra deps). Occlusion budget: an 80px white square over a 320px QR
// covers ~6% of the area; ecLevel M recovers 15% of codewords, so the
// covered modules are comfortably reconstructable.
//
// Copy-code fallback for when the camera can't scan (e.g. simulator):
// CodeBlock's built-in copy button, mirroring the iOS "Paste code" path.

export const Route = createFileRoute("/pair")({
  component: PairPage,
});

const UNIVERSAL_LINK_BASE = "https://thinkite.dev/pair";
const QR_SIZE = 320;
const LOGO_SIZE = 72;

type Offer = { encoded: string; qr: string };

function PairPage() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/pair/offer");
      if (!res.ok) throw new Error(await res.text());
      const { encoded } = (await res.json()) as { encoded: string };
      // Render at 2x and display at QR_SIZE so the modules stay crisp on
      // retina. margin = quiet-zone modules (camera lock-on needs some).
      const qr = await toDataURL(`${UNIVERSAL_LINK_BASE}?o=${encoded}`, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: QR_SIZE * 2,
      });
      setOffer({ encoded, qr });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      {/* The pair window is hiddenInset (no titlebar) — without a drag
          region the whole window is immovable. Fixed strip under the
          traffic lights; content is centered well below it. */}
      {isDesktopShell && (
        <div className="fixed inset-x-0 top-0 h-8" style={DRAG_REGION} />
      )}
      <VStack gap={4} align="center" justify="center" className="h-screen p-6">
        {error !== null ? (
          <Banner
            status="error"
            title="Couldn't create a pairing code"
            description={error}
            endContent={
              <Button label="Retry" variant="ghost" clickAction={refresh} />
            }
          />
        ) : offer === null ? (
          <Spinner size="sm" label="Preparing pairing code…" />
        ) : (
          <>
            <Heading level={4}>Pair New Device</Heading>
            {/* The card stays white in BOTH themes — dark-on-light is the most
              universally scannable, and it pops against a dark window. */}
            <div className="relative rounded-lg border bg-white p-1.5">
              <img
                src={offer.qr}
                alt="Pairing QR code"
                width={QR_SIZE}
                height={QR_SIZE}
              />
              <img
                src={thinkiteLogo}
                alt=""
                width={LOGO_SIZE}
                height={LOGO_SIZE}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white p-1"
              />
            </div>
            <VStack gap={1} align="center">
              <Text size="sm" weight="medium">
                Scan with iPhone camera
              </Text>
              {/* The window IS the admission gate (main.ts setPairing): closing
                it stops admitting, so warn against closing early. */}
              <Text size="xsm" color="secondary" className="text-center">
                Keep this window open until your iPhone connects.
              </Text>
            </VStack>
            <VStack gap={2} className="w-full">
              <Text size="xsm" color="secondary" className="text-center">
                Or paste this code in the app
              </Text>
              <CodeBlock
                code={offer.encoded}
                size="sm"
                width="100%"
                isWrapped
                maxHeight={120}
                hasCopyButton
              />
            </VStack>
          </>
        )}
      </VStack>
    </>
  );
}
