import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionState } from "@thinkite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSidecodeSession,
  type SidecodeSessionMetadata,
  writeSidecodeSession,
} from "../sidecode-sessions.ts";
import type { RuntimeQueryHandle } from "./session-runtime.ts";
import {
  SessionRuntimeManager,
  type SessionStateListener,
} from "./session-runtime-manager.ts";

/** Helper to build a complete sidecode metadata record for fixture writes. */
function fixtureMeta(
  partial: Partial<SidecodeSessionMetadata> & { cliSessionId: string },
): SidecodeSessionMetadata {
  const now = Date.now();
  return {
    sessionId: `local_${partial.cliSessionId}`,
    cliSessionId: partial.cliSessionId,
    cwd: partial.cwd ?? "/tmp/x",
    originCwd: partial.originCwd ?? partial.cwd ?? "/tmp/x",
    createdAt: partial.createdAt ?? now,
    lastActivityAt: partial.lastActivityAt ?? now,
    isArchived: partial.isArchived ?? false,
    title: partial.title ?? "",
    titleSource: partial.titleSource ?? "auto",
    permissionMode: partial.permissionMode ?? "bypassPermissions",
    effort: "xhigh",
    ...(partial.model !== undefined ? { model: partial.model } : {}),
    ...(partial.bridge !== undefined ? { bridge: partial.bridge } : {}),
  };
}

/** Write a fixture record to disk + bind manager.home so hydration picks
 *  it up. Use when tests need an existing session in BOTH disk and the
 *  manager's in-memory cache. */
function seedExistingSession(
  m: SessionRuntimeManager<string>,
  home: string,
  meta: SidecodeSessionMetadata,
): void {
  writeSidecodeSession(home, meta);
  m.setHome(home);
}

/** Build a listener with onChange spy + an inert onRemove. */
function makeListener(): {
  listener: SessionStateListener;
  onChange: ReturnType<typeof vi.fn>;
  onRemove: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn<(sessionId: string, state: SessionState) => void>();
  const onRemove = vi.fn<(sessionId: string) => void>();
  return {
    listener: { onChange, onRemove },
    onChange,
    onRemove,
  };
}

function fakeQuery(): RuntimeQueryHandle & {
  closeMock: ReturnType<typeof vi.fn>;
} {
  const closeMock = vi.fn();
  return {
    interrupt: async () => {},
    close: closeMock,
    closeMock,
  };
}

describe("SessionRuntimeManager", () => {
  it("getOrCreate creates a new runtime if absent", () => {
    const m = new SessionRuntimeManager<string>();
    expect(m.has("s1")).toBe(false);
    const r = m.getOrCreate("s1");
    expect(r.sessionId).toBe("s1");
    expect(m.has("s1")).toBe(true);
    expect(m.size()).toBe(1);
  });

  it("getOrCreate returns the existing runtime on subsequent calls", () => {
    const m = new SessionRuntimeManager<string>();
    const a = m.getOrCreate("s1");
    a.addEvent("event-on-a");
    const b = m.getOrCreate("s1");
    expect(b).toBe(a);
    expect(b.currentCursor).toBe(1); // state preserved
  });

  it("delete removes; returns true iff it existed", () => {
    const m = new SessionRuntimeManager<string>();
    m.getOrCreate("s1");
    expect(m.delete("s1")).toBe(true);
    expect(m.delete("s1")).toBe(false);
    expect(m.has("s1")).toBe(false);
  });

  it("values() iterates all live runtimes", () => {
    const m = new SessionRuntimeManager<string>();
    m.getOrCreate("a");
    m.getOrCreate("b");
    m.getOrCreate("c");
    const ids = [...m.values()].map((r) => r.sessionId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("default options propagate to lazily-created runtimes", () => {
    const m = new SessionRuntimeManager<string>({ bufferCap: 2 });
    const r = m.getOrCreate("s1");
    r.addEvent("a"); // cursor 1
    r.addEvent("b"); // cursor 2
    r.addEvent("c"); // cursor 3 — "a" evicted by cap=2
    expect(r.oldestCursor).toBe(2);
  });

  it("options passed to getOrCreate override defaults on first creation only", () => {
    const m = new SessionRuntimeManager<string>({ bufferCap: 100 });
    const r = m.getOrCreate("s1", { bufferCap: 1 });
    r.addEvent("a"); // cursor 1
    r.addEvent("b"); // cursor 2 — "a" evicted by cap=1
    expect(r.oldestCursor).toBe(2);

    // Subsequent getOrCreate with different options is ignored.
    const r2 = m.getOrCreate("s1", { bufferCap: 1000 });
    expect(r2).toBe(r);
    r2.addEvent("c"); // cursor 3 — still cap=1
    expect(r2.oldestCursor).toBe(3);
  });
});

describe("SessionRuntimeManager.shutdown", () => {
  it("resolves immediately on an empty manager", async () => {
    const m = new SessionRuntimeManager<string>();
    const start = Date.now();
    await m.shutdown(5000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("calls close() on every runtime's query in parallel", async () => {
    const m = new SessionRuntimeManager<string>();
    const r1 = m.getOrCreate("s1");
    const r2 = m.getOrCreate("s2");
    const r3 = m.getOrCreate("s3");
    const q1 = fakeQuery();
    const q2 = fakeQuery();
    const q3 = fakeQuery();
    r1.query = q1;
    r2.query = q2;
    r3.query = q3;
    // No loopPromise → shutdown skips await (no-op for that runtime).
    await m.shutdown(1000);
    expect(q1.closeMock).toHaveBeenCalledOnce();
    expect(q2.closeMock).toHaveBeenCalledOnce();
    expect(q3.closeMock).toHaveBeenCalledOnce();
  });

  it("awaits each runtime's loopPromise before resolving", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    r.query = fakeQuery();
    let resolved = false;
    r.loopPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 30);
    });
    await m.shutdown(1000);
    expect(resolved).toBe(true);
  });

  it("clears the map after shutdown so subsequent has/get/size show empty", async () => {
    const m = new SessionRuntimeManager<string>();
    m.getOrCreate("s1");
    m.getOrCreate("s2");
    expect(m.size()).toBe(2);
    await m.shutdown(100);
    expect(m.size()).toBe(0);
    expect(m.has("s1")).toBe(false);
    expect(m.get("s2")).toBeUndefined();
  });

  it("does NOT hang when loopPromise never resolves — bounded by timeoutMs", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    r.query = fakeQuery();
    // Promise that never resolves.
    r.loopPromise = new Promise<void>(() => {});
    const start = Date.now();
    await m.shutdown(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // ~50ms timer fired
    expect(elapsed).toBeLessThan(200); // didn't hang
    // Map cleared regardless of timeout.
    expect(m.size()).toBe(0);
  });

  it("tolerates runtime without a query (just buffer state)", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    r.addEvent("event-but-no-query");
    expect(r.query).toBeNull();
    await expect(m.shutdown(100)).resolves.toBeUndefined();
    expect(m.size()).toBe(0);
  });

  it("tolerates runtime without a loopPromise (close fired, no await)", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    const q = fakeQuery();
    r.query = q;
    // loopPromise stays null
    await m.shutdown(100);
    expect(q.closeMock).toHaveBeenCalledOnce();
  });

  it("swallows rejected loopPromise so shutdown still completes", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    r.query = fakeQuery();
    r.loopPromise = Promise.reject(new Error("loop blew up"));
    // Should not throw.
    await expect(m.shutdown(100)).resolves.toBeUndefined();
    expect(m.size()).toBe(0);
  });

  it("swallows close() exceptions per-runtime — others still drained", async () => {
    const m = new SessionRuntimeManager<string>();
    const r1 = m.getOrCreate("s1");
    const r2 = m.getOrCreate("s2");
    r1.query = {
      interrupt: async () => {},
      close: () => {
        throw new Error("close blew up");
      },
    };
    const q2 = fakeQuery();
    r2.query = q2;
    await expect(m.shutdown(100)).resolves.toBeUndefined();
    expect(q2.closeMock).toHaveBeenCalledOnce();
    expect(m.size()).toBe(0);
  });
});

describe("SessionRuntimeManager #17 SessionState fan-out", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-manager-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("getAllSessionStates returns [] on a fresh manager with no home", () => {
    const m = new SessionRuntimeManager<string>();
    expect(m.getAllSessionStates()).toEqual([]);
  });

  it("getAllSessionStates returns disk-only entries when no runtimes exist", () => {
    const m = new SessionRuntimeManager<string>();
    writeSidecodeSession(
      home,
      fixtureMeta({
        cliSessionId: "abc",
        cwd: "/repos/foo",
        title: "first prompt",
        model: "claude-opus-4-7",
        createdAt: 1_000,
        lastActivityAt: 2_000,
      }),
    );
    m.setHome(home); // hydrates from disk
    const states = m.getAllSessionStates();
    expect(states).toHaveLength(1);
    expect(states[0]?.sessionId).toBe("abc");
    expect(states[0]?.state).toMatchObject({
      activity: "idle",
      model: "claude-opus-4-7",
      title: "first prompt",
      cwd: "/repos/foo",
      lastActivityAt: 2_000,
      createdAt: 1_000,
      isArchived: false,
      permissionMode: "bypassPermissions",
    });
  });

  it("getAllSessionStates merges runtime live fields over disk static", () => {
    const m = new SessionRuntimeManager<string>();
    writeSidecodeSession(
      home,
      fixtureMeta({
        cliSessionId: "abc",
        cwd: "/repos/foo",
        title: "stored title",
        model: "stored-model",
        lastActivityAt: 1_000,
      }),
    );
    m.setHome(home);
    const r = m.getOrCreate("abc");
    // Disk seeds currentModel via getOrCreate.
    expect(r.currentModel).toBe("stored-model");
    // Simulate a live activity edge.
    r.setActivity("running");

    const states = m.getAllSessionStates();
    expect(states[0]?.state.activity).toBe("running");
    // Runtime's lastActivityAt is more recent than disk's 1_000.
    expect(states[0]?.state.lastActivityAt).toBeGreaterThan(1_000);
    // Disk still owns title / cwd.
    expect(states[0]?.state.title).toBe("stored title");
    expect(states[0]?.state.cwd).toBe("/repos/foo");
  });

  it("getAllSessionStates includes runtime-only sessions (no disk metadata yet)", () => {
    const m = new SessionRuntimeManager<string>();
    m.setHome(home);
    m.getOrCreate("memory-only");
    const states = m.getAllSessionStates();
    expect(states.map((s) => s.sessionId)).toEqual(["memory-only"]);
    expect(states[0]?.state).toMatchObject({
      activity: "idle",
      title: "",
      cwd: "",
      isArchived: false,
    });
  });

  it("getOrCreate seeds currentModel from disk metadata", () => {
    const m = new SessionRuntimeManager<string>();
    writeSidecodeSession(
      home,
      fixtureMeta({ cliSessionId: "seeded", model: "claude-sonnet-4-6" }),
    );
    m.setHome(home); // hydrate from disk
    const r = m.getOrCreate("seeded");
    expect(r.currentModel).toBe("claude-sonnet-4-6");
  });

  it("getOrCreate seeds lastActivityAt from disk metadata (viewing doesn't fabricate now)", () => {
    const m = new SessionRuntimeManager<string>();
    const past = 1_700_000_000_000; // fixed past timestamp, well before now
    writeSidecodeSession(
      home,
      fixtureMeta({ cliSessionId: "seeded", lastActivityAt: past }),
    );
    m.setHome(home); // hydrate from disk
    const r = m.getOrCreate("seeded");
    // Materializing a runtime just to serve a read-only transcript subscribe
    // must NOT bump lastActivityAt to the constructor's Date.now() — it
    // inherits the persisted timestamp, so a session doesn't jump to the top
    // of the iOS list merely from being viewed.
    expect(r.lastActivityAt).toBe(past);
  });

  it("getOrCreate does NOT seed currentModel when home is unset (memory-only manager)", () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("no-home");
    expect(r.currentModel).toBeNull();
  });

  it("subscribeSessionStates returns initial snapshot + listener fires on activity transition", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(m, home, fixtureMeta({ cliSessionId: "a" }));
    const { listener, onChange } = makeListener();
    const { initial } = m.subscribeSessionStates(listener);
    expect(initial.map((s) => s.sessionId)).toEqual(["a"]);

    const r = m.getOrCreate("a");
    r.setActivity("running");

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toBe("a");
    expect(onChange.mock.calls[0]?.[1].activity).toBe("running");
  });

  it("subscribeSessionStates unsubscribe stops fan-out", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(m, home, fixtureMeta({ cliSessionId: "a" }));
    const { listener, onChange } = makeListener();
    const { unsubscribe } = m.subscribeSessionStates(listener);

    const r = m.getOrCreate("a");
    r.setActivity("running");
    expect(onChange).toHaveBeenCalledOnce();

    unsubscribe();
    r.setActivity("idle");
    // No additional fires after unsubscribe.
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("notifyStateChanged is a no-op when no listeners are attached (zero-cost on inactive)", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(m, home, fixtureMeta({ cliSessionId: "a" }));
    const r = m.getOrCreate("a");
    // No subscribers — these calls should not throw or attempt disk reads
    // (smoke-test for the short-circuit path).
    expect(() => r.setActivity("running")).not.toThrow();
    expect(() => r.setActivity("idle")).not.toThrow();
  });

  // (model fan-out via manager.setModel is covered in the "B: manager
  // .setModel owns model persistence + fan-out" section below; there's no
  // runtime-level setModel to test here anymore.)

  it("multiple listeners all receive the same fan-out", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(m, home, fixtureMeta({ cliSessionId: "a" }));
    const l1 = makeListener();
    const l2 = makeListener();
    m.subscribeSessionStates(l1.listener);
    m.subscribeSessionStates(l2.listener);

    const r = m.getOrCreate("a");
    r.setActivity("running");

    expect(l1.onChange).toHaveBeenCalledOnce();
    expect(l2.onChange).toHaveBeenCalledOnce();
  });

  it("listener exception is isolated — sibling listeners still receive the event", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(m, home, fixtureMeta({ cliSessionId: "a" }));
    const flaky: SessionStateListener = {
      onChange: () => {
        throw new Error("listener exploded");
      },
      onRemove: () => {},
    };
    const good = makeListener();
    m.subscribeSessionStates(flaky);
    m.subscribeSessionStates(good.listener);

    const r = m.getOrCreate("a");
    expect(() => r.setActivity("running")).not.toThrow();
    expect(good.onChange).toHaveBeenCalledOnce();
  });

  it("getOrCreate wires onStateChanged even when caller passes options without it", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(m, home, fixtureMeta({ cliSessionId: "a" }));
    const { listener, onChange } = makeListener();
    m.subscribeSessionStates(listener);

    // Caller passes unrelated options — manager-wired onStateChanged must
    // still fire (caller-supplied onStateChanged is always overridden).
    const r = m.getOrCreate("a", { bufferCap: 10 });
    r.setActivity("running");
    expect(onChange).toHaveBeenCalledOnce();
  });

  // ─── #17.5 lastActivityAt disk persistence ─────────────────────────

  it("#17.5 activity edge advances disk lastActivityAt", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(
      m,
      home,
      fixtureMeta({ cliSessionId: "a", lastActivityAt: 1_000 }),
    );
    const r = m.getOrCreate("a");

    r.setActivity("running"); // runtime stamps a fresh lastActivityAt
    const onDisk = readSidecodeSession(home, "a");
    expect(onDisk?.lastActivityAt).toBeGreaterThan(1_000);
  });

  it("#17.5 activity edge does NOT regress disk lastActivityAt when the cached value is in the future (monotonic guard)", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(
      m,
      home,
      fixtureMeta({ cliSessionId: "a", lastActivityAt: 5_000_000_000_000 }),
    );
    const r = m.getOrCreate("a");
    // setActivity stamps runtime.lastActivityAt = Date.now() (~1.7e12),
    // strictly LESS than the disk's future 5e12. notifyStateChanged's
    // monotonic guard rejects the regression — no disk write.
    r.setActivity("running");

    const onDisk = readSidecodeSession(home, "a");
    expect(onDisk?.lastActivityAt).toBe(5_000_000_000_000); // unchanged
  });

  it("#17.5 fan-out reflects the freshly-persisted lastActivityAt", () => {
    const m = new SessionRuntimeManager<string>();
    seedExistingSession(
      m,
      home,
      fixtureMeta({ cliSessionId: "a", lastActivityAt: 1_000 }),
    );
    const { listener, onChange } = makeListener();
    m.subscribeSessionStates(listener);
    const r = m.getOrCreate("a");
    r.setActivity("running");

    expect(onChange).toHaveBeenCalledOnce();
    const state = onChange.mock.calls[0]?.[1] as SessionState;
    expect(state.activity).toBe("running");
    expect(state.lastActivityAt).toBeGreaterThan(1_000);
  });

  it("#17.5 no-op when home is unset (memory-only manager)", () => {
    const m = new SessionRuntimeManager<string>();
    // No setHome.
    const r = m.getOrCreate("a");
    expect(() => {
      r.setActivity("running");
      r.setActivity("idle");
    }).not.toThrow();
    // No disk file to assert against — just confirms the manager doesn't
    // crash trying to read/write metadata that doesn't apply.
  });

  // ─── Race: subscribe-creates-runtime BEFORE the create lands meta ────
  //
  // Production repro for "iOS picked Sonnet → detail screen reverts to
  // default Opus". The transcript `subscribe` RPC calls getOrCreate and
  // builds the runtime (currentModel=null, no meta yet) WHILE sendPrompt's
  // create path is still awaiting its hasSession check; createSessionFromPrompt
  // then lands meta.model=Sonnet. The runtime mirror stays stale-null — and
  // that is FINE: there's no race-guard anymore. Two invariants keep the
  // model correct: notifyStateChanged no longer diffs/persists model on the
  // setActivity("running") edge (so the stale null can't regress
  // states.model), and buildPublicState falls back to meta.model when
  // currentModel is null (so every fan-out carries the picked model).

  it("activity edge after the race does NOT regress the persisted model", () => {
    const m = new SessionRuntimeManager<string>();
    m.setHome(home);
    const { listener, onChange } = makeListener();
    m.subscribeSessionStates(listener);

    const r = m.getOrCreate("race-2"); // subscribe wins
    m.createSessionFromPrompt({
      cliSessionId: "race-2",
      cwd: "/p",
      firstPrompt: "hi",
      model: "claude-sonnet-4-6",
    });
    // No race-guard: createSession does NOT mirror onto the pre-existing
    // runtime, so the mirror stays stale-null. The model survives anyway
    // (asserted below) via states + buildPublicState's fallback.
    expect(r.currentModel).toBeNull();
    onChange.mockClear(); // ignore the create fan-out; focus on the edge

    r.setActivity("running"); // the edge that used to wipe the model

    // Disk metadata is intact — NOT regressed to undefined.
    expect(m.getMetadata("race-2")?.model).toBe("claude-sonnet-4-6");
    expect(readSidecodeSession(home, "race-2")?.model).toBe(
      "claude-sonnet-4-6",
    );
    // The fan-out push carries the picked model, not null.
    expect(onChange).toHaveBeenCalledOnce();
    const state = onChange.mock.calls[0]?.[1] as SessionState;
    expect(state.activity).toBe("running");
    expect(state.model).toBe("claude-sonnet-4-6");
  });

  it("non-race order (create before getOrCreate) still seeds + holds the model", () => {
    const m = new SessionRuntimeManager<string>();
    m.setHome(home);
    const { listener, onChange } = makeListener();
    m.subscribeSessionStates(listener);

    // create lands meta first, THEN getOrCreate (the normal sendPrompt
    // order when no subscribe raced ahead).
    m.createSessionFromPrompt({
      cliSessionId: "ok-1",
      cwd: "/p",
      firstPrompt: "hi",
      model: "claude-sonnet-4-6",
    });
    const r = m.getOrCreate("ok-1");
    expect(r.currentModel).toBe("claude-sonnet-4-6"); // seeded from meta
    onChange.mockClear();

    r.setActivity("running");
    expect(m.getMetadata("ok-1")?.model).toBe("claude-sonnet-4-6");
    const state = onChange.mock.calls[0]?.[1] as SessionState;
    expect(state.model).toBe("claude-sonnet-4-6");
  });

  // ─── B: manager.setModel owns model persistence + fan-out ───────────
  //
  // notifyStateChanged no longer persists model, so manager.setModel
  // writes states.model + disk explicitly and fans out exactly once
  // (the live runtime's currentModel is mirrored with a direct field
  // set — no onStateChanged, so no double fan-out).

  it("setModel persists the model to disk + fans out once (live runtime)", () => {
    const m = new SessionRuntimeManager<string>();
    m.setHome(home);
    const { listener, onChange } = makeListener();
    m.subscribeSessionStates(listener);
    m.createSessionFromPrompt({
      cliSessionId: "sm-1",
      cwd: "/p",
      firstPrompt: "hi",
      model: "claude-sonnet-4-6",
    });
    const r = m.getOrCreate("sm-1");
    onChange.mockClear();

    const changed = m.setModel("sm-1", "claude-opus-4-7");

    expect(changed).toBe(true);
    expect(r.currentModel).toBe("claude-opus-4-7"); // mirror updated
    expect(m.getMetadata("sm-1")?.model).toBe("claude-opus-4-7");
    expect(readSidecodeSession(home, "sm-1")?.model).toBe("claude-opus-4-7");
    // Exactly one fan-out — direct mirror set, no extra onStateChanged.
    expect(onChange).toHaveBeenCalledOnce();
    const state = onChange.mock.calls[0]?.[1] as SessionState;
    expect(state.model).toBe("claude-opus-4-7");
  });

  it("setModel reset-to-default after the race still fans out (no stale-null gap)", () => {
    const m = new SessionRuntimeManager<string>();
    m.setHome(home);
    const { listener, onChange } = makeListener();
    m.subscribeSessionStates(listener);

    const r = m.getOrCreate("sm-2"); // subscribe wins → currentModel null
    m.createSessionFromPrompt({
      cliSessionId: "sm-2",
      cwd: "/p",
      firstPrompt: "hi",
      model: "claude-sonnet-4-6",
    });
    expect(r.currentModel).toBeNull(); // stale mirror (no guard)
    onChange.mockClear();

    // Reset to SDK default: states.model is Sonnet, the runtime mirror is
    // already null. A direct field set + explicit fan-out covers this —
    // routing through runtime.setModel(null) would dedupe (null===null)
    // and swallow the fan-out, leaving iOS stale.
    const changed = m.setModel("sm-2", undefined);

    expect(changed).toBe(true);
    expect(m.getMetadata("sm-2")?.model).toBeUndefined();
    expect(onChange).toHaveBeenCalledOnce();
    const state = onChange.mock.calls[0]?.[1] as SessionState;
    expect(state.model).toBeNull();
  });
});
