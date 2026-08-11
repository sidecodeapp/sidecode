import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  Section,
  Spacer,
  Text,
} from "@expo/ui/swift-ui";
import { font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import { PROTOCOL_VERSION } from "@thinkite/protocol";
import { Stack } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-native";
import type { TransportDiagnostics } from "@/lib/daemon-client";
import {
  statusColor,
  statusLabel,
  useDaemonClient,
} from "@/lib/daemon-client-context";

/**
 * Single-host detail page, iOS-only. See settings/index.ios.tsx for why
 * this lives in the SwiftUI namespace instead of the universal API.
 *
 * V0 is single-paired-daemon, so the route has no dynamic segment.
 * "Forget host" calls `unpair()` which closes the WS, wipes SecureStore,
 * and flips state to `unpaired` — the root Stack.Protected guard then
 * routes back to /onboarding automatically (no imperative router call needed).
 *
 * Destructive action uses `<Button role="destructive" label="...">` —
 * SwiftUI gives us systemRed (auto light/dark adapt), red-tinted cell
 * highlight on press, and a "destructive" VoiceOver hint, all native.
 *
 * If/when multi-host arrives, rename to `hosts/[fingerprint].ios.tsx`
 * and source the record by id; the section structure carries over.
 */
export default function SettingsHostScreen() {
  const { paired, unpair, connectionStatus, client } = useDaemonClient();

  // Phase-4 measurement panel: poll live wire diagnostics while this
  // screen is up. 1s is fast enough to watch a QUIC path migrate
  // during a roaming test, cheap enough to not matter (iroh samples
  // are synchronous FFI reads; WebRTC returns a constant).
  const [diag, setDiag] = useState<TransportDiagnostics | null>(null);
  useEffect(() => {
    const sample = () => setDiag(client.transportDiagnostics());
    sample();
    const id = setInterval(sample, 1000);
    return () => clearInterval(id);
  }, [client]);

  const onForget = () => {
    Alert.alert(
      "Forget this host?",
      "You'll need to scan a pair QR from Thinkite on your Mac again to reconnect.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => {
            void unpair();
          },
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: paired?.serviceName ?? "Host" }} />
      <Host style={{ flex: 1 }}>
        <Form>
          {/* One section of label-left / value-right rows (iOS Settings value
              table) — collapses what were four single-value sections. Each row
              is a bare HStack; LabeledContent would be the semantic fit but its
              props are an empty stub in this @expo/ui version. */}
          <Section>
            <InfoRow label="Status">
              <Image
                systemName="circle.fill"
                size={10}
                color={statusColor(connectionStatus)}
              />
              <Text modifiers={[foregroundStyle("#8E8E93")]}>
                {statusLabel(connectionStatus)}
              </Text>
            </InfoRow>
            <InfoRow label="Hostname">
              <Text modifiers={[foregroundStyle("#8E8E93")]}>
                {paired?.serviceName ?? "—"}
              </Text>
            </InfoRow>
            <InfoRow label="Protocol">
              <Text
                modifiers={[
                  font({ design: "monospaced" }),
                  foregroundStyle("#8E8E93"),
                ]}
              >
                {PROTOCOL_VERSION}
              </Text>
            </InfoRow>
          </Section>
          {/* Live wire panel (phase-4 measurements). Rows degrade to "—"
              while offline; the paths list only exists on iroh. */}
          <Section title="Connection">
            <InfoRow label="Transport">
              <Text modifiers={[foregroundStyle("#8E8E93")]}>
                {diag === null
                  ? "—"
                  : diag.kind === "iroh"
                    ? "iroh"
                    : "WebRTC"}
              </Text>
            </InfoRow>
            <InfoRow label="Connected in">
              <Text
                modifiers={[
                  font({ design: "monospaced" }),
                  foregroundStyle("#8E8E93"),
                ]}
              >
                {diag === null
                  ? "—"
                  : `${diag.wireMs + diag.helloMs} ms (wire ${diag.wireMs} + hello ${diag.helloMs})`}
              </Text>
            </InfoRow>
            {diag?.rttMs !== undefined && (
              <InfoRow label="RTT">
                <Text
                  modifiers={[
                    font({ design: "monospaced" }),
                    foregroundStyle("#8E8E93"),
                  ]}
                >
                  {diag.rttMs} ms
                </Text>
              </InfoRow>
            )}
            {diag?.paths?.map((p) => (
              <InfoRow
                key={p.id}
                label={p.isSelected ? `Path ${p.id} ●` : `Path ${p.id}`}
              >
                <Text
                  modifiers={[
                    font({ design: "monospaced", size: 12 }),
                    foregroundStyle("#8E8E93"),
                  ]}
                >
                  {`${p.kind} ${shortAddr(p.remoteAddr)} ${p.rttMs}ms`}
                </Text>
              </InfoRow>
            ))}
          </Section>
          <Section>
            {/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole
                ('default' | 'cancel' | 'destructive'), not an HTML/ARIA
                role attribute. Drives systemRed + VoiceOver "destructive"
                hint at the SwiftUI layer. */}
            <Button role="destructive" label="Forget host" onPress={onForget} />
          </Section>
        </Form>
      </Host>
    </>
  );
}

/** Compress a path address for one Form row: relay URLs lose scheme +
 *  trailing dot-slash noise, IPs pass through. */
function shortAddr(addr: string): string {
  return addr.replace(/^https?:\/\//, "").replace(/\.?\/?$/, "");
}

/**
 * Compact label-left / value-right Form row (iOS Settings value-cell). Label is
 * primary; pass the value as children (tint it secondary at the call site).
 */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <HStack alignment="center" spacing={8}>
      <Text modifiers={[foregroundStyle("primary")]}>{label}</Text>
      <Spacer />
      {children}
    </HStack>
  );
}
