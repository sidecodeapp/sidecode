import { MODEL_METADATA, type TurnUsage } from "@thinkite/protocol";
import { type ContextUsage, computeContextUsage } from "@/lib/context-usage";

/**
 * Hook wrapper around `computeContextUsage`. Looks up the selected
 * model's `contextWindow` from the bundled `MODEL_METADATA` table and
 * feeds it to the pure helper. Reactively re-runs only when its inputs
 * change (the catalog is a module constant — no subscription).
 *
 * Returns `null` when:
 *   - No model is selected yet (picker hasn't bootstrapped)
 *   - The model isn't in `MODEL_METADATA` (e.g. a brand-new Anthropic
 *     release sidecode hasn't shipped for — extremely rare since the
 *     bundled table covers both current and deprecated entries)
 *   - No turn has completed yet (latestUsage null on fresh subscribe)
 *
 * See `lib/context-usage.ts` for the formula + design rationale.
 */
export type { ContextUsage };

export function useContextUsage(
  latestUsage: TurnUsage | null | undefined,
  model: string | undefined,
): ContextUsage | null {
  if (!model) return null;
  const contextWindow = MODEL_METADATA[model]?.contextWindow;
  return computeContextUsage(latestUsage, contextWindow);
}
