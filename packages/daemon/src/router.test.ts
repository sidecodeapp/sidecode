import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  Command,
  DaemonFrame,
  EventDelta,
  TimelineItem,
} from "@thinkite/protocol";
import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "./command.ts";
import { GitWatcherRegistry } from "./git-watch.ts";
import { createCommandHandler } from "./router.ts";
import { SessionRuntimeManager } from "./runtime/session-runtime-manager.ts";
import type { SidecodeSessionMetadata } from "./sidecode-sessions.ts";

function makeCtx(): {
  ctx: CommandContext;
  sent: DaemonFrame[];
  fireDisconnect: () => void;
} {
  const sent: DaemonFrame[] = [];
  const callbacks: Array<() => void> = [];
  return {
    sent,
    fireDisconnect: () => {
      for (const cb of callbacks) cb();
      callbacks.length = 0;
    },
    ctx: {
      send: (f) => sent.push(f),
      fingerprint: "0123456789abcdef",
      onDisconnect: (cb) => {
        callbacks.push(cb);
      },
      state: new Map(),
    },
  };
}

/** Default deps for command-handler tests. */
function makeDeps(
  overrides?: Partial<Parameters<typeof createCommandHandler>[0]>,
): Parameters<typeof createCommandHandler>[0] {
  return {
    listSidecodeSessions: vi.fn().mockReturnValue([]),
    getMessages: vi.fn().mockResolvedValue({ items: [] }),
    runtimeManager: new SessionRuntimeManager<EventDelta>(),
    hasSession: vi.fn().mockResolvedValue(true),
    isShuttingDown: () => false,
    gitWatchers: new GitWatcherRegistry(),
    epoch: "test-epoch",
    ...overrides,
  };
}

describe("createCommandHandler — unsupported commands", () => {
  it("replies error/unsupported with the inbound requestId", async () => {
    // deleteSession is reserved for V1+ (per project_sidecode_persistence
    // memory) — router falls through to the unsupported-default branch.
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "deleteSession", requestId: "del-1", sessionId: "s" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      code: "unsupported",
    });
    expect((sent[0] as { requestId?: string }).requestId).toBe("del-1");
  });
});

describe("createCommandHandler — subscribe / unsubscribe", () => {
  it("subscribe replies with settled + cursor and starts fanning out events", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        getMessages: vi.fn().mockResolvedValue({
          items: [{ type: "user_message", uuid: "u-1", text: "hi" }],
        }),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-1", sessionId: "S" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      requestId: "sub-1",
      sessionId: "S",
      cursor: 0,
    });
    expect((sent[0] as { settled: TimelineItem[] }).settled).toEqual([
      { type: "user_message", uuid: "u-1", text: "hi" },
    ]);
    // Now emit events on the runtime — fanout should ctx.send `event` frames.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime to exist");
    runtime.addEvent({ kind: "turn_started" });
    runtime.addEvent({
      kind: "patch_text",
      uuid: "msg:0",
      deltaText: "hello",
    });
    expect(sent).toHaveLength(3); // subscribe.response + 2 event frames
    expect(sent[1]).toMatchObject({
      type: "event",
      sessionId: "S",
      cursor: 1,
      delta: { kind: "turn_started" },
    });
    expect(sent[2]).toMatchObject({
      type: "event",
      sessionId: "S",
      cursor: 2,
      delta: { kind: "patch_text", uuid: "msg:0", deltaText: "hello" },
    });
  });

  it("subscribe forwards initialUsage from getMessages onto the response", async () => {
    // Resume-time seed for the iOS context meter: daemon extracts
    // usage from the last assistant message's raw envelope (see
    // daemon/src/index.ts:extractLatestUsage), piggybacks on the
    // existing getMessages call, ships it on subscribe.response so
    // the meter renders before any live turn fires. Forwarding test
    // only — extraction logic lives in daemon/src/index.ts and is
    // smoke-checked there.
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager: new SessionRuntimeManager<EventDelta>(),
        getMessages: vi.fn().mockResolvedValue({
          items: [],
          initialUsage: {
            inputTokens: 500,
            cacheReadInputTokens: 120_000,
            cacheCreationInputTokens: 2_000,
          },
        }),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-iu", sessionId: "S" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      requestId: "sub-iu",
      initialUsage: {
        inputTokens: 500,
        cacheReadInputTokens: 120_000,
        cacheCreationInputTokens: 2_000,
      },
    });
  });

  it("subscribe with sinceCursor=current skips replay (only live events)", async () => {
    // Daemon's contract: subscribe sends settled (from JSONL) + cursor at
    // subscribe time; subsequent fanout = events with cursor > that value.
    // Pre-existing buffer events shouldn't be replayed (settled covers them).
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.addEvent({ kind: "turn_started" }); // cursor 1
    runtime.addEvent({ kind: "turn_completed" }); // cursor 2

    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-2", sessionId: "S" },
      ctx,
    );
    // Only subscribe.response — no replay of cursor 1 / 2.
    expect(sent).toHaveLength(1);
    expect((sent[0] as { cursor: number }).cursor).toBe(2);

    // Future events (cursor > 2) flow through.
    runtime.addEvent({ kind: "turn_failed", error: "boom" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      type: "event",
      cursor: 3,
      delta: { kind: "turn_failed", error: "boom" },
    });
  });

  it("cold-path subscribe response carries epoch + recovered:false", async () => {
    // Cold path = no resume metadata from client. Daemon returns the
    // full settled snapshot AND the process epoch so the client can
    // pass it back as `sinceEpoch` on the next reconnect.
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager: new SessionRuntimeManager<EventDelta>(),
        getMessages: vi.fn().mockResolvedValue({ items: [] }),
        epoch: "epoch-cold",
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-cold", sessionId: "S" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      epoch: "epoch-cold",
      recovered: false,
    });
  });

  it("warm-path subscribe with matching epoch + in-buffer sinceCursor replays gap and recovered:true", async () => {
    // Simulates iOS reconnect: client previously saw events up to
    // cursor 2, transport dropped, ring buffer (still in memory)
    // accumulated events 3-4 during the gap. On re-subscribe with
    // sinceCursor=2 + matching epoch, daemon must:
    //   - return EMPTY settled[] (client preserves its in-memory state)
    //   - mark recovered: true
    //   - replay the buffered events 3-4 as event frames
    //   - NO getMessages call (no JSONL re-read)
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.addEvent({ kind: "turn_started" }); // cursor 1
    runtime.addEvent({ kind: "turn_completed" }); // cursor 2
    runtime.addEvent({ kind: "turn_started" }); // cursor 3
    runtime.addEvent({ kind: "turn_failed", error: "x" }); // cursor 4

    const getMessages = vi.fn();
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, getMessages, epoch: "e1" }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "subscribe",
        requestId: "sub-warm",
        sessionId: "S",
        sinceCursor: 2,
        sinceEpoch: "e1",
      },
      ctx,
    );

    // Wire ordering: response first, then replay frames (events 3 + 4).
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      epoch: "e1",
      recovered: true,
      cursor: 4,
      settled: [],
    });
    expect(sent[1]).toMatchObject({
      type: "event",
      cursor: 3,
      delta: { kind: "turn_started" },
    });
    expect(sent[2]).toMatchObject({
      type: "event",
      cursor: 4,
      delta: { kind: "turn_failed", error: "x" },
    });
    // Warm path bypasses JSONL — getMessages must NOT have fired.
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("isNew subscribe replays ring-buffer events without a getMessages scan", async () => {
    // Brand-new-session fast path: the create-path sendPrompt already ran
    // (pushed the synthesized user_message + turn_started) before the
    // detail screen's subscribe arrives. The daemon serves those from the
    // ring buffer WITHOUT the (expensive, race-prone) JSONL scan.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.addEvent({
      kind: "append",
      item: { type: "user_message", uuid: "u-1", text: "hi" },
    }); // cursor 1
    runtime.addEvent({ kind: "turn_started" }); // cursor 2

    // Rejects if the cold path's JSONL scan is reached — proves the fast
    // path skips the await entirely (no await = no interleaving window).
    const getMessages = vi
      .fn()
      .mockRejectedValue(new Error("getMessages must not run on isNew"));
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, getMessages, epoch: "e-new" }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-new", sessionId: "S", isNew: true },
      ctx,
    );

    expect(getMessages).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      requestId: "sub-new",
      sessionId: "S",
      epoch: "e-new",
      recovered: false,
      cursor: 2,
      settled: [],
    });
    // Replay from floor 0 delivers the synthesized user_message + turn_started.
    expect(sent).toHaveLength(3);
    expect(sent[1]).toMatchObject({
      type: "event",
      cursor: 1,
      delta: { kind: "append", item: { type: "user_message", uuid: "u-1" } },
    });
    expect(sent[2]).toMatchObject({
      type: "event",
      cursor: 2,
      delta: { kind: "turn_started" },
    });
  });

  it("isNew subscribe arriving BEFORE the first prompt still delivers it live", async () => {
    // The race ordering: the detail screen subscribes (isNew) before the
    // create-path sendPrompt has pushed anything. The fast path registers
    // the fanout at cursor 0 synchronously (no await window), so events
    // pushed afterwards arrive live — none are dropped.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const getMessages = vi
      .fn()
      .mockRejectedValue(new Error("getMessages must not run on isNew"));
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, getMessages, epoch: "e-new2" }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-new2", sessionId: "S", isNew: true },
      ctx,
    );
    expect(getMessages).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      recovered: false,
      cursor: 0,
      settled: [],
    });

    // Now the create-path pushPrompt fires — events fan out live.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime to exist");
    runtime.addEvent({
      kind: "append",
      item: { type: "user_message", uuid: "u-9", text: "first" },
    }); // cursor 1
    runtime.addEvent({ kind: "turn_started" }); // cursor 2
    expect(sent).toHaveLength(3);
    expect(sent[1]).toMatchObject({
      type: "event",
      cursor: 1,
      delta: { kind: "append", item: { type: "user_message", uuid: "u-9" } },
    });
    expect(sent[2]).toMatchObject({
      type: "event",
      cursor: 2,
      delta: { kind: "turn_started" },
    });
  });

  it("isNew is ignored when a resume hint (sinceCursor) is present", async () => {
    // A reconnect carries sinceCursor; even if a stale isNew rides along,
    // the warm recovery path must win so an existing transcript is never
    // blanked by the empty-settled fast path.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.addEvent({ kind: "turn_started" }); // cursor 1
    runtime.addEvent({ kind: "turn_completed" }); // cursor 2

    const handler = createCommandHandler(
      makeDeps({ runtimeManager, epoch: "e-resume" }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "subscribe",
        requestId: "sub-resume",
        sessionId: "S",
        isNew: true,
        sinceCursor: 1,
        sinceEpoch: "e-resume",
      },
      ctx,
    );
    // Warm path wins: recovered:true + replay of cursor 2, NOT the fast path.
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      recovered: true,
      cursor: 2,
    });
  });

  it("warm-path falls back to cold-path on epoch mismatch", async () => {
    // Simulates daemon restart between iOS sessions: client's stored
    // sinceEpoch is from the OLD process, current daemon has a new
    // nonce. Daemon must transparently fall back to full snapshot —
    // no error frame, just recovered:false so the client knows to
    // truncate its in-memory state and re-ingest.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.addEvent({ kind: "turn_started" }); // cursor 1

    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        getMessages: vi.fn().mockResolvedValue({
          items: [{ type: "user_message", uuid: "u-1", text: "old" }],
        }),
        epoch: "epoch-new",
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "subscribe",
        requestId: "sub-mismatch",
        sessionId: "S",
        sinceCursor: 1,
        sinceEpoch: "epoch-old",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      epoch: "epoch-new",
      recovered: false,
    });
    expect((sent[0] as { settled: TimelineItem[] }).settled).toEqual([
      { type: "user_message", uuid: "u-1", text: "old" },
    ]);
  });

  it("warm-path falls back to cold-path when sinceCursor predates the ring buffer", async () => {
    // Simulates: WebRTC was disconnected long enough for the ring
    // buffer (cap 500) to evict the events the client needs. Even
    // though the epoch matches, the daemon can't serve an incremental
    // resume — falls back to cold path. Tested with a tiny bufferCap
    // for determinism.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S", { bufferCap: 2 });
    runtime.addEvent({ kind: "turn_started" }); // cursor 1 → will be evicted
    runtime.addEvent({ kind: "turn_completed" }); // cursor 2 → will be evicted
    runtime.addEvent({ kind: "turn_started" }); // cursor 3 → kept (oldest)
    runtime.addEvent({ kind: "turn_completed" }); // cursor 4 → kept

    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        getMessages: vi.fn().mockResolvedValue({ items: [] }),
        epoch: "e1",
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "subscribe",
        requestId: "sub-stale",
        sessionId: "S",
        sinceCursor: 1, // events 2 (the gap-fill we'd need) was evicted
        sinceEpoch: "e1",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      recovered: false,
    });
  });

  it("re-subscribe to the same session on the same conn replaces the prior fanout", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-1", sessionId: "S" },
      ctx,
    );
    await handler(
      { type: "subscribe", requestId: "sub-2", sessionId: "S" },
      ctx,
    );
    // Manager should only carry ONE subscriber for this conn — the second
    // subscribe call dropped the first cb before registering the new one.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime");
    expect(runtime.subscriberCount).toBe(1);
    runtime.addEvent({ kind: "turn_started" });
    // Only ONE event frame emitted (no double-delivery).
    const eventFrames = sent.filter((f) => f.type === "event");
    expect(eventFrames).toHaveLength(1);
  });

  it("unsubscribe stops fanout and replies with the response frame", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-1", sessionId: "S" },
      ctx,
    );
    await handler(
      { type: "unsubscribe", requestId: "uns-1", sessionId: "S" },
      ctx,
    );
    expect(sent.at(-1)).toMatchObject({
      type: "unsubscribe.response",
      requestId: "uns-1",
    });
    // Manager has no subscribers anymore → addEvent fans out to nobody.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime");
    expect(runtime.subscriberCount).toBe(0);
    const before = sent.length;
    runtime.addEvent({ kind: "turn_started" });
    expect(sent.length).toBe(before);
  });

  it("unsubscribe for a session we don't have a sub for is a silent ack", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "unsubscribe", requestId: "uns-orphan", sessionId: "no-such" },
      ctx,
    );
    expect(sent).toEqual([
      { type: "unsubscribe.response", requestId: "uns-orphan" },
    ]);
  });

  it("ws disconnect (onDisconnect callback firing) clears all this conn's subs", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, fireDisconnect } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-1", sessionId: "S1" },
      ctx,
    );
    await handler(
      { type: "subscribe", requestId: "sub-2", sessionId: "S2" },
      ctx,
    );
    expect(runtimeManager.get("S1")?.subscriberCount).toBe(1);
    expect(runtimeManager.get("S2")?.subscriberCount).toBe(1);
    fireDisconnect();
    expect(runtimeManager.get("S1")?.subscriberCount).toBe(0);
    expect(runtimeManager.get("S2")?.subscriberCount).toBe(0);
  });

  it("two connections subscribed to the same session each get their own fanout", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const a = makeCtx();
    const b = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-a", sessionId: "S" },
      a.ctx,
    );
    await handler(
      { type: "subscribe", requestId: "sub-b", sessionId: "S" },
      b.ctx,
    );
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime");
    expect(runtime.subscriberCount).toBe(2);
    runtime.addEvent({ kind: "turn_started" });
    expect(a.sent.filter((f) => f.type === "event")).toHaveLength(1);
    expect(b.sent.filter((f) => f.type === "event")).toHaveLength(1);
    // Disconnecting only `a` doesn't affect `b`.
    a.fireDisconnect();
    expect(runtime.subscriberCount).toBe(1);
    runtime.addEvent({ kind: "turn_completed" });
    expect(a.sent.filter((f) => f.type === "event")).toHaveLength(1); // unchanged
    expect(b.sent.filter((f) => f.type === "event")).toHaveLength(2);
  });

  it("subscribe error path: getMessages rejects → error frame, no runtime sub registered", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        getMessages: vi.fn().mockRejectedValue(new Error("disk read failed")),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-x", sessionId: "S" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sub-x",
      code: "internal",
      message: expect.stringContaining("disk read failed"),
    });
    // Runtime was getOrCreate'd but no subscriber registered (subscribe
    // throws before runtime.subscribe runs).
    expect(runtimeManager.get("S")?.subscriberCount).toBe(0);
  });
});

// ─── sendPrompt + interrupt + shuttingDown ────────────────────────────────
//
// These tests use a hand-rolled queryFactory that returns an empty,
// immediately-completing iterator — we only care about the handler's
// orchestration (path decision, runtime state, response shape), not what
// the SDK does with the prompt afterward. F2's run-query.test.ts covers
// the consumer-loop side.

function emptyQueryFactory(): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return ((_params: unknown) => {
    async function* gen(): AsyncGenerator<never, void> {}
    const it = gen();
    return Object.assign(it, {
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
    }) as never;
  }) as never;
}

describe("createCommandHandler — sendPrompt", () => {
  it("resume path: existing session → ensureSessionLoop with mode=resume; turn_started emitted", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(true),
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-1",
        sessionId: "S",
        text: "hello",
      },
      ctx,
    );
    expect(sent.at(-1)).toEqual({
      type: "sendPrompt.response",
      requestId: "sp-1",
    });
    // Resume path: NO sidecode metadata written (Desktop / CLI already
    // own the session's local_*.json).
    expect(runtimeManager.getMetadata("S")).toBeUndefined();
    // Runtime was created and pushPrompt fired turn_started into the buffer.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime");
    expect(runtime.currentCursor).toBeGreaterThanOrEqual(1);
  });

  it("create path: new session + cwd → writes sidecode metadata before spawning query", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(false),
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-2",
        sessionId: "new-uuid",
        text: "first message",
        cwd: "/Users/me/proj",
      },
      ctx,
    );
    expect(runtimeManager.getMetadata("new-uuid")).toMatchObject({
      cliSessionId: "new-uuid",
      cwd: "/Users/me/proj",
      title: "first message",
      titleSource: "auto",
    });
    expect(sent.at(-1)).toEqual({
      type: "sendPrompt.response",
      requestId: "sp-2",
    });
  });

  it("create path without cwd → invalid_message error, no runtime spawned", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(false),
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-3",
        sessionId: "new-uuid",
        text: "hi",
        // cwd missing
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sp-3",
      code: "invalid_message",
      message: expect.stringContaining("cwd is required"),
    });
    expect(runtimeManager.getMetadata("new-uuid")).toBeUndefined();
    expect(runtimeManager.has("new-uuid")).toBe(false);
  });

  it("rejected during shutdown → error frame, no runtime side-effect", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        isShuttingDown: () => true,
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-shut",
        sessionId: "S",
        text: "hi",
        cwd: "/x",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sp-shut",
      message: expect.stringContaining("shutting down"),
    });
    expect(runtimeManager.getMetadata("S")).toBeUndefined();
    expect(runtimeManager.has("S")).toBe(false);
  });

  it("create path forwards model into manager-cached metadata", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(false),
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-mod",
        sessionId: "S",
        text: "hi",
        cwd: "/p",
        model: "claude-opus-4-7[1m]",
      },
      ctx,
    );
    expect(runtimeManager.getMetadata("S")).toMatchObject({
      cliSessionId: "S",
      cwd: "/p",
      title: "hi",
      model: "claude-opus-4-7[1m]",
    });
  });

  it("resume path does NOT modify metadata (setSessionSelection owns that path)", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(true),
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-upd",
        sessionId: "S",
        text: "hi",
        model: "claude-sonnet-4-6",
      },
      ctx,
    );
    // Resume path: sidecode never wrote metadata for this session in the
    // first place (Desktop owns it). Manager's cache stays empty.
    expect(runtimeManager.getMetadata("S")).toBeUndefined();
  });

  it("resume path does NOT call applyFlagSettings (setSessionSelection owns runtime apply)", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const applyFlagMock = vi.fn(async () => {});
    const runtime = runtimeManager.getOrCreate("S");
    runtime.loopPromise = Promise.resolve();
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
      applyFlagSettings: applyFlagMock,
    };
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(true),
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-no-apply",
        sessionId: "S",
        text: "hi",
        model: "claude-opus-4-7[1m]",
      },
      ctx,
    );
    expect(applyFlagMock).not.toHaveBeenCalled();
  });

  // ─── V0 slash-command whitelist defense-in-depth ────────────────────────
  // iOS's `useSlashCommandHandler` does the same check pre-send; these
  // tests cover the daemon's fallback rejection if iOS misbehaves. Single
  // source of truth = packages/protocol/src/slash-commands.ts.

  it("unknown slash command → unsupported error, no hasSession call, no runtime", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const hasSession = vi.fn();
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, hasSession }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-foo",
        sessionId: "S",
        text: "/foo bar baz",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sp-foo",
      code: "unsupported",
      message: expect.stringContaining("/foo"),
    });
    // Defense check happens BEFORE hasSession + metadata write, so
    // neither runs. A misbehaving client can't trigger session metadata
    // writes by spamming garbage slashes.
    expect(hasSession).not.toHaveBeenCalled();
    expect(runtimeManager.getMetadata("S")).toBeUndefined();
    expect(runtimeManager.has("S")).toBe(false);
  });

  it("intercept-handling slash (/clear) → unsupported error with hint", async () => {
    const handler = createCommandHandler(makeDeps({}));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-clear",
        sessionId: "S",
        text: "/clear",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sp-clear",
      code: "unsupported",
      message: expect.stringContaining("intercept-handling"),
    });
  });

  it("intercept-handling slash (/model with id) → unsupported error", async () => {
    // /model in the daemon = client bug. setSessionSelection RPC is the
    // correct path for runtime model switches.
    const handler = createCommandHandler(makeDeps({}));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-model",
        sessionId: "S",
        text: "/model claude-opus-4-7",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sp-model",
      code: "unsupported",
      message: expect.stringContaining("/model"),
    });
  });

  it("passthrough slash (/init) → proceeds normally, reaches SDK as raw text", async () => {
    // Sanity check that the defense doesn't accidentally block whitelisted
    // passthrough commands. /init flows through unchanged — its prompt
    // template expansion happens inside the SDK.
    const handler = createCommandHandler(
      makeDeps({
        hasSession: vi.fn().mockResolvedValue(true),
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-init",
        sessionId: "S",
        text: "/init",
      },
      ctx,
    );
    expect(sent.at(-1)).toEqual({
      type: "sendPrompt.response",
      requestId: "sp-init",
    });
  });
});

describe("createCommandHandler — setSessionSelection", () => {
  it("applies model via applyFlagSettings, then writes metadata", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.createSessionFromPrompt({
      cliSessionId: "S",
      cwd: "/p",
      firstPrompt: "init",
    });
    const applyFlagMock = vi.fn(async () => {});
    const runtime = runtimeManager.getOrCreate("S");
    runtime.loopPromise = Promise.resolve();
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
      applyFlagSettings: applyFlagMock,
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-1",
        sessionId: "S",
        model: "claude-opus-4-7[1m]",
      },
      ctx,
    );
    // Passing model via applyFlagSettings behaves identically to the
    // dedicated setModel setter per upstream docs — one entrypoint is
    // enough.
    expect(applyFlagMock).toHaveBeenCalledExactlyOnceWith({
      model: "claude-opus-4-7[1m]",
    });
    // Manager-owned: runtime.currentModel mirrored + states cache
    // updated. (Disk write only happens when manager.home is set, which
    // it isn't in this test — the in-memory cache update is what we
    // verify.)
    expect(runtime.currentModel).toBe("claude-opus-4-7[1m]");
    expect(runtimeManager.getMetadata("S")?.model).toBe("claude-opus-4-7[1m]");
    expect(sent.at(-1)).toMatchObject({
      type: "setSessionSelection.response",
      requestId: "ss-1",
    });
  });

  it("#17 setSessionSelection forwards model change to bridge.reportMetadata when bridged", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.createSessionFromPrompt({
      cliSessionId: "S",
      cwd: "/p",
      firstPrompt: "init",
    });
    const reportMetadataMock = vi.fn();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.loopPromise = Promise.resolve();
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
      applyFlagSettings: vi.fn(async () => {}),
    };
    runtime.bridge = {
      write: () => {},
      sendResult: () => {},
      reportState: () => {},
      reportMetadata: reportMetadataMock,
      close: () => {},
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-bridge",
        sessionId: "S",
        model: "claude-opus-4-7",
      },
      ctx,
    );
    expect(reportMetadataMock).toHaveBeenCalledExactlyOnceWith({
      model: "claude-opus-4-7",
    });
  });

  it("#17 setSessionSelection does NOT call bridge.reportMetadata when model is a no-op (same value)", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.createSessionFromPrompt({
      cliSessionId: "S",
      cwd: "/p",
      firstPrompt: "init",
      model: "claude-opus-4-7",
    });
    const reportMetadataMock = vi.fn();
    const runtime = runtimeManager.getOrCreate("S"); // currentModel seeded from states
    runtime.loopPromise = Promise.resolve();
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
      applyFlagSettings: vi.fn(async () => {}),
    };
    runtime.bridge = {
      write: () => {},
      sendResult: () => {},
      reportState: () => {},
      reportMetadata: reportMetadataMock,
      close: () => {},
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-noop-bridge",
        sessionId: "S",
        model: "claude-opus-4-7", // same as currentModel
      },
      ctx,
    );
    expect(reportMetadataMock).not.toHaveBeenCalled();
  });

  it("#17 setSessionSelection with no bridge attached: skips reportMetadata silently", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.createSessionFromPrompt({
      cliSessionId: "S",
      cwd: "/p",
      firstPrompt: "init",
    });
    const runtime = runtimeManager.getOrCreate("S");
    runtime.loopPromise = Promise.resolve();
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
      applyFlagSettings: vi.fn(async () => {}),
    };
    // bridge stays null — pure session, no CCR mirror.
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-pure",
        sessionId: "S",
        model: "claude-opus-4-7",
      },
      ctx,
    );
    // No throw, runtime model still updated, response succeeds.
    expect(runtime.currentModel).toBe("claude-opus-4-7");
    expect(sent.at(-1)).toMatchObject({
      type: "setSessionSelection.response",
    });
  });

  it("#17 setSessionSelection with model=undefined resets runtime.currentModel to null", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.createSessionFromPrompt({
      cliSessionId: "S",
      cwd: "/p",
      firstPrompt: "init",
      model: "claude-opus-4-7",
    });
    const runtime = runtimeManager.getOrCreate("S"); // seeded with claude-opus-4-7
    runtime.loopPromise = Promise.resolve();
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
      applyFlagSettings: vi.fn(async () => {}),
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-reset",
        sessionId: "S",
      },
      ctx,
    );
    expect(runtime.currentModel).toBeNull();
  });

  it("no-op when model is omitted (defensive — iOS shouldn't fire this)", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const applyFlagMock = vi.fn(async () => {});
    const runtime = runtimeManager.getOrCreate("S");
    runtime.loopPromise = Promise.resolve();
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
      applyFlagSettings: applyFlagMock,
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-noop",
        sessionId: "S",
      },
      ctx,
    );
    expect(applyFlagMock).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({
      type: "setSessionSelection.response",
      requestId: "ss-noop",
    });
  });

  it("deferred case: no live runtime + no metadata → response succeeds, no state mutation", async () => {
    // Session sidecode never created (an unknown / not-yet-created id).
    // manager.setModel returns false; nothing to apply or persist; the
    // response still goes back ok.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-deferred",
        sessionId: "S",
        model: "claude-opus-4-7",
      },
      ctx,
    );
    expect(runtimeManager.getMetadata("S")).toBeUndefined();
    expect(sent.at(-1)).toMatchObject({
      type: "setSessionSelection.response",
      requestId: "ss-deferred",
    });
  });

  it("apply failure: applyFlagSettings throws → error frame, metadata UNTOUCHED", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.createSessionFromPrompt({
      cliSessionId: "S",
      cwd: "/p",
      firstPrompt: "init",
      model: "old-model",
    });
    const runtime = runtimeManager.getOrCreate("S");
    runtime.loopPromise = Promise.resolve();
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
      applyFlagSettings: vi.fn(async () => {
        throw new Error("model not allowed");
      }),
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-fail",
        sessionId: "S",
        model: "bogus",
      },
      ctx,
    );
    // applyFlagSettings threw BEFORE manager.setModel — cache unchanged.
    expect(runtimeManager.getMetadata("S")?.model).toBe("old-model");
    expect(sent.at(-1)).toMatchObject({
      type: "error",
      requestId: "ss-fail",
      code: "internal",
      message: expect.stringContaining("model not allowed"),
    });
  });

  it("rejected during shutdown → error frame, no apply, no metadata write", async () => {
    const handler = createCommandHandler(
      makeDeps({
        isShuttingDown: () => true,
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "setSessionSelection",
        requestId: "ss-shut",
        sessionId: "S",
        model: "x",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "ss-shut",
      message: expect.stringContaining("shutting down"),
    });
  });
});

describe("createCommandHandler — interrupt", () => {
  it("calls runtime.query.interrupt() and emits turn_canceled to subscribers", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    const interruptMock = vi.fn(async () => {});
    runtime.query = {
      interrupt: interruptMock,
      close: () => {},
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "interrupt", requestId: "int-1", sessionId: "S" },
      ctx,
    );
    expect(interruptMock).toHaveBeenCalledOnce();
    expect(sent).toEqual([{ type: "interrupt.response", requestId: "int-1" }]);
    // turn_canceled landed in the runtime buffer for any subscriber to see.
    const events: EventDelta[] = [];
    runtime.subscribe((e) => events.push(e.payload), 0);
    expect(events).toContainEqual({ kind: "turn_canceled" });
  });

  it("interrupt on a session with no active runtime → silent ack (no-op)", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "interrupt", requestId: "int-orphan", sessionId: "no-such" },
      ctx,
    );
    expect(sent).toEqual([
      { type: "interrupt.response", requestId: "int-orphan" },
    ]);
  });

  it("interrupt error path: query.interrupt() rejects → error frame", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.query = {
      interrupt: vi.fn().mockRejectedValue(new Error("control_lost")),
      close: () => {},
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "interrupt", requestId: "int-fail", sessionId: "S" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "int-fail",
      code: "internal",
      message: expect.stringContaining("control_lost"),
    });
  });
});

describe("createCommandHandler — subscribe with turn-boundary settled cache", () => {
  // These tests cover the race-elimination path added with the turn-
  // boundary refresh refactor. The key invariant: when runtime.settled
  // is populated (because run-query did an in-iterator refresh at the
  // last turn boundary), cold-path subscribe must serve from memory
  // WITHOUT calling deps.getMessages. When settled is null (fresh
  // runtime, or a resumed session whose runtime was torn down), the
  // lazy-init fallback uses deps.getMessages AND memoizes the result for
  // next time.
  it("cold path uses runtime.settled when populated; no JSONL re-read", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    // Simulate: a prior turn already completed and run-query refreshed
    // settled in-memory.
    runtime.addEvent({ kind: "turn_started" }); // cursor=1
    runtime.addEvent({ kind: "turn_completed" }); // cursor=2
    runtime.settled = [
      { type: "user_message", uuid: "u-1", text: "hello" },
      { type: "assistant_message", uuid: "m-1", text: "hi" },
    ];
    runtime.settledCursor = 2;
    runtime.latestUsage = { inputTokens: 100, outputTokens: 50 };

    const getMessages = vi.fn();
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, getMessages }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-warm-mem", sessionId: "S" },
      ctx,
    );

    expect(getMessages).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      cursor: 2,
      recovered: false,
      initialUsage: { inputTokens: 100, outputTokens: 50 },
    });
    expect((sent[0] as { settled: TimelineItem[] }).settled).toEqual([
      { type: "user_message", uuid: "u-1", text: "hello" },
      { type: "assistant_message", uuid: "m-1", text: "hi" },
    ]);
  });

  it("cold path replays buffer events with cursor > settledCursor", async () => {
    // Simulates: turn 1 completed (settled refreshed at cursor=2),
    // turn 2 partially streamed (events 3 + 4 in buffer), client
    // subscribes mid-turn-2. Daemon must return turn-1 settled AND
    // replay events 3, 4 so the client catches up to live.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.addEvent({ kind: "turn_started" }); // cursor=1
    runtime.addEvent({ kind: "turn_completed" }); // cursor=2
    runtime.settled = [
      { type: "assistant_message", uuid: "m-1", text: "turn 1 final" },
    ];
    runtime.settledCursor = 2;
    runtime.addEvent({ kind: "turn_started" }); // cursor=3 — turn 2 begins
    runtime.addEvent({
      kind: "patch_text",
      uuid: "m-2",
      deltaText: "hello",
    }); // cursor=4

    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-mid", sessionId: "S" },
      ctx,
    );

    // Response: settled from cursor=2, current cursor=4.
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      cursor: 4,
    });
    // Replay: events 3, 4 in order (they're > settledCursor=2).
    expect(sent[1]).toMatchObject({ type: "event", cursor: 3 });
    expect(sent[2]).toMatchObject({ type: "event", cursor: 4 });
  });

  it("lazy-init fallback memoizes ONLY when runtime.query is set (active SDK loop)", async () => {
    // Fresh runtime with active SDK loop simulated → first subscribe
    // lazy-inits via deps.getMessages AND memoizes onto runtime.settled
    // because turn-boundary refresh will keep it current. The NEXT
    // subscribe takes the fast in-memory path with zero JSONL re-reads.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S"); // settled stays null
    // Simulate an active SDK loop — turn-boundary refresh would be
    // running, so it's safe to memoize. Just need a non-null value
    // for the gate check; the actual interface methods aren't exercised
    // by this code path.
    runtime.query = {
      interrupt: () => Promise.resolve(),
      close: () => {},
    };
    const fetched = [
      { type: "user_message" as const, uuid: "u-1", text: "lazy hi" },
    ];
    const getMessages = vi.fn().mockResolvedValue({
      items: fetched,
      initialUsage: { inputTokens: 7 },
    });
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, getMessages }),
    );

    // First subscribe — uses fallback.
    const { ctx: ctx1, sent: sent1 } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-lazy-1", sessionId: "S" },
      ctx1,
    );
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect((sent1[0] as { settled: TimelineItem[] }).settled).toEqual(fetched);
    expect(sent1[0]).toMatchObject({
      initialUsage: { inputTokens: 7 },
    });

    // Second subscribe (different connection ctx) — runtime.settled is
    // now memoized, no second getMessages call.
    const { ctx: ctx2, sent: sent2 } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-lazy-2", sessionId: "S" },
      ctx2,
    );
    expect(getMessages).toHaveBeenCalledTimes(1); // unchanged
    expect((sent2[0] as { settled: TimelineItem[] }).settled).toEqual(fetched);
    expect(sent2[0]).toMatchObject({
      initialUsage: { inputTokens: 7 },
    });
  });

  it("does NOT memoize when runtime.query is null (inactive / torn-down loop)", async () => {
    // A runtime whose SDK loop has exited (idle teardown / daemon
    // restart) keeps runtime.query null. Without the memo gate, the
    // first subscribe would cache the JSONL snapshot and serve it
    // forever — even after a later sendPrompt spawns a new loop that
    // appends messages. With the gate: each cold-path subscribe
    // re-reads JSONL so subsequent fresh subscribes see updated content.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.getOrCreate("S"); // query stays null
    const getMessages = vi.fn().mockResolvedValue({
      items: [{ type: "user_message" as const, uuid: "u-1", text: "old" }],
      initialUsage: undefined,
    });
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, getMessages }),
    );

    // First subscribe — fetches via getMessages.
    const { ctx: ctx1 } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "ds-1", sessionId: "S" },
      ctx1,
    );
    expect(getMessages).toHaveBeenCalledTimes(1);

    // Second subscribe — fetches AGAIN, no memoization.
    const { ctx: ctx2 } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "ds-2", sessionId: "S" },
      ctx2,
    );
    expect(getMessages).toHaveBeenCalledTimes(2);
  });
});

describe("createCommandHandler — getGitStatus / subscribeGitStatus / unsubscribeGitStatus", () => {
  // Uses a real GitWatcherRegistry against a tmp non-git directory. The
  // happy snapshot for non-repo dirs is deterministic (`isRepo:false`,
  // all numeric fields zero) so we can assert the wire shape without
  // invoking the `git` binary or fs.watch.
  let cwd: string;
  let registry: GitWatcherRegistry;

  function makeGitDeps() {
    cwd = mkdtempSync(path.join(tmpdir(), "sidecode-router-git-"));
    registry = new GitWatcherRegistry();
    return makeDeps({ gitWatchers: registry });
  }

  function cleanup() {
    registry.disposeAll();
    rmSync(cwd, { recursive: true, force: true });
  }

  it("getGitStatus replies with a non-repo snapshot for a plain directory", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getGitStatus", requestId: "g0", cwd } satisfies Command,
      ctx,
    );
    expect(sent).toEqual([
      {
        type: "getGitStatus.response",
        requestId: "g0",
        cwd,
        status: {
          isRepo: false,
          project: path.basename(cwd),
          branch: null,
          ahead: 0,
          behind: 0,
          insertions: 0,
          deletions: 0,
          isDirty: false,
        },
      },
    ]);
    // Snapshot-only never starts a watcher (no fs.watch leak).
    expect(registry.getOrCreate(cwd).listenerCount()).toBe(0);
    cleanup();
  });

  it("subscribeGitStatus acks WITHOUT an initial snapshot", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g1", cwd } satisfies Command,
      ctx,
    );
    expect(sent).toEqual([
      { type: "subscribeGitStatus.response", requestId: "g1", cwd },
    ]);
    cleanup();
  });

  it("unsubscribe responds even when nothing was subscribed", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "unsubscribeGitStatus",
        requestId: "g2",
        cwd,
      } satisfies Command,
      ctx,
    );
    expect(sent).toEqual([
      { type: "unsubscribeGitStatus.response", requestId: "g2" },
    ]);
    cleanup();
  });

  it("disconnect cleans up the per-conn subscription", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, fireDisconnect } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g3", cwd } satisfies Command,
      ctx,
    );
    const watcher = registry.getOrCreate(cwd);
    expect(watcher.listenerCount()).toBe(1);
    fireDisconnect();
    expect(watcher.listenerCount()).toBe(0);
    cleanup();
  });

  it("re-subscribe on same conn replaces the previous listener", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g4a", cwd } satisfies Command,
      ctx,
    );
    await handler(
      { type: "subscribeGitStatus", requestId: "g4b", cwd } satisfies Command,
      ctx,
    );
    const watcher = registry.getOrCreate(cwd);
    // Two subscribe calls on the same connection should leave exactly
    // one listener attached, not two.
    expect(watcher.listenerCount()).toBe(1);
    cleanup();
  });
});

// ─── Filesystem browser (listDirectory + getFilesystemRoots) ─────────────────

/**
 * Build a fixture directory tree at a fresh tmpdir for browser tests:
 *
 *   <root>/
 *     alpha/                  ← subdirectory (alpha sort tester)
 *     beta/
 *     zebra/                  ← directory; lowercase sort vs Alpha
 *     .hidden/                ← hidden directory
 *     README.md               ← file
 *     .env                    ← hidden file
 *     image.png               ← file (predictable size)
 *
 * Returned helpers let each test populate exactly what it needs.
 */
function makeBrowserFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "router-browser-"));
  for (const dir of ["alpha", "beta", "zebra", ".hidden"]) {
    mkdirSync(path.join(root, dir));
  }
  writeFileSync(path.join(root, "README.md"), "hello\n");
  writeFileSync(path.join(root, ".env"), "SECRET=x\n");
  writeFileSync(path.join(root, "image.png"), "fake-png-bytes");
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("createCommandHandler — listDirectory", () => {
  it("returns only directories by default, sorted alpha case-insensitive", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld1",
          path: root,
        } satisfies Command,
        ctx,
      );
      expect(sent).toHaveLength(1);
      const res = sent[0];
      expect(res.type).toBe("listDirectory.response");
      if (res.type !== "listDirectory.response") throw new Error("type guard");
      expect(res.path).toBe(root);
      expect(res.parent).toBe(path.dirname(root));
      // No files (default includeFiles=false), no hidden (default
      // includeHidden=false); alpha case-insensitive within kind:
      // alpha → beta → zebra.
      expect(res.entries.map((e) => e.name)).toEqual([
        "alpha",
        "beta",
        "zebra",
      ]);
      expect(res.entries.every((e) => e.kind === "directory")).toBe(true);
      // No stats on dir-only entries.
      expect(res.entries.every((e) => e.size === undefined)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("includes hidden entries when includeHidden=true (still no files by default)", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld2",
          path: root,
          includeHidden: true,
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "listDirectory.response")
        throw new Error("expected response");
      // .hidden directory now shown; .env file still filtered by !includeFiles.
      expect(sent[0].entries.map((e) => e.name)).toEqual([
        ".hidden",
        "alpha",
        "beta",
        "zebra",
      ]);
    } finally {
      cleanup();
    }
  });

  it("surfaces files (kind only, no size/modifiedAt in V0) when includeFiles=true", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld3",
          path: root,
          includeFiles: true,
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "listDirectory.response")
        throw new Error("expected response");
      // Dirs first (alpha, beta, zebra), then files (image.png, README.md).
      // .env / .hidden still filtered (no includeHidden).
      expect(sent[0].entries.map((e) => e.name)).toEqual([
        "alpha",
        "beta",
        "zebra",
        "image.png",
        "README.md",
      ]);
      const readme = sent[0].entries.find((e) => e.name === "README.md");
      expect(readme?.kind).toBe("file");
      // V0 deliberately leaves size + modifiedAt undefined; the per-
      // entry stat path is deferred until we know whether we want
      // per-call stat, lazy-on-visible-row, or native bulk-stat.
      expect(readme?.size).toBeUndefined();
      expect(readme?.modifiedAt).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("expands ~ to HOME", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listDirectory", requestId: "ld4", path: "~" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "listDirectory.response")
      throw new Error("expected response");
    // Daemon should have resolved "~" to homedir; echoed path matches.
    expect(sent[0].path).toBe(homedir());
  });

  it("returns not_found error for ENOENT path", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "listDirectory",
        requestId: "ld5",
        path: "/nonexistent-path-for-test-abc123",
      } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "error") throw new Error("expected error frame");
    expect(sent[0].code).toBe("not_found");
    expect(sent[0].requestId).toBe("ld5");
  });

  it("returns not_a_directory error when path is a file", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld6",
          path: path.join(root, "README.md"),
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "error") throw new Error("expected error frame");
      expect(sent[0].code).toBe("not_a_directory");
    } finally {
      cleanup();
    }
  });

  it("reports parent=null at the filesystem root", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listDirectory", requestId: "ld7", path: "/" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "listDirectory.response")
      throw new Error("expected response");
    expect(sent[0].path).toBe("/");
    expect(sent[0].parent).toBeNull();
  });
});

describe("createCommandHandler — getFilesystemRoots", () => {
  function makeSidecodeMeta(
    over: Partial<SidecodeSessionMetadata> = {},
  ): SidecodeSessionMetadata {
    return {
      sessionId: "local_test",
      cliSessionId: "cli-test",
      cwd: "/Users/x/proj",
      originCwd: "/Users/x/proj",
      createdAt: 1700000000000,
      lastActivityAt: 1700000000000,
      isArchived: false,
      title: "t",
      titleSource: "auto",
      permissionMode: "bypassPermissions",
      effort: "xhigh",
      ...over,
    };
  }

  it("returns home/desktop/documents derived from os.homedir", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getFilesystemRoots", requestId: "fr1" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "getFilesystemRoots.response")
      throw new Error("expected response");
    const home = homedir();
    expect(sent[0].home).toBe(home);
    // Desktop/Documents are OPTIONAL by contract: present iff the dir
    // exists on disk (macOS always has both; Linux CI runners have
    // neither). Mirror the handler's existence filter instead of
    // assuming a macOS-shaped $HOME.
    const desktop = path.join(home, "Desktop");
    expect(sent[0].desktop).toBe(existsSync(desktop) ? desktop : undefined);
    const documents = path.join(home, "Documents");
    expect(sent[0].documents).toBe(
      existsSync(documents) ? documents : undefined,
    );
    expect(sent[0].recentCwds).toEqual([]); // no sessions = no recents
  });

  it("aggregates recent cwds from sidecode sessions, deduped, existence-filtered, sorted desc", async () => {
    // Use tmpdir for existing cwds so the existence check actually
    // resolves on the real filesystem.
    const existingA = mkdtempSync(path.join(tmpdir(), "fr-cwdA-"));
    const existingB = mkdtempSync(path.join(tmpdir(), "fr-cwdB-"));
    const staleC = "/Users/nope/this-was-deleted-test-xyz";
    try {
      const handler = createCommandHandler(
        makeDeps({
          listSidecodeSessions: vi.fn().mockReturnValue([
            // Two sessions in the same cwd — dedupes to the LATEST
            // lastActivityAt (900 > 100).
            makeSidecodeMeta({
              cwd: existingA,
              lastActivityAt: 1700000000100,
            }),
            makeSidecodeMeta({
              cwd: existingA,
              lastActivityAt: 1700000000900,
            }),
            makeSidecodeMeta({
              cwd: existingB,
              lastActivityAt: 1700000000500,
            }),
            // Stale path; should be dropped by existence filter.
            makeSidecodeMeta({ cwd: staleC, lastActivityAt: 1700000001000 }),
          ]),
        }),
      );
      const { ctx, sent } = makeCtx();
      await handler(
        { type: "getFilesystemRoots", requestId: "fr2" } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "getFilesystemRoots.response")
        throw new Error("expected response");
      // existingA wins existingB on lastActivityAt (900 > 500); staleC dropped.
      expect(sent[0].recentCwds.map((r) => r.path)).toEqual([
        existingA,
        existingB,
      ]);
      // Dedup keeps the LATER lastActivityAt (900 > 100).
      expect(sent[0].recentCwds[0].lastUsedAt).toBe(
        new Date(1700000000900).toISOString(),
      );
    } finally {
      rmSync(existingA, { recursive: true, force: true });
      rmSync(existingB, { recursive: true, force: true });
    }
  });

  it("caps recentCwds at 10 even when more exist", async () => {
    const cwds: string[] = [];
    for (let i = 0; i < 15; i++) {
      cwds.push(mkdtempSync(path.join(tmpdir(), `fr-cap-${i}-`)));
    }
    try {
      const handler = createCommandHandler(
        makeDeps({
          listSidecodeSessions: vi.fn().mockReturnValue(
            cwds.map((cwd, i) =>
              makeSidecodeMeta({
                cwd,
                lastActivityAt: 1700000000000 + i,
              }),
            ),
          ),
        }),
      );
      const { ctx, sent } = makeCtx();
      await handler(
        { type: "getFilesystemRoots", requestId: "fr3" } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "getFilesystemRoots.response")
        throw new Error("expected response");
      expect(sent[0].recentCwds).toHaveLength(10);
      // Sorted desc means the LAST 10 we inserted come first.
      expect(sent[0].recentCwds[0].path).toBe(cwds[14]);
    } finally {
      for (const c of cwds) rmSync(c, { recursive: true, force: true });
    }
  });
});

describe("createCommandHandler — subscribeSessions (#17)", () => {
  it("returns the manager's initial snapshot on response.initial", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    // Pre-create a runtime so getAllSessionStates has memory entries.
    // currentModel is a plain mirror field (no runtime-level setter) —
    // set it directly the way the manager does.
    const r = runtimeManager.getOrCreate("seed-1");
    r.currentModel = "claude-opus-4-7";
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();

    await handler(
      { type: "subscribeSessions", requestId: "subs-1" } satisfies Command,
      ctx,
    );

    expect(sent).toHaveLength(1);
    const r0 = sent[0];
    if (r0?.type !== "subscribeSessions.response")
      throw new Error("expected subscribeSessions.response");
    expect(r0.requestId).toBe("subs-1");
    expect(r0.initial.map((e) => e.sessionId)).toEqual(["seed-1"]);
    expect(r0.initial[0]?.state.model).toBe("claude-opus-4-7");
  });

  it("fans out session_state_changed envelopes when a runtime activity transitions", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const r = runtimeManager.getOrCreate("S");
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribeSessions", requestId: "subs-1" } satisfies Command,
      ctx,
    );
    // Drop the initial response from the assertion target.
    const before = sent.length;

    r.setActivity("running");
    r.setActivity("idle");

    const newFrames = sent.slice(before);
    expect(newFrames).toHaveLength(2);
    expect(newFrames[0]).toMatchObject({
      type: "session_state_changed",
      sessionId: "S",
    });
    expect(
      (newFrames[0] as { state: { activity: string } }).state.activity,
    ).toBe("running");
    expect(
      (newFrames[1] as { state: { activity: string } }).state.activity,
    ).toBe("idle");
  });

  it("onDisconnect detaches the listener — no more frames after disconnect", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const r = runtimeManager.getOrCreate("S");
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent, fireDisconnect } = makeCtx();
    await handler(
      { type: "subscribeSessions", requestId: "subs-1" } satisfies Command,
      ctx,
    );
    fireDisconnect();
    const before = sent.length;
    r.setActivity("running");
    // No additional frames — listener was removed.
    expect(sent.length).toBe(before);
  });

  it("#17 sendPrompt create-path emits push frames with the picked model verbatim", async () => {
    // Repro for "ios picked Sonnet → detail screen shows default Opus".
    // Verifies the daemon's TWO push frames (createSessionFromPrompt
    // fanout + pushPrompt's setActivity("running") edge) BOTH carry
    // `state.model === cmd.model` end-to-end.
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(false), // new session → create
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx, sent } = makeCtx();
    // Open the subscribeSessions stream before sending the prompt, so
    // the fanout listener is attached when createSessionFromPrompt fires.
    await handler(
      { type: "subscribeSessions", requestId: "subs-0" } satisfies Command,
      ctx,
    );
    const before = sent.length;
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-create",
        sessionId: "new-id",
        text: "first prompt",
        cwd: "/p",
        model: "claude-sonnet-4-6",
      },
      ctx,
    );
    const pushed = sent
      .slice(before)
      .filter((f) => f.type === "session_state_changed");
    // Should be at least the creation push and one activity-edge push.
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    // EVERY push carries the user's picked model — no null/undefined.
    for (const frame of pushed) {
      if (frame.type !== "session_state_changed")
        throw new Error("filter invariant violated");
      expect(frame.state.model).toBe("claude-sonnet-4-6");
    }
  });

  it("re-subscribe on the same peer replaces the previous listener (no double-deliver)", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const r = runtimeManager.getOrCreate("S");
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribeSessions", requestId: "subs-1" } satisfies Command,
      ctx,
    );
    await handler(
      { type: "subscribeSessions", requestId: "subs-2" } satisfies Command,
      ctx,
    );
    const before = sent.length;
    r.setActivity("running");
    const newFrames = sent.slice(before);
    // Exactly one fanout — the second subscribe replaced the first.
    expect(newFrames).toHaveLength(1);
  });
});

// ─── CCR upgrade / downgrade (bridgeSession / unbridgeSession / create-bridged) ──

function fakeBridge() {
  return {
    attach: vi.fn(async () => ({})),
    upgrade: vi.fn(async () => ({})),
    unbridge: vi.fn(async () => {}),
  };
}
type BridgeDep = NonNullable<
  Parameters<typeof createCommandHandler>[0]["bridgeService"]
>;
const asBridge = (b: ReturnType<typeof fakeBridge>): BridgeDep =>
  b as unknown as BridgeDep;

describe("createCommandHandler — bridgeSession (CCR upgrade)", () => {
  it("idle session → calls bridgeService.upgrade with the session's metadata + replies response", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.createSessionFromPrompt({
      cliSessionId: "s1",
      cwd: "/w",
      firstPrompt: "hello there",
      model: "claude-opus-4-7",
    });
    const bridge = fakeBridge();
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, bridgeService: asBridge(bridge) }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "bridgeSession",
        requestId: "br-1",
        sessionId: "s1",
      } satisfies Command,
      ctx,
    );
    expect(bridge.upgrade).toHaveBeenCalledWith(
      "s1",
      expect.anything(),
      expect.objectContaining({ cwd: "/w", model: "claude-opus-4-7" }),
    );
    expect(sent.at(-1)).toEqual({
      type: "bridgeSession.response",
      requestId: "br-1",
    });
  });

  it("rejects (unsupported) while a turn is running — does NOT call upgrade", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    runtimeManager.createSessionFromPrompt({
      cliSessionId: "s1",
      cwd: "/w",
      firstPrompt: "hi",
    });
    runtimeManager.getOrCreate("s1").setActivity("running");
    const bridge = fakeBridge();
    const handler = createCommandHandler(
      makeDeps({ runtimeManager, bridgeService: asBridge(bridge) }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "bridgeSession",
        requestId: "br-2",
        sessionId: "s1",
      } satisfies Command,
      ctx,
    );
    expect(bridge.upgrade).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "unsupported" });
  });

  it("replies unsupported when the daemon has no bridgeService", async () => {
    const handler = createCommandHandler(makeDeps()); // no bridgeService
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "bridgeSession",
        requestId: "br-3",
        sessionId: "s1",
      } satisfies Command,
      ctx,
    );
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "unsupported" });
  });

  it("replies session_not_found when the session is unknown", async () => {
    const bridge = fakeBridge();
    const handler = createCommandHandler(
      makeDeps({ bridgeService: asBridge(bridge) }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "bridgeSession",
        requestId: "br-4",
        sessionId: "ghost",
      } satisfies Command,
      ctx,
    );
    expect(bridge.upgrade).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({
      type: "error",
      code: "session_not_found",
    });
  });
});

describe("createCommandHandler — unbridgeSession (CCR downgrade)", () => {
  it("calls bridgeService.unbridge + replies response", async () => {
    const bridge = fakeBridge();
    const handler = createCommandHandler(
      makeDeps({ bridgeService: asBridge(bridge) }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "unbridgeSession",
        requestId: "un-1",
        sessionId: "s1",
      } satisfies Command,
      ctx,
    );
    expect(bridge.unbridge).toHaveBeenCalledWith("s1");
    expect(sent.at(-1)).toEqual({
      type: "unbridgeSession.response",
      requestId: "un-1",
    });
  });

  it("replies unsupported when the daemon has no bridgeService", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "unbridgeSession",
        requestId: "un-2",
        sessionId: "s1",
      } satisfies Command,
      ctx,
    );
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "unsupported" });
  });
});

describe("createCommandHandler — create-bridged (sendPrompt + bridged)", () => {
  it("create path with bridged:true → attaches the bridge before the turn", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const bridge = fakeBridge();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(false),
        queryFactory: emptyQueryFactory(),
        bridgeService: asBridge(bridge),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "cb-1",
        sessionId: "new-b",
        text: "first message",
        cwd: "/w",
        bridged: true,
      } satisfies Command,
      ctx,
    );
    expect(bridge.attach).toHaveBeenCalledWith(
      "new-b",
      expect.anything(),
      expect.objectContaining({ title: "first message", cwd: "/w" }),
    );
    expect(sent.at(-1)).toEqual({
      type: "sendPrompt.response",
      requestId: "cb-1",
    });
  });

  it("does NOT attach a bridge on the resume path even with bridged:true", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const bridge = fakeBridge();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(true), // resume
        queryFactory: emptyQueryFactory(),
        bridgeService: asBridge(bridge),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "cb-2",
        sessionId: "existing",
        text: "hi",
        bridged: true,
      } satisfies Command,
      ctx,
    );
    expect(bridge.attach).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({
      type: "sendPrompt.response",
      requestId: "cb-2",
    });
  });
});
