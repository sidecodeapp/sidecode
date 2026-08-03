import type { Command, DaemonFrame } from "@thinkite/protocol";
import { PROTOCOL_VERSION } from "@thinkite/protocol";
import { describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandHandler } from "./command.ts";
import { createLocalConnection } from "./local-connection.ts";

function makeConnection(handler?: CommandHandler) {
  const sent: DaemonFrame[] = [];
  const seen: Array<{ cmd: Command; ctx: CommandContext }> = [];
  const conn = createLocalConnection(
    handler ?? ((cmd, ctx) => void seen.push({ cmd, ctx })),
    { send: (frame) => void sent.push(frame) },
  );
  return { conn, sent, seen };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createLocalConnection", () => {
  it("dispatches a valid command to the handler with local fingerprint", async () => {
    const { conn, sent, seen } = makeConnection();
    conn.dispatchText(
      JSON.stringify({ type: "subscribeSessions", requestId: "r1" }),
    );
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cmd).toEqual({
      type: "subscribeSessions",
      requestId: "r1",
    });
    expect(seen[0]!.ctx.fingerprint).toBe("local");
    expect(sent).toHaveLength(0);
  });

  it("routes ctx.send back through the transport", async () => {
    const { conn, sent } = makeConnection((_cmd, ctx) => {
      ctx.send({ type: "error", code: "unsupported", message: "nope" });
    });
    conn.dispatchText(
      JSON.stringify({ type: "subscribeSessions", requestId: "r1" }),
    );
    await flush();
    expect(sent).toEqual([
      { type: "error", code: "unsupported", message: "nope" },
    ]);
  });

  it("answers hello with server_info without invoking the handler", () => {
    const { conn, sent, seen } = makeConnection();
    conn.dispatchText(
      JSON.stringify({ type: "hello", protocolVersion: "9.9.9" }),
    );
    expect(sent).toEqual([
      { type: "server_info", protocolVersion: PROTOCOL_VERSION },
    ]);
    expect(seen).toHaveLength(0);
  });

  it("answers ping with pong echoing t", () => {
    const { conn, sent } = makeConnection();
    conn.dispatchText(JSON.stringify({ type: "ping", t: 123 }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "pong", echoT: 123 });
  });

  it("replies invalid_message on non-JSON and schema-invalid input", () => {
    const { conn, sent, seen } = makeConnection();
    conn.dispatchText("not json");
    conn.dispatchText(JSON.stringify({ type: "no_such_frame" }));
    expect(sent).toHaveLength(2);
    for (const frame of sent) {
      expect(frame).toMatchObject({ type: "error", code: "invalid_message" });
    }
    expect(seen).toHaveLength(0);
  });

  it("converts handler throw/reject into an error frame with requestId", async () => {
    const { conn, sent } = makeConnection(() => {
      throw new Error("boom");
    });
    conn.dispatchText(
      JSON.stringify({ type: "subscribeSessions", requestId: "r7" }),
    );
    await flush();
    expect(sent).toEqual([
      {
        type: "error",
        requestId: "r7",
        code: "internal",
        message: "handler error: boom",
      },
    ]);
  });

  it("fires onDisconnect callbacks exactly once on close, swallowing throws", async () => {
    const first = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const second = vi.fn();
    const { conn } = makeConnection((_cmd, ctx) => {
      ctx.onDisconnect(first);
      ctx.onDisconnect(second);
    });
    conn.dispatchText(
      JSON.stringify({ type: "subscribeSessions", requestId: "r1" }),
    );
    await flush();
    conn.close();
    conn.close();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("drops frames and outbound sends after close", async () => {
    const sent: DaemonFrame[] = [];
    let lateCtx: CommandContext | undefined;
    const conn = createLocalConnection(
      (_cmd, ctx) => {
        lateCtx = ctx;
      },
      { send: (frame) => void sent.push(frame) },
    );
    conn.dispatchText(
      JSON.stringify({ type: "subscribeSessions", requestId: "r1" }),
    );
    await flush();
    conn.close();
    conn.dispatchText(JSON.stringify({ type: "ping", t: 1 }));
    lateCtx!.send({ type: "error", code: "internal", message: "late" });
    expect(sent).toHaveLength(0);
  });
});
