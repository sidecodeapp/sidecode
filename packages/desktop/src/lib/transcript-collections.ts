import type { TimelineItem } from "@thinkite/protocol";
import {
  type Collection,
  createCollection,
  createOptimisticAction,
} from "@tanstack/react-db";
import { daemonRpc } from "./daemon-rpc";

// Per-session live transcript collections — the desktop port of iOS's
// transcript-collection-factory.ts (same Map-of-collections pattern,
// TanStack/db#652; still the practical optimum for resident push
// subscriptions — query-driven sync's loadSubset contract is
// fetch/pagination-shaped, see project memory). One collection per
// cliSessionId; the sync handler owns the daemon subscription, so any
// number of consumers share one stream and back-nav within gcTime never
// re-issues the subscribe RPC.
//
// Desktop simplifications vs iOS: no per-session turn-result store yet
// (usage meter / turn_failed surfacing are the headerContext slice), no
// isNew fast path (desktop doesn't create sessions), no images.

/**
 * `_order` is a client-internal monotonic counter used purely for
 * sorting — NOT wire protocol. TanStack DB sorts by key without a
 * `compare`, and our keys are random uuids; `timestamp` is not monotonic
 * around compact boundaries (verified on iOS). Array order from the
 * daemon IS canonical order, so we preserve it by index.
 */
export type OrderedTimelineItem = TimelineItem & { _order: number };

const collections = new Map<string, Collection<OrderedTimelineItem, string>>();

const itemKey = (item: TimelineItem): string =>
  item.type === "tool_call" ? item.callId : item.uuid;

export function getTranscriptCollection(
  cliSessionId: string,
): Collection<OrderedTimelineItem, string> {
  const cached = collections.get(cliSessionId);
  if (cached !== undefined) return cached;

  const collection = createCollection<OrderedTimelineItem, string>({
    id: `transcript-${cliSessionId}`,
    // tool_call rows use `callId` (Anthropic tool_use_id) as identity;
    // everything else keys by message uuid.
    getKey: itemKey,
    compare: (a, b) => a._order - b._order,
    // gcTime: react-db default (5 min). The explicit 60s from the first cut
    // was tighter than it needed to be — a switched-away session's data is
    // small relative to the real renderer costs (Pierre wasm, xterm), and
    // the longer window makes back-nav re-subscribes rarer.
    sync: {
      sync: ({
        begin,
        write,
        commit,
        markReady,
        truncate,
        collection: coll,
      }) => {
        // markReady() exactly once per sync-handler lifetime; reconnect
        // re-attaches refresh contents without re-gating isLoading.
        let hasMarkedReady = false;

        const sub = daemonRpc.subscribeSession(cliSessionId, {
          onEvent: (delta) => {
            switch (delta.kind) {
              case "append": {
                // Optimistic reconcile: a user_message we optimistically
                // inserted (same uuid) already holds a slot — reuse its
                // `_order` so the synced row lands in that slot and the
                // overlay drops onto it by key, no flicker.
                const key = itemKey(delta.item);
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
              case "turn_completed":
              case "turn_failed":
              case "turn_canceled":
                // Running-state renders from the daemon-pushed
                // sessionState.activity; usage / turn errors land with
                // the composer headerContext slice.
                break;
              case "compact_started":
              case "compact_applied":
                // V0.5+ — divider append + preservedUuids filtering.
                break;
            }
          },
          onSubscribed: ({ recovered, settled }) => {
            if (!recovered) {
              // Cold path — full snapshot. truncate() inside the sync
              // transaction so observers never see a flash of empty.
              begin();
              truncate();
              for (let i = 0; i < settled.length; i += 1) {
                write({ type: "insert", value: { ...settled[i], _order: i } });
              }
              commit();
            }
            if (!hasMarkedReady) {
              markReady();
              hasMarkedReady = true;
            }
          },
        });

        // Runs when gcTime expires (no subscribers for ≥5 min).
        return () => {
          sub.unsubscribe();
        };
      },
    },
  });

  // Auto-evict when the collection finishes its own cleanup lifecycle —
  // a dead entry left in the cache would hand consumers a cleaned-up
  // collection that throws on writes.
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
  /** Client-minted uuid — the optimistic insert and the daemon's
   *  synthesized user_message append share it, so the live append drops
   *  onto the optimistic bubble by key. */
  userMessageUuid: string;
  text: string;
  cwd?: string;
  model?: string;
}

/**
 * Optimistic send: `onMutate` paints the user bubble synchronously;
 * `mutationFn` fires sendPrompt with the same uuid. The daemon fans the
 * synthesized append out on the subscribe stream BEFORE the RPC ack, and
 * frames are ordered — so the synced row exists by the time the
 * optimistic transaction settles, and the overlay lands on it seamlessly.
 * On failure the action rolls the insert back automatically.
 */
export const sendUserMessage = createOptimisticAction<SendMessageVars>({
  onMutate: ({ cliSessionId, userMessageUuid, text }) => {
    const coll = getTranscriptCollection(cliSessionId);
    coll.insert({
      type: "user_message",
      uuid: userMessageUuid,
      text,
      _order: coll.size,
    });
  },
  mutationFn: async ({ cliSessionId, userMessageUuid, text, cwd, model }) => {
    await daemonRpc.sendPrompt({
      sessionId: cliSessionId,
      text,
      cwd,
      model,
      userMessageUuid,
    });
  },
});
