#!/usr/bin/env node --experimental-strip-types
/**
 * Throwaway probe: how does `query.applyFlagSettings` react to
 * effortLevel values that aren't in the Settings.effortLevel type
 * (sdk.d.ts:5179 only allows 'low' | 'medium' | 'high' | 'xhigh')?
 *
 * Two cases we care about:
 *   1. effortLevel: 'max' — known to NOT be in the type (max is in
 *      the broader EffortLevel enum at sdk.d.ts:522 but Settings's
 *      narrower variant excludes it). Daemon currently skips this
 *      explicitly. Does the SDK ALSO defend against it, or would it
 *      silently accept and ignore?
 *   2. effortLevel: 'test' — totally invalid string. Does the SDK
 *      validate this at the apply call, or fail later, or silently
 *      ignore?
 *
 * For each: catch + log. The TS `as never` casts bypass the SDK's
 * type narrowing so we can actually send the bad values on the wire.
 *
 * Run: pnpm --filter @thinkite/daemon exec tsx scripts/probe-apply-flag-failures.ts
 */

import {
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

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
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  };
}

async function probe(label: string, fn: () => Promise<unknown>): Promise<void> {
  process.stdout.write(`\n[${label}] calling... `);
  try {
    const r = await fn();
    process.stdout.write(`OK  return = ${JSON.stringify(r)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`THREW: ${msg}\n`);
  }
}

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

  // Background-drain SDK messages so the transport stays alive while
  // we run probes. Flip `primed` after the first result so we know
  // the subprocess is ready for control requests.
  let primed = false;
  let drainerDone = false;
  const drainer = (async () => {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "result") {
        primed = true;
      }
    }
    drainerDone = true;
  })().catch((err) => {
    console.error("[probe] drainer error:", err);
    drainerDone = true;
  });

  // Send a no-op prompt to make the subprocess actually run something
  // (control plane is only ready after the SDK has handshaken).
  channel.push(userMessage("Say 'ok'."));

  // Wait for the first result, with a 30s cap.
  const deadline = Date.now() + 30_000;
  while (!primed && !drainerDone && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!primed) {
    console.error("\n[probe] timed out waiting for initial result");
    channel.end();
    return;
  }
  console.log("\n[probe] initial turn settled; starting probes");

  // Probe 1: opus-4-7 + max — Settings.effortLevel type says no max.
  await probe("max effort + valid model", () =>
    q.applyFlagSettings({
      model: "claude-opus-4-7",
      effortLevel: "max" as never,
    }),
  );

  // Probe 2: completely invalid string.
  await probe("invalid effort 'test'", () =>
    q.applyFlagSettings({
      effortLevel: "test" as never,
    }),
  );

  // Probe 3: known-good (sanity).
  await probe("valid effort 'low'", () =>
    q.applyFlagSettings({ effortLevel: "low" }),
  );

  // Probe 4: invalid model id via applyFlagSettings.
  await probe("applyFlagSettings invalid model", () =>
    q.applyFlagSettings({ model: "claude-nonexistent-9-9" }),
  );

  // Probe 5: invalid model id via dedicated setModel setter.
  // Per upstream docs setModel behaves "identically" to applyFlagSettings
  // for the model key — but does it ALSO accept garbage silently?
  await probe("setModel invalid model", () =>
    q.setModel("claude-nonexistent-9-9"),
  );

  // Probe 6: setModel with empty string (also outside the official enum).
  await probe("setModel empty string", () => q.setModel(""));

  // Probe 7: setModel undefined (this IS in the official type — should
  // reset to default). Sanity check.
  await probe("setModel undefined", () => q.setModel(undefined));

  // Probe 8: After all those, try to run an actual turn. If the last
  // apply (setModel undefined) reset to default, this should work and
  // modelUsage will tell us which model actually ran.
  console.log(
    "\n[probe] running follow-up turn to see what runs after all the bad applies",
  );
  let endResult: SDKMessage | undefined;
  const probeTurn = (async () => {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "result") {
        endResult = msg;
        return;
      }
    }
  })();
  channel.push(userMessage("Reply just 'ok'."));
  await Promise.race([probeTurn, new Promise((r) => setTimeout(r, 60_000))]);
  if (endResult) {
    const r = endResult as unknown as {
      subtype?: string;
      modelUsage?: Record<string, unknown>;
      errors?: string[];
      is_error?: boolean;
    };
    console.log(`[probe] turn subtype: ${r.subtype}`);
    console.log(`[probe] is_error: ${r.is_error}`);
    if (r.errors) console.log(`[probe] errors: ${JSON.stringify(r.errors)}`);
    console.log(`[probe] modelUsage: ${JSON.stringify(r.modelUsage)}`);
  } else {
    console.log("[probe] turn never settled");
  }

  channel.end();
  await q.return().catch(() => {});
  await drainer;
}

main().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
