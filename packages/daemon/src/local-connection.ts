import {
  type ClientFrame,
  clientFrame,
  type DaemonFrame,
  PROTOCOL_VERSION,
} from "@thinkite/protocol";
import type { CommandContext, CommandHandler } from "./command.ts";

/**
 * In-process transport for the daemon's command router — the local
 * counterpart of IrohPeerServer's per-peer dispatch. A host that embeds
 * the daemon (deno desktop) creates one connection per GUI socket and pipes
 * raw message text in; frames flow back through `send`.
 *
 * Same wire language as the remote transport (ClientFrame / DaemonFrame
 * JSON), so a client implementation is portable across both. Two remote
 * concerns are deliberately absent:
 *  - no version gate: both ends import the same protocol package in the
 *    same process, so `hello` is answered with `server_info` unconditionally
 *    (a client written against the remote handshake works unchanged);
 *  - no chunk envelopes: this never rides a DataChannel, so there is no
 *    16KB wire limit to split around.
 */
export interface LocalConnectionOptions {
  /** Deliver one daemon frame to the client (e.g. WebSocket send). */
  send: (frame: DaemonFrame) => void;
  log?: (msg: string) => void;
}

export interface LocalConnection {
  /**
   * Feed one raw client message (JSON text). Malformed input is answered
   * with an `invalid_message` error frame, never thrown. No-op after close.
   */
  dispatchText(text: string): void;
  /**
   * Tear down: fires the router's onDisconnect cleanups (subscription
   * fanouts etc.) exactly once. Idempotent.
   */
  close(): void;
}

export function createLocalConnection(
  commandHandler: CommandHandler,
  options: LocalConnectionOptions,
): LocalConnection {
  const log = options.log ?? (() => {});
  const state = new Map<string, unknown>();
  const disconnectCallbacks: Array<() => void> = [];
  let closed = false;

  const send = (frame: DaemonFrame): void => {
    if (closed) return;
    try {
      options.send(frame);
    } catch (err) {
      log(
        `[local] send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const ctx: CommandContext = {
    send,
    fingerprint: "local",
    onDisconnect: (cb) => disconnectCallbacks.push(cb),
    state,
  };

  return {
    dispatchText(text: string): void {
      if (closed) return;
      let frame: ClientFrame;
      try {
        frame = clientFrame.parse(JSON.parse(text));
      } catch (err) {
        send({
          type: "error",
          code: "invalid_message",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (frame.type === "hello") {
        send({ type: "server_info", protocolVersion: PROTOCOL_VERSION });
        return;
      }
      if (frame.type === "ping") {
        send({ type: "pong", t: Date.now(), echoT: frame.t });
        return;
      }
      const cmd = frame;
      Promise.resolve()
        .then(() => commandHandler(cmd, ctx))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log(`[local] handler error on ${cmd.type}: ${message}`);
          send({
            type: "error",
            requestId:
              "requestId" in cmd
                ? (cmd as { requestId?: string }).requestId
                : undefined,
            code: "internal",
            message: `handler error: ${message}`,
          });
        });
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const cb of disconnectCallbacks) {
        try {
          cb();
        } catch (err) {
          log(
            `[local] disconnect callback failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      disconnectCallbacks.length = 0;
    },
  };
}
