/**
 * Drive the SDK's `query()` in **streaming-input mode** — one persistent
 * subprocess per session, fed user prompts via an async channel. Each
 * emitted SDK message becomes an `EventDelta` pushed into the runtime's
 * ring buffer.
 *
 * Why streaming-input (vs single-shot string `prompt: string`):
 *   - SDK's `interrupt()` only works in streaming mode (per
 *     sdk.d.ts:2018-2027). Single-shot prompts would leave F3's "stop"
 *     button dead.
 *   - One subprocess per session → no 1-2s respawn + context reload per
 *     turn.
 *   - Matches Paseo's pattern (claude-agent.ts:2109-2113).
 *
 * Public API:
 *   - `ensureSessionLoop(runtime, options)` — idempotent; lazy-creates
 *     the channel, query, and consumer loop on first call. Returns the
 *     loop's promise (resolves when query exits via close / error /
 *     natural end). Subsequent calls return the existing promise.
 *   - `pushPrompt(runtime, text)` — pushes a user message into the
 *     channel. Throws if no loop is running yet.
 *
 * Consumer-loop behavior — what each SDK message becomes:
 *   - `stream_event` (with `includePartialMessages: true` set):
 *       - `message_start` → remember Anthropic message.id
 *       - `content_block_start (text)` → `append { assistant_message }`
 *         with empty text under synthetic uuid `${msgId}:${blockIndex}`
 *       - `content_block_delta (text_delta)` → `patch_text` against
 *         that synthetic uuid
 *       - `content_block_*` for tool_use / `input_json_delta` → IGNORED.
 *         V0 waits for the `assistant` envelope (which carries the full
 *         input) and emits the running tool_call atomically. Partial-JSON
 *         input streaming is deferred (see project_session_replay_model
 *         memory and Paseo's claude-agent.ts:3918 for V0.5+ adoption).
 *
 *   - `assistant` envelope: each `tool_use` block (deduped by call id)
 *     becomes `append { tool_call, status: "running", detail }`.
 *
 *   - `user` envelope: each `tool_result` block patches the matching
 *     pending tool_call → `patch_tool_call { status, error, detail }`.
 *
 *   - everything else (system / status / hook / result / replay): ignored.
 *
 * Identifier divergence between live and settled state is documented in
 * the protocol's `eventDelta` doc — synthetic `${msgId}:${idx}` for live
 * assistant_message uuids vs envelope uuid for cold-start. They never
 * coexist in the iOS view, so the divergence is acceptable for V0.
 */

import {
  type Query,
  query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  EventDelta,
  ImageAttachment,
  ToolCallDetail,
} from "@thinkite/protocol";
import {
  attachOutputToDetail,
  buildDetailFromInput,
  extractText,
  summaryFor,
  toolResultBlock,
  toolUseBlock,
} from "../messages/tool-detail.ts";
import {
  type AsyncMessageInput,
  createAsyncMessageInput,
} from "./async-message-input.ts";
import type { SessionActivity, SessionRuntime } from "./session-runtime.ts";

/**
 * M3.7 idle-teardown delay — after a turn completes with no subscribers,
 * wait this long before disposing the SDK query subprocess to free the
 * ~250MB RSS it holds. Runtime survives; next sendPrompt / bridge inbound
 * triggers a fresh ensureSessionLoop spawn (~500ms-1s cold start).
 *
 * 15min matches Claude Desktop's empirical policy (user-tested 2026-05-31:
 * `0 subscribers + session idle 15min → teardown`). NOT differentiator on
 * Desktop's teardown side — sidecode's actual differentiators (per memory
 * project_sdk_process_pool_v05): lazy spawn (Desktop spawns on
 * subscribe; we spawn only on prompt) + LRU cap (V0.5+).
 *
 * Note: this constant is no longer read by run-query — SessionRuntime
 * owns the timer internally and honors `teardownDelayMs` option.
 * Re-exported for tests that want the production-default value.
 */
export const IDLE_TEARDOWN_DELAY_MS = 15 * 60_000;

/**
 * M3.7.4 unified activity edge — drives BOTH consumers of the
 * idle/running boundary from the same 3 source points:
 *   - `pushPrompt` (user submission, earliest "running")
 *   - `forwardToBridge` first model frame (stream_event / assistant, the
 *     second "running" report — matches Claude Code's writeSdkMessages→
 *     startTurn AND catches SDK autonomous yields like scheduled tasks
 *     that wake the process without a user prompt)
 *   - `handleResultEnvelope` (terminal envelope, "idle")
 *
 * What it does on each edge:
 *   - `runtime.setActivity(state)` → updates runtime state, manages the
 *     M3.7 teardown timer (arm on idle if subs===0; cancel on running)
 *   - `runtime.bridge?.reportState(state)` → CCR cross-client UI
 *     (claude.ai's session-list spinner; deduped internally by bridge)
 *   - (future #17) `runtime.setActivity` will also emit a
 *     `session_activity` EventDelta to iOS subscribers — only one line to
 *     add at that time since the helper centralizes the edge already
 *
 * Logging: emits `[teardown] armed/canceled` only on actual state
 * transitions (relies on setActivity's dedupe). `[teardown] fired` is
 * emitted from inside SessionRuntime's timer callback. Bridge
 * reportState is error-isolated (a flaky transport must not break the
 * pillar query loop).
 */
function markActivity(
  runtime: SessionRuntime<EventDelta>,
  state: SessionActivity,
): void {
  runtime.setActivity(state);
  // CCR side — bridge.reportState dedupes internally on its own state, so
  // a deduped local setActivity STILL drives a deduped bridge call (the
  // bridge layer is the source of truth for cloud "did we send this
  // state change"). Error-isolated + null-bridge-safe.
  try {
    runtime.bridge?.reportState(state);
  } catch {
    // best-effort — never let a CCR transport hiccup break the pillar path
  }
}

// ─── Streaming state (per turn — actually per persistent loop) ─────────

interface StreamingState {
  /** Anthropic message.id of the message currently being streamed (between message_start/stop). */
  currentMessageId: string | null;
  /** messageId → blockIndex → synthetic assistant_message uuid. */
  textBlockUuids: Map<string, Map<number, string>>;
  /** tool_use_ids we've emitted append for. Prevents dups when assistant envelopes split per block. */
  appendedToolUseIds: Set<string>;
  /** tool_use_id → detail (kept around so tool_result patching reuses the typed shape). */
  pendingTools: Map<string, ToolCallDetail>;
  /**
   * Set to true after a `compact_boundary` arrives; the NEXT user
   * envelope is the SDK-injected compact summary message (JSONL marks
   * it `isCompactSummary: true`, but SDK's live `SDKUserMessage` type
   * doesn't surface that flag — see sdk.d.ts:3672). We use this
   * "next user is summary" hint to lift it to a `compact_summary`
   * append instead of dropping it like a normal SDK-echoed user msg.
   * Cleared the moment we consume the next user envelope.
   */
  expectingCompactSummary: boolean;
}

function newStreamingState(): StreamingState {
  return {
    currentMessageId: null,
    textBlockUuids: new Map(),
    appendedToolUseIds: new Set(),
    pendingTools: new Map(),
    expectingCompactSummary: false,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface SessionLoopOptions {
  /**
   * `"create"` → SDK creates a new session at `runtime.sessionId` (passed
   * via `options.sessionId`). `cwd` MUST be provided.
   * `"resume"` → SDK loads existing JSONL via `options.resume`.
   *
   * Decision (existence check via `getSessionInfo`) lives in the router's
   * sendPrompt handler — see project_session_replay_model memory and
   * router.ts for why.
   */
  mode: "create" | "resume";
  /**
   * Working directory for the SDK process. REQUIRED when mode="create"
   * (new session needs a cwd to root in). Ignored when mode="resume" —
   * SDK uses the persisted cwd from the existing session.
   */
  cwd?: string;
  /** Model picker selection from the iOS input bar.
   *
   *  Only applied when this call ACTUALLY spawns the SDK query — i.e.
   *  the first ensureSessionLoop for a runtime. Subsequent calls are
   *  idempotent no-ops and ignore the option. To change model on an
   *  already-running query, callers use the router's
   *  `setSessionSelection` RPC, which issues
   *  `runtime.query.applyFlagSettings({ model })`. */
  model?: string;
  /**
   * Fresh OAuth access token for the bundled claude binary, handed in via
   * env (`CLAUDE_CODE_OAUTH_TOKEN`). The caller ensures freshness
   * (OAuthRefreshManager.ensureFresh) right before this spawn — the binary
   * treats an env token as inference-only and won't self-refresh, so it's
   * valid for this spawn's lifetime only. Omitted on the test path
   * (`queryFactory` set), which never spawns a real binary.
   */
  oauthToken?: string;
  /**
   * Absolute path to the bundled `claude` SEA binary to spawn
   * (`pathToClaudeCodeExecutable`). Computed by the Electron layer (menubar),
   * which owns packaging: inside the packaged .app the binary is `asarUnpack`'d
   * to a fixed `Resources/app.asar.unpacked/...` location, and the SDK's own
   * resolution would otherwise point INSIDE `app.asar` (a file) and spawn with
   * `ENOTDIR`. Undefined in dev / tests → the SDK resolves its platform package
   * from node_modules itself (no asar, so that path is real). The daemon stays
   * electron-agnostic: it just forwards whatever the host computed.
   */
  claudeExecutablePath?: string;
  /** Test seam: override the SDK's `query()` factory. */
  queryFactory?: typeof query;
}

/**
 * Idempotent. First call: creates the input channel, spawns the SDK
 * query in streaming-input mode (resume or create per `options.mode`),
 * and starts the consumer loop in the background. Subsequent calls:
 * returns the existing loop promise without touching `runtime.query`
 * or `runtime.inputChannel`.
 *
 * The loop promise resolves when:
 *   - `runtime.query.close()` is called (F3's daemon shutdown)
 *   - `runtime.inputChannel.end()` is called and the SDK drains naturally
 *   - the SDK iterator throws — caught here and surfaced as a
 *     `turn_failed` EventDelta into the runtime buffer (slice G3)
 */
export function ensureSessionLoop(
  runtime: SessionRuntime<EventDelta>,
  options: SessionLoopOptions,
): Promise<void> {
  // M3.7.4 — the explicit teardown-timer cancel that used to live here
  // (M3.7.2) moved to markActivity("running"), which fires from pushPrompt
  // (always called right after ensureSessionLoop). Same end-state, but
  // centralizes the activity-edge logic so SDK autonomous yields (caught
  // by markActivity in forwardToBridge first-frame branch) ALSO cancel
  // the timer — the gap that pure ensureSessionLoop-entry-cancel missed.
  if (runtime.loopPromise) return runtime.loopPromise;

  // We spawn the SDK's OWN bundled claude binary (no
  // pathToClaudeCodeExecutable → the SDK require.resolve's its per-platform
  // package) and authenticate it by handing the user's OAuth access token via
  // env. The token is ensured fresh by the caller (OAuthRefreshManager) right
  // before this call. The test path (`queryFactory`) spawns nothing, so it
  // gets no env and needs no token.
  //
  // env REPLACES (not merges) the child env when set, so we spread
  // process.env to keep PATH/HOME/etc. CLAUDE_CODE_ENTRYPOINT stays
  // remote_mobile (resume-picker visible; we deliberately don't use the
  // binary's allowlisted refresh pipe — see reference_bundled_claude memory).
  const spawnEnv =
    options.queryFactory === undefined && options.oauthToken !== undefined
      ? ({
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken,
          CLAUDE_CODE_ENTRYPOINT: "remote_mobile",
        } as Record<string, string>)
      : undefined;
  const envOption = spawnEnv ? { env: spawnEnv } : {};

  // Spawn the host-supplied binary path when present (packaged app, where the
  // SDK's own resolution would hit `app.asar` → ENOTDIR). Absent in dev/tests,
  // where the SDK resolves its platform package itself. See SessionLoopOptions.
  const execOption = options.claudeExecutablePath
    ? { pathToClaudeCodeExecutable: options.claudeExecutablePath }
    : {};

  const channel = createAsyncMessageInput<SDKUserMessage>();
  runtime.inputChannel = channel;

  const factory = options.queryFactory ?? query;
  // V0 has no approval UI on iOS — every tool call must auto-approve or
  // the iOS user sees nothing happen. SDK requires BOTH `permissionMode:
  // "bypassPermissions"` AND `allowDangerouslySkipPermissions: true`
  // (sdk.d.ts:1469,1485) to truly skip the gate; setting only one isn't
  // enough. Equivalent to claude CLI's `--dangerously-skip-permissions`
  // flag. Revisit when V0.5+ adds an approval-sheet on iOS.
  const bypassFlags = {
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true as const,
  };
  // Removed from the model's context entirely (not just permission-denied):
  //   - AskUserQuestion: V0 iOS has no answer UI — if the model called it,
  //     the turn would sit waiting on input the app can't deliver. Hiding
  //     the tool makes the model phrase questions as plain text instead.
  // The ask_user detail/render path stays: resumed Desktop sessions can
  // still contain historical AskUserQuestion calls.
  const disallowedTools = ["AskUserQuestion"];
  // SDK requires sessionId XOR resume — they're mutually exclusive
  // (sdk.d.ts:1538-1540 — "Cannot be used with continue or resume unless
  // forkSession is also set"). We use sessionId for new sessions (so the
  // SDK adopts our client-supplied UUID) and resume for existing ones.
  //
  // `model` is spread in only when set — omitting the key lets the SDK
  // fall through to its own default (which honors the user's account /
  // Desktop settings, e.g. `Settings.effortLevel` for adaptive
  // thinking). Mid-session changes go through a single
  // `applyFlagSettings({ model })` on the live query — see router's
  // setSessionSelection handler.
  const modelOption =
    options.model !== undefined ? { model: options.model } : {};
  const sdkOptions =
    options.mode === "create"
      ? {
          ...bypassFlags,
          disallowedTools,
          ...modelOption,
          sessionId: runtime.sessionId,
          includePartialMessages: true as const,
          cwd: options.cwd,
          ...envOption,
          ...execOption,
        }
      : {
          ...bypassFlags,
          disallowedTools,
          ...modelOption,
          resume: runtime.sessionId,
          includePartialMessages: true as const,
          cwd: options.cwd,
          ...envOption,
          ...execOption,
        };
  const q: Query = factory({
    prompt: channel.iterable,
    options: sdkOptions,
  });
  // Query satisfies RuntimeQueryHandle structurally (interrupt + close).
  runtime.query = q;

  if (options.mode === "create") {
    // Seed an empty settled snapshot for a freshly-created session. The
    // first subscribe then takes the race-free Path A (serve settled=[]
    // atomically + replay the ring buffer from cursor 0) instead of the
    // JSONL cold-path, whose `settledCursor = currentCursor` would give an
    // empty replay window. This is what lets a create's first sendPrompt
    // fire BEFORE iOS subscribes (e.g. straight from the new-session
    // screen): whenever iOS subscribes, settled=[] + buffer replay
    // (0, currentCursor] delivers the synthesized user_message /
    // turn_started that pushPrompt is about to append. A brand-new
    // session has no prior messages, so [] is correct; the real snapshot
    // replaces it at the first turn boundary (handleSdkMessage).
    runtime.settled = [];
    runtime.settledCursor = 0;
  }

  const loopPromise = (async () => {
    const state = newStreamingState();
    try {
      for await (const msg of q) {
        // Synchronous per-message processing: each delta is emitted via
        // addEvent (which also folds it into `settled`) before the next
        // SDK message is pulled. No async work here anymore — the
        // turn-boundary JSONL re-read is gone (continuous fold replaced it).
        handleSdkMessage(runtime, state, msg);
        // Parallel derivation: fork the SAME raw SDKMessage to the CCR
        // bridge mirror (no-op for pure WebRTC sessions). Pillar path
        // (enriched → WebRTC) runs first; the mirror is best-effort.
        forwardToBridge(runtime, msg);
      }
    } catch (err) {
      // Surface the SDK error as a `turn_failed` so iOS can render it
      // instead of seeing an unexplained gap in the stream — unless the
      // user interrupted (some SDK paths throw rather than yielding an
      // error result; the router already emitted turn_canceled).
      //
      // KNOWN LIMITATION (bundled-binary auth): the env OAuth token is fixed
      // for this loop's lifetime; a loop alive past the token's expiry 401s
      // ("Failed to authenticate. API Error: 401") and KEEPS failing (same
      // process, same stale token) until the loop is disposed + respawned
      // (idle teardown, or daemon restart). Narrow window (loop must stay
      // actively alive > access-token TTL; idle teardown caps it). Self-heal
      // when needed: detect the 401 here → `runtime.disposeQuery()` so the
      // next sendPrompt respawns with a fresh ensureFresh() token. Deferred
      // (string-matching the SDK error is fragile; trigger is rare).
      if (!runtime.interrupted) {
        runtime.addEvent({
          kind: "turn_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      // M3.7 identity guard — `disposeQuery()` may have ALREADY claimed
      // these slots (synchronously nulled query/inputChannel/loopPromise)
      // and a fresh `ensureSessionLoop` call may have spawned a NEW loop
      // with a different SDK query handle that now owns
      // runtime.{query,inputChannel,loopPromise}. In that case, the OLD
      // loop (this one, draining after disposeQuery's q.close()) MUST
      // NOT clear the new loop's state. Compare against `q` (the SDK
      // handle, captured in the outer scope BEFORE the IIFE — chosen
      // over loopPromise to dodge a TS "used before assigned" cycle);
      // cleanup ONLY when we still own the slot. Wrapped in a positive
      // `if` (not `if !== q { return }`) so biome doesn't flag a
      // return-in-finally — control-flow correctness is preserved
      // because the try-IIFE doesn't return a value.
      if (runtime.query === q) {
        runtime.query = null;
        runtime.inputChannel = null;
        runtime.loopPromise = null;
        // Invalidate the in-memory settled snapshot — turn-boundary
        // refresh isn't running anymore, so it would go stale. Next
        // cold-path subscribe re-reads JSONL fresh. Router's lazy-init
        // path also won't re-memoize until ensureSessionLoop spawns a
        // new query handle (i.e. another sendPrompt comes in for this
        // session). See router subscribe handler's `if (runtime.query
        // !== null)` gate for the matching half of this invariant.
        runtime.settled = null;
        runtime.settledCursor = 0;
        runtime.latestUsage = null;
        runtime.interrupted = false;
      }
      // else: disposed + replaced — new loop owns the slots, skip cleanup.
    }
  })();
  runtime.loopPromise = loopPromise;
  return loopPromise;
}

/**
 * Push a user prompt into the channel feeding the active SDK query.
 * `ensureSessionLoop` must have been called first — throws otherwise.
 *
 * Emits TWO EventDeltas synchronously into the runtime buffer BEFORE
 * the prompt hits the channel:
 *
 *   1. `append { user_message }` — the SDK iterator NEVER echoes the
 *      user's prompt back (only assistant + tool_result envelopes), so
 *      without this iOS would never see its own message in the live
 *      stream until the next cold-load read the settled JSONL. Daemon
 *      synthesizes the append so iOS can render purely from event
 *      stream — no client-side optimistic state needed.
 *
 *   2. `turn_started` — flips the iOS "thinking…" indicator immediately
 *      (before SDK roundtrip + Claude's first byte; ~200-800ms gap).
 *
 * The user_message uuid we assign here matches the SDKUserMessage.uuid
 * we push to the channel, so SDK's JSONL write uses the same id (per
 * Paseo's pattern at claude-agent.ts:2298). Settled-from-JSONL and
 * live-from-buffer therefore resolve to the same id — no divergence.
 */
export function pushPrompt(
  runtime: SessionRuntime<EventDelta>,
  text: string,
  images?: readonly ImageAttachment[],
  userMessageUuid?: string,
): void {
  const channel = runtime.inputChannel;
  if (channel === null) {
    throw new Error(
      `pushPrompt: session ${runtime.sessionId} has no active loop — call ensureSessionLoop first`,
    );
  }
  // A fresh turn starts — clear any interrupt flag left over from a prior
  // turn whose terminal envelope never arrived, so it can't suppress this
  // turn's genuine turn_failed.
  runtime.interrupted = false;
  // Prefer the client-supplied uuid: iOS optimistically inserts the bubble
  // under it, and reusing it here (for both the synthesized append AND the
  // SDKUserMessage below) makes the live append, the JSONL row, and the
  // optimistic insert all share one id — the client dedupes by key, no
  // double bubble. Falls back to a fresh uuid when the client didn't send
  // one (new-session first send: no optimistic insert to reconcile).
  const userMsgUuid = userMessageUuid ?? crypto.randomUUID();
  runtime.addEvent({
    kind: "append",
    item: {
      type: "user_message",
      uuid: userMsgUuid,
      text,
      images: images && images.length > 0 ? [...images] : undefined,
    },
  });
  runtime.addEvent({ kind: "turn_started" });
  const userMessage = buildUserMessage(
    runtime.sessionId,
    text,
    userMsgUuid,
    images,
  );
  channel.push(userMessage);
  // Mirror the user prompt to the CCR bridge as well. The SDK iterator
  // never echoes user prompts back (only assistant + tool_result envelopes
  // — see this fn's docstring), so without this the cloud transcript would
  // show assistant replies with no preceding question. Same SDKUserMessage
  // object we feed the local query → local and cloud agree on the prompt.
  // No-op + error-isolated for pure (non-bridged) sessions via forwardToBridge.
  forwardToBridge(runtime, userMessage);
  // M3.7.4 unified activity edge — earliest "running" report (matches Claude
  // Code's onUserPrompt, remoteBridgeCore.ts: "mark running when the user
  // submits a prompt … before the first assistant token"). Makes claude.ai
  // show the session busy the instant the prompt lands, not ~200-800ms later
  // at the first model frame. Also cancels any pending M3.7 teardown timer
  // (a user prompt = activity). forwardToBridge re-asserts running on first
  // frame (deduped no-op locally + on bridge).
  markActivity(runtime, "running");
}

function buildUserMessage(
  sessionId: string,
  text: string,
  uuid: string,
  images?: readonly ImageAttachment[],
): SDKUserMessage {
  // SDK content blocks: image(s) prepended before text — matches Claude
  // Code's own paste flow ordering (`array<image,text>` per probe), so
  // the model sees the visual first then the question. Empty text is
  // allowed when only images were sent (skip text block in that case
  // so we don't feed the model an empty string).
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }
  > = [];
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      });
    }
  }
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
    uuid,
    session_id: sessionId,
  } as unknown as SDKUserMessage;
}

// ─── CCR bridge read-in (slice M2.2) ────────────────────────────────────

/** A prompt extracted from an inbound (claude.ai-typed) bridge message,
 *  shaped as the args `pushPrompt` takes. `uuid` is claude.ai's own message
 *  id — reused verbatim so the local synthesized append, the SDK JSONL row,
 *  AND the bridge write-back all share ONE id. The write-back then collides
 *  with claude.ai's own copy on that uuid and folds (server + UI both dedupe
 *  by uuid — M2.2 dedup-probe verified), so a bridge-originated prompt needs
 *  NO origin tracking / suppression: it goes through the same pushPrompt path
 *  as a local/iOS prompt. */
export interface InboundPrompt {
  text: string;
  /** claude.ai's message uuid (reused for dedup-by-uuid fold). */
  uuid?: string;
  images?: ImageAttachment[];
}

/** The inline image MIME types claude.ai vision accepts (mirrors the protocol
 *  `imageAttachment.mediaType` enum). Narrows the untyped inbound media_type
 *  string to ImageAttachment["mediaType"] so unsupported types are dropped. */
function isSupportedMediaType(v: unknown): v is ImageAttachment["mediaType"] {
  return v === "image/jpeg" || v === "image/png";
}

/**
 * Parse an inbound bridge SDKMessage into pushPrompt args, or null if it
 * isn't a drivable user prompt. The SDK already filters echoes of our own
 * outbound writes + re-deliveries before onInboundMessage fires, so this
 * only sees genuinely-new claude.ai prompts — but we still defensively
 * narrow the shape (it's @alpha untyped at our boundary) and reject
 * non-user / empty-content frames.
 *
 * Content shapes accepted (mirror of buildUserMessage's output):
 *   - `content: string`              → text
 *   - `content: [{type:"text",text}, {type:"image",source:{...}}, …]`
 *       → text blocks concatenated; image blocks mapped to ImageAttachment
 * Returns null when there's neither text nor an image (nothing to run).
 */
export function extractInboundPrompt(msg: unknown): InboundPrompt | null {
  const m = msg as {
    type?: unknown;
    uuid?: unknown;
    message?: { content?: unknown };
  };
  if (m.type !== "user") return null;
  const content = m.message?.content;

  let text = "";
  const images: ImageAttachment[] = [];
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const rawBlock of content) {
      if (typeof rawBlock !== "object" || rawBlock === null) continue;
      const block = rawBlock as {
        type?: unknown;
        text?: unknown;
        source?: { type?: unknown; media_type?: unknown; data?: unknown };
      };
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      } else if (
        block.type === "image" &&
        block.source?.type === "base64" &&
        isSupportedMediaType(block.source.media_type) &&
        typeof block.source.data === "string"
      ) {
        // mediaType is narrowed to the protocol enum by the guard above —
        // unsupported MIME types (claude.ai vision only accepts jpeg/png
        // inline) are dropped rather than fed to the SDK as a bad string.
        images.push({
          mediaType: block.source.media_type,
          data: block.source.data,
        });
      }
    }
  }

  if (text.length === 0 && images.length === 0) return null;
  const uuid = typeof m.uuid === "string" ? m.uuid : undefined;
  return {
    text,
    ...(uuid !== undefined ? { uuid } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

// ─── CCR bridge mirror (slice M1 write-out) ─────────────────────────────

/**
 * Mirror one raw SDKMessage to the CCR bridge, if this runtime is bridged.
 *
 * Parallel derivation to handleSdkMessage's enriched EventDelta fan-out:
 * the SAME query() stream forks into (a) enriched → WebRTC and (b) raw →
 * bridge → claude.ai. One tap, two sinks — no conversion between them.
 *
 * Forwarding is an ALLOWLIST that mirrors Claude Code's own
 * `isEligibleBridgeMessage` (claude-code-source bridge/bridgeMessaging.ts) —
 * "the server only wants user/assistant turns and slash-command system
 * events; everything else (tool_result, progress, etc.) is internal REPL
 * chatter":
 *   - `stream_event` → write       (live token streaming; the server fans
 *                                    these out to viewers but does NOT
 *                                    persist them — ephemeral by design.
 *                                    Desktop doesn't send deltas, but the
 *                                    transport accepts them — ccr-stream spike)
 *   - `assistant`    → write       (whole message; persisted server-side)
 *   - `user`         → write       (the prompt + tool_results; persisted)
 *   - `system` w/ `subtype:"local_command"` → write (slash-command echo, so
 *                                    claude.ai shows locally-run /commands.
 *                                    Other system subtypes — init / status /
 *                                    compact_boundary — are NOT forwarded:
 *                                    they're local lifecycle, not transcript.
 *                                    NOTE sidecode's headless query loop
 *                                    doesn't currently emit local_command
 *                                    frames — handled for source-parity +
 *                                    forward-compat, not because we produce
 *                                    them yet.)
 *   - `result`       → sendResult()(turn boundary — claude.ai stops its
 *                                    "working" spinner. NEVER write() the
 *                                    result frame: sendResult already emits
 *                                    one, writing it too would duplicate it
 *                                    and the cloud UI spins — the gotcha
 *                                    from spikes/ccr-perm)
 *   - everything else (compact_boundary, other system subtypes, hooks) →
 *     IGNORED. Compaction is explicitly excluded by Desktop too
 *     (isCompactSummary / compact_boundary are local-only, not cloud
 *     transcript) — this is permanent, not a TODO.
 *
 * Bridge errors are SWALLOWED: a flaky CCR transport must degrade ONLY the
 * mirror, never the query loop or the WebRTC fan-out (the pillar path).
 */
function forwardToBridge(
  runtime: SessionRuntime<EventDelta>,
  msg: SDKMessage,
): void {
  const bridge = runtime.bridge;
  if (bridge === null) return;
  try {
    const m = msg as { type?: unknown; subtype?: unknown };
    if (m.type === "result") {
      // Turn end: stop the spinner (sendResult). The idle reportState was
      // moved out of here in M3.7.4 — it now fires from handleResultEnvelope
      // via markActivity("idle"), which atomically updates runtime state +
      // arms the teardown timer + reports CCR. This branch keeps only
      // bridge-specific concerns (sendResult to stop the spinner +
      // checkpoint to persist SSE seq for M3.4 restart re-attach).
      bridge.sendResult();
      // M3.1 checkpoint — snapshot the SSE high-water mark to persisted
      // bridge worker state so a daemon restart (M3.4) can resume the SSE
      // stream with `initialSequenceNum = saved` and the server replays
      // only seq > saved (EXCLUSIVE) — at-least-once delivery, no
      // double-execution. Single-in-flight assumption documented on
      // BridgeWorkerState.lastSSESequenceNum: V0 doesn't track per-prompt
      // seq, so multi-prompt back-pressure could mis-checkpoint past an
      // unfinished prompt. Acceptable at V0 scale. Optional method (some
      // RuntimeBridge impls are simple test fakes).
      bridge.checkpoint?.();
    } else if (
      m.type === "stream_event" ||
      m.type === "assistant" ||
      m.type === "user" ||
      (m.type === "system" && m.subtype === "local_command")
    ) {
      // M3.7.4 — activity edge handled in handleSdkMessage (one place,
      // bridge-independent). forwardToBridge stays purely about CCR mirror:
      // bridge.reportState was already called from setActivity → markActivity
      // path (deduped on the bridge layer too). Just write the frame.
      bridge.write(msg);
    }
    // else: compact_boundary / other system subtypes / hooks — not mirrored.
  } catch {
    // Best-effort mirror — isolate transport failures from the pillar path.
  }
}

// ─── SDK message dispatch ───────────────────────────────────────────────

function handleSdkMessage(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKMessage,
): void {
  // M3.7.4 activity edge dispatch — must run BEFORE type-specific handlers
  // AND independently of bridge attach state (so pure non-bridged sessions
  // also benefit from autonomous-yield cancel). Three triggers:
  //   - `stream_event` / `assistant` → "running" (first frame of any turn,
  //     user-driven OR SDK-autonomous: scheduled task, hook response, async
  //     background work that wakes the SDK process without a user prompt)
  //   - `result` → "idle" (terminal envelope, every subtype counts: success,
  //     error_during_execution, error_max_turns, etc.)
  // setActivity dedupes — only the first running-edge per turn actually
  // transitions state + cancels timer; subsequent stream_events are no-ops.
  // `user` (tool_result) / `system` envelopes don't transition activity —
  // they happen MID-turn when activity is already "running".
  if (msg.type === "result") {
    markActivity(runtime, "idle");
  } else if (msg.type === "stream_event" || msg.type === "assistant") {
    markActivity(runtime, "running");
  }
  if (msg.type === "stream_event") {
    handleStreamEvent(runtime, state, msg);
  } else if (msg.type === "assistant") {
    handleAssistantEnvelope(runtime, state, msg);
  } else if (msg.type === "user") {
    handleUserEnvelope(runtime, state, msg);
  } else if (msg.type === "result") {
    // No turn-boundary JSONL re-read anymore: `settled` is kept current by
    // the continuous fold in SessionRuntime.addEvent (messages/fold.ts), so
    // it never depends on the SDK's async flush timing. handleResultEnvelope
    // emits turn_completed/turn_failed and stashes latestUsage on success.
    handleResultEnvelope(runtime, msg);
  } else if (msg.type === "system") {
    // Two `type: "system"` subtypes drive compact UI:
    //   - "status" with status:'compacting' → compact_started (UI banner)
    //   - "compact_boundary" → compact_applied (prune + divider) +
    //     prime expectingCompactSummary so the next user envelope is
    //     lifted to compact_summary
    // Other system subtypes (init etc) are still ignored.
    handleSystemMessage(runtime, state, msg);
  }
  // Others (hook_*, task_*, etc) ignored for V0.
}

/**
 * Dispatch on system subtype. SDK's `SDKStatusMessage` is transient
 * (not persisted to JSONL) — we only see it via the live stream, so
 * resume can't reconstruct "compacting in progress" state. That's
 * fine: resume always sees stable state, never mid-compact.
 *
 * `SDKCompactBoundaryMessage` IS persisted (the JSONL line tagged
 * subtype:"compact_boundary") so normalize() also emits a
 * compact_divider on cold-load. Both paths converge to the same
 * TimelineItem shape — see protocol/src/index.ts compact_divider.
 */
function handleSystemMessage(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKMessage,
): void {
  const m = msg as unknown as Record<string, unknown>;
  if (m.subtype === "status") {
    // SDKStatusMessage: status enum is 'compacting' | 'requesting' | null.
    // Only 'compacting' interests us — 'requesting' fires for every API
    // call and would be UI noise; null is the resting state.
    if (m.status === "compacting") {
      runtime.addEvent({ kind: "compact_started" });
    }
    return;
  }
  if (m.subtype === "compact_boundary") {
    handleCompactBoundary(runtime, state, m);
    return;
  }
}

/**
 * Pull compact metadata off the SDKCompactBoundaryMessage and emit the
 * `compact_applied` EventDelta iOS reducer needs. Also primes
 * `expectingCompactSummary` so handleUserEnvelope can lift the
 * immediately-following SDK-injected summary user message into a
 * `compact_summary` append (SDK live type doesn't carry the
 * isCompactSummary flag the JSONL persists, so we infer by sequence).
 *
 * Real-world JSONL samples have NEVER carried preservedSegment /
 * preservedMessages (manual /compact + auto-compact both go full-
 * compaction). Partial compaction only fires from REPL multi-select
 * UI, which sidecode shouldn't see. preservedUuids → undefined in
 * the 99% case; iOS reducer treats that as "drop everything".
 */
function handleCompactBoundary(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  m: Record<string, unknown>,
): void {
  const meta = m.compact_metadata as Record<string, unknown> | undefined;
  if (meta === undefined) return;
  const trigger = meta.trigger;
  if (trigger !== "manual" && trigger !== "auto") return;
  const preTokens = numberOrUndef(meta.pre_tokens);
  const postTokens = numberOrUndef(meta.post_tokens);
  if (preTokens === undefined || postTokens === undefined) return;
  const durationMs = numberOrUndef(meta.duration_ms);
  const uuid = typeof m.uuid === "string" ? m.uuid : undefined;
  if (uuid === undefined) return;

  // preserved_messages.uuids supersedes preserved_segment per SDK docs.
  // Both shapes carry the surviving message UUIDs differently — segment
  // gives head/anchor/tail, messages gives the full list. For V0 we
  // only forward the simpler `preserved_messages.uuids`. Partial-
  // compaction via preservedSegment fires only from REPL multi-select
  // UI sidecode shouldn't see; if it does happen, iOS reducer treats
  // undefined as full-compaction (drops everything) which is wrong but
  // recoverable on next reload. TODO V0.5+: also handle preservedSegment.
  const preservedMessages = meta.preserved_messages as
    | { uuids?: unknown }
    | undefined;
  const preservedUuids = Array.isArray(preservedMessages?.uuids)
    ? preservedMessages.uuids.filter((u): u is string => typeof u === "string")
    : undefined;

  runtime.addEvent({
    kind: "compact_applied",
    trigger,
    preTokens,
    postTokens,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(preservedUuids !== undefined ? { preservedUuids } : {}),
    uuid,
  });
  // Prime: the next user envelope is the SDK-injected summary message.
  state.expectingCompactSummary = true;
}

/**
 * Anthropic SDK fires one `result` envelope at the end of every turn,
 * shaped as a discriminated union on `subtype` (sdk.d.ts:3155):
 *   - `SDKResultSuccess` (subtype: 'success') — `result: string` carries
 *     the final assistant output text
 *   - `SDKResultError` (subtype: 'error_during_execution' |
 *     'error_max_turns' | 'error_max_budget_usd' |
 *     'error_max_structured_output_retries') — `errors: string[]` carries
 *     the failure reasons (NOT `result`)
 *
 * We must dispatch on subtype so iOS sees `turn_failed` (red banner) for
 * the error case rather than a deceptive `turn_completed` followed by a
 * second `turn_failed` from the catch block (the original bug observed
 * when "No conversation found with session ID" fired before cwd was
 * plumbed through).
 *
 * Usage stats are best-effort: SDK shape uses snake_case. Parse
 * defensively — missing fields become `undefined`.
 */
function handleResultEnvelope(
  runtime: SessionRuntime<EventDelta>,
  msg: SDKMessage,
): void {
  const r = msg as unknown as Record<string, unknown>;
  // Consume the interrupt flag: this terminal envelope belongs to the turn
  // the user just interrupted. Reset regardless of subtype so a stale flag
  // can't leak into a later turn (e.g. if the interrupt raced a success).
  const wasInterrupted = runtime.interrupted;
  runtime.interrupted = false;
  // M3.7.4 activity edge — `markActivity("idle")` is now fired from
  // handleSdkMessage's dispatch (one place, bridge-independent) BEFORE
  // we reach here. Don't re-call (would be a deduped no-op but reads
  // confusingly as "two edges per result envelope"). handleResultEnvelope
  // is now purely about emitting turn_completed / turn_failed deltas +
  // stashing latestUsage.
  const rawUsage = r.usage as Record<string, unknown> | undefined;
  const usage = rawUsage
    ? {
        inputTokens: numberOrUndef(rawUsage.input_tokens),
        outputTokens: numberOrUndef(rawUsage.output_tokens),
        cacheReadInputTokens: numberOrUndef(rawUsage.cache_read_input_tokens),
        cacheCreationInputTokens: numberOrUndef(
          rawUsage.cache_creation_input_tokens,
        ),
      }
    : undefined;

  if (r.subtype === "success") {
    runtime.addEvent({ kind: "turn_completed", usage });
    // Stash live for the context-window meter's resume seed — saves
    // a subscribe-time JSONL re-extraction in the common warm path
    // (subscriber dropped + reconnected after this turn). The
    // subsequent turn-boundary refresh will overwrite this with the
    // JSONL-derived value as belt-and-suspenders.
    if (usage !== undefined) runtime.latestUsage = usage;
    return;
  }
  // Any non-"success" subtype is an error variant. But if the user
  // interrupted this turn, the SDK ends it with `error_during_execution`
  // — that's the cancel's terminal envelope, not a real failure (the
  // router already emitted turn_canceled). Swallow it.
  if (wasInterrupted) return;
  // Pull the `errors: string[]` payload; fall back to the subtype name.
  const errors = Array.isArray(r.errors)
    ? (r.errors as unknown[]).filter((e): e is string => typeof e === "string")
    : [];
  const message =
    errors.length > 0
      ? errors.join("\n")
      : `SDK ${String(r.subtype ?? "error")}`;
  runtime.addEvent({ kind: "turn_failed", error: message });
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function handleStreamEvent(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKPartialAssistantMessage,
): void {
  // SDK types `event` as the upstream Beta union — go through `unknown`
  // and narrow defensively rather than importing every Beta type into
  // our runtime.
  const event = msg.event as unknown as Record<string, unknown>;
  const eventType = typeof event.type === "string" ? event.type : null;

  if (eventType === "message_start") {
    const message = event.message as Record<string, unknown> | undefined;
    const messageId = typeof message?.id === "string" ? message.id : null;
    state.currentMessageId = messageId;
    return;
  }

  if (eventType === "message_stop") {
    state.currentMessageId = null;
    return;
  }

  if (eventType === "content_block_start") {
    const block = event.content_block as Record<string, unknown> | undefined;
    const index = typeof event.index === "number" ? event.index : null;
    if (block?.type === "text" && index !== null && state.currentMessageId) {
      const synthUuid = `${state.currentMessageId}:${index}`;
      let perMsg = state.textBlockUuids.get(state.currentMessageId);
      if (!perMsg) {
        perMsg = new Map();
        state.textBlockUuids.set(state.currentMessageId, perMsg);
      }
      perMsg.set(index, synthUuid);
      runtime.addEvent({
        kind: "append",
        item: { type: "assistant_message", uuid: synthUuid, text: "" },
      });
    }
    // tool_use content_block_start ignored — handled atomically when the
    // `assistant` envelope arrives with full input.
    return;
  }

  if (eventType === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    const index = typeof event.index === "number" ? event.index : null;
    if (
      delta?.type === "text_delta" &&
      typeof delta.text === "string" &&
      delta.text.length > 0 &&
      index !== null &&
      state.currentMessageId
    ) {
      const uuid = state.textBlockUuids.get(state.currentMessageId)?.get(index);
      if (uuid) {
        runtime.addEvent({
          kind: "patch_text",
          uuid,
          deltaText: delta.text,
        });
      }
    }
    // input_json_delta ignored.
    return;
  }
  // content_block_stop, message_delta: ignored.
}

function handleAssistantEnvelope(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKAssistantMessage,
): void {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const parsed = toolUseBlock.safeParse(rawBlock);
    if (!parsed.success) continue;
    const t = parsed.data;
    if (state.appendedToolUseIds.has(t.id)) continue;
    state.appendedToolUseIds.add(t.id);
    const detail = buildDetailFromInput(t.name, t.input);
    state.pendingTools.set(t.id, detail);
    runtime.addEvent({
      kind: "append",
      item: {
        type: "tool_call",
        callId: t.id,
        name: t.name,
        summary: summaryFor(detail, t.name),
        status: "running",
        error: null,
        detail,
      },
    });
  }
}

function handleUserEnvelope(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKUserMessage,
): void {
  const content = (msg.message as { content?: unknown })?.content;

  // First check: if a compact just landed, the very next user envelope
  // is the SDK-injected summary message. SDK live type doesn't surface
  // isCompactSummary, so we infer-by-sequence. Lift to a regular
  // user_message append so iOS renders it (without the lift it'd be
  // dropped — handleUserEnvelope only processes tool_result blocks on
  // plain text user messages). Done BEFORE the tool_result loop because
  // summary content is plain text — no tool_result to process. The
  // summary intentionally uses the user_message variant rather than a
  // dedicated compact_summary one: getSessionMessages strips
  // isCompactSummary on resume so we couldn't render distinctly there
  // anyway (#13), and keeping it as user_message lets the upcoming
  // long-text max-height + sheet-trigger affordance handle both
  // summaries and paste-blob user inputs uniformly.
  if (state.expectingCompactSummary) {
    state.expectingCompactSummary = false;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (b): b is { type: "text"; text: string } =>
                  typeof b === "object" &&
                  b !== null &&
                  (b as { type?: unknown }).type === "text" &&
                  typeof (b as { text?: unknown }).text === "string",
              )
              .map((b) => b.text)
              .join("\n\n")
          : "";
    const uuid = typeof msg.uuid === "string" ? msg.uuid : undefined;
    if (text.length > 0 && uuid !== undefined) {
      runtime.addEvent({
        kind: "append",
        item: { type: "user_message", uuid, text },
      });
    }
    return;
  }

  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const parsed = toolResultBlock.safeParse(rawBlock);
    if (!parsed.success) continue;
    const t = parsed.data;
    const detail = state.pendingTools.get(t.tool_use_id);
    if (!detail) continue; // orphan tool_result — append happens in assistant envelope, which we may have missed
    const outputText = extractText(t.content);
    attachOutputToDetail(detail, outputText);
    runtime.addEvent({
      kind: "patch_tool_call",
      callId: t.tool_use_id,
      status: t.is_error ? "failed" : "completed",
      error: t.is_error ? outputText : null,
      // Shallow copy so the buffered EventDelta isn't aliased to the
      // pendingTools entry (which we'll drop next anyway, but defensive).
      detail: { ...detail },
    });
    state.pendingTools.delete(t.tool_use_id);
  }
}

// AsyncMessageInput is module-level export only for type clarity in tests
// that need to construct one directly. Production callers use ensureSessionLoop.
export type { AsyncMessageInput };
