import {
  createCollection,
  eq,
  localOnlyCollectionOptions,
  useLiveQuery,
} from "@tanstack/react-db";
import type { TurnUsage } from "@thinkite/protocol";

/**
 * Per-session "latest turn result" — the transcript-derived bits that
 * are NOT a timeline item and are NOT cheap for the daemon to broadcast
 * for every session:
 *   - `latestUsage` — token usage from the last completed turn → the
 *     context-window meter on the composer's model chip.
 *   - `lastError`   — last turn failure string, for dev logging.
 * Keyed by cliSessionId.
 *
 * Why NOT folded into the #17 `sessionStateCollection`: that collection
 * is a daemon-pushed custom-sync collection (its rows are OWNED by the
 * subscribeSessions sync handler — a client patch would be clobbered on
 * the next daemon push, and a bare mutation on a custom-sync collection
 * isn't even allowed). And these two fields are inherently PER-OPEN-
 * SESSION: `latestUsage` needs the transcript (the daemon doesn't cheaply
 * know every session's usage without reading each JSONL) and only the
 * open composer consumes it — the drawer list shows no meter. So they're
 * sourced lazily from the live transcript subscription
 * (transcript-collection-factory routes `turn_completed.usage` /
 * `turn_failed.error` / cold-path `initialUsage` here) into this localOnly
 * collection.
 *
 * Running-state ("is this session working right now") is deliberately NOT
 * here — that's the daemon-authoritative `sessionState.activity` (#17),
 * which is cheap + daemon-wide. Read `activity === "running"` off the
 * `sessionStateCollection` row instead (this used to carry a redundant
 * client-derived `isRunning`; deleted 2026-06-01).
 *
 * A `localOnly` collection — pure in-memory, no external sync source.
 * Interim limitation: rows are only fresh while the feeding transcript
 * subscription is alive. Leaving a session gc's its transcript (~60s),
 * after which its row is cleared (`clearSessionTurnResult`) rather than
 * left frozen.
 */
export interface SessionTurnResult {
  cliSessionId: string;
  lastError: string | null;
  latestUsage: TurnUsage | null;
}

const DEFAULTS: Omit<SessionTurnResult, "cliSessionId"> = {
  lastError: null,
  latestUsage: null,
};

export const sessionTurnResultCollection = createCollection(
  localOnlyCollectionOptions({
    id: "session-turn-result",
    getKey: (r: SessionTurnResult) => r.cliSessionId,
  }),
);

/**
 * Upsert a session's turn result. `collection.update` throws on a missing
 * key and `insert` throws on an existing one, and localOnly has no upsert
 * util — so branch on presence. Direct (auto-commit) mutations loopback-
 * sync immediately; no handler / acceptMutations needed.
 */
export function patchSessionTurnResult(
  cliSessionId: string,
  patch: Partial<Omit<SessionTurnResult, "cliSessionId">>,
): void {
  if (sessionTurnResultCollection.get(cliSessionId) === undefined) {
    sessionTurnResultCollection.insert({
      cliSessionId,
      ...DEFAULTS,
      ...patch,
    });
  } else {
    sessionTurnResultCollection.update(cliSessionId, (draft) => {
      Object.assign(draft, patch);
    });
  }
}

/** Drop a session's turn-result row (called when its transcript is gc'd). */
export function clearSessionTurnResult(cliSessionId: string): void {
  if (sessionTurnResultCollection.get(cliSessionId) !== undefined) {
    sessionTurnResultCollection.delete(cliSessionId);
  }
}

// Stable reference for the "no row yet" case so consumers don't re-render
// on identity churn. Consumers only read lastError / latestUsage; the
// empty cliSessionId is never observed.
const EMPTY: SessionTurnResult = { cliSessionId: "", ...DEFAULTS };

/**
 * Reactive read of one session's latest turn result. Returns DEFAULTS when
 * no row exists yet (session never completed a turn this session, or its
 * row was cleared) OR when `cliSessionId` is null (the new-session screen
 * has no session — the query is disabled and DEFAULTS stands in).
 */
export function useSessionTurnResult(
  cliSessionId: string | null,
): SessionTurnResult {
  const { data } = useLiveQuery(
    (q) =>
      cliSessionId
        ? q
            .from({ r: sessionTurnResultCollection })
            .where(({ r }) => eq(r.cliSessionId, cliSessionId))
            .findOne()
        : null,
    [cliSessionId],
  );
  return data ?? EMPTY;
}
