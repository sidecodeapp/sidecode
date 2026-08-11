import { describe, expect, it, vi } from "vitest";
import type {
  clearBridgeWorkerState,
  updateBridgeSequenceNum,
  writeBridgeWorkerState,
} from "../sidecode-sessions.ts";
import {
  type BridgeAttachableRuntime,
  BridgeService,
  type OAuthManager,
} from "./bridge-service.ts";
import type { BridgeTransport } from "./bridge-transport.ts";
import type { fetchRemoteCredentials } from "./sdk-adapter.ts";

/** A fake OAuthManager recording start/stop + handing out a token. */
function fakeOAuth(): OAuthManager & {
  starts: number;
  stops: number;
} {
  let starts = 0;
  let stops = 0;
  return {
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    ensureFresh: vi.fn(async () => "tok"),
    start: () => {
      starts++;
    },
    stop: () => {
      stops++;
    },
  };
}

/** A fake BridgeTransport (only the bits BridgeService touches). Captures the
 *  onClose passed into attach so tests can simulate a transport-initiated
 *  close. */
function fakeTransport(
  cseSessionId = "cse_x",
  opts: { expiresInSec?: number; isConnectedOverride?: () => boolean } = {},
) {
  let closeCalls = 0;
  const reconnectCalls: Array<Record<string, unknown>> = [];
  const reportMetadataCalls: Array<Record<string, unknown>> = [];
  return {
    cseSessionId,
    get closeCalls() {
      return closeCalls;
    },
    get reconnectCalls() {
      return reconnectCalls;
    },
    get reportMetadataCalls() {
      return reportMetadataCalls;
    },
    close() {
      closeCalls++;
    },
    write() {},
    sendResult() {},
    reportMetadata(metadata: Record<string, unknown>) {
      reportMetadataCalls.push(metadata);
    },
    getSequenceNum: () => 0,
    expiresInSec: opts.expiresInSec ?? 14400, // default 4h, matches server
    async reconnect(o: Record<string, unknown>) {
      reconnectCalls.push(o);
    },
    get isConnected() {
      return opts.isConnectedOverride
        ? opts.isConnectedOverride()
        : closeCalls === 0;
    },
  } as unknown as BridgeTransport & {
    closeCalls: number;
    reconnectCalls: Array<Record<string, unknown>>;
    reportMetadataCalls: Array<Record<string, unknown>>;
  };
}

/** Build a service whose attachTransport returns the given transport (and
 *  records the onClose it was handed). */
function serviceWith(
  transport: BridgeTransport,
  oauth = fakeOAuth(),
): {
  service: BridgeService;
  oauth: ReturnType<typeof fakeOAuth>;
  getOnClose: () => ((code: number | undefined) => void) | undefined;
  attachSpy: ReturnType<typeof vi.fn>;
} {
  let onClose: ((code: number | undefined) => void) | undefined;
  const attachSpy = vi.fn(
    async (params: { onClose?: (code: number | undefined) => void }) => {
      onClose = params.onClose;
      return transport;
    },
  );
  const service = new BridgeService({
    oauth,
    home: "/test-home",
    persist: STUB_PERSIST,
    attachTransport:
      attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
  });
  return { service, oauth, getOnClose: () => onClose, attachSpy };
}

/** No-op persistence stubs — most tests don't care about the M3.1
 *  worker-state writes; the M3.1-specific tests below pass their own
 *  spies via the `persist` option. */
const STUB_PERSIST = {
  writeBridgeWorkerState: () => undefined,
  updateBridgeSequenceNum: () => undefined,
  clearBridgeWorkerState: () => undefined,
};

function runtime(): BridgeAttachableRuntime {
  return { bridge: null };
}

describe("BridgeService.attach", () => {
  it("opens a transport, wires runtime.bridge, and starts the OAuth timer", async () => {
    const t = fakeTransport("cse_1");
    const { service, oauth, attachSpy } = serviceWith(t);
    const rt = runtime();

    const returned = await service.attach("s1", rt, {
      title: "T",
      cwd: "/w",
      model: "claude-sonnet-4-6",
    });

    expect(returned).toBe(t);
    expect(rt.bridge).toBe(t); // wired so forwardToBridge mirrors
    expect(service.has("s1")).toBe(true);
    expect(service.size).toBe(1);
    expect(oauth.starts).toBe(1); // proactive timer armed
    // forwarded the request fields + injected the oauth as token source
    expect(attachSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: oauth,
        title: "T",
        cwd: "/w",
        model: "claude-sonnet-4-6",
      }),
    );
  });

  it("is a no-op on a second attach for the same session (no double-open)", async () => {
    const t = fakeTransport();
    const { service, attachSpy } = serviceWith(t);
    const rt = runtime();
    const first = await service.attach("s1", rt, { title: "T", cwd: "/w" });
    const second = await service.attach("s1", rt, { title: "T", cwd: "/w" });
    expect(second).toBe(first);
    expect(attachSpy).toHaveBeenCalledOnce(); // only one real attach
    expect(service.size).toBe(1);
  });

  it("on attach failure: leaves runtime.bridge untouched and stops the timer (no idle refresh loop)", async () => {
    const oauth = fakeOAuth();
    const attachSpy = vi.fn(async () => {
      throw new Error("create_failed");
    });
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    const rt = runtime();
    await expect(
      service.attach("s1", rt, { title: "T", cwd: "/w" }),
    ).rejects.toThrow("create_failed");
    expect(rt.bridge).toBeNull(); // no half-wired mirror
    expect(service.has("s1")).toBe(false);
    expect(oauth.starts).toBe(1);
    expect(oauth.stops).toBe(1); // started then stopped — net zero idle loop
  });

  it("throws after shutdown", async () => {
    const { service } = serviceWith(fakeTransport());
    service.shutdown();
    await expect(
      service.attach("s1", runtime(), { title: "T", cwd: "/w" }),
    ).rejects.toThrow(/shut down/);
  });
});

describe("BridgeService.attach with `existing` — M3.4 startup re-attach path", () => {
  it("threads existingCseSessionId + initialSequenceNum into attachTransport (no createCodeSession path)", async () => {
    const t = fakeTransport("cse_known");
    const { service, attachSpy } = serviceWith(t);
    const rt = runtime();

    await service.attach(
      "s1",
      rt,
      { title: "T", cwd: "/w" },
      { cseSessionId: "cse_known", lastSSESequenceNum: 42 },
    );

    expect(attachSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        existingCseSessionId: "cse_known",
        initialSequenceNum: 42,
      }),
    );
  });

  it("SKIPS writeBridgeWorkerState on re-attach (disk record already correct; backfilled flag must not be reset)", async () => {
    const t = fakeTransport("cse_known");
    const writeSpy = vi.fn(() => undefined);
    const updateSpy = vi.fn(() => undefined);
    const clearSpy = vi.fn(() => undefined);
    const oauth = fakeOAuth();
    const attachSpy = vi.fn(async () => t);
    const service = new BridgeService({
      home: "/test-home",
      oauth,
      persist: {
        writeBridgeWorkerState:
          writeSpy as unknown as typeof writeBridgeWorkerState,
        updateBridgeSequenceNum:
          updateSpy as unknown as typeof updateBridgeSequenceNum,
        clearBridgeWorkerState:
          clearSpy as unknown as typeof clearBridgeWorkerState,
      },
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });

    await service.attach(
      "s1",
      runtime(),
      { title: "T", cwd: "/w" },
      { cseSessionId: "cse_known", lastSSESequenceNum: 99 },
    );

    expect(writeSpy).not.toHaveBeenCalled(); // backfilled / cseId / seq preserved
  });

  it("wires runtime.bridge + records the session in the map + arms proactive timer (re-attach is a full live attach)", async () => {
    const t = fakeTransport("cse_known", { expiresInSec: 7200 });
    const setTimerSpy = vi.fn(
      (_cb: () => void, _ms: number) =>
        ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    );
    const oauth = fakeOAuth();
    const attachSpy = vi.fn(async () => t);
    const service = new BridgeService({
      home: "/test-home",
      oauth,
      persist: STUB_PERSIST,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
      setTimer: setTimerSpy as unknown as typeof setTimeout,
      clearTimer: (() => {}) as unknown as typeof clearTimeout,
    });
    const rt = runtime();

    await service.attach(
      "s1",
      rt,
      { title: "T", cwd: "/w" },
      { cseSessionId: "cse_known", lastSSESequenceNum: 5 },
    );

    expect(rt.bridge).toBe(t);
    expect(service.has("s1")).toBe(true);
    expect(service.size).toBe(1);
    expect(oauth.starts).toBe(1);
    expect(setTimerSpy).toHaveBeenCalledOnce(); // proactive timer armed
  });

  it("still builds the inbound bag — re-attached bridges accept inbound prompts/interrupts the same as fresh ones", async () => {
    const t = fakeTransport("cse_known");
    let capturedInbound:
      | undefined
      | { onInboundMessage?: unknown; onSetPermissionMode?: unknown };
    const attachSpy = vi.fn(async (params: { inbound?: unknown }) => {
      capturedInbound = params.inbound as typeof capturedInbound;
      return t;
    });
    const service = new BridgeService({
      home: "/test-home",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
      onInboundPrompt: () => {}, // flips hasInbound → bag built
    });

    await service.attach(
      "s1",
      runtime(),
      { title: "T", cwd: "/w" },
      { cseSessionId: "cse_known", lastSSESequenceNum: 1 },
    );

    expect(capturedInbound).toBeDefined();
    expect(capturedInbound?.onInboundMessage).toBeTypeOf("function");
    // V0 permission-mode stub also present
    expect(capturedInbound?.onSetPermissionMode).toBeTypeOf("function");
  });

  it("on re-attach failure: leaves runtime.bridge untouched, doesn't touch disk, stops the idle timer", async () => {
    const oauth = fakeOAuth();
    const writeSpy = vi.fn(() => undefined);
    const clearSpy = vi.fn(() => undefined);
    const attachSpy = vi.fn(async () => {
      throw new Error("reattach_failed");
    });
    const service = new BridgeService({
      home: "/test-home",
      oauth,
      persist: {
        writeBridgeWorkerState:
          writeSpy as unknown as typeof writeBridgeWorkerState,
        updateBridgeSequenceNum: (() =>
          undefined) as unknown as typeof updateBridgeSequenceNum,
        clearBridgeWorkerState:
          clearSpy as unknown as typeof clearBridgeWorkerState,
      },
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    const rt = runtime();

    await expect(
      service.attach(
        "s1",
        rt,
        { title: "T", cwd: "/w" },
        { cseSessionId: "cse_dead", lastSSESequenceNum: 10 },
      ),
    ).rejects.toThrow("reattach_failed");
    expect(rt.bridge).toBeNull();
    expect(service.has("s1")).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled(); // no half-write
    expect(clearSpy).not.toHaveBeenCalled(); // startup orchestrator decides clearing
    expect(oauth.stops).toBe(1);
  });

  it("#17 re-attach with `model` PUTs external_metadata to catch CCR up with disk intent", async () => {
    const t = fakeTransport("cse_known") as ReturnType<typeof fakeTransport>;
    const { service } = serviceWith(t);

    await service.attach(
      "s1",
      runtime(),
      { title: "T", cwd: "/w", model: "claude-opus-4-7" },
      { cseSessionId: "cse_known", lastSSESequenceNum: 0 },
    );

    expect(t.reportMetadataCalls).toEqual([{ model: "claude-opus-4-7" }]);
  });

  it("#17 re-attach without `model` does NOT call reportMetadata (no intent to assert)", async () => {
    const t = fakeTransport("cse_known") as ReturnType<typeof fakeTransport>;
    const { service } = serviceWith(t);

    await service.attach(
      "s1",
      runtime(),
      { title: "T", cwd: "/w" }, // no model
      { cseSessionId: "cse_known", lastSSESequenceNum: 0 },
    );

    expect(t.reportMetadataCalls).toEqual([]);
  });

  it("#17 fresh attach (NOT re-attach) does NOT call reportMetadata (createCodeSession already plumbed model)", async () => {
    const t = fakeTransport("cse_x") as ReturnType<typeof fakeTransport>;
    const { service } = serviceWith(t);

    await service.attach(
      "s1",
      runtime(),
      { title: "T", cwd: "/w", model: "claude-opus-4-7" },
      // No `existing` arg → fresh-attach path
    );

    expect(t.reportMetadataCalls).toEqual([]);
  });
});

describe("BridgeService — inbound prompt routing (M2.2)", () => {
  it("wires inbound when onInboundPrompt is set, and routes extracted prompts to it", async () => {
    const t = fakeTransport();
    const routed: Array<{ sessionId: string; text: string; uuid?: string }> =
      [];
    let capturedInbound:
      | { onInboundMessage?: (msg: unknown) => void }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: { onInboundMessage?: (msg: unknown) => void };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      onInboundPrompt: (sessionId, prompt) =>
        routed.push({ sessionId, text: prompt.text, uuid: prompt.uuid }),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });

    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // inbound bag was passed → transport opens bidirectional.
    expect(capturedInbound).toBeDefined();
    expect(typeof capturedInbound?.onInboundMessage).toBe("function");

    // A real claude.ai user message → extracted + routed with the session id.
    capturedInbound?.onInboundMessage?.({
      type: "user",
      uuid: "claude-uuid-1",
      message: { role: "user", content: "hello from cloud" },
    });
    expect(routed).toEqual([
      { sessionId: "s1", text: "hello from cloud", uuid: "claude-uuid-1" },
    ]);
  });

  it("drops non-prompt inbound frames (does not call the router)", async () => {
    const t = fakeTransport();
    const routed: unknown[] = [];
    let capturedInbound:
      | { onInboundMessage?: (msg: unknown) => void }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: { onInboundMessage?: (msg: unknown) => void };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      onInboundPrompt: (sessionId, prompt) =>
        routed.push({ sessionId, prompt }),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // assistant frame + empty user → both filtered by extractInboundPrompt.
    capturedInbound?.onInboundMessage?.({
      type: "assistant",
      message: { content: "x" },
    });
    capturedInbound?.onInboundMessage?.({
      type: "user",
      message: { content: [] },
    });
    expect(routed).toEqual([]);
  });

  it("does NOT wire inbound when ALL handlers are omitted (mirror mode — M1 regression guard)", async () => {
    const t = fakeTransport();
    let captured: { inbound?: unknown } | undefined;
    const attachSpy = vi.fn(async (params: { inbound?: unknown }) => {
      captured = params;
      return t;
    });
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      // No onInboundPrompt, no onInterrupt, no onSetModel.
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    // inbound undefined → transport derives outboundOnly:true (pure mirror,
    // M1 behavior preserved when no caller wires the control surface).
    expect(captured?.inbound).toBeUndefined();
  });
});

describe("BridgeService — control routing (M2.4)", () => {
  it("wires onInterrupt into the inbound bag and routes with the session id", async () => {
    const t = fakeTransport();
    const interrupts: string[] = [];
    let capturedInbound:
      | { onInterrupt?: () => void; onInboundMessage?: unknown }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: { onInterrupt?: () => void; onInboundMessage?: unknown };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      // ONLY onInterrupt — no prompt routing, no setModel.
      onInterrupt: (sessionId) => interrupts.push(sessionId),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // inbound bag built, contains ONLY onInterrupt (partial wiring is fine).
    expect(capturedInbound).toBeDefined();
    expect(typeof capturedInbound?.onInterrupt).toBe("function");
    expect(capturedInbound?.onInboundMessage).toBeUndefined();

    // SDK fires the handler → routed with the session id.
    capturedInbound?.onInterrupt?.();
    expect(interrupts).toEqual(["s1"]);
  });

  it("wires onSetModel into the inbound bag and routes (session id + model)", async () => {
    const t = fakeTransport();
    const models: Array<{ sessionId: string; model: string | undefined }> = [];
    let capturedInbound:
      | { onSetModel?: (model: string | undefined) => void }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: { onSetModel?: (model: string | undefined) => void };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      onSetModel: (sessionId, model) => models.push({ sessionId, model }),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    expect(typeof capturedInbound?.onSetModel).toBe("function");
    capturedInbound?.onSetModel?.("claude-opus-4-8");
    capturedInbound?.onSetModel?.(undefined); // reset-to-default
    expect(models).toEqual([
      { sessionId: "s1", model: "claude-opus-4-8" },
      { sessionId: "s1", model: undefined },
    ]);
  });

  it("composes all three handlers when all are provided", async () => {
    // Production wiring (index.ts) provides all three together — verify the
    // bag carries each, and each routes to its respective callback.
    const t = fakeTransport();
    const seen: string[] = [];
    let capturedInbound:
      | {
          onInboundMessage?: (msg: unknown) => void;
          onInterrupt?: () => void;
          onSetModel?: (model: string | undefined) => void;
        }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: {
          onInboundMessage?: (msg: unknown) => void;
          onInterrupt?: () => void;
          onSetModel?: (model: string | undefined) => void;
        };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      onInboundPrompt: (sid, p) => seen.push(`prompt:${sid}:${p.text}`),
      onInterrupt: (sid) => seen.push(`interrupt:${sid}`),
      onSetModel: (sid, m) => seen.push(`setModel:${sid}:${m ?? "null"}`),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    expect(typeof capturedInbound?.onInboundMessage).toBe("function");
    expect(typeof capturedInbound?.onInterrupt).toBe("function");
    expect(typeof capturedInbound?.onSetModel).toBe("function");

    capturedInbound?.onInboundMessage?.({
      type: "user",
      uuid: "u-1",
      message: { role: "user", content: "hi" },
    });
    capturedInbound?.onInterrupt?.();
    capturedInbound?.onSetModel?.("claude-sonnet-4-6");
    expect(seen).toEqual([
      "prompt:s1:hi",
      "interrupt:s1",
      "setModel:s1:claude-sonnet-4-6",
    ]);
  });

  it("auto-attaches onSetPermissionMode stub returning V0 refuse verdict whenever bidirectional", async () => {
    // V0 fixes bypassPermissions (project_no_plan_mode_v0). The stub beats the
    // SDK's generic "callback not registered" auto-error by giving claude.ai
    // a sidecode-specific reason. Static — no router, no per-session state.
    const t = fakeTransport();
    let capturedInbound:
      | {
          onSetPermissionMode?: (
            mode: unknown,
          ) => { ok: true } | { ok: false; error: string };
        }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: {
          onSetPermissionMode?: (
            mode: unknown,
          ) => { ok: true } | { ok: false; error: string };
        };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      // Any one caller handler suffices to flip bidirectional — that's when
      // the stub is attached. Using onInterrupt here, but the stub is
      // independent of WHICH caller handler triggered bidirectional mode.
      onInterrupt: () => {},
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    expect(typeof capturedInbound?.onSetPermissionMode).toBe("function");
    const verdict = capturedInbound?.onSetPermissionMode?.("plan");
    expect(verdict?.ok).toBe(false);
    // Refuse for ANY mode (acceptEdits / default / plan / bypassPermissions
    // all refused — V0 locks bypass; only revisit when plan / approval UI lands).
    expect(capturedInbound?.onSetPermissionMode?.("default")?.ok).toBe(false);
    expect(capturedInbound?.onSetPermissionMode?.("acceptEdits")?.ok).toBe(
      false,
    );
    if (verdict?.ok === false) {
      // ASCII-only error per repo convention; mention bypassPermissions so the
      // user understands WHY without reading sidecode source.
      expect(verdict.error).toMatch(/bypassPermissions/);
      expect(verdict.error).not.toMatch(/[一-鿿]/); // no CJK
    }
  });

  it("does NOT auto-attach onSetPermissionMode in pure mirror mode (no caller handlers)", async () => {
    // The stub is bundled into the bag, not bolted on independently — so when
    // hasInbound is false (M1 pure mirror) the bag is undefined and the SDK
    // sees no onSetPermissionMode at all. Pure mirror has no read channel
    // anyway, so claude.ai can't reach the worker with set_permission_mode.
    const t = fakeTransport();
    let captured: { inbound?: unknown } | undefined;
    const attachSpy = vi.fn(async (params: { inbound?: unknown }) => {
      captured = params;
      return t;
    });
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      // No caller handlers → hasInbound false → no bag.
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    expect(captured?.inbound).toBeUndefined();
  });
});

describe("BridgeService.detach", () => {
  it("closes the transport, clears runtime.bridge, stops the timer on last bridge", async () => {
    const t = fakeTransport();
    const { service, oauth } = serviceWith(t);
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    service.detach("s1", rt);

    expect((t as unknown as { closeCalls: number }).closeCalls).toBe(1);
    expect(rt.bridge).toBeNull();
    expect(service.has("s1")).toBe(false);
    expect(oauth.stops).toBe(1); // last bridge gone → timer stopped
  });

  it("is a no-op for an unknown session", async () => {
    const { service } = serviceWith(fakeTransport());
    expect(() => service.detach("nope", runtime())).not.toThrow();
  });

  it("keeps the OAuth timer running while other bridges remain", async () => {
    // Two sessions, two transports. Detaching one must NOT stop the timer.
    const oauth = fakeOAuth();
    const t1 = fakeTransport("cse_1");
    const t2 = fakeTransport("cse_2");
    const queue = [t1, t2];
    const attachSpy = vi.fn(async () => queue.shift());
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    const rt1 = runtime();
    const rt2 = runtime();
    await service.attach("s1", rt1, { title: "T", cwd: "/w" });
    await service.attach("s2", rt2, { title: "T", cwd: "/w" });
    expect(service.size).toBe(2);

    service.detach("s1", rt1);
    expect(service.size).toBe(1);
    expect(oauth.stops).toBe(0); // s2 still bridged → timer stays up

    service.detach("s2", rt2);
    expect(oauth.stops).toBe(1); // now empty → stop
  });
});

describe("BridgeService — transport-initiated close (onClose)", () => {
  it("M3.5 — code 1000 (clean server-side end) forgets the session immediately, no reconnect", async () => {
    const t = fakeTransport();
    const { service, oauth, getOnClose } = serviceWith(t);
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    getOnClose()?.(1000);

    expect(service.has("s1")).toBe(false);
    expect(rt.bridge).toBeNull();
    expect(oauth.stops).toBe(1);
  });

  it("M3.5 — non-1000 codes (401 / 4090 / 4091) trigger reconnect, session stays in the map while recovery is in-flight", async () => {
    // 401 used to forget unconditionally (pre-M3.5). Now onClose routes to
    // reconnect() so the session record persists across the reconnect
    // attempt — only an explicit reconnect failure (creds null / terminal
    // failure) clears it. Tests for the actual reconnect dispatch live in
    // the M3.5 reconnect describe block; here we only assert that 401
    // does NOT forget the session synchronously.
    const t = fakeTransport();
    const { service, getOnClose } = serviceWith(t);
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    getOnClose()?.(401);

    // Reconnect is async + fire-and-forget — but the session record was
    // NOT immediately cleared (unlike the pre-M3.5 forget-on-any-code path).
    expect(service.has("s1")).toBe(true);
    expect(rt.bridge).toBe(t);
  });
});

describe("BridgeService.shutdown", () => {
  it("closes all transports and stops the OAuth manager; idempotent", async () => {
    const oauth = fakeOAuth();
    const t1 = fakeTransport("cse_1");
    const t2 = fakeTransport("cse_2");
    const queue = [t1, t2];
    const attachSpy = vi.fn(async () => queue.shift());
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    await service.attach("s2", runtime(), { title: "T", cwd: "/w" });

    service.shutdown();
    service.shutdown(); // idempotent

    expect((t1 as unknown as { closeCalls: number }).closeCalls).toBe(1);
    expect((t2 as unknown as { closeCalls: number }).closeCalls).toBe(1);
    expect(service.size).toBe(0);
    // stop() called: once when map emptied during shutdown loop is NOT how it
    // works (shutdown clears then stops once) — assert at least the final stop.
    expect(oauth.stops).toBeGreaterThanOrEqual(1);
  });
});

describe("BridgeService — M3.1 worker-state persistence", () => {
  it("attach writes initial bridge worker state {cseSessionId, lastSSESequenceNum:0, backfilled:false}", async () => {
    const t = fakeTransport("cse_42");
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined),
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/test-home",
      oauth: fakeOAuth(),
      persist,
      attachTransport: vi.fn(
        async () => t,
      ) as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("local-sess-1", runtime(), { title: "T", cwd: "/w" });
    expect(persist.writeBridgeWorkerState).toHaveBeenCalledWith(
      "/test-home",
      "local-sess-1",
      { cseSessionId: "cse_42", lastSSESequenceNum: 0, backfilled: false },
    );
  });

  it("attach passes a persistSequenceNum closure that routes through updateBridgeSequenceNum", async () => {
    const t = fakeTransport();
    let captured: { persistSequenceNum?: (seq: number) => void } | undefined;
    const attachSpy = vi.fn(async (params: typeof captured) => {
      captured = params;
      return t;
    });
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined),
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("sess-A", runtime(), { title: "T", cwd: "/w" });
    expect(typeof captured?.persistSequenceNum).toBe("function");
    // Invoke as if BridgeTransport.checkpoint did → updateBridgeSequenceNum
    // gets the right (home, cliSessionId, seq) triple. This is the routing
    // proof: home + sessionId are closed over correctly per-attach.
    captured?.persistSequenceNum?.(7);
    expect(persist.updateBridgeSequenceNum).toHaveBeenCalledWith(
      "/h",
      "sess-A",
      7,
    );
  });

  it("detach clears the bridge worker state (explicit unbridge intent)", async () => {
    const t = fakeTransport();
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined),
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist,
      attachTransport: vi.fn(
        async () => t,
      ) as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });
    service.detach("s1", rt);
    expect(persist.clearBridgeWorkerState).toHaveBeenCalledWith("/h", "s1");
  });

  it("transport-initiated onClose (4090 epoch / 401 jwt) does NOT clear worker state — M3.4 reattach needs it", async () => {
    // onClose goes through forget(), not detach(), so worker state must
    // persist for restart re-attach to find this bridged session.
    const t = fakeTransport();
    let onClose: ((code: number | undefined) => void) | undefined;
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined),
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist,
      attachTransport: vi.fn(
        async (params: { onClose?: (code: number | undefined) => void }) => {
          onClose = params.onClose;
          return t;
        },
      ) as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    onClose?.(4090);
    expect(persist.clearBridgeWorkerState).not.toHaveBeenCalled();
  });

  it("attach logs (but does not throw) when metadata is missing — writeBridgeWorkerState returns undefined", async () => {
    const t = fakeTransport();
    const messages: string[] = [];
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined), // simulate missing metadata
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      log: (m) => messages.push(m),
      persist,
      attachTransport: vi.fn(
        async () => t,
      ) as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    await expect(
      service.attach("s1", runtime(), { title: "T", cwd: "/w" }),
    ).resolves.toBe(t);
    expect(
      messages.some((m) =>
        m.includes("no sidecode metadata to persist worker state"),
      ),
    ).toBe(true);
  });
});

describe("BridgeService.reconnect — M3.5.3 unified entry", () => {
  /** Build a service with reconnect-aware test seams (fetchRemoteCredentials
   *  + setTimer / clearTimer fakes). All tests in this block use the same
   *  shape so behavior is comparable. */
  function reconnectService(opts: {
    transport: BridgeTransport;
    fetchImpl?: typeof fetchRemoteCredentials;
    persist?: {
      writeBridgeWorkerState?: typeof writeBridgeWorkerState;
      updateBridgeSequenceNum?: typeof updateBridgeSequenceNum;
      clearBridgeWorkerState?: typeof clearBridgeWorkerState;
    };
    attachQueue?: BridgeTransport[]; // for reactive-reattach tests
    oauth?: ReturnType<typeof fakeOAuth>;
  }) {
    const oauth = opts.oauth ?? fakeOAuth();
    const attachQueue = [opts.transport, ...(opts.attachQueue ?? [])];
    let onCloseCaptured: ((c: number | undefined) => void) | undefined;
    const attachSpy = vi.fn(
      async (params: {
        onClose?: (c: number | undefined) => void;
        existingCseSessionId?: string;
        initialSequenceNum?: number;
      }) => {
        onCloseCaptured = params.onClose;
        const next = attachQueue.shift();
        if (next === undefined) throw new Error("test attach queue exhausted");
        return next;
      },
    );
    const fetchImpl =
      opts.fetchImpl ??
      vi.fn(
        async () =>
          ({
            worker_jwt: "new-jwt",
            api_base_url: "https://api.anthropic.com",
            expires_in: 14400,
            worker_epoch: 2,
          }) as Awaited<ReturnType<typeof fetchRemoteCredentials>>,
      );
    const service = new BridgeService({
      home: "/h",
      oauth,
      persist: opts.persist ?? STUB_PERSIST,
      sdk: { fetchRemoteCredentials: fetchImpl },
      // No-op timers — proactive tests will inject their own.
      setTimer: ((_cb: () => void, _ms: number) => {
        return {} as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimer: () => {},
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.ts").BridgeTransport.attach,
    });
    return {
      service,
      oauth,
      attachSpy,
      fetchImpl: fetchImpl as ReturnType<typeof vi.fn>,
      getOnClose: () => onCloseCaptured,
    };
  }

  it("returns 'not_attached' when no session exists for the given id", async () => {
    const { service } = reconnectService({ transport: fakeTransport() });
    const r = await service.reconnect("ghost");
    expect(r.result).toBe("not_attached");
  });

  it("returns 'service_stopped' after shutdown", async () => {
    const { service } = reconnectService({ transport: fakeTransport() });
    service.shutdown();
    const r = await service.reconnect("anything");
    expect(r.result).toBe("service_stopped");
  });

  it("LIVE transport: fetches fresh creds + calls transport.reconnect (PROACTIVE mode)", async () => {
    const transport = fakeTransport("cse_live");
    const { service, fetchImpl } = reconnectService({ transport });
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    const r = await service.reconnect("s1");

    expect(r).toEqual({ result: "reconnected", mode: "proactive" });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "cse_live", accessToken: "tok" }),
    );
    const tcalls = (
      transport as unknown as {
        reconnectCalls: Array<Record<string, unknown>>;
      }
    ).reconnectCalls;
    expect(tcalls).toHaveLength(1);
    expect(tcalls[0]).toMatchObject({
      ingressToken: "new-jwt",
      apiBaseUrl: "https://api.anthropic.com",
      epoch: 2,
      expiresInSec: 14400,
    });
    // Session map still has the SAME transport (no replacement on proactive).
    expect(rt.bridge).toBe(transport);
  });

  it("DEAD transport: full re-attach via attachTransport with existingCseSessionId + initialSequenceNum (REACTIVE mode)", async () => {
    const oldTransport = fakeTransport("cse_react", {
      isConnectedOverride: () => false, // already dead
    });
    // getSequenceNum on the dying transport — service uses this as the
    // SSE resume point for the new attach.
    (
      oldTransport as unknown as { getSequenceNum: () => number }
    ).getSequenceNum = () => 42;
    const newTransport = fakeTransport("cse_react");
    const { service, attachSpy, fetchImpl } = reconnectService({
      transport: oldTransport,
      attachQueue: [newTransport],
    });
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });
    // attachSpy called once for initial attach; clear so we can assert the
    // reattach call shape in isolation.
    attachSpy.mockClear();

    const r = await service.reconnect("s1");

    expect(r).toEqual({ result: "reconnected", mode: "reactive" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledTimes(1);
    const attachArg = attachSpy.mock.calls[0]?.[0] as {
      existingCseSessionId?: string;
      initialSequenceNum?: number;
    };
    expect(attachArg.existingCseSessionId).toBe("cse_react");
    expect(attachArg.initialSequenceNum).toBe(42);
    // runtime.bridge re-wired to the NEW transport.
    expect(rt.bridge).toBe(newTransport);
  });

  it("creds=null → clearBridgeWorkerState + detach (session truly gone on cloud)", async () => {
    const transport = fakeTransport("cse_gone");
    const clearSpy = vi.fn(() => undefined);
    const { service } = reconnectService({
      transport,
      fetchImpl: vi.fn(async () => null),
      persist: { ...STUB_PERSIST, clearBridgeWorkerState: clearSpy },
    });
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    const r = await service.reconnect("s1");

    expect(r).toEqual({ result: "cleared", reason: "creds_null" });
    expect(clearSpy).toHaveBeenCalledWith("/h", "s1");
    expect(service.has("s1")).toBe(false);
    expect(rt.bridge).toBeNull();
  });

  it("CredentialsFailure (session_stale_relogin) → clearBridgeWorkerState + detach", async () => {
    const transport = fakeTransport("cse_relogin");
    const clearSpy = vi.fn(() => undefined);
    const { service } = reconnectService({
      transport,
      fetchImpl: vi.fn(
        async () =>
          ({
            terminal: true,
            reason: "session_stale_relogin",
          }) as Awaited<ReturnType<typeof fetchRemoteCredentials>>,
      ),
      persist: { ...STUB_PERSIST, clearBridgeWorkerState: clearSpy },
    });
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    const r = await service.reconnect("s1");

    expect(r.result).toBe("cleared");
    if (r.result === "cleared") expect(r.reason).toBe("session_stale_relogin");
    expect(clearSpy).toHaveBeenCalledWith("/h", "s1");
  });

  it("OAuth ensureFresh throw → 'auth_failed', worker state preserved", async () => {
    const transport = fakeTransport("cse_oauth");
    const oauth = fakeOAuth();
    oauth.ensureFresh = vi.fn(async () => {
      throw new Error("oauth network blip");
    });
    const clearSpy = vi.fn(() => undefined);
    const { service } = reconnectService({
      transport,
      oauth,
      persist: { ...STUB_PERSIST, clearBridgeWorkerState: clearSpy },
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    const r = await service.reconnect("s1");

    expect(r.result).toBe("auth_failed");
    // State NOT cleared on auth failure — transient.
    expect(clearSpy).not.toHaveBeenCalled();
    expect(service.has("s1")).toBe(true);
  });

  it("transport.reconnect throws (live path) → 'transport_failed', worker state preserved", async () => {
    const transport = fakeTransport("cse_live");
    (
      transport as unknown as { reconnect: typeof transport.reconnect }
    ).reconnect = async () => {
      throw new Error("server 503");
    };
    const clearSpy = vi.fn(() => undefined);
    const { service } = reconnectService({
      transport,
      persist: { ...STUB_PERSIST, clearBridgeWorkerState: clearSpy },
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    const r = await service.reconnect("s1");

    expect(r.result).toBe("transport_failed");
    expect(clearSpy).not.toHaveBeenCalled();
  });
});

describe("BridgeService — onClose-driven reconnect (M3.5.4)", () => {
  it("non-1000 onClose triggers reconnect (live transport, proactive path)", async () => {
    const transport = fakeTransport("cse_x");
    let onClose: ((c: number | undefined) => void) | undefined;
    const fetchImpl = vi.fn(
      async () =>
        ({
          worker_jwt: "j",
          api_base_url: "https://api.anthropic.com",
          expires_in: 14400,
          worker_epoch: 2,
        }) as Awaited<ReturnType<typeof fetchRemoteCredentials>>,
    );
    const attachSpy = vi.fn(
      async (params: { onClose?: (c: number | undefined) => void }) => {
        onClose = params.onClose;
        return transport;
      },
    );
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      sdk: { fetchRemoteCredentials: fetchImpl },
      setTimer: ((_cb: () => void, _ms: number) =>
        ({}) as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
      clearTimer: () => {},
      attachTransport: attachSpy as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // Simulate onClose firing with a non-clean code. Fire-and-forget — we
    // wait one microtask for the async reconnect to enqueue.
    onClose?.(4090);
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "cse_x" }),
    );
    const tcalls = (
      transport as unknown as {
        reconnectCalls: Array<Record<string, unknown>>;
      }
    ).reconnectCalls;
    expect(tcalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("BridgeService — M3.5.5 proactive refresh timer", () => {
  it("arms the timer on attach with delay = (expiresInSec - leadSec) * 1000", async () => {
    const transport = fakeTransport("cse_x", { expiresInSec: 14400 }); // 4h
    let armedDelay: number | undefined;
    const setTimer = vi.fn(((cb: () => void, ms: number) => {
      armedDelay = ms;
      return { _cb: cb } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      setTimer,
      clearTimer: () => {},
      proactiveRefreshLeadSec: 30 * 60, // 30min lead
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // (14400 - 1800) * 1000 = 12_600_000 ms
    expect(armedDelay).toBe(12_600_000);
  });

  it("clamps the timer delay to MIN_PROACTIVE_DELAY_MS (60s) when lead >= expires_in", async () => {
    // Short jwt + generous lead — naive math would be negative or 0; clamp
    // guards against refresh-loop.
    const transport = fakeTransport("cse_x", { expiresInSec: 60 }); // 60s jwt
    let armedDelay: number | undefined;
    const setTimer = vi.fn(((_cb: () => void, ms: number) => {
      armedDelay = ms;
      return {} as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      setTimer,
      clearTimer: () => {},
      proactiveRefreshLeadSec: 30 * 60, // lead is BIGGER than jwt lifetime
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    expect(armedDelay).toBe(60_000); // clamped to MIN_PROACTIVE_DELAY_MS
  });

  it("cancels the timer on detach", async () => {
    const transport = fakeTransport("cse_x");
    const clearTimer = vi.fn();
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      setTimer: (() =>
        ({ id: 1 }) as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
      clearTimer,
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    service.detach("s1", rt);

    expect(clearTimer).toHaveBeenCalled();
  });

  it("cancels the timer on shutdown", async () => {
    const transport = fakeTransport("cse_x");
    const clearTimer = vi.fn();
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      setTimer: (() =>
        ({ id: 1 }) as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
      clearTimer,
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    service.shutdown();

    expect(clearTimer).toHaveBeenCalled();
  });

  it("re-arms the timer after a successful proactive reconnect", async () => {
    const transport = fakeTransport("cse_x", { expiresInSec: 14400 });
    let armedCount = 0;
    const setTimer = vi.fn(((_cb: () => void, _ms: number) => {
      armedCount++;
      return { id: armedCount } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      sdk: {
        fetchRemoteCredentials: vi.fn(
          async () =>
            ({
              worker_jwt: "j",
              api_base_url: "https://api.anthropic.com",
              expires_in: 14400,
              worker_epoch: 2,
            }) as Awaited<ReturnType<typeof fetchRemoteCredentials>>,
        ),
      },
      setTimer,
      clearTimer: () => {},
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    expect(armedCount).toBe(1); // initial attach

    const r = await service.reconnect("s1");
    expect(r.result).toBe("reconnected");
    expect(armedCount).toBe(2); // re-armed after successful reconnect
  });
});

describe("BridgeService — M3.5.6 reconnect failure backoff ladder", () => {
  /** Build a service whose fetchRemoteCredentials always throws (the
   *  cleanest way to drive the transport_failed branch through the ladder). */
  function failingService(
    opts: {
      setTimer?: typeof setTimeout;
      clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
      failureMode?: "fetch_throw" | "creds_null";
    } = {},
  ) {
    const setTimerSpy =
      opts.setTimer ??
      vi.fn(
        ((_cb: () => void, _ms: number) =>
          ({ id: 1 }) as unknown as ReturnType<
            typeof setTimeout
          >) as unknown as typeof setTimeout,
      );
    const clearTimerSpy = opts.clearTimer ?? vi.fn();
    const transport = fakeTransport("cse_x");
    const fetchImpl =
      opts.failureMode === "creds_null"
        ? vi.fn(async () => null)
        : vi.fn(async () => {
            throw new Error("network blip");
          });
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      sdk: {
        fetchRemoteCredentials:
          fetchImpl as unknown as typeof fetchRemoteCredentials,
      },
      setTimer: setTimerSpy,
      clearTimer: clearTimerSpy,
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    return { service, transport, setTimerSpy, clearTimerSpy, fetchImpl };
  }

  it("first transport_failed schedules backoff at ladder[0] = 30s", async () => {
    const setTimerSpy = vi.fn(
      ((_cb: () => void, _ms: number) =>
        ({ id: 1 }) as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
    );
    const { service } = failingService({
      setTimer: setTimerSpy as unknown as typeof setTimeout,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    // Clear the initial proactive-timer call so we can inspect backoff-only calls.
    setTimerSpy.mockClear();

    const r = await service.reconnect("s1");

    expect(r.result).toBe("transport_failed");
    expect(setTimerSpy).toHaveBeenCalledTimes(1);
    expect(setTimerSpy.mock.calls[0]?.[1]).toBe(30_000);
  });

  it("ladder progresses: 30s → 2min → 10min on consecutive failures", async () => {
    const setTimerSpy = vi.fn(
      ((_cb: () => void, _ms: number) =>
        ({ id: 1 }) as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
    );
    const { service } = failingService({
      setTimer: setTimerSpy as unknown as typeof setTimeout,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    setTimerSpy.mockClear();

    await service.reconnect("s1"); // attempt 1: 30s
    await service.reconnect("s1"); // attempt 2: 2min
    await service.reconnect("s1"); // attempt 3: 10min

    expect(setTimerSpy.mock.calls.map((c) => c[1])).toEqual([
      30_000, 120_000, 600_000,
    ]);
  });

  it("after ladder exhaustion (4th failure) NO new timer is armed", async () => {
    const setTimerSpy = vi.fn(
      ((_cb: () => void, _ms: number) =>
        ({ id: 1 }) as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
    );
    const { service } = failingService({
      setTimer: setTimerSpy as unknown as typeof setTimeout,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    setTimerSpy.mockClear();

    await service.reconnect("s1"); // 1
    await service.reconnect("s1"); // 2
    await service.reconnect("s1"); // 3
    await service.reconnect("s1"); // 4 — past ladder, no timer

    expect(setTimerSpy).toHaveBeenCalledTimes(3);
  });

  it("successful reconnect after failures RESETS the ladder (next failure goes back to 30s)", async () => {
    const setTimerSpy = vi.fn(
      ((_cb: () => void, _ms: number) =>
        ({ id: 1 }) as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
    );
    const transport = fakeTransport("cse_x");
    let failNext = true;
    const fetchImpl = vi.fn(async () => {
      if (failNext) {
        throw new Error("transient");
      }
      return {
        worker_jwt: "j",
        api_base_url: "https://api.anthropic.com",
        expires_in: 14400,
        worker_epoch: 2,
      } as Awaited<ReturnType<typeof fetchRemoteCredentials>>;
    });
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      sdk: {
        fetchRemoteCredentials:
          fetchImpl as unknown as typeof fetchRemoteCredentials,
      },
      setTimer: setTimerSpy,
      clearTimer: () => {},
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    setTimerSpy.mockClear();

    // 2 failures → ladder at index 2 (next would be 10min)
    await service.reconnect("s1"); // 30s
    await service.reconnect("s1"); // 2min

    // Success → ladder reset
    failNext = false;
    const ok = await service.reconnect("s1");
    expect(ok.result).toBe("reconnected");

    // Drop back to failure → should arm 30s again, not 10min
    failNext = true;
    setTimerSpy.mockClear();
    await service.reconnect("s1");
    expect(setTimerSpy.mock.calls.at(-1)?.[1]).toBe(30_000);
  });

  it("auth_failed (ensureFresh throws) also schedules backoff", async () => {
    const setTimerSpy = vi.fn(
      ((_cb: () => void, _ms: number) =>
        ({ id: 1 }) as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
    );
    const transport = fakeTransport("cse_x");
    const oauth = fakeOAuth();
    oauth.ensureFresh = vi.fn(async () => {
      throw new Error("keychain unavailable");
    });
    const service = new BridgeService({
      home: "/h",
      oauth,
      persist: STUB_PERSIST,
      setTimer: setTimerSpy,
      clearTimer: () => {},
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    setTimerSpy.mockClear();

    const r = await service.reconnect("s1");

    expect(r.result).toBe("auth_failed");
    expect(setTimerSpy).toHaveBeenCalledTimes(1);
    expect(setTimerSpy.mock.calls[0]?.[1]).toBe(30_000);
  });

  it("cleared (null creds → session deleted) does NOT schedule backoff", async () => {
    const setTimerSpy = vi.fn(
      ((_cb: () => void, _ms: number) =>
        ({ id: 1 }) as unknown as ReturnType<
          typeof setTimeout
        >) as unknown as typeof setTimeout,
    );
    const { service } = failingService({
      setTimer: setTimerSpy as unknown as typeof setTimeout,
      failureMode: "creds_null",
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    setTimerSpy.mockClear();

    const r = await service.reconnect("s1");

    expect(r.result).toBe("cleared");
    expect(setTimerSpy).not.toHaveBeenCalled();
  });

  it("detach cancels the backoff timer", async () => {
    const clearTimerSpy = vi.fn();
    const { service } = failingService({
      clearTimer: clearTimerSpy as unknown as (
        h: ReturnType<typeof setTimeout>,
      ) => void,
    });
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });
    await service.reconnect("s1"); // arms backoff
    clearTimerSpy.mockClear();

    service.detach("s1", rt);

    // detach → cancelTimers → clears backoffTimer (the only one armed since
    // reconnect failed before re-arming proactive).
    expect(clearTimerSpy).toHaveBeenCalled();
  });

  it("shutdown cancels backoff timers across all sessions", async () => {
    const clearTimerSpy = vi.fn();
    const { service } = failingService({
      clearTimer: clearTimerSpy as unknown as (
        h: ReturnType<typeof setTimeout>,
      ) => void,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    await service.reconnect("s1"); // arms backoff
    clearTimerSpy.mockClear();

    service.shutdown();

    expect(clearTimerSpy).toHaveBeenCalled();
  });
});

describe("BridgeService — M3.5.7 in-flight reconnect coalescing + stale-transport guard", () => {
  it("two concurrent reconnect calls coalesce into ONE fetchRemoteCredentials + share the result", async () => {
    // Without M3.5.7: two onClose fires from same transport (SSE + CCRClient
    // sides) each start a reconnect → both call fetchRemoteCredentials →
    // server bumps epoch twice → second bump kills the first transport →
    // more onClose fires → cascade. With the guard: second reconnect call
    // returns the in-flight promise; only ONE fetchRemoteCredentials runs.
    const transport = fakeTransport("cse_x");
    let resolveCreds: (
      v: Awaited<ReturnType<typeof fetchRemoteCredentials>>,
    ) => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof fetchRemoteCredentials>>>((r) => {
          resolveCreds = r;
        }),
    );
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      sdk: {
        fetchRemoteCredentials:
          fetchImpl as unknown as typeof fetchRemoteCredentials,
      },
      setTimer: ((_cb: () => void, _ms: number) =>
        ({}) as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
      clearTimer: () => {},
      attachTransport: vi.fn(
        async () => transport,
      ) as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // Fire two reconnects concurrently — both should be in-flight against
    // the same promise.
    const p1 = service.reconnect("s1");
    const p2 = service.reconnect("s1");

    // fetchRemoteCredentials only fires AFTER ensureFresh resolves (one
    // microtask later than the synchronous reconnect entry); flush ticks
    // until the call lands. Then assert it was called ONCE (second reconnect
    // attached to the in-flight promise without re-firing the SDK call).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Now resolve creds → both callers get the same result.
    resolveCreds({
      worker_jwt: "j",
      api_base_url: "https://api.anthropic.com",
      expires_in: 14400,
      worker_epoch: 2,
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(r1.result).toBe("reconnected");
  });

  it("stale onClose from a zombie transport (post-reactive-reattach) is ignored — no new reconnect", async () => {
    // After reactive reattach, the OLD transport's queued onClose can still
    // fire (SDK already had it on the stack). Without the stale-transport
    // guard, that fire would trigger ANOTHER reconnect for a session that
    // already has a fresh transport — racing more attaches + cascading.
    // With the guard: compare firingTransport vs session.transport → ignore.
    const oldTransport = fakeTransport("cse_x", {
      isConnectedOverride: () => false,
    });
    const newTransport = fakeTransport("cse_x");
    const queue = [oldTransport, newTransport];
    let capturedOldOnClose: ((c: number | undefined) => void) | undefined;
    let captureCount = 0;
    const attachSpy = vi.fn(
      async (params: { onClose?: (c: number | undefined) => void }) => {
        captureCount++;
        // Capture the FIRST attach's onClose (old transport's).
        if (captureCount === 1) capturedOldOnClose = params.onClose;
        const next = queue.shift();
        if (next === undefined) throw new Error("test queue exhausted");
        return next;
      },
    );
    const fetchImpl = vi.fn(
      async () =>
        ({
          worker_jwt: "j",
          api_base_url: "https://api.anthropic.com",
          expires_in: 14400,
          worker_epoch: 2,
        }) as Awaited<ReturnType<typeof fetchRemoteCredentials>>,
    );
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist: STUB_PERSIST,
      sdk: {
        fetchRemoteCredentials:
          fetchImpl as unknown as typeof fetchRemoteCredentials,
      },
      setTimer: ((_cb: () => void, _ms: number) =>
        ({}) as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
      clearTimer: () => {},
      attachTransport: attachSpy as unknown as typeof BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // Trigger a reactive reattach. Old transport is dead (isConnected=false)
    // → service swaps to newTransport.
    const r = await service.reconnect("s1");
    expect(r.result).toBe("reconnected");
    expect(r).toMatchObject({ mode: "reactive" });
    // attachTransport called once for initial + once for reactive reattach.
    expect(captureCount).toBe(2);

    // Now simulate the OLD transport's queued onClose firing (post-replace).
    // Should be IGNORED — no new reconnect, no new attach call.
    fetchImpl.mockClear();
    capturedOldOnClose?.(4090);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).not.toHaveBeenCalled(); // no reconnect triggered
  });
});

// ── M3.3 upgrade + downgrade ──────────────────────────────────────────────

/** No-op timers so attach's proactive-refresh arm doesn't leave a real
 *  setTimeout pending across the test (matches the existing tests' pattern). */
const NO_TIMERS = {
  setTimer: (_cb: () => void, _ms: number) =>
    0 as unknown as ReturnType<typeof setTimeout>,
  clearTimer: (_h: ReturnType<typeof setTimeout>) => {},
};
type AttachOverride =
  typeof import("./bridge-transport.ts").BridgeTransport.attach;
const asAttach = (fn: unknown): AttachOverride => fn as AttachOverride;

describe("upgrade (M3.3 pure→bridged + backfill)", () => {
  /** A fake transport that records backfill() calls (the shared fakeTransport
   *  omits backfill — only upgrade uses it). */
  function fakeTransportWithBackfill(cseSessionId = "cse_up") {
    const backfillCalls: unknown[][] = [];
    let closeCalls = 0;
    return {
      cseSessionId,
      get backfillCalls() {
        return backfillCalls;
      },
      get closeCalls() {
        return closeCalls;
      },
      async backfill(msgs: unknown[]) {
        backfillCalls.push(msgs);
      },
      close() {
        closeCalls++;
      },
      write() {},
      sendResult() {},
      reportMetadata() {},
      getSequenceNum: () => 0,
      expiresInSec: 14400,
      async reconnect() {},
      get isConnected() {
        return closeCalls === 0;
      },
    } as unknown as BridgeTransport & {
      backfillCalls: unknown[][];
      closeCalls: number;
    };
  }

  it("attaches fresh, backfills the read history, then marks backfilled", async () => {
    const transport = fakeTransportWithBackfill();
    const markBackfilled = vi.fn(() => undefined);
    const readHistory = vi.fn(async () => [{ type: "user", uuid: "u1" }]);
    const runtime: BridgeAttachableRuntime = { bridge: null };
    const service = new BridgeService({
      oauth: fakeOAuth(),
      home: "/h",
      persist: { ...STUB_PERSIST, markBridgeBackfilled: markBackfilled },
      readHistory,
      attachTransport: asAttach(vi.fn(async () => transport)),
      ...NO_TIMERS,
    });

    const t = await service.upgrade("s1", runtime, { title: "t", cwd: "/w" });

    expect(t).toBe(transport);
    expect(runtime.bridge).toBe(transport); // attach wired the slot
    expect(readHistory).toHaveBeenCalledWith("s1", "/w");
    expect(transport.backfillCalls).toEqual([[{ type: "user", uuid: "u1" }]]);
    expect(markBackfilled).toHaveBeenCalledWith("/h", "s1");
  });

  it("marks backfilled even with empty history (no backfill write)", async () => {
    const transport = fakeTransportWithBackfill();
    const markBackfilled = vi.fn(() => undefined);
    const service = new BridgeService({
      oauth: fakeOAuth(),
      home: "/h",
      persist: { ...STUB_PERSIST, markBridgeBackfilled: markBackfilled },
      readHistory: vi.fn(async () => []),
      attachTransport: asAttach(vi.fn(async () => transport)),
      ...NO_TIMERS,
    });

    await service.upgrade("s1", { bridge: null }, { title: "t", cwd: "/w" });

    expect(transport.backfillCalls).toEqual([]); // empty → skip the flush write
    expect(markBackfilled).toHaveBeenCalledWith("/h", "s1");
  });

  it("does NOT mark backfilled when history read fails (attach still succeeded → bridged)", async () => {
    const transport = fakeTransportWithBackfill();
    const markBackfilled = vi.fn(() => undefined);
    const service = new BridgeService({
      oauth: fakeOAuth(),
      home: "/h",
      persist: { ...STUB_PERSIST, markBridgeBackfilled: markBackfilled },
      readHistory: vi.fn(async () => {
        throw new Error("read failed");
      }),
      attachTransport: asAttach(vi.fn(async () => transport)),
      ...NO_TIMERS,
    });

    const t = await service.upgrade(
      "s1",
      { bridge: null },
      {
        title: "t",
        cwd: "/w",
      },
    );

    expect(t).toBe(transport); // attach succeeded → bridged, just not backfilled
    expect(markBackfilled).not.toHaveBeenCalled();
  });
});

describe("unbridge (downgrade — detach then cloud delete)", () => {
  it("detaches locally (close + clear worker state) then DELETEs the cse_", async () => {
    const transport = fakeTransport("cse_del");
    const clearWorker = vi.fn(() => undefined);
    const deleteCse = vi.fn(async () => true);
    const runtime: BridgeAttachableRuntime = { bridge: null };
    const service = new BridgeService({
      oauth: fakeOAuth(),
      home: "/h",
      persist: { ...STUB_PERSIST, clearBridgeWorkerState: clearWorker },
      readOrgUUID: () => "org_1",
      sdk: { deleteCodeSession: deleteCse },
      attachTransport: asAttach(vi.fn(async () => transport)),
      ...NO_TIMERS,
    });

    await service.attach("s1", runtime, { title: "t", cwd: "/w" });
    expect(runtime.bridge).toBe(transport);

    await service.unbridge("s1");

    expect(transport.closeCalls).toBe(1); // handle closed (detach)
    expect(runtime.bridge).toBe(null); // slot cleared
    expect(clearWorker).toHaveBeenCalledWith("/h", "s1"); // worker state cleared
    expect(deleteCse).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "cse_del",
        organizationUuid: "org_1",
      }),
    );
  });

  it("no-ops the cloud delete when the session isn't attached", async () => {
    const deleteCse = vi.fn(async () => true);
    const service = new BridgeService({
      oauth: fakeOAuth(),
      home: "/h",
      persist: STUB_PERSIST,
      readOrgUUID: () => "o",
      sdk: { deleteCodeSession: deleteCse },
      ...NO_TIMERS,
    });

    await service.unbridge("nope");

    expect(deleteCse).not.toHaveBeenCalled();
  });

  it("local downgrade still completes when the cloud delete fails (best-effort)", async () => {
    const transport = fakeTransport("cse_x");
    const clearWorker = vi.fn(() => undefined);
    const runtime: BridgeAttachableRuntime = { bridge: null };
    const service = new BridgeService({
      oauth: fakeOAuth(),
      home: "/h",
      persist: { ...STUB_PERSIST, clearBridgeWorkerState: clearWorker },
      readOrgUUID: () => "o",
      sdk: { deleteCodeSession: vi.fn(async () => false) }, // cloud delete fails
      attachTransport: asAttach(vi.fn(async () => transport)),
      ...NO_TIMERS,
    });

    await service.attach("s1", runtime, { title: "t", cwd: "/w" });
    await expect(service.unbridge("s1")).resolves.toBeUndefined();

    expect(transport.closeCalls).toBe(1); // detached regardless
    expect(clearWorker).toHaveBeenCalledWith("/h", "s1");
  });

  it("skips the cloud delete when there's no org uuid (still detaches)", async () => {
    const transport = fakeTransport("cse_x");
    const deleteCse = vi.fn(async () => true);
    const runtime: BridgeAttachableRuntime = { bridge: null };
    const service = new BridgeService({
      oauth: fakeOAuth(),
      home: "/h",
      persist: STUB_PERSIST,
      readOrgUUID: () => null, // no org uuid
      sdk: { deleteCodeSession: deleteCse },
      attachTransport: asAttach(vi.fn(async () => transport)),
      ...NO_TIMERS,
    });

    await service.attach("s1", runtime, { title: "t", cwd: "/w" });
    await service.unbridge("s1");

    expect(transport.closeCalls).toBe(1); // detached
    expect(deleteCse).not.toHaveBeenCalled(); // skipped — no org uuid
  });
});
