/**
 * Holds all SessionRuntime instances + an in-memory cache of every
 * sidecode-owned session's metadata for a daemon process. Three responsibilities:
 *
 *   1. `runtimes: Map<sid, SessionRuntime>` — heavyweight SDK-driving
 *      objects (M3.7 disposes the SDK subprocess on idle but the runtime
 *      survives until daemon shutdown).
 *
 *   2. `states: Map<sid, SidecodeSessionMetadata>` — the daemon's
 *      AUTHORITATIVE in-memory copy of every sidecode session's on-disk
 *      metadata. Hydrated once in `setHome`; subsequently mutated in
 *      lockstep with disk via `persistMetadata`. Read path (`notifyStateChanged`,
 *      `getAllSessionStates`) consults this map — never disk — so the
 *      hot fan-out path is allocation-only.
 *
 *   3. `stateListeners` — daemon-wide #17 `subscribeSessions` fan-out.
 *      One listener per iOS peer (router wires via `subscribeSessionStates`).
 *
 * Every runtime created here gets its `onStateChanged` callback wired to
 * the manager's `notifyStateChanged`. When the runtime fires (activity
 * transition / model change), notifyStateChanged compares live fields
 * against the cached state, persists any actual delta (memory + disk),
 * and broadcasts to every listener.
 *
 * Bridge ownership: the `bridge` subtree of `SidecodeSessionMetadata`
 * is owned by `BridgeService` (writeBridgeWorkerState /
 * updateBridgeSequenceNum / markBridgeBackfilled / clearBridgeWorkerState
 * still write disk directly). To prevent manager's full-record writes
 * from clobbering BridgeService's concurrent bridge updates,
 * `persistMetadata` re-reads disk at write time to grab the fresh
 * `bridge` field before writing back. This single disk read is the only
 * read on the hot path — getAllSessionStates / notifyStateChanged are
 * disk-free.
 *
 * Generic over the same event type as SessionRuntime — the daemon picks
 * the concrete type at composition time.
 */

import type { SessionState } from "@thinkite/protocol";
import {
  buildNewSidecodeSession,
  listSidecodeSessions,
  readSidecodeSession,
  type SidecodeSessionMetadata,
  writeSidecodeSession,
} from "../sidecode-sessions.ts";
import {
  SessionRuntime,
  type SessionRuntimeOptions,
} from "./session-runtime.ts";

/**
 * #17 — listener for daemon-wide SessionState fan-out. Router wires one
 * per `subscribeSessions` subscriber; the manager's
 * `subscribeSessionStates` adds it to the listener set.
 *
 * `onChange` fires whenever any SessionState field iOS observes changes
 * (activity / model / lastActivityAt / title / isArchived). Synchronous;
 * listener impl must be cheap.
 *
 * `onRemove` is reserved for V0.5+ — V0 sessions only become archived
 * (`isArchived: true`), never disappear from the list. Kept in the
 * interface for protocol forward-compat.
 */
export interface SessionStateListener {
  onChange: (sessionId: string, state: SessionState) => void;
  onRemove: (sessionId: string) => void;
}

export class SessionRuntimeManager<T> {
  private readonly runtimes = new Map<string, SessionRuntime<T>>();
  private readonly defaultOptions: SessionRuntimeOptions<T>;
  private readonly stateListeners = new Set<SessionStateListener>();
  /** In-memory cache of every sidecode-owned session's on-disk metadata.
   *  Hydrated by `setHome`, mutated in lockstep with disk via
   *  `persistMetadata`. The single source of truth on the hot path
   *  (notifyStateChanged / getAllSessionStates read from here, not disk). */
  private readonly states = new Map<string, SidecodeSessionMetadata>();
  /** Sidecode home dir. Optional so tests can build a memory-only manager
   *  without touching the filesystem (states map stays empty until
   *  caller seeds via createSession + the manager handles persist no-op
   *  paths when home is null). Production daemon calls `setHome` right
   *  after construction in `index.ts`. */
  private home: string | null = null;

  constructor(defaults: SessionRuntimeOptions<T> = {}) {
    this.defaultOptions = defaults;
  }

  /** Bind the sidecode home and hydrate the states cache from disk.
   *  Always re-reads disk — calling twice (same or different home) drops
   *  the prior cache and rebuilds. Production calls this exactly once at
   *  boot; tests use re-call to refresh after fixture writes. The
   *  `runtimes` map is NOT touched (live runtime state survives). */
  setHome(home: string): void {
    this.home = home;
    this.states.clear();
    for (const meta of listSidecodeSessions(home)) {
      this.states.set(meta.cliSessionId, meta);
    }
  }

  has(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  get(sessionId: string): SessionRuntime<T> | undefined {
    return this.runtimes.get(sessionId);
  }

  /**
   * Lazy-create. If a runtime already exists for `sessionId`, returns it
   * unchanged — `options` is only consulted on first creation.
   *
   * #17: every created runtime gets its `onStateChanged` callback wired
   * to the manager's `notifyStateChanged`, overriding any caller-supplied
   * value (V0 has no use case for a caller-owned state callback; the
   * manager is the single fan-out point). `currentModel` is seeded from
   * the in-memory states cache if present so re-attach paths AND the
   * first state snapshot reflect the persisted picker selection without
   * a disk read.
   */
  getOrCreate(
    sessionId: string,
    options?: SessionRuntimeOptions<T>,
  ): SessionRuntime<T> {
    const existing = this.runtimes.get(sessionId);
    if (existing !== undefined) return existing;
    const merged: SessionRuntimeOptions<T> = {
      ...this.defaultOptions,
      ...(options ?? {}),
      // #17 — manager-owned fan-out; caller-supplied onStateChanged would
      // bypass the daemon-wide listener set, which is never what we want.
      onStateChanged: (sid: string) => this.notifyStateChanged(sid),
    };
    const created = new SessionRuntime<T>(sessionId, merged);
    const meta = this.states.get(sessionId);
    if (meta?.model !== undefined) {
      // Direct field assignment — at construction time there are no
      // listeners attached yet, and even if there were, initial-state
      // seeding shouldn't look like a "change" event. (Model is a plain
      // mirror field; the manager owns it directly — there is no
      // runtime-level setter.)
      created.currentModel = meta.model;
    }
    // Seed lastActivityAt from persisted metadata too (same rationale as the
    // model mirror above). Without this, a runtime materialized purely to
    // serve a transcript `subscribe` — i.e. just *viewing* a session —
    // reports the constructor's `Date.now()`, and buildPublicState (which
    // prefers the runtime over meta) re-sorts the just-viewed session to the
    // top of the iOS list. Viewing isn't activity; only `setActivity` (turn
    // start/idle edges) should advance the timestamp forward from here.
    if (meta?.lastActivityAt !== undefined) {
      created.lastActivityAt = meta.lastActivityAt;
    }
    this.runtimes.set(sessionId, created);
    return created;
  }

  /** Drop the runtime for `sessionId`. Returns true iff it existed.
   *  Does NOT delete the on-disk metadata or the in-memory states entry
   *  — those are owned by the session lifecycle (V0 has no delete RPC). */
  delete(sessionId: string): boolean {
    return this.runtimes.delete(sessionId);
  }

  size(): number {
    return this.runtimes.size;
  }

  /** Iterate all live runtimes (used by F3's graceful shutdown). */
  values(): IterableIterator<SessionRuntime<T>> {
    return this.runtimes.values();
  }

  // ─── Mutation API — replaces ad-hoc updateSidecodeSession* helpers ──

  /**
   * Register a freshly-created sidecode session: stamp metadata to both
   * the in-memory cache AND disk, then fan out a #17 envelope so any
   * connected iOS peer sees the row appear.
   *
   * Used by the router's sendPrompt create branch. Builds the metadata
   * via the `buildNewSidecodeSession` factory but the caller still owns
   * the record shape — `meta.cliSessionId` is required and becomes the
   * map key.
   */
  createSession(meta: SidecodeSessionMetadata): void {
    this.states.set(meta.cliSessionId, meta);
    // No model race-guard needed: even when a transcript `subscribe`
    // built the runtime BEFORE this create lands the metadata (so
    // getOrCreate seeded `currentModel` to null), the model still
    // surfaces correctly. notifyStateChanged no longer diffs/persists
    // model on activity edges (so the stale null can't regress
    // states.model), and buildPublicState's `currentModel ?? meta.model`
    // fallback serves the picked model in every fan-out. states.model
    // (set above) is the authoritative source; the runtime mirror is
    // best-effort.
    if (this.home !== null) writeSidecodeSession(this.home, meta);
    this.fanoutStateChanged(meta.cliSessionId);
  }

  /**
   * Convenience: build + register a new sidecode session in one step.
   * Returns the canonical metadata that landed in the cache + disk.
   */
  createSessionFromPrompt(input: {
    cliSessionId: string;
    cwd: string;
    firstPrompt: string;
    model?: string;
    now?: number;
  }): SidecodeSessionMetadata {
    const meta = buildNewSidecodeSession(input);
    this.createSession(meta);
    return meta;
  }

  /**
   * Apply a new model selection (replaces the standalone
   * `updateSidecodeSessionSelection` helper). Mirrors onto the live
   * runtime so the next state-changed envelope reflects it, then
   * persists. Returns true iff the model actually changed.
   *
   * Three call paths cover the model surface area:
   *   - router setSessionSelection (iOS picker)
   *   - bridge.onSetModel (claude.ai picker via CCR control message)
   *   - V0.5+ slash commands / programmatic updates
   *
   * Model persistence + fan-out are OWNED HERE (notifyStateChanged no
   * longer diffs/persists model — see its comment). The live runtime's
   * `currentModel` is a best-effort mirror, set with a direct field
   * assignment (matching getOrCreate's seed); persist + fan-out are
   * explicit below. (There is no runtime-level model setter.)
   */
  setModel(sessionId: string, model: string | undefined): boolean {
    const prev = this.states.get(sessionId);
    if (prev === undefined) return false;
    const prevModel = prev.model ?? null;
    const nextModel = model ?? null;
    if (prevModel === nextModel) return false;

    // Mirror onto the live runtime (if any) so buildPublicState + the
    // SDK-side read reflect the pick immediately. Direct assignment, no
    // onStateChanged — the persist + fan-out are explicit below and cover
    // both the live and no-runtime (model picked pre-first-prompt) cases.
    const runtime = this.runtimes.get(sessionId);
    if (runtime !== undefined) runtime.currentModel = nextModel;
    this.persistMetadata(sessionId, { model });
    this.fanoutStateChanged(sessionId);
    return true;
  }

  /**
   * Set the session title with provenance tracking (replaces the
   * standalone `updateSidecodeSessionTitle` helper). Honors the
   * `titleSource: "user"` lock — a user `/rename` always wins over a
   * later auto-derived title, so daemon-driven auto-fills are silent
   * no-ops when the on-disk record is user-locked.
   *
   * V0 doesn't expose `/rename` yet, so this is only called by future
   * V0.5+ slash-command handler; kept in the manager surface so the
   * eventual wiring is one method call.
   */
  setTitle(
    sessionId: string,
    title: string,
    source: "auto" | "user",
  ): string | undefined {
    const prev = this.states.get(sessionId);
    if (prev === undefined) return undefined;
    if (source === "auto" && prev.titleSource === "user") {
      return prev.title;
    }
    this.persistMetadata(sessionId, { title, titleSource: source });
    this.fanoutStateChanged(sessionId);
    return title;
  }

  /**
   * Re-read a session's metadata from disk into the in-memory cache.
   * Called by BridgeService after `writeBridgeWorkerState` /
   * `updateBridgeSequenceNum` / etc. so the manager's cached
   * `bridge` subtree doesn't go stale. Returns the refreshed record,
   * or undefined if the disk file is missing (the session was deleted
   * out from under us). Safe no-op when home is unset.
   */
  refreshFromDisk(sessionId: string): SidecodeSessionMetadata | undefined {
    if (this.home === null) return undefined;
    const meta = readSidecodeSession(this.home, sessionId);
    if (meta === undefined) {
      this.states.delete(sessionId);
      return undefined;
    }
    this.states.set(sessionId, meta);
    return meta;
  }

  // ─── Read API ──────────────────────────────────────────────────────

  /**
   * Look up a session's persisted metadata (full SidecodeSessionMetadata
   * shape). Returns undefined if the session isn't known.
   *
   * V0 callers: M3.4 startup-reattach reads `bridge` field via this;
   * router's create-vs-resume decision in sendPrompt reads the rest.
   */
  getMetadata(sessionId: string): SidecodeSessionMetadata | undefined {
    return this.states.get(sessionId);
  }

  /**
   * Snapshot every sidecode-owned session's metadata in the cache. Used
   * by M3.4 startup-reattach to enumerate bridged sessions. NOT for iOS
   * fan-out (that goes through `getAllSessionStates` which returns the
   * iOS-facing protocol shape).
   */
  listMetadata(): SidecodeSessionMetadata[] {
    return [...this.states.values()];
  }

  /**
   * Refresh the cached `bridge` subtree from disk + fan out the updated public
   * state. BridgeService writes/clears the worker-state `bridge` field on the
   * session's metadata file DIRECTLY (outside persistMetadata), so the manager
   * cache — the truth source for the iOS-facing `bridged` flag — would
   * otherwise stay stale until the next persistMetadata. Wire this to fire
   * after every bridge attach/detach (index.ts wraps the persist seam) so the
   * `bridged` flag converges live for connected iOS clients.
   *
   * Off the hot path (rare user / boot / recovery action) → the disk re-read
   * is acceptable. No cache entry (attach raced ahead of metadata creation) →
   * still fan out (buildPublicState falls back to runtime); the next
   * persistMetadata reconciles the bridge field.
   */
  notifyBridgeChanged(sessionId: string): void {
    const cached = this.states.get(sessionId);
    if (cached !== undefined && this.home !== null) {
      const disk = readSidecodeSession(this.home, sessionId);
      if (disk?.bridge !== undefined) {
        this.states.set(sessionId, { ...cached, bridge: disk.bridge });
      } else if (cached.bridge !== undefined) {
        const { bridge: _dropped, ...rest } = cached;
        this.states.set(sessionId, rest as SidecodeSessionMetadata);
      }
    }
    this.fanoutStateChanged(sessionId);
  }

  // ─── #17 fan-out ───────────────────────────────────────────────────

  /**
   * Subscribe to daemon-wide SessionState changes.
   *
   * Returns:
   *   - `initial`: a one-time snapshot of every known session
   *     (`getAllSessionStates`). Router emits these via
   *     `subscribeSessions.response.initial` so the iOS TanStack DB
   *     collection seeds without a separate listSessions RPC.
   *   - `unsubscribe`: idempotent closure to detach the listener (used
   *     by router on WebRTC peer disconnect).
   *
   * The listener fires synchronously from inside notifyStateChanged. A
   * throwing listener is caught + isolated so a buggy iOS subscriber
   * can't poison fan-out for other peers.
   */
  subscribeSessionStates(listener: SessionStateListener): {
    initial: Array<{ sessionId: string; state: SessionState }>;
    unsubscribe: () => void;
  } {
    const initial = this.getAllSessionStates();
    this.stateListeners.add(listener);
    return {
      initial,
      unsubscribe: () => {
        this.stateListeners.delete(listener);
      },
    };
  }

  /**
   * Build the iOS-facing SessionState snapshot for every known session.
   * Reads exclusively from in-memory state (states cache + runtimes).
   */
  getAllSessionStates(): Array<{
    sessionId: string;
    state: SessionState;
  }> {
    const allIds = new Set<string>();
    for (const id of this.states.keys()) allIds.add(id);
    for (const id of this.runtimes.keys()) allIds.add(id);
    const out: Array<{ sessionId: string; state: SessionState }> = [];
    for (const id of allIds) {
      const state = this.buildPublicState(id);
      if (state !== null) out.push({ sessionId: id, state });
    }
    return out;
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /**
   * Manager-internal fan-out fired by every SessionRuntime's
   * `onStateChanged` callback. Detects what changed by comparing the
   * runtime's live fields against the cached metadata; persists any
   * actual delta (memory + disk); fans out to listeners.
   *
   * The activity field is NOT persisted — it's transient (lost on
   * daemon restart, reset to "idle" on next hydration); only
   * lastActivityAt + model land on disk.
   *
   * Short-circuits the listener fanout when no listeners are attached.
   */
  private notifyStateChanged(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    const prev = this.states.get(sessionId);
    if (runtime === undefined || prev === undefined) {
      // Either no runtime fired this (impossible — onStateChanged is
      // wired from a SessionRuntime constructor), or no metadata exists
      // for the session (createSession was never called). The latter is
      // a programmer bug for sidecode-owned sessions; treat as a no-op
      // for resilience.
      if (this.stateListeners.size > 0) {
        const state = this.buildPublicState(sessionId);
        if (state !== null) this.fanoutFromState(sessionId, state);
      }
      return;
    }

    // This fires on activity transitions only (setActivity stamps a fresh
    // lastActivityAt; model changes go through manager.setModel, which
    // doesn't route here). We persist ONLY lastActivityAt — model is
    // deliberately NOT diffed/persisted.
    //
    // Why model is excluded: model persistence is owned by `setModel`
    // (and the initial value by `createSession`), which write
    // states.model explicitly. `runtime.currentModel` is just a mirror,
    // and it can be stale-null when a transcript `subscribe` built the
    // runtime before the create landed the metadata (getOrCreate had no
    // meta to seed from). If we diffed it here, the first
    // setActivity("running") edge would see currentModel(null) !==
    // states.model(picked) and REGRESS the persisted model to undefined.
    // buildPublicState's `runtime.currentModel ?? meta.model` fallback
    // already serves the right model in the fan-out, so dropping the
    // diff removes the regression class entirely (this is what let the
    // old createSession race-guard go away).
    //
    // Monotonic guard on lastActivityAt: only advance forward, never
    // regress. Defends against (a) clock adjustments / NTP rollback,
    // and (b) the runtime's `Date.now()` construction stamp being
    // older than a disk-loaded value (e.g. a session that hadn't seen
    // a turn in a long time but was hydrated with a recent disk
    // timestamp from before the daemon restart).
    if (runtime.lastActivityAt > prev.lastActivityAt) {
      this.persistMetadata(sessionId, {
        lastActivityAt: runtime.lastActivityAt,
      });
    }

    if (this.stateListeners.size === 0) return;
    const state = this.buildPublicState(sessionId);
    if (state !== null) this.fanoutFromState(sessionId, state);
  }

  /**
   * Apply a partial patch to the cached metadata + disk in lockstep.
   * The `bridge` subtree is intentionally excluded from the patch type
   * — it's owned by BridgeService, which writes through its own disk
   * helpers. Before writing the full record back to disk, we re-read
   * disk to grab the fresh `bridge` field so we don't clobber a
   * concurrent BridgeService write.
   *
   * The disk re-read is the only disk read on the write path; reads
   * via getMetadata / getAllSessionStates / notifyStateChanged stay
   * memory-only.
   */
  private persistMetadata(
    sessionId: string,
    patch: Partial<Omit<SidecodeSessionMetadata, "bridge">>,
  ): void {
    const prev = this.states.get(sessionId);
    if (prev === undefined) return;
    const next: SidecodeSessionMetadata = { ...prev, ...patch };
    this.states.set(sessionId, next);
    if (this.home === null) return;

    // Re-read disk to grab fresh bridge state (BridgeService writes
    // bridge.* independently — manager's cache might be slightly stale
    // for that subtree). User fields come from our cache; bridge field
    // comes from disk.
    const disk = readSidecodeSession(this.home, sessionId);
    let toWrite: SidecodeSessionMetadata;
    if (disk?.bridge !== undefined) {
      toWrite = { ...next, bridge: disk.bridge };
      // Keep our cache's bridge subtree in sync with disk so subsequent
      // M3.4 reads (via getMetadata) see the latest.
      this.states.set(sessionId, toWrite);
    } else {
      // No bridge field on disk — drop it from our write payload too.
      const { bridge: _, ...rest } = next;
      toWrite = rest as SidecodeSessionMetadata;
      // Cache might still have a stale bridge subtree from before
      // BridgeService cleared it; mirror disk reality.
      if (next.bridge !== undefined) this.states.set(sessionId, toWrite);
    }
    writeSidecodeSession(this.home, toWrite);
  }

  /** Build the iOS-facing SessionState for one session from in-memory state. */
  private buildPublicState(sessionId: string): SessionState | null {
    const meta = this.states.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (meta === undefined && runtime === undefined) return null;
    const fallbackTs = meta?.createdAt ?? Date.now();
    return {
      activity: runtime?.activity ?? "idle",
      model: runtime?.currentModel ?? meta?.model ?? null,
      lastActivityAt:
        runtime?.lastActivityAt ?? meta?.lastActivityAt ?? fallbackTs,
      title: meta?.title ?? "",
      cwd: meta?.cwd ?? "",
      createdAt: meta?.createdAt ?? fallbackTs,
      isArchived: meta?.isArchived ?? false,
      permissionMode: meta?.permissionMode ?? "bypassPermissions",
      // Derived from worker-state presence (BridgeService writes/clears the
      // `bridge` subtree on attach/detach). Kept fresh in the cache by
      // persistMetadata's disk-merge + notifyBridgeChanged on bridge changes.
      bridged: meta?.bridge !== undefined,
    };
  }

  /** Build the public state then fan out to all listeners. */
  private fanoutStateChanged(sessionId: string): void {
    if (this.stateListeners.size === 0) return;
    const state = this.buildPublicState(sessionId);
    if (state === null) return;
    this.fanoutFromState(sessionId, state);
  }

  /** Fan out a pre-built state to all listeners, isolating each listener
   *  throw so a flaky iOS subscriber can't break sibling fan-out or the
   *  runtime's tight onStateChanged callback that triggered us. */
  private fanoutFromState(sessionId: string, state: SessionState): void {
    for (const listener of this.stateListeners) {
      try {
        listener.onChange(sessionId, state);
      } catch {
        // Isolation: don't poison sibling listeners or the caller.
      }
    }
  }

  // ─── Shutdown ──────────────────────────────────────────────────────

  /**
   * Daemon-shutdown drain: for every runtime in parallel, fire `query.close()`
   * (which kicks off SDK's internal 5s grace + abort fallback) then await
   * the runtime's `loopPromise` so the consumer loop's finally{} block runs
   * before this method returns. The await is bounded by `timeoutMs` per
   * runtime to keep a stuck loop from hanging the whole shutdown.
   *
   * Drops every entry from the map afterward, regardless of whether each
   * runtime drained cleanly or timed out — process is exiting either way,
   * leaking entries is harmless.
   *
   * `query.close()` is the only correct daemon-shutdown call for V0:
   *   - SDK doc claims `close()` is "forceful" but the actual sdk.mjs
   *     impl does inputStream.done() + 5s grace timer before abort.
   *   - `interrupt()` would speed shutdown of in-flight turns from ~5s to
   *     ~hundreds of ms, but only matters if shutdown latency is felt.
   *     Keep this method simple; revisit if measured shutdowns lag.
   *
   * See project_session_replay_model memory for the full lifecycle policy
   * and why `inputChannel.end()` is redundant here (close() already calls
   * `inputStream.done()` on the SDK's wrapper).
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const tasks = [...this.runtimes.values()].map(async (runtime) => {
      try {
        runtime.query?.close();
      } catch {
        // close() is sync void and shouldn't throw, but defensive.
      }
      if (runtime.loopPromise) {
        // Per-runtime timeout: a stuck loop shouldn't hang the whole drain.
        // Outer process-level forceExit (in bin/thinkite.ts) is the final
        // safety net for catastrophic hangs.
        await Promise.race([
          runtime.loopPromise.catch(() => {}),
          new Promise<void>((resolve) => {
            setTimeout(resolve, timeoutMs).unref();
          }),
        ]);
      }
    });
    await Promise.all(tasks);
    this.runtimes.clear();
  }
}
