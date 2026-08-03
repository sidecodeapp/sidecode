import type { TimelineItem } from "@thinkite/protocol";
import { describe, expect, it, vi } from "vitest";
import { type RuntimeQueryHandle, SessionRuntime } from "./session-runtime.ts";

describe("SessionRuntime", () => {
  it("addEvent assigns cursors monotonically starting at 1", () => {
    const r = new SessionRuntime<string>("s1");
    expect(r.currentCursor).toBe(0);
    expect(r.oldestCursor).toBeNull();

    const e1 = r.addEvent("a");
    const e2 = r.addEvent("b");
    const e3 = r.addEvent("c");

    expect(e1.cursor).toBe(1);
    expect(e2.cursor).toBe(2);
    expect(e3.cursor).toBe(3);
    expect(r.currentCursor).toBe(3);
    expect(r.oldestCursor).toBe(1);
  });

  it("evicts oldest when bufferCap is exceeded", () => {
    const r = new SessionRuntime<string>("s1", { bufferCap: 3 });
    r.addEvent("a"); // cursor 1
    r.addEvent("b"); // cursor 2
    r.addEvent("c"); // cursor 3
    expect(r.oldestCursor).toBe(1);
    r.addEvent("d"); // cursor 4; "a" evicted
    expect(r.oldestCursor).toBe(2);
    r.addEvent("e"); // cursor 5; "b" evicted
    expect(r.oldestCursor).toBe(3);
    expect(r.currentCursor).toBe(5);
  });

  it("subscribe with default sinceCursor replays the entire buffer", () => {
    const r = new SessionRuntime<string>("s1");
    r.addEvent("a");
    r.addEvent("b");
    r.addEvent("c");
    const seen: string[] = [];
    r.subscribe((e) => seen.push(e.payload));
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("subscribe with sinceCursor=N skips events with cursor <= N", () => {
    const r = new SessionRuntime<string>("s1");
    r.addEvent("a"); // 1
    r.addEvent("b"); // 2
    r.addEvent("c"); // 3
    const seen: number[] = [];
    r.subscribe((e) => seen.push(e.cursor), 2);
    expect(seen).toEqual([3]);
  });

  it("subscribe with sinceCursor at currentCursor replays nothing", () => {
    const r = new SessionRuntime<string>("s1");
    r.addEvent("a");
    r.addEvent("b");
    const seen: string[] = [];
    r.subscribe((e) => seen.push(e.payload), r.currentCursor);
    expect(seen).toEqual([]);
  });

  it("subscribe registers cb for future events", () => {
    const r = new SessionRuntime<string>("s1");
    const seen: number[] = [];
    r.subscribe((e) => seen.push(e.cursor));
    r.addEvent("a"); // 1
    r.addEvent("b"); // 2
    expect(seen).toEqual([1, 2]);
  });

  it("returned unsubscribe stops fanout", () => {
    const r = new SessionRuntime<string>("s1");
    const seen: string[] = [];
    const unsub = r.subscribe((e) => seen.push(e.payload));
    r.addEvent("a");
    unsub();
    r.addEvent("b");
    expect(seen).toEqual(["a"]);
    expect(r.subscriberCount).toBe(0);
  });

  it("returned unsubscribe is idempotent", () => {
    const r = new SessionRuntime<string>("s1");
    const cb = vi.fn();
    const unsub = r.subscribe(cb);
    unsub();
    unsub(); // second call is a no-op
    expect(r.subscriberCount).toBe(0);

    // Re-subscribing the same cb after unsub should still work.
    r.subscribe(cb);
    r.addEvent("x");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("explicit unsubscribe(cb) removes; returns false for absent cb", () => {
    const r = new SessionRuntime<string>("s1");
    const cb = vi.fn();
    r.subscribe(cb);
    expect(r.unsubscribe(cb)).toBe(true);
    expect(r.unsubscribe(cb)).toBe(false);
    r.addEvent("a");
    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple subscribers all receive the same event", () => {
    const r = new SessionRuntime<string>("s1");
    const a: string[] = [];
    const b: string[] = [];
    r.subscribe((e) => a.push(e.payload));
    r.subscribe((e) => b.push(e.payload));
    r.addEvent("x");
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });

  it("isIdle reflects subscribers + query state", () => {
    const r = new SessionRuntime<string>("s1");
    expect(r.isIdle).toBe(true);

    const unsub = r.subscribe(() => {});
    expect(r.isIdle).toBe(false);
    unsub();
    expect(r.isIdle).toBe(true);

    const queryStub: RuntimeQueryHandle = {
      interrupt: async () => {},
      close: () => {},
    };
    r.query = queryStub;
    expect(r.isIdle).toBe(false);
    r.query = null;
    expect(r.isIdle).toBe(true);
  });

  it("reentrant addEvent during replay lands in the buffer but doesn't roundtrip", () => {
    // Contract: subscribe replays buffered events first, THEN attaches cb
    // to the live fanout. So if cb triggers addEvent during replay, the
    // new event reaches the buffer (and future subscribers) but not the
    // currently-replaying cb on this same call. This keeps replay order
    // monotonic — no weird interleaving of past + reentrantly-triggered
    // present events.
    const r = new SessionRuntime<string>("s1");
    r.addEvent("seed"); // cursor 1

    const seen: number[] = [];
    let triggered = false;
    r.subscribe((e) => {
      seen.push(e.cursor);
      if (!triggered) {
        triggered = true;
        r.addEvent("triggered-from-subscriber"); // cursor 2
      }
    });

    expect(seen).toEqual([1]); // reentrant event NOT delivered to this cb
    expect(r.currentCursor).toBe(2); // but it IS in the buffer
    expect(r.oldestCursor).toBe(1);
  });

  // ─── M3.7 idle-teardown ──────────────────────────────────────────────

  it("M3.7 lastActivityAt initialized to ~now at construction", () => {
    const before = Date.now();
    const r = new SessionRuntime<string>("s1");
    const after = Date.now();
    expect(r.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(r.lastActivityAt).toBeLessThanOrEqual(after);
  });

  it("M3.7 armTeardownTimer schedules the fire callback at the requested delay (via injected setTimer)", () => {
    let scheduledCb: (() => void) | undefined;
    let scheduledDelay: number | undefined;
    const setTimer = vi.fn(((cb: () => void, ms: number) => {
      scheduledCb = cb;
      scheduledDelay = ms;
      return Symbol("h") as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const r = new SessionRuntime<string>("s1", {
      setTimer: setTimer as unknown as typeof setTimeout,
      clearTimer: (() => {}) as unknown as typeof clearTimeout,
    });

    const fired: number[] = [];
    r.armTeardownTimer(900_000, () => fired.push(Date.now()));

    expect(setTimer).toHaveBeenCalledOnce();
    expect(scheduledDelay).toBe(900_000);
    expect(r.hasTeardownTimerArmed).toBe(true);
    expect(fired).toHaveLength(0);

    scheduledCb?.(); // simulate timer firing
    expect(fired).toHaveLength(1);
  });

  it("M3.7 armTeardownTimer twice cancels the prior timer (no double-fire)", () => {
    const cleared: Array<unknown> = [];
    const setTimer = vi.fn(
      (() =>
        Symbol("h") as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
    );
    const clearTimer = vi.fn((h: ReturnType<typeof setTimeout>) => {
      cleared.push(h);
    });
    const r = new SessionRuntime<string>("s1", {
      setTimer: setTimer as unknown as typeof setTimeout,
      clearTimer: clearTimer as unknown as typeof clearTimeout,
    });

    r.armTeardownTimer(1000, () => {});
    r.armTeardownTimer(2000, () => {}); // re-arm
    expect(setTimer).toHaveBeenCalledTimes(2);
    expect(clearTimer).toHaveBeenCalledOnce(); // prior was canceled
  });

  it("M3.7 cancelTeardownTimer returns true when armed, false when not, and is idempotent", () => {
    const r = new SessionRuntime<string>("s1", {
      setTimer: (() =>
        Symbol("h") as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
      clearTimer: (() => {}) as unknown as typeof clearTimeout,
    });
    expect(r.cancelTeardownTimer()).toBe(false);

    r.armTeardownTimer(1000, () => {});
    expect(r.hasTeardownTimerArmed).toBe(true);
    expect(r.cancelTeardownTimer()).toBe(true);
    expect(r.hasTeardownTimerArmed).toBe(false);
    expect(r.cancelTeardownTimer()).toBe(false); // idempotent
  });

  it("M3.7 disposeQuery synchronously nulls query / inputChannel / loopPromise + calls close / end", () => {
    const r = new SessionRuntime<string>("s1");
    const closeSpy = vi.fn();
    const endSpy = vi.fn();
    const queryStub: RuntimeQueryHandle = {
      interrupt: async () => {},
      close: closeSpy,
    };
    r.query = queryStub;
    r.inputChannel = { push: () => {}, end: endSpy };
    r.loopPromise = Promise.resolve();

    r.disposeQuery();

    // Synchronous nullification
    expect(r.query).toBeNull();
    expect(r.inputChannel).toBeNull();
    expect(r.loopPromise).toBeNull();
    // SDK signaled to wind down
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(endSpy).toHaveBeenCalledOnce();
  });

  it("M3.7 disposeQuery is a no-op when query already null", () => {
    const r = new SessionRuntime<string>("s1");
    expect(() => r.disposeQuery()).not.toThrow();
    expect(r.query).toBeNull();
  });

  it("M3.7 disposeQuery PRESERVES bridge / subscribers / settled / latestUsage", () => {
    const r = new SessionRuntime<string>("s1");
    r.query = { interrupt: async () => {}, close: () => {} };
    r.inputChannel = { push: () => {}, end: () => {} };
    r.loopPromise = Promise.resolve();
    r.bridge = {
      write: () => {},
      sendResult: () => {},
      reportState: () => {},
      close: () => {},
    };
    r.settled = [];
    r.settledCursor = 5;
    r.latestUsage = { inputTokens: 100 };
    const cb = vi.fn();
    r.subscribe(cb);

    r.disposeQuery();

    // Only the SDK-process slots cleared. Everything else survives.
    expect(r.bridge).not.toBeNull();
    expect(r.settled).not.toBeNull();
    expect(r.latestUsage).not.toBeNull();
    expect(r.subscriberCount).toBe(1);
  });

  // ─── M3.7.4 setActivity + activity field ────────────────────────────

  /** Build a runtime with mock timer + injected log recorder. Returns the
   *  runtime + log lines + helpers to drive the timer. */
  function activityHarness() {
    const logs: string[] = [];
    let lastCb: (() => void) | undefined;
    let lastDelay: number | undefined;
    const setTimer = vi.fn(((cb: () => void, ms: number) => {
      lastCb = cb;
      lastDelay = ms;
      return Symbol("h") as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const runtime = new SessionRuntime<string>("s_act", {
      setTimer,
      clearTimer: (() => {}) as unknown as typeof clearTimeout,
      teardownDelayMs: 900_000,
      log: (msg) => logs.push(msg),
    });
    // Sub a "fake query" so the eligibility predicate sees query !== null.
    runtime.query = {
      interrupt: async () => {},
      close: () => {},
    };
    return {
      runtime,
      logs,
      get lastDelay() {
        return lastDelay;
      },
      fire() {
        if (lastCb === undefined) throw new Error("no timer armed");
        lastCb();
      },
    };
  }

  it("M3.7.4 activity initialized to 'idle' at construction", () => {
    const r = new SessionRuntime<string>("s1");
    expect(r.activity).toBe("idle");
  });

  it("M3.7.4 setActivity dedupes — same state returns changed=false", () => {
    const r = new SessionRuntime<string>("s1");
    const result = r.setActivity("idle"); // already idle
    expect(result.changed).toBe(false);
    expect(result.armed).toBe(false);
    expect(result.canceled).toBe(false);
  });

  it("M3.7.4 setActivity('running') cancels any pending teardown timer", () => {
    const h = activityHarness();
    // Arm via the eligible path: setActivity('idle') with subs=0 + query!=null.
    h.runtime.setActivity("idle");
    expect(h.runtime.hasTeardownTimerArmed).toBe(true);

    const result = h.runtime.setActivity("running");
    expect(result.changed).toBe(true);
    expect(result.canceled).toBe(true);
    expect(h.runtime.hasTeardownTimerArmed).toBe(false);
  });

  it("M3.7.4 setActivity('idle') with subs===0 + query!==null ARMS timer", () => {
    const h = activityHarness();
    h.runtime.activity = "running"; // pre-set for clean transition
    const result = h.runtime.setActivity("idle");
    expect(result.changed).toBe(true);
    expect(result.armed).toBe(true);
    expect(h.runtime.hasTeardownTimerArmed).toBe(true);
    expect(h.logs.some((l) => l.includes("[teardown] armed"))).toBe(true);
  });

  // ─── M3.7.5 subscriber gate ──────────────────────────────────────────

  it("M3.7.5 setActivity('idle') with subs > 0 does NOT arm timer (Claude Desktop parity: watching = keep warm)", () => {
    const h = activityHarness();
    h.runtime.subscribe(() => {}); // 1 subscriber
    h.runtime.activity = "running";

    const result = h.runtime.setActivity("idle");
    expect(result.changed).toBe(true);
    expect(result.armed).toBe(false); // gated out by sub presence
    expect(h.runtime.hasTeardownTimerArmed).toBe(false);
  });

  it("M3.7.5 setActivity('idle') with query===null does NOT arm timer", () => {
    const h = activityHarness();
    h.runtime.query = null; // no SDK process to dispose
    h.runtime.activity = "running";
    const result = h.runtime.setActivity("idle");
    expect(result.armed).toBe(false);
    expect(h.runtime.hasTeardownTimerArmed).toBe(false);
  });

  it("M3.7.5 subscribe() cancels a pending teardown timer (user came back)", () => {
    const h = activityHarness();
    h.runtime.setActivity("idle"); // arm
    expect(h.runtime.hasTeardownTimerArmed).toBe(true);
    const beforeLogs = h.logs.length;

    h.runtime.subscribe(() => {});
    expect(h.runtime.hasTeardownTimerArmed).toBe(false);
    // Log includes a "canceled reason=subscribe" line
    const newLogs = h.logs.slice(beforeLogs);
    expect(
      newLogs.some(
        (l) =>
          l.includes("[teardown] canceled") && l.includes("reason=subscribe"),
      ),
    ).toBe(true);
  });

  it("M3.7.5 unsubscribe() arms teardown timer when last sub leaves + session is idle", () => {
    const h = activityHarness();
    const unsub = h.runtime.subscribe(() => {});
    // setActivity('idle') with sub present → no arm
    h.runtime.activity = "running";
    h.runtime.setActivity("idle");
    expect(h.runtime.hasTeardownTimerArmed).toBe(false);

    // User leaves — sub removed → arm via the eligible path.
    unsub();
    expect(h.runtime.hasTeardownTimerArmed).toBe(true);
  });

  it("M3.7.5 unsubscribe() does NOT arm timer when activity is 'running' (mid-turn protection)", () => {
    const h = activityHarness();
    const unsub = h.runtime.subscribe(() => {});
    h.runtime.activity = "running"; // turn in flight

    unsub();
    expect(h.runtime.hasTeardownTimerArmed).toBe(false); // never arm mid-turn
  });

  it("M3.7.5 explicit unsubscribe(cb) is symmetric with closure — arms timer the same way", () => {
    const h = activityHarness();
    const cb = vi.fn();
    h.runtime.subscribe(cb);
    h.runtime.activity = "running";
    h.runtime.setActivity("idle");
    expect(h.runtime.hasTeardownTimerArmed).toBe(false);

    expect(h.runtime.unsubscribe(cb)).toBe(true);
    expect(h.runtime.hasTeardownTimerArmed).toBe(true);
  });

  it("M3.7.5 multiple subs — only the LAST unsubscribe arms the timer", () => {
    const h = activityHarness();
    const u1 = h.runtime.subscribe(() => {});
    const u2 = h.runtime.subscribe(() => {});
    h.runtime.activity = "running";
    h.runtime.setActivity("idle");

    u1(); // 1 sub left → no arm
    expect(h.runtime.hasTeardownTimerArmed).toBe(false);
    u2(); // 0 subs → arm
    expect(h.runtime.hasTeardownTimerArmed).toBe(true);
  });

  it("M3.7.5 fire callback uses lastActivityAt for accurate idleDurationMs (sub-leave-armed timer)", () => {
    const h = activityHarness();
    const turnTime = Date.now() - 100; // pretend turn finished 100ms ago
    h.runtime.lastActivityAt = turnTime;
    h.runtime.activity = "idle"; // already idle from earlier turn
    const unsub = h.runtime.subscribe(() => {});
    // sub leaving arms timer — but lastActivityAt should reflect the
    // earlier turn-complete, not now.
    unsub();
    expect(h.runtime.hasTeardownTimerArmed).toBe(true);

    h.fire();
    // Log includes the idleDurationMs which is now - turnTime ≈ 100ms (with some slop)
    const fired = h.logs.find((l) => l.includes("[teardown] fired"));
    expect(fired).toBeDefined();
    expect(fired).toMatch(/idleDurationMs=\d+/);
  });

  it("M3.7.5 timer auto-clears `teardownTimer` field on fire (hygiene)", () => {
    const h = activityHarness();
    h.runtime.setActivity("idle");
    expect(h.runtime.hasTeardownTimerArmed).toBe(true);
    h.fire();
    expect(h.runtime.hasTeardownTimerArmed).toBe(false);
  });

  it("M3.7 disposeQuery swallows close/end exceptions (best-effort tear-down)", () => {
    const r = new SessionRuntime<string>("s1");
    r.query = {
      interrupt: async () => {},
      close: () => {
        throw new Error("close_failed");
      },
    };
    r.inputChannel = {
      push: () => {},
      end: () => {
        throw new Error("end_failed");
      },
    };
    expect(() => r.disposeQuery()).not.toThrow();
    expect(r.query).toBeNull();
  });

  // ─── #17 onStateChanged + lastActivityAt fan-out ─────────────────────

  it("#17 currentModel initialized to null at construction", () => {
    const r = new SessionRuntime<string>("s1");
    expect(r.currentModel).toBeNull();
  });

  // currentModel is a plain mirror field owned by SessionRuntimeManager
  // (getOrCreate seed + manager.setModel direct assignment) — there is no
  // runtime-level setModel, so its read/write behavior is covered by the
  // manager tests, not here. onStateChanged is fired only by setActivity.

  it("#17 setActivity fires onStateChanged on transition (idle→running, running→idle)", () => {
    const seen: string[] = [];
    const r = new SessionRuntime<string>("s1", {
      onStateChanged: (sid) => seen.push(sid),
    });
    r.setActivity("running"); // idle → running
    r.setActivity("idle"); // running → idle
    expect(seen).toEqual(["s1", "s1"]);
  });

  it("#17 setActivity does NOT fire onStateChanged for no-op transitions", () => {
    const seen: string[] = [];
    const r = new SessionRuntime<string>("s1", {
      onStateChanged: (sid) => seen.push(sid),
    });
    r.setActivity("idle"); // already idle — no transition
    expect(seen).toEqual([]);
  });

  it("#17 setActivity stamps lastActivityAt on BOTH running AND idle edges", () => {
    const r = new SessionRuntime<string>("s1");
    const t0 = r.lastActivityAt;
    // Simulate clock advance — vi fake timers would be cleaner but the
    // construction-time stamp is captured before this test runs so just
    // poke real Date.now via a brief sync-busy loop alternative: set
    // lastActivityAt manually to a known-past value first.
    r.lastActivityAt = t0 - 1000;
    r.setActivity("running");
    const tRunning = r.lastActivityAt;
    expect(tRunning).toBeGreaterThan(t0 - 1000);
    r.lastActivityAt = tRunning - 500;
    r.setActivity("idle");
    expect(r.lastActivityAt).toBeGreaterThan(tRunning - 500);
  });

  it("continuous fold: addEvent applies foldDelta + tracks settledCursor, only once settled is seeded", () => {
    // Trivial reducer (appends a marker per event) — exercises the addEvent
    // wiring: the `settled !== null` guard + the settledCursor advance, not
    // fold logic (that's fold.test.ts).
    const r = new SessionRuntime<string>("s1", {
      foldDelta: (settled, delta) => {
        settled.push({
          type: "user_message",
          uuid: delta,
          text: delta,
        } as unknown as TimelineItem);
        return settled;
      },
    });

    // Null until seeded → addEvent does NOT fold.
    r.addEvent("a");
    expect(r.settled).toBeNull();

    // Seed (mirrors the create-mode [] seed / subscribe lazy-init) → folding
    // resumes and settledCursor tracks the folded event.
    r.settled = [];
    const e = r.addEvent("b");
    expect(r.settled).toHaveLength(1);
    expect(r.settledCursor).toBe(e.cursor);

    r.addEvent("c");
    expect(r.settled).toHaveLength(2);
    expect(r.settledCursor).toBe(r.currentCursor);
  });
});
