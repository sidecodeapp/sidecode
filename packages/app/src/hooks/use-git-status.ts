import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitStatus } from "@thinkite/protocol";
import { useEffect, useRef } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Live git status for a `cwd`, as the canonical react-query realtime shape:
 * a one-shot `getGitStatus` queryFn for the initial snapshot, plus a pure
 * change-stream subscription that folds each push into the SAME cache entry
 * via `setQueryData`. Returns the latest snapshot, or `null` while loading /
 * `cwd` is undefined / offline.
 *
 * Why `connectionStatus` gates + re-subscribes: git status is a pass-through
 * to the current Transport, NOT a facade-managed auto-resume subscription.
 * On an offline→online transport swap the old subscription is dead; gating
 * `enabled` on `connectionStatus` re-fires both the query (fresh snapshot —
 * the watcher may have missed changes while we were gone) and the subscribe
 * effect (a new listener on the new transport). Default staleTime means
 * re-enabling refetches; the daemon's 15s status cache keeps that cheap.
 */
export function useGitStatus(
  cwd: string | undefined,
  /** Fired on each live status-change push (NOT the initial snapshot — that's
   *  the queryFn) — a generic change hook so the caller can react (e.g.
   *  invalidate the working-tree-diff query) WITHOUT this primitive knowing
   *  about it. Held in a ref, so a fresh inline callback each render doesn't
   *  re-subscribe. */
  onChange?: (status: GitStatus) => void,
): GitStatus | null {
  const { client, connectionStatus } = useDaemonClient();
  const queryClient = useQueryClient();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const enabled = cwd !== undefined && connectionStatus === "online";

  const { data } = useQuery({
    queryKey: ["gitStatus", cwd],
    queryFn: () => {
      if (!cwd) throw new Error("cwd required");
      return client.getGitStatus(cwd);
    },
    enabled,
  });

  // Live deltas — a pure change stream (no initial; that's the queryFn). Each
  // push folds into the same cache entry and notifies onChange.
  useEffect(() => {
    if (!enabled || !cwd) return;
    let active = true;
    let unsub: (() => Promise<void>) | null = null;
    client
      .subscribeGitStatus(cwd, (s) => {
        if (!active) return;
        queryClient.setQueryData(["gitStatus", cwd], s);
        onChangeRef.current?.(s);
      })
      .then(({ unsubscribe }) => {
        if (!active) return void unsubscribe().catch(() => {});
        unsub = unsubscribe;
      })
      .catch((err) => {
        if (active) console.error("subscribeGitStatus failed", err);
      });
    return () => {
      active = false;
      void unsub?.().catch(() => {});
    };
  }, [client, cwd, enabled, queryClient]);

  return data ?? null;
}
