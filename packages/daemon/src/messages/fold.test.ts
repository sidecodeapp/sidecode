import type { EventDelta, TimelineItem } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { foldEventDelta } from "./fold.ts";

// Structural fixtures — the fold operates on shape, so casts keep these
// terse without pulling in detail builders. (Detail content is opaque to
// the fold; it only copies it on patch_tool_call.)
const assistantMsg = (uuid: string, text: string): TimelineItem =>
  ({ type: "assistant_message", uuid, text }) as unknown as TimelineItem;
const userMsg = (uuid: string, text: string): TimelineItem =>
  ({ type: "user_message", uuid, text }) as unknown as TimelineItem;
const toolCall = (
  callId: string,
  status: "completed" | "failed",
): TimelineItem =>
  ({
    type: "tool_call",
    callId,
    name: "Bash",
    summary: "ran",
    status,
    error: null,
    detail: { type: "bash" },
  }) as unknown as TimelineItem;

const appendDelta = (item: TimelineItem): EventDelta =>
  ({ kind: "append", item }) as EventDelta;

describe("foldEventDelta", () => {
  it("append pushes the item to the end", () => {
    const settled: TimelineItem[] = [userMsg("u1", "hi")];
    foldEventDelta(settled, appendDelta(assistantMsg("a1", "")));
    expect(settled).toHaveLength(2);
    expect(settled[1]).toMatchObject({ type: "assistant_message", uuid: "a1" });
  });

  it("patch_text accumulates onto the matching assistant_message by uuid", () => {
    const settled: TimelineItem[] = [assistantMsg("a1", "Hel")];
    foldEventDelta(settled, {
      kind: "patch_text",
      uuid: "a1",
      deltaText: "lo",
    } as EventDelta);
    foldEventDelta(settled, {
      kind: "patch_text",
      uuid: "a1",
      deltaText: " world",
    } as EventDelta);
    expect(settled[0]).toMatchObject({
      type: "assistant_message",
      text: "Hello world",
    });
  });

  it("patch_text targets the LAST matching assistant_message (streaming)", () => {
    // Two assistant messages share no uuid; patch must hit a1 (earlier),
    // proving the by-uuid match (not just last item).
    const settled: TimelineItem[] = [
      assistantMsg("a1", "first"),
      toolCall("c1", "completed"),
      assistantMsg("a2", "second"),
    ];
    foldEventDelta(settled, {
      kind: "patch_text",
      uuid: "a1",
      deltaText: "!",
    } as EventDelta);
    expect(settled[0]).toMatchObject({ uuid: "a1", text: "first!" });
    expect(settled[2]).toMatchObject({ uuid: "a2", text: "second" });
  });

  it("patch_text on an unknown uuid is a no-op", () => {
    const settled: TimelineItem[] = [assistantMsg("a1", "x")];
    foldEventDelta(settled, {
      kind: "patch_text",
      uuid: "nope",
      deltaText: "y",
    } as EventDelta);
    expect(settled[0]).toMatchObject({ text: "x" });
  });

  it("patch_tool_call updates status/error/detail of the matching tool_call", () => {
    const settled: TimelineItem[] = [toolCall("c1", "completed")];
    foldEventDelta(settled, {
      kind: "patch_tool_call",
      callId: "c1",
      status: "failed",
      error: "boom",
      detail: { type: "bash", output: "boom" },
    } as EventDelta);
    expect(settled[0]).toMatchObject({
      type: "tool_call",
      callId: "c1",
      status: "failed",
      error: "boom",
    });
  });

  it("turn_* and compact_* are no-ops (settled unchanged)", () => {
    const settled: TimelineItem[] = [userMsg("u1", "hi")];
    for (const kind of [
      "turn_started",
      "turn_completed",
      "turn_failed",
      "turn_canceled",
      "compact_started",
      "compact_applied",
    ]) {
      foldEventDelta(settled, { kind } as unknown as EventDelta);
    }
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ uuid: "u1", text: "hi" });
  });

  it("patch_text replaces the item (doesn't mutate the original ref — warm-replay safe)", () => {
    const original = assistantMsg("a1", "Hel");
    const settled: TimelineItem[] = [original];
    foldEventDelta(settled, {
      kind: "patch_text",
      uuid: "a1",
      deltaText: "lo",
    } as EventDelta);
    // settled[0] is a new object; the original (shared with the buffer's
    // append event) keeps its pre-patch text.
    expect(settled[0]).not.toBe(original);
    expect((original as unknown as { text: string }).text).toBe("Hel");
  });
});
