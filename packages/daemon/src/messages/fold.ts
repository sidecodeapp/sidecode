import type { EventDelta, TimelineItem } from "@thinkite/protocol";

/**
 * Fold one EventDelta into the in-memory `settled` TimelineItem[] (mutating
 * in place, returning the same reference). This is the daemon-side mirror
 * of the iOS transcript reducer (transcript-collection-factory `onEvent`):
 * both apply the SAME deltas the SAME way, so the daemon's cold-path
 * snapshot (`settled`) is exactly what iOS shows live — which lets the
 * turn-boundary refresh stay purely in-memory (no JSONL re-read, no
 * dependency on the SDK's async flush timing, no live/settled divergence).
 *
 * Compact (`compact_started` / `compact_applied`) is a deliberate no-op:
 * the iOS reducer no-ops it too in V0 (divider + prune deferred to V0.5+,
 * see thinkite/thinkite#13). Mirroring that keeps settled == live. A
 * re-read of the compacted JSONL would instead PRUNE settled and diverge
 * from iOS's unpruned live state. When V0.5+ teaches the iOS reducer to
 * prune on `compact_applied` (filter to preservedUuids + append divider),
 * teach this the same prune — still in-memory, still no re-read.
 *
 * Mirrors normalize.ts's output for non-compact turns: the deltas are
 * emitted by run-query using the same tool-detail.ts formatting normalize
 * uses, so a folded item is byte-identical to the normalized one (an
 * append'd tool_call patched to completed == normalize's paired
 * ToolCallItem; append'd-empty assistant_message + patch_text deltas ==
 * normalize's full assistant text).
 */
export function foldEventDelta(
  settled: TimelineItem[],
  delta: EventDelta,
): TimelineItem[] {
  switch (delta.kind) {
    case "append":
      settled.push(delta.item);
      return settled;
    case "patch_text": {
      // Streaming patches target the most recent assistant_message — scan
      // from the end so the common case is O(1).
      for (let i = settled.length - 1; i >= 0; i -= 1) {
        const it = settled[i];
        if (
          it !== undefined &&
          it.type === "assistant_message" &&
          it.uuid === delta.uuid
        ) {
          // Replace (don't mutate) so the buffer's original append item —
          // shared by reference, replayed verbatim on warm reconnect —
          // stays untouched while settled accumulates the full text.
          settled[i] = { ...it, text: it.text + delta.deltaText };
          return settled;
        }
      }
      return settled;
    }
    case "patch_tool_call": {
      for (let i = settled.length - 1; i >= 0; i -= 1) {
        const it = settled[i];
        if (
          it !== undefined &&
          it.type === "tool_call" &&
          it.callId === delta.callId
        ) {
          settled[i] = {
            ...it,
            status: delta.status,
            error: delta.error,
            detail: delta.detail,
          };
          return settled;
        }
      }
      return settled;
    }
    default:
      // turn_started / turn_completed / turn_failed / turn_canceled /
      // compact_started / compact_applied — not transcript items, no effect.
      return settled;
  }
}
