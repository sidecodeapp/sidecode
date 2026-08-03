/**
 * iOS-side signaling client.
 *
 * Opens a WebSocket to the sidecode signaling worker as `role=client`
 * (no signature required — daemon-side validates via known_clients on
 * peer.joined). Surfaces incoming frames as typed callbacks and lets
 * the owner send `to`-addressed frames to the daemon.
 *
 * Why not `partysocket`: RN 0.85 + Hermes lacks global `MessageEvent` /
 * `CloseEvent`. partysocket's `cloneEventNode` path (forced by their RN
 * detection in PR #294) constructs those at runtime → crashes. Per
 * partykit issue #516 the maintainer's own RN fallback is "use native
 * WebSocket". Daemon side keeps `partysocket` (Node 24 has full DOM
 * globals).
 *
 * Reconnect: exponential backoff with ±25% jitter, capped at 30s. Runs
 * forever until close() is called. Identical strategy to the
 * `connectionRetryPolicy` we sketched earlier for the LAN-only design,
 * just simpler — there's only one URL to dial.
 */

/** Peer descriptor as the signaling worker stamps it. */
export interface SignalingPeer {
  /** Server-assigned connection id; opaque, used as routing target. */
  id: string;
  /** Pubkey the peer self-declared (TRUSTED only after DTLS fp pinning). */
  pubkey: string;
  role: "daemon" | "client";
}

/** Incoming-frame callbacks. All optional — owner subscribes only to
 *  what it cares about. */
export interface SignalingClientCallbacks {
  /** Initial roster on connect AND after server-side reconnect. */
  onPeers?: (peers: SignalingPeer[]) => void;
  /** A peer (typically daemon) just connected. */
  onPeerJoined?: (peer: SignalingPeer) => void;
  /** A peer disconnected. */
  onPeerLeft?: (peer: SignalingPeer) => void;
  /** Daemon → client SDP offer. `fpSig` is the daemon's Ed25519 signature
   *  over the SDP's DTLS fingerprint; the owner MUST verify it against
   *  the QR-known daemon pubkey before calling setRemoteDescription.
   *  `iceServers` carries the daemon-minted TURN creds (the daemon is the
   *  sole minter); the owner builds its peer connection with them. Absent
   *  when the daemon couldn't mint — owner falls back to its STUN default. */
  onOffer?: (
    from: string,
    sdp: string,
    fpSig: string,
    iceServers?: RTCIceServer[],
  ) => void;
  /** Trickle-ICE candidate from a peer. */
  onCandidate?: (from: string, candidate: unknown) => void;
  /** Worker-side error (`peer_not_found`, `missing_to`, etc.). */
  onProtocolError?: (reason: string, raw: unknown) => void;
  /** Lifecycle signal — owner can show connecting / online / offline UI. */
  onState?: (state: SignalingState) => void;
}

export type SignalingState =
  | { kind: "connecting"; attempt: number }
  | { kind: "open" }
  | { kind: "closed"; code?: number; reason?: string }
  | { kind: "reconnecting"; attempt: number; nextDelayMs: number };

export interface SignalingClientOptions extends SignalingClientCallbacks {
  /** Daemon's Ed25519 pubkey (base64url). Becomes the room name. */
  daemonPubkey: string;
  /** Our own pubkey (base64url). Daemon uses it to look up known_clients. */
  clientPubkey: string;
  /** Override for tests (e.g. local wrangler dev). */
  signalingHost?: string;
  /** Override for tests (`ws` against localhost). */
  signalingScheme?: "ws" | "wss";
}

const DEFAULT_HOST = "signaling.thinkite.dev";
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_FRACTION = 0.25;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: SignalingClientOptions;

  constructor(opts: SignalingClientOptions) {
    this.opts = opts;
  }

  /** Open the connection. Safe to call multiple times — no-op if already
   *  open or actively reconnecting. */
  connect(): void {
    if (this.closed) {
      // Owner explicitly closed previously; need a fresh instance.
      throw new Error("SignalingClient: connect() after close()");
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer) return;
    this.openSocket();
  }

  /** Send an addressed frame to a specific peer (typically the daemon).
   *  Drops silently if the WS isn't open — peer.joined arrival ordering
   *  guarantees the daemon will have us in their roster before the next
   *  reconnect cycle attempts this frame. */
  send(to: string, type: string, payload: Record<string, unknown> = {}): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ to, type, ...payload }));
  }

  /** Permanently close the client. Reconnection stops; the WS is closed.
   *  Subsequent connect() calls throw. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore — RN sometimes throws on close-during-connecting
      }
      this.ws = null;
    }
  }

  // ─── Internals ──────────────────────────────────────────────────

  private buildUrl(): string {
    const scheme = this.opts.signalingScheme ?? "wss";
    const host = this.opts.signalingHost ?? DEFAULT_HOST;
    const params = new URLSearchParams({
      role: "client",
      pubkey: this.opts.clientPubkey,
    });
    return `${scheme}://${host}/parties/signaling/${this.opts.daemonPubkey}?${params}`;
  }

  private openSocket(): void {
    this.opts.onState?.({ kind: "connecting", attempt: this.attempt });
    const ws = new WebSocket(this.buildUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onState?.({ kind: "open" });
    };
    ws.onmessage = (e) => {
      const raw = typeof e.data === "string" ? e.data : null;
      if (!raw) return;
      try {
        this.dispatch(JSON.parse(raw));
      } catch {
        // Malformed frame from worker — log via protocol-error
        // callback if owner cares.
        this.opts.onProtocolError?.("bad_json", raw);
      }
    };
    ws.onerror = () => {
      // RN's onerror fires before onclose. Don't surface to owner here —
      // onclose will follow with the actual disposition.
    };
    ws.onclose = (e) => {
      this.ws = null;
      if (this.closed) {
        this.opts.onState?.({ kind: "closed", code: e.code, reason: e.reason });
        return;
      }
      this.scheduleReconnect();
    };
  }

  private dispatch(msg: unknown): void {
    if (!isRecord(msg)) return;
    const type = typeof msg.type === "string" ? msg.type : "";

    switch (type) {
      case "peers": {
        if (Array.isArray(msg.peers)) {
          this.opts.onPeers?.(msg.peers.filter(isPeer));
        }
        return;
      }
      case "peer.joined": {
        if (isPeer(msg.peer)) this.opts.onPeerJoined?.(msg.peer);
        return;
      }
      case "peer.left": {
        if (isPeer(msg.peer)) this.opts.onPeerLeft?.(msg.peer);
        return;
      }
      case "offer": {
        if (
          typeof msg.from === "string" &&
          typeof msg.sdp === "string" &&
          typeof msg.fpSig === "string"
        ) {
          // Daemon-relayed TURN creds (optional). Worker forwards the offer
          // envelope verbatim, so this is whatever the daemon attached.
          const iceServers = Array.isArray(msg.iceServers)
            ? (msg.iceServers as RTCIceServer[])
            : undefined;
          this.opts.onOffer?.(msg.from, msg.sdp, msg.fpSig, iceServers);
        }
        return;
      }
      case "candidate": {
        if (typeof msg.from === "string") {
          this.opts.onCandidate?.(msg.from, msg.candidate);
        }
        return;
      }
      case "error": {
        const reason = typeof msg.reason === "string" ? msg.reason : "unknown";
        this.opts.onProtocolError?.(reason, msg);
        return;
      }
    }
  }

  private scheduleReconnect(): void {
    const base = Math.min(
      INITIAL_BACKOFF_MS * BACKOFF_MULTIPLIER ** this.attempt,
      MAX_BACKOFF_MS,
    );
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER_FRACTION;
    const delay = Math.floor(base * jitter);

    this.attempt += 1;
    this.opts.onState?.({
      kind: "reconnecting",
      attempt: this.attempt,
      nextDelayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.openSocket();
    }, delay);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPeer(v: unknown): v is SignalingPeer {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.pubkey === "string" &&
    (v.role === "daemon" || v.role === "client")
  );
}
