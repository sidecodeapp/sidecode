import * as ed25519 from "@noble/ed25519";
import {
  type ChunkEnvelope,
  ChunkReassembler,
  chunkMessage,
  isChunkEnvelope,
} from "@thinkite/protocol";
import { base64UrlToBytes } from "./base64";
import type { ClientIdentity } from "./identity";
import { SignalingClient, type SignalingPeer } from "./signaling-client";
import { WebRTCPeer } from "./webrtc-peer";
import type { WireTransport } from "./wire-transport";

/**
 * WebRTC implementation of `WireTransport`: DataChannel + the CF-worker
 * signaling / SDP-fingerprint-pinned establishment dance, extracted
 * verbatim from the old `Transport.connect`. Owns the two DataChannel
 * quirks the RPC layer shouldn't see:
 *
 *   - chunk envelopes — SCTP caps a message at ~256KiB, so oversized
 *     JSON is split by `chunkMessage` on send and stitched by
 *     `ChunkReassembler` on receive (see protocol/chunking.ts);
 *   - string/BufferSource decode on inbound messages.
 */

class WebRTCWireTransport implements WireTransport {
  private onFrame: ((frame: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;
  private closeFired = false;
  private readonly reassembler = new ChunkReassembler();

  constructor(
    private readonly signaling: SignalingClient,
    private readonly peer: WebRTCPeer,
    private readonly dc: RTCDataChannel,
  ) {}

  /**
   * Wire DataChannel + peer-state handlers. Called exactly once, right
   * after the DC opens. Swaps the peer's state listener from
   * connect-time (rejects the connect promise) to runtime — once the
   * channel is up, ICE/DTLS keepalive failures (Mac WiFi off, daemon
   * crash, peer network change) surface as `failed`/`closed` on the PC.
   * DataChannel.onclose alone is not enough: many WebRTC stacks only
   * fire it on explicit pc.close(), so a half-dead PC can sit silent
   * for minutes.
   */
  install(): void {
    this.peer.setOnState((s) => {
      if (s === "failed" || s === "closed") this.fireClose();
    });
    const dcEv = this.dc as unknown as {
      addEventListener: (event: string, handler: (e: unknown) => void) => void;
    };
    dcEv.addEventListener("message", (event) => {
      const data = (event as { data: unknown }).data;
      let text: string;
      if (typeof data === "string") {
        text = data;
      } else {
        // BufferSource — shouldn't happen with our JSON wire, but be
        // permissive in case daemon ever ships binary frames.
        try {
          text = new TextDecoder().decode(data as ArrayBuffer);
        } catch {
          return;
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // ignore non-JSON
      }
      // Chunk reassembly. Daemon's `webrtc-peer.send()` splits oversized
      // frames into envelopes; intermediate pieces return `null` and we
      // wait, the last piece returns the full JSON which we re-parse and
      // deliver as a normal frame.
      if (isChunkEnvelope(parsed)) {
        const assembled = this.reassembler.push(parsed as ChunkEnvelope);
        if (assembled === null) return;
        try {
          parsed = JSON.parse(assembled);
        } catch {
          return;
        }
      }
      this.onFrame?.(parsed);
    });
    dcEv.addEventListener("close", () => this.fireClose());
  }

  diagnostics() {
    // No cheap synchronous rtt/path introspection on RTCPeerConnection
    // (getStats is async + verbose) — kind is all the panel needs to
    // confirm which wire is live.
    return { kind: "webrtc" as const };
  }

  send(frame: unknown): void {
    // react-native-webrtc's RTCDataChannel.send() takes string |
    // ArrayBuffer | ArrayBufferView; we use string here. `chunkMessage`
    // yields the original JSON for normal-sized frames; only an
    // oversized one (e.g. someone pasting megabytes into a prompt) gets
    // split into envelopes. Throws through to the caller — a refused
    // write fails that request, not the transport.
    const dcSend = (this.dc as unknown as { send: (s: string) => void }).send;
    const json = JSON.stringify(frame);
    for (const piece of chunkMessage(json)) {
      dcSend.call(this.dc, piece);
    }
  }

  setOnFrame(cb: ((frame: unknown) => void) | null): void {
    this.onFrame = cb;
  }

  setOnClose(cb: (() => void) | null): void {
    this.onClose = cb;
  }

  close(): void {
    try {
      this.peer.close();
    } catch {
      // already closed
    }
    try {
      this.signaling.close();
    } catch {
      // already closed
    }
    // peer.close() flips its state to "closed", which fires the state
    // listener → fireClose(). fireClose is idempotent either way.
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
 * Establish the WebRTC wire: signaling open → daemon offer (fpSig
 * verified against the QR-known pubkey) → answer (our fpSig) → ICE/DTLS
 * → DataChannel open. Resolves with an installed `WireTransport`;
 * rejects on verification failure, connection failure, or `deadlineAt`.
 *
 * The wire-version handshake is NOT part of this — the caller runs
 * `helloHandshake` next, under the same deadline.
 */
export function connectWebRTCWire(
  identity: ClientIdentity,
  daemonPubkey: string,
  deadlineAt: number,
  timeoutMessage: string,
): Promise<WireTransport> {
  return new Promise((resolve, reject) => {
    // daemon-side connection ID we learn from `peers` / `peer.joined`,
    // used to address candidate / answer frames back to the daemon.
    let daemonPeerId: string | null = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      try {
        peer.close();
      } catch {
        // ignore
      }
      try {
        signaling.close();
      } catch {
        // ignore
      }
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timeoutId = setTimeout(
      () => fail(new Error(timeoutMessage)),
      Math.max(0, deadlineAt - Date.now()),
    );

    const peer = new WebRTCPeer({
      signFingerprint: (transcript) => identity.sign(transcript),
      verifyFingerprint: async (transcript, sigB64) => {
        try {
          return await ed25519.verifyAsync(
            base64UrlToBytes(sigB64),
            transcript,
            base64UrlToBytes(daemonPubkey),
          );
        } catch {
          return false;
        }
      },
      onLocalCandidate: (candidate) => {
        if (!daemonPeerId) return;
        signaling.send(daemonPeerId, "candidate", { candidate });
      },
      onDataChannelOpen: (dc) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        // Signaling has done its job — close to free the worker
        // connection. Trickle candidates after DC-open are pointless
        // (ICE already succeeded) and the established DataChannel
        // doesn't depend on the socket.
        try {
          signaling.close();
        } catch {
          // ignore
        }
        const wire = new WebRTCWireTransport(signaling, peer, dc);
        wire.install();
        resolve(wire);
      },
      onState: (s) => {
        if (s === "failed") {
          fail(
            new Error(
              "WebRTC connection failed (ICE or DTLS). Network or NAT may be blocking peer-to-peer; try again.",
            ),
          );
        }
      },
    });

    const onDaemonAvailable = (daemon: SignalingPeer) => {
      daemonPeerId = daemon.id;
      // Daemon sees `peer.joined` from its side and is responsible for
      // initiating the offer; iOS sits and waits. No-op here.
    };

    const signaling = new SignalingClient({
      daemonPubkey,
      clientPubkey: identity.publicKeyB64,
      onPeers: (peers) => {
        const daemon = peers.find((p) => p.role === "daemon");
        if (daemon) onDaemonAvailable(daemon);
      },
      onPeerJoined: (peer) => {
        if (peer.role === "daemon") onDaemonAvailable(peer);
      },
      onOffer: (from, sdp, fpSig, iceServers) => {
        daemonPeerId = from;
        // `iceServers` carries the daemon-minted TURN creds (it's the sole
        // minter). handleOffer applies them before it gathers ICE so our
        // candidates include the relay; absent them we stay STUN-only.
        void peer
          .handleOffer(sdp, fpSig, iceServers)
          .then(({ answerSdp, fpSig: ourSig }) => {
            signaling.send(from, "answer", { sdp: answerSdp, fpSig: ourSig });
          })
          .catch((err) => {
            fail(err instanceof Error ? err : new Error(String(err)));
          });
      },
      onCandidate: (_from, candidate) => {
        void peer.addRemoteCandidate(candidate as RTCIceCandidateInit);
      },
      onProtocolError: (reason) => {
        // Worker-level errors (peer_not_found / missing_to / etc.) are
        // logged but don't fail the connect — they're typically benign
        // (e.g. daemon transiently offline so our candidate frame got
        // rejected). The timeout will catch the actual stuck cases.
        console.warn(`signaling protocol error: ${reason}`);
      },
    });
    signaling.connect();
  });
}
