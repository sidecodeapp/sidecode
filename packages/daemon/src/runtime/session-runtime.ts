import type { TimelineItem, TurnUsage } from "@thinkite/protocol";

/**
 * Per-session in-memory state for streaming/live messaging. Holds:
 *   - a ring buffer of events the daemon has pushed (for replay on subscribe)
 *   - a monotonic cursor assigned on each addEvent
 *   - a set of live subscriber callbacks (for fanout)
 *   - a slot for the SDK Query handle (populated by F2's run-query)
 *   - in-memory settled snapshot (refreshed at turn boundaries by run-query)
 *     so subscribe-time cold path can serve atomically from memory instead
 *     of racing with the live event stream over an async JSONL read
 *
 * Generic over `T` so callers can store whatever payload type makes sense
 * (TimelineItem delta, raw SDK message, etc.). F1 stays decoupled from the
 * SDK — only shapes the data + lifecycle.
 *
 * Buffer semantics:
 *   - cursors start at 1; `sinceCursor: 0` means "replay everything"
 *   - `subscribe(cb, sinceCursor=0)` synchronously replays buffered events
 *     with `cursor > sinceCursor`, then keeps cb in the subscriber set
 *   - if the requested `sinceCursor` is older than `oldestCursor`, caller
 *     is responsible for filling the gap from settled state (JSONL on disk
 *     via getSessionMessages) — runtime only guarantees what's in the ring
 *   - bufferCap defaults to 500 events
 *
 * Settled semantics:
 *   - `settled` is null until something populates it: either run-query's
 *     turn-boundary refresh (after each `result` envelope) or a lazy
 *     cold-path init from the router's subscribe handler.
 *   - `settledCursor` is the cursor that `settled` corresponds to — i.e.
 *     replay of buffer events with cursor > settledCursor reconstructs
 *     state from settled onward. Set atomically with `settled`.
 *   - The settled snapshot is for OUR own runtime's session. For sessions
 *     replayed from disk (no SDK loop running here), settled stays null
 *     and cold path always reads JSONL fresh.
 */

/**
 * Just the lifecycle methods we care about from the SDK Query type.
 * F2 assigns a real SDK Query (which structurally satisfies this) — no
 * changes to this file needed when SDK signatures evolve, as long as
 * `interrupt`/`close` shapes stay stable.
 */
export interface RuntimeQueryHandle {
  /** Return value intentionally ignored — SDK 0.3.206 started resolving
   *  with an SDKControlInterruptResponse (was void); `unknown` accepts
   *  both and keeps callers from depending on it. */
  interrupt(): Promise<unknown>;
  close(): void;
  /** Mid-session model swap. Router's `setSessionSelection` handler
   *  uses this. Passing `model` via applyFlagSettings behaves
   *  identically to the dedicated `setModel()` setter per upstream
   *  docs — so we use this one and skip setModel.
   *
   *  Optional in this interface because router tests inject a stub
   *  query without it; production SDK `Query` always has the method
   *  (sdk.d.ts:2178). */
  applyFlagSettings?(settings: { model?: string | null }): Promise<void>;
}

/**
 * Structural slot for an `AsyncMessageInput<SDKUserMessage>` channel that
 * F2 stuffs in. We intentionally avoid importing the SDK type here so
 * SessionRuntime stays a pure data structure — `push` taking `unknown`
 * is contravariant-friendly and a typed `AsyncMessageInput<T>` assigns
 * cleanly. F2 holds the typed reference internally for actual pushing.
 */
export interface RuntimeInputChannel {
  push(msg: unknown): void;
  end(): void;
}

/**
 * Structural slot for the CCR bridge mirror (BridgeTransport, slice M1).
 * The query loop forwards each raw SDKMessage here in parallel with the
 * enriched EventDelta fan-out, so a bridged session streams to claude.ai
 * without SessionRuntime importing the SDK or the @alpha `/bridge` types.
 *
 * `write` takes `unknown` (same SDK-decoupling rationale as
 * `RuntimeInputChannel.push`) — BridgeTransport holds the typed SDKMessage
 * internally. Lifecycle is owned by BridgeTransport, NOT the query loop:
 * the loop's finally clears query/inputChannel/loopPromise but deliberately
 * leaves `bridge` intact, so a bridge outlives an idle (lazy) query — the
 * multiplex invariant from project_sidecode_ccr_architecture.
 */
export interface RuntimeBridge {
  /** Forward one raw SDKMessage to the cloud mirror (non-result frames). */
  write(msg: unknown): void;
  /** Signal turn completion (claude.ai stops its "working" spinner). */
  sendResult(): void;
  /**
   * Report the session's busy/idle state to the CCR worker endpoint so
   * claude.ai shows it as running vs idle. `"running"` on turn start,
   * `"idle"` on turn end. (`"requires_action"` is for permission prompts —
   * V0 deferred per project_no_plan_mode_v0 / no can_use_tool wiring; revisit
   * when iOS gains an approval sheet.) Empirically REQUIRED: without it a
   * bridged session never enters `running` on claude.ai (verified in M1.5
   * spike — see project_sidecode_ccr_architecture).
   */
  reportState(state: "idle" | "running" | "requires_action"): void;
  /**
   * M3.1 checkpoint — snapshot the current SSE high-water mark to
   * persisted bridge worker state so M3.4 startup re-attach can resume
   * with `initialSequenceNum = saved` and the server replays only seq >
   * saved (EXCLUSIVE → at-least-once, no double-execute). Called from
   * forwardToBridge's `result` branch (one fire per turn-complete).
   *
   * Optional on the interface because tests / spike fakes don't need to
   * implement it; the production BridgeTransport always does. No-op
   * after close and on transports constructed without a persist callback.
   */
  checkpoint?(): void;
  /**
   * #17 — PUT /worker external_metadata so other CCR clients (multi-tab
   * claude.ai, future server-side viewers) see the latest control-plane
   * state. Sidecode uses this to broadcast model changes:
   * setSessionSelection (iOS-driven) and bridge.onSetModel (CCR-driven)
   * both forward `{ model }` here so any peer reading worker metadata
   * sees the new value immediately, without waiting for the next
   * assistant frame's per-turn `message.model` field.
   *
   * Caller passes the FULL metadata object — the SDK does PUT semantics
   * (replace, not merge) per `bridge.d.ts:77`. V0 only sends `{ model }`;
   * future branch/dir reporting will accumulate via a manager-side bag.
   *
   * Optional on the interface (test fakes can skip). Production
   * BridgeTransport implements; best-effort + no-op after close.
   */
  reportMetadata?(metadata: Record<string, unknown>): void;
  /** Tear down the bridge transport. */
  close(): void;
}

export interface RuntimeEvent<T> {
  /** Monotonically increasing per-runtime; assigned by addEvent. */
  cursor: number;
  payload: T;
}

export type Subscriber<T> = (event: RuntimeEvent<T>) => void;

/** Session activity state — CCR's `session_status` enum, mirrored on the
 *  iOS protocol (issue #17 — cross-client broadcast). V0 emits only `idle |
 *  running`; `requires_action` is reserved for V0.5+ permission flow. */
export type SessionActivity = "idle" | "running" | "requires_action";

export interface SessionRuntimeOptions<T> {
  /** Max events retained in the ring. Oldest evicted on overflow. */
  bufferCap?: number;
  /**
   * Continuous-fold reducer. When set, `addEvent` applies each delta to
   * the in-memory `settled` snapshot (if non-null), keeping it current so
   * the cold path serves a complete snapshot with `settledCursor ==
   * currentCursor` — no per-turn JSONL re-read. Production wires
   * `foldEventDelta` (messages/fold.ts), which mirrors the iOS reducer.
   * Left unset in tests that don't exercise the fold.
   */
  foldDelta?: (settled: TimelineItem[], delta: T) => TimelineItem[];
  /** Test seams for M3.7 idle-teardown timer — inject mock
   *  setTimeout/clearTimeout to drive the dispose schedule synchronously
   *  in tests. Default = real Node timers. Same pattern as
   *  BridgeService.setTimer / OAuthRefreshManager. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Delay for the idle-teardown timer (ms). Default `15 * 60_000` (matches
   *  Claude Desktop's empirical policy `0 subs + idle 15min`). Tunable via
   *  this seam without rebuilding the manager — tests use small values
   *  (e.g. 100ms) for fast assertions. */
  teardownDelayMs?: number;
  /** Optional logger for M3.7 teardown lifecycle events. Default no-op so
   *  the pure-data-structure contract isn't violated by stray stdout.
   *  Production = `(msg) => console.log("[sidecode] " + msg)` wired via
   *  SessionRuntimeManager defaults. Receives pre-formatted messages
   *  ("[teardown] armed session=..." etc.) without sidecode prefix —
   *  injector adds it. */
  log?: (msg: string) => void;
  /** #17 — fires when a state field iOS subscribers care about changes:
   *  `activity` (idle ↔ running transition), `currentModel` (mid-session
   *  swap via router setSessionSelection / bridge onSetModel), and
   *  `lastActivityAt` (bumped on every setActivity call, both running and
   *  idle edges so iOS list sort by recency reflects active turns).
   *
   *  Synchronous fan-out — SessionRuntimeManager wires this to its
   *  daemon-wide listener set, hydrates disk-side static fields (title /
   *  cwd / createdAt / isArchived / permissionMode), and emits a
   *  `session_state_changed` envelope to every subscribeSessions subscriber. Callback impl must be cheap (no async
   *  work inside) since it runs on every activity edge of every session.
   *  No-op by default so the pure-data-structure contract isn't violated
   *  in tests that don't wire the manager.
   */
  onStateChanged?: (sessionId: string) => void;
}

export class SessionRuntime<T> {
  readonly sessionId: string;
  /** SDK query handle slot; populated by F2 when ensureSessionLoop spawns query(). */
  query: RuntimeQueryHandle | null = null;
  /** Streaming-input channel; populated by F2 alongside `query`. Used by F2's pushPrompt to feed new user prompts into the live SDK process. */
  inputChannel: RuntimeInputChannel | null = null;
  /** Promise that resolves when F2's consumer loop exits (graceful close, error, or natural end-of-iterator). Null when no loop is active. F3's daemon shutdown awaits this per runtime. */
  loopPromise: Promise<void> | null = null;

  /** CCR bridge mirror slot (slice M1). Null = pure session (WebRTC only).
   *  Set by BridgeTransport.attach, cleared by its detach — NOT by the query
   *  loop's finally (a bridge must outlive an idle lazy query). When non-null,
   *  the consumer loop forwards each raw SDKMessage here, and pushPrompt
   *  mirrors the user prompt — see run-query's `forwardToBridge`. */
  bridge: RuntimeBridge | null = null;

  /** In-memory normalized snapshot of the transcript, so cold-path
   *  subscribes serve directly from memory. Maintained by CONTINUOUS FOLD:
   *  `addEvent` applies each delta via `foldDelta` (mirrors the iOS
   *  reducer + normalize.ts), so settled stays current with zero JSONL
   *  re-reads — no dependency on the SDK's async flush timing. Null until
   *  seeded: the create-mode `[]` seed (run-query) for sessions we drive,
   *  or the router's cold-path `deps.getMessages` lazy-init for resumed
   *  sessions; folding resumes once non-null. Imports TimelineItem from
   *  protocol because that's the one shape we stash. */
  settled: TimelineItem[] | null = null;
  /** Cursor that `settled` corresponds to. With continuous fold this
   *  tracks `currentCursor` (settled reflects every event so far), so the
   *  cold-path replay window (settledCursor, currentCursor] is empty —
   *  settled IS the full snapshot. (Set to currentCursor on each fold; set
   *  by the router's lazy-init read for the no-fold seed case.) */
  settledCursor = 0;
  /** Latest turn usage stats (input tokens / cache tokens). Updated
   *  live whenever a `turn_completed` event is added with usage AND
   *  reloaded at turn-boundary refresh as belt-and-suspenders. Null
   *  for sessions whose most recent turn was tool-only or that haven't
   *  completed a turn yet on this runtime. */
  latestUsage: TurnUsage | null = null;
  /** Set by the interrupt RPC (router) right before `query.interrupt()`.
   *  On interrupt the SDK ends the in-flight turn with an
   *  `error_during_execution` result envelope; this flag tells
   *  handleResultEnvelope (and the loop's catch) to treat that as a user
   *  cancel — the router already emitted `turn_canceled` — instead of
   *  surfacing a spurious `turn_failed`. Consumed (reset) when that
   *  terminal envelope / throw is handled, on the next prompt, and on
   *  loop exit, so it never leaks into a later turn. */
  interrupted = false;

  /** M3.7 idle-teardown clock + #17 iOS list sort key — epoch ms of the
   *  most recent activity edge (BOTH `running` AND `idle`, set by every
   *  `setActivity()` call via run-query's markActivity helper).
   *
   *  Used by:
   *    - M3.7 teardown timer's `[teardown] fired idleDurationMs=...` log
   *      (computed at fire time as `Date.now() - lastActivityAt`); since
   *      the timer can only arm + fire while activity is `idle` and
   *      lastActivityAt was just stamped at idle-entry, the field acts as
   *      the idle-entry timestamp for the teardown path.
   *    - #17 iOS session list — sorted by `lastActivityAt` desc so the
   *      session the user just sent a prompt into (running edge) jumps to
   *      the top immediately, not only after the turn completes.
   *
   *  Initialized to construction time so a never-used runtime's clock
   *  has a sensible value. */
  lastActivityAt: number = Date.now();

  /** M3.7.4 / #17 current activity state. Mirrors Claude Code's
   *  bridge.reportState contract (`idle | running | requires_action`).
   *  Set by `setActivity()` (called from run-query's markActivity at the
   *  3 reportState edges); also gates the teardown timer (arm only when
   *  `idle`). Reserved enum value `requires_action` not emitted in V0. */
  activity: SessionActivity = "idle";

  /** #17 — current model selection for this runtime. `null` = "let SDK
   *  pick default" (honors the user's account / Desktop `Settings.model`
   *  per upstream docs). A best-effort MIRROR — `SidecodeSessionMetadata
   *  .model` (the manager's `states` cache) is the authoritative source.
   *  Written by `SessionRuntimeManager` only, via direct field assignment:
   *    - `getOrCreate` seeds it from on-disk metadata at first hydration
   *    - `setModel` mirrors the new pick (router setSessionSelection /
   *      bridge onSetModel) after `applyFlagSettings({model})` succeeds
   *
   *  Read by `buildPublicState` as `currentModel ?? meta.model` (so a
   *  stale-null mirror falls back to the authoritative metadata) → iOS
   *  via `session_state_changed.state.model`. NOT the source of truth for
   *  the *next* spawn — `ensureSessionLoop` reads `options.model` from the
   *  router call site (which reads disk). This field is the *live*
   *  selection applyFlagSettings has applied to the running query. */
  currentModel: string | null = null;

  private readonly bufferCap: number;
  private readonly buffer: RuntimeEvent<T>[] = [];
  private readonly subscribers = new Set<Subscriber<T>>();
  private nextCursor = 1;
  private readonly foldDelta?: (
    settled: TimelineItem[],
    delta: T,
  ) => TimelineItem[];

  // M3.7 idle-teardown timer + injection seams (see SessionRuntimeOptions).
  private teardownTimer?: ReturnType<typeof setTimeout>;
  private readonly setTimer: (
    cb: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly teardownDelayMs: number;
  private readonly log: (msg: string) => void;
  // #17 state-changed callback — fired from setActivity on meaningful
  // transitions. Default no-op so the standalone pure-data-structure
  // contract holds (tests + manager-less callers). Model changes do NOT
  // fire it: model is owned by SessionRuntimeManager (direct mirror +
  // explicit persist/fan-out), so currentModel is set without a callback.
  private readonly onStateChanged: (sessionId: string) => void;

  constructor(sessionId: string, options: SessionRuntimeOptions<T> = {}) {
    this.sessionId = sessionId;
    this.bufferCap = options.bufferCap ?? 500;
    this.foldDelta = options.foldDelta;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.teardownDelayMs = options.teardownDelayMs ?? 15 * 60_000;
    this.log = options.log ?? (() => {});
    this.onStateChanged = options.onStateChanged ?? (() => {});
  }

  /** Cursor of the oldest event still in the buffer, or null if empty. */
  get oldestCursor(): number | null {
    return this.buffer[0]?.cursor ?? null;
  }

  /** Cursor of the most-recently assigned event, or 0 if no events yet. */
  get currentCursor(): number {
    return this.nextCursor - 1;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * True iff no live subscribers and no active SDK query. V0 doesn't
   * auto-GC idle runtimes (see project_session_replay_model memory) — this
   * is an introspection helper for tests + a future opt-in GC pass.
   */
  get isIdle(): boolean {
    return this.subscribers.size === 0 && this.query === null;
  }

  /**
   * Append an event. Assigns the next cursor, evicts the oldest if the
   * buffer is over cap, then fanouts synchronously to all subscribers.
   *
   * Subscriber exceptions propagate — caller wraps callbacks that may
   * throw. (V0 producers are internal so we trust them.)
   */
  addEvent(payload: T): RuntimeEvent<T> {
    const event: RuntimeEvent<T> = { cursor: this.nextCursor++, payload };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferCap) {
      this.buffer.shift();
    }
    // Continuous fold: keep `settled` current (settledCursor == this event)
    // so the cold path serves a complete in-memory snapshot with an empty
    // replay window — no per-turn JSONL re-read. Only folds once `settled`
    // is initialized (the create-mode `[]` seed, or the subscribe lazy-init
    // JSONL read); a null `settled` means "no snapshot yet — the next
    // subscribe seeds it from disk", and folding resumes after that. The
    // buffer above is untouched, so warm-reconnect replay is unaffected.
    if (this.settled !== null && this.foldDelta !== undefined) {
      this.settled = this.foldDelta(this.settled, payload);
      this.settledCursor = event.cursor;
    }
    for (const cb of this.subscribers) {
      cb(event);
    }
    return event;
  }

  /**
   * Subscribe `cb` to the event stream. Synchronously replays buffered
   * events with `cursor > sinceCursor`, then registers `cb` for future
   * fanouts. Returns an idempotent unsubscribe closure.
   *
   * Replay-then-attach order is deliberate: a callback that triggers
   * `addEvent` reentrantly during replay won't receive that new event on
   * this subscribe call — it lands in the buffer (and reaches future
   * subscribers via replay), but doesn't roundtrip mid-iteration. This
   * keeps replay ordering monotonic and avoids replay/live interleaving
   * weirdness. Production callers (router-side ws fanout) don't trigger
   * addEvent from inside the callback, so this only matters for tests.
   */
  subscribe(cb: Subscriber<T>, sinceCursor = 0): () => void {
    const replayStart = this.buffer.findIndex((e) => e.cursor > sinceCursor);
    if (replayStart >= 0) {
      const replay = this.buffer.slice(replayStart);
      for (const event of replay) {
        cb(event);
      }
    }
    this.subscribers.add(cb);
    // M3.7.5 — a sub just joined; user is watching. Cancel any pending
    // teardown timer (set when the LAST sub left, or at turn-complete with
    // no subs). Idempotent — no-op when nothing was armed. Mirrors Claude
    // Desktop's policy (`0 subs + idle 15min → teardown`); sub presence
    // means we MUST keep the query warm for the watcher.
    if (this.cancelTeardownTimer()) {
      this.log(
        `[teardown] canceled session=${this.sessionId} reason=subscribe`,
      );
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.subscribers.delete(cb);
      // M3.7.5 — last sub left + session idle → arm teardown countdown.
      // No-op if other subs still present, query already null, or activity
      // is "running" (mid-turn).
      this.armIfEligibleForTeardown();
    };
  }

  /**
   * Remove `cb` if present; returns true iff it was in the set. Equivalent
   * to calling the closure returned by `subscribe`, but useful when the
   * caller didn't keep that closure (e.g. ws.onclose iterating subscribers
   * registered through different paths).
   */
  unsubscribe(cb: Subscriber<T>): boolean {
    const removed = this.subscribers.delete(cb);
    // M3.7.5 — symmetric with the subscribe-returned closure's arm path.
    if (removed) this.armIfEligibleForTeardown();
    return removed;
  }

  // ─── M3.7 idle-teardown ────────────────────────────────────────────────
  //
  // Goal: after a session's query has been idle for N minutes, kill the
  // ~250MB claude SDK subprocess to free RAM. Runtime SURVIVES (bridge,
  // subscribers, persisted state all stay) — only the heavyweight subprocess
  // goes. Next sendPrompt / bridge inbound triggers a fresh respawn via the
  // existing ensureSessionLoop path (~500ms-1s cold-start cost, mostly
  // invisible to UX since network RTT dominates).
  //
  // Policy: subscriber-presence is NOT a keep-alive signal — iOS watching
  // a transcript doesn't need the query process (transcript is settled +
  // historical fold). Bridge presence is NOT a keep-alive signal either —
  // bridge inbound's ensureSessionLoop call respawns on demand. So the
  // single dispose predicate is "loopPromise.settled && no new turn for N
  // min", driven entirely off the turn-complete edge (handleResultEnvelope).

  /**
   * Arm the idle-teardown timer. Cancels any prior pending timer first so
   * it's idempotent (a turn-complete edge mid-turn-N-of-many resets the
   * clock cleanly). When the timer fires, `onFire` runs — caller's
   * responsibility to invoke `disposeQuery()` + emit any structured logs.
   *
   * `.unref()` lets the daemon exit even with a pending timer (same pattern
   * as BridgeService.armProactiveRefresh). In Node `setTimeout` returns a
   * Timeout that has .unref(); test-injected timers may not, so guard.
   *
   * On fire: the internal wrapper synchronously clears `teardownTimer`
   * BEFORE invoking `onFire`, so `hasTeardownTimerArmed` accurately
   * reports `false` once the timer has truly elapsed (otherwise the
   * field would dangle pointing at the expired handle).
   */
  armTeardownTimer(delayMs: number, onFire: () => void): void {
    this.cancelTeardownTimer();
    const handle = this.setTimer(() => {
      // Auto-clear field on fire so post-fire state is clean. cancelTeardownTimer
      // after fire is a no-op (no field set), preserving idempotency.
      this.teardownTimer = undefined;
      onFire();
    }, delayMs);
    if (
      typeof (handle as unknown as { unref?: () => void }).unref === "function"
    ) {
      (handle as unknown as { unref: () => void }).unref();
    }
    this.teardownTimer = handle;
  }

  /**
   * M3.7.4 — update the activity state. Internal dedupe on the activity
   * enum (no-op transition if same). Returns the timer-side effects so
   * callers (run-query's markActivity) can emit structured logs without
   * re-deriving the predicate. Side effects:
   *
   *   - "running" → cancel any pending teardown timer (turn in flight,
   *     either user-driven via pushPrompt OR autonomous SDK yield via
   *     forwardToBridge first model frame — both are activity edges)
   *   - "idle" → arm teardown timer IFF eligible
   *     (`subscribers.size === 0 && query !== null`). Subscriber-gating
   *     matches Claude Desktop's empirical policy: watching = keep warm;
   *     nobody watching = reclaim after delay.
   *   - "requires_action" → reserved (V0 never emits); semantically
   *     close to "running" — cancel teardown.
   *
   * BOTH edges stamp `lastActivityAt = now` (#17): the iOS list sorts by
   * this field, so the row should jump to the top as soon as the user
   * sends a prompt (running edge), not only when the turn completes (idle
   * edge). For the teardown log's `idleDurationMs` accuracy: the timer
   * can only arm + fire while activity is `idle`, so the stamp at idle
   * entry is what gets read at fire time — `delayMs` (15min) is the
   * dominant term, the running-edge stamp doesn't pollute it.
   *
   * #17 onStateChanged callback fires:
   *   - on activity transition (`changed === true`) — fan-out the new
   *     `activity` field via SessionStateChanged envelope
   *   - on every idle-entry re-stamp even when activity already idle (the
   *     `lastActivityAt` field changed → iOS list sort changes) — V0
   *     callers never re-emit idle twice for one turn so this branch is
   *     dormant, but the invariant "callback fires whenever a field iOS
   *     subscribers see has changed" is preserved.
   *
   * Returns `{ changed, armed, canceled }` so caller can decide which
   * structured logs to emit. `armed`/`canceled` are timer transitions,
   * NOT subsumed by `changed`.
   */
  setActivity(state: SessionActivity): {
    changed: boolean;
    armed: boolean;
    canceled: boolean;
  } {
    const changed = this.activity !== state;
    this.activity = state;
    // #17 — BOTH edges stamp lastActivityAt so iOS list sort reflects
    // user-initiated activity instantly (not waiting for turn complete).
    this.lastActivityAt = Date.now();
    let armed = false;
    let canceled = false;
    if (state === "idle") {
      armed = this.armIfEligibleForTeardown();
    } else {
      // running / requires_action — activity in flight, MUST cancel any
      // pending teardown to avoid mid-turn dispose.
      canceled = this.cancelTeardownTimer();
    }
    // #17 fan-out: only when activity transitioned (avoids spammy idle→idle
    // notifications). lastActivityAt-only updates without an activity
    // transition can't happen in V0 (setActivity is always called with the
    // edge-appropriate enum), so the changed-gate is the right predicate.
    if (changed) this.onStateChanged(this.sessionId);
    return { changed, armed, canceled };
  }

  // NOTE: there is no `setModel` here. Model is owned by
  // SessionRuntimeManager — `getOrCreate` seeds `currentModel` and
  // `manager.setModel` mirrors it via direct field assignment, then
  // persists + fans out explicitly. A runtime-level setter that fired
  // `onStateChanged` used to exist but caused the model to be diffed on
  // state edges (the create/subscribe race regression); it's gone.

  /**
   * Arm the idle-teardown timer iff ALL eligibility predicates hold:
   *   1. `activity === "idle"` (not mid-turn)
   *   2. `subscribers.size === 0` (no iOS watcher to keep warm) — M3.7.5
   *   3. `query !== null` (something to actually dispose)
   *
   * Returns true iff arm succeeded. Used by both `setActivity("idle")`
   * (turn-complete edge) AND `unsubscribe()` (last-sub-left edge) — same
   * predicate, two trigger points. Idempotent: re-arming over an
   * already-armed timer just resets the clock (intentional — most-recent
   * idle edge wins).
   *
   * The fire callback: log + `disposeQuery()`. Reads `lastActivityAt` at
   * fire time (not arm time) so the log accurately reports the actual
   * idle duration — useful when a sub-leave-triggered arm fires long
   * after the last turn (`idleDurationMs ≈ readingTime + delay`). Since
   * setActivity stamps lastActivityAt on BOTH running and idle edges,
   * but the timer only arms after an idle edge, the stamp at fire time
   * still corresponds to the idle-entry timestamp — no contamination
   * from earlier running edges in the same turn.
   */
  private armIfEligibleForTeardown(): boolean {
    if (this.activity !== "idle") return false;
    if (this.subscribers.size !== 0) return false;
    if (this.query === null) return false;
    this.armTeardownTimer(this.teardownDelayMs, () => {
      const idleDurationMs = Date.now() - this.lastActivityAt;
      this.log(
        `[teardown] fired session=${this.sessionId} idleDurationMs=${idleDurationMs}`,
      );
      this.disposeQuery();
    });
    this.log(
      `[teardown] armed session=${this.sessionId} delayMs=${this.teardownDelayMs}`,
    );
    return true;
  }

  /**
   * Cancel the pending teardown timer. Returns `true` iff one was actually
   * armed (lets callers gate "canceled" logging on the meaningful case —
   * a no-op cancel during first-ever ensureSessionLoop shouldn't log).
   */
  cancelTeardownTimer(): boolean {
    if (this.teardownTimer === undefined) return false;
    this.clearTimer(this.teardownTimer);
    this.teardownTimer = undefined;
    return true;
  }

  /** Test/introspection helper: whether the teardown timer is currently armed. */
  get hasTeardownTimerArmed(): boolean {
    return this.teardownTimer !== undefined;
  }

  /**
   * Synchronous tear-down of the SDK query subprocess. Claims the runtime
   * slots IMMEDIATELY (so a racing ensureSessionLoop sees `query/inputChannel/
   * loopPromise === null` and spawns a fresh process) + best-effort closes
   * the old SDK channel + handle. The OLD consumer loop's finally still
   * runs eventually (~5s SDK grace period); it's guarded by identity
   * comparison in run-query so its cleanup is a no-op when we've already
   * nullified.
   *
   * Preserves: `settled` / `latestUsage` (a fast respawn (rare) gets a warm
   * snapshot; the loop's identity-guarded finally won't trash them as long
   * as the new loopPromise has taken over). `bridge` is independent of
   * query lifetime by design (multiplex invariant — see
   * project_sidecode_ccr_architecture). Subscribers are untouched.
   *
   * No-op when `query === null` (already disposed / never spawned).
   */
  disposeQuery(): void {
    const q = this.query;
    if (q === null) return;
    const channel = this.inputChannel;
    // Synchronously claim the slots — ensureSessionLoop called right after
    // this returns will see null + spawn fresh, not return the dying handle.
    this.query = null;
    this.inputChannel = null;
    this.loopPromise = null;
    // Best-effort tear-down of the SDK side. `inputChannel.end()` signals
    // the AsyncMessageInput iterator to stop, then query.close() triggers
    // the SDK's ~5s grace shutdown. Both wrapped — neither should throw,
    // but a torn-down channel + reentrant close could surprise us.
    try {
      channel?.end();
    } catch {
      // best-effort
    }
    try {
      q.close();
    } catch {
      // best-effort
    }
  }
}
