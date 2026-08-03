#!/usr/bin/env node --experimental-strip-types
/**
 * Dump the live `ModelInfo[]` the Agent SDK reports for the current user's
 * account. Spawns one throwaway Claude process via `query()`, awaits the
 * init message (which carries the model list), prints it as JSON, and
 * disposes the subprocess.
 *
 * Use this to:
 *   1. Verify which Claude models your OAuth account can actually use
 *      (1P vs 3P, plan tier, custom envvar overrides, etc.)
 *   2. Capture ground truth for `packages/protocol/src/models.ts`
 *      baseline entries — paste the relevant `value`/`displayName`/
 *      `description`/`supportedEffortLevels` into the hardcoded table.
 *
 * Run from repo root:
 *
 *   pnpm --filter @thinkite/daemon exec tsx scripts/dump-models.ts
 *
 * or:
 *
 *   cd packages/daemon && pnpm tsx scripts/dump-models.ts
 *
 * Notes:
 *   - Costs ~one Claude spawn (a few hundred ms). Doesn't actually send a
 *     turn — the prompt is consumed by init only, then we abort.
 *   - Output goes to stdout; redirect to a file with `> models-dump.json`.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  // Minimal valid query setup. The prompt string is a no-op here — we
  // only wait for the init handshake, not for a real assistant reply.
  const q = query({
    prompt: "ping",
    options: {},
  });

  try {
    const init = await q.initializationResult();
    // Pretty-print only the models slice. If you want the whole init
    // payload (commands / agents / account / fast_mode_state), swap to
    // `console.log(JSON.stringify(init, null, 2))`.
    console.log(JSON.stringify(init.models, null, 2));
  } finally {
    // Best-effort cleanup — abort the underlying subprocess so we don't
    // dangle a Claude process after the dump.
    try {
      await q.return();
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error("[dump-models] failed:", err);
  process.exit(1);
});
