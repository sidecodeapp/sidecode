import type {
  BiStream,
  Connection,
  Endpoint,
  Incoming,
} from "@number0/iroh";
import {
  type ClientFrame,
  type Command,
  clientFrame,
  type DaemonFrame,
  decodeWireFrameLength,
  decodeWireFramePayload,
  encodeWireFrame,
  IROH_RPC_ALPN,
  isProtocolCompatible,
  PROTOCOL_VERSION,
  WIRE_FRAME_HEADER_BYTES,
} from "@thinkite/protocol";
import type { CommandContext, CommandHandler } from "./command.ts";
import type { Identity } from "./identity.ts";
import { fingerprintFromPubkeyB64, seedFromPrivateKey } from "./identity.ts";
import type { KnownClients } from "./known-clients.ts";

/**
 * iroh QUIC transport — phase 3 of the iroh integration. Runs ALONGSIDE
 * WebRTCPeerServer on the same daemon identity (an iroh endpoint hosts
 * many ALPNs; this one owns `thinkite/rpc/1`, the echo probe keeps its
 * own). WebRTC stays the default client path; the app dials this one
 * behind a dev toggle until the cutover decision.
 *
 * Everything the WebRTC path built out-of-band comes free here:
 *
 *   - Identity: the QUIC handshake proves possession of the ed25519 key
 *     whose pubkey IS the EndpointId (phase 2 validated EndpointId ==
 *     pairing pubkey byte-for-byte). No signaling worker, no DTLS
 *     fingerprint signing dance — `conn.remoteId()` is authenticated by
 *     the transport itself.
 *   - Admission: `remoteId` is matched against known_clients right after
 *     the handshake; unknown ids are admitted only while the pair window
 *     is open (same `isPairing` gate as WebRTC).
 *   - Framing: one client-opened bi-stream per connection carries
 *     length-prefixed JSON frames (see protocol/wire-frame.ts). No SCTP
 *     message cap → no chunking envelopes on this path.
 *
 * The hello/server_info wire-version handshake is copied unchanged from
 * WebRTCPeerServer — same frames, same `isProtocolCompatible` rule — so
 * the app's RPC layer sees an identical protocol regardless of transport.
 */

/** QUIC application close codes (u62, surfaced to the peer). */
const CLOSE_OK = 0n;
const CLOSE_UNKNOWN_CLIENT = 1n;
const CLOSE_PROTOCOL_ERROR = 2n;

/**
 * Max time from connection-accepted to hello-verified. The QUIC
 * handshake is already done by accept time, so this only bounds a peer
 * that connects and then stalls before opening the RPC stream or
 * sending `hello` — much tighter than WebRTC's 30s setup budget.
 */
const HELLO_TIMEOUT_MS = 10_000;

export interface IrohPeerServerOptions {
  /** Daemon's long-lived ed25519 identity — doubles as the iroh secret
   *  key, so the EndpointId clients dial IS the pairing pubkey. */
  identity: Identity;
  /** Same admission source of truth as the WebRTC path. */
  knownClients: KnownClients;
  /** Invoked for each application command after the wire-version
   *  handshake. Same contract as WebRTCPeerServer's. */
  commandHandler?: CommandHandler;
  /** Pair-window gate for admitting unknown pubkeys (see WebRTC twin). */
  isPairing?: () => boolean;
  /**
   * Endpoint preset. "n0" (default) = production relays + pkarr
   * discovery. "minimal" = no external services — tests dial by direct
   * address, offline.
   */
  preset?: "n0" | "minimal";
  log?: (event: string, data?: Record<string, unknown>) => void;
}

interface PeerSlot {
  /** `conn.stableId()` — unique per connection within this endpoint. */
  key: number;
  conn: Connection;
  bi: BiStream;
  /** base64url raw pubkey == remote EndpointId bytes. */
  clientPubkey: string;
  fingerprint: string;
  /** True once `hello` passed the version gate. */
  versionVerified: boolean;
  /** Reaps peers that connect but never complete `hello`. */
  helloTimeoutId: ReturnType<typeof setTimeout> | null;
  /**
   * Serializes writeAll calls — concurrent writes on one QUIC stream
   * would interleave bytes mid-frame. Each send chains onto the tail;
   * a failed write closes the peer (byte-stream framing can't resync).
   */
  writeChain: Promise<void>;
  disconnectCallbacks: Array<() => void>;
  scratch: Map<string, unknown>;
}

export class IrohPeerServer {
  private endpoint: Endpoint | null = null;
  private readonly peers = new Map<number, PeerSlot>();
  private stopped = false;
  private readonly identity: Identity;
  private readonly knownClients: KnownClients;
  private readonly commandHandler?: CommandHandler;
  private readonly isPairing: () => boolean;
  private readonly preset: "n0" | "minimal";
  private readonly log: NonNullable<IrohPeerServerOptions["log"]>;

  constructor(options: IrohPeerServerOptions) {
    this.identity = options.identity;
    this.knownClients = options.knownClients;
    this.commandHandler = options.commandHandler;
    this.isPairing = options.isPairing ?? (() => false);
    this.preset = options.preset ?? "n0";
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Bind the endpoint and start accepting. Resolves once bound (accept
   * loop continues in the background). The napi binding is imported
   * lazily so a missing/broken native module degrades to "iroh listener
   * unavailable" instead of failing daemon boot — the caller logs the
   * rejection and the WebRTC path carries on.
   */
  async start(): Promise<void> {
    if (this.endpoint) throw new Error("IrohPeerServer already started");
    const { Endpoint } = await import("@number0/iroh");

    const b = Endpoint.builder();
    if (this.preset === "n0") b.applyN0();
    else b.applyMinimal();
    b.secretKey(Array.from(seedFromPrivateKey(this.identity.privateKey)));
    b.alpns([Array.from(Buffer.from(IROH_RPC_ALPN))]);
    const ep = await b.bind();
    if (this.stopped) {
      // stop() raced the bind — don't leak the endpoint.
      await ep.close();
      return;
    }
    this.endpoint = ep;
    this.log("iroh.listening", {
      endpointId: ep.id().toString(),
      alpn: IROH_RPC_ALPN,
    });
    void this.acceptLoop(ep);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const peer of [...this.peers.values()]) {
      this.closePeer(peer, "shutdown");
    }
    this.peers.clear();
    if (this.endpoint) {
      const ep = this.endpoint;
      this.endpoint = null;
      try {
        await ep.close();
      } catch {
        // ignore
      }
    }
  }

  /** Peers admitted past the known_clients gate (QUIC handshake = auth). */
  authenticatedCount(): number {
    return this.peers.size;
  }

  /** Test hook: the bound endpoint's dialable address (id + direct addrs). */
  endpointAddr() {
    if (!this.endpoint) throw new Error("IrohPeerServer not started");
    return this.endpoint.addr();
  }

  // ─── Accept path ─────────────────────────────────────────────────

  private async acceptLoop(ep: Endpoint): Promise<void> {
    for (;;) {
      let incoming: Incoming | null;
      try {
        incoming = await ep.acceptNext();
      } catch (err) {
        if (!this.stopped) {
          this.log("iroh.accept_loop_error", {
            error: (err as Error).message,
          });
        }
        return;
      }
      if (!incoming) return; // endpoint closed
      void this.handleIncoming(incoming).catch((err: unknown) => {
        // Handshake-phase failures (peer vanished mid-accept, stream
        // never opened…) are per-connection noise, not server errors.
        this.log("iroh.incoming_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async handleIncoming(incoming: Incoming): Promise<void> {
    const accepting = await incoming.accept();
    const conn = await accepting.connect();

    // ── known_clients gate ──
    // remoteId is authenticated by the QUIC handshake itself (the peer
    // proved possession of the matching secret key). Compare raw bytes,
    // not string forms — known_clients stores base64url.
    const clientPubkey = Buffer.from(
      Uint8Array.from(conn.remoteId().toBytes()),
    ).toString("base64url");
    let known = this.knownClients
      .list()
      .find((c) => c.publicKeyB64 === clientPubkey);
    if (!known) {
      if (!this.isPairing()) {
        this.log("iroh.peer.rejected_unknown", {
          pubkey: clientPubkey.slice(0, 12),
        });
        conn.close(CLOSE_UNKNOWN_CLIENT, Array.from(Buffer.from("unknown")));
        return;
      }
      const fingerprint = fingerprintFromPubkeyB64(clientPubkey);
      known = {
        fingerprint,
        publicKeyB64: clientPubkey,
        pairedAt: Date.now(),
      };
      this.knownClients.add(known);
      this.log("iroh.peer.paired", { fingerprint });
    }

    // ── RPC stream ──
    // The client opens the bi-stream and speaks first (hello), so
    // acceptBi resolves as soon as its first bytes arrive. The hello
    // timeout below covers a peer that connects and then goes silent —
    // it closes the conn, which rejects this await and any pending read.
    const helloTimeoutId = setTimeout(() => {
      const slot = this.peers.get(conn.stableId());
      if (slot && !slot.versionVerified) {
        this.closePeer(slot, "hello timeout");
      } else if (!slot) {
        // acceptBi still pending — no slot yet; close the conn directly.
        try {
          conn.close(CLOSE_PROTOCOL_ERROR, Array.from(Buffer.from("timeout")));
        } catch {
          // ignore
        }
      }
    }, HELLO_TIMEOUT_MS);

    let bi: BiStream;
    try {
      bi = await conn.acceptBi();
    } catch (err) {
      clearTimeout(helloTimeoutId);
      throw err;
    }

    const slot: PeerSlot = {
      key: conn.stableId(),
      conn,
      bi,
      clientPubkey,
      fingerprint: known.fingerprint,
      versionVerified: false,
      helloTimeoutId,
      writeChain: Promise.resolve(),
      disconnectCallbacks: [],
      scratch: new Map(),
    };
    this.peers.set(slot.key, slot);
    this.log("iroh.peer.connected", { fingerprint: slot.fingerprint });

    // Transport-level death watch (peer crash, network loss past QUIC's
    // idle timeout, explicit close). closePeer is idempotent, so this
    // coexists with the read loop's error path racing it.
    void conn
      .closed()
      .then((reason) => this.closePeer(slot, `connection closed: ${reason}`))
      .catch(() => this.closePeer(slot, "connection closed"));

    void this.readLoop(slot).catch((err: unknown) => {
      this.closePeer(
        slot,
        `read error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // ─── Frame read loop + dispatch ──────────────────────────────────

  private async readLoop(slot: PeerSlot): Promise<void> {
    const recv = slot.bi.recv;
    for (;;) {
      // readExact rejects on stream end/reset — that's the loop's exit,
      // surfaced through the catch in handleIncoming.
      const header = await recv.readExact(WIRE_FRAME_HEADER_BYTES);
      const length = decodeWireFrameLength(Uint8Array.from(header));
      const body = await recv.readExact(length);
      if (!this.peers.has(slot.key)) return; // closed while reading
      this.onFrame(slot, decodeWireFramePayload(Uint8Array.from(body)));
    }
  }

  private onFrame(slot: PeerSlot, json: string): void {
    let frame: ClientFrame;
    try {
      frame = clientFrame.parse(JSON.parse(json));
    } catch (err) {
      this.log("iroh.peer.bad_frame", {
        fingerprint: slot.fingerprint,
        error: (err as Error).message,
      });
      // Same policy as WebRTC: a malformed frame from an authenticated
      // peer is more likely a bug than an attack — don't kill the
      // channel. (Framing stays intact; only the JSON was bad.)
      return;
    }

    // ── Wire-version handshake gate (copied from WebRTCPeerServer) ──
    if (frame.type === "hello") {
      if (slot.versionVerified) return; // re-hello: ignore
      if (!isProtocolCompatible(frame.protocolVersion)) {
        this.log("iroh.peer.version_mismatch", {
          fingerprint: slot.fingerprint,
          clientProtocolVersion: frame.protocolVersion,
          daemonProtocolVersion: PROTOCOL_VERSION,
        });
        this.send(slot, {
          type: "error",
          code: "incompatible_protocol",
          message: `client protocol ${frame.protocolVersion} is not compatible with daemon ${PROTOCOL_VERSION}`,
          protocolVersion: PROTOCOL_VERSION,
        });
        this.closePeerAfterFlush(slot, "incompatible wire protocol");
        return;
      }
      slot.versionVerified = true;
      if (slot.helloTimeoutId) {
        clearTimeout(slot.helloTimeoutId);
        slot.helloTimeoutId = null;
      }
      this.send(slot, {
        type: "server_info",
        protocolVersion: PROTOCOL_VERSION,
      });
      this.log("iroh.peer.version_ok", {
        fingerprint: slot.fingerprint,
        protocolVersion: frame.protocolVersion,
      });
      return;
    }

    if (!slot.versionVerified) {
      this.log("iroh.peer.pre_hello_frame", {
        fingerprint: slot.fingerprint,
        frameType: frame.type,
      });
      this.send(slot, {
        type: "error",
        code: "incompatible_protocol",
        message: "hello required before any other frame",
      });
      this.closePeerAfterFlush(slot, "frame before hello");
      return;
    }

    if (frame.type === "ping") {
      this.send(slot, { type: "pong", t: Date.now(), echoT: frame.t });
      return;
    }

    const handler = this.commandHandler;
    if (!handler) {
      this.log("iroh.peer.unhandled", {
        fingerprint: slot.fingerprint,
        frameType: frame.type,
      });
      return;
    }
    const cmd = frame as Command;
    const ctx: CommandContext = {
      send: (f) => this.send(slot, f),
      fingerprint: slot.fingerprint,
      onDisconnect: (cb) => slot.disconnectCallbacks.push(cb),
      state: slot.scratch,
    };
    Promise.resolve()
      .then(() => handler(cmd, ctx))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log("iroh.peer.handler_error", {
          fingerprint: slot.fingerprint,
          frameType: frame.type,
          error: message,
        });
        const requestId =
          "requestId" in cmd
            ? (cmd as { requestId?: string }).requestId
            : undefined;
        this.send(slot, {
          type: "error",
          requestId,
          code: "internal",
          message: `handler error: ${message}`,
        });
      });
  }

  // ─── Send / close ────────────────────────────────────────────────

  private send(slot: PeerSlot, frame: DaemonFrame): void {
    if (!this.peers.has(slot.key)) return;
    let bytes: Uint8Array;
    try {
      bytes = encodeWireFrame(JSON.stringify(frame));
    } catch (err) {
      this.log("iroh.peer.send.encode_error", {
        fingerprint: slot.fingerprint,
        error: (err as Error).message,
      });
      return;
    }
    // napi writeAll takes Array<number> — a transient number[] copy of
    // the frame. Fine for RPC-sized frames; revisit if profiling shows
    // multi-MB subscribe responses hurting.
    slot.writeChain = slot.writeChain
      .then(() => slot.bi.send.writeAll(Array.from(bytes)))
      .catch((err: unknown) => {
        // A failed write means the stream is broken mid-frame — the
        // peer can't parse anything after it. Close; reconnect recovers.
        this.closePeer(
          slot,
          `write error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Close after the pending writes (e.g. a final error frame) flush. */
  private closePeerAfterFlush(slot: PeerSlot, reason: string): void {
    void slot.writeChain.then(() => this.closePeer(slot, reason));
  }

  private closePeer(slot: PeerSlot, reason: string): void {
    if (!this.peers.delete(slot.key)) return;
    if (slot.helloTimeoutId) {
      clearTimeout(slot.helloTimeoutId);
      slot.helloTimeoutId = null;
    }
    for (const cb of slot.disconnectCallbacks) {
      try {
        cb();
      } catch (err) {
        this.log("iroh.peer.cleanup_error", {
          fingerprint: slot.fingerprint,
          error: (err as Error).message,
        });
      }
    }
    try {
      slot.conn.close(CLOSE_OK, []);
    } catch {
      // already closed
    }
    this.log("iroh.peer.closed", {
      fingerprint: slot.fingerprint,
      reason,
    });
  }
}
