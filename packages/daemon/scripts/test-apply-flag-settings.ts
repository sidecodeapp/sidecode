#!/usr/bin/env node --experimental-strip-types
/**
 * Throwaway experiment: verify `query.applyFlagSettings` actually
 * swaps the SDK's active model + effort mid-session, without
 * restarting the claude subprocess.
 *
 * Flow:
 *   1. Spawn streaming-input query with options.model = Opus 4.7,
 *      options.effort = "high".
 *   2. Turn 1 — ask "what model are you?". Capture assistant text +
 *      the result envelope's `model` / `modelUsage`.
 *   3. Call applyFlagSettings({ model: <haiku>, effortLevel: "low" }).
 *   4. Turn 2 — same question. Capture again.
 *   5. Print before/after side by side so we can eyeball:
 *      - Did the SDK report a different `model` on turn 2's result?
 *      - Did modelUsage account for the new model?
 *      - Did the assistant's self-id change? (Probably the most fragile
 *        signal — models hallucinate their own identity.)
 *
 * Note on effort: per the user, the model itself doesn't know its
 * effortLevel, so we can't ask it. Verifying effort would need
 * indirect signals (response latency, modelUsage thinking tokens) —
 * not done here.
 *
 * Run from repo root:
 *   pnpm --filter @thinkite/daemon exec tsx scripts/test-apply-flag-settings.ts
 */

import {
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// ─── Inline tiny async push channel (subset of src/runtime/async-message-input) ──
function makeChannel<T>(): {
  push: (msg: T) => void;
  end: () => void;
  iterable: AsyncIterable<T>;
} {
  const queue: T[] = [];
  const waiters: Array<(r: IteratorResult<T, void>) => void> = [];
  let closed = false;
  return {
    push(msg) {
      if (closed) return;
      const w = waiters.shift();
      if (w) w({ value: msg, done: false });
      else queue.push(msg);
    },
    end() {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T, void>> {
            if (queue.length > 0) {
              return Promise.resolve({
                value: queue.shift() as T,
                done: false,
              });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    // SDK type accepts string or block array; string is enough.
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  };
}

const PROMPT =
  "Which Claude model are you? Reply with the model ID (e.g. claude-opus-4-7 or claude-haiku-4-5) and nothing else.";

async function main() {
  const channel = makeChannel<SDKUserMessage>();
  const q = query({
    prompt: channel.iterable,
    options: {
      model: "claude-opus-4-7",
      effort: "high",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  type Capture = {
    label: string;
    assistantText: string;
    resultModel?: string;
    modelUsage?: Record<string, unknown>;
  };
  const captures: Capture[] = [
    { label: "BEFORE applyFlagSettings", assistantText: "" },
    {
      label: "AFTER applyFlagSettings (haiku + low effort)",
      assistantText: "",
    },
  ];
  let phase = 0;

  // Kick off turn 1.
  channel.push(userMessage(PROMPT));

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant") {
      const blocks = (msg as { message: { content: Array<unknown> } }).message
        .content;
      for (const block of blocks) {
        const b = block as { type: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") {
          captures[phase].assistantText += b.text;
        }
      }
    } else if (msg.type === "result") {
      const r = msg as unknown as {
        model?: string;
        modelUsage?: Record<string, unknown>;
      };
      captures[phase].resultModel = r.model;
      captures[phase].modelUsage = r.modelUsage;

      if (phase === 0) {
        console.log("\n=== Turn 1 done. Now switching... ===");
        await q.applyFlagSettings({
          model: "claude-haiku-4-5-20251001",
          effortLevel: "low",
        });
        console.log(
          "→ applyFlagSettings({ model: 'claude-haiku-4-5-20251001', effortLevel: 'low' }) — returned",
        );
        phase = 1;
        channel.push(userMessage(PROMPT));
      } else {
        // Turn 2 done — finish up.
        channel.end();
        await q.return().catch(() => {});
        break;
      }
    }
  }

  console.log("\n────────────────────────────────────────────────────────");
  for (const c of captures) {
    console.log(`\n## ${c.label}`);
    console.log(`Assistant self-id: ${c.assistantText.trim() || "<empty>"}`);
    console.log(`result.model: ${c.resultModel ?? "<missing>"}`);
    console.log(
      `result.modelUsage: ${JSON.stringify(c.modelUsage, null, 2) ?? "<missing>"}`,
    );
  }
}

main().catch((err) => {
  console.error("[test-apply-flag-settings] failed:", err);
  process.exit(1);
});
