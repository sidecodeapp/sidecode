import {
  type Collection,
  createCollection,
  createOptimisticAction,
} from "@tanstack/react-db";
import type { ImageAttachment, TimelineItem } from "@thinkite/protocol";
import { type DaemonClient, daemonClient } from "@/lib/daemon-client";
import {
  clearSessionTurnResult,
  patchSessionTurnResult,
} from "@/lib/session-turn-result";

/**
 * Augmented item type stored inside the collection. `_order` is an
 * iOS-internal monotonic counter used purely for sorting; NOT part of
 * the wire protocol.
 *
 * Why we need it: TanStack DB stores items in a `SortedMap` internally.
 * Without a `compare` function, it falls back to sorting by KEY — our
 * key is `uuid` (a random string), so chronological order gets shredded
 * into lexical-by-random order. Even though SDK's getSessionMessages
 * returns items in the correct chronological order, the collection
 * scrambles them on insert.
 *
 * Why not `timestamp`: SessionMessage HAS a `timestamp` field but it's
 * not monotonic — verified empirically. Around compact boundaries the
 * SDK-injected summary message uses fresh time while the following
 * `<command-name>/compact</command-name>` echo uses the original
 * (older) command time. Plus same-envelope items (text + tool_use
 * blocks) share a timestamp, requiring a tiebreaker anyway. Using
 * array-index `_order` sidesteps both issues — the SDK array order IS
 * the canonical chronological order (it has already done parent_uuid
 * chain reconstruction), we just preserve it.
 *
 * Structural-typing note: `OrderedTimelineItem` extends `TimelineItem`
 * with one extra field; consumers expecting `TimelineItem[]` (like
 * `flattenToBlocks`) accept it without changes.
 */
export type OrderedTimelineItem = TimelineItem & { _order: number };

/**
 * Per-session latest-turn result (lastError / latestUsage) lives in a
 * separate `localOnly` collection in `@/lib/session-turn-result`. This
 * sync handler is its writer: it routes the subscription's turn_* /
 * initialUsage into it via patchSessionTurnResult, and clears it on
 * cleanup. Consumers read it via `useSessionTurnResult`.
 * (Running-state moved to the daemon-pushed `sessionState.activity` — #17
 * — so no client `isRunning` is written here anymore.)
 *
 * Module-level per-session collection cache. Implements the
 * maintainer-blessed pattern from TanStack/db#652:
 *   - One collection per cliSessionId, keyed in a Map
 *   - Cache eviction wired to `status:change` event so when TanStack
 *     DB's gcTime timer fires `cleanup()`, the entry drops out of
 *     this Map automatically — no manual ref counting
 *
 * The collection's `sync` config opens a single `client.subscribe(...)`
 * call inside its handler. This is THE difference vs the old
 * queryCollectionOptions approach:
 *   - Old: queryFn was vestigial (returned [], needed staleTime:Infinity
 *     to stop React Query from re-firing it); subscribe lived in the
 *     consumer hook's useEffect → one subscription per hook mount
 *   - New: sync handler owns the subscription → one subscription per
 *     collection lifetime → multiple consumers viewing the same session
 *     share one subscription → back-nav within gcTime doesn't even
 *     close+reopen the subscribe RPC (sync handler keeps running)
 *
 * Future migration (V0.5+): when TanStack/db#315 ships
 * `createPartitionedCollection`, this factory becomes a thin shim or
 * is removed entirely.
 */
const collections = new Map<string, Collection<OrderedTimelineItem, string>>();
const GC_TIME_MS = 60_000;

export interface TranscriptCollectionDeps {
  client: DaemonClient;
  /** Set on the FIRST creation of a brand-new session's collection
   *  (route-derived, `?new=1`). Forwarded to the daemon subscribe so it
   *  serves the no-disk-scan fast path — see subscribeCommand.isNew. Only
   *  consulted at collection-creation time: a cache hit (back-nav within
   *  gcTime) returns the existing collection and never re-reads this, and
   *  the daemon honors it only on the first attach. Defaults to false. */
  isNew?: boolean;
}

export function getTranscriptCollection(
  cliSessionId: string,
  deps: TranscriptCollectionDeps,
): Collection<OrderedTimelineItem, string> {
  const cached = collections.get(cliSessionId);
  if (cached !== undefined) return cached;

  const collection = createCollection<OrderedTimelineItem, string>({
    id: `transcript-${cliSessionId}`,
    // tool_call rows use `callId` (Anthropic tool_use_id) as their
    // identity. user_message / assistant_message use `uuid`. The
    // collection key has to discriminate both.
    getKey: (item: OrderedTimelineItem): string =>
      item.type === "tool_call" ? item.callId : item.uuid,
    // Sort by our injected `_order` field, NOT by key.
    compare: (a, b) => a._order - b._order,
    gcTime: GC_TIME_MS,
    sync: {
      sync: ({
        begin,
        write,
        commit,
        markReady,
        truncate,
        collection: coll,
      }) => {
        // markReady() must be called exactly once per sync handler
        // lifetime to unblock useLiveQuery's isLoading. Subsequent
        // onSubscribed firings (e.g. on transport reconnect) re-ingest
        // settled but don't re-call markReady — collection is already
        // ready, we're just refreshing its contents.
        let hasMarkedReady = false;

        const sub = deps.client.subscribe(
          cliSessionId,
          {
            onEvent: (delta) => {
              switch (delta.kind) {
                case "append": {
                  // `_order` continues from the collection's current size
                  // — first event after a cold-path settled[] ingest gets
                  // _order = settled.length; subsequent _order increments
                  // by 1 per append.
                  //
                  // Optimistic reconcile: when the client optimistically
                  // inserted this user_message (same uuid) before sending,
                  // the row is already present — reuse its `_order` rather
                  // than coll.size, so the synced row keeps the slot the
                  // optimistic bubble took and can't collide with the
                  // assistant reply that follows. Still an `insert`: the row
                  // lives only in the transaction overlay, not the synced
                  // store, so the daemon's append is what populates synced;
                  // the overlay then drops onto it by key, no flicker.
                  const key =
                    delta.item.type === "tool_call"
                      ? delta.item.callId
                      : delta.item.uuid;
                  const existing = coll.get(key);
                  begin();
                  write({
                    type: "insert",
                    value: {
                      ...delta.item,
                      _order: existing?._order ?? coll.size,
                    },
                  });
                  commit();
                  break;
                }
                case "patch_text": {
                  const current = coll.get(delta.uuid);
                  if (current?.type !== "assistant_message") return;
                  begin();
                  write({
                    type: "update",
                    value: { ...current, text: current.text + delta.deltaText },
                  });
                  commit();
                  break;
                }
                case "patch_tool_call": {
                  const current = coll.get(delta.callId);
                  if (current?.type !== "tool_call") return;
                  begin();
                  write({
                    type: "update",
                    value: {
                      ...current,
                      status: delta.status,
                      error: delta.error,
                      detail: delta.detail,
                    },
                  });
                  commit();
                  break;
                }
                case "turn_started":
                  // Clear any stale error from a prior turn. Running-state is
                  // now daemon-pushed via sessionState.activity (#17), not
                  // written here.
                  patchSessionTurnResult(cliSessionId, { lastError: null });
                  break;
                case "turn_completed":
                  if (delta.usage !== undefined) {
                    patchSessionTurnResult(cliSessionId, {
                      latestUsage: delta.usage,
                    });
                  }
                  break;
                case "turn_failed":
                  patchSessionTurnResult(cliSessionId, {
                    lastError: delta.error,
                  });
                  break;
                case "turn_canceled":
                  // Running-state handled by sessionState.activity; nothing
                  // turn-result to record on a cancel.
                  break;
                case "compact_started":
                case "compact_applied":
                  // V0.5+ — divider rendering + summary handling.
                  break;
              }
            },
            onSubscribed: ({ recovered, settled, initialUsage }) => {
              if (!recovered) {
                // Cold path — daemon returned a full snapshot. truncate()
                // is an operation INSIDE a sync transaction (must be
                // bracketed by begin()/commit()), not a standalone clear.
                // TanStack DB internally buffers the truncate + the
                // subsequent inserts in the same transaction so observers
                // never see a flash of empty content. Works correctly
                // whether collection was empty (first subscribe) or had
                // stale items (reconnect with epoch mismatch).
                begin();
                truncate();
                for (let i = 0; i < settled.length; i += 1) {
                  write({
                    type: "insert",
                    value: { ...settled[i], _order: i },
                  });
                }
                commit();
              }
              if (initialUsage !== undefined) {
                patchSessionTurnResult(cliSessionId, {
                  latestUsage: initialUsage,
                });
              }
              if (!hasMarkedReady) {
                markReady();
                hasMarkedReady = true;
              }
            },
          },
          { isNew: deps.isNew },
        );

        // Cleanup runs when the collection's gcTime expires (no active
        // subscribers for ≥60s). Unsub from the facade — daemon stops
        // fanning events for this session to us. Drop the turn-result row
        // so a future re-create starts fresh (stale usage never lingers).
        return () => {
          void sub.unsubscribe();
          clearSessionTurnResult(cliSessionId);
        };
      },
    },
  });

  // Auto-evict from this Map when the collection finishes its own
  // cleanup lifecycle. Without this listener, an evicted collection
  // would leave a stale dead entry in the cache; subsequent
  // get-for-same-sessionId would return a cleaned-up collection that
  // throws on write ops. PR TanStack/db#714 (in our 0.6.7) guarantees
  // the status:change event fires BEFORE event handlers are cleared,
  // so this delete is reliable.
  collection.on("status:change", ({ status }) => {
    if (status === "cleaned-up") {
      collections.delete(cliSessionId);
    }
  });

  collections.set(cliSessionId, collection);
  return collection;
}

interface SendMessageVars {
  cliSessionId: string;
  /** Client-generated uuid for this user_message. The optimistic insert
   *  and the daemon's synthesized append both key off it → one bubble. */
  userMessageUuid: string;
  text: string;
  cwd?: string;
  images?: ImageAttachment[];
  model?: string;
}

/**
 * Optimistic in-session send (follow-up messages only — the new-session
 * first send goes through `createSession`, whose synthesized append rides
 * in on buffer replay with no optimistic insert).
 *
 * `onMutate` inserts the user_message bubble into the session's transcript
 * collection synchronously, so it paints the instant the user hits send —
 * no waiting on the daemon round-trip. `mutationFn` fires the sendPrompt
 * carrying the SAME `userMessageUuid`; the daemon reuses it for both the
 * synthesized `user_message` append and the SDKUserMessage, so the live
 * append, the JSONL row, and this optimistic insert all share one key.
 *
 * Reconciliation (why no flicker, no double bubble): the daemon emits the
 * synthesized append synchronously in `pushPrompt` and fans it out on the
 * subscribe stream BEFORE the sendPrompt RPC ack (the handler sends the ack
 * after pushPrompt returns). Frames are ordered on the wire, so the
 * sync handler writes the row into the collection's synced store before
 * this `mutationFn` resolves. When the optimistic transaction then settles,
 * the overlay drops onto an already-present synced row (same key) — seamless.
 * No `utils.refetch()` (that's the query-collection path); the transcript is
 * a pure sync collection fed by the subscribe stream.
 *
 * On sendPrompt failure the action auto-rolls-back the optimistic insert.
 *
 * Uses the module-level `daemonClient` singleton (mirrors `createSession`),
 * so it can be a module const rather than a per-client factory.
 */
export const sendUserMessage = createOptimisticAction<SendMessageVars>({
  onMutate: ({ cliSessionId, userMessageUuid, text, images }) => {
    const coll = getTranscriptCollection(cliSessionId, {
      client: daemonClient,
    });
    coll.insert({
      type: "user_message",
      uuid: userMessageUuid,
      text,
      images: images && images.length > 0 ? images : undefined,
      // Append at the tail — lands after existing bubbles, before the
      // assistant reply (which arrives with a higher _order).
      _order: coll.size,
    });
  },
  mutationFn: async ({
    cliSessionId,
    userMessageUuid,
    text,
    cwd,
    images,
    model,
  }) => {
    await daemonClient.sendPrompt({
      sessionId: cliSessionId,
      text,
      cwd,
      images,
      model,
      userMessageUuid,
    });
  },
});
