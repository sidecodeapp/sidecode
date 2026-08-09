import { hostname } from "node:os";
import QRCode from "qrcode";
import { readActiveDaemonLock } from "./daemon-lock.ts";
import { resolveThinkiteHome } from "./home.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { createPairOffer } from "./pairing.ts";

/**
 * Implementation of the `sidecode pair` subcommand.
 *
 * Stateless print: reads identity from $THINKITE_HOME, confirms the
 * running `sidecode up` daemon via $THINKITE_HOME/daemon.lock, and prints
 * a fresh pair.offer for it. Does NOT spawn a server of its own — safe
 * to run multiple times. The offer is just `daemonIdentityPublicKey +
 * serviceName`; the signaling worker handles discovery; admission of
 * unknown pubkeys is gated by the daemon's pair-window flag (set when
 * the menubar Pair window is open).
 */
export async function runPairCommand(_args: readonly string[]): Promise<void> {
  const home = resolveThinkiteHome();
  const identity = loadOrCreateIdentity(home);

  const lock = readActiveDaemonLock(home);
  if (!lock) {
    console.error("✗ sidecode is not running.");
    console.error("");
    console.error("Start it first:");
    console.error("  sidecode up");
    console.error("");
    console.error("Then re-run `sidecode pair` (in another terminal).");
    process.exit(1);
  }

  // Caveat: this CLI mints the offer in a separate process, so it can NOT
  // open the running daemon's pair-window admission gate (that gate is driven
  // by the menubar Pair window's open/close, in-process). For a fresh pair,
  // also open the menubar's Pair UI. For re-pairing an already-known client
  // (e.g. wiped iOS install with same pubkey), this CLI alone is enough.
  const { encoded } = createPairOffer(identity, hostname());

  const qr = await QRCode.toString(encoded, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "M",
  });

  console.log("Scan with sidecode iOS:");
  console.log("");
  console.log(qr);
  console.log("Or paste this payload into the app:");
  console.log("");
  console.log(encoded);
  console.log("");
  console.log(`Daemon PID:   ${lock.pid}`);
  console.log(`Fingerprint:  ${identity.fingerprint}`);
  console.log("");
  console.log(
    "If iOS doesn't have this client paired yet, open the menubar's Pair window first — that opens the daemon's admission gate.",
  );
}
