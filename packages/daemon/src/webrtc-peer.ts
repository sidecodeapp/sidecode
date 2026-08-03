import {
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  type ChunkEnvelope,
  ChunkReassembler,
  type ClientFrame,
  type Command,
  chunkMessage,
  clientFrame,
  type DaemonFrame,
  dtlsFingerprintTranscript,
  extractDtlsFingerprint,
  isChunkEnvelope,
  isProtocolCompatible,
  PROTOCOL_VERSION,
} from "@thinkite/protocol";
// node-datachannel (libdatachannel NAPI) through its W3C polyfill layer.
// Loaded lazily: the native .node binding only exists where install
// scripts ran (node/pnpm trees, deno auto-mode trees) — never in deno
// none-mode's global cache. Deferring the import to first client contact
// means a daemon that never sees a peer come online never touches the
// binding, and a missing/broken binding downgrades to a per-connection
// refusal instead of a boot crash.
import type {
  RTCDataChannel,
  RTCPeerConnection,
} from "node-datachannel/polyfill";
import PartySocket from "partysocket";
import type { CommandContext, CommandHandler } from "./command.ts";
import type { Identity } from "./identity.ts";
import { publicKeyFromB64 } from "./identity.ts";
import type { KnownClients } from "./known-clients.ts";

/**
 * WebRTC-DataChannel transport with **DTLS-fingerprint-pinned identity**.
 *
 * Identity binding lives at the DTLS layer instead of in an application-
 * layer handshake:
 *
 *   1. Daemon creates offer; SDP contains an ephemeral DTLS cert
 *      fingerprint.
 *   2. Daemon signs that fingerprint under a domain tag with its long-
 *      lived Ed25519 key and forwards { sdp, fpSig } via signaling.
 *   3. Client (knowing daemon's pubkey from the QR) verifies fpSig
 *      against the fingerprint in the received SDP. A malicious signaling
 *      worker swapping the fingerprint is caught here, BEFORE DTLS even
 *      starts.
 *   4. Client mirrors the same fp-sign step in its answer.
 *   5. Daemon verifies the answer signature against the client's known
 *      pubkey (looked up in `known_clients.json` via the pubkey the
 *      client self-declared on the signaling side).
 *   6. DTLS handshake completes — the session is now bound to identities
 *      verified out-of-band (QR for daemon → client, pair flow for
 *      client → daemon).
 *   7. DataChannel opens. Frames received from this point are implicitly
 *      from the authenticated peer.
 *   8. Wire-version handshake: client sends `hello`, daemon validates
 *      protocol-version overlap and responds with `server_info`, then
 *      application commands are dispatched to `commandHandler`.
 *
 * Pair-window admission (admitting a new client pubkey to known_clients)
 * is gated by `isPairing` — when true, unknown pubkeys are admitted; when
 * false, they're silently rejected. The menubar UI controls this gate
 * via its `createPairOffer` cadence; tests pre-pair via `knownClients.add()`.
 */

const DEFAULT_SIGNALING_HOST = "signaling.thinkite.dev";
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

/**
 * True when an ICE candidate string's connection address is private /
 * link-local / loopback — the ranges Cloudflare TURN refuses to mint
 * permissions for (and that a relay can never reach anyway). Parses the
 * 5th SDP token (`candidate:<f> <comp> <proto> <prio> <ADDR> <port> ...`).
 * mDNS `.local` names count as private: the relay can't route to them.
 */
/** True when the candidate's connection address is IPv6. Cloudflare TURN
 *  issues IPv4 relay addresses only (documented), so an IPv6 peer target
 *  can never complete a relayed pair — filtering it under relay-only
 *  saves CreatePermission round-trips that are guaranteed to fail.
 *  (Historically this filter was load-bearing: werift's TURN layer let one
 *  refused CreatePermission poison the whole allocation. libdatachannel
 *  fails such pairs independently, so this is now hygiene — candidate for
 *  removal after a relay-only A/B on device.) */
export function isIpv6CandidateAddress(candidate: string): boolean {
  const addr = candidate.trim().split(/\s+/)[4];
  return !!addr && addr.includes(":");
}

export function isPrivateCandidateAddress(candidate: string): boolean {
  const addr = candidate.trim().split(/\s+/)[4]?.toLowerCase();
  if (!addr) return false;
  if (addr.endsWith(".local")) return true;
  // IPv6: loopback, link-local (fe80::/10), unique-local (fc00::/7)
  if (addr.includes(":")) {
    return (
      addr === "::1" ||
      addr.startsWith("fe8") ||
      addr.startsWith("fe9") ||
      addr.startsWith("fea") ||
      addr.startsWith("feb") ||
      addr.startsWith("fc") ||
      addr.startsWith("fd")
    );
  }
  // IPv4: 10/8, 127/8, 169.254/16, 172.16-31/12, 192.168/16
  const octets = addr.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

type WebrtcModule = typeof import("node-datachannel/polyfill");
let webrtcModule: Promise<WebrtcModule> | null = null;
/** Memoized dynamic import of the WebRTC stack; see the import-note above. */
function loadWebrtc(): Promise<WebrtcModule> {
  webrtcModule ??= import("node-datachannel/polyfill");
  return webrtcModule;
}

/**
 * How long the daemon reuses a minted TURN cred before re-minting. The
 * worker requests a 12h TTL from Cloudflare; we refresh at 10h so a
 * connection never gets a cred that's about to expire mid-session.
 */
const TURN_CACHE_TTL_MS = 10 * 60 * 60 * 1000;
/**
 * Negative-cache window when minting fails (TURN unconfigured / outage).
 * Without it every `peer.joined` would re-hit `/turn-credentials` and pay
 * a round-trip before falling back to STUN; 60s lets an outage self-heal
 * fast while sparing the common steady-state from per-connection minting.
 */
const TURN_NEGATIVE_TTL_MS = 60_000;

/**
 * Max time from `peer.joined` to `authenticated` (= DataChannel open).
 * Normal path completes in well under 5s on a clean network; 30s gives
 * generous headroom for TURN-relayed sessions over flaky links while
 * still capping how long a stuck slot ties up memory.
 */
const SETUP_TIMEOUT_MS = 30_000;

export interface WebRTCPeerServerOptions {
  /** Daemon's long-lived Ed25519 identity. Signs DTLS fingerprints +
   *  proves daemon-ownership of the room to the signaling worker. */
  identity: Identity;
  /** Source of truth for "which iOS pubkeys is this daemon paired with."
   *  Looked up on every `peer.joined`. */
  knownClients: KnownClients;
  /** Invoked for each application command after the per-peer wire-version
   *  handshake (hello / server_info) completes. The DataChannel is
   *  DTLS-bound to a known pubkey by the time we get here, AND the peer
   *  has proven it speaks a compatible wire-protocol version. */
  commandHandler?: CommandHandler;
  /**
   * Runtime gate for admitting new iOS pubkeys via the pair-window UI.
   * When `true`, an unknown clientPubkey is added to known_clients on
   * connect. When `false`, unknown pubkeys are rejected silently. The
   * menubar flips this when the QR window opens/closes; tests default
   * to `false` since they pre-pair via `knownClients.add()`.
   */
  isPairing?: () => boolean;
  /** Override for tests (e.g. local `wrangler dev`). */
  signalingHost?: string;
  signalingScheme?: "ws" | "wss";
  iceServers?: RTCIceServer[];
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Per-peer slot. No application-layer auth state machine — the
 * "authenticated" boolean flips true once DataChannel opens (which only
 * succeeds after DTLS verifies the signed fingerprint).
 */
interface PeerSlot {
  /** Signaling-assigned connection id (server-stamped, opaque). */
  clientId: string;
  /** Pubkey from `peer.joined` (matched against known_clients before we
   *  accept the slot). After this point we treat the pubkey as
   *  authoritative — it's bound to the DTLS session via fpSig. */
  clientPubkey: string;
  /** Short hex fingerprint for log + CommandContext compatibility. */
  fingerprint: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  /** True once DTLS+DataChannel is up (= peer has been cryptographically
   *  bound to clientPubkey). */
  authenticated: boolean;
  /** True once the client's `hello` has arrived AND its protocolVersion
   *  is wire-compatible with ours. Application commands sent before
   *  this flips are rejected with `incompatible_protocol`. */
  versionVerified: boolean;
  /** Cleared the moment `authenticated` flips true. Reaps slots whose
   *  PC is stuck pre-auth (e.g. client died before sending answer, so
   *  ICE never starts and `connectionstatechange` never fires). */
  setupTimeoutId: ReturnType<typeof setTimeout> | null;
  /** Per-peer buffer for inbound chunk envelopes. Each PeerSlot has
   *  its own — chunk ids are scoped to the sender, and a stale buffer
   *  from a dropped peer mustn't bleed into a fresh one. */
  reassembler: ChunkReassembler;
  disconnectCallbacks: Array<() => void>;
  scratch: Map<string, unknown>;
}

export class WebRTCPeerServer {
  private signaling: PartySocket | null = null;
  private readonly peers = new Map<string, PeerSlot>();
  private readonly log: NonNullable<WebRTCPeerServerOptions["log"]>;
  private readonly identity: Identity;
  private readonly knownClients: KnownClients;
  private readonly commandHandler?: CommandHandler;
  private readonly isPairing: () => boolean;
  private readonly signalingHost: string;
  private readonly signalingScheme: "ws" | "wss";
  /** STUN-only fallback list used when TURN minting is unavailable. */
  private readonly iceServers: RTCIceServer[];
  /**
   * SIDECODE_ICE_POLICY=relay — TURN-only test mode. iceTransportPolicy
   * "relay" is also passed to libdatachannel, but the hard guarantee
   * deliberately lives here at the app layer (defense-in-depth after
   * werift's forceTurn proved leaky): non-relay LOCAL candidates are never
   * signaled to the client, and non-relay REMOTE candidates are never fed
   * to the pc. No material, no pair.
   */
  private readonly relayOnly = process.env.SIDECODE_ICE_POLICY === "relay";
  /** Cached minted TURN ICE-server list (+ expiry). Null until first
   *  fetch; on mint failure holds the STUN fallback with a short TTL. */
  private turnCache: { iceServers: RTCIceServer[]; expiresAt: number } | null =
    null;
  /** Single-flight guard so concurrent `peer.joined` events share one
   *  mint round-trip instead of each firing their own. */
  private turnInFlight: Promise<RTCIceServer[]> | null = null;

  constructor(options: WebRTCPeerServerOptions) {
    this.identity = options.identity;
    this.knownClients = options.knownClients;
    this.commandHandler = options.commandHandler;
    this.isPairing = options.isPairing ?? (() => false);
    this.signalingHost = options.signalingHost ?? DEFAULT_SIGNALING_HOST;
    this.signalingScheme = options.signalingScheme ?? "wss";
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.signaling) throw new Error("WebRTCPeerServer already started");

    this.signaling = new PartySocket({
      host: this.signalingHost,
      protocol: this.signalingScheme,
      party: "signaling",
      room: this.identity.publicKeyB64,
      // Per-reconnect sig refresh keeps ts/sig inside the worker's ±60s
      // skew window even after long backoff cycles.
      query: async () => {
        const ts = Date.now();
        const sig = cryptoSign(
          null,
          Buffer.from(`signaling/v1/${this.identity.publicKeyB64}/${ts}`),
          this.identity.privateKey,
        ).toString("base64url");
        return { role: "daemon", ts: String(ts), sig };
      },
      maxRetries: Infinity,
    });

    this.signaling.addEventListener("message", (e: MessageEvent) => {
      const text =
        typeof e.data === "string"
          ? e.data
          : new TextDecoder().decode(e.data as ArrayBuffer);
      void this.onSignalingMessage(JSON.parse(text));
    });
    this.signaling.addEventListener("open", () => this.log("signaling.open"));
    this.signaling.addEventListener("close", (e: CloseEvent) => {
      this.log("signaling.close", { code: e.code, reason: e.reason });
    });
    this.signaling.addEventListener("error", (e: Event) => {
      this.log("signaling.error", {
        error: (e as ErrorEvent)?.message ?? "unknown",
      });
    });

    // Warm the TURN cache so the first `peer.joined` doesn't eat a mint
    // round-trip in its setup budget. Fire-and-forget — getIceServers never
    // throws (degrades to STUN), and a failure here just means the first
    // connection re-attempts the mint.
    void this.getIceServers();

    // Fire-and-forget. Daemon shouldn't refuse to start just because
    // signaling.thinkite.dev is momentarily unreachable — PartySocket's
    // infinite retry will eventually connect when the network heals, and
    // until then pair attempts time out client-side. The previous
    // synchronous await-for-peers was a debugging-era affordance; in
    // production a daemon that boots cleanly and surfaces "signaling.open"
    // in its log is the right model.
  }

  async stop(): Promise<void> {
    if (!this.signaling) return;
    for (const peer of [...this.peers.values()]) {
      this.closePeer(peer, "shutdown");
    }
    this.peers.clear();
    try {
      this.signaling.close();
    } catch {
      // ignore
    }
    this.signaling = null;
  }

  /** Number of peers with an open DTLS-verified DataChannel. */
  authenticatedCount(): number {
    let n = 0;
    for (const p of this.peers.values()) if (p.authenticated) n += 1;
    return n;
  }

  // ─── Signaling-frame router ──────────────────────────────────────

  private async onSignalingMessage(msg: unknown): Promise<void> {
    if (!isRecord(msg) || typeof msg.type !== "string") return;

    if (msg.type === "peers") {
      this.log("signaling.peers", {
        count: Array.isArray(msg.peers) ? msg.peers.length : 0,
      });
      return;
    }
    if (msg.type === "peer.joined" && isRecord(msg.peer)) {
      await this.onPeerJoined({
        id: String(msg.peer.id ?? ""),
        pubkey: String(msg.peer.pubkey ?? ""),
        role: String(msg.peer.role ?? ""),
      });
      return;
    }
    // Intentionally no handler for `peer.left`. Signaling is a setup-
    // time channel; once the DataChannel is up it has nothing left to
    // say about transport health. iOS routinely closes its signaling
    // socket right after `server_info` to free the worker connection,
    // which would surface here as `peer.left` — acting on it would
    // tear down a perfectly healthy DC. PC health is driven by
    // `connectionstatechange` (failed/closed/disconnected). For the
    // edge case where a client bails BEFORE we get an answer (PC
    // stuck in `have-local-offer`, ICE never starts checking, so
    // `connectionstatechange` never fires), the per-slot setup
    // timeout below reaps the slot.
    if (msg.type === "answer" && typeof msg.from === "string") {
      await this.onAnswer(msg.from, msg);
      return;
    }
    if (msg.type === "candidate" && typeof msg.from === "string") {
      const peer = this.peers.get(msg.from);
      if (!peer) return;
      // Remote candidates are NOT type-filtered in relay-only mode — W3C
      // iceTransportPolicy semantics restrict LOCAL candidates only, and a
      // daemon-relay ↔ client-srflx pair is a legitimate relayed path.
      //
      // But PRIVATE-address remotes are dropped under relay-only: they can
      // never pair with a relay candidate (Cloudflare can't reach them, and
      // CF TURN denies CreatePermission/ChannelBind for private ranges), so
      // feeding them in only buys guaranteed-to-fail permission traffic.
      // (Was load-bearing under werift, whose TURN layer let one refused
      // permission poison the allocation; libdatachannel fails pairs
      // independently — hygiene now, A/B-removable.)
      const candStr =
        (msg.candidate as { candidate?: string })?.candidate ?? "";
      const remoteTyp = / typ (\w+)/.exec(candStr)?.[1];
      if (
        this.relayOnly &&
        (isPrivateCandidateAddress(candStr) || isIpv6CandidateAddress(candStr))
      ) {
        this.log("peer.candidate.remote_private_dropped", {
          clientId: peer.clientId,
          typ: remoteTyp,
          v6: isIpv6CandidateAddress(candStr) || undefined,
        });
        return;
      }
      this.log("peer.candidate.remote", {
        clientId: peer.clientId,
        typ: remoteTyp,
      });
      try {
        // Candidate init dict straight through — W3C addIceCandidate takes
        // RTCIceCandidateInit directly, no wrapper class needed.
        await peer.pc.addIceCandidate(msg.candidate as RTCIceCandidateInit);
      } catch (err) {
        this.log("peer.candidate.error", {
          clientId: peer.clientId,
          error: (err as Error).message,
        });
      }
      return;
    }
  }

  // ─── Peer lifecycle ──────────────────────────────────────────────

  private async onPeerJoined(peer: {
    id: string;
    pubkey: string;
    role: string;
  }): Promise<void> {
    if (peer.role !== "client" || !peer.id || !peer.pubkey) return;
    if (this.peers.has(peer.id)) return; // duplicate event

    // Pubkey gate: must be in known_clients, OR we're in pair-window
    // mode (in which case admit them and persist). New pubkeys arriving
    // while the menubar Pair window is closed are silently rejected —
    // signaling DO routes the connection to us but we never respond
    // with an offer, so the client's reconnect loop will time out.
    let knownClient = this.knownClientByPubkey(peer.pubkey);
    if (!knownClient) {
      if (!this.isPairing()) {
        this.log("peer.rejected_unknown", {
          clientId: peer.id,
          pubkey: peer.pubkey.slice(0, 12),
        });
        return;
      }
      const fingerprint = fingerprintFromPubkey(peer.pubkey);
      knownClient = {
        fingerprint,
        publicKeyB64: peer.pubkey,
        pairedAt: Date.now(),
      };
      this.knownClients.add(knownClient);
      this.log("peer.paired", { clientId: peer.id, fingerprint });
    }

    // First client contact is what pulls in the WebRTC stack (see the
    // lazy-import note at the top). A missing native binding (e.g. deno
    // none-mode dev, where install scripts never ran) refuses this
    // connection and leaves the daemon itself healthy.
    let rtc: WebrtcModule;
    try {
      rtc = await loadWebrtc();
    } catch (err) {
      this.log("peer.webrtc_unavailable", {
        clientId: peer.id,
        error: (err as Error).message,
      });
      return;
    }

    // Mint/reuse TURN creds for THIS connection and reuse the exact same
    // list for the client (relayed in the offer below) so both ends agree
    // on relays. Falls back to STUN-only if minting is unavailable. Both
    // ends get the ORIGINAL Cloudflare shape (urls lists incl. turns:/tcp
    // variants) — libdatachannel parses the full set, no normalization.
    // TURN-only test mode: pass the policy to libdatachannel AND keep the
    // bidirectional candidate filter (see `relayOnly`) as the app-layer
    // hard guarantee + regression-tool backstop.
    const iceTransportPolicy = this.relayOnly ? "relay" : "all";
    if (this.relayOnly) {
      this.log("peer.ice_policy_relay_only", { clientId: peer.id });
    }
    let iceServers = await this.getIceServers();
    let pc: RTCPeerConnection;
    try {
      pc = new rtc.RTCPeerConnection({ iceServers, iceTransportPolicy });
    } catch (err) {
      // A malformed ICE config must NEVER crash the peer loop
      // (node-datachannel throws synchronously on a bad entry). Drop the
      // suspect cache, fall back to STUN-only, and relay that same
      // fallback so both ends stay consistent.
      this.log("peer.ice_config_invalid", {
        error: (err as Error).message,
        count: iceServers.length,
      });
      this.turnCache = null;
      iceServers = this.iceServers;
      pc = new rtc.RTCPeerConnection({ iceServers, iceTransportPolicy });
    }
    const slot: PeerSlot = {
      clientId: peer.id,
      clientPubkey: peer.pubkey,
      fingerprint: knownClient.fingerprint,
      pc,
      dc: null,
      authenticated: false,
      versionVerified: false,
      setupTimeoutId: null,
      reassembler: new ChunkReassembler(),
      disconnectCallbacks: [],
      scratch: new Map(),
    };
    this.peers.set(peer.id, slot);
    slot.setupTimeoutId = setTimeout(() => {
      if (slot.authenticated) return;
      this.closePeer(slot, "setup timeout");
    }, SETUP_TIMEOUT_MS);

    pc.addEventListener("icecandidate", (event) => {
      const candidate = (
        event as unknown as { candidate?: RTCIceCandidate | null }
      ).candidate;
      if (candidate && this.signaling) {
        const cand =
          typeof candidate.toJSON === "function"
            ? candidate.toJSON()
            : candidate;
        // Log the candidate type (host/srflx/relay) — the observable for
        // the TURN gate: under SIDECODE_ICE_POLICY=relay every local
        // candidate must be `relay`, and any successful connection proves
        // the relay leg end to end.
        const typ = / typ (\w+)/.exec(
          (cand as { candidate?: string }).candidate ?? "",
        )?.[1];
        if (this.relayOnly && typ !== "relay") {
          this.log("peer.candidate.local_dropped", {
            clientId: peer.id,
            typ,
          });
          return;
        }
        this.log("peer.candidate.local", { clientId: peer.id, typ });
        this.signaling.send(
          JSON.stringify({ to: peer.id, type: "candidate", candidate: cand }),
        );
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      const state = pc.connectionState;
      this.log("peer.connectionstate", { clientId: peer.id, state });
      if (
        state === "failed" ||
        state === "closed" ||
        state === "disconnected"
      ) {
        this.closePeer(slot, `connectionState=${state}`);
      }
    });

    // Daemon side is the offerer — we create the DataChannel.
    const dc = pc.createDataChannel("sidecode/v1", { ordered: true });
    slot.dc = dc;
    dc.addEventListener("open", () => this.onDataChannelOpen(slot));
    dc.addEventListener("message", (event) => {
      const data = (event as unknown as { data: unknown }).data;
      this.onDataChannelMessage(slot, data);
    });
    dc.addEventListener("close", () => {
      this.closePeer(slot, "datachannel closed");
    });

    // Create offer, sign the DTLS fingerprint, forward via signaling.
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = offer.sdp ?? pc.localDescription?.sdp ?? "";
      const fp = extractDtlsFingerprint(sdp);
      const fpSig = cryptoSign(
        null,
        Buffer.from(dtlsFingerprintTranscript(fp)),
        this.identity.privateKey,
      ).toString("base64url");
      // Relay the SAME ICE-server list (incl. minted TURN creds) the daemon
      // used — the client is not a verified party so it never mints its own;
      // it just uses what the signed daemon hands it. fpSig still pins the
      // DTLS identity, so a tampering signaling worker can't swap in a
      // malicious relay without breaking the fingerprint signature.
      this.signaling?.send(
        JSON.stringify({ to: peer.id, type: "offer", sdp, fpSig, iceServers }),
      );
    } catch (err) {
      this.log("peer.offer.error", {
        clientId: peer.id,
        error: (err as Error).message,
      });
      this.closePeer(slot, "offer failed");
    }
  }

  private async onAnswer(
    fromId: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const peer = this.peers.get(fromId);
    if (!peer) return;

    const sdp = typeof msg.sdp === "string" ? msg.sdp : "";
    const fpSigB64 = typeof msg.fpSig === "string" ? msg.fpSig : "";
    if (!sdp || !fpSigB64) {
      this.log("peer.answer.missing_sig", { clientId: peer.clientId });
      this.closePeer(peer, "answer missing fpSig");
      return;
    }

    // Verify the client's signature over the DTLS fingerprint they're
    // committing to. This is the core of the "no MITM via signaling"
    // guarantee — if the signaling worker swapped the answer's
    // fingerprint, the signature here won't match.
    let fp: string;
    try {
      fp = extractDtlsFingerprint(sdp);
    } catch (err) {
      this.log("peer.answer.bad_sdp", {
        clientId: peer.clientId,
        error: (err as Error).message,
      });
      this.closePeer(peer, "answer SDP missing fingerprint");
      return;
    }
    const sigBytes = Buffer.from(fpSigB64, "base64url");
    const ok = cryptoVerify(
      null,
      Buffer.from(dtlsFingerprintTranscript(fp)),
      publicKeyFromB64(peer.clientPubkey),
      sigBytes,
    );
    if (!ok) {
      this.log("peer.answer.bad_sig", { clientId: peer.clientId });
      this.closePeer(peer, "answer fpSig invalid");
      return;
    }

    try {
      // Plain description dict — W3C setRemoteDescription takes an
      // RTCSessionDescriptionInit, no wrapper class needed.
      await peer.pc.setRemoteDescription({ type: "answer", sdp });
    } catch (err) {
      this.log("peer.answer.set_remote_error", {
        clientId: peer.clientId,
        error: (err as Error).message,
      });
      this.closePeer(peer, "setRemoteDescription failed");
    }
  }

  // ─── DataChannel: open + frame dispatch ─────────────────────────

  private onDataChannelOpen(slot: PeerSlot): void {
    // DTLS handshake completed AND we already verified the answer's
    // fpSig against clientPubkey — the channel is now bound to a peer
    // whose identity was pinned by Ed25519. No further handshake.
    slot.authenticated = true;
    if (slot.setupTimeoutId) {
      clearTimeout(slot.setupTimeoutId);
      slot.setupTimeoutId = null;
    }
    this.log("peer.authenticated", {
      clientId: slot.clientId,
      fingerprint: slot.fingerprint,
    });
  }

  private onDataChannelMessage(slot: PeerSlot, data: unknown): void {
    if (!slot.authenticated) return;

    let frame: ClientFrame;
    try {
      const text =
        typeof data === "string"
          ? data
          : new TextDecoder().decode(data as ArrayBuffer);
      let parsed: unknown = JSON.parse(text);
      // Chunked-message reassembly. Chunk envelopes are the transport
      // wrapper around oversized JSON payloads (sender side splits in
      // `send()` below). Intermediate chunks return `null`; only when
      // the last slice arrives do we have a full JSON string to feed
      // into the schema parser.
      if (isChunkEnvelope(parsed)) {
        const assembled = slot.reassembler.push(parsed as ChunkEnvelope);
        if (assembled === null) return;
        parsed = JSON.parse(assembled);
      }
      frame = clientFrame.parse(parsed);
    } catch (err) {
      this.log("peer.bad_frame", {
        clientId: slot.clientId,
        error: (err as Error).message,
      });
      // We don't kill the channel on bad frame — the protocol doesn't
      // require it, and a malformed message from an authenticated peer
      // is more likely a bug than an attack. Reconsider if abuse
      // patterns appear.
      return;
    }

    // ─── Wire-version handshake gate ─────────────────────────────────
    // `hello` from iOS is the only frame valid before versionVerified
    // flips. The protocol package's `isProtocolCompatible` owns the rule
    // (same minor for 0.x, same major for ≥1.x). Mismatch → send
    // `incompatible_protocol` error + close the peer.
    if (frame.type === "hello") {
      if (slot.versionVerified) {
        // Re-hello shouldn't happen; ignore silently to keep state
        // machine simple.
        return;
      }
      if (!isProtocolCompatible(frame.protocolVersion)) {
        this.log("peer.version_mismatch", {
          clientId: slot.clientId,
          clientProtocolVersion: frame.protocolVersion,
          daemonProtocolVersion: PROTOCOL_VERSION,
        });
        this.send(slot, {
          type: "error",
          code: "incompatible_protocol",
          message: `client protocol ${frame.protocolVersion} is not compatible with daemon ${PROTOCOL_VERSION}`,
          // Structured copy of our version so iOS can tell WHICH side is
          // outdated (`outdatedSide`) and name it in the error copy.
          protocolVersion: PROTOCOL_VERSION,
        });
        this.closePeer(slot, "incompatible wire protocol");
        return;
      }
      slot.versionVerified = true;
      this.send(slot, {
        type: "server_info",
        protocolVersion: PROTOCOL_VERSION,
      });
      this.log("peer.version_ok", {
        clientId: slot.clientId,
        protocolVersion: frame.protocolVersion,
      });
      return;
    }

    if (!slot.versionVerified) {
      // Any non-hello frame before the handshake completes is a protocol
      // error. We reply with `incompatible_protocol` and close — a well-
      // behaved client would never get here, so this is mostly diagnostic
      // for a buggy/malicious peer.
      this.log("peer.pre_hello_frame", {
        clientId: slot.clientId,
        frameType: frame.type,
      });
      this.send(slot, {
        type: "error",
        code: "incompatible_protocol",
        message: "hello required before any other frame",
      });
      this.closePeer(slot, "frame before hello");
      return;
    }

    if (frame.type === "ping") {
      this.send(slot, { type: "pong", t: Date.now(), echoT: frame.t });
      return;
    }

    const handler = this.commandHandler;
    if (!handler) {
      this.log("peer.unhandled", {
        clientId: slot.clientId,
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
        this.log("peer.handler_error", {
          clientId: slot.clientId,
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

  // ─── Send / close ───────────────────────────────────────────────

  private send(slot: PeerSlot, frame: DaemonFrame): void {
    if (!slot.dc || slot.dc.readyState !== "open") return;
    try {
      // `chunkMessage` yields the original JSON unchanged when it
      // fits the wire limit; only oversized frames get split into
      // envelopes (see chunking.ts). Sending each piece sequentially
      // is safe — DataChannel is `ordered: true` so the receiver
      // sees them in order without us tracking indices.
      const json = JSON.stringify(frame);
      for (const piece of chunkMessage(json)) {
        slot.dc.send(piece);
      }
    } catch (err) {
      this.log("peer.send.error", {
        clientId: slot.clientId,
        error: (err as Error).message,
      });
    }
  }

  private closePeer(slot: PeerSlot, reason: string): void {
    if (!this.peers.has(slot.clientId)) return;
    if (slot.setupTimeoutId) {
      clearTimeout(slot.setupTimeoutId);
      slot.setupTimeoutId = null;
    }
    for (const cb of slot.disconnectCallbacks) {
      try {
        cb();
      } catch (err) {
        this.log("peer.cleanup_error", {
          clientId: slot.clientId,
          error: (err as Error).message,
        });
      }
    }
    try {
      slot.dc?.close();
    } catch {
      // ignore
    }
    try {
      slot.pc.close();
    } catch {
      // ignore
    }
    this.peers.delete(slot.clientId);
    this.log("peer.closed", { clientId: slot.clientId, reason });
  }

  // ─── TURN credentials ───────────────────────────────────────────

  /**
   * Effective ICE-server list for a new peer connection: minted TURN
   * (STUN + relay) when available, else the STUN-only fallback. Cached +
   * single-flighted so a burst of `peer.joined` events shares one mint.
   * Never throws — a TURN outage degrades to STUN, it doesn't break
   * connections (they just won't traverse symmetric NAT).
   */
  private getIceServers(): Promise<RTCIceServer[]> {
    const now = Date.now();
    if (this.turnCache && this.turnCache.expiresAt > now) {
      return Promise.resolve(this.turnCache.iceServers);
    }
    if (this.turnInFlight) return this.turnInFlight;

    const p = this.fetchTurnCredentials().then((turn) => {
      if (turn) {
        this.turnCache = {
          iceServers: turn,
          expiresAt: Date.now() + TURN_CACHE_TTL_MS,
        };
        return turn;
      }
      // Negative-cache the STUN fallback briefly so an outage / unconfigured
      // TURN doesn't re-mint on every connection.
      this.turnCache = {
        iceServers: this.iceServers,
        expiresAt: Date.now() + TURN_NEGATIVE_TTL_MS,
      };
      return this.iceServers;
    });
    this.turnInFlight = p;
    void p.finally(() => {
      if (this.turnInFlight === p) this.turnInFlight = null;
    });
    return p;
  }

  /**
   * Mint TURN credentials from the signaling worker's `/turn-credentials`
   * endpoint. The daemon is the SOLE minter (clients get creds relayed in
   * the offer), so we prove pubkey ownership with an Ed25519 signature over
   * a `turn/v1/...` domain-tagged message — distinct from the signaling-
   * connect signature so neither is replayable as the other. Returns the
   * one-element ICE-server list on success, or null on any failure.
   */
  private async fetchTurnCredentials(): Promise<RTCIceServer[] | null> {
    const scheme = this.signalingScheme === "wss" ? "https" : "http";
    const url = `${scheme}://${this.signalingHost}/turn-credentials`;
    const ts = Date.now();
    const sig = cryptoSign(
      null,
      Buffer.from(`turn/v1/${this.identity.publicKeyB64}/${ts}`),
      this.identity.privateKey,
    ).toString("base64url");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pubkey: this.identity.publicKeyB64,
          ts,
          sig,
        }),
      });
      if (!res.ok) {
        this.log("turn.mint_unavailable", { status: res.status });
        return null;
      }
      // Cloudflare returns `iceServers` as an ARRAY of RTCIceServer objects
      // (a STUN entry + a TURN entry, each with a `urls` list) — NOT a single
      // object. Pass it through as-is, but keep only well-formed entries so a
      // shape change can never feed the peer stack an entry without `urls`
      // (which throws "IceServer config should be a string Or an object").
      const data = (await res.json()) as { iceServers?: RTCIceServer[] };
      const servers = Array.isArray(data.iceServers) ? data.iceServers : [];
      const valid = servers.filter(
        (s): s is RTCIceServer =>
          !!s &&
          (typeof s.urls === "string"
            ? s.urls.length > 0
            : Array.isArray(s.urls) && s.urls.length > 0),
      );
      if (valid.length === 0) {
        this.log("turn.mint_empty");
        return null;
      }
      this.log("turn.minted", { servers: valid.length });
      return valid;
    } catch (err) {
      this.log("turn.fetch_error", { error: (err as Error).message });
      return null;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private knownClientByPubkey(pubkey: string) {
    for (const c of this.knownClients.list()) {
      if (c.publicKeyB64 === pubkey) return c;
    }
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function fingerprintFromPubkey(publicKeyB64: string): string {
  // Same derivation as identity.ts: sha256(raw pubkey bytes), first 16 hex.
  return createHash("sha256")
    .update(Buffer.from(publicKeyB64, "base64url"))
    .digest("hex")
    .slice(0, 16);
}
