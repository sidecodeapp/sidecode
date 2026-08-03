import type { TurnUsage } from "@thinkite/protocol";

/**
 * Pure derivation for the context-window meter. Lives in `lib/`
 * alongside `timeline-reducer.ts` (same convention: framework-free
 * logic in lib/, React-Query / RN consumers in hooks/). The hook in
 * `hooks/use-context-usage.ts` is a thin wrapper that joins this with
 * the daemon's model catalog.
 *
 * Formula matches Claude Code's `/context` command:
 *   `used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
 *   `output_tokens` is excluded — it's what got appended to the
 *   conversation; only what was sent IN counts against the window.
 *
 * Cache reads count toward "used" because they still occupy context
 * window — they're just billed cheaper than fresh input. Mirrors
 * Claude Code source `analyzeContext.ts`'s `totalFromAPI` calculation.
 *
 * `null` returns: any missing piece (no usage, no model cap, zero
 * used) → meter renders nothing. Distinct from `{ percentage: 0 }`
 * which would render a hairline empty fill.
 */
export type ContextUsage = {
  /** input + cache_creation + cache_read, in tokens. */
  used: number;
  /** Model's `contextWindow` from daemon metadata (200k / 1M / etc.). */
  max: number;
  /** `used / max * 100`, clamped to [0, 100] so a malformed payload
   *  (e.g. usage > max from a backend bug) can't break the fill bar's
   *  `width: ${pct}%` CSS validity. */
  percentage: number;
};

export function computeContextUsage(
  latestUsage: TurnUsage | null | undefined,
  contextWindow: number | undefined,
): ContextUsage | null {
  if (!latestUsage) return null;
  if (!contextWindow || contextWindow <= 0) return null;
  const used =
    (latestUsage.inputTokens ?? 0) +
    (latestUsage.cacheCreationInputTokens ?? 0) +
    (latestUsage.cacheReadInputTokens ?? 0);
  if (used <= 0) return null;
  // Clamp to [0, 100]. Above-cap can theoretically happen if usage
  // arrives reporting a turn that exceeded the cap before SDK auto-
  // compacted; clamping keeps the fill bar's CSS width valid.
  const percentage = Math.min(100, Math.max(0, (used / contextWindow) * 100));
  return { used, max: contextWindow, percentage };
}
