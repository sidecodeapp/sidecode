import {
  isProtocolCompatible,
  outdatedSide,
  PROTOCOL_VERSION,
} from "@thinkite/protocol";

/**
 * Byte-layer seam between `Transport` (the RPC/frame layer in
 * daemon-client.ts) and a concrete transport:
 *
 *   - `webrtc-wire.ts` — DataChannel; owns the signaling/SDP-fp dance,
 *     chunk envelopes (SCTP message cap) and string decode.
 *   - `iroh-wire.ts` — QUIC bi-stream; owns length-prefix framing.
 *
 * Both sides of the interface deal in whole, parsed protocol frames —
 * serialization, framing and reassembly are implementation details, so
 * the RPC layer above is transport-blind.
 */
/** One network path of a live iroh connection (direct IP or relay). */
export interface WirePathInfo {
  /** `ip:port` for direct paths, relay URL for relay paths. */
  remoteAddr: string;
  /** True if QUIC currently sends application data over this path. */
  isSelected: boolean;
  kind: "ip" | "relay";
  rttMs: number;
}

/**
 * Point-in-time transport diagnostics for the phase-4 measurement
 * panel (Settings → host). WebRTC reports only its kind; iroh samples
 * live QUIC state (rtt, open paths) on every call — poll to watch
 * path migration during roaming tests.
 */
export interface WireDiagnostics {
  kind: "webrtc" | "iroh";
  rttMs?: number;
  paths?: WirePathInfo[];
}

export interface WireTransport {
  /** Send one protocol frame. May throw synchronously when the
   *  underlying channel refuses the write (caller decides whether that
   *  fails one request or the whole transport). */
  send(frame: unknown): void;
  /** Sample transport diagnostics. Cheap; safe after close (fields
   *  degrade to undefined). */
  diagnostics(): WireDiagnostics;
  /** Replace the inbound-frame listener. Frames arrive fully
   *  reassembled and JSON-parsed. Latest registration wins (the hello
   *  handshake registers first, then hands off to the frame router);
   *  null clears. */
  setOnFrame(cb: ((frame: unknown) => void) | null): void;
  /** Replace the transport-fatal listener (remote close, ICE/QUIC
   *  failure, network death). Fires at most once. Latest wins; null
   *  clears. */
  setOnClose(cb: (() => void) | null): void;
  /** Idempotent. Closing locally still fires the close listener —
   *  callers that initiated the close track that themselves (see
   *  Transport.intentionallyClosed). */
  close(): void;
}

/**
 * Wire-version mismatch between app and daemon (each side's frames
 * carry its PROTOCOL_VERSION, so `outdatedSide` names the stale one).
 *
 * Unlike a transient unreachable-daemon failure, this is TERMINAL: no
 * amount of retrying changes the version check. `DaemonClientProvider`
 * routes it to a terminal `error` state and stops the auto-reconnect
 * loop (the user re-attempts via `reset()` after updating).
 */
export class IncompatibleProtocolError extends Error {
  readonly appProtocolVersion = PROTOCOL_VERSION;
  readonly daemonProtocolVersion: string | null;
  /** Which side is too old. `"daemon"` → update the Mac app, `"app"` →
   *  update this app, `"unknown"` → no usable daemon version, update both. */
  readonly outdatedSide: "app" | "daemon" | "unknown";
  constructor(daemonProtocolVersion: string | null = null) {
    const side =
      daemonProtocolVersion === null
        ? null
        : outdatedSide(daemonProtocolVersion);
    super(
      side === "remote"
        ? "The Mac app is out of date. Update Thinkite on your Mac, then try again."
        : side === "local"
          ? "This app is out of date. Update Thinkite from the App Store, then try again."
          : "Thinkite is out of date. Update both the iPhone app and the Mac app to the latest version, then try again.",
    );
    this.name = "IncompatibleProtocolError";
    this.daemonProtocolVersion = daemonProtocolVersion;
    this.outdatedSide =
      side === "remote" ? "daemon" : side === "local" ? "app" : "unknown";
  }
}

/**
 * Wire-version handshake, shared by every transport: send `hello`,
 * resolve on a compatible `server_info`, reject on the daemon's
 * `incompatible_protocol` error (or an incompatible server_info —
 * defense in depth against asymmetric compat-rule drift), transport
 * close, or the deadline.
 *
 * Uses the wire's frame/close listener slots and clears them on
 * settle — the caller installs its own runtime listeners afterwards.
 */
export function helloHandshake(
  wire: WireTransport,
  deadlineAt: number,
  timeoutMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      wire.setOnFrame(null);
      wire.setOnClose(null);
      fn();
    };
    const timeoutId = setTimeout(
      () => finish(() => reject(new Error(timeoutMessage))),
      Math.max(0, deadlineAt - Date.now()),
    );
    wire.setOnClose(() =>
      finish(() =>
        reject(new Error("connection closed during version handshake")),
      ),
    );
    wire.setOnFrame((raw) => {
      const frame = raw as {
        type?: string;
        code?: string;
        message?: string;
        protocolVersion?: string;
      };
      if (frame.type === "error" && frame.code === "incompatible_protocol") {
        // Keep the daemon's diagnostic text (which version it wanted,
        // which we sent) in a console.warn for debugging; user-facing
        // copy comes from IncompatibleProtocolError.
        if (frame.message) {
          console.warn(
            `daemon reported incompatible_protocol: ${frame.message}`,
          );
        }
        finish(() =>
          reject(new IncompatibleProtocolError(frame.protocolVersion ?? null)),
        );
        return;
      }
      if (
        frame.type === "server_info" &&
        typeof frame.protocolVersion === "string"
      ) {
        const version = frame.protocolVersion;
        if (!isProtocolCompatible(version)) {
          finish(() => reject(new IncompatibleProtocolError(version)));
          return;
        }
        finish(resolve);
      }
      // Anything else pre-handshake is unexpected — wait for the
      // deadline rather than guess at it.
    });
    try {
      wire.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    } catch (err) {
      finish(() =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    }
  });
}
