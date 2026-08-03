// WebSocket bridge from the renderer to the in-process daemon's command
// router — the local twin of the iOS WebRTC transport. Dumb by design: the
// daemon's LocalConnection owns frame parsing, validation, and error replies
// (invalid input is answered in-band, never thrown); this module only moves
// text and ties connection lifetime to socket lifetime.
//
// One LocalConnection per socket. Closing the socket fires the router's
// per-connection cleanups (subscription fanouts), so a reloaded webview
// never leaks subscribers.
//
// `ws` is per-socket listeners (unlike Bun.serve's handler-per-server API
// this replaced), so index.ts just hands the upgraded socket here — no
// ws.data discriminant dance.
import type { Daemon } from "@thinkite/daemon";
import type { WebSocket } from "ws";

export function attachRpc(ws: WebSocket, daemon: Daemon): void {
  const conn = daemon.connectLocal({
    send: (frame) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(frame));
      }
    },
  });
  ws.on("message", (msg, isBinary) => {
    if (!isBinary) conn.dispatchText(msg.toString());
  });
  // conn.close() is idempotent; fires the router's per-connection cleanups
  // (subscription fanouts) so a reloaded webview never leaks subscribers.
  ws.on("close", () => conn.close());
}
