import { createCollection } from "@tanstack/react-db";
import type { SessionState } from "@thinkite/protocol";
import { daemonRpc } from "./daemon-rpc";

/**
 * Desktop row shape for the session-states collection — same design as
 * iOS's sessions-collection.ts: the daemon's `SessionState` payload keyed
 * by `cliSessionId` (the stream's `sessionId` IS the Claude Code session
 * uuid; the daemon's `local_*` bookkeeping id never reaches clients).
 * Routes and the PTY attach key by this same id.
 */
export type SessionRow = SessionState & {
  cliSessionId: string;
};

/**
 * The desktop's single session-state collection, backed by the daemon's
 * `subscribeSessions` push stream over the /rpc bridge.
 *
 * Sync contract (ported from iOS): every (re)connect delivers a fresh
 * `initial` snapshot — truncate + bulk insert so rows removed while
 * disconnected don't linger; live `session_state_changed` /
 * `session_state_removed` envelopes upsert / delete row-by-row.
 * Last-write-wins, no cursor.
 *
 * `startSync: true` keeps the collection warm from app start; route
 * loaders gate on `preload()` before reading.
 */
export const sessionStateCollection = createCollection<SessionRow, string>({
  id: "session-states",
  getKey: (r) => r.cliSessionId,
  startSync: true,
  sync: {
    sync: ({ begin, write, commit, markReady, truncate, collection }) => {
      let hasMarkedReady = false;

      const handle = daemonRpc.subscribeSessions({
        onInitial: (entries) => {
          begin();
          truncate();
          for (const { sessionId, state } of entries) {
            write({
              type: "insert",
              value: { cliSessionId: sessionId, ...state },
            });
          }
          commit();
          if (!hasMarkedReady) {
            markReady();
            hasMarkedReady = true;
          }
        },
        onChange: (sessionId, state) => {
          // insert / update are mutually exclusive in TanStack DB —
          // branch on presence for upsert semantics.
          const existing = collection.get(sessionId);
          begin();
          write({
            type: existing === undefined ? "insert" : "update",
            value: { cliSessionId: sessionId, ...state },
          });
          commit();
        },
        onRemove: (sessionId) => {
          if (collection.get(sessionId) === undefined) return;
          begin();
          write({ type: "delete", key: sessionId });
          commit();
        },
      });
      return () => handle.unsubscribe();
    },
  },
});
