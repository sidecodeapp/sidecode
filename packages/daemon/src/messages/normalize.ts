import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AssistantStopReason,
  ImageAttachment,
  TimelineItem,
  ToolCallItem,
  TurnUsage,
} from "@thinkite/protocol";
import { assistantStopReason } from "@thinkite/protocol";
import {
  assistantContentBlock,
  attachOutputToDetail,
  buildDetailFromInput,
  extractText,
  summaryFor,
  userContentBlock,
} from "./tool-detail.ts";

/**
 * Convert SDK `SessionMessage[]` (raw Anthropic message envelopes) into a
 * flat `TimelineItem[]` for iOS. This is sidecode's batch normalization
 * layer used on cold-start: assistant text becomes its own item,
 * tool_use+tool_result are paired into a single ToolCallItem with
 * status/error, and per-tool detail variants carry the bits iOS needs to
 * render a typed UI (vs raw JSON).
 *
 * For incremental streaming during a live turn, see runtime/run-query.ts —
 * it emits `EventDelta`s into a SessionRuntime instead of building a full
 * array. The two paths share `tool-detail.ts` so detail formatting stays
 * consistent.
 *
 * Reality check: `getSessionMessages()` strips the JSONL sidecar
 * `toolUseResult` field (verified empirically), so we only have:
 *   - tool_use input (typed, useful)
 *   - tool_result.content as text (the model's view; no exit codes,
 *     no structured patches, no numFiles)
 *
 * For Edit/Write we therefore compute unified diffs via jsdiff from the
 * input strings — Edit diffs the snippet old→new, Write diffs empty→content
 * (so every Write renders as a green all-add new-file diff).
 */

/**
 * Synthetic user-role markers Claude Code writes into the JSONL that must
 * NOT render as user prose. A whole `user` message whose text is exactly
 * one of these is dropped on cold-read so the transcript matches the live
 * stream (which never emits them — the daemon doesn't synthesize them).
 *
 * V0 scope: ONLY the interrupt markers. These are the only ones a
 * sidecode-driven session actually produces (we bypass permissions, so the
 * CANCEL/REJECT members of the CLI's `SYNTHETIC_MESSAGES` never fire). The
 * broader synthetic-content family — `<command-name>` / `<local-command-*>`
 * slash echoes, `<bash-*>` blocks, `<system-reminder>` (often inline, needs
 * stripping not dropping) — is tracked in thinkite/thinkite#12.
 *
 * Mirrors the CLI's INTERRUPT_MESSAGE / INTERRUPT_MESSAGE_FOR_TOOL_USE
 * constants (utils/messages.ts). Exact-text match: the interrupt markers
 * are written as a single text block with no other content.
 */
const DROPPED_SYNTHETIC_USER_TEXTS = new Set<string>([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

export function normalize(messages: readonly SessionMessage[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  const pendingByCallId = new Map<string, ToolCallItem>();

  for (const sdkMsg of messages) {
    // System messages are dropped — SDK's getSessionMessages by default
    // doesn't return them (we don't pass includeSystemMessages anyway),
    // and even when forced through, the AH mapper strips `subtype` /
    // `compactMetadata` so we can't differentiate compact_boundary
    // from stop_hook_summary. Resume therefore has no compact_divider
    // for V0; live path produces dividers via run-query.ts handling
    // SDKCompactBoundaryMessage directly. See thinkite/thinkite#13.
    if (sdkMsg.type === "system") continue;
    const env = sdkMsg.message;
    if (typeof env !== "object" || env === null) continue;
    const content = (env as { content?: unknown }).content;

    if (sdkMsg.type === "user") {
      // user.content is `string | ContentBlock[]`. Plain string → single user_message.
      if (typeof content === "string") {
        if (content.length > 0 && !DROPPED_SYNTHETIC_USER_TEXTS.has(content)) {
          out.push({ type: "user_message", uuid: sdkMsg.uuid, text: content });
        }
        continue;
      }
      if (!Array.isArray(content)) continue;
      // ContentBlock[] form. Two distinct shapes flow through this branch:
      //   (a) tool_result envelopes (Claude's tool feedback) — one per
      //       paired tool_use, never mixed with user-typed content
      //   (b) user-typed messages — text + optional images, possibly multiple
      //       text blocks though usually just one
      // We collect (b) into ONE user_message item per SDK envelope (text
      // joined, images concatenated) and dispatch (a) directly into the
      // pendingByCallId map. Sample probe confirmed messages don't mix the
      // two shapes, so a single pass with two accumulators is sufficient.
      const texts: string[] = [];
      const images: ImageAttachment[] = [];
      for (const block of content) {
        const parsedBlock = userContentBlock.safeParse(block);
        if (!parsedBlock.success) continue;
        const b = parsedBlock.data;
        if (b.type === "text") {
          if (b.text.length > 0) texts.push(b.text);
        } else if (b.type === "image") {
          // V0 only carries inline base64 images (mobile uploads always
          // come as base64; URL form is for Anthropic API users who
          // host their own image bucket). Skip URL form silently.
          if (b.source.type !== "base64") continue;
          // Protocol's imageAttachment.mediaType enum only accepts
          // jpeg/png. Resume of a Desktop session with paste-image that
          // landed as gif/webp/heic would otherwise crash zod parse —
          // safer to drop the image than tank the whole getMessages.
          if (
            b.source.media_type !== "image/jpeg" &&
            b.source.media_type !== "image/png"
          ) {
            continue;
          }
          images.push({
            data: b.source.data,
            mediaType: b.source.media_type,
          });
        } else {
          // tool_result
          const target = pendingByCallId.get(b.tool_use_id);
          if (target === undefined) continue; // orphan result, skip
          const outputText = extractText(b.content);
          target.status = b.is_error ? "failed" : "completed";
          // Anthropic tool_result.content is `string | ContentBlock[]`; the
          // array form (e.g. `[{type:"text", text:"..."}]`) shows up for some
          // tools. Always store extracted text so iOS doesn't re-implement
          // ContentBlock parsing just to display an error string.
          target.error = b.is_error ? outputText : null;
          attachOutputToDetail(target.detail, outputText);
        }
      }
      // Multiple text blocks in one envelope are rare but happen with
      // CLI-synth messages. Join with paragraph spacing to stay visually
      // distinct in markdown rendering.
      const joinedText = texts.join("\n\n");
      // Drop a pure interrupt marker (single text block, no images). Keep
      // anything carrying images — markers never do, so this is defensive.
      if (images.length === 0 && DROPPED_SYNTHETIC_USER_TEXTS.has(joinedText)) {
        continue;
      }
      if (texts.length > 0 || images.length > 0) {
        out.push({
          type: "user_message",
          uuid: sdkMsg.uuid,
          text: joinedText,
          images: images.length > 0 ? images : undefined,
        });
      }
      continue;
    }

    // sdkMsg.type === "assistant"
    if (!Array.isArray(content)) continue;
    // Pull stop_reason once per envelope — settled JSONL always has it
    // (the model wrote it before disk-flush) except for the interrupted
    // case where SDK leaves it null. We pass the same value into every
    // assistant_message item from this envelope; UI typically only
    // checks the last one before a tool_call / next user message.
    const rawStopReason = (env as { stop_reason?: unknown }).stop_reason;
    const parsedStopReason = assistantStopReason.safeParse(rawStopReason);
    const stopReason: AssistantStopReason | undefined = parsedStopReason.success
      ? parsedStopReason.data
      : undefined;
    for (const block of content) {
      const parsedBlock = assistantContentBlock.safeParse(block);
      if (!parsedBlock.success) continue; // includes "thinking" etc — ignored
      const b = parsedBlock.data;
      if (b.type === "text") {
        if (b.text.length > 0) {
          out.push({
            type: "assistant_message",
            uuid: sdkMsg.uuid,
            text: b.text,
            stopReason,
          });
        }
      } else {
        // tool_use
        const detail = buildDetailFromInput(b.name, b.input);
        const item: ToolCallItem = {
          type: "tool_call",
          callId: b.id,
          name: b.name,
          summary: summaryFor(detail, b.name),
          // Default to completed; later tool_result may flip to failed.
          // Tools without a matching tool_result stay "completed" — V0 reads
          // settled JSONL so missing-result is rare and the tool likely just
          // ran with no payload (e.g. silent success).
          status: "completed",
          error: null,
          detail,
        };
        out.push(item);
        pendingByCallId.set(b.id, item);
      }
    }
  }

  return out;
}

/**
 * Pull a usage seed for the iOS context-window meter out of the JSONL
 * replay returned by `getSessionMessages`. Scans newest-first for the
 * last assistant message whose raw envelope carries a `usage` field,
 * extracts the four token counts using the same snake_case → camelCase
 * mapping as `run-query.ts`'s live extractor. Returns `undefined` when:
 *   - The session has no assistant messages (empty/user-only JSONL)
 *   - The most recent assistant turn was tool-only (no API usage stamp)
 *   - The .message envelope is missing or shaped unexpectedly
 *
 * `SessionMessage.message` is typed as `unknown` by the SDK, but in
 * practice carries the raw Anthropic API response (Claude Code writes
 * the full response shape into JSONL). Defensive casting + optional
 * field access keeps us safe if the SDK's serialization changes.
 *
 * Lives here (rather than in daemon/index.ts) so both daemon-level
 * code paths can share it: (1) `RouterDeps.getMessages` for the
 * subscribe lazy-init fallback; (2) `run-query.ts` for the
 * turn-boundary in-memory refresh.
 */
export function extractLatestUsage(
  messages: readonly SessionMessage[],
): TurnUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.type !== "assistant") continue;
    const raw = m.message as { usage?: Record<string, unknown> } | undefined;
    const u = raw?.usage;
    if (u === undefined) continue;
    return {
      inputTokens: numberOrUndef(u.input_tokens),
      outputTokens: numberOrUndef(u.output_tokens),
      cacheReadInputTokens: numberOrUndef(u.cache_read_input_tokens),
      cacheCreationInputTokens: numberOrUndef(u.cache_creation_input_tokens),
    };
  }
  return undefined;
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
