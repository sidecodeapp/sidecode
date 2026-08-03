import semver from "semver";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

export {
  type ChunkEnvelope,
  ChunkReassembler,
  chunkMessage,
  isChunkEnvelope,
} from "./chunking.ts";
export {
  DEFAULT_MODEL,
  getDefaultModelId,
  MODEL_METADATA,
  MODELS,
  type ModelEntry,
  type ModelMetadata,
  prettyModel,
} from "./models.ts";
export {
  dtlsFingerprintTranscript,
  extractDtlsFingerprint,
} from "./sdp-fingerprint.ts";
export {
  type CommandContext,
  type CommandHandling,
  getCommandsForContext,
  isWhitelistedCommand,
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashCommandName,
  type SlashCommandSpec,
} from "./slash-commands.ts";

// ─── Protocol version ──────────────────────────────────────────────────────
//
// Single source of truth for "what wire schemas does this side speak."
// The protocol package IS the wire contract, so its semver IS the wire
// version — daemon and iOS both import this same value (whatever's in
// `packages/protocol/package.json`'s `version` field).
//
// Bumping = edit `packages/protocol/package.json` (e.g. `npm version
// patch`). No constant elsewhere to keep in sync; the package.json IS
// the source of truth, both at npm-install time and at runtime.
//
// Compatibility check (`isProtocolCompatible`) also lives in this
// package so the rule travels with the schemas it's protecting.
// Transports just call the helper; they don't reason about semver
// themselves.
//
// Bump policy:
//   - **patch** (0.0.1 → 0.0.2 / 1.2.3 → 1.2.4): additive only — a new
//     optional field, or a whole new frame type that older peers
//     harmlessly ignore (the daemon drops unknown command types, iOS
//     drops unknown event types; no `z.strictObject`, so extra fields
//     are stripped). NOTE: a new *enum case* on an EXISTING field is NOT
//     automatically additive — it's breaking for a closed `z.enum` the
//     daemon validates (old daemon rejects the whole frame) or for any
//     consumer that switches on the value without a default. Treat an
//     enum-case add as breaking unless that field is a loose string with
//     a fallback path. Compatible.
//   - **minor** (0.0.x → 0.1.0 during 0.x; 1.0.0 → 1.1.0 post-1.0):
//     0.x minor bump is breaking (npm semver convention for 0.x);
//     ≥1.0 minor bump is additive. The compat helper handles both.
//   - **major** (1.x → 2.0.0): breaking schema change post-1.0.
//   - **pre-release** (`0.5.0-beta.1`): NOT compatible with `0.5.0`
//     per semver convention — pre-releases are explicitly opt-in.
export const PROTOCOL_VERSION: string = pkg.version;

/**
 * True iff a remote peer reporting `remote` speaks a wire-compatible
 * schema set with this build's PROTOCOL_VERSION. Compatible means
 * "same breaking line", per the bump policy above:
 *
 *   - during 0.x the minor is the breaking axis → same `0.minor` line
 *     (`0.5.1` ↔ `0.5.9` compatible in both directions, `0.6.0` not)
 *   - ≥1.0 the major is the breaking axis → same major
 *   - pre-release on either side → exact match only (mid-development
 *     schemas churn; two builds are only known-compatible if identical)
 *
 * Deliberately NOT npm caret semantics. `satisfies(remote, ^local)` is
 * asymmetric — it rejects a remote with a LOWER patch on the same
 * breaking line, but the bump policy says patch bumps are additive and
 * old peers harmlessly ignore them. Symmetric same-line comparison is
 * the faithful implementation, and it guarantees the daemon (which
 * checks `hello` first) always rejects before iOS gets a chance to —
 * iOS's `server_info` re-check is pure drift defense.
 *
 * Returns `false` on unparseable input (defensive — we'd rather refuse
 * than blunder on with an unknown version that might or might not be
 * compatible).
 */
export function isProtocolCompatible(remote: string): boolean {
  const r = semver.parse(remote);
  const local = semver.parse(PROTOCOL_VERSION);
  if (!r || !local) return false;
  if (r.prerelease.length > 0 || local.prerelease.length > 0) {
    return semver.eq(r, local);
  }
  if (r.major !== local.major) return false;
  return local.major === 0 ? r.minor === local.minor : true;
}

/**
 * Which side is outdated, given the version an INCOMPATIBLE remote
 * reported. Only meaningful after `isProtocolCompatible(remote)`
 * returned false — incompatible versions are never equal, so the
 * semver-lower side is the one that needs updating.
 *
 * Returns from the caller's perspective: `"remote"` → the peer is
 * older (iOS calling this → tell the user to update the Mac app),
 * `"local"` → this build is older. Returns `null` when the input is
 * unparseable or equal to ours (a peer that rejected us while
 * reporting our own version is misbehaving, not outdated) — callers
 * fall back to direction-neutral "update both" copy.
 */
export function outdatedSide(remote: string): "local" | "remote" | null {
  if (!semver.valid(remote) || !semver.valid(PROTOCOL_VERSION)) return null;
  if (semver.eq(remote, PROTOCOL_VERSION)) return null;
  return semver.lt(remote, PROTOCOL_VERSION) ? "remote" : "local";
}

// ─── Pair offer ────────────────────────────────────────────────────────────
//
// The QR carries just enough to wire up signaling + identity-verify the
// daemon. Connection itself is WebRTC: client opens a SignalingClient to
// the room named after `daemonIdentityPublicKey`, daemon's offer arrives
// signed by the corresponding private key, client verifies fpSig against
// the QR-known pubkey, DTLS binds the channel.
//
// Two fields:
//   - `daemonIdentityPublicKey` — base64url ed25519 raw pubkey. Doubles as
//     the signaling room name AND the verification key for the daemon's
//     SDP fingerprint signature. The 16-hex daemon fingerprint is
//     `sha256(pubkey).slice(0,16)` — derived, not transmitted.
//   - `serviceName` — `os.hostname()` snapshot for the iOS confirm UI.
//
// The QR carries no expiry. Admission of an unknown pubkey is gated
// daemon-side by "is the desktop app's Pair window open" — that flag, not the
// QR, is the authority on "can a fresh client pair right now." A stale
// screenshot is harmless once the window closes.

export const PAIR_OFFER_VERSION = 2;

export const pairOfferFrame = z.object({
  type: z.literal("pair.offer"),
  v: z.number().int(),
  daemonIdentityPublicKey: z.string(), // base64url ed25519 raw pubkey
  serviceName: z.string(),
});

export type PairOfferFrame = z.infer<typeof pairOfferFrame>;

/**
 * On-the-wire pair offer with one-character keys. The QR is the only
 * place this frame ever appears, and every character in the QR payload
 * costs us ~1 module in the rendered grid. Compacting to single letters
 * keeps the QR a couple version steps smaller.
 */
const pairOfferWire = z.object({
  v: z.number().int(),
  k: z.string(), // daemonIdentityPublicKey
  s: z.string(), // serviceName
});
export type PairOfferWire = z.infer<typeof pairOfferWire>;

export function toPairOfferWire(offer: PairOfferFrame): PairOfferWire {
  return { v: offer.v, k: offer.daemonIdentityPublicKey, s: offer.serviceName };
}

export function fromPairOfferWire(wire: unknown): PairOfferFrame {
  const parsed = pairOfferWire.parse(wire);
  return {
    type: "pair.offer",
    v: parsed.v,
    daemonIdentityPublicKey: parsed.k,
    serviceName: parsed.s,
  };
}

/** Encode a pair offer to its QR wire form: base64url of UTF-8 JSON. */
export function encodePairOffer(offer: PairOfferFrame): string {
  const json = JSON.stringify(toPairOfferWire(offer));
  return base64urlEncodeUtf8(json);
}

/** Decode the wire form produced by `encodePairOffer`. */
export function decodePairOfferPayload(payload: string): PairOfferFrame {
  return fromPairOfferWire(JSON.parse(base64urlDecodeUtf8(payload)));
}

function base64urlEncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeUtf8(b64: string): string {
  const padded = b64 + "===".slice(0, (4 - (b64.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ─── Events: daemon → client (server-pushed, no requestId) ─────────────────

export const sessionUpdatedEvent = z.object({
  type: z.literal("session.updated"),
  sessionId: z.string(),
  lastModified: z.number(),
});

export const approvalRequestEvent = z.object({
  type: z.literal("approval.request"),
  sessionId: z.string(),
  requestId: z.string(),
  toolName: z.string(),
  toolUseId: z.string(),
  title: z.string().optional(),
  input: z.unknown(),
});

export const sessionDivergedEvent = z.object({
  type: z.literal("session.diverged"),
  sessionId: z.string(),
  branches: z.array(z.string()).min(2),
});

export const sessionForkedEvent = z.object({
  type: z.literal("session.forked"),
  from: z.string(),
  to: z.string(),
  upToMessageId: z.string(),
});

export const event = z.discriminatedUnion("type", [
  sessionUpdatedEvent,
  approvalRequestEvent,
  sessionDivergedEvent,
  sessionForkedEvent,
]);

export type Event = z.infer<typeof event>;

// ─── Session control state stream (issue #17) ─────────────────────────────
//
// `sessionState` is daemon → iOS's PER-SESSION view-model for the list +
// detail-header surfaces. Carries both live fields (activity, model,
// lastActivityAt) that flip during a session's lifecycle AND static
// fields (title, cwd, ...) that rarely change but iOS still needs.
//
// Delivered via the `subscribeSessions` RPC (one daemon-wide stream, NOT
// per-session) — iOS pairs once, gets `initial: [{sessionId, state}, ...]`
// for every session the daemon knows about, then receives
// `session_state_changed` / `session_state_removed` push envelopes for
// every transition. iOS stores entries in a TanStack DB custom-sync
// collection; views consume via `useLiveQuery` with declarative
// `.where()` / `.orderBy()`. See [[project_v0_session_list_design]].
//
// Wire policy: LAST-WRITE-WINS, NO cursor. A push always carries the
// FULL state; client just overwrites. Missing pushes self-heal on the
// next transition (no replay needed — this is current-state, not an
// event log). Contrast with `eventDelta` / `eventFrame` which IS cursor-
// keyed and needs ordered fold (transcript timeline).
//
// `sessionState` is the sole session-list view-model: it fully replaced
// the old `listSessions` RPC + `sessionInfo` record (deleted once iOS
// migrated to this stream — see project_v0_session_list_design "协议
// 同步收口").

export const sessionActivity = z.enum(["idle", "running", "requires_action"]);
export type SessionActivity = z.infer<typeof sessionActivity>;

/**
 * Full daemon-side view of a session for the iOS list + detail-header
 * surfaces. Driven by `SessionRuntime.setActivity` / `setModel` (live
 * fields) + persisted disk metadata (static fields).
 *
 * For sessions with a live `SessionRuntime` in the daemon, the values
 * are the in-memory truth. For sessions that exist only on disk
 * (sidecode metadata, no runtime yet — e.g. between daemon boot and
 * first sendPrompt), the values are synthesized from disk metadata
 * with `activity = "idle"`. iOS doesn't distinguish — both are just
 * entries in the collection.
 */
export const sessionState = z.object({
  /** "idle" | "running" | "requires_action". `requires_action`
   *  reserved for V0.5+ permission flow; V0 daemon never emits it. */
  activity: sessionActivity,
  /** Raw SDK model key (e.g. `claude-opus-4-7[1m]`). Null when no model
   *  was committed yet (brand-new session, picker hasn't bootstrapped). */
  model: z.string().nullable(),
  /** Epoch ms of the most recent activity transition (start OR end of
   *  turn). iOS list view sorts by this `desc`. Live updates on every
   *  push; persisted to disk at turn-complete for restart durability. */
  lastActivityAt: z.number(),
  /** Auto-derived (from first prompt) or user-renamed title. */
  title: z.string(),
  /** Local working directory the session is rooted in. iOS uses this for
   *  the detail-screen git status bar (NOT for list rows — see
   *  project_v0_session_list_design). */
  cwd: z.string(),
  /** Epoch ms session creation. Immutable. */
  createdAt: z.number(),
  /** V0 archive UI not exposed but field present for forward compat. */
  isArchived: z.boolean(),
  /** V0 owned sessions are always `bypassPermissions`. */
  permissionMode: z.enum(["bypassPermissions", "default"]),
  /** True when this session has an active CCR bridge (visible + drivable from
   *  claude.ai). Daemon-derived from BridgeService worker-state presence; iOS
   *  shows the bridged badge + the upgrade/downgrade toggle. Optional on the
   *  wire so a client's optimistic insert can omit it (undefined = pure). */
  bridged: z.boolean().optional(),
});
export type SessionState = z.infer<typeof sessionState>;

/** Subscribe-once RPC: gets initial snapshot of ALL session states the
 *  daemon knows about + opens the stream for live `session_state_changed`
 *  / `session_state_removed` push envelopes. WebRTC channel close →
 *  implicit unsubscribe via `ctx.onDisconnect` (router-side).
 *
 *  iOS calls this once per WebRTC connection (after pair + hello). The
 *  TanStack DB sync handler is the ONLY consumer; views read via
 *  `useLiveQuery`. */
export const subscribeSessionsCommand = z.object({
  type: z.literal("subscribeSessions"),
  requestId: z.string(),
});

export const subscribeSessionsResponse = z.object({
  type: z.literal("subscribeSessions.response"),
  requestId: z.string(),
  /** Full daemon-side snapshot. Empty array on a fresh daemon. */
  initial: z.array(
    z.object({
      sessionId: z.string(),
      state: sessionState,
    }),
  ),
});

/** Server push — a session's state changed. Client overwrites by
 *  `sessionId` (last-write-wins). Fires on every transition: activity
 *  flip, model change, title rename (V0.5+), archive (V0.5+),
 *  lastActivityAt bump. */
export const sessionStateChangedEvent = z.object({
  type: z.literal("session_state_changed"),
  sessionId: z.string(),
  state: sessionState,
});

/** Server push — a session was deleted server-side (sidecode delete RPC,
 *  bridge cse_ delete observed via M3.5 reconnect classifier, etc.).
 *  Client removes the entry from its collection. */
export const sessionStateRemovedEvent = z.object({
  type: z.literal("session_state_removed"),
  sessionId: z.string(),
});

// ─── Timeline items (server-normalized message stream) ────────────────────
//
// Daemon translates raw SDK SessionMessage[] (Anthropic ContentBlock[] inside
// `message`) into a flat TimelineItem[]: one item per assistant text segment,
// one per user text segment, one per paired tool_use+tool_result. iOS just
// renders — no flattening, no tool-pairing on the client.
//
// Field naming: camelCase throughout, even where SDK uses snake_case in INPUT
// shapes (`file_path` → `filePath`, `old_string` → `oldString`). Output shapes
// in SDK are already camelCase (`structuredPatch`, `numLines`).

// ─── Shared content schemas (referenced by both timelineItem + sendPromptCommand) ──

/**
 * Image attachment. V0 accepts only base64 — daemon forwards as-is into
 * Anthropic SDK's `{type:'image', source:{type:'base64', media_type, data}}`
 * content block. Format limited to JPEG/PNG: mobile picker pipeline always
 * compresses to JPEG (Opus 4.7 long edge 2576px), PNG slot exists for
 * future pasted-screenshot path that wants to preserve transparency.
 *
 * Wire size: a single 2576x1448 JPEG q0.85 ≈ 600KB-1MB base64. Chunking
 * protocol (chunking.ts) splits at 60K chars, so a typical image flows
 * as ~10-15 chunks over the DataChannel.
 */
export const imageAttachment = z.object({
  data: z.string(),
  mediaType: z.enum(["image/jpeg", "image/png"]),
});
export type ImageAttachment = z.infer<typeof imageAttachment>;

/**
 * Anthropic API stop_reason — verbatim enum from the SDK.
 * `null` is significant: it indicates the message was interrupted —
 * either the user called `interrupt()` mid-stream, or the SDK shut
 * down before the turn completed. iOS shows a "[stopped]" badge.
 *
 * (`pause_turn` shows up when the model voluntarily yields; `refusal`
 * when it declines to answer. We carry both so UI can theme them
 * differently in V0.5+, though V0 treats anything-non-null as "normal
 * completion" visually.)
 */
export const assistantStopReason = z
  .enum([
    "end_turn",
    "tool_use",
    "max_tokens",
    "stop_sequence",
    "pause_turn",
    "refusal",
    "model_context_window_exceeded",
  ])
  .nullable();
export type AssistantStopReason = z.infer<typeof assistantStopReason>;

export const grepMode = z.enum(["content", "files_with_matches", "count"]);
export type GrepMode = z.infer<typeof grepMode>;

/**
 * Per-tool semantic detail. Each variant is a render hint for iOS — bash/read
 * fence the output for tree-sitter highlight, edit/write surface a unified
 * diff, grep/glob just dump the rg/glob text blob.
 *
 * Reality of the data we work from: `getSessionMessages()` strips the sidecar
 * `toolUseResult` field that Claude Code writes to disk (see normalize.ts).
 * What's left in tool_result is the textual content the model SAW — so we
 * can't rebuild structuredPatch/gitDiff/exitCode/numFiles/etc. on the daemon.
 * Detail variants therefore carry the raw input metadata + a single text
 * `output` blob, and edit/write diffs are computed via jsdiff from input
 * (Edit: old/new; Write: empty/content).
 *
 * `unknown` is the fallback for tools without a typed variant
 * (NotebookEdit, MCP*, etc.). iOS renders it as a "Used <name>" row;
 * the sheet shows pretty-printed input + raw output text.
 */
export const toolCallDetail = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bash"),
    command: z.string(),
    /** Claude-generated active-voice short summary (BashInput.description). */
    description: z.string().optional(),
    /** Combined text output the model saw (stdout+stderr+errors as one blob).
     *  Empty / preview-only when `runInBackground: true` — the real output
     *  lives in `/tasks/{taskId}.output` and is owned by the SDK's
     *  background task subsystem (see V0.5+ background-tasks panel). */
    output: z.string(),
    /** Mirrors SDK input `run_in_background`. Tells the iOS transcript this
     *  bash spawn was fire-and-forget — the row should link to the
     *  Background Tasks panel rather than show its output inline. */
    runInBackground: z.boolean().optional(),
    /** Background task ID (`b3v2ethee`-style 8-char). Parsed out of
     *  tool_result by daemon when `runInBackground:true`. Lets the
     *  transcript row deep-link to the Background Tasks panel entry. */
    taskId: z.string().optional(),
  }),
  z.object({
    type: z.literal("read"),
    filePath: z.string(),
    /** File content as the model saw it (line-number prefix stripped). */
    content: z.string(),
    /** tree-sitter language hint derived from file extension (sidecode-side). */
    language: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
    /** PDF page range, only set for PDF reads. */
    pages: z.string().optional(),
  }),
  z.object({
    type: z.literal("edit"),
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
    /** Unified diff computed by daemon via jsdiff(filePath, oldString, newString). */
    unifiedDiff: z.string(),
  }),
  z.object({
    type: z.literal("write"),
    filePath: z.string(),
    content: z.string(),
    /** Unified diff against empty (treats every Write as "new file"); we can't
     * tell create-vs-update without the sidecar, so we always show all-add. */
    unifiedDiff: z.string(),
  }),
  z.object({
    type: z.literal("grep"),
    pattern: z.string(),
    path: z.string().optional(),
    mode: grepMode,
    /** Raw rg output as the model saw it. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("glob"),
    pattern: z.string(),
    path: z.string().optional(),
    /** Raw glob output (newline-separated paths) as the model saw it. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("agent"),
    /** SDK `Agent.input.subagent_type` — registered subagent name (e.g.
     *  "Explore", "Plan", "general-purpose"). SDK marks it optional;
     *  daemon stores "" when absent (default catch-all agent). */
    subagentType: z.string(),
    description: z.string(),
    /** SDK `Agent.input.model` — per-spawn model override ("haiku" etc.).
     *  Only present when the parent explicitly overrode; the common
     *  inherit-from-parent case has no model in input and is NOT
     *  reconstructible (sidecar stripped), so absence ≠ default model. */
    model: z.string().optional(),
    /** Original prompt handed to the subagent. May be long. */
    prompt: z.string(),
    /** Final text the subagent returned to the parent conversation.
     *  Subagent's intermediate tool calls and chain-of-thought are NOT
     *  here — they live in the subagent JSONL and surface via the
     *  Background Tasks panel ("View transcript" link) in V0.5+. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("web_fetch"),
    url: z.string(),
    /** Extraction prompt — describes what to pull from the page. */
    prompt: z.string(),
    /** Lossy-by-design summary the fetch-side small model produced.
     *  Not raw page HTML; see Claude Code docs for WebFetch behavior. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("web_search"),
    query: z.string(),
    /** Returned result titles + URLs as the model saw them. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("task_create"),
    /** SDK does NOT pass taskId in input — daemon parses it out of the
     *  tool_result text ("Created task #N: …"). Required field because
     *  every subsequent TaskUpdate/TaskStop refers to it. */
    taskId: z.string(),
    /** Short label shown in todo lists. */
    subject: z.string(),
    description: z.string().optional(),
    /** Present-progressive form for "in-progress" rendering
     *  ("Installing foo" vs "Install foo"). */
    activeForm: z.string().optional(),
  }),
  z.object({
    type: z.literal("task_update"),
    /** SDK uses `taskId` here (camelCase) — kept verbatim. */
    taskId: z.string(),
    status: z
      .enum(["pending", "in_progress", "completed", "cancelled"])
      .optional(),
    activeForm: z.string().optional(),
  }),
  z.object({
    type: z.literal("task_stop"),
    /** SDK input field is `task_id` (snake_case, inconsistent with
     *  TaskUpdate's camelCase). Daemon normalizes to camelCase here. */
    taskId: z.string(),
  }),
  z.object({
    type: z.literal("ask_user"),
    /** The questions Claude posed. Each may be single- or multi-select. */
    questions: z.array(
      z.object({
        question: z.string(),
        header: z.string(),
        multiSelect: z.boolean(),
        options: z.array(
          z.object({
            label: z.string(),
            description: z.string(),
          }),
        ),
      }),
    ),
    /** User's selected option labels — daemon parses out of tool_result.
     *  Same array order as `questions`; each element is the chosen label
     *  (or comma-joined labels if multiSelect). Undefined while pending. */
    answers: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("schedule_wakeup"),
    /** Seconds from now until Claude re-fires; SDK clamps to [60, 3600]. */
    delaySeconds: z.number(),
    /** Short user-facing reason, shown in transcript + telemetry. */
    reason: z.string(),
    /** Prompt to fire on wake-up — typically a re-invocation of /loop. */
    prompt: z.string(),
  }),
  z.object({
    type: z.literal("monitor"),
    /** Watch command (typically `tail -f X`, `gh pr checks --watch`, etc.). */
    command: z.string(),
    description: z.string().optional(),
    /** Background task ID — same role as bash.taskId. Monitor always
     *  spawns a background task (that's its whole purpose). */
    taskId: z.string().optional(),
    /** Initial output preview / handshake message. The live stream of
     *  output lines flows through the Background Tasks panel, not here. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("unknown"),
    /** Raw SDK tool name — becomes the row summary ("Used <toolName>"). */
    toolName: z.string(),
    input: z.unknown(),
    output: z.string(),
  }),
]);
export type ToolCallDetail = z.infer<typeof toolCallDetail>;

const toolCallItem = z.object({
  type: z.literal("tool_call"),
  /** Mirrors SDK tool_use_id; pairs the call with its result for daemon-side. */
  callId: z.string(),
  /** Raw SDK tool name ("Bash", "Edit", "Read", "WebFetch", ...). */
  name: z.string(),
  /** Daemon-derived row object label — iOS prepends a past-tense verb from
   *  detail.type ("Edited foo.ts", 'Searched "TODO"'; see app tool-verbs.ts). */
  summary: z.string(),
  /**
   * V0 reads settled JSONL so most tool_calls arrive `completed` or `failed`.
   * `running` is a forward-compat slot for the streaming slice — when we wire
   * partial messages from `query()`, a tool_use without its paired tool_result
   * will surface as `running` until the result lands. Producers in V0 never
   * emit it; UI may still render it as a "no signal yet" placeholder.
   */
  status: z.enum(["completed", "failed", "running"]),
  /** Tool result error text when status="failed", null otherwise. */
  error: z.string().nullable(),
  detail: toolCallDetail,
  /** Reserved extension point — wire-stable when we eventually add fields. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ToolCallItem = z.infer<typeof toolCallItem>;

export const timelineItem = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    /** SDK SessionMessage uuid for the surrounding message envelope. */
    uuid: z.string(),
    /** Concatenated text from all text content blocks in the message.
     *  May be empty when the user sent only image(s) with no caption. */
    text: z.string(),
    /** Images attached to this user message, in the order they appear
     *  in the SDK content block array. Daemon decodes from
     *  `{type:'image', source:{type:'base64', media_type, data}}` blocks. */
    images: z.array(imageAttachment).optional(),
  }),
  z.object({
    type: z.literal("assistant_message"),
    uuid: z.string(),
    text: z.string(),
    /** Anthropic stop_reason. `null` (vs undefined) is significant —
     *  it indicates the assistant message was interrupted before the
     *  model wrote its own stop_reason. UI shows a "[stopped]" badge
     *  in that case. `undefined` means the daemon didn't have the
     *  field yet (live streaming partial), not the same thing. */
    stopReason: assistantStopReason.optional(),
  }),
  toolCallItem,
  // ─── Compact divider ─────────────────────────────────────────────────
  // Visual marker for "the conversation was compacted here." Produced
  // ONLY by the iOS reducer consuming a live `compact_applied`
  // EventDelta. Resume can't emit one — SDK's getSessionMessages strips
  // `subtype` / `compactMetadata` from system messages, so normalize
  // has no way to identify a compact_boundary on disk. Tracked in
  // thinkite/thinkite#13. Live-only divider is the V0 trade.
  //
  // Renders as a horizontal divider + caption ("Context compacted ·
  // 215k → 18k (manual)"). UI never lets the user mistake it for a
  // chat message — it's chrome, not content.
  z.object({
    type: z.literal("compact_divider"),
    /** SDK SessionMessage uuid of the originating compact_boundary
     *  system message (forwarded by daemon on the compact_applied
     *  delta). Stable key. */
    uuid: z.string(),
    /** Manual `/compact` vs SDK auto-compact. Caption tag for the
     *  divider; doesn't change layout. */
    trigger: z.enum(["manual", "auto"]),
    /** Token counts before / after compaction (from compactMetadata).
     *  Powers the divider's `215k → 18k` caption. */
    preTokens: z.number(),
    postTokens: z.number(),
  }),
]);
export type TimelineItem = z.infer<typeof timelineItem>;

/**
 * Incremental update applied to an iOS-side timeline during a live turn.
 * The daemon's runtime emits these into a per-session ring buffer; the
 * router fans them out to subscribers (slice G). iOS replays buffered
 * deltas to reach the current rendering state.
 *
 * Shape rationale:
 *   - `append` covers any whole new TimelineItem (assistant_message bubble
 *     created from first text chunk; tool_call with status="running" when
 *     a tool_use lands).
 *   - `patch_text` is the hot path during streaming — appended to the most
 *     recent assistant_message item identified by `uuid`.
 *   - `patch_tool_call` flips status (running → completed/failed), sets
 *     error text, and replaces detail with a fresh copy carrying tool_result
 *     output text (slotted into the right per-variant field by the daemon
 *     so iOS doesn't re-implement that logic).
 *
 * Identifier conventions during a live turn:
 *   - assistant_message `uuid`: synthetic `${anthropicMessageId}:${blockIndex}`
 *     (stable across the multiple stream_events for one content block, but
 *     diverges from the JSONL envelope uuid that batch normalize uses on
 *     cold-start). They never coexist in iOS view, so the divergence is OK.
 *   - tool_call `callId`: Anthropic tool_use_id, identical live + settled.
 */
/**
 * Per-turn token usage. Lifted into a named schema (rather than inlined
 * on `turn_completed` only) because two surfaces consume the same
 * shape:
 *   - `eventDelta.turn_completed.usage` — live broadcast after each turn.
 *   - `subscribeResponse.initialUsage` — resume-time seed extracted
 *     from the last assistant message in the JSONL, so the iOS
 *     context-window meter shows a number immediately on session open
 *     rather than waiting for the next live turn.
 *
 * Field naming converts Anthropic's snake_case to sidecode's camelCase
 * (one place — both surfaces inherit). All fields optional because
 * different SDK code paths populate different subsets, and cache_*
 * are always undefined for very-first-turn responses.
 */
export const turnUsage = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
});
export type TurnUsage = z.infer<typeof turnUsage>;

export const eventDelta = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("append"),
    /** Whole TimelineItem to push at the end of the rendered transcript. */
    item: timelineItem,
  }),
  z.object({
    kind: z.literal("patch_text"),
    /** uuid of the assistant_message item to append `deltaText` into. */
    uuid: z.string(),
    deltaText: z.string(),
  }),
  z.object({
    kind: z.literal("patch_tool_call"),
    /** Anthropic tool_use_id of the existing tool_call to update. */
    callId: z.string(),
    /** Terminal status — daemon never patches back to "running". */
    status: z.enum(["completed", "failed"]),
    /** Tool result error text when status="failed", null otherwise. */
    error: z.string().nullable(),
    /** Replacement detail with output slotted into the right field. */
    detail: toolCallDetail,
  }),
  // ─── Turn lifecycle ────────────────────────────────────────────────
  // Bracket each Claude turn so iOS can render "thinking…" / show-stop /
  // hide-stop / failure-toast / canceled-marker without inferring from
  // event timing. Emitted by run-query (turn_started before pushPrompt
  // fans out, turn_completed on `result` envelope, turn_failed in the
  // catch where F2 swallowed errors) and by router's interrupt handler
  // (turn_canceled after query.interrupt() resolves).
  z.object({
    kind: z.literal("turn_started"),
  }),
  z.object({
    kind: z.literal("turn_completed"),
    /** Optional usage stats lifted from the SDK `result` envelope.
     *  Same shape reused by `subscribeResponse.initialUsage` for the
     *  resume-time meter seed. */
    usage: turnUsage.optional(),
  }),
  z.object({
    kind: z.literal("turn_failed"),
    error: z.string(),
  }),
  z.object({
    kind: z.literal("turn_canceled"),
  }),
  // ─── Compact lifecycle (nested inside turn_started/turn_completed) ───
  // SDK runs compaction either when user invokes `/compact` or when its
  // own auto-compact heuristic fires before processing a normal turn.
  // Either way it happens INSIDE an active turn — turn_started has
  // already fired, turn_completed hasn't yet. Compact UI lives in its
  // own state slot (`isCompacting`) parallel to `isRunning` so the
  // "Compacting context…" indicator can show alongside the normal
  // running state.
  z.object({
    /** Emitted when the daemon sees the SDK's transient
     *  `SDKStatusMessage { status: 'compacting' }` (not persisted to
     *  JSONL — live-only signal). Carries no trigger field because
     *  status messages don't know manual-vs-auto; the divider added
     *  by `compact_applied` carries that. */
    kind: z.literal("compact_started"),
  }),
  z.object({
    /** Emitted when the daemon sees `SDKCompactBoundaryMessage`. iOS
     *  reducer responds by (a) filtering `items` to keep only
     *  `preservedUuids`, (b) appending a `compact_divider` TimelineItem
     *  for the visual marker, (c) flipping `isCompacting` back to
     *  false. The next live `turn_completed.usage` then naturally
     *  drops the context meter. */
    kind: z.literal("compact_applied"),
    trigger: z.enum(["manual", "auto"]),
    preTokens: z.number(),
    postTokens: z.number(),
    durationMs: z.number().optional(),
    /** UUIDs of messages that survive compaction (preserved tail).
     *  Undefined / empty = full compaction (the 99% case — manual
     *  /compact + auto-compact both go this way). Defined only when
     *  Claude Code's partial-compaction path fires (REPL multi-select
     *  UI), which sidecode rarely sees. */
    preservedUuids: z.array(z.string()).optional(),
    /** Mirror of the compact_boundary message's uuid — used by the
     *  reducer as the divider TimelineItem's uuid so live + resume
     *  paths render the same identity. */
    uuid: z.string(),
  }),
]);
export type EventDelta = z.infer<typeof eventDelta>;

// ─── Streaming-session commands (client → daemon) ──────────────────────────
//
// All four request a per-session control action and get a correlated response.
// Live stream events arrive as `eventFrame`s tagged with `sessionId` (no
// requestId) — those are server-initiated, fanned out from the runtime
// to subscribers. ws disconnect is treated as an implicit `unsubscribe-all`
// for that connection (no RPC needed).

/**
 * Subscribe to a session's live event stream.
 *
 * Two paths, dispatched daemon-side on whether the client passes
 * resume metadata:
 *
 * **Cold path** (no `sinceCursor` / `sinceEpoch`): daemon reads the
 * full settled snapshot from JSONL and returns it inline on the
 * response, then live events flow with monotonically-increasing
 * cursor > response.cursor. Used on first subscribe AND on app cold
 * start where the in-memory cursor was lost.
 *
 * **Warm path** (resume — `sinceCursor` + `sinceEpoch` provided):
 * if `sinceEpoch` matches the daemon's current process epoch AND
 * `sinceCursor` is still within the runtime's ring buffer, daemon
 * returns an EMPTY `settled[]` + `recovered: true`, then synchronously
 * replays events with cursor > sinceCursor (these arrive as `event`
 * frames AFTER the subscribe.response). Used by the facade on
 * WebRTC reconnect — client preserves its in-memory collection and
 * only catches up on the gap.
 *
 * If the warm path can't be served (epoch mismatch from daemon
 * restart, or sinceCursor predates the ring buffer), daemon falls
 * back transparently to the cold path: full settled[] + recovered:
 * false. Client sees recovered:false and truncates its collection
 * before ingesting settled[].
 */
export const subscribeCommand = z.object({
  type: z.literal("subscribe"),
  requestId: z.string(),
  sessionId: z.string(),
  /** Warm-path resume — last cursor the client saw on this session.
   *  Daemon serves incrementally from cursor+1. Undefined = cold path. */
  sinceCursor: z.number().optional(),
  /** Warm-path epoch guard — daemon's process nonce from the previous
   *  subscribe.response on this session. Mismatch (daemon restarted,
   *  ring buffer is fresh) → fallback to cold path automatically. */
  sinceEpoch: z.string().optional(),
  /** Brand-new-session fast path. The new-session screen sets this on
   *  the FIRST subscribe of a session it just created (route-derived:
   *  the `?new=1` param). It tells the daemon "no JSONL exists for this
   *  session yet, and a create-path sendPrompt is concurrently spinning
   *  up the runtime" — so the daemon serves the in-memory snapshot
   *  SYNCHRONOUSLY and skips the (expensive + race-prone) JSONL scan.
   *
   *  Why it matters: the cold path's `getMessages` does a full
   *  ~20-project-key fs scan for a not-yet-existent session. That await
   *  yields, and the concurrent create-path `pushPrompt` advances the
   *  runtime cursor past the synthesized `user_message` / `turn_started`
   *  during the window — they then land in neither `settled` (empty
   *  JSONL) nor the replay window, so the new session's first message
   *  never renders. No await on this path → no interleaving window.
   *
   *  Only honored when `sinceCursor` is absent (first subscribe). A
   *  reconnect carries a resume hint and takes the warm/cold path, so a
   *  stale flag can never blank an existing transcript. */
  isNew: z.boolean().optional(),
});

export const subscribeResponse = z.object({
  type: z.literal("subscribe.response"),
  requestId: z.string(),
  sessionId: z.string(),
  /** Settled JSONL state at subscribe time. Empty array on the warm
   *  path (recovered:true) — client preserves its in-memory state
   *  and consumes the replayed event frames instead. */
  settled: z.array(timelineItem),
  /** Runtime cursor at subscribe time. Client stores this as the
   *  high-water mark; subsequent live event frames carry cursors >
   *  this value, and the next reconnect passes this as sinceCursor. */
  cursor: z.number(),
  /** Daemon's process epoch nonce. Stable for the daemon's lifetime
   *  (regenerated on daemon boot). Client passes back as sinceEpoch
   *  on reconnect — mismatch triggers cold-path fallback. */
  epoch: z.string(),
  /** Server-side decision: true = warm-path incremental resume served
   *  (client may merge incoming events into existing collection);
   *  false = full snapshot returned (client should truncate the
   *  collection and ingest `settled` from scratch). Always false on
   *  the cold path; true on the warm path when both epoch matches
   *  AND sinceCursor is within the ring buffer. */
  recovered: z.boolean(),
  /** Optional usage seed for the context meter — extracted by daemon
   *  from the most recent assistant message in the JSONL (via SDK's
   *  `getSessionMessages`, whose `message: unknown` carries the raw
   *  Anthropic envelope with its `usage` field intact). Lets the
   *  meter render immediately on resume rather than waiting for the
   *  next live `turn_completed`. Undefined when the session has no
   *  assistant messages yet or its last assistant message had no
   *  usage payload (e.g. a tool-only turn). Skipped on the warm path
   *  — client already has the latest usage from the live stream. */
  initialUsage: turnUsage.optional(),
});

export const unsubscribeCommand = z.object({
  type: z.literal("unsubscribe"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const unsubscribeResponse = z.object({
  type: z.literal("unsubscribe.response"),
  requestId: z.string(),
});

// ─── Model picker ──────────────────────────────────────────────────────
//
// Model list + metadata moved out of the protocol-as-wire schemas and into
// `./models.ts` as a plain TS constant. Daemon + iOS both import `MODELS`
// / `DEFAULT_MODEL` / `prettyModel` directly — no more `getModels` RPC,
// no more `useQuery` loading state on iOS.
//
// `effort` deliberately omitted from sendPrompt / setSessionSelection:
// sidecode V0 trusts Claude's adaptive thinking + per-account
// `Settings.effortLevel` defaults, doesn't expose a per-session effort
// knob. Power users tweak via Desktop `/effort` slash command which
// persists to settings.json; sidecode honors that implicitly by not
// passing `--effort` on its spawned subprocess.

/**
 * Send a user prompt into a session.
 *
 * `cwd` is REQUIRED on the first sendPrompt for a session that doesn't yet
 * have JSONL on disk (= iOS-creating a new session). Daemon checks via
 * SDK's `getSessionInfo(sessionId)`; missing-cwd-for-new-session → daemon
 * replies with `{ type: "error", code: "invalid_message" }`. For resume
 * (session already exists), `cwd` is ignored — SDK uses the persisted cwd.
 *
 * `images` carries base64-encoded image attachments — daemon wraps these
 * into SDK content blocks (`{type:'image', source:{type:'base64', ...}}`)
 * and prepends them to the text block. Empty `text` is allowed when only
 * images are sent. The chunking layer (chunking.ts) splits large image
 * payloads across DataChannel frames; protocol consumers don't see chunks.
 *
 * `model` carries the input-bar picker's current selection, forwarded
 * to the SDK `query()` options on every send (NOT pinned per session —
 * user can switch mid-conversation via `setSessionSelection`). Omitted
 * = use the SDK's default.
 */
export const sendPromptCommand = z.object({
  type: z.literal("sendPrompt"),
  requestId: z.string(),
  sessionId: z.string(),
  text: z.string(),
  cwd: z.string().optional(),
  images: z.array(imageAttachment).optional(),
  model: z.string().optional(),
  /** Client-supplied uuid for the user_message this prompt creates. When
   *  present, the daemon uses it as BOTH the synthesized `user_message`
   *  append uuid AND the SDKUserMessage uuid (so the JSONL persists the
   *  same id). This lets the client optimistically insert the bubble under
   *  this uuid before sending, then dedupe against the daemon's synthesized
   *  append by key — no flicker, no double bubble. Omitted on the
   *  new-session first send (no optimistic insert there — the bubble rides
   *  in on the synthesized append's buffer replay), where the daemon falls
   *  back to a fresh uuid. */
  userMessageUuid: z.string().optional(),
  /** Create-bridged: when the FIRST send of a NEW session sets this, the
   *  daemon attaches a CCR bridge BEFORE running the first turn — so the whole
   *  session mirrors live to claude.ai from turn 1 (no backfill, no seam).
   *  Ignored for an existing session (use `bridgeSession` to upgrade one). */
  bridged: z.boolean().optional(),
});

export const sendPromptResponse = z.object({
  type: z.literal("sendPrompt.response"),
  requestId: z.string(),
});

/**
 * Pick-time commit of the input-bar model selection.
 *
 * Fired by iOS the moment the user picks a different model (not
 * bundled with sendPrompt). Daemon applies via a single
 * `applyFlagSettings({ model })` on the live SDK query first, then
 * writes the new model into sidecode metadata if that call succeeds.
 *
 * Omitted model is a no-op (defensive — iOS shouldn't fire this).
 *
 * Errors: daemon replies with `error` (code `internal`) when the
 * control plane apply throws — e.g., model not allowed by the user's
 * account, transient subprocess issue. iOS uses this signal to roll
 * back the optimistic picker update.
 */
export const setSessionSelectionCommand = z.object({
  type: z.literal("setSessionSelection"),
  requestId: z.string(),
  sessionId: z.string(),
  model: z.string().optional(),
});

export const setSessionSelectionResponse = z.object({
  type: z.literal("setSessionSelection.response"),
  requestId: z.string(),
});

/** User pressed "stop" on the live turn. Targets `runtime.query.interrupt()`
 *  — turn ends, session/subprocess stays alive for follow-up prompts. */
export const interruptCommand = z.object({
  type: z.literal("interrupt"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const interruptResponse = z.object({
  type: z.literal("interrupt.response"),
  requestId: z.string(),
});

/**
 * CCR upgrade — bridge an EXISTING pure session so it's visible + drivable
 * from claude.ai. Daemon does a fresh attach + history backfill (M3.3).
 *
 * V0 gate (option A): the daemon REJECTS this with `error{code:"unsupported"}`
 * if the session is currently `running` — upgrade only at a turn boundary
 * (idle). iOS should also disable the toggle while running; the reject is the
 * defensive backstop. Other failures (attach failed / CCR gate / token) reply
 * `error{code:"internal"}`. iOS rolls back its optimistic bridged flag on error.
 */
export const bridgeSessionCommand = z.object({
  type: z.literal("bridgeSession"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const bridgeSessionResponse = z.object({
  type: z.literal("bridgeSession.response"),
  requestId: z.string(),
});

/**
 * CCR downgrade ("make private") — drop a bridged session's cloud mirror. The
 * daemon detaches locally (the session continues as a pure WebRTC session) and
 * best-effort hard-deletes the cse_ on claude.ai. Idempotent: a session that
 * isn't bridged is a no-op success.
 */
export const unbridgeSessionCommand = z.object({
  type: z.literal("unbridgeSession"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const unbridgeSessionResponse = z.object({
  type: z.literal("unbridgeSession.response"),
  requestId: z.string(),
});

/**
 * Server-initiated streaming event — one per `runtime.addEvent`. Fanned out
 * to every subscriber on the corresponding session. `cursor` is the
 * runtime's monotonic counter for this event; clients may ignore it in V0.
 */
export const eventFrame = z.object({
  type: z.literal("event"),
  sessionId: z.string(),
  cursor: z.number(),
  delta: eventDelta,
});

export const approveCommand = z.object({
  type: z.literal("approve"),
  requestId: z.string(),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
});

export const stopTaskCommand = z.object({
  type: z.literal("stopTask"),
  sessionId: z.string(),
});

// ─── Request/response commands (correlated by requestId) ───────────────────

export const deleteSessionCommand = z.object({
  type: z.literal("deleteSession"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const deleteSessionResponse = z.object({
  type: z.literal("deleteSession.response"),
  requestId: z.string(),
});

// ─── Git status: snapshot (get) + live subscription (workspace info bar) ──
//
// Split into two RPCs so the client maps onto the canonical react-query
// realtime shape: `getGitStatus` is the one-shot snapshot (queryFn —
// cached + deduped daemon-side, symmetric with `getWorkingTreeDiff`), and
// `subscribeGitStatus` is a PURE change stream (no initial in its response)
// that pushes `gitStatus` events as the per-cwd watcher detects changes
// (client folds each into the query cache). Closing the DataChannel
// implicitly unsubscribes; an explicit `unsubscribeGitStatus` releases the
// watcher ref-count early so the daemon can dispose its fs.watch handles.

export const gitStatus = z.object({
  /** False when `cwd` isn't a git repository. Numeric fields are zero,
   *  `branch` is null, `project` is still filled with basename(cwd). */
  isRepo: z.boolean(),
  /** `path.basename(cwd)`. Daemon's heuristic — what the user sees in
   *  Finder, no `package.json` peek, works for any language. */
  project: z.string(),
  /** Null when not a repo OR in detached-HEAD state. */
  branch: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  isDirty: z.boolean(),
});
export type GitStatus = z.infer<typeof gitStatus>;

/** One-shot snapshot for `cwd`. Reuses the per-cwd watcher's cached
 *  `refresh()` (15s TTL + in-flight dedup), so firing this concurrently
 *  with `subscribeGitStatus` costs at most one git invocation. */
export const getGitStatusCommand = z.object({
  type: z.literal("getGitStatus"),
  requestId: z.string(),
  cwd: z.string(),
});

export const getGitStatusResponse = z.object({
  type: z.literal("getGitStatus.response"),
  requestId: z.string(),
  cwd: z.string(),
  status: gitStatus,
});

export const subscribeGitStatusCommand = z.object({
  type: z.literal("subscribeGitStatus"),
  requestId: z.string(),
  cwd: z.string(),
});

/** Pure change-stream ack — NO initial snapshot (use `getGitStatus`).
 *  The watcher's listener fires only on subsequent changes, delivered as
 *  `gitStatus` events. */
export const subscribeGitStatusResponse = z.object({
  type: z.literal("subscribeGitStatus.response"),
  requestId: z.string(),
  cwd: z.string(),
});

export const unsubscribeGitStatusCommand = z.object({
  type: z.literal("unsubscribeGitStatus"),
  requestId: z.string(),
  cwd: z.string(),
});

export const unsubscribeGitStatusResponse = z.object({
  type: z.literal("unsubscribeGitStatus.response"),
  requestId: z.string(),
});

/** Server-initiated push. `cwd` is the routing key — iOS may subscribe
 *  to multiple cwds (e.g. listing pages) and route by this field. */
export const gitStatusEvent = z.object({
  type: z.literal("gitStatus"),
  cwd: z.string(),
  status: gitStatus,
});

// ─── Working-tree diff (one-shot RPC; opened from the status bar) ──────────
//
// Returns the raw unified diff matching the `+N -M` the status bar shows:
// `git diff <ref>` against the SAME comparison ref the watcher uses (upstream
// tracking ref, else HEAD) for tracked changes, PLUS synthesized all-add
// patches for untracked non-binary files (`git diff` never sees untracked, but
// the count includes them). `diff` is "" when the tree is clean.

export const getWorkingTreeDiffCommand = z.object({
  type: z.literal("getWorkingTreeDiff"),
  requestId: z.string(),
  cwd: z.string(),
});

export const getWorkingTreeDiffResponse = z.object({
  type: z.literal("getWorkingTreeDiff.response"),
  requestId: z.string(),
  cwd: z.string(),
  /** False when `cwd` isn't a git repository (`diff` is then ""). */
  isRepo: z.boolean(),
  /** Raw multi-file unified diff (tracked vs comparison ref + untracked
   *  all-add patches). "" when there are no changes. */
  diff: z.string(),
  /** Number of files present in `diff` (tracked changed + untracked
   *  included). Matches what renders — excludes untracked files dropped by
   *  the caps. 0 when clean / non-repo. */
  fileCount: z.number().int().nonnegative(),
  /** True when untracked synthesis hit its caps (>500 files, or a file
   *  >256 KiB skipped) — the diff is "useful" not "exhaustive". */
  truncated: z.boolean(),
});

// ─── Filesystem browser (cwd picker + V0.5+ file picker) ───────────────────
//
// One workhorse RPC + one bootstrap RPC. The workhorse `listDirectory`
// reads a single directory level (Finder-style hierarchical browser);
// the bootstrap `getFilesystemRoots` returns the home/desktop/documents
// paths iOS needs as starting points + a recents list aggregated from
// session history (since iOS doesn't know the daemon machine's HOME).
//
// File-picker readiness: `includeFiles` defaults to false for V0's
// folder-only picker; flipping it surfaces files too. `directoryEntry`
// carries optional size + modifiedAt so a future file picker can show
// metadata without a schema bump. To skip the per-file stat cost in
// the V0 folder-only path, the daemon's handler ONLY stats entries
// when `includeFiles === true`.

export const directoryEntry = z.object({
  /** Last path segment, e.g. "src" or "package.json". */
  name: z.string(),
  /** Absolute path. */
  path: z.string(),
  kind: z.enum(["directory", "file"]),
  /** Size in bytes. Populated only when the response includes files
   *  AND the daemon could stat the entry. Absent otherwise. */
  size: z.number().optional(),
  /** ISO 8601 mtime. Populated alongside `size` only. */
  modifiedAt: z.string().optional(),
});
export type DirectoryEntry = z.infer<typeof directoryEntry>;

export const listDirectoryCommand = z.object({
  type: z.literal("listDirectory"),
  requestId: z.string(),
  /** Absolute path, or "~" / "~/..." (server expands to HOME). Anything
   *  else (relative paths, "~user") is treated as-is and likely errors. */
  path: z.string(),
  /** Include files in the response. Default false — V0 folder picker
   *  needs directories only, skipping files lets the daemon skip the
   *  per-entry stat loop entirely. */
  includeFiles: z.boolean().optional(),
  /** Include dotfile / dot-directory entries (.git, .config, etc.).
   *  Default false. */
  includeHidden: z.boolean().optional(),
});

export const listDirectoryResponse = z.object({
  type: z.literal("listDirectory.response"),
  requestId: z.string(),
  /** Echoed canonical absolute path of the listed dir (post-"~"-expansion). */
  path: z.string(),
  /** Parent absolute path for breadcrumb / up-nav. Null when at the
   *  filesystem root ("/"). */
  parent: z.string().nullable(),
  /** Sorted by daemon: directories first, then files; alphabetical
   *  within each group (case-insensitive). iOS can render straight
   *  through without re-sorting. */
  entries: z.array(directoryEntry),
});

/** Recent cwd entry — union of Desktop session cwds and sidecode session
 *  cwds, filtered to only paths that still exist on disk (stale cwds
 *  from deleted/moved projects are dropped). */
export const recentCwd = z.object({
  path: z.string(),
  /** ISO 8601 timestamp of the most recent session activity at this cwd. */
  lastUsedAt: z.string(),
});

export const getFilesystemRootsCommand = z.object({
  type: z.literal("getFilesystemRoots"),
  requestId: z.string(),
});

export const getFilesystemRootsResponse = z.object({
  type: z.literal("getFilesystemRoots.response"),
  requestId: z.string(),
  /** Daemon machine's HOME directory absolute path (e.g.
   *  "/Users/you"). Always populated — every OS has $HOME. */
  home: z.string(),
  /** `${home}/Desktop` if it exists on disk. Optional because Desktop
   *  is not universal (Linux headless servers / non-standard XDG
   *  locales lack it); macOS always has it. */
  desktop: z.string().optional(),
  /** `${home}/Documents` if it exists on disk. Same optionality
   *  reasoning as `desktop`. */
  documents: z.string().optional(),
  /** Recent project cwds, sorted by lastUsedAt desc, deduped and
   *  filtered to existing paths. Max 10. */
  recentCwds: z.array(recentCwd),
});

// ─── Health + error ────────────────────────────────────────────────────────

export const pingFrame = z.object({
  type: z.literal("ping"),
  t: z.number(),
});

export const pongFrame = z.object({
  type: z.literal("pong"),
  t: z.number(),
  echoT: z.number(),
});

export const errorFrame = z.object({
  type: z.literal("error"),
  requestId: z.string().optional(),
  code: z.enum([
    "invalid_message",
    "unauthenticated",
    "session_not_found",
    "internal",
    "unsupported",
    "rate_limited",
    "incompatible_protocol",
    // Filesystem browser errors (listDirectory / getFilesystemRoots).
    "not_found",
    "permission_denied",
    "not_a_directory",
  ]),
  message: z.string(),
  /** Sender's PROTOCOL_VERSION. Set on `incompatible_protocol` VERSION-
   *  mismatch rejections so the receiver can run `outdatedSide()` and
   *  name the side that needs updating. Deliberately absent on the
   *  other `incompatible_protocol` use (frame-before-hello, a protocol-
   *  misuse rejection where versions may well be EQUAL and direction is
   *  meaningless) and on all other codes. */
  protocolVersion: z.string().optional(),
});

// ─── Hello / server_info (wire-version handshake on DataChannel open) ─────
//
// iOS sends `hello` immediately after DC.open carrying its PROTOCOL_VERSION.
// Daemon checks compatibility via `isProtocolCompatible` and responds with
// its own `server_info` (or with `error{code:"incompatible_protocol",
// protocolVersion}` + DC close on mismatch — the version lets iOS name
// which side is outdated via `outdatedSide`). iOS treats `server_info` as
// the "ready" signal — application commands may only flow after it arrives.
//
// Single field exchanged each way. There's no separate "app release
// version" / "daemon release version" — the protocol package owns the
// only version that matters for whether the two ends can talk.

export const helloCommand = z.object({
  type: z.literal("hello"),
  protocolVersion: z.string(),
});

export const serverInfoEvent = z.object({
  type: z.literal("server_info"),
  protocolVersion: z.string(),
});

export type HelloCommand = z.infer<typeof helloCommand>;
export type ServerInfoEvent = z.infer<typeof serverInfoEvent>;

// ─── Top-level direction unions (parse the wire against these) ─────────────

export const command = z.discriminatedUnion("type", [
  subscribeCommand,
  unsubscribeCommand,
  sendPromptCommand,
  setSessionSelectionCommand,
  interruptCommand,
  approveCommand,
  stopTaskCommand,
  deleteSessionCommand,
  getGitStatusCommand,
  subscribeGitStatusCommand,
  unsubscribeGitStatusCommand,
  getWorkingTreeDiffCommand,
  listDirectoryCommand,
  getFilesystemRootsCommand,
  bridgeSessionCommand,
  unbridgeSessionCommand,
  subscribeSessionsCommand,
]);

export type Command = z.infer<typeof command>;

export const response = z.discriminatedUnion("type", [
  subscribeResponse,
  unsubscribeResponse,
  sendPromptResponse,
  setSessionSelectionResponse,
  interruptResponse,
  deleteSessionResponse,
  getGitStatusResponse,
  subscribeGitStatusResponse,
  unsubscribeGitStatusResponse,
  getWorkingTreeDiffResponse,
  listDirectoryResponse,
  getFilesystemRootsResponse,
  bridgeSessionResponse,
  unbridgeSessionResponse,
  subscribeSessionsResponse,
]);

export type Response = z.infer<typeof response>;

/** All frames a client may send to the daemon over the authenticated
 *  DataChannel. Identity binding lives at the DTLS layer via SDP-
 *  fingerprint signing — by the time anything arrives on the channel,
 *  the peer is already cryptographically bound to a known pubkey.
 *  `hello` is the only frame the daemon accepts before the wire-version
 *  handshake completes (see helloCommand). */
export const clientFrame = z.discriminatedUnion("type", [
  helloCommand,
  pingFrame,
  subscribeCommand,
  unsubscribeCommand,
  sendPromptCommand,
  setSessionSelectionCommand,
  interruptCommand,
  approveCommand,
  stopTaskCommand,
  deleteSessionCommand,
  getGitStatusCommand,
  subscribeGitStatusCommand,
  unsubscribeGitStatusCommand,
  getWorkingTreeDiffCommand,
  listDirectoryCommand,
  getFilesystemRootsCommand,
  bridgeSessionCommand,
  unbridgeSessionCommand,
  subscribeSessionsCommand,
]);

export type ClientFrame = z.infer<typeof clientFrame>;

/** All frames the daemon may send to a client over the authenticated
 *  DataChannel. `server_info` is daemon's reply to `hello` and the
 *  signal that the client may begin sending application commands. */
export const daemonFrame = z.discriminatedUnion("type", [
  serverInfoEvent,
  pongFrame,
  errorFrame,
  sessionUpdatedEvent,
  approvalRequestEvent,
  sessionDivergedEvent,
  sessionForkedEvent,
  subscribeResponse,
  unsubscribeResponse,
  sendPromptResponse,
  setSessionSelectionResponse,
  interruptResponse,
  bridgeSessionResponse,
  unbridgeSessionResponse,
  eventFrame,
  deleteSessionResponse,
  getGitStatusResponse,
  subscribeGitStatusResponse,
  unsubscribeGitStatusResponse,
  gitStatusEvent,
  getWorkingTreeDiffResponse,
  listDirectoryResponse,
  getFilesystemRootsResponse,
  subscribeSessionsResponse,
  sessionStateChangedEvent,
  sessionStateRemovedEvent,
]);

export type DaemonFrame = z.infer<typeof daemonFrame>;
