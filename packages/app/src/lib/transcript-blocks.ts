import type {
  ImageAttachment,
  TimelineItem,
  ToolCallDetail,
} from "@thinkite/protocol";

/**
 * Annotate `TimelineItem[]` with render hints the FlatList rows need:
 * a stable id and a flattened shape (`{ kind: "text", role, text }` or
 * `{ kind: "tool", ... }`) so the row components dispatch on `kind`
 * without re-discriminating the protocol union.
 *
 * Pairing tool_use+tool_result, flattening ContentBlock[], computing per-tool
 * summaries — all that lives in the daemon (Slice D, see
 * daemon/src/messages/normalize.ts). This module is purely a render-side
 * shape adapter.
 */

export type RenderBlock =
  | TextRenderBlock
  | ToolRenderBlock
  | CompactDividerRenderBlock;

export interface TextRenderBlock {
  kind: "text";
  /** Stable key for FlatList. `<itemUuid>:<itemIndex>`. */
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Raw `ImageAttachment[]` (base64 + mediaType) for user-message
   *  attachments, in the order the user picked them. Assistant messages
   *  never carry images (model output is text + tool_use only), so this
   *  is only populated for `role === "user"`. Render layer is responsible
   *  for materializing these to `file://` URIs via `image-cache.ts` —
   *  Galeria's native iOS viewer can't decode `data:` URIs directly. */
  images?: ImageAttachment[];
}

export interface ToolRenderBlock {
  kind: "tool";
  id: string;
  /** Anthropic tool_use id (preserved from the wire `callId`). */
  callId: string;
  /** Raw SDK tool name (e.g. "Bash", "Edit", "WebFetch"). */
  name: string;
  /** Daemon-computed row object label — basename, command summary, pattern,
   *  etc. Rendered after the past-tense verb from tool-verbs.ts. */
  summary: string;
  status: "completed" | "failed" | "running";
  /** Tool result error text when `status === "failed"`, null otherwise. */
  error: string | null;
  /** Server-computed structured detail; ToolBlock dispatches on `detail.type`. */
  detail: ToolCallDetail;
}

/**
 * Visual divider rendered where the conversation was compacted.
 * Sourced ONLY from the reducer consuming a live `compact_applied`
 * EventDelta — resume can't produce one (SDK's getSessionMessages
 * strips the system-message subtype + compactMetadata needed to
 * identify boundaries on disk; see thinkite/thinkite#13). Renders
 * as a horizontal line + caption ("Context compacted · 215k → 18k").
 * The actual component lands in the next Slice 2 commit; ChatPanel's
 * renderItem currently renders a placeholder.
 */
export interface CompactDividerRenderBlock {
  kind: "compact_divider";
  id: string;
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens: number;
}

export function flattenToBlocks(items: readonly TimelineItem[]): RenderBlock[] {
  return items.map((item, idx): RenderBlock => {
    switch (item.type) {
      case "user_message":
        return {
          kind: "text",
          id: `${item.uuid}:${idx}`,
          role: "user",
          text: item.text,
          images:
            item.images && item.images.length > 0 ? item.images : undefined,
        };
      case "assistant_message":
        return {
          kind: "text",
          id: `${item.uuid}:${idx}`,
          role: "assistant",
          text: item.text,
        };
      case "tool_call":
        return {
          kind: "tool",
          id: `${item.callId}:${idx}`,
          callId: item.callId,
          name: item.name,
          summary: item.summary,
          status: item.status,
          error: item.error,
          detail: item.detail,
        };
      case "compact_divider":
        return {
          kind: "compact_divider",
          id: `${item.uuid}:${idx}`,
          trigger: item.trigger,
          preTokens: item.preTokens,
          postTokens: item.postTokens,
        };
      default: {
        const _exhaustive: never = item;
        throw new Error(
          `unhandled timeline item: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  });
}
