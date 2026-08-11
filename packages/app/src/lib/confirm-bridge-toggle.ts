import { Alert } from "react-native";

/** Minimal structural shape this helper needs — avoids coupling to the full
 *  DaemonClient facade (the real client satisfies it). */
type BridgeClient = {
  bridgeSession(sessionId: string): Promise<void>;
  unbridgeSession(sessionId: string): Promise<void>;
};

/**
 * Confirm-then-toggle this session's CCR bridge (pure P2P ↔ cloud remote
 * control). Shared by the session-row context menu and the detail-screen header
 * button so the privacy-sensitive copy + the bridge/unbridge dispatch live in
 * exactly one place (no drift between the two entry points).
 *
 * Always confirms first via a native Alert — bridging EXPOSES the session to
 * the cloud, un-bridging ENDS remote control, both worth a beat. The flag is
 * NOT flipped optimistically: we fire the RPC and let `bridged` flip when the
 * daemon broadcasts the new state (no local state to roll back).
 */
export function confirmBridgeToggle(
  client: BridgeClient,
  cliSessionId: string,
  isBridged: boolean,
): void {
  const apply = () => {
    const pending = isBridged
      ? client.unbridgeSession(cliSessionId)
      : client.bridgeSession(cliSessionId);
    pending.catch((err) =>
      console.warn(
        `[sidecode] ${isBridged ? "unbridgeSession" : "bridgeSession"} failed:`,
        err,
      ),
    );
  };

  if (isBridged) {
    Alert.alert(
      "Make Private?",
      "This session will stop syncing to the cloud. Remote control from claude.ai and Claude Desktop will end.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Make Private", onPress: apply },
      ],
    );
  } else {
    Alert.alert(
      "Start Remote Control?",
      "This session will be mirrored to the cloud — visible and controllable from claude.ai and Claude Desktop.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Start", onPress: apply },
      ],
    );
  }
}
