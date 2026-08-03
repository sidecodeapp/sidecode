import {
  dtlsFingerprintTranscript,
  extractDtlsFingerprint,
} from "@thinkite/protocol";
import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from "react-native-webrtc";

/**
 * iOS-side WebRTC peer.
 *
 * Mirrors the daemon's `WebRTCPeerServer` but for a single peer (= the
 * daemon). The iOS side is the answerer in the SDP exchange — the
 * daemon initiates with an offer once it sees our peer.joined event.
 *
 * Identity binding (matching daemon side):
 *   - Daemon's offer arrives with `fpSig` = daemon's Ed25519 signature
 *     over its SDP DTLS fingerprint.
 *   - We verify it against the daemon pubkey we learned from QR.
 *   - We sign OUR answer's DTLS fingerprint with our own Ed25519 key.
 *   - DTLS handshake follows; channel is authenticated when DC opens.
 *
 * Crypto is injected (`signFingerprint` / `verifyFingerprint`) so the
 * peer itself stays transport-only — easier to unit-test, swap to a
 * hardware-backed signer later, etc.
 */

export type WebRTCPeerState =
  | "idle"
  | "received-offer"
  | "verifying"
  | "answered"
  | "ice-checking"
  | "connected"
  | "failed"
  | "closed";

export interface WebRTCPeerOptions {
  iceServers?: RTCIceServer[];

  /** Sign our DTLS fingerprint with the client's Ed25519 private key.
   *  Owner provides this so WebRTCPeer doesn't need to know about
   *  keypair storage. Returns base64url-encoded signature. */
  signFingerprint: (fingerprintTranscript: Uint8Array) => Promise<string>;

  /** Verify daemon's signature over its DTLS fingerprint. Returns true
   *  if the signature checks out against the QR-known daemon pubkey. */
  verifyFingerprint: (
    fingerprintTranscript: Uint8Array,
    signatureB64Url: string,
  ) => Promise<boolean>;

  /** Fires for each locally-gathered ICE candidate. Owner forwards it
   *  to the daemon via the signaling channel. */
  onLocalCandidate: (candidate: RTCIceCandidateInit) => void;

  /** DataChannel ready for application traffic. */
  onDataChannelOpen?: (dc: RTCDataChannel) => void;
  /** DataChannel closed or PC failed. */
  onDataChannelClose?: () => void;

  /** Lifecycle telemetry. */
  onState?: (state: WebRTCPeerState) => void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

// react-native-webrtc's event-target-shim base + the global DOM RTCPeerConnection
// type confuse TS resolution — `addEventListener` calls fail typecheck even
// though they work at runtime. We cast the EventTarget surface explicitly so
// strongly-typed callers stay readable and we don't sprinkle `as any` around.
type EventfulPC = {
  addEventListener: (event: string, handler: (e: unknown) => void) => void;
};
type EventfulDC = EventfulPC & {
  readyState: string;
  send: (data: string) => void;
  close: () => void;
};

export class WebRTCPeer {
  private readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private state: WebRTCPeerState = "idle";
  private closed = false;
  /** Trickled candidates that arrived before setRemoteDescription finished.
   *  handleOffer's async prefix (fpSig verify) loses the race against the
   *  daemon's candidate frames; addIceCandidate before the remote
   *  description throws — and under relay-only the daemon sends exactly ONE
   *  candidate, so silently losing it kills the connection outright. */
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private readonly opts: WebRTCPeerOptions;
  // Separately mutable so callers (DaemonClient) can swap the listener
  // when the meaning of "failed/closed" changes between connect-time
  // (= reject the connect Promise) and runtime (= surface as
  // transport-lost to trigger reconnect).
  private onStateCb?: (state: WebRTCPeerState) => void;

  constructor(opts: WebRTCPeerOptions) {
    this.opts = opts;
    this.onStateCb = opts.onState;
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS,
    });
    const pc = this.pc as unknown as EventfulPC;

    // Forward locally-gathered candidates to the owner. The owner pipes
    // them through SignalingClient to the daemon.
    pc.addEventListener("icecandidate", (event) => {
      const candidate = (event as { candidate: RTCIceCandidate | null })
        .candidate;
      if (!candidate) return; // null candidate signals end-of-candidates
      this.opts.onLocalCandidate(candidate.toJSON());
    });

    // Daemon side creates the DataChannel; we receive it via this event.
    pc.addEventListener("datachannel", (event) => {
      const dc = (event as { channel: RTCDataChannel }).channel;
      this.dc = dc;
      const dcEv = dc as unknown as EventfulDC;
      dcEv.addEventListener("open", () => {
        this.setState("connected");
        this.opts.onDataChannelOpen?.(dc);
      });
      dcEv.addEventListener("close", () => {
        this.setState("closed");
        this.opts.onDataChannelClose?.();
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      const s = this.pc.connectionState;
      if (s === "connecting") this.setState("ice-checking");
      else if (s === "failed") this.setState("failed");
      else if (s === "closed" || s === "disconnected") this.setState("closed");
      // "connected" state we already set in dc.open above — that's the
      // moment the channel is usable, not the moment connectionState flips.
    });
  }

  /** Process the daemon's offer + fpSig. Returns the answer SDP + our
   *  own fpSig — owner forwards them back to the daemon via signaling.
   *  Throws if the daemon's signature doesn't verify. */
  async handleOffer(
    offerSdp: string,
    daemonFpSig: string,
    iceServers?: RTCIceServer[],
  ): Promise<{ answerSdp: string; fpSig: string }> {
    if (this.closed) throw new Error("WebRTCPeer is closed");
    this.setState("received-offer");

    // 0. Apply the daemon-relayed TURN creds BEFORE we createAnswer — that's
    //    when this (answerer) side starts ICE gathering, so the relay must be
    //    in the config by now for our candidates to include it. The daemon is
    //    the sole minter; absent creds (mint unavailable) we keep the
    //    STUN-only default the constructor set. The fpSig check below still
    //    pins DTLS identity, so a tampering worker can't swap in a hostile
    //    relay without invalidating the signature.
    if (iceServers && iceServers.length > 0) {
      this.pc.setConfiguration({ iceServers });
    }

    // 1. Verify daemon's signature over the SDP fingerprint before we
    //    even acknowledge the offer. If signaling DO was compromised and
    //    swapped the fingerprint, this catches it pre-DTLS.
    this.setState("verifying");
    const daemonFp = extractDtlsFingerprint(offerSdp);
    const transcript = dtlsFingerprintTranscript(daemonFp);
    const ok = await this.opts.verifyFingerprint(transcript, daemonFpSig);
    if (!ok) {
      this.setState("failed");
      throw new Error(
        "daemon SDP fingerprint signature did not verify against the QR-known pubkey",
      );
    }

    // 2. Accept daemon's offer, then flush candidates that raced ahead of
    //    it (the fpSig verify above is async — daemon candidate frames
    //    routinely arrive mid-verify).
    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: offerSdp }),
    );
    this.remoteDescriptionSet = true;
    for (const candidate of this.pendingRemoteCandidates.splice(0)) {
      await this.addRemoteCandidate(candidate);
    }

    // 3. Generate our answer.
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    const answerSdp = answer.sdp ?? this.pc.localDescription?.sdp ?? "";

    // 4. Sign OUR fingerprint so the daemon can pin its remote end too.
    const ourFp = extractDtlsFingerprint(answerSdp);
    const fpSig = await this.opts.signFingerprint(
      dtlsFingerprintTranscript(ourFp),
    );

    this.setState("answered");
    return { answerSdp, fpSig };
  }

  /** Apply a remote ICE candidate (from the daemon). Queued until the
   *  remote description lands — addIceCandidate before it throws, and a
   *  swallowed throw silently discards the candidate forever. */
  async addRemoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) return;
    if (!this.remoteDescriptionSet) {
      this.pendingRemoteCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // Post-description failures are benign — end-of-candidates (null) on
      // platforms that don't filter it, or duplicates. The PC's own state
      // machine reflects connection health.
    }
  }

  /** Best-effort send on the established DataChannel. No-op if not open. */
  send(data: string | ArrayBuffer): void {
    if (!this.dc || this.dc.readyState !== "open") return;
    this.dc.send(data as string);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dc?.close();
    } catch {
      // ignore
    }
    try {
      this.pc.close();
    } catch {
      // ignore
    }
    this.setState("closed");
  }

  getState(): WebRTCPeerState {
    return this.state;
  }

  /** Replace the state-change listener. Used by DaemonClient to switch
   *  from a connect-time failure handler (rejects the connect Promise)
   *  to a runtime handler (treats failed/closed as transport lost). */
  setOnState(cb: ((state: WebRTCPeerState) => void) | null): void {
    this.onStateCb = cb ?? undefined;
  }

  private setState(state: WebRTCPeerState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateCb?.(state);
  }
}
