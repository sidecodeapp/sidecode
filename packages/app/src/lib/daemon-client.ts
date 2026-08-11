import { sha256 } from "@noble/hashes/sha2.js";
import {
  type DirectoryEntry,
  decodePairOfferPayload,
  type EventDelta,
  type GitStatus,
  type ImageAttachment,
  PAIR_OFFER_VERSION,
  type SessionState,
  type TimelineItem,
  type TurnUsage,
} from "@thinkite/protocol";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { base64UrlToBytes } from "./base64";
import type { ClientIdentity } from "./identity";
import { connectIrohWire } from "./iroh-wire";
import {
  helloHandshake,
  type WireDiagnostics,
  type WireTransport,
} from "./wire-transport";

/** Wire diagnostics + connect timings, as served by the facade. */
export interface TransportDiagnostics extends WireDiagnostics {
  /** Wire establishment (QUIC dial incl. discovery + path upgrade). */
  wireMs: number;
  /** hello → server_info round trip on the established wire. */
  helloMs: number;
}

// Re-exported so consumers (daemon-client-context) keep their import
// path; the class itself moved to wire-transport.ts with the handshake
// that throws it.
export { IncompatibleProtocolError } from "./wire-transport";

// SecureStore restricts keys to [A-Za-z0-9._-] — no slashes / colons. Bump
// the trailing version when the persisted shape changes — older entries
// with a different shape become unreadable, the consumer falls into the
// `unpaired` state, and the user re-pairs cleanly.
//
// v2 → v3: WebRTC pivot. `addresses[]` is gone (signaling worker handles
// discovery), `fingerprint` is now derived from pubkey on read instead of
// persisted. PairedDaemon shrank to `{ daemonIdentityPublicKey, serviceName }`.
const PAIRED_STORE_KEY = "sidecode_paired_daemon_v3";

/**
 * What we save after a successful first pair so subsequent launches can
 * reconnect without re-scanning a QR.
 *
 * Just the daemon's pubkey (== its iroh EndpointId — the dial address)
 * plus the display label. `fingerprint` is derived from pubkey via
 * `sha256(...).slice(0, 16)` whenever the UI needs it.
 */
export interface PairedDaemon {
  daemonIdentityPublicKey: string; // base64url
  serviceName: string;
}

export interface PairOffer {
  v: number;
  daemonIdentityPublicKey: string;
  serviceName: string;
}

/** Derive the 16-hex-char daemon fingerprint from its base64url pubkey.
 *  Matches the daemon-side derivation in identity.ts. */
export function fingerprintFromPubkey(daemonIdentityPublicKey: string): string {
  const raw = base64UrlToBytes(daemonIdentityPublicKey);
  const hash = sha256(raw);
  let hex = "";
  for (let i = 0; i < hash.length; i += 1) {
    hex += hash[i].toString(16).padStart(2, "0");
  }
  return hex.slice(0, 16);
}

/**
 * Decode a pair.offer payload (the base64url string from a QR / dev paste).
 *
 * Wire format is base64url of JSON with one-letter keys. The encoding +
 * key-shortening both live in the protocol package; iOS receives the
 * verbose PairOffer shape ready to use.
 */
export function decodePairOffer(payload: string): PairOffer {
  const offer = decodePairOfferPayload(payload);
  if (offer.v !== PAIR_OFFER_VERSION) {
    throw new Error(
      `Pair code is from a different Thinkite version (got v=${offer.v}, expected v=${PAIR_OFFER_VERSION}). Update Thinkite on your Mac.`,
    );
  }
  return offer;
}

export async function getPairedDaemon(): Promise<PairedDaemon | null> {
  const raw = await SecureStore.getItemAsync(PAIRED_STORE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PairedDaemon>;
    if (
      typeof parsed.daemonIdentityPublicKey !== "string" ||
      typeof parsed.serviceName !== "string"
    ) {
      return null;
    }
    return parsed as PairedDaemon;
  } catch {
    return null;
  }
}

async function setPairedDaemon(d: PairedDaemon): Promise<void> {
  await SecureStore.setItemAsync(PAIRED_STORE_KEY, JSON.stringify(d));
}

export async function clearPairedDaemon(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRED_STORE_KEY);
}

interface PendingRequest {
  resolve: (frame: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Per-session callback receiving server-initiated `eventFrame` payloads.
 * Function identity (not just sessionId) determines ownership: stale
 * unsubscribes after a re-subscribe won't clobber the new owner.
 *
 * `cursor` is the wire cursor for this event — passed through verbatim
 * so the facade can use it as the resume hint on the next reconnect
 * without re-deriving from an event count (which would break if the
 * daemon ever batched or skipped cursors).
 */
type EventCallback = (cursor: number, delta: EventDelta) => void;
type GitStatusCallback = (status: GitStatus) => void;

/**
 * #17 — push-channel callbacks for the daemon-wide `subscribeSessions`
 * stream. Singleton per app process (one collection consumes the stream;
 * see `sessionStateCollection`). Last-write-wins semantics; no cursor /
 * no replay gap — each reconnect re-delivers `onInitial` with the full
 * fresh snapshot, so the consumer can truncate-and-reinsert without
 * worrying about missed deltas.
 *
 *   - `onInitial(entries)` — fires once per attach (initial + every
 *     reconnect). Consumer should treat each call as "ground truth — drop
 *     anything you have and start over with these entries". V0 daemon's
 *     `getAllSessionStates` returns a disk + memory union (see
 *     SessionRuntimeManager).
 *   - `onChange(sessionId, state)` — server push for a single session's
 *     state update. Upsert by sessionId.
 *   - `onRemove(sessionId)` — server push for a deleted session. V0 daemon
 *     never fires this (no user-driven delete), but consumer should
 *     handle it for V0.5+ forward compat.
 */
export interface SessionStatesCallbacks {
  onInitial: (
    entries: Array<{ sessionId: string; state: SessionState }>,
  ) => void;
  onChange: (sessionId: string, state: SessionState) => void;
  onRemove: (sessionId: string) => void;
}

/**
 * Max time we wait from "start connecting" to the hello handshake
 * settling. Covers: endpoint bind (first connect only) + relay/pkarr
 * discovery + QUIC dial + direct-path upgrade + hello→server_info.
 * Measured: ~400ms Wi-Fi cold, ~600ms cellular cold, ~20ms hot
 * reconnect; the slack is for hostile networks (relay-only paths) and
 * daemon-side delays admitting an unknown pubkey (pair-window open vs
 * not).
 *
 * If this trips, the UX message blames the most likely cause: the user
 * forgot to open the Pair window in the desktop app on their Mac.
 *
 * Also bounds the boot "Connecting to daemon…" screen before it falls to
 * `offline`; the retry loop covers overflow.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** User-facing copy when the connect deadline trips — blames the most
 *  likely cause (Pair window closed on the Mac). */
const CONNECT_TIMEOUT_MESSAGE =
  "Couldn't reach Mac. Make sure the Pair window is open on your Mac, then tap Retry.";

/**
 * Application-layer liveness probe. A peer that dies without a close
 * frame (kill -9, power loss, cable pull) is otherwise only detected by
 * the transport's own idle machinery — measured at ~35s on iroh (QUIC
 * default idle timeout, no FFI knob to tune it). A ping every 10s with
 * a 5s pong deadline bounds silent-death detection at ~15s worst case
 * (10.5s measured), and as a side effect keeps QUIC idle timers + NAT
 * mappings warm. Daemon side has answered `ping` with `pong` since the
 * WebRTC era — no daemon change.
 */
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 5_000;

/**
 * Single underlying wire + RPC transport for the daemon connection.
 * Throwaway: one instance per successful connect; replaced wholesale on
 * every reconnect. Consumers should NEVER reference this directly —
 * they bind to the stable `DaemonClient` facade below, which holds a
 * `Transport | null` ref and swaps it out across reconnects.
 *
 * Renamed from the old public `DaemonClient` class on the facade
 * refactor (see project_v0_webrtc_pivot.md + the durable-streams /
 * Centrifuge inspiration). The static `pair` / `reconnect` factories
 * stay here — Provider wires `Transport.reconnect(...)` → facade._attach.
 */
export class Transport {
  /**
   * Per-session live event callbacks. Set on `subscribe`, cleared on
   * `unsubscribe` (only if the stored cb is still the same identity), and
   * cleared en masse on transport close.
   */
  private readonly eventCallbacks = new Map<string, EventCallback>();
  /**
   * Per-cwd git status callbacks. Same identity-checked lifecycle as
   * `eventCallbacks` but keyed by `cwd` instead of `sessionId` — git
   * watcher state is per-workspace on the daemon, not per-session.
   */
  private readonly gitStatusCallbacks = new Map<string, GitStatusCallback>();
  /**
   * #17 — singleton push-channel for daemon-wide `subscribeSessions`.
   * Not a Map: there's only one session-states stream per transport
   * (one collection consumes it). Set by `subscribeSessions` after the
   * RPC response lands; cleared on transport close.
   */
  private sessionStatesPush: Pick<
    SessionStatesCallbacks,
    "onChange" | "onRemove"
  > | null = null;
  /**
   * `true` once `close()` has been called by the consumer — distinguishes
   * "user / context tore down the connection" from "transport dropped on
   * its own". Drives whether onUnexpectedClose fires.
   */
  private intentionallyClosed = false;

  /** Liveness probe timers (see PING_INTERVAL_MS). Started by
   *  `installMessageHandlers`, cleared on close/teardown. */
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /**
   * Optional callback invoked when the transport closes WITHOUT a prior
   * `close()` call. Set by the context provider after a successful pair /
   * reconnect to wire up auto-reconnect.
   */
  private onUnexpectedClose: (() => void) | null = null;

  private constructor(
    private readonly wire: WireTransport,
    private readonly pending: Map<string, PendingRequest>,
    /** Connect-time measurements (phase-4 panel): wire establishment
     *  and hello handshake durations. */
    private readonly timings: { wireMs: number; helloMs: number },
  ) {}

  /** Live wire diagnostics + connect timings for the Settings panel. */
  transportDiagnostics(): TransportDiagnostics {
    return {
      ...this.wire.diagnostics(),
      wireMs: this.timings.wireMs,
      helloMs: this.timings.helloMs,
    };
  }

  /**
   * Register a one-shot handler invoked when the underlying transport
   * drops without an explicit `close()` from the consumer (network blip,
   * daemon crash, ICE timeout, etc.). Call before any await yields after
   * pair / reconnect resolves so the handler is wired before any close
   * can fire.
   */
  setOnUnexpectedClose(cb: (() => void) | null): void {
    this.onUnexpectedClose = cb;
  }

  /**
   * First-time pair via a QR offer. Persists `PairedDaemon` for next
   * launch on success.
   */
  static async pair(
    identity: ClientIdentity,
    offer: PairOffer,
  ): Promise<Transport> {
    const client = await Transport.connect(
      identity,
      offer.daemonIdentityPublicKey,
    );
    await setPairedDaemon({
      daemonIdentityPublicKey: offer.daemonIdentityPublicKey,
      serviceName: offer.serviceName,
    });
    return client;
  }

  /** Reconnect using a previously-paired daemon. */
  static async reconnect(
    identity: ClientIdentity,
    daemon: PairedDaemon,
  ): Promise<Transport> {
    return Transport.connect(identity, daemon.daemonIdentityPublicKey);
  }

  /**
   * The single transport-establishment entry point: establish the iroh
   * wire, then run the shared wire-version handshake (`hello` →
   * `server_info`) before resolving. Identical for pair AND reconnect — from iOS's POV the
   * two cases differ only in (a) what pubkey we connect to and (b)
   * whether the daemon already knows our pubkey (it admits us anyway
   * when its pair-window-open gate is active).
   *
   * One deadline (`CONNECT_TIMEOUT_MS`) covers the whole flow:
   * establishment → hello → server_info. On wire-version mismatch the
   * daemon sends an `error` frame with code `incompatible_protocol`
   * then closes; `helloHandshake` surfaces that as
   * `IncompatibleProtocolError`.
   */
  private static async connect(
    identity: ClientIdentity,
    daemonPubkey: string,
  ): Promise<Transport> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + CONNECT_TIMEOUT_MS;
    const wire = await connectIrohWire(
      identity,
      daemonPubkey,
      deadlineAt,
      CONNECT_TIMEOUT_MESSAGE,
    );
    const wireMs = Date.now() - startedAt;
    try {
      await helloHandshake(wire, deadlineAt, CONNECT_TIMEOUT_MESSAGE);
    } catch (err) {
      wire.close();
      throw err;
    }
    const helloMs = Date.now() - startedAt - wireMs;
    const client = new Transport(wire, new Map(), { wireMs, helloMs });
    client.installMessageHandlers();
    return client;
  }

  /**
   * #17 — open the daemon-wide `subscribeSessions` push channel. Awaits
   * the response (returns `initial` snapshot), and ALSO wires the push
   * callbacks into the frame router so subsequent `session_state_changed`
   * / `session_state_removed` envelopes route to `callbacks.onChange` /
   * `callbacks.onRemove` until transport close.
   *
   * Low-level — `DaemonClient.subscribeSessions` wraps this with replay-
   * on-reconnect semantics so the collection's sync handler doesn't care
   * which Transport instance is current. Returns an `unsubscribe` thunk
   * that detaches the push callbacks (V0 doesn't send an explicit
   * unsubscribe RPC — daemon's listener set is cleaned up via
   * `ctx.onDisconnect` when the transport closes).
   */
  async subscribeSessions(callbacks: {
    onChange: (sessionId: string, state: SessionState) => void;
    onRemove: (sessionId: string) => void;
  }): Promise<{
    initial: Array<{ sessionId: string; state: SessionState }>;
    unsubscribe: () => void;
  }> {
    const requestId = Crypto.randomUUID();
    // Install push callbacks BEFORE sending the RPC so a fast daemon
    // can't fire a session_state_changed envelope between our request
    // and the response landing (race window otherwise — small, but
    // unsubscribed deltas would be silently dropped by the router).
    this.sessionStatesPush = callbacks;
    try {
      const res = (await this.request({
        type: "subscribeSessions",
        requestId,
      })) as { initial: Array<{ sessionId: string; state: SessionState }> };
      return {
        initial: res.initial,
        unsubscribe: () => {
          // Only clear if WE are still the active push consumer (defensive
          // against a re-subscribe replacing us; matches the identity-
          // guard pattern used by per-session subscribe).
          if (this.sessionStatesPush === callbacks) {
            this.sessionStatesPush = null;
          }
        },
      };
    } catch (err) {
      // Roll back the push install on RPC failure so a later subscribeSessions
      // attempt isn't shadowed by our stale callbacks.
      if (this.sessionStatesPush === callbacks) {
        this.sessionStatesPush = null;
      }
      throw err;
    }
  }

  /**
   * List one level of a directory on the daemon machine for the iOS
   * cwd / file picker. `path` accepts an absolute path or "~" / "~/...";
   * server expands. Options:
   *   - `includeFiles`: surface file entries (default: folders only)
   *   - `includeHidden`: surface dotfile entries (default: hidden)
   *
   * V0 leaves file `size` / `modifiedAt` undefined even when
   * `includeFiles=true` — the per-entry stat path is deferred. See
   * daemon's listDirectory handler header for the rationale.
   */
  async listDirectory(
    path: string,
    opts: { includeFiles?: boolean; includeHidden?: boolean } = {},
  ): Promise<{
    path: string;
    parent: string | null;
    entries: DirectoryEntry[];
  }> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      { type: "listDirectory", requestId, path };
    if (opts.includeFiles !== undefined) frame.includeFiles = opts.includeFiles;
    if (opts.includeHidden !== undefined)
      frame.includeHidden = opts.includeHidden;
    const res = (await this.request(frame)) as {
      path: string;
      parent: string | null;
      entries: DirectoryEntry[];
    };
    return res;
  }

  /**
   * Working-tree diff for `cwd` — the status bar's tap target. One-shot RPC
   * (request/response by requestId), wrapped in react-query by
   * `use-working-tree-diff`. Returns the raw multi-file unified diff matching
   * the bar's `+N -M` (vs the default-branch merge-base, incl untracked).
   */
  async getWorkingTreeDiff(cwd: string): Promise<{
    isRepo: boolean;
    diff: string;
    fileCount: number;
    truncated: boolean;
  }> {
    const requestId = Crypto.randomUUID();
    return (await this.request({
      type: "getWorkingTreeDiff",
      requestId,
      cwd,
    })) as {
      isRepo: boolean;
      diff: string;
      fileCount: number;
      truncated: boolean;
    };
  }

  /**
   * Bootstrap RPC for the picker — one call returns daemon machine's
   * HOME + (if they exist) Desktop / Documents shortcut paths +
   * recent-cwd candidates aggregated from session history. Callers
   * typically wrap in react-query with a long staleTime.
   */
  async getFilesystemRoots(): Promise<{
    home: string;
    desktop?: string;
    documents?: string;
    recentCwds: { path: string; lastUsedAt: string }[];
  }> {
    const requestId = Crypto.randomUUID();
    return (await this.request({
      type: "getFilesystemRoots",
      requestId,
    })) as {
      home: string;
      desktop?: string;
      documents?: string;
      recentCwds: { path: string; lastUsedAt: string }[];
    };
  }

  /**
   * Subscribe to a session's live event stream. Low-level RPC — the
   * facade (`DaemonClient`) wraps this with the registry that handles
   * cross-reconnect resumption + state machine; consumers should call
   * `daemonClient.subscribe(...)`, not this directly.
   *
   * `opts.sinceCursor` + `opts.sinceEpoch` are the resume hints. Pass
   * both when the caller has previously subscribed to this session on
   * THIS process (= within the same DaemonClient facade lifetime) and
   * wants the daemon to skip the JSONL re-read and only fill the gap.
   * Daemon falls back to a full snapshot transparently if the epoch
   * doesn't match or the ring buffer evicted the gap events — caller
   * detects via `recovered: false` on the response.
   *
   * Returns the daemon's response (settled / cursor / epoch / recovered
   * / initialUsage) plus the `unsubscribe` thunk. The thunk is
   * identity-checked: a stale cleanup after a quick remount won't
   * clobber the new subscription.
   */
  async subscribe(
    sessionId: string,
    onEvent: EventCallback,
    opts: { sinceCursor?: number; sinceEpoch?: string; isNew?: boolean } = {},
  ): Promise<{
    settled: TimelineItem[];
    cursor: number;
    epoch: string;
    recovered: boolean;
    /** Usage seed for the context meter — daemon extracts from the
     *  last assistant message's raw envelope so the meter has a number
     *  on resume. Undefined for fresh sessions, tool-only last turns,
     *  AND for the warm path (recovered:true) where the client already
     *  has the latest usage from the live stream. */
    initialUsage?: TurnUsage;
    unsubscribe: () => Promise<void>;
  }> {
    this.eventCallbacks.set(sessionId, onEvent);
    let res: {
      settled: TimelineItem[];
      cursor: number;
      epoch: string;
      recovered: boolean;
      initialUsage?: TurnUsage;
    };
    try {
      const requestId = Crypto.randomUUID();
      const frame: {
        type: string;
        requestId: string;
        sessionId: string;
        sinceCursor?: number;
        sinceEpoch?: string;
        isNew?: boolean;
      } = { type: "subscribe", requestId, sessionId };
      if (opts.sinceCursor !== undefined) frame.sinceCursor = opts.sinceCursor;
      if (opts.sinceEpoch !== undefined) frame.sinceEpoch = opts.sinceEpoch;
      if (opts.isNew === true) frame.isNew = true;
      res = (await this.request(frame)) as {
        settled: TimelineItem[];
        cursor: number;
        epoch: string;
        recovered: boolean;
        initialUsage?: TurnUsage;
      };
    } catch (err) {
      if (this.eventCallbacks.get(sessionId) === onEvent) {
        this.eventCallbacks.delete(sessionId);
      }
      throw err;
    }
    return {
      settled: res.settled,
      cursor: res.cursor,
      epoch: res.epoch,
      recovered: res.recovered,
      initialUsage: res.initialUsage,
      unsubscribe: () => this.unsubscribeOwned(sessionId, onEvent),
    };
  }

  /**
   * Send a user prompt into a session. `cwd` REQUIRED on the first
   * sendPrompt for an iOS-created session (no JSONL yet); ignored for
   * resume. Daemon validates and may reply with
   * `{ type: "error", code: "invalid_message" }` for missing-cwd.
   *
   * `images` carry compressed base64 JPEG/PNG attachments — protocol
   * schema is `{ data, mediaType }`. Daemon wraps these into Anthropic
   * `ImageBlockParam`s ahead of the text block when calling the SDK.
   * Empty / missing array sends a text-only prompt.
   *
   * `model` carries the input-bar picker's current selection. Daemon
   * uses it as the SDK `query()` initial option on FIRST ensureSessionLoop
   * (create path, or resume after a runtime respawn). Mid-session apply
   * is owned by `setSessionSelection` (pick-time RPC). iOS should still
   * pass the current selection on every sendPrompt so daemon-restart
   * recoveries inherit it cleanly.
   *
   * Argument shape is an options object — cwd/images/model grew past
   * the comfortable positional-parameter threshold.
   */
  async sendPrompt(opts: {
    sessionId: string;
    text: string;
    cwd?: string;
    images?: ImageAttachment[];
    model?: string;
    /** Create-bridged: on a NEW session's FIRST send, the daemon attaches a CCR
     *  bridge before turn 1 (mirrors live from the first message, no backfill).
     *  Ignored for an existing session — use `bridgeSession` to upgrade one. */
    bridged?: boolean;
    userMessageUuid?: string;
  }): Promise<void> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      {
        type: "sendPrompt",
        requestId,
        sessionId: opts.sessionId,
        text: opts.text,
      };
    if (opts.cwd !== undefined) frame.cwd = opts.cwd;
    if (opts.images !== undefined && opts.images.length > 0) {
      frame.images = opts.images;
    }
    if (opts.model !== undefined) frame.model = opts.model;
    if (opts.bridged !== undefined) frame.bridged = opts.bridged;
    if (opts.userMessageUuid !== undefined) {
      frame.userMessageUuid = opts.userMessageUuid;
    }
    await this.request(frame);
  }

  /**
   * Pick-time commit of the input-bar's model selection. Daemon
   * applies to the live SDK query via `applyFlagSettings({ model })`,
   * then writes the new model into sidecode metadata if that call
   * succeeds. Throws on apply failure — callers (typically a TanStack
   * Query mutation with onError rollback) revert the optimistic picker
   * update.
   *
   * Omitted model is a no-op (defensive — picker shouldn't fire this).
   */
  async setSessionSelection(opts: {
    sessionId: string;
    model?: string;
  }): Promise<void> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      {
        type: "setSessionSelection",
        requestId,
        sessionId: opts.sessionId,
      };
    if (opts.model !== undefined) frame.model = opts.model;
    await this.request(frame);
  }

  /**
   * User pressed stop on the live turn. Targets `runtime.query.interrupt()`
   * on the daemon: cancels the current turn but keeps the session /
   * subprocess alive for follow-up prompts.
   */
  async interrupt(sessionId: string): Promise<void> {
    const requestId = Crypto.randomUUID();
    await this.request({
      type: "interrupt",
      requestId,
      sessionId,
    });
  }

  /**
   * CCR upgrade — mirror this pure P2P session to a cloud `cse_` so it's
   * visible + drivable from claude.ai / Claude Desktop. Daemon attaches the
   * bridge at the next turn boundary; the iOS-facing `bridged` flag flips via
   * the `subscribeSessions` push once BridgeService worker-state lands. Throws
   * on daemon error (e.g. cannot upgrade mid-turn) so callers can roll back any
   * optimistic UI.
   */
  async bridgeSession(sessionId: string): Promise<void> {
    const requestId = Crypto.randomUUID();
    await this.request({
      type: "bridgeSession",
      requestId,
      sessionId,
    });
  }

  /**
   * CCR downgrade ("make private") — drop the cloud mirror; the session
   * continues as a pure P2P session. Idempotent: unbridging a session that
   * isn't bridged is a no-op success.
   */
  async unbridgeSession(sessionId: string): Promise<void> {
    const requestId = Crypto.randomUUID();
    await this.request({
      type: "unbridgeSession",
      requestId,
      sessionId,
    });
  }

  /**
   * Identity-checked unsubscribe — both the local registry slot AND the
   * RPC are gated on `owner` still matching the stored callback.
   *
   * Why gate the RPC too: in React 19 StrictMode dev, useEffect runs
   * mount → cleanup → mount with the same key. The first mount's
   * subscribe Promise often resolves AFTER the cleanup, by which point
   * the second mount has already registered a new callback (overwriting
   * the slot) and re-sent its own subscribe RPC. If we then send a stale
   * unsubscribe RPC for the first mount, the daemon's per-connection
   * `subs` map maps sessionId → unsubscribe handle for the NEW fanout,
   * so the daemon would tear down the live one. Skipping the RPC when
   * we no longer own the slot defers cleanup to whoever does — they'll
   * either send their own unsubscribe later, or the channel close will
   * release everything at once.
   */
  private async unsubscribeOwned(
    sessionId: string,
    owner: EventCallback,
  ): Promise<void> {
    if (this.eventCallbacks.get(sessionId) !== owner) return;
    this.eventCallbacks.delete(sessionId);
    const requestId = Crypto.randomUUID();
    await this.request({
      type: "unsubscribe",
      requestId,
      sessionId,
    });
  }

  /**
   * One-shot git status snapshot for `cwd` — the react-query queryFn
   * counterpart to `subscribeGitStatus`'s change stream. Daemon-side it
   * reuses the per-cwd watcher's cached `refresh()`, so firing it
   * concurrently with subscribe costs at most one git invocation.
   */
  async getGitStatus(cwd: string): Promise<GitStatus> {
    const requestId = Crypto.randomUUID();
    const res = (await this.request({
      type: "getGitStatus",
      requestId,
      cwd,
    })) as { status: GitStatus; cwd: string };
    return res.status;
  }

  /**
   * Subscribe to live git status for a `cwd` — a PURE change stream (no
   * initial snapshot; fetch that via `getGitStatus`). Subsequent changes
   * arrive through `onUpdate`; returns an `unsubscribe` thunk. Mirrors the
   * `subscribe` lifecycle — identity-checked cleanup, transport-close
   * clears the map.
   */
  async subscribeGitStatus(
    cwd: string,
    onUpdate: GitStatusCallback,
  ): Promise<{ unsubscribe: () => Promise<void> }> {
    this.gitStatusCallbacks.set(cwd, onUpdate);
    try {
      const requestId = Crypto.randomUUID();
      await this.request({
        type: "subscribeGitStatus",
        requestId,
        cwd,
      });
    } catch (err) {
      if (this.gitStatusCallbacks.get(cwd) === onUpdate) {
        this.gitStatusCallbacks.delete(cwd);
      }
      throw err;
    }
    return {
      unsubscribe: () => this.unsubscribeGitStatusOwned(cwd, onUpdate),
    };
  }

  private async unsubscribeGitStatusOwned(
    cwd: string,
    owner: GitStatusCallback,
  ): Promise<void> {
    if (this.gitStatusCallbacks.get(cwd) !== owner) return;
    this.gitStatusCallbacks.delete(cwd);
    const requestId = Crypto.randomUUID();
    await this.request({
      type: "unsubscribeGitStatus",
      requestId,
      cwd,
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    this.stopKeepalive();
    try {
      this.wire.close();
    } catch {
      // already closed
    }
  }

  // ─── Liveness probe ─────────────────────────────────────────────

  private startKeepalive(): void {
    this.pingIntervalId = setInterval(() => {
      // Previous ping still unanswered when the next tick arrives —
      // the pong deadline below will close first, so just skip.
      if (this.pongTimeoutId !== null) return;
      try {
        this.wire.send({ type: "ping", t: Date.now() });
      } catch {
        // Wire refused the write — it's dead; force the close path.
        this.probeFailed("ping send failed");
        return;
      }
      this.pongTimeoutId = setTimeout(
        () => this.probeFailed("pong timeout"),
        PONG_TIMEOUT_MS,
      );
    }, PING_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.pingIntervalId !== null) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    if (this.pongTimeoutId !== null) {
      clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  /** Probe verdict: peer is silently dead. Close the wire — its close
   *  listener runs `onTransportClosed`, which fires onUnexpectedClose
   *  (intentionallyClosed is false) and the provider reconnects. */
  private probeFailed(reason: string): void {
    console.log(`[transport] liveness probe failed (${reason})`);
    this.stopKeepalive();
    try {
      this.wire.close();
    } catch {
      // already closed
    }
  }

  private request(
    frame: { type: string; requestId: string } & Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(frame.requestId, { resolve, reject });
      try {
        // Serialization/framing/chunking is the wire's business. A
        // refused write fails THIS request, not the transport.
        this.wire.send(frame);
      } catch (err) {
        this.pending.delete(frame.requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Install the runtime frame router + close handler on the wire.
   *  Called by `connect` exactly once, right after the hello handshake
   *  settles (which cleared its own one-shot listeners). Frames arrive
   *  already decoded, reassembled and parsed — transport quirks like
   *  chunk envelopes or half-dead-PC detection live in the wire
   *  implementations. */
  private installMessageHandlers(): void {
    this.wire.setOnClose(() => this.onTransportClosed());
    this.startKeepalive();
    this.wire.setOnFrame((parsed) => {
      const frame = parsed as {
        type?: string;
        requestId?: string;
        message?: string;
        sessionId?: string;
        delta?: EventDelta;
        cwd?: string;
        status?: GitStatus;
        state?: SessionState;
      };
      // Liveness probe answer — clears the pong deadline armed by the
      // matching ping. Any pong counts; we don't correlate echoT.
      if (frame.type === "pong") {
        if (this.pongTimeoutId !== null) {
          clearTimeout(this.pongTimeoutId);
          this.pongTimeoutId = null;
        }
        return;
      }
      // Server-initiated event frame (no requestId). Routed by sessionId
      // to the subscribed callback. Unknown sessionId → silently drop
      // (probably a frame for a session we just unsubscribed).
      if (
        frame.type === "event" &&
        typeof frame.sessionId === "string" &&
        frame.delta !== undefined &&
        typeof (frame as { cursor?: unknown }).cursor === "number"
      ) {
        const cb = this.eventCallbacks.get(frame.sessionId);
        if (cb) cb((frame as { cursor: number }).cursor, frame.delta);
        return;
      }
      // Server-initiated git status update. Routed by `cwd` — multiple
      // subscriptions on different workspaces share one connection.
      if (
        frame.type === "gitStatus" &&
        typeof frame.cwd === "string" &&
        frame.status !== undefined
      ) {
        const cb = this.gitStatusCallbacks.get(frame.cwd);
        if (cb) cb(frame.status);
        return;
      }
      // #17 server pushes for subscribeSessions stream. Singleton consumer
      // (sessionStatesPush) — silently drop when nobody subscribed (e.g.
      // a stray frame after consumer unsubscribed but before transport
      // closed).
      if (
        frame.type === "session_state_changed" &&
        typeof frame.sessionId === "string" &&
        frame.state !== undefined
      ) {
        this.sessionStatesPush?.onChange(frame.sessionId, frame.state);
        return;
      }
      if (
        frame.type === "session_state_removed" &&
        typeof frame.sessionId === "string"
      ) {
        this.sessionStatesPush?.onRemove(frame.sessionId);
        return;
      }
      if (!frame.requestId) return;
      const slot = this.pending.get(frame.requestId);
      if (!slot) return;
      this.pending.delete(frame.requestId);
      if (frame.type === "error") {
        slot.reject(new Error(frame.message ?? "daemon error"));
      } else {
        slot.resolve(frame);
      }
    });
  }

  private onTransportClosed(): void {
    this.stopKeepalive();
    const err = new Error("daemon connection closed");
    for (const [, slot] of this.pending) slot.reject(err);
    this.pending.clear();
    this.eventCallbacks.clear();
    this.gitStatusCallbacks.clear();
    this.sessionStatesPush = null;
    if (!this.intentionallyClosed) {
      const cb = this.onUnexpectedClose;
      this.onUnexpectedClose = null;
      cb?.();
    }
  }
}

// ─── Subscription registry types ────────────────────────────────────────

/**
 * Payload delivered to `onSubscribed`. The fields distinguish the two
 * RPC outcomes:
 *
 *   - `recovered: false` — daemon returned a full snapshot. Consumer
 *     MUST truncate its collection and ingest `settled` from scratch.
 *     Fires on first subscribe of a session, on app cold start, and on
 *     reconnect when the daemon couldn't serve incrementally (epoch
 *     mismatch or sinceCursor predates ring).
 *   - `recovered: true` — daemon served incrementally. `settled` is
 *     empty; consumer keeps its existing collection state and the
 *     facade will replay events (`onEvent`) for the gap between the
 *     last seen cursor and the daemon's current cursor.
 *
 * `initialUsage` is only present on cold-path responses — daemon
 * skips it on warm path because the consumer's live `latestUsage`
 * state is already current.
 */
export interface SubscriptionAttached {
  recovered: boolean;
  settled: TimelineItem[];
  cursor: number;
  initialUsage?: TurnUsage;
}

/**
 * Opaque per-session subscription handle owned by the `DaemonClient`
 * facade. Public surface is just `unsubscribe()` — everything else is
 * internal bookkeeping for the registry's replay-on-reconnect logic.
 *
 * State fields are all leading-underscored to signal "facade-only".
 * No public observable state machine: V0 consumers don't need to
 * render "subscribing" / "catching up" / "errored" badges — the
 * useDaemonClient hook's `connectionStatus` covers the offline UX.
 * If/when we add per-subscription error UI, expose what's needed at
 * that point — adding fields is non-breaking.
 *
 * Lifecycle: created by `daemonClient.subscribe(...)`, lives across
 * any number of transport reconnects (re-attached by the facade's
 * registry replay), terminates on `.unsubscribe()`.
 */
export class Subscription {
  /** Internal state for race detection during attach/detach handoffs
   *  — NOT public observable state. Three values:
   *    - "subscribing": registered but no in-flight subscribe RPC has
   *      resolved on the current transport (or no transport attached)
   *    - "subscribed": last subscribe RPC resolved; live events flow
   *    - "unsubscribed": terminal; .unsubscribe() removed from registry
   *  Used only to detect "consumer raced us during an await" — see
   *  the cast sites in attachSubscription. */
  _state: "subscribing" | "subscribed" | "unsubscribed" = "subscribing";
  /** Last cursor consumed via onEvent OR set from a cold-path
   *  response. Passed back as `sinceCursor` on the next attach.
   *  Null until the first successful subscribe response. */
  _cursor: number | null = null;
  /** Daemon epoch from the most recent subscribe response. Passed
   *  back as `sinceEpoch` on the next attach. Null until first
   *  successful attach. */
  _epoch: string | null = null;
  /** Transport-level unsubscribe thunk for the current attachment, or
   *  null when no transport is attached. */
  _currentUnsubscribe: (() => Promise<void>) | null = null;
  /** Brand-new-session flag, captured once at `subscribe()` time from the
   *  route (`?new=1`). Passed to the daemon ONLY on the first attach
   *  (when `_cursor` is still null) so it takes the no-disk-scan fast
   *  path. On any reconnect `_cursor` is set → the resume-hint branch
   *  wins → the flag is never re-sent, so a session that has since
   *  acquired a transcript can't be blanked. */
  _isNew = false;

  constructor(
    readonly cliSessionId: string,
    readonly callbacks: {
      onEvent: (delta: EventDelta) => void;
      onSubscribed: (info: SubscriptionAttached) => void;
    },
    private readonly facadeUnsubscribe: (sub: Subscription) => Promise<void>,
  ) {}

  /** Consumer entrypoint. Removes from facade registry; if a transport
   *  is currently attached, sends the unsubscribe RPC. Idempotent. */
  async unsubscribe(): Promise<void> {
    if (this._state === "unsubscribed") return;
    await this.facadeUnsubscribe(this);
  }
}

/**
 * Thrown by WRITE RPCs when no transport is attached (offline). Lets a
 * caller tell a deliberate offline-gate rejection apart from a real RPC
 * failure. The UI write-gate (`connectionStatus` in InputBar) prevents
 * virtually all of these by disabling the affordance; this is the facade
 * backstop so a write that slips past the UI (a race) fails FAST instead
 * of hanging on `readyPromise` — and is NOT silently queued to fire on
 * the next reconnect (see project memory "queued-writes OUT": prompts are
 * time-sensitive agent commands, not mergeable document edits).
 */
export class OfflineError extends Error {
  constructor(message = "daemon offline") {
    super(message);
    this.name = "OfflineError";
  }
}

// ─── DaemonClient facade ────────────────────────────────────────────────

/**
 * Stable, long-lived public client. The Provider instantiates ONE per
 * app lifetime and consumers bind to it; the underlying `Transport`
 * comes and goes on transport reconnects without changing this object's
 * identity.
 *
 * Why this layer exists:
 *   - Removes the `client: DaemonClient | null` flicker every consumer
 *     used to gate on (the brief null between `_detachTransport` and
 *     the next `_attachTransport`). Consumers see a steady reference;
 *     RPCs await `readyPromise` internally.
 *   - Owns the per-session subscription registry. On every reconnect
 *     the facade replays the registry against the new Transport with
 *     each sub's `_cursor` + `_epoch` as resume hints — daemon serves
 *     incrementally when it can, falls back to a fresh snapshot
 *     transparently when it can't. Consumer's onEvent / onSubscribed
 *     fire continuously; the `recovered: false` flag on a re-attach
 *     tells the consumer "your collection is stale, rebuild it."
 *
 * Non-subscribe RPCs (`getFilesystemRoots`, `listDirectory`, etc.) are
 * thin pass-throughs that `await this.readyPromise` then dispatch to the
 * current transport. If a transport drops while a pass-through is
 * in-flight, the request rejects with "daemon connection closed" —
 * caller handles via react-query's retry or visible error state, same
 * as today.
 *
 * Consumers holding non-facade-managed subscriptions (`subscribeGitStatus`
 * today — git status doesn't get the auto-resume treatment because it's
 * inherently per-cwd and cheap to re-fetch) read `connectionStatus`
 * from `useDaemonClient` and put IT in their useEffect deps. A
 * "offline" → "online" transition fires the effect's cleanup + re-run,
 * which lands a fresh subscribe on the new transport. No facade-side
 * machinery needed for this case.
 *
 * Lifecycle calls are leading-underscored — Provider is the only
 * legitimate caller. External consumers MUST NOT touch them.
 */
export class DaemonClient {
  private transport: Transport | null = null;
  private readyPromise: Promise<Transport>;
  private resolveReady!: (t: Transport) => void;
  private readonly subs = new Set<Subscription>();
  /**
   * #17 — singleton session-states subscription state. One per app
   * process: the iOS TanStack DB sessionStateCollection is the only
   * consumer. Distinct from per-session `subs` because:
   *   - last-write-wins (no cursor / epoch resume hint needed)
   *   - reconnect re-delivers full `onInitial` snapshot (consumer
   *     truncate-and-reinserts) rather than replaying a delta gap
   *   - only one logical subscription exists, so a Set is overkill
   * Set by `subscribeSessions(callbacks)`; cleared by the returned
   * unsubscribe thunk. Survives transport reconnects automatically —
   * `_attachTransport` re-issues the RPC against the new transport.
   */
  private sessionStatesSub: SessionStatesCallbacks | null = null;

  constructor() {
    this.readyPromise = new Promise((r) => {
      this.resolveReady = r;
    });
  }

  /** Live diagnostics of the current transport, or null while offline.
   *  Poll from the Settings host panel — iroh samples rtt/paths fresh
   *  on every call. */
  transportDiagnostics(): TransportDiagnostics | null {
    return this.transport?.transportDiagnostics() ?? null;
  }

  /** Provider hook. Called after each successful Transport handshake.
   *  Re-resolves the readyPromise, then replays every registered
   *  subscription against the new transport (in parallel, with per-sub
   *  try/catch for error isolation). */
  _attachTransport(t: Transport): void {
    this.transport = t;
    this.resolveReady(t);
    // Replay every active per-session subscription. Parallel + isolated —
    // a single session's subscribe RPC failure must not stall the rest.
    for (const sub of this.subs) {
      void this.attachSubscription(t, sub);
    }
    // #17 — replay the daemon-wide session-states subscription too. Each
    // attach re-delivers a fresh `initial` snapshot via onInitial so the
    // consumer truncates + reinserts — that's the last-write-wins
    // contract.
    if (this.sessionStatesSub !== null) {
      void this.attachSessionStatesSub(t, this.sessionStatesSub);
    }
  }

  /** Provider hook. Called BEFORE the transport is closed (so the
   *  pending readyPromise gets re-armed before any RPC tries to
   *  resolve against a dead handle). The transport's own teardown
   *  cleans up its eventCallbacks map; we just clear our local
   *  unsubscribe thunks (they're tied to that dead map). */
  _detachTransport(): void {
    this.transport = null;
    // Re-arm readyPromise so any in-flight `await` blocks until the
    // next _attachTransport.
    this.readyPromise = new Promise((r) => {
      this.resolveReady = r;
    });
    for (const sub of this.subs) {
      sub._currentUnsubscribe = null;
      // Flag for race-detection in the next attach attempt — see the
      // cast sites in attachSubscription. Won't fire if sub is already
      // unsubscribed (idempotent).
      if (sub._state === "subscribed") sub._state = "subscribing";
    }
    // #17 sessionStatesSub itself is preserved across reconnect — its
    // re-attach happens in `_attachTransport`. The transport's
    // `onTransportClosed` already nulled out `sessionStatesPush`.
  }

  /**
   * Re-attach the daemon-wide session-states subscription against `t`.
   * Calls `subscribeSessions` on the transport, then delivers the
   * returned `initial` snapshot via `onInitial`. Push frames after the
   * RPC response route through the transport's `sessionStatesPush`
   * slot to the wrapped callbacks.
   *
   * Bare-bones error handling: a failed re-attach (transport closed
   * mid-await) is non-fatal — the next `_attachTransport` retries. We
   * console.warn so dev sees it, mirroring `attachSubscription`.
   */
  private async attachSessionStatesSub(
    t: Transport,
    sub: SessionStatesCallbacks,
  ): Promise<void> {
    try {
      const { initial } = await t.subscribeSessions({
        onChange: (sid, state) => {
          // Re-check identity in case consumer unsubscribed during await.
          if (this.sessionStatesSub === sub) sub.onChange(sid, state);
        },
        onRemove: (sid) => {
          if (this.sessionStatesSub === sub) sub.onRemove(sid);
        },
      });
      // Final identity guard before delivering the snapshot — consumer
      // may have unsubscribed while we were awaiting.
      if (this.sessionStatesSub === sub) sub.onInitial(initial);
    } catch (err) {
      console.warn("[sidecode] subscribeSessions attach failed:", err);
    }
  }

  private async attachSubscription(
    t: Transport,
    sub: Subscription,
  ): Promise<void> {
    if (sub._state === "unsubscribed") return;
    sub._state = "subscribing";

    const opts: { sinceCursor?: number; sinceEpoch?: string; isNew?: boolean } =
      sub._cursor !== null && sub._epoch !== null
        ? { sinceCursor: sub._cursor, sinceEpoch: sub._epoch }
        : // First attach only (no resume hint yet): forward the brand-new
          // flag so the daemon skips the JSONL scan. Once any response
          // lands, `_cursor` is set and the branch above wins on every
          // reconnect — `isNew` is never re-sent.
          sub._isNew
          ? { isNew: true }
          : {};

    try {
      const result = await t.subscribe(
        sub.cliSessionId,
        // Wrap onEvent to update the resume cursor with the wire cursor
        // verbatim — single source of truth, robust against future
        // daemon-side batching / skipping.
        (cursor, delta) => {
          sub._cursor = cursor;
          sub.callbacks.onEvent(delta);
        },
        opts,
      );
      // TS narrows `sub._state` to "subscribing" based on the assignment
      // at the top of this function, but consumer can call .unsubscribe()
      // during the await — re-cast to acknowledge the mutability.
      if ((sub._state as Subscription["_state"]) === "unsubscribed") {
        // Consumer raced us — drop the freshly-attached handle.
        void result.unsubscribe().catch(() => {});
        return;
      }
      sub._epoch = result.epoch;
      sub._currentUnsubscribe = result.unsubscribe;
      sub._state = "subscribed";
      // _cursor semantics = "highest cursor consumer has seen".
      //   - Cold (recovered:false): settled[] in onSubscribed covers
      //     everything up to result.cursor — record that as our high
      //     water so the next reconnect resumes from here.
      //   - Warm (recovered:true): leave _cursor alone (set by the
      //     last onEvent on the prior attach, = sinceCursor we sent).
      //     The replay events about to arrive will advance it forward.
      if (!result.recovered) sub._cursor = result.cursor;
      sub.callbacks.onSubscribed({
        recovered: result.recovered,
        settled: result.settled,
        cursor: result.cursor,
        initialUsage: result.initialUsage,
      });
    } catch (err) {
      // Transport-level failures (RPC reject, transport closed
      // mid-await) are EXPECTED during reconnect storms and don't
      // warrant noisy logging — leave sub._state as "subscribing"
      // so the next _attachTransport retries. But also DON'T swallow
      // silently: errors from inside the consumer's onSubscribed
      // callback (e.g. accidental misuse of begin/commit/truncate in
      // a sync handler) would otherwise vanish into this catch and
      // leave the consumer in a stuck-loading state with no signal.
      // Console-warn so dev sees the actual exception. In production
      // this is fine — the next reconnect retry will produce the same
      // warn line, which still beats silent stuck-loading.
      console.warn(`[sidecode] subscribe(${sub.cliSessionId}) failed:`, err);
    }
  }

  /**
   * Subscribe to a session's live event stream with auto-resume across
   * transport reconnects. Returns a `Subscription` handle whose only
   * public method is `.unsubscribe()`. Safe to call at any time — if
   * the underlying transport isn't up yet, the facade queues the
   * subscribe to fire on the next `_attachTransport`.
   *
   * `onSubscribed.recovered === false` is the consumer's signal to
   * truncate its local cache and ingest the response's `settled[]`
   * fresh — happens on first subscribe AND on reconnect when the
   * daemon couldn't serve incrementally (epoch mismatch / cursor
   * predates ring). `recovered === true` means the consumer's
   * existing collection is still valid; subsequent `onEvent` calls
   * fill the gap.
   */
  subscribe(
    cliSessionId: string,
    callbacks: {
      onEvent: (delta: EventDelta) => void;
      onSubscribed: (info: SubscriptionAttached) => void;
    },
    opts?: { isNew?: boolean },
  ): Subscription {
    const sub = new Subscription(cliSessionId, callbacks, (s) =>
      this.removeSubscription(s),
    );
    // `isNew` is honored only on the first attach (see attachSubscription)
    // — a brand-new session created on this device, so the daemon serves
    // the no-disk-scan fast path. Stable for the subscription's lifetime;
    // reconnects fall through to the resume-hint branch.
    if (opts?.isNew === true) sub._isNew = true;
    this.subs.add(sub);
    if (this.transport !== null) {
      void this.attachSubscription(this.transport, sub);
    }
    return sub;
  }

  private async removeSubscription(sub: Subscription): Promise<void> {
    sub._state = "unsubscribed";
    this.subs.delete(sub);
    const unsub = sub._currentUnsubscribe;
    sub._currentUnsubscribe = null;
    if (unsub !== null) {
      try {
        await unsub();
      } catch {
        // Transport may already be dead; ignore.
      }
    }
  }

  // ─── Pass-through RPCs (await readyPromise → dispatch) ────────────

  /**
   * #17 — open the daemon-wide session-states stream. Singleton: only
   * one consumer per app process (the TanStack DB session collection's
   * sync handler).
   *
   * Survives reconnects automatically — `_attachTransport` re-issues the
   * RPC against the new transport and re-delivers `onInitial` with a
   * fresh snapshot. The consumer's sync handler treats each `onInitial`
   * as ground truth (truncate-and-reinsert).
   *
   * Returns synchronously; `onInitial` fires later (after the first
   * RPC response lands). The returned `unsubscribe` thunk both clears
   * the singleton slot (so a subsequent `subscribeSessions` attaches
   * cleanly) AND fires the active transport's local unsubscribe (which
   * detaches its push callbacks).
   *
   * Idempotent on the singleton: calling `subscribeSessions` twice
   * without unsubscribing in between REPLACES the prior consumer (V0
   * has only one consumer so this matters only as a defensive guard;
   * if needed, expose multi-consumer fan-out later).
   */
  subscribeSessions(callbacks: SessionStatesCallbacks): {
    unsubscribe: () => void;
  } {
    this.sessionStatesSub = callbacks;
    if (this.transport !== null) {
      void this.attachSessionStatesSub(this.transport, callbacks);
    }
    return {
      unsubscribe: () => {
        // Only clear if we're still the active sub (defensive against a
        // late unsubscribe by a stale closure after a subscribeSessions
        // call replaced us).
        if (this.sessionStatesSub === callbacks) {
          this.sessionStatesSub = null;
        }
      },
    };
  }

  async listDirectory(
    path: string,
    opts?: { includeFiles?: boolean; includeHidden?: boolean },
  ): Promise<{
    path: string;
    parent: string | null;
    entries: DirectoryEntry[];
  }> {
    const t = await this.readyPromise;
    return t.listDirectory(path, opts);
  }

  async getWorkingTreeDiff(cwd: string): Promise<{
    isRepo: boolean;
    diff: string;
    fileCount: number;
    truncated: boolean;
  }> {
    const t = await this.readyPromise;
    return t.getWorkingTreeDiff(cwd);
  }

  async getFilesystemRoots(): Promise<{
    home: string;
    desktop?: string;
    documents?: string;
    recentCwds: { path: string; lastUsedAt: string }[];
  }> {
    const t = await this.readyPromise;
    return t.getFilesystemRoots();
  }

  /**
   * Write-gate backstop: return the current transport or throw
   * `OfflineError` immediately when offline. Used by WRITE RPCs instead
   * of `await this.readyPromise` so they reject fast rather than hang
   * until the next reconnect (which would be an invisible, unbounded,
   * accidental queue — exactly what "queued-writes OUT" forbids). Reads
   * keep `await this.readyPromise` on purpose, so they auto-resume on
   * reconnect. `transport !== null` ⟺ `readyPromise` resolved (online),
   * so this is equivalent to the await when online, fail-fast when not.
   */
  private requireTransport(): Transport {
    if (this.transport === null) {
      throw new OfflineError("daemon offline — write rejected");
    }
    return this.transport;
  }

  async sendPrompt(opts: {
    sessionId: string;
    text: string;
    cwd?: string;
    images?: ImageAttachment[];
    model?: string;
    /** Create-bridged on a new session's first send — see Transport.sendPrompt. */
    bridged?: boolean;
    userMessageUuid?: string;
  }): Promise<void> {
    const t = this.requireTransport();
    return t.sendPrompt(opts);
  }

  async setSessionSelection(opts: {
    sessionId: string;
    model?: string;
  }): Promise<void> {
    const t = this.requireTransport();
    return t.setSessionSelection(opts);
  }

  async interrupt(sessionId: string): Promise<void> {
    const t = this.requireTransport();
    return t.interrupt(sessionId);
  }

  async bridgeSession(sessionId: string): Promise<void> {
    const t = this.requireTransport();
    return t.bridgeSession(sessionId);
  }

  async unbridgeSession(sessionId: string): Promise<void> {
    const t = this.requireTransport();
    return t.unbridgeSession(sessionId);
  }

  /** One-shot git status snapshot for `cwd` (react-query queryFn). */
  async getGitStatus(cwd: string): Promise<GitStatus> {
    const t = await this.readyPromise;
    return t.getGitStatus(cwd);
  }

  /**
   * Per-cwd git status subscribe — a pure change stream (initial snapshot
   * comes from `getGitStatus`). Pass-through to the current transport —
   * NO facade-managed registry (git status is cheap to re-fetch and per-cwd
   * subscriptions don't have the same continuity requirements as
   * transcript). Consumers re-subscribe on transport swap by including
   * `daemonClient.connectionEpoch` in their useEffect deps.
   */
  async subscribeGitStatus(
    cwd: string,
    onUpdate: (status: GitStatus) => void,
  ): Promise<{ unsubscribe: () => Promise<void> }> {
    const t = await this.readyPromise;
    return t.subscribeGitStatus(cwd, onUpdate);
  }
}

// Shared-connection orchestration lives in `daemon-client-context.tsx` —
// this module exports primitives (Transport class + DaemonClient facade
// + Subscription handle + pair / reconnect / store helpers); the Context
// owns the connection lifecycle + status machine and drives the singleton
// below (attach / detach Transport).

/**
 * The app's one DaemonClient, as a module-level singleton.
 *
 * The facade is framework-agnostic (no React, no hooks; its constructor
 * just arms a readyPromise), and there is only ever one connection per
 * app process — so it lives at module scope, mirroring the TanStack Query
 * `queryClient`. This lets non-React, module-scope consumers (TanStack DB
 * collections in `sessions-collection.ts`, future collections) reference
 * the client directly instead of threading it through React context.
 *
 * React consumers still go through `useDaemonClient()` — the Provider
 * owns the connection lifecycle (connect / reconnect / pair / unpair) and
 * the status machine that drives UI, and merely attaches/detaches the
 * Transport on this singleton. Safe at module scope because RN is a
 * single-process, single-user runtime — the SSR "shared cache leaks
 * across requests" hazard that makes TanStack Query avoid module-global
 * clients on the server doesn't exist here.
 */
export const daemonClient = new DaemonClient();
