import { loadOrCreateIdentity, seedFromPrivateKey } from "./identity.ts";

/**
 * Phase-2 dev probe: bind an iroh endpoint on the daemon's long-lived
 * ed25519 identity and echo-accept, so the iOS dev screen can dial the
 * REAL daemon identity instead of a throwaway peer.
 *
 * Key point being validated: the pairing identity IS the iroh secret
 * key, so the daemon's EndpointId equals the pubkey the QR already
 * carries (hex vs base64url — same 32 bytes). If this holds, the iroh
 * cutover needs no QR/pairing format change at all.
 *
 * Not wired into `up` — run via `thinkite iroh-probe`. No known_clients
 * gating yet (probe accepts anyone); the accept-gate moves here in
 * phase 3 when this grows into the real transport.
 */

const ALPN = "iroh-ffi/echo/0"; // matches the app dev screen's probe ALPN

export async function runIrohProbe(home: string): Promise<void> {
  // Lazy import: keeps the napi binding off every other subcommand's path.
  const { Endpoint } = await import("@number0/iroh");

  const identity = loadOrCreateIdentity(home);
  const seed = seedFromPrivateKey(identity.privateKey);

  const b = Endpoint.builder();
  b.applyN0();
  b.secretKey(Array.from(seed));
  b.alpns([Array.from(Buffer.from(ALPN))]);
  const ep = await b.bind();

  const endpointId = ep.id().toString();
  const pubkeyHex = Buffer.from(identity.publicKeyB64, "base64url").toString(
    "hex",
  );
  console.log(`[iroh-probe] EndpointId:        ${endpointId}`);
  console.log(`[iroh-probe] identity (hex):    ${pubkeyHex}`);
  console.log(
    `[iroh-probe] identity == EndpointId: ${endpointId === pubkeyHex ? "YES — pairing key IS the iroh key" : "NO (mismatch!)"}`,
  );
  console.log(`[iroh-probe] fingerprint:       ${identity.fingerprint}`);
  console.log(`[iroh-probe] ALPN ${ALPN} — waiting for connections…`);

  let n = 0;
  for (;;) {
    const incoming = await ep.acceptNext();
    if (!incoming) break;
    const i = ++n;
    void (async () => {
      const accepting = await incoming.accept();
      const conn = await accepting.connect();
      console.log(`[iroh-probe] #${i} connection accepted`);
      const bi = await conn.acceptBi();
      const data = await bi.recv.readToEnd(65536);
      const text = Buffer.from(data).toString("utf8");
      console.log(`[iroh-probe] #${i} recv: ${JSON.stringify(text)}`);
      await bi.send.writeAll(Array.from(Buffer.from(`echo:${text}`)));
      await bi.send.finish();
      await conn.closed();
      console.log(`[iroh-probe] #${i} closed`);
    })().catch((e) => console.error(`[iroh-probe] #${i} error:`, e));
  }
}
