import {
  decodeWireFrameLength,
  decodeWireFramePayload,
  encodeWireFrame,
  IROH_RPC_ALPN,
  WIRE_FRAME_HEADER_BYTES,
} from "@thinkite/protocol";
import {
  type BiStreamLike,
  type ConnectionLike,
  EndpointAddr,
  EndpointBuilder,
  EndpointId,
  type EndpointLike,
} from "react-native-iroh-ffi";
import { base64UrlToBytes } from "./base64";
import type { ClientIdentity } from "./identity";
import type {
  WireDiagnostics,
  WirePathInfo,
  WireTransport,
} from "./wire-transport";

/**
 * iroh implementation of `WireTransport`: one QUIC connection to the
 * daemon's `IrohPeerServer`, one client-opened bi-stream carrying
 * length-prefix-framed JSON (see protocol/wire-frame.ts). Everything
 * the WebRTC wire does out-of-band comes free here:
 *
 *   - no signaling worker / SDP / ICE — we dial the daemon's
 *     EndpointId (== the QR pubkey) via relays + pkarr discovery;
 *   - no fpSig dance — the QUIC handshake proves both identities, and
 *     the daemon's known_clients gate admits our EndpointId (== our
 *     pairing pubkey, because the endpoint binds on `privateKeySeed`);
 *   - no chunk envelopes — QUIC streams have no message-size cap.
 */

const CLOSE_OK = 0n;

/** Fresh, non-shared ArrayBuffer copy — uniffi args want `ArrayBuffer`
 *  proper, and `TypedArray.buffer.slice()` types as ArrayBufferLike. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * One endpoint per app process, bound lazily on the identity seed and
 * reused across reconnects. Rebinding per connect would race two
 * endpoints publishing the same key to pkarr and churn relay
 * connections; a connection per connect on a stable endpoint is the
 * intended iroh usage.
 */
let endpointPromise: Promise<EndpointLike> | null = null;

function getEndpoint(identity: ClientIdentity): Promise<EndpointLike> {
  endpointPromise ??= (async () => {
    const builder = new EndpointBuilder();
    builder.applyN0();
    builder.secretKey(toArrayBuffer(identity.privateKeySeed));
    return await builder.bind();
  })().catch((err: unknown) => {
    // A failed bind must not poison every future connect.
    endpointPromise = null;
    throw err;
  });
  return endpointPromise;
}

class IrohWireTransport implements WireTransport {
  private onFrame: ((frame: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;
  private closeFired = false;
  private closed = false;
  /** Serializes writeAll calls — concurrent writes on one QUIC stream
   *  would interleave bytes mid-frame (same rule as the daemon side). */
  private writeChain: Promise<void> = Promise.resolve();
  // uniffi exposes BiStream halves as METHODS (napi has getters) —
  // grab each wrapper once instead of re-materializing per call.
  private readonly sendStream: ReturnType<BiStreamLike["send"]>;
  private readonly recvStream: ReturnType<BiStreamLike["recv"]>;

  constructor(
    private readonly conn: ConnectionLike,
    bi: BiStreamLike,
  ) {
    this.sendStream = bi.send();
    this.recvStream = bi.recv();
  }

  /** Start the read loop + death watch. Called once, right after the
   *  bi-stream opens. */
  install(): void {
    void this.readLoop().catch(() => this.fireClose());
    // Transport-level death watch: peer crash, network loss past QUIC's
    // idle timeout, daemon-initiated close. Idempotent with the read
    // loop's error path racing it.
    this.conn
      .closed()
      .then(() => this.fireClose())
      .catch(() => this.fireClose());
  }

  private async readLoop(): Promise<void> {
    const recv = this.recvStream;
    for (;;) {
      // readExact rejects on stream end/reset — the loop's exit path.
      const header = await recv.readExact(WIRE_FRAME_HEADER_BYTES);
      const length = decodeWireFrameLength(new Uint8Array(header));
      const body = await recv.readExact(length);
      if (this.closed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeWireFramePayload(new Uint8Array(body)));
      } catch {
        continue; // framing intact, payload bad — skip, same as WebRTC wire
      }
      this.onFrame?.(parsed);
    }
  }

  diagnostics(): WireDiagnostics {
    let rttMs: number | undefined;
    let paths: WirePathInfo[] | undefined;
    try {
      const rtt = this.conn.rtt();
      rttMs = rtt === undefined ? undefined : Number(rtt);
      paths = this.conn.paths().map((p) => ({
        remoteAddr: p.remoteAddr,
        isSelected: p.isSelected,
        kind: p.isRelay ? ("relay" as const) : ("ip" as const),
        rttMs: Number(p.rttMs),
      }));
    } catch {
      // conn closed — kind alone still identifies the wire
    }
    return { kind: "iroh", rttMs, paths };
  }

  send(frame: unknown): void {
    const buf = toArrayBuffer(encodeWireFrame(JSON.stringify(frame)));
    this.writeChain = this.writeChain
      .then(() => this.sendStream.writeAll(buf))
      .catch(() => {
        // A failed write breaks the stream mid-frame — nothing after it
        // can parse. Transport-fatal; the facade's reconnect recovers.
        this.fireClose();
      });
  }

  setOnFrame(cb: ((frame: unknown) => void) | null): void {
    this.onFrame = cb;
  }

  setOnClose(cb: (() => void) | null): void {
    this.onClose = cb;
  }

  close(): void {
    this.closed = true;
    try {
      this.conn.close(CLOSE_OK, new ArrayBuffer(0));
    } catch {
      // already closed
    }
    this.fireClose();
    // The shared endpoint stays bound — only this connection dies.
  }

  private fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }
}

/**
 * Establish the iroh wire: bind (or reuse) the identity-keyed endpoint,
 * dial the daemon's EndpointId, open the RPC bi-stream. Rejects on
 * `deadlineAt`. The wire-version handshake is NOT part of this — the
 * caller runs `helloHandshake` next, under the same deadline; the
 * daemon's acceptBi only resolves when our first frame (the hello)
 * arrives, so the stream is proven end-to-end by then.
 */
export async function connectIrohWire(
  identity: ClientIdentity,
  daemonPubkey: string,
  deadlineAt: number,
  timeoutMessage: string,
): Promise<WireTransport> {
  const alpn = toArrayBuffer(
    Uint8Array.from(IROH_RPC_ALPN, (c) => c.charCodeAt(0)),
  );
  const remote = EndpointId.fromBytes(
    toArrayBuffer(base64UrlToBytes(daemonPubkey)),
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(timeoutMessage)),
      Math.max(0, deadlineAt - Date.now()),
    );
  });

  try {
    const wire = await Promise.race([
      (async () => {
        const ep = await getEndpoint(identity);
        const addr = new EndpointAddr(remote, undefined, []);
        const conn = await ep.connect(addr, alpn);
        const bi = await conn.openBi();
        const w = new IrohWireTransport(conn, bi);
        w.install();
        return w;
      })(),
      timeout,
    ]);
    return wire;
  } finally {
    clearTimeout(timeoutId);
    // On timeout the losing connect attempt keeps running detached; a
    // late-arriving connection is closed by QUIC idle timeout since no
    // one ever reads/writes it. Acceptable for a dev-toggle path.
  }
}
