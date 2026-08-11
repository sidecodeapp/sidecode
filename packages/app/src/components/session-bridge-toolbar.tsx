import { eq, useLiveQuery } from "@tanstack/react-db";
import { Stack } from "expo-router";
import { confirmBridgeToggle } from "@/lib/confirm-bridge-toggle";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { sessionStateCollection } from "@/lib/sessions-collection";

// Claude brand orange — matches the session-row bridged cloud badge (#DA7756),
// so a bridged session reads the same in the list and in its own header.
const BRIDGED_TINT = "#DA7756";

/**
 * Trailing header control for the session detail screen: a single nav-bar
 * button toggling this session's CCR bridge (pure P2P ↔ cloud remote
 * control). Rendered as its own `Stack.Toolbar placement="right"` so it
 * coexists with the screen's leading hamburger, and kept in its own component
 * so the detail screen stays free of `useDaemonClient` (imperative daemon calls
 * live next to the UI that triggers them).
 *
 *   - `cloud` (private): the session runs peer-to-peer to your Mac, not in the
 *     cloud. Tap → bridge.
 *   - `cloud.fill` in Claude orange (bridged): mirrored to the cloud, visible +
 *     controllable from claude.ai / Claude Desktop. Tap → make private.
 *
 * Tapping always confirms first (native Alert) — bridging EXPOSES the session,
 * un-bridging ENDS remote control, both worth a beat. Disabled while the daemon
 * isn't online: bridge/unbridge are writes that would otherwise hang (local-
 * first gates writes at the point of action rather than showing a global badge).
 *
 * A future `Stack.Toolbar.Menu` (Rename / Archive / Delete …) can sit beside
 * this button once those daemon RPCs exist; for now it's the lone trailing slot.
 */
export function SessionBridgeToolbar({
  cliSessionId,
}: {
  cliSessionId: string;
}) {
  const { client, connectionStatus } = useDaemonClient();

  // This session's row, for the live `bridged` flag (daemon-pushed via
  // subscribeSessions; flips on its own once the bridge worker-state lands —
  // no optimistic local toggle to roll back).
  const { data: row } = useLiveQuery(
    (q) =>
      q
        .from({ s: sessionStateCollection })
        .where(({ s }) => eq(s.cliSessionId, cliSessionId))
        .findOne(),
    [cliSessionId],
  );

  const isBridged = row?.bridged === true;
  const online = connectionStatus === "online";

  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button
        icon={isBridged ? "cloud.fill" : "cloud"}
        tintColor={isBridged ? BRIDGED_TINT : undefined}
        disabled={!online}
        onPress={() => confirmBridgeToggle(client, cliSessionId, isBridged)}
      />
    </Stack.Toolbar>
  );
}
