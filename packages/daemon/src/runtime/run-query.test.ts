import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventDelta } from "@thinkite/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ensureSessionLoop,
  extractInboundPrompt,
  pushPrompt,
} from "./run-query.ts";
import { type RuntimeEvent, SessionRuntime } from "./session-runtime.ts";

/**
 * Cheap test seam: build a fake Query that iterates a static array of
 * SDKMessages then exits. Production callers pass the SDK's real
 * `query()`. Casting through `unknown` skips the rest of Query's
 * surface (setModel/setPermissionMode/...) since `ensureSessionLoop`
 * only needs the AsyncGenerator + the runtime's RuntimeQueryHandle slot.
 *
 * The fake ignores the input `prompt` channel — tests don't care that
 * pushed prompts reach the SDK, only that emitted SDK messages produce
 * the right EventDeltas.
 */
function fakeQueryYielding(
  messages: readonly SDKMessage[],
): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return ((_params: unknown) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of messages) yield m;
    }
    const it = gen();
    return Object.assign(it, {
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
    }) as unknown as Query;
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
}

/** Drain a runtime's buffer into a plain payload array for assertions. */
function payloads(runtime: SessionRuntime<EventDelta>): EventDelta[] {
  const events: RuntimeEvent<EventDelta>[] = [];
  runtime.subscribe((e) => events.push(e), 0);
  return events.map((e) => e.payload);
}

/**
 * Fake CCR bridge that records what the query loop forwards. `writes` holds
 * the raw SDKMessages passed to `write`; `sendResultCalls` counts
 * `sendResult`. `throwOnWrite` simulates a flaky transport to prove the
 * mirror's failures are isolated from the pillar (query loop / WebRTC) path.
 */
function fakeBridge(opts: { throwOnWrite?: boolean } = {}) {
  const writes: SDKMessage[] = [];
  const states: string[] = []; // raw reportState calls (pre-dedup)
  let sendResultCalls = 0;
  let closeCalls = 0;
  let checkpointCalls = 0;
  return {
    writes,
    states,
    get sendResultCalls() {
      return sendResultCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    get checkpointCalls() {
      return checkpointCalls;
    },
    write(msg: unknown) {
      if (opts.throwOnWrite) throw new Error("bridge transport down");
      writes.push(msg as SDKMessage);
    },
    sendResult() {
      sendResultCalls++;
    },
    reportState(state: string) {
      states.push(state);
    },
    checkpoint() {
      checkpointCalls++;
    },
    close() {
      closeCalls++;
    },
  };
}

// ─── Stream event scaffolding ────────────────────────────────────────

function messageStart(messageId: string): SDKMessage {
  return {
    type: "stream_event",
    uuid: `env-${messageId}-start`,
    session_id: "s",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: messageId } },
  } as unknown as SDKMessage;
}

function messageStop(): SDKMessage {
  return {
    type: "stream_event",
    uuid: "env-stop",
    session_id: "s",
    parent_tool_use_id: null,
    event: { type: "message_stop" },
  } as unknown as SDKMessage;
}

function contentBlockStartText(index: number): SDKMessage {
  return {
    type: "stream_event",
    uuid: `env-cbs-text-${index}`,
    session_id: "s",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
  } as unknown as SDKMessage;
}

function contentBlockDeltaText(index: number, text: string): SDKMessage {
  return {
    type: "stream_event",
    uuid: `env-cbd-text-${index}`,
    session_id: "s",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  } as unknown as SDKMessage;
}

function contentBlockDeltaInputJson(
  index: number,
  partial: string,
): SDKMessage {
  return {
    type: "stream_event",
    uuid: `env-cbd-input-${index}`,
    session_id: "s",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partial },
    },
  } as unknown as SDKMessage;
}

function assistantEnvelope(
  toolUses: Array<{
    id: string;
    name: string;
    input: unknown;
  }>,
): SDKMessage {
  return {
    type: "assistant",
    uuid: `env-asst-${toolUses.map((t) => t.id).join(",")}`,
    session_id: "s",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      content: toolUses.map((t) => ({
        type: "tool_use",
        id: t.id,
        name: t.name,
        input: t.input,
      })),
    },
  } as unknown as SDKMessage;
}

function userToolResult(
  toolUseId: string,
  content: unknown,
  isError = false,
): SDKMessage {
  return {
    type: "user",
    uuid: `env-user-${toolUseId}`,
    session_id: "s",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  } as unknown as SDKMessage;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("ensureSessionLoop — text streaming", () => {
  it("appends an assistant_message on first text content_block_start, then patches with deltas", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        messageStart("msg_1"),
        contentBlockStartText(0),
        contentBlockDeltaText(0, "Hello"),
        contentBlockDeltaText(0, ", "),
        contentBlockDeltaText(0, "world"),
        messageStop(),
      ]),
    });
    expect(payloads(runtime)).toEqual([
      {
        kind: "append",
        item: { type: "assistant_message", uuid: "msg_1:0", text: "" },
      },
      { kind: "patch_text", uuid: "msg_1:0", deltaText: "Hello" },
      { kind: "patch_text", uuid: "msg_1:0", deltaText: ", " },
      { kind: "patch_text", uuid: "msg_1:0", deltaText: "world" },
    ]);
  });

  it("supports multiple text content blocks in one message (different uuids per index)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        messageStart("msg_X"),
        contentBlockStartText(0),
        contentBlockDeltaText(0, "first"),
        contentBlockStartText(1),
        contentBlockDeltaText(1, "second"),
        messageStop(),
      ]),
    });
    const out = payloads(runtime);
    const uuids = out.map((e) =>
      e.kind === "append" && e.item.type === "assistant_message"
        ? e.item.uuid
        : e.kind === "patch_text"
          ? e.uuid
          : null,
    );
    expect(uuids).toEqual(["msg_X:0", "msg_X:0", "msg_X:1", "msg_X:1"]);
  });

  it("ignores input_json_delta (V0 doesn't stream tool input partials)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        messageStart("msg_1"),
        contentBlockDeltaInputJson(0, '{"command":"ls'),
        contentBlockDeltaInputJson(0, '"}'),
        messageStop(),
      ]),
    });
    expect(payloads(runtime)).toEqual([]);
  });

  it("text_delta before message_start is ignored (no currentMessageId yet)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        contentBlockStartText(0),
        contentBlockDeltaText(0, "stray"),
      ]),
    });
    expect(payloads(runtime)).toEqual([]);
  });
});

describe("ensureSessionLoop — tool_use append", () => {
  it("appends a running tool_call with detail built from input on assistant envelope", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          {
            id: "tu_1",
            name: "Bash",
            input: { command: "ls", description: "List files" },
          },
        ]),
      ]),
    });
    const out = payloads(runtime);
    expect(out).toHaveLength(1);
    const ev = out[0];
    if (ev?.kind !== "append") throw new Error("expected append");
    if (ev.item.type !== "tool_call")
      throw new Error("expected tool_call item");
    expect(ev.item.callId).toBe("tu_1");
    expect(ev.item.name).toBe("Bash");
    expect(ev.item.status).toBe("running");
    expect(ev.item.summary).toBe("List files");
    if (ev.item.detail.type !== "bash") throw new Error("expected bash detail");
    expect(ev.item.detail.command).toBe("ls");
    expect(ev.item.detail.output).toBe("");
  });

  it("does not duplicate the append if the same tool_use_id appears in two assistant envelopes", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          { id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]),
        assistantEnvelope([
          { id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]),
      ]),
    });
    expect(payloads(runtime)).toHaveLength(1);
  });
});

describe("ensureSessionLoop — tool_result patch", () => {
  it("emits patch_tool_call (completed) with output slotted into detail.output", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          { id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]),
        userToolResult("tu_1", "file1\nfile2\n"),
      ]),
    });
    const out = payloads(runtime);
    expect(out).toHaveLength(2);
    const patch = out[1];
    if (patch?.kind !== "patch_tool_call") throw new Error("expected patch");
    expect(patch.callId).toBe("tu_1");
    expect(patch.status).toBe("completed");
    expect(patch.error).toBeNull();
    if (patch.detail.type !== "bash") throw new Error("expected bash detail");
    expect(patch.detail.output).toBe("file1\nfile2\n");
  });

  it("emits patch_tool_call (failed) with error text from array-form tool_result.content", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          {
            id: "tu_1",
            name: "Edit",
            input: {
              file_path: "/x.ts",
              old_string: "missing",
              new_string: "x",
            },
          },
        ]),
        userToolResult(
          "tu_1",
          [{ type: "text", text: "String to replace not found in file." }],
          true,
        ),
      ]),
    });
    const out = payloads(runtime);
    const patch = out[1];
    if (patch?.kind !== "patch_tool_call") throw new Error("expected patch");
    expect(patch.status).toBe("failed");
    expect(patch.error).toBe("String to replace not found in file.");
  });

  it("drops orphan tool_results (no prior tool_use append for that id)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([userToolResult("tu_orphan", "...")]),
    });
    expect(payloads(runtime)).toEqual([]);
  });
});

describe("ensureSessionLoop — lifecycle", () => {
  it("clears runtime.query, inputChannel, loopPromise after the iterator completes", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    expect(runtime.query).toBeNull();
    expect(runtime.inputChannel).toBeNull();
    expect(runtime.loopPromise).toBeNull();
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([messageStart("msg_1"), messageStop()]),
    });
    expect(runtime.query).toBeNull();
    expect(runtime.inputChannel).toBeNull();
    expect(runtime.loopPromise).toBeNull();
  });

  it("create mode seeds settled=[] (cursor 0) so the first subscribe is race-free", async () => {
    const runtime = new SessionRuntime<EventDelta>("s-create");
    // Don't await — the seed is set synchronously, before the (empty) loop
    // drains and the finally clears settled back to null. This is the state
    // the first subscribe reads.
    const loop = ensureSessionLoop(runtime, {
      mode: "create",
      cwd: "/x",
      queryFactory: fakeQueryYielding([]),
    });
    expect(runtime.settled).toEqual([]);
    expect(runtime.settledCursor).toBe(0);
    await loop; // drain + clean up
  });

  it("resume mode does NOT seed settled (stays null → JSONL cold-path)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s-resume");
    const loop = ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([]),
    });
    expect(runtime.settled).toBeNull();
    await loop;
  });

  it("iterator errors → turn_failed EventDelta + runtime state cleared", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    // Hand-rolled async iterator whose `next()` rejects — biome's `useYield`
    // would flag a `function*` body that never yields, and "yield then
    // throw" doesn't trigger the runtime's catch path the way "throw on
    // first .next()" does.
    const factory = (() => {
      const it: AsyncIterator<SDKMessage, void> & AsyncIterable<SDKMessage> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          return Promise.reject(new Error("boom"));
        },
        async return() {
          return { value: undefined, done: true };
        },
        async throw(err) {
          throw err;
        },
      };
      return Object.assign(it, {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    // No throw to caller — error surfaces as a turn_failed EventDelta in
    // the buffer (G3 replacement for F2's swallow).
    await ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    expect(payloads(runtime)).toEqual([{ kind: "turn_failed", error: "boom" }]);
    expect(runtime.query).toBeNull();
    expect(runtime.inputChannel).toBeNull();
    expect(runtime.loopPromise).toBeNull();
  });

  it("is idempotent — second call returns the existing loop promise without creating a new query", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    let queryCreations = 0;
    const factory = ((_params: unknown) => {
      queryCreations++;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Stays open until manually drained — simulates a real long-lived query.
        yield messageStart("msg_1");
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;

    const p1 = ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    const p2 = ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    expect(p1).toBe(p2);
    expect(queryCreations).toBe(1);
    await p1;
  });

  it("populates runtime.query and inputChannel synchronously before returning the promise", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Empty — yields nothing.
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    // Set synchronously before any microtask runs.
    expect(runtime.query).not.toBeNull();
    expect(runtime.inputChannel).not.toBeNull();
    expect(runtime.loopPromise).not.toBeNull();
  });
});

describe("pushPrompt", () => {
  it("throws if no loop is active", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    expect(() => pushPrompt(runtime, "hi")).toThrow(/no active loop/);
  });

  it("pushes onto the active inputChannel after ensureSessionLoop", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Empty — keeps inputChannel alive synchronously.
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    // Just asserting it doesn't throw — actual SDK side wiring is verified
    // by the streaming + tool tests above (which yield synthesized SDK
    // messages back through the consumer loop).
    expect(() => pushPrompt(runtime, "hi")).not.toThrow();
  });

  it("emits user_message append + turn_started synchronously, in that order", () => {
    // SDK's iterator never echoes the user prompt back — daemon synthesizes
    // the user_message append so iOS's pure event-driven render sees it
    // without needing client-side optimistic state.
    const runtime = new SessionRuntime<EventDelta>("s1");
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    pushPrompt(runtime, "hi");
    // After pushPrompt: cursor=2 (user_message at 1, turn_started at 2).
    expect(runtime.currentCursor).toBe(2);
    const out = payloads(runtime);
    expect(out).toHaveLength(2);
    const first = out[0];
    if (first?.kind !== "append") throw new Error("expected append");
    if (first.item.type !== "user_message") {
      throw new Error("expected user_message item");
    }
    expect(first.item.text).toBe("hi");
    expect(typeof first.item.uuid).toBe("string");
    expect(out[1]).toEqual({ kind: "turn_started" });
  });

  it("reuses a client-supplied userMessageUuid for the synthesized append", () => {
    // iOS optimistically inserts the bubble under this uuid; the daemon
    // must reuse it (not mint its own) so the synced append dedupes against
    // the optimistic insert by key — no double bubble.
    const runtime = new SessionRuntime<EventDelta>("s1");
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    pushPrompt(runtime, "hi", undefined, "client-uuid-123");
    const first = payloads(runtime)[0];
    if (first?.kind !== "append" || first.item.type !== "user_message") {
      throw new Error("expected user_message append");
    }
    expect(first.item.uuid).toBe("client-uuid-123");
  });

  it("mints a fresh uuid when no userMessageUuid is supplied (new-session path)", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    pushPrompt(runtime, "hi");
    const first = payloads(runtime)[0];
    if (first?.kind !== "append" || first.item.type !== "user_message") {
      throw new Error("expected user_message append");
    }
    expect(first.item.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("ensureSessionLoop — turn lifecycle from SDK envelopes", () => {
  function resultEnvelope(
    usage?: Record<string, number | undefined>,
  ): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      uuid: "env-result",
      session_id: "s",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      result: "ok",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      modelUsage: {},
      permission_denials: [],
      usage,
    } as unknown as SDKMessage;
  }

  function errorResultEnvelope(errors: string[]): SDKMessage {
    return {
      type: "result",
      subtype: "error_during_execution",
      uuid: "env-result-err",
      session_id: "s",
      errors,
    } as unknown as SDKMessage;
  }

  it("SDK `result` envelope → turn_completed with usage parsed", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        resultEnvelope({
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        }),
      ]),
    });
    expect(payloads(runtime)).toEqual([
      {
        kind: "turn_completed",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5,
        },
      },
    ]);
  });

  it("`result` envelope without usage → turn_completed with usage=undefined", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([resultEnvelope(undefined)]),
    });
    expect(payloads(runtime)).toEqual([
      { kind: "turn_completed", usage: undefined },
    ]);
  });

  it("`result` envelope with partial usage → only known fields populate", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        resultEnvelope({ input_tokens: 100 }), // only input_tokens
      ]),
    });
    const evts = payloads(runtime);
    expect(evts).toHaveLength(1);
    if (evts[0]?.kind !== "turn_completed")
      throw new Error("expected turn_completed");
    expect(evts[0].usage).toEqual({
      inputTokens: 100,
      outputTokens: undefined,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    });
  });

  it("error `result` envelope → turn_failed with errors joined", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([errorResultEnvelope(["boom"])]),
    });
    expect(payloads(runtime)).toEqual([{ kind: "turn_failed", error: "boom" }]);
  });

  it("interrupted turn's error `result` is swallowed (no turn_failed)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    // The interrupt RPC sets this before query.interrupt(); the SDK then
    // ends the turn with error_during_execution, which must NOT become a
    // turn_failed (the router already emitted turn_canceled).
    runtime.interrupted = true;
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        errorResultEnvelope([
          "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
        ]),
      ]),
    });
    expect(payloads(runtime).map((p) => p.kind)).not.toContain("turn_failed");
    expect(runtime.interrupted).toBe(false);
  });
});

describe("M3.7 idle-teardown wiring", () => {
  function resultEnvelope(): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      uuid: "env-result",
      session_id: "s",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      result: "ok",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      modelUsage: {},
      permission_denials: [],
    } as unknown as SDKMessage;
  }

  /** Build a runtime with an injected synchronous timer. The injected
   *  setTimer captures the callback so tests can fire it manually instead
   *  of waiting real time. `fire()` invokes the latest captured callback. */
  function runtimeWithMockedTimer() {
    let lastCb: (() => void) | undefined;
    let lastDelay: number | undefined;
    let cleared = 0;
    const setTimer = vi.fn(((cb: () => void, ms: number) => {
      lastCb = cb;
      lastDelay = ms;
      return Symbol("h") as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearTimer = vi.fn(((_h: ReturnType<typeof setTimeout>) => {
      cleared++;
    }) as unknown as typeof clearTimeout);
    const runtime = new SessionRuntime<EventDelta>("s1", {
      setTimer: setTimer as unknown as typeof setTimeout,
      clearTimer: clearTimer as unknown as typeof clearTimeout,
    });
    return {
      runtime,
      setTimer,
      get clearCount() {
        return cleared;
      },
      get lastDelay() {
        return lastDelay;
      },
      fire() {
        if (lastCb === undefined) throw new Error("no timer armed");
        lastCb();
      },
    };
  }

  it("result envelope stamps lastActivityAt + arms teardown timer (15min)", async () => {
    const harness = runtimeWithMockedTimer();
    const before = Date.now();
    await ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([resultEnvelope()]),
    });
    expect(harness.runtime.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(harness.lastDelay).toBe(15 * 60_000);
  });

  it("M3.7.4 — pushPrompt cancels a pending teardown timer (turn-complete then user sendPrompt = cancel via markActivity)", async () => {
    const harness = runtimeWithMockedTimer();
    // First turn: result envelope arms the timer.
    let secondPushReady = false;
    const factory = ((_p: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield resultEnvelope();
        // Stay open so the loop is alive when we push the next prompt.
        while (!secondPushReady) {
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(() => {
          secondPushReady = true;
        }),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;

    const loop = ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    // Wait for the result envelope to be consumed (arms timer via markActivity("idle"))
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.runtime.hasTeardownTimerArmed).toBe(true);
    expect(harness.runtime.activity).toBe("idle");
    const clearedBefore = harness.clearCount;

    // User sends a new prompt → pushPrompt fires markActivity("running")
    // → cancels the armed teardown timer.
    pushPrompt(harness.runtime, "second turn");

    expect(harness.clearCount).toBeGreaterThan(clearedBefore);
    expect(harness.runtime.hasTeardownTimerArmed).toBe(false);
    expect(harness.runtime.activity).toBe("running");

    // Drain — let the loop wind down.
    secondPushReady = true;
    harness.runtime.query?.close();
    await loop;
  });

  it("M3.7.4 — SDK autonomous yield (forwardToBridge first frame) cancels a pending teardown timer", async () => {
    // The gap the M3.7.4 helper was designed to close: turn N completes,
    // timer is armed for 15min, then the SDK autonomously yields a NEW
    // message_start (scheduled task, hook response, async background work)
    // BEFORE the next user prompt. Without the cancel in forwardToBridge's
    // first-model-frame branch, the timer would fire mid-autonomous-turn
    // and kill live work.
    const harness = runtimeWithMockedTimer();
    await ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        // Turn 1: complete → arm timer
        resultEnvelope(),
        // Turn 2 (autonomous, no user prompt): first model frame should
        // cancel the timer via markActivity("running") in forwardToBridge.
        messageStart("msg_auto"),
        contentBlockStartText(0),
        contentBlockDeltaText(0, "autonomous work"),
        messageStop(),
      ]),
    });
    // Final state after autonomous work: NO pending timer (canceled by the
    // first frame), no result envelope to re-arm it. The runtime is mid-
    // turn from the SDK's POV (activity = "running") even though we ran
    // out of mock messages.
    expect(harness.runtime.hasTeardownTimerArmed).toBe(false);
    expect(harness.runtime.activity).toBe("running");
  });

  it("timer fire disposes the SDK query (nulls slots, calls close)", async () => {
    const harness = runtimeWithMockedTimer();
    const closeSpy = vi.fn();
    const factory = ((_params: unknown) => {
      // Long-running iterator — only yields the result then waits.
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield resultEnvelope();
        // Stay "open" — finally tests respawn race separately.
        await new Promise<void>(() => {}); // never resolve
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: closeSpy,
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;

    const loop = ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    // Yield to microtask so the result envelope is consumed + timer armed.
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.runtime.hasTeardownTimerArmed).toBe(true);
    expect(harness.runtime.query).not.toBeNull();

    // Fire the teardown timer.
    harness.fire();

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(harness.runtime.query).toBeNull();
    expect(harness.runtime.inputChannel).toBeNull();
    expect(harness.runtime.loopPromise).toBeNull();
    // Avoid hanging the test on the never-resolve iterator.
    void loop;
  });

  it("identity-guarded finally — disposed loop's finally is no-op when a new loop has spawned (no state-trash)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");

    // Spawn loop A with a never-yielding iterator.
    let queryASignaled = false;
    const factoryA = ((_p: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // wait for signal to end
        while (!queryASignaled) {
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(() => {
          queryASignaled = true; // disposeQuery → close → iterator ends
        }),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;

    const loopA = ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: factoryA,
    });
    const queryA = runtime.query;
    expect(queryA).not.toBeNull();

    // Synchronously dispose (simulates timer fire mid-loop) — claims slots.
    runtime.disposeQuery();
    expect(runtime.query).toBeNull();

    // Immediately spawn loop B — should succeed and own the slots.
    const loopB = ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([resultEnvelope()]),
    });
    const queryB = runtime.query;
    expect(queryB).not.toBeNull();
    expect(queryB).not.toBe(queryA);

    // Wait for loop B to drain (it ends after one envelope).
    await loopB;
    // And loop A drains (its `close()` was triggered by disposeQuery).
    await loopA;

    // KEY ASSERTION: after BOTH loops have drained, loop A's finally MUST
    // NOT have cleared loop B's state (which finished normally and cleared
    // itself). runtime should be cleanly post-loopB-completion: all null.
    expect(runtime.query).toBeNull();
    expect(runtime.inputChannel).toBeNull();
    expect(runtime.loopPromise).toBeNull();
  });

  it("integration: turn-complete → 15min idle → fire → next sendPrompt respawns fresh", async () => {
    const harness = runtimeWithMockedTimer();
    let factoryCalls = 0;
    const factory = ((_p: unknown) => {
      factoryCalls++;
      // Each call yields one result envelope + ends.
      return Object.assign(
        (async function* () {
          yield resultEnvelope();
        })(),
        {
          interrupt: vi.fn(async () => {}),
          close: vi.fn(),
        },
      ) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;

    // Turn 1.
    await ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    expect(factoryCalls).toBe(1);
    expect(harness.runtime.hasTeardownTimerArmed).toBe(true);

    // Simulate 15min passing → timer fires.
    harness.fire();
    expect(harness.runtime.query).toBeNull();

    // Turn 2 (after idle teardown) → fresh spawn.
    await ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    expect(factoryCalls).toBe(2); // new SDK process
    expect(harness.runtime.hasTeardownTimerArmed).toBe(true); // re-armed
  });

  it("error result envelope ALSO arms the timer (any terminal envelope counts as turn-complete)", async () => {
    const harness = runtimeWithMockedTimer();
    await ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        {
          type: "result",
          subtype: "error_during_execution",
          uuid: "env-err",
          session_id: "s",
          errors: ["boom"],
        } as unknown as SDKMessage,
      ]),
    });
    // Timer armed (15min) regardless of success vs error subtype.
    expect(harness.lastDelay).toBe(15 * 60_000);
  });

  // ─── M3.7.5 subscriber gate — Claude Desktop parity ──────────────────

  it("M3.7.5 subscriber present at turn-complete BLOCKS teardown arm (watching = keep warm)", async () => {
    const harness = runtimeWithMockedTimer();
    harness.runtime.subscribe(() => {}); // iOS watching

    await ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([resultEnvelope()]),
    });
    // setActivity('idle') runs but armIfEligibleForTeardown gates out on
    // subs.size > 0 — timer never armed.
    expect(harness.runtime.hasTeardownTimerArmed).toBe(false);
    expect(harness.runtime.activity).toBe("idle");
  });

  it("M3.7.5 sub joining mid-idle cancels armed timer (user came back to look)", async () => {
    const harness = runtimeWithMockedTimer();
    await ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([resultEnvelope()]),
    });
    expect(harness.runtime.hasTeardownTimerArmed).toBe(true);

    // iOS opens session detail screen → subscribes → cancels teardown.
    harness.runtime.subscribe(() => {});
    expect(harness.runtime.hasTeardownTimerArmed).toBe(false);
  });

  it("M3.7.5 sub leaving with idle session ARMS the timer (user closed iOS app)", async () => {
    const harness = runtimeWithMockedTimer();
    const unsub = harness.runtime.subscribe(() => {});

    // Long-lived factory: yields the result envelope but the iterator
    // stays awaiting more messages (production behavior — streaming-input
    // mode keeps the SDK process alive between turns). This is what makes
    // `runtime.query` survive the result envelope so the eligibility
    // predicate at unsubscribe-time sees query !== null.
    const factory = ((_p: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield resultEnvelope();
        await new Promise<void>(() => {}); // hold loop open
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;

    const loop = ensureSessionLoop(harness.runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    // Wait for the result envelope to be consumed (sub-gated, no arm).
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.runtime.hasTeardownTimerArmed).toBe(false);
    expect(harness.runtime.query).not.toBeNull(); // still alive

    // User backgrounds iOS / leaves session → sub drops → arm.
    unsub();
    expect(harness.runtime.hasTeardownTimerArmed).toBe(true);
    void loop; // avoid hanging — never-resolve iterator
  });
});

describe("ensureSessionLoop — CCR bridge mirror (M1 write-out)", () => {
  function resultEnvelope(): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      uuid: "env-result",
      session_id: "s",
      result: "ok",
    } as unknown as SDKMessage;
  }

  it("forwards stream_event / assistant / user via write, result via sendResult", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        messageStart("msg_1"),
        contentBlockStartText(0),
        contentBlockDeltaText(0, "hi"),
        assistantEnvelope([
          { id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]),
        userToolResult("tu_1", "out"),
        resultEnvelope(),
      ]),
    });
    // result is NOT in writes (it goes to sendResult); everything else is.
    const types = bridge.writes.map((m) => (m as { type: string }).type);
    expect(types).toEqual([
      "stream_event", // message_start
      "stream_event", // content_block_start
      "stream_event", // content_block_delta
      "assistant",
      "user",
    ]);
    expect(bridge.sendResultCalls).toBe(1);
    // running reported on the first model frame (message_start stream_event),
    // idle reported on result. (fakeBridge records raw calls; dedup is tested
    // in BridgeTransport.) The running fires once here because forwardToBridge
    // only reports running on stream_event/assistant — and the first one is
    // message_start.
    expect(bridge.states[0]).toBe("running");
    expect(bridge.states.at(-1)).toBe("idle");
  });

  it("reports running on the first model frame (stream_event/assistant), idle on result", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          { id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]),
        userToolResult("tu_1", "out"),
        resultEnvelope(),
      ]),
    });
    // assistant → running; user → (no state, already running); result → idle.
    expect(bridge.states).toEqual(["running", "idle"]);
  });

  it("M3.1 — fires bridge.checkpoint() exactly once per turn-complete (result envelope)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([{ id: "tu_1", name: "Bash", input: {} }]),
        userToolResult("tu_1", "ok"),
        resultEnvelope(),
      ]),
    });
    // One checkpoint per result envelope. Stream-events / user / assistant
    // frames must NOT trigger an extra checkpoint (those would mis-advance
    // the seq past an unfinished turn on multi-prompt back-pressure).
    expect(bridge.checkpointCalls).toBe(1);
  });

  it("pushPrompt reports running at prompt-submit (before any model frame)", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    pushPrompt(runtime, "hi");
    // running reported synchronously at submit — matches Claude Code onUserPrompt.
    expect(bridge.states).toEqual(["running"]);
  });

  it("does NOT write the result frame (only sendResult — avoids the double-result spinner gotcha)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([resultEnvelope()]),
    });
    expect(bridge.writes).toHaveLength(0);
    expect(bridge.sendResultCalls).toBe(1);
  });

  it("ignores status / compact_boundary system frames (allowlist, not denylist)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        statusMsg("compacting"),
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 10,
          post_tokens: 1,
        }),
      ]),
    });
    expect(bridge.writes).toHaveLength(0);
    expect(bridge.sendResultCalls).toBe(0);
  });

  it("forwards system/local_command (slash-command echo — source parity with isEligibleBridgeMessage)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    const localCommand = {
      type: "system",
      subtype: "local_command",
      uuid: "env-localcmd",
      session_id: "s",
    } as unknown as SDKMessage;
    // A non-local_command system frame in the same run must NOT forward.
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([localCommand, statusMsg("compacting")]),
    });
    expect(bridge.writes).toHaveLength(1);
    expect((bridge.writes[0] as { subtype: string }).subtype).toBe(
      "local_command",
    );
  });

  it("isolates bridge.write failures from the pillar path (query loop + EventDelta fan-out keep working)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    runtime.bridge = fakeBridge({ throwOnWrite: true });
    // A throwing bridge must NOT surface as turn_failed nor stop processing.
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        messageStart("msg_1"),
        contentBlockStartText(0),
        contentBlockDeltaText(0, "Hello"),
        messageStop(),
      ]),
    });
    // The enriched EventDelta fan-out (the pillar) is unaffected.
    expect(payloads(runtime)).toEqual([
      {
        kind: "append",
        item: { type: "assistant_message", uuid: "msg_1:0", text: "" },
      },
      { kind: "patch_text", uuid: "msg_1:0", deltaText: "Hello" },
    ]);
  });

  it("pure (non-bridged) session: null bridge is a no-op (no crash)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    expect(runtime.bridge).toBeNull();
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([resultEnvelope()]),
    });
    expect(payloads(runtime)).toEqual([
      { kind: "turn_completed", usage: undefined },
    ]);
  });

  it("pushPrompt mirrors the user prompt to the bridge (SDK never echoes it)", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    pushPrompt(runtime, "what is 2+2?", undefined, "u-uuid-1");
    expect(bridge.writes).toHaveLength(1);
    const mirrored = bridge.writes[0] as {
      type: string;
      uuid: string;
      message: {
        role: string;
        content: Array<{ type: string; text?: string }>;
      };
    };
    expect(mirrored.type).toBe("user");
    expect(mirrored.uuid).toBe("u-uuid-1");
    expect(mirrored.message.role).toBe("user");
    expect(mirrored.message.content[0]).toEqual({
      type: "text",
      text: "what is 2+2?",
    });
  });
});

describe("extractInboundPrompt (M2.2 read-in)", () => {
  it("extracts text + uuid from a string-content user message", () => {
    const msg = {
      type: "user",
      uuid: "claude-uuid-1",
      session_id: "cse_x",
      message: { role: "user", content: "hello from claude.ai" },
    };
    expect(extractInboundPrompt(msg)).toEqual({
      text: "hello from claude.ai",
      uuid: "claude-uuid-1",
    });
  });

  it("concatenates text blocks from array content", () => {
    const msg = {
      type: "user",
      uuid: "u-2",
      message: {
        role: "user",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    };
    expect(extractInboundPrompt(msg)).toEqual({
      text: "part one part two",
      uuid: "u-2",
    });
  });

  it("maps image blocks to ImageAttachment (reverse of buildUserMessage)", () => {
    const msg = {
      type: "user",
      uuid: "u-3",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
          { type: "text", text: "what is this?" },
        ],
      },
    };
    expect(extractInboundPrompt(msg)).toEqual({
      text: "what is this?",
      uuid: "u-3",
      images: [{ mediaType: "image/png", data: "AAAA" }],
    });
  });

  it("returns the prompt without uuid when the message has none", () => {
    const msg = {
      type: "user",
      message: { role: "user", content: "no uuid here" },
    };
    expect(extractInboundPrompt(msg)).toEqual({ text: "no uuid here" });
  });

  it("returns null for a non-user message", () => {
    expect(
      extractInboundPrompt({ type: "assistant", message: { content: "x" } }),
    ).toBeNull();
  });

  it("returns null for an empty user message (no text, no images)", () => {
    expect(
      extractInboundPrompt({
        type: "user",
        uuid: "u",
        message: { content: [] },
      }),
    ).toBeNull();
    expect(
      extractInboundPrompt({ type: "user", message: { content: "" } }),
    ).toBeNull();
  });

  it("ignores unknown block types but keeps text/images", () => {
    const msg = {
      type: "user",
      uuid: "u-4",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t", content: "ignored" },
          { type: "text", text: "kept" },
        ],
      },
    };
    expect(extractInboundPrompt(msg)).toEqual({ text: "kept", uuid: "u-4" });
  });

  it("feeds back into pushPrompt — an inbound prompt drives the local loop with the reused uuid", () => {
    // The whole 2.2 point: an extracted inbound prompt is just pushPrompt args.
    // Reusing claude.ai's uuid means the synthesized user_message append (and
    // its bridge write-back) carry that uuid → dedupe-by-uuid fold.
    const runtime = new SessionRuntime<EventDelta>("s1");
    const bridge = fakeBridge();
    runtime.bridge = bridge;
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });

    const prompt = extractInboundPrompt({
      type: "user",
      uuid: "claude-uuid-9",
      message: { role: "user", content: "drive me" },
    });
    if (prompt === null) throw new Error("expected a prompt");
    pushPrompt(runtime, prompt.text, prompt.images, prompt.uuid);

    // Synthesized user_message append reuses the inbound uuid.
    const first = payloads(runtime)[0];
    if (first?.kind !== "append" || first.item.type !== "user_message") {
      throw new Error("expected user_message append");
    }
    expect(first.item.uuid).toBe("claude-uuid-9");
    // The bridge write-back also carries that uuid (folds against claude.ai's).
    const mirrored = bridge.writes[0] as { type: string; uuid: string };
    expect(mirrored.type).toBe("user");
    expect(mirrored.uuid).toBe("claude-uuid-9");
  });
});

describe("ensureSessionLoop — mode parameter passes correct option to SDK", () => {
  it("mode=create passes options.sessionId (not resume)", async () => {
    const runtime = new SessionRuntime<EventDelta>("created-uuid");
    let capturedOptions: unknown;
    const factory = ((params: unknown) => {
      capturedOptions = (params as { options?: unknown }).options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    await ensureSessionLoop(runtime, {
      mode: "create",
      cwd: "/proj",
      queryFactory: factory,
    });
    expect(capturedOptions).toMatchObject({
      sessionId: "created-uuid",
      cwd: "/proj",
      includePartialMessages: true,
      // V0 has no iOS answer UI — the tool is hidden from the model so a
      // turn never blocks on a question the app can't deliver.
      disallowedTools: ["AskUserQuestion"],
    });
    expect((capturedOptions as { resume?: string }).resume).toBeUndefined();
  });

  it("mode=resume passes options.resume (not sessionId)", async () => {
    const runtime = new SessionRuntime<EventDelta>("existing-uuid");
    let capturedOptions: unknown;
    const factory = ((params: unknown) => {
      capturedOptions = (params as { options?: unknown }).options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    expect(capturedOptions).toMatchObject({
      resume: "existing-uuid",
      includePartialMessages: true,
      disallowedTools: ["AskUserQuestion"],
    });
    expect(
      (capturedOptions as { sessionId?: string }).sessionId,
    ).toBeUndefined();
  });
});

// ─── Compact lifecycle (SDK live stream) ────────────────────────────────
// SDKStatusMessage with status='compacting' → compact_started
// SDKCompactBoundaryMessage → compact_applied (+ primes summary lift)
// Following SDKUserMessage → compact_summary append (sequence-detected)

function statusMsg(status: "compacting" | "requesting" | null): SDKMessage {
  return {
    type: "system",
    subtype: "status",
    uuid: `env-status-${status ?? "null"}`,
    session_id: "s",
    status,
  } as unknown as SDKMessage;
}

function compactBoundaryEnvelope(
  uuid: string,
  meta: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    post_tokens: number;
    duration_ms?: number;
    preserved_messages?: { anchor_uuid: string; uuids: string[] };
  },
): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    session_id: "s",
    compact_metadata: meta,
  } as unknown as SDKMessage;
}

function plainUserEnvelope(uuid: string, text: string): SDKMessage {
  return {
    type: "user",
    uuid,
    session_id: "s",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  } as unknown as SDKMessage;
}

describe("ensureSessionLoop — compact lifecycle", () => {
  it("SDKStatusMessage status='compacting' → compact_started", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([statusMsg("compacting")]),
    });
    expect(payloads(runtime)).toEqual([{ kind: "compact_started" }]);
  });

  it("status='requesting' and status=null are ignored (UI noise)", async () => {
    // Only 'compacting' is a UI-relevant signal. 'requesting' fires for
    // every API call and would spam the UI; null is resting state.
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        statusMsg("requesting"),
        statusMsg(null),
      ]),
    });
    expect(payloads(runtime)).toEqual([]);
  });

  it("compact_boundary → compact_applied with metadata fields mapped", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 34000,
          post_tokens: 4000,
          duration_ms: 37000,
        }),
      ]),
    });
    expect(payloads(runtime)).toEqual([
      {
        kind: "compact_applied",
        trigger: "manual",
        preTokens: 34000,
        postTokens: 4000,
        durationMs: 37000,
        uuid: "b-1",
      },
    ]);
  });

  it("compact_boundary with preserved_messages → preservedUuids forwarded", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "auto",
          pre_tokens: 180000,
          post_tokens: 18000,
          preserved_messages: {
            anchor_uuid: "anchor-1",
            uuids: ["keep-1", "keep-2", "keep-3"],
          },
        }),
      ]),
    });
    const ev = payloads(runtime)[0];
    if (ev?.kind !== "compact_applied")
      throw new Error("expected compact_applied");
    expect(ev.preservedUuids).toEqual(["keep-1", "keep-2", "keep-3"]);
  });

  it("compact_boundary without preserved_messages → preservedUuids omitted (full compact)", async () => {
    // The 99% case — manual /compact and auto-compact both go full.
    // iOS reducer treats undefined as "drop everything pre-compact".
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 34000,
          post_tokens: 4000,
        }),
      ]),
    });
    const ev = payloads(runtime)[0];
    if (ev?.kind !== "compact_applied")
      throw new Error("expected compact_applied");
    expect(ev.preservedUuids).toBeUndefined();
  });

  it("the user message immediately following compact_boundary → user_message append (summary lift)", async () => {
    // SDK live type doesn't expose isCompactSummary, so we detect by
    // sequence: the first user msg after a compact_boundary is the
    // SDK-injected summary. Lifted to a regular user_message append so
    // iOS renders it (without the lift it'd be dropped — handleUserEnvelope
    // only processes tool_result blocks on plain text user msgs). Verifies
    // the expectingCompactSummary flag is set + consumed correctly.
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 34000,
          post_tokens: 4000,
        }),
        plainUserEnvelope("s-1", "Summary covering earlier conversation..."),
      ]),
    });
    const evts = payloads(runtime);
    expect(evts).toEqual([
      {
        kind: "compact_applied",
        trigger: "manual",
        preTokens: 34000,
        postTokens: 4000,
        uuid: "b-1",
      },
      {
        kind: "append",
        item: {
          type: "user_message",
          uuid: "s-1",
          text: "Summary covering earlier conversation...",
        },
      },
    ]);
  });

  it("subsequent user msgs after the summary are NOT lifted", async () => {
    // Flag clears on first consume — only ONE summary per boundary.
    // Later user messages flow through the normal tool_result path
    // (which no-ops on plain text user msgs, preventing duplicate
    // rendering of iOS-typed prompts).
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 34000,
          post_tokens: 4000,
        }),
        plainUserEnvelope("s-1", "Summary text"),
        plainUserEnvelope("u-2", "user's next prompt"),
      ]),
    });
    const evts = payloads(runtime);
    // Expect: compact_applied + ONE user_message append (the lifted
    // summary), but NOT a second append for u-2.
    expect(evts.filter((e) => e.kind === "append")).toHaveLength(1);
  });
});
