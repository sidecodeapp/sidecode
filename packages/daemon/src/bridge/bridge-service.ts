/**
 * BridgeService — daemon-level owner of all CCR bridge mirrors.
 *
 * One instance per daemon process (created in index.ts's `start`, drained in
 * `daemon.stop`). It holds:
 *   - the single OAuthRefreshManager (the keychain token is process-global →
 *     one manager serves every bridge — see project_sidecode_ccr_architecture)
 *   - a `sessionId → AttachedSession` map of live mirrors (M3.5: each entry
 *     tracks transport + runtime + original request + proactive jwt timer)
 *
 * Responsibilities:
 *   - `attach(sessionId, runtime, params)` — open a BridgeTransport, hang it
 *     on `runtime.bridge`, wire the inbound bag, arm the M3.5 proactive jwt
 *     refresh timer, and persist the M3.1 worker state.
 *   - `reconnect(sessionId)` — M3.5.3 unified entry for PROACTIVE
 *     (jwt-timer-driven) and REACTIVE (post-onClose) recovery. Single SDK
 *     probe call (`fetchRemoteCredentials`) is the discriminator (mirrors
 *     Claude Code's own pattern — no close-code switch needed; see
 *     project_sidecode_ccr_architecture onClose-codes spike).
 *   - `detach(sessionId)` — explicit unbridge, cancels timer, closes transport,
 *     clears worker state.
 *   - `shutdown()` — close every mirror + stop the OAuth manager + cancel
 *     every pending timer. Called from daemon.stop() AFTER
 *     runtimeManager.shutdown() (queries drained first).
 *
 * Recovery model (M3.5):
 *   - PROACTIVE: `armProactiveRefresh` schedules ~30min before jwt expiry
 *     (`expiresInSec - proactiveRefreshLeadSec`). Timer fires → calls
 *     `reconnect(sessionId)` → live `transport.reconnect()`. Re-arms on
 *     success.
 *   - REACTIVE: SDK's onClose callback routes through `handleClose` which
 *     dispatches to `reconnect(sessionId)` for any non-1000 code. Dead
 *     transport path: fetch fresh creds + build a NEW attachBridgeSession
 *     against the same cse_, replace transport in session map.
 *   - Same `reconnect` entry serves both. Discriminator is
 *     `transport.isConnected` (live = proactive swap, dead = full re-attach).
 *
 * Ownership boundary: BridgeService owns the transport lifetime, NOT the query
 * loop. run-query's finally clears query/inputChannel/loopPromise but
 * deliberately leaves `runtime.bridge` intact — a bridge outlives an idle
 * (lazy) query (the multiplex invariant). So `runtime.bridge` is a mirror of
 * what this service tracks; the service is the source of truth for closing.
 *
 * Scope today (M2 + M3.1 + M3.5): the daemon constructs ONE BridgeService with
 * the inbound handlers wired (see index.ts) — bidirectional from the first
 * attach. RPC surface for creating bridged sessions / upgrading existing ones
 * to bridged (the "create-bridged" / "upgrade" iOS commands) is still M4;
 * M1.5 + M2.5 spikes call `attach` directly to prove the transport works
 * end-to-end. M3.4 startup re-attach will reuse the `existingCseSessionId` +
 * `initialSequenceNum` BridgeTransport.attach params that M3.5 added.
 */

import type { InboundPrompt } from "../runtime/run-query.ts";
import { extractInboundPrompt } from "../runtime/run-query.ts";
import type { SessionRuntime } from "../runtime/session-runtime.ts";
import {
  clearBridgeWorkerState,
  markBridgeBackfilled,
  updateBridgeSequenceNum,
  writeBridgeWorkerState,
} from "../sidecode-sessions.ts";
import {
  type BridgeInboundHandlers,
  BridgeTransport,
  type PermissionModeVerdict,
  type TokenSource,
} from "./bridge-transport.ts";
import { readOrgUUID } from "./credentials.ts";
import {
  deleteCodeSession,
  fetchRemoteCredentials,
  isCredentialsFailure,
} from "./sdk-adapter.ts";

/** V0 verdict for any set_permission_mode control_request from claude.ai.
 *  sidecode V0 fixes `bypassPermissions` (project_no_plan_mode_v0 +
 *  feedback_no_hook_permission_interception) — no plan / acceptEdits /
 *  default mode toggle. Returning an explicit refuse beats the SDK's
 *  generic "callback not registered" fallback: the user sees WHY their
 *  mode change didn't take. Revisit when V0.5+ adds plan / approval UI. */
const V0_PERMISSION_MODE_VERDICT: PermissionModeVerdict = {
  ok: false,
  error:
    "sidecode V0 runs with bypassPermissions; remote permission-mode changes are not supported.",
};

/** The subset of OAuthRefreshManager BridgeService drives. Injectable so
 *  tests pass a fake (no keychain, no timers). Production = the real manager,
 *  which also satisfies TokenSource via `ensureFresh`. */
export interface OAuthManager extends TokenSource {
  /** Begin proactive pre-expiry refreshing (idempotent). */
  start(): void;
  /** Stop proactive refreshing + cancel the pending timer. */
  stop(): void;
}

/** Params for one attach, minus the token source (the service injects its
 *  own OAuthManager) and onClose (the service wires reconnect/cleanup in M3;
 *  M1 just logs). */
export interface BridgeAttachRequest {
  /** cloud session title (shown on claude.ai). */
  title: string;
  /** local working directory — carried into the code-session config. */
  cwd: string;
  /** raw SDK model key (optional). */
  model?: string;
  /** own-tag override (default `["sidecode"]`). */
  tags?: string[];
  /** host override (staging/local). */
  baseUrl?: string;
}

/** Minimal runtime shape BridgeService needs — just the bridge slot. Keeps
 *  the service decoupled from the full SessionRuntime<EventDelta> generic so
 *  tests can pass a bare `{ bridge: null }`. */
export interface BridgeAttachableRuntime {
  bridge: SessionRuntime<unknown>["bridge"];
}

export interface BridgeServiceOptions {
  /** The daemon's OAuthRefreshManager (token source + proactive timer). */
  oauth: OAuthManager;
  /** Sidecode home dir — the persistence root (`<home>/sessions/...`)
   *  passed through to writeBridgeWorkerState / updateBridgeSequenceNum
   *  / clearBridgeWorkerState. M3.1 made the service persistence-aware;
   *  pre-M3.1 callers passed nothing and the service was stateless. */
  home: string;
  /** Optional logger for attach failures / close codes. */
  log?: (message: string) => void;
  /**
   * Route an inbound (claude.ai-typed) prompt into a local turn (slice M2.2).
   * Given the session id + the extracted prompt, the impl (index.ts) looks up
   * the runtime, ensures its query loop, and pushPrompt()s — the reply then
   * streams back via M1's write-out tap. Reusing the inbound uuid makes the
   * write-back fold against claude.ai's own copy (dedup-by-uuid verified), so
   * no origin tracking is needed.
   *
   * Presence of ANY inbound handler (this, onInterrupt, or onSetModel) flips
   * every attached transport to BIDIRECTIONAL (the transport derives
   * outboundOnly:false when `inbound` is passed). Omit ALL → pure mirror (M1):
   * no inbound handlers, transports stay outboundOnly.
   */
  onInboundPrompt?: (sessionId: string, prompt: InboundPrompt) => void;
  /**
   * claude.ai pressed stop (slice M2.4). The impl (index.ts) routes this to
   * the session's `runtime.query.interrupt()`. The SDK has ALREADY auto-sent
   * the `control_response: success` (verified in claude-code-source
   * bridgeMessaging.ts `handleServerControlRequest`) — this is a pure
   * notification, we owe no response.
   */
  onInterrupt?: (sessionId: string) => void;
  /**
   * claude.ai changed the model selector (slice M2.4). The impl routes this to
   * `runtime.query.applyFlagSettings({ model })` (apply to the live query) AND
   * `runtimeManager.setModel` (mirror onto the runtime + persist metadata —
   * the iOS chip's truth source is the #17 `sessionState.model`, NOT the
   * transcript, so the metadata write + fan-out is what makes the chip
   * converge via the subscribeSessions push).
   * `undefined` = reset to the account default. SDK auto-sends the
   * control_response: success — we owe no response. No EventDelta is emitted
   * (claude.ai already learns the model from the `message.model` on the
   * assistant envelope we mirror; the iOS chip reads metadata, not transcript).
   */
  onSetModel?: (sessionId: string, model: string | undefined) => void;
  /** Test seam: override BridgeTransport.attach. */
  attachTransport?: typeof BridgeTransport.attach;
  /** Test seams: override the persistence helpers so unit tests don't
   *  touch real disk. Production uses the real sidecode-sessions module
   *  via `home`; these accept the same (home, cliSessionId, ...) tail. */
  persist?: {
    writeBridgeWorkerState?: typeof writeBridgeWorkerState;
    updateBridgeSequenceNum?: typeof updateBridgeSequenceNum;
    clearBridgeWorkerState?: typeof clearBridgeWorkerState;
    markBridgeBackfilled?: typeof markBridgeBackfilled;
  };
  /** Test seams for M3.5 reconnect: SDK call (probe + new creds) and the
   *  proactive jwt timer (mock setTimeout / clearTimeout to drive
   *  scheduled behavior synchronously in tests, same pattern as
   *  OAuthRefreshManager). */
  sdk?: {
    fetchRemoteCredentials?: typeof fetchRemoteCredentials;
    /** Test seam: override the raw-HTTP cse_ delete (downgrade/unbridge). */
    deleteCodeSession?: typeof deleteCodeSession;
  };
  /** Read the org UUID for the cse_ delete call. Default =
   *  credentials.readOrgUUID (reads ~/.claude.json). Injectable for tests. */
  readOrgUUID?: () => string | null;
  /**
   * M3.3 upgrade backfill source — read a session's existing history as raw
   * SDKMessages (user/assistant) to flush to the cloud mirror. index.ts wires
   * this to `getSessionMessages` + a user/assistant filter; omit (tests / no
   * backfill) → upgrade attaches without flushing history. Given the
   * session's cliSessionId + cwd hint.
   */
  readHistory?: (cliSessionId: string, cwd: string) => Promise<unknown[]>;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Override the proactive-refresh lead (seconds before jwt expiry). Tests
   *  use a small value to avoid arming long timers; production default keeps
   *  ~30min safety margin against the 4h jwt lifetime. */
  proactiveRefreshLeadSec?: number;
}

/**
 * Per-session internal state. Tracks the live transport PLUS everything
 * needed to re-attach after onClose (M3.5 reactive recovery): the original
 * attach request (cwd/model/title/tags/baseUrl) + the runtime to re-wire +
 * the proactive jwt refresh timer that's armed against this session's
 * `expiresInSec`.
 *
 * `runtime` is held so onClose-driven reconnect can re-wire `runtime.bridge`
 * with the new transport without the caller having to plumb it through.
 */
interface AttachedSession {
  transport: BridgeTransport;
  runtime: BridgeAttachableRuntime;
  request: BridgeAttachRequest;
  /** Proactive jwt refresh — fires ~30min before expires_in (M3.5.5). */
  refreshTimer?: ReturnType<typeof setTimeout>;
  /** Reactive failure-recovery retry — fires at one of BACKOFF_LADDER_MS
   *  after a reconnect() returned transport_failed or auth_failed (M3.5.6).
   *  Mutually exclusive with refreshTimer in practice: a healthy session
   *  has refreshTimer armed (no retry needed); a session whose last reconnect
   *  failed has backoffTimer armed (refreshTimer was canceled by reconnect's
   *  own preamble). cancelTimers() clears both regardless. */
  backoffTimer?: ReturnType<typeof setTimeout>;
  /** 0-indexed ladder position: how many consecutive reconnect failures
   *  have we observed. Reset to 0 on `reconnected` result. When the next
   *  failure would push past BACKOFF_LADDER_MS.length, we stop retrying
   *  (state is preserved — M3.4 startup re-attach can pick it up next
   *  daemon boot, or a future explicit /reconnect command can revive it). */
  backoffAttempt: number;
  /**
   * M3.5.7 in-flight reconnect coalescer. Any `reconnect(sessionId)` call
   * while this is set returns the SAME promise instead of starting a new
   * recovery attempt. Cleared in the finally block of the wrapping reconnect.
   *
   * Why this is essential at the e2e level (not caught by unit tests, which
   * mock fetchRemoteCredentials and never run concurrently): the SDK fires
   * onClose from BOTH the SSE-side and the CCRClient-side for the same
   * transport (so any close = 2 events), AND `fetchRemoteCredentials` bumps
   * epoch server-side on EVERY call — so two concurrent reconnects each
   * bump epoch and each kills the other's transport, triggering more
   * onClose events, triggering more reconnects, in an exponential cascade
   * that ends with one reconnect getting null creds (clearing the session
   * from the map) while another succeeds (writing runtime.bridge to a
   * brand-new transport whose AttachedSession is now orphaned). Spike-
   * verified via spikes/m3-5-recovery archive mode pre-M3.5.7: 10 onClose
   * fires + 5 failed reattach attempts + final state divergence. With this
   * guard: 1 onClose group collapses to 1 reconnect, cascade gone.
   *
   * Typed as `Promise<unknown>` so the field can sit above the
   * ReconnectResult declaration without a forward-reference dance; the
   * narrow type is restored at the assignment + await sites.
   */
  inFlightReconnect?: Promise<unknown>;
}

/** Close code 1000 = clean session end (server-emitted). Sidecode's server
 *  side never sends this in production, but we honor it for parity with
 *  Claude Code's `handleTransportPermanentClose` (replBridge.ts:921) which
 *  also short-circuits on 1000 — see onClose-codes spike in
 *  project_sidecode_ccr_architecture for the source-confirmed close-code map. */
const CLEAN_CLOSE_CODE = 1000;

/**
 * Result of a `BridgeService.reconnect(sessionId)` call. Exposed so tests
 * and (V0.5+) iOS / protocol callers can distinguish recovery outcomes
 * without inspecting service internals. The classifier mirrors the
 * source-confirmed M3.5 decision table in
 * project_sidecode_ccr_architecture.
 */
export type ReconnectResult =
  /** Service has been shut down — caller shouldn't retry. */
  | { result: "service_stopped" }
  /** No live AttachedSession for the given id — nothing to reconnect. */
  | { result: "not_attached" }
  /** OAuthRefreshManager.ensureFresh() threw — keychain / network / relogin. */
  | { result: "auth_failed"; cause: unknown }
  /** fetchRemoteCredentials threw OR transport.reconnect / re-attach threw —
   *  transient (network / 5xx). Worker state preserved; caller may retry. */
  | { result: "transport_failed"; cause: unknown }
  /** session_status flipped to "session truly gone" (creds null) or
   *  "user needs relogin" (CredentialsFailure). Worker state CLEARED;
   *  caller shouldn't retry. */
  | { result: "cleared"; reason: string }
  /** Recovery succeeded. `mode` distinguishes:
   *   - `proactive`: live transport, in-place creds swap (PROACTIVE timer
   *     path; handle ref unchanged)
   *   - `reactive`: dead transport, new attachBridgeSession built (post-onClose
   *     recovery; handle ref replaced, runtime.bridge re-wired) */
  | { result: "reconnected"; mode: "proactive" | "reactive" };

/** Default lead time for the proactive jwt refresh (seconds before the
 *  server-issued expires_in). 30 min is safe given the standard 4h jwt
 *  lifetime — leaves enough time for one reconnect retry if the first
 *  attempt 5xx's. Test seam overrides via `proactiveRefreshLeadSec`. */
const DEFAULT_PROACTIVE_REFRESH_LEAD_SEC = 30 * 60;

/** Lower bound on the proactive timer delay. If the lead is configured
 *  too generously or the server returns a very short expires_in, this
 *  prevents back-to-back refresh loops. */
const MIN_PROACTIVE_DELAY_MS = 60 * 1000;

/** Failure-recovery backoff ladder (M3.5.6). After a `reconnect()` fails
 *  with a transient outcome (transport_failed / auth_failed), retry at
 *  these delays in order. Past the last entry we stop retrying — the
 *  bridge sits dead until M3.4 startup re-attach (next daemon boot) or
 *  an explicit /reconnect command (future). Worker state is preserved.
 *
 *  Rationale on the spacing: 30s catches a 5xx blip / brief jwt-issuance
 *  hiccup; 2min covers a short Anthropic incident; 10min is the SSE
 *  reconnect budget upper bound (RECONNECT_GIVE_UP_MS = 600_000 in
 *  SSETransport.ts) — beyond that the cse_ is likely server-side reaped
 *  and only a re-attach (M3.4) would help anyway. */
const BACKOFF_LADDER_MS = [30_000, 120_000, 600_000];

export class BridgeService {
  private readonly oauth: OAuthManager;
  private readonly home: string;
  private readonly log: (message: string) => void;
  private readonly attachTransport: typeof BridgeTransport.attach;
  private readonly onInboundPrompt?: (
    sessionId: string,
    prompt: InboundPrompt,
  ) => void;
  private readonly onInterrupt?: (sessionId: string) => void;
  private readonly onSetModel?: (
    sessionId: string,
    model: string | undefined,
  ) => void;
  private readonly writeBridgeWorkerState: typeof writeBridgeWorkerState;
  private readonly updateBridgeSequenceNum: typeof updateBridgeSequenceNum;
  private readonly clearBridgeWorkerState: typeof clearBridgeWorkerState;
  private readonly markBridgeBackfilled: typeof markBridgeBackfilled;
  private readonly fetchRemoteCredentials: typeof fetchRemoteCredentials;
  private readonly deleteCodeSession: typeof deleteCodeSession;
  private readonly readOrgUUID: () => string | null;
  private readonly readHistory?: (
    cliSessionId: string,
    cwd: string,
  ) => Promise<unknown[]>;
  private readonly setTimer: (
    cb: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly proactiveRefreshLeadSec: number;
  /** sessionId → live AttachedSession. The service is the source of truth
   *  for everything per-session (transport / timer / reattach context). */
  private readonly sessions = new Map<string, AttachedSession>();
  private stopped = false;

  constructor(options: BridgeServiceOptions) {
    this.oauth = options.oauth;
    this.home = options.home;
    this.log = options.log ?? (() => {});
    this.attachTransport = options.attachTransport ?? BridgeTransport.attach;
    this.onInboundPrompt = options.onInboundPrompt;
    this.onInterrupt = options.onInterrupt;
    this.onSetModel = options.onSetModel;
    this.writeBridgeWorkerState =
      options.persist?.writeBridgeWorkerState ?? writeBridgeWorkerState;
    this.updateBridgeSequenceNum =
      options.persist?.updateBridgeSequenceNum ?? updateBridgeSequenceNum;
    this.clearBridgeWorkerState =
      options.persist?.clearBridgeWorkerState ?? clearBridgeWorkerState;
    this.markBridgeBackfilled =
      options.persist?.markBridgeBackfilled ?? markBridgeBackfilled;
    this.fetchRemoteCredentials =
      options.sdk?.fetchRemoteCredentials ?? fetchRemoteCredentials;
    this.deleteCodeSession =
      options.sdk?.deleteCodeSession ?? deleteCodeSession;
    this.readOrgUUID = options.readOrgUUID ?? readOrgUUID;
    this.readHistory = options.readHistory;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.proactiveRefreshLeadSec =
      options.proactiveRefreshLeadSec ?? DEFAULT_PROACTIVE_REFRESH_LEAD_SEC;
  }

  /** Number of live mirrors (for tests / introspection). */
  get size(): number {
    return this.sessions.size;
  }

  /** Whether a session currently has a bridge mirror. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Open a CCR mirror for `sessionId` and wire it to `runtime.bridge`.
   *
   * Idempotent-ish: if a bridge already exists for this session, the existing
   * transport is returned unchanged (a second attach is a no-op, not a
   * double-open / epoch-steal). Throws BridgeAttachError on failure — caller
   * decides how to surface it; `runtime.bridge` is left untouched on failure
   * (no half-wired mirror).
   *
   * `existing` (M3.4 startup re-attach): when provided, attaches to an
   * already-known cse_ session instead of calling `createCodeSession` — used
   * by the startup orchestrator to revive bridges from disk after a daemon
   * restart. The transport resumes from `lastSSESequenceNum` (exclusive) and
   * persistence is SKIPPED (worker state on disk is already correct: same
   * cse_, more-accurate disk seq, `backfilled` flag preserved across boots).
   * Omit for fresh attaches (create-bridged / M3.3 upgrade paths).
   *
   * Starts the OAuth proactive timer on the first successful attach.
   */
  async attach(
    sessionId: string,
    runtime: BridgeAttachableRuntime,
    request: BridgeAttachRequest,
    existing?: { cseSessionId: string; lastSSESequenceNum: number },
  ): Promise<BridgeTransport> {
    if (this.stopped) {
      throw new Error("BridgeService is shut down");
    }
    const already = this.sessions.get(sessionId);
    if (already !== undefined) return already.transport;

    // Arm the OAuth proactive timer before the first attach so ensureFresh
    // (called inside BridgeTransport.attach) benefits, and idle bridges stay
    // refreshed. start() is idempotent — safe to call on every attach.
    this.oauth.start();

    const inbound = this.buildInboundBag(sessionId);

    // `transportRef` is captured by the onClose closure so handleClose can
    // do the M3.5.7 stale-transport check (ignore zombie closes from a
    // transport we've already replaced via reactive reattach). The ref is
    // populated AFTER attachTransport returns; if onClose fires DURING
    // attach (transport closed during connect), BridgeTransport.attach
    // itself throws → no entry ever lands in the session map → no stale
    // check applies. Safe race window.
    let transportRef: BridgeTransport | undefined;
    let transport: BridgeTransport;
    try {
      transport = await this.attachTransport({
        tokens: this.oauth,
        title: request.title,
        cwd: request.cwd,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.tags !== undefined ? { tags: request.tags } : {}),
        ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
        ...(inbound !== undefined ? { inbound } : {}),
        // M3.4 re-attach path: thread existingCseSessionId +
        // initialSequenceNum so BridgeTransport.attach skips createCodeSession
        // and resumes the live cse_ from the disk-checkpointed seq.
        ...(existing !== undefined
          ? {
              existingCseSessionId: existing.cseSessionId,
              initialSequenceNum: existing.lastSSESequenceNum,
            }
          : {}),
        persistSequenceNum: (seq) => {
          this.updateBridgeSequenceNum(this.home, sessionId, seq);
        },
        onClose: (code) => this.handleClose(sessionId, code, transportRef),
      });
      transportRef = transport;
    } catch (err) {
      // Attach failed — if this was the only would-be bridge, stop the timer
      // we just started so an idle daemon doesn't keep a refresh loop alive
      // for zero bridges.
      if (this.sessions.size === 0) this.oauth.stop();
      throw err;
    }

    const session: AttachedSession = {
      transport,
      runtime,
      request,
      backoffAttempt: 0,
    };
    this.sessions.set(sessionId, session);
    runtime.bridge = transport;
    if (existing === undefined) {
      // M3.1 fresh-attach — record the cse_ mapping + initial seq=0 +
      // backfilled=false in sidecode metadata. M3.4 startup re-attach reads
      // this back to know which sessions to revive (any session with `bridge`
      // present is bridged). backfilled=false is the create-bridged default;
      // M3.3 upgrade flow flips it to true via markBridgeBackfilled after the
      // historical flush.
      //
      // No-op + log when metadata is missing (writeBridgeWorkerState returns
      // undefined): means the caller attached a bridge to a session that was
      // never registered locally, which is a programmer bug rather than user
      // state we should fabricate.
      const persisted = this.writeBridgeWorkerState(this.home, sessionId, {
        cseSessionId: transport.cseSessionId,
        lastSSESequenceNum: 0,
        backfilled: false,
      });
      if (persisted === undefined) {
        this.log(
          `[bridge] session ${sessionId} attached but no sidecode metadata to persist worker state — restart re-attach won't find it`,
        );
      }
    }
    // For M3.4 re-attach path: disk worker state is preserved as-is — same
    // cse_, server replays seq > lastSSESequenceNum on attachBridgeSession,
    // and the in-flight `persistSequenceNum` callback above advances the
    // checkpoint naturally as new events stream in. Critically we MUST NOT
    // overwrite `backfilled` here (re-attach of an already-backfilled bridge
    // would otherwise re-trigger M3.3's history flush on next upgrade).
    //
    // M3.5.5 — arm proactive jwt refresh against the freshly-issued
    // expires_in. Refreshes ~30min before expiry so the next reconnect
    // happens on a still-valid transport (PROACTIVE path) rather than
    // waiting for onClose to fire (REACTIVE path).
    this.armProactiveRefresh(sessionId);
    // #17 — bring CCR's external_metadata in sync with the user's
    // last-known model intent on M3.4 STARTUP RE-ATTACH only. Why
    // gated on `existing !== undefined`:
    //   - Fresh create-bridged path: `createCodeSession({config:{model}})`
    //     already plumbed the model into the cse_ session config at
    //     creation, so CCR's view already matches; reportMetadata here
    //     would be a redundant write of the same value.
    //   - Re-attach path: `existingCseSessionId` SKIPS createCodeSession,
    //     so the cse_'s CCR-side model is whatever was stored at the
    //     ORIGINAL create. Between then and now the user may have changed
    //     models via setSessionSelection (persisted to disk meta + applied
    //     to local query + reportMetadata'd live) — but if that
    //     reportMetadata happened in a prior daemon session, a restart
    //     would still see CCR with the original model. This catch-up
    //     PUT bridges that gap.
    // Best-effort: BridgeTransport.reportMetadata swallows write errors,
    // so a flaky CCR transport doesn't fail the attach.
    if (existing !== undefined && request.model !== undefined) {
      transport.reportMetadata({ model: request.model });
    }
    this.log(
      `[bridge] session ${sessionId} ${existing !== undefined ? "re-attached" : "mirroring"} to ${transport.cseSessionId}`,
    );
    return transport;
  }

  /**
   * M3.3 mid-life upgrade (pure → bridged) of an EXISTING session.
   *
   * Precondition: the caller (router) gates on the session being IDLE (not
   * `running`) — V0 option A. Upgrading mid-turn would drop the in-flight
   * turn's already-streamed messages into a seam between the on-disk backfill
   * (not yet flushed) and the live tap (only catches post-attach writes); at a
   * turn boundary the JSONL is complete and there's no in-flight turn, so the
   * handoff is clean. This method does NOT re-check idle — that's the router's
   * job; here we assume a boundary.
   *
   * Flow: fresh `attach` (createCodeSession + worker state {backfilled:false} +
   * wire runtime.bridge + arm timers) → read the session's existing history →
   * `transport.backfill(historical)` → `markBridgeBackfilled`. After this the
   * live tap (forwardToBridge) mirrors every subsequent turn automatically.
   *
   * Backfill is best-effort: a fresh attach that SUCCEEDS but whose backfill
   * read/flush fails leaves the session BRIDGED but with prior history absent
   * on claude.ai (live turns still mirror). We log and DON'T mark backfilled.
   * Attach failure itself propagates (BridgeAttachError) — the caller surfaces
   * it and the session stays pure.
   */
  async upgrade(
    sessionId: string,
    runtime: BridgeAttachableRuntime,
    request: BridgeAttachRequest,
  ): Promise<BridgeTransport> {
    const transport = await this.attach(sessionId, runtime, request);
    if (this.readHistory === undefined) return transport;
    try {
      const history = await this.readHistory(sessionId, request.cwd);
      if (history.length > 0) await transport.backfill(history);
      // Mark done even for empty history (nothing to flush = backfill complete).
      this.markBridgeBackfilled(this.home, sessionId);
    } catch (err) {
      this.log(
        `[bridge] upgrade backfill failed for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        } (session stays bridged; prior history not shown on claude.ai)`,
      );
    }
    return transport;
  }

  /**
   * Build the inbound handler bag for `sessionId`. Extracted from `attach`
   * so the same bag shape is used on initial attach AND on M3.5 reactive
   * reconnect (the new attachBridgeSession needs the same inbound wiring
   * the old one had — the SDK won't carry callbacks across attachBridgeSession
   * calls).
   *
   * Each member is included only if its corresponding router was provided
   * — partial wiring is allowed (mirror + interrupt but no prompt routing).
   * Omit ALL handlers → returns undefined → transport stays outboundOnly
   * (M1 pure mirror).
   *
   * NOTE on onSetPermissionMode: STATIC stub always attached when bidirectional
   * (V0 fixes bypassPermissions per project_no_plan_mode_v0). NOT participating
   * in the hasInbound decision — a daemon with zero real routers still gets
   * a pure mirror, not a bidirectional transport that only refuses permission
   * changes.
   */
  private buildInboundBag(
    sessionId: string,
  ): BridgeInboundHandlers | undefined {
    const promptRoute = this.onInboundPrompt;
    const interruptRoute = this.onInterrupt;
    const setModelRoute = this.onSetModel;
    const hasInbound =
      promptRoute !== undefined ||
      interruptRoute !== undefined ||
      setModelRoute !== undefined;
    if (!hasInbound) return undefined;
    return {
      ...(promptRoute !== undefined
        ? {
            onInboundMessage: (msg: unknown) => {
              const prompt = extractInboundPrompt(msg);
              if (prompt !== null) promptRoute(sessionId, prompt);
            },
          }
        : {}),
      ...(interruptRoute !== undefined
        ? { onInterrupt: () => interruptRoute(sessionId) }
        : {}),
      ...(setModelRoute !== undefined
        ? {
            onSetModel: (model: string | undefined) =>
              setModelRoute(sessionId, model),
          }
        : {}),
      onSetPermissionMode: (): PermissionModeVerdict =>
        V0_PERMISSION_MODE_VERDICT,
    };
  }

  /**
   * Unified reconnect entry — M3.5.3. Single public method for both
   * PROACTIVE (jwt-timer fired) and REACTIVE (onClose-driven) recovery.
   * Dispatches internally on `transport.isConnected`:
   *
   *   - LIVE transport (proactive jwt swap before expiry) →
   *     `transport.reconnect(creds)` rebuilds internals in place; handle ref
   *     stays the same, runtime.bridge unchanged, SSE resumes from the SDK's
   *     internal high-water mark.
   *
   *   - DEAD transport (post-onClose recovery) → `attachTransport` with
   *     `existingCseSessionId` + `initialSequenceNum = transport.getSequenceNum()`
   *     (the most-recent seq the old handle saw, more current than the disk
   *     checkpoint). Old transport is forgotten, new one replaces it in the
   *     session map, runtime.bridge is re-wired.
   *
   * The discriminator for "session still alive vs deleted" is the return
   * value of `fetchRemoteCredentials` — NOT the onClose code (which is
   * ambiguous: 4090 fires for archive / delete / real epoch supersede; see
   * onClose-codes spike in project_sidecode_ccr_architecture). This mirrors
   * Claude Code's own `handleTransportPermanentClose` pattern — let the
   * recovery attempt's own response decide.
   *
   * Errors PROPAGATE (caller handles backoff in M3.5.6). Returns the result
   * so callers / tests can distinguish reconnected vs cleared vs failed.
   */
  async reconnect(sessionId: string): Promise<ReconnectResult> {
    if (this.stopped) return { result: "service_stopped" };
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { result: "not_attached" };
    // M3.5.7 in-flight coalescing — see AttachedSession.inFlightReconnect
    // docstring for the full rationale (it's the difference between a
    // 10-event cascade and a 1-event clean recovery on real archive/delete
    // events). Returning the same promise means N concurrent callers all
    // see the same outcome, no racing fetchRemoteCredentials calls bumping
    // epoch and killing each other's transports.
    if (session.inFlightReconnect !== undefined) {
      return session.inFlightReconnect as Promise<ReconnectResult>;
    }
    const promise = this.reconnectInternal(sessionId, session);
    session.inFlightReconnect = promise;
    try {
      return await promise;
    } finally {
      // Only clear if THIS promise is still the in-flight slot — a
      // synchronously-scheduled second reconnect would race; current code
      // can't (the body is `await`-driven), but defensive for future edits.
      if (session.inFlightReconnect === promise) {
        session.inFlightReconnect = undefined;
      }
    }
  }

  /**
   * Implementation of `reconnect` — runs the actual recovery flow. Always
   * invoked under the in-flight guard from the public `reconnect` method.
   * Extracted so the guard logic stays trivially readable; everything
   * below is unchanged from M3.5.3 semantics.
   */
  private async reconnectInternal(
    sessionId: string,
    session: AttachedSession,
  ): Promise<ReconnectResult> {
    // Cancel BOTH pending timers — about to re-arm one (proactive on success,
    // backoff on failure) or give up entirely. Cancelling backoff here
    // matters when reconnect was called by the backoff timer itself: the
    // timer fired, this is the in-flight retry, the slot is now consumed.
    this.cancelTimers(session);

    // Probe + fresh creds in one round trip. fetchRemoteCredentials is the
    // authoritative discriminator (see method docstring). ensureFresh covers
    // the case where the OAuth access token is stale (this would otherwise
    // give a misleading 401 from the /bridge endpoint).
    let accessToken: string;
    try {
      accessToken = await this.oauth.ensureFresh();
    } catch (err) {
      this.log(
        `[bridge] session ${sessionId} reconnect: OAuth refresh failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.scheduleBackoffRetry(sessionId);
      return { result: "auth_failed", cause: err };
    }

    const cseId = session.transport.cseSessionId;
    let creds: Awaited<ReturnType<typeof fetchRemoteCredentials>>;
    try {
      creds = await this.fetchRemoteCredentials({
        sessionId: cseId,
        accessToken,
        ...(session.request.baseUrl !== undefined
          ? { baseUrl: session.request.baseUrl }
          : {}),
      });
    } catch (err) {
      // Network-shaped throw (DNS, etc). Don't clear state — transient.
      this.log(
        `[bridge] session ${sessionId} reconnect: fetchRemoteCredentials threw — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.scheduleBackoffRetry(sessionId);
      return { result: "transport_failed", cause: err };
    }

    if (creds === null) {
      // null = HTTP transport error OR session-truly-gone (the /bridge
      // endpoint returns 404 when cse_ is deleted; the SDK collapses both
      // to null). On balance: assume the worst — clear worker state so M3.4
      // startup re-attach doesn't keep trying. If this was actually transient,
      // a future explicit reattach can re-establish.
      this.log(
        `[bridge] session ${sessionId} reconnect: fetchRemoteCredentials returned null (session deleted or persistent network failure)`,
      );
      this.detach(sessionId, session.runtime);
      return { result: "cleared", reason: "creds_null" };
    }

    if (isCredentialsFailure(creds)) {
      // Terminal — user needs to re-login (untrusted_device /
      // session_stale_relogin). Clear state, log, give up. Don't retry.
      this.log(
        `[bridge] session ${sessionId} reconnect: creds failure ${creds.reason} — user needs claude /login`,
      );
      this.detach(sessionId, session.runtime);
      return { result: "cleared", reason: creds.reason };
    }

    // Success path. Dispatch by transport liveness.
    if (session.transport.isConnected) {
      // PROACTIVE — swap creds on live handle. Errors propagate.
      try {
        await session.transport.reconnect({
          ingressToken: creds.worker_jwt,
          apiBaseUrl: creds.api_base_url,
          epoch: creds.worker_epoch,
          expiresInSec: creds.expires_in,
        });
      } catch (err) {
        this.log(
          `[bridge] session ${sessionId} reconnect: live transport.reconnect threw — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.scheduleBackoffRetry(sessionId);
        return { result: "transport_failed", cause: err };
      }
      // Re-arm proactive timer against the new lifetime + reset ladder.
      session.backoffAttempt = 0;
      this.armProactiveRefresh(sessionId);
      this.log(
        `[bridge] session ${sessionId} proactive jwt refresh OK (epoch=${creds.worker_epoch}, expires_in=${creds.expires_in}s)`,
      );
      return { result: "reconnected", mode: "proactive" };
    }

    // REACTIVE — dead handle, build a NEW attachBridgeSession against the
    // same cse_. Use the dying transport's last known seq as the SSE resume
    // point (more current than the disk checkpoint; the SDK's getSequenceNum
    // remains readable post-close, so this works even after the onClose fire
    // that triggered us).
    const lastSeq = session.transport.getSequenceNum();
    const inbound = this.buildInboundBag(sessionId);
    // Capture-after-attach pattern for the stale-transport guard — same as
    // BridgeService.attach above (see comment there).
    let newTransportRef: BridgeTransport | undefined;
    let newTransport: BridgeTransport;
    try {
      newTransport = await this.attachTransport({
        tokens: this.oauth,
        title: session.request.title,
        cwd: session.request.cwd,
        existingCseSessionId: cseId,
        initialSequenceNum: lastSeq,
        ...(session.request.model !== undefined
          ? { model: session.request.model }
          : {}),
        ...(session.request.tags !== undefined
          ? { tags: session.request.tags }
          : {}),
        ...(session.request.baseUrl !== undefined
          ? { baseUrl: session.request.baseUrl }
          : {}),
        ...(inbound !== undefined ? { inbound } : {}),
        persistSequenceNum: (seq) => {
          this.updateBridgeSequenceNum(this.home, sessionId, seq);
        },
        onClose: (code) => this.handleClose(sessionId, code, newTransportRef),
      });
      newTransportRef = newTransport;
    } catch (err) {
      this.log(
        `[bridge] session ${sessionId} reconnect: reattach attachTransport threw — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.scheduleBackoffRetry(sessionId);
      return { result: "transport_failed", cause: err };
    }

    // Swap into the session record. Only clear runtime.bridge if it still
    // points at the old transport — runtime.bridge update below replaces it
    // unconditionally, so the order is: read-old → set-new.
    session.transport = newTransport;
    session.runtime.bridge = newTransport;
    session.backoffAttempt = 0;
    this.armProactiveRefresh(sessionId);
    this.log(
      `[bridge] session ${sessionId} reattached to ${cseId} (seq=${lastSeq})`,
    );
    return { result: "reconnected", mode: "reactive" };
  }

  /**
   * onClose dispatch — M3.5.4. Called by the BridgeTransport when the SDK
   * fires its onClose callback. Routes to reconnect for every non-1000
   * code; treats 1000 as a clean server-side teardown (rare in practice;
   * source-confirmed in Claude Code's `handleTransportPermanentClose`
   * replBridge.ts:921 which short-circuits identically).
   *
   * Fire-and-forget — reconnect() is async but onClose is sync from the
   * SDK side, so the recovery runs in the background. Errors are logged
   * inside reconnect(); we don't surface them here.
   */
  private handleClose(
    sessionId: string,
    code: number | undefined,
    firingTransport: BridgeTransport | undefined,
  ): void {
    // M3.5.7 stale-transport guard. Zombie close from a transport we've
    // already replaced via reactive reattach: ignore. Otherwise the cascade
    // chain "old transport dies → reconnect → new transport attached → old
    // transport's CCRClient heartbeat fires 4090 → triggers another reconnect
    // → new attach bumps epoch → kills the just-attached transport → loops"
    // amplifies a single archive/delete event into 5-10 fires (spike-verified
    // pre-M3.5.7 in spikes/m3-5-recovery archive mode). When `firingTransport`
    // is undefined, the onClose fired during attach (BridgeTransport.attach
    // already throws in that case, so no session is in the map) — fall
    // through to the normal path harmlessly.
    const session = this.sessions.get(sessionId);
    if (
      session !== undefined &&
      firingTransport !== undefined &&
      session.transport !== firingTransport
    ) {
      this.log(
        `[bridge] session ${sessionId} ignored stale close (code ${code ?? "?"}) from a zombie transport — current cse_=${session.transport.cseSessionId}`,
      );
      return;
    }
    this.log(
      `[bridge] session ${sessionId} transport closed (code ${code ?? "?"})`,
    );
    if (code === CLEAN_CLOSE_CODE) {
      // Clean server-side end. Forget without trying to reconnect. Worker
      // state stays on disk — M3.4 startup re-attach will probe + clear if
      // the session is truly gone (1000 is server-emitted; sidecode never
      // sees it from the M2/M3.1 spike runs, but parity with Claude Code).
      if (session) this.forget(sessionId, session.runtime);
      return;
    }
    // Any other code: probe-and-reconnect via the unified entry. Don't
    // await — onClose is the SDK's sync notification, recovery is async.
    // The in-flight guard (M3.5.7) coalesces concurrent close events from
    // the same transport (SSE + CCRClient both fire) into a single recovery.
    void this.reconnect(sessionId).catch((err) => {
      this.log(
        `[bridge] session ${sessionId} reconnect rejected from onClose handler: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * Arm the proactive jwt refresh timer for a session — M3.5.5. Fires
   * `expiresInSec - proactiveRefreshLeadSec` seconds in the future, clamped
   * to MIN_PROACTIVE_DELAY_MS so we don't refresh-loop on a server-issued
   * short jwt. Cancels any prior timer first.
   *
   * When the timer fires it calls reconnect(sessionId). On success reconnect
   * re-arms a new timer against the freshly-issued expires_in (via the same
   * path that called armProactiveRefresh here). On failure the timer doesn't
   * re-arm; recovery falls back to the reactive onClose path when the jwt
   * actually expires (4h).
   *
   * `.unref()` lets the daemon exit even if a timer is pending — same
   * pattern as OAuthRefreshManager.
   */
  private armProactiveRefresh(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.cancelRefreshTimer(session);
    const leadMs = this.proactiveRefreshLeadSec * 1000;
    const lifetimeMs = session.transport.expiresInSec * 1000;
    const delayMs = Math.max(MIN_PROACTIVE_DELAY_MS, lifetimeMs - leadMs);
    const handle = this.setTimer(() => {
      void this.reconnect(sessionId).catch(() => {
        // Errors already logged by reconnect itself.
      });
    }, delayMs);
    // Node's setTimeout returns a Timeout object; unref keeps the event loop
    // from being held by an idle bridge. Production = real timer, tests
    // inject their own setTimer (often returns plain number / Symbol) so
    // unref may not exist — guard.
    if (
      typeof (handle as unknown as { unref?: () => void }).unref === "function"
    ) {
      (handle as unknown as { unref: () => void }).unref();
    }
    session.refreshTimer = handle;
  }

  /** Cancel a session's proactive jwt-refresh timer (if any). Idempotent.
   *  Kept separate from `cancelTimers` so the proactive timer can be
   *  re-armed without disturbing an in-flight backoff retry — currently
   *  unused (reconnect always wipes both), but cheaper to read at the
   *  callsite when behavior splits in V0.5+. */
  private cancelRefreshTimer(session: AttachedSession): void {
    if (session.refreshTimer !== undefined) {
      this.clearTimer(session.refreshTimer);
      session.refreshTimer = undefined;
    }
  }

  /** Cancel a session's backoff retry timer (if any). Idempotent. */
  private cancelBackoffTimer(session: AttachedSession): void {
    if (session.backoffTimer !== undefined) {
      this.clearTimer(session.backoffTimer);
      session.backoffTimer = undefined;
    }
  }

  /** Cancel BOTH timers — used by reconnect's preamble, detach, forget, and
   *  shutdown. Idempotent. */
  private cancelTimers(session: AttachedSession): void {
    this.cancelRefreshTimer(session);
    this.cancelBackoffTimer(session);
  }

  /**
   * Schedule a retry after a reconnect() failure — M3.5.6. The current
   * `backoffAttempt` indexes into BACKOFF_LADDER_MS; past the last entry
   * we log "ladder exhausted" and don't re-arm (state stays put for M3.4
   * startup re-attach or a future explicit revive command).
   *
   * Cancels any existing backoffTimer first (covers the unusual case where
   * two failures fire concurrently — the second's schedule supersedes the
   * first's).
   *
   * Increment-then-schedule: `backoffAttempt` is bumped immediately, so a
   * subsequent failure (after the timer fires + reconnect runs + that
   * reconnect also fails) reads the NEXT ladder index. Reset to 0 on
   * `reconnected` success in the reconnect() method itself.
   */
  private scheduleBackoffRetry(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.cancelBackoffTimer(session);
    const idx = session.backoffAttempt;
    if (idx >= BACKOFF_LADDER_MS.length) {
      this.log(
        `[bridge] session ${sessionId} backoff ladder exhausted after ${idx} attempts — giving up (worker state preserved, M3.4 will re-attach next boot)`,
      );
      return;
    }
    const delayMs = BACKOFF_LADDER_MS[idx];
    if (delayMs === undefined) return; // defensive — bounds-checked above
    session.backoffAttempt = idx + 1;
    const handle = this.setTimer(() => {
      void this.reconnect(sessionId).catch(() => {
        // Errors already logged by reconnect itself.
      });
    }, delayMs);
    if (
      typeof (handle as unknown as { unref?: () => void }).unref === "function"
    ) {
      (handle as unknown as { unref: () => void }).unref();
    }
    session.backoffTimer = handle;
    this.log(
      `[bridge] session ${sessionId} backoff retry scheduled in ${delayMs}ms (attempt ${idx + 1}/${BACKOFF_LADDER_MS.length})`,
    );
  }

  /**
   * Downgrade (bridged → pure / "make private") of an EXISTING bridged session.
   *
   * Order matters: `detach` FIRST (closes the handle → no more heartbeats → no
   * 4090 onClose → no reconnect race; forgets the session; clears worker state
   * so M3.4 startup re-attach won't revive it), THEN a best-effort
   * `deleteCodeSession` on the now-orphaned cse_ so it vanishes from claude.ai.
   *
   * If the cloud delete fails (network / no org uuid) the local downgrade still
   * holds: the session continues PURE (local JSONL untouched, runtime + P2P
   * unaffected) and the worker state is already cleared, so the daemon won't
   * re-bridge it; the cse_ just lingers as a `disconnected` session on
   * claude.ai the user can delete there. Never throws, never blocks the local
   * downgrade on the cloud call.
   */
  async unbridge(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const cseSessionId = session?.transport.cseSessionId;
    // Local teardown first — closes the handle (stops heartbeats so no 4090
    // onClose → no reconnect), forgets the session, clears worker state. Uses
    // the AttachedSession's OWN runtime (the one the bridge is wired to), so
    // the caller doesn't have to thread the right runtime through.
    if (session !== undefined) this.detach(sessionId, session.runtime);
    if (cseSessionId === undefined) return;
    // Best-effort cloud delete of the now-orphaned cse_.
    try {
      const organizationUuid = this.readOrgUUID();
      if (organizationUuid === null) {
        this.log(
          `[bridge] unbridge ${sessionId}: no org uuid — cse_ ${cseSessionId} left as disconnected on claude.ai`,
        );
        return;
      }
      const accessToken = await this.oauth.ensureFresh();
      const ok = await this.deleteCodeSession({
        sessionId: cseSessionId,
        accessToken,
        organizationUuid,
      });
      if (!ok) {
        this.log(
          `[bridge] unbridge ${sessionId}: deleteCodeSession failed for ${cseSessionId} (left as disconnected on claude.ai)`,
        );
      }
    } catch (err) {
      this.log(
        `[bridge] unbridge ${sessionId}: cloud delete threw for ${cseSessionId}: ${
          err instanceof Error ? err.message : String(err)
        } (local downgrade already applied)`,
      );
    }
  }

  /**
   * Close + forget the mirror for `sessionId`. No-op if none. Clears
   * `runtime.bridge` so the query loop stops forwarding. Stops the OAuth
   * timer when the last bridge is gone.
   *
   * M3.1 — also clears the persisted bridge worker state. This is the
   * EXPLICIT-tear-down path; M3.4 startup re-attach uses presence of
   * `bridge` in metadata as the "revive me" signal, so clearing here
   * means "user/caller intentionally unbridged this session, don't auto-
   * restore on next daemon start". `onClose` (transport died for non-
   * teardown reasons — 4090 epoch, 4091 init, 401 jwt — see M3.5) goes
   * through `forget` only, leaving the worker state intact for restart.
   */
  detach(sessionId: string, runtime: BridgeAttachableRuntime): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.cancelTimers(session);
    try {
      session.transport.close();
    } catch {
      // close() is best-effort.
    }
    this.forget(sessionId, runtime);
    try {
      this.clearBridgeWorkerState(this.home, sessionId);
    } catch (err) {
      this.log(
        `[bridge] clearBridgeWorkerState failed for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Remove the tracking entry + detach the runtime reference WITHOUT closing
   * (the caller already closed, or the transport closed itself via onClose).
   * Stops the OAuth timer when the map empties. Also cancels any pending
   * proactive refresh timer for the session.
   */
  private forget(sessionId: string, runtime: BridgeAttachableRuntime): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.cancelTimers(session);
    this.sessions.delete(sessionId);
    // Only clear the runtime's slot if it still points at THIS transport — a
    // re-attach may have already swapped in a newer one (M3.5 reactive path
    // does this — replaces session.transport in place, runtime.bridge gets
    // re-wired before forget runs).
    if (runtime.bridge === session.transport) {
      runtime.bridge = null;
    }
    if (this.sessions.size === 0) this.oauth.stop();
  }

  /**
   * Close every mirror + stop the OAuth manager. Idempotent. Called from
   * daemon.stop() after runtimeManager.shutdown() — queries are already
   * drained, so no forwardToBridge write can race these closes.
   *
   * Does NOT clear `runtime.bridge` slots: the runtimes are being dropped by
   * the manager's own shutdown anyway, and we don't hold runtime refs here.
   * Also cancels every pending proactive refresh timer.
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const session of this.sessions.values()) {
      this.cancelTimers(session);
      try {
        session.transport.close();
      } catch {
        // best-effort — process is exiting.
      }
    }
    this.sessions.clear();
    this.oauth.stop();
  }
}
