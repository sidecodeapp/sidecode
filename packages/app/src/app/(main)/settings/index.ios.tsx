import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  Menu,
  Section,
  Spacer,
  Text,
  Toggle,
} from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  frame,
  padding,
} from "@expo/ui/swift-ui/modifiers";
import { useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import {
  useSetThemePreference,
  useThemePreference,
} from "@/hooks/use-theme-preference";
import { statusColor, useDaemonClient } from "@/lib/daemon-client-context";
import { clearLastUsedCwd } from "@/lib/last-used-cwd";
import type { ThemePref } from "@/lib/theme-preference";
import {
  getTransportPreference,
  setTransportPreference,
  type TransportPref,
} from "@/lib/transport-preference";

/**
 * Settings root, iOS-only. Uses `@expo/ui/swift-ui` (Form, Section, Button +
 * custom label) directly instead of the universal API.
 *
 * Why not universal: universal Button on iOS always pushes a `buttonStyle()`
 * modifier (even for `variant="text"` → `buttonStyle("plain")`), which
 * overrides the Form-aware automatic style SwiftUI would otherwise pick.
 * Tested empirically: gives a chunky filled capsule for the destructive
 * action when we want a borderless Settings-style row. Going to swift-ui
 * namespace lets us hand the Button to Form raw and let the iOS list-style
 * inheritance kick in.
 *
 * Disclosure rows use `<Button>` with custom HStack label so SwiftUI's
 * Form/List provides cell highlight on tap for free, and full-row hit
 * area without needing `contentShape`. Inside Form, the auto-borderless
 * Button preserves children foreground colors (title primary, subtitle
 * gray, chevron gray).
 *
 * `index.tsx` is an Android stub that returns null — V0 is iOS-only.
 * The stub exists solely so expo-router's typed-routes generator picks
 * up `/settings` (it scans bare-extension files only, no platform suffix).
 */
export default function SettingsIndexScreen() {
  const { paired, connectionStatus } = useDaemonClient();
  const queryClient = useQueryClient();
  const version = Constants.expoConfig?.version ?? "—";

  // Wipe the persisted "last used cwd" so the next New-session lands on the
  // empty placeholder again — lets you toggle that state without a Metro
  // reload. Invalidate so live subscribers re-read null immediately.
  const onClearLastCwd = async () => {
    await clearLastUsedCwd();
    queryClient.invalidateQueries({ queryKey: ["lastUsedCwd"] });
  };

  return (
    <>
      <Stack.Screen options={{ title: "Settings" }} />
      {/* Top-left Cancel — iOS HIG: dismiss/back actions on the leading
          edge. Settings was historically on the right; aligned with
          cwd-picker + pair for a single consistent sheet-dismiss
          location across the app. */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="xmark"
          accessibilityLabel="Close"
          onPress={() => router.back()}
        />
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <Form>
          <Section title="General">
            <AppearanceMenu />
          </Section>
          <Section
            title="Host"
            footer={
              <Text
                modifiers={[
                  font({ size: 13 }),
                  foregroundStyle("#8E8E93"),
                  padding({ top: 16 }),
                  frame({ maxWidth: Infinity }),
                ]}
              >
                Version {version}
              </Text>
            }
          >
            <Button onPress={() => router.push("/settings/host")}>
              <HStack alignment="center" spacing={8}>
                {/* Leading status dot (Mail.app unread-indicator pattern) —
                    scannable at-a-glance state without reading text. Same
                    color as the host-detail Status section so the row's
                    state matches the page it leads to. */}
                <Image
                  systemName="circle.fill"
                  size={10}
                  color={statusColor(connectionStatus)}
                />
                {/* Without an explicit foreground style, SwiftUI Button
                    tints the title text with the current accent color
                    (system blue). `foregroundStyle("primary")` forces
                    the literal `Color.primary` (black/white auto-adapt). */}
                <Text modifiers={[foregroundStyle("primary")]}>
                  {paired?.serviceName ?? "—"}
                </Text>
                <Spacer />
                <Image systemName="chevron.right" size={14} color="#8E8E93" />
              </HStack>
            </Button>
          </Section>
          {/* Dev-only probe pages, relocated here from the session-list
              sidebar so the sidebar stays product-clean. Whole section is
              stripped from release builds via __DEV__ (a literal the bundler
              dead-code-eliminates). Pushes resolve at the (main) Stack level
              and present a card over this settings sheet; back returns here. */}
          {__DEV__ && (
            <Section title="Developer">
              <DisclosureRow
                label="KeyboardExtender spike"
                onPress={() => router.push("/dev/keyboard-extender")}
              />
              <DisclosureRow
                label="iroh probe"
                onPress={() => router.push("/dev/iroh")}
              />
              <TransportToggle />
              <Button
                label="Clear last cwd (test placeholder)"
                onPress={onClearLastCwd}
              />
            </Section>
          )}
        </Form>
      </Host>
    </>
  );
}

/**
 * Dev toggle: dial the daemon over iroh instead of WebRTC on the NEXT
 * (re)connect — flipping it doesn't tear down a live transport, so
 * toggle + background/foreground the app (or wait for a natural
 * reconnect) to switch. Same pairing identity either way; the daemon's
 * iroh listener is always on.
 */
function TransportToggle() {
  const [pref, setPref] = useState<TransportPref | null>(null);
  useEffect(() => {
    void getTransportPreference().then(setPref);
  }, []);
  return (
    <Toggle
      label="iroh transport (next connect)"
      isOn={pref === "iroh"}
      onIsOnChange={(on) => {
        const next: TransportPref = on ? "iroh" : "webrtc";
        setPref(next);
        void setTransportPreference(next);
      }}
    />
  );
}

/**
 * A borderless Form row with a leading title and trailing chevron — the
 * disclosure-cell shape iOS Settings uses for "tap to drill in". Same
 * Button-with-HStack-label trick as the Host row (auto-borderless inside
 * Form, preserves child foreground colors, full-row hit area + tap
 * highlight). `foregroundStyle("primary")` keeps the title black/white
 * instead of inheriting the accent tint a bare Button title would get.
 */
function DisclosureRow({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Button onPress={onPress}>
      <HStack alignment="center" spacing={8}>
        <Text modifiers={[foregroundStyle("primary")]}>{label}</Text>
        <Spacer />
        <Image systemName="chevron.right" size={14} color="#8E8E93" />
      </HStack>
    </Button>
  );
}

const APPEARANCE_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * Appearance row: a static "Appearance" label on the left; on the right, a
 * `Menu` whose trigger is ONLY the current value + up/down glyph (just that
 * trailing chunk is tappable, not the whole row). The menu lists the three
 * options with a leading checkmark on the selected one (iOS's native
 * menu-selection affordance). Picking applies + persists via
 * `useSetThemePreference` (one `Uniwind.setTheme` flips the whole app).
 */
function AppearanceMenu() {
  const { data: pref = "system" } = useThemePreference();
  const setPref = useSetThemePreference();
  const current = APPEARANCE_OPTIONS.find((o) => o.value === pref);

  return (
    <HStack alignment="center" spacing={8}>
      <Text modifiers={[foregroundStyle("primary")]}>Appearance</Text>
      <Spacer />
      <Menu
        label={
          <HStack alignment="center" spacing={4}>
            {/* iOS 26 SwiftUI Menu clips a dynamic-width label for ~1 frame
                on mount (expo/expo#44579 — an OS Menu bug, not Expo). Reserve
                width for the longest option ("System") and trailing-align so
                the value sits flush against the chevron and never clips.
                ~60pt covers it at body size. */}
            <Text
              modifiers={[
                foregroundStyle("#8E8E93"),
                frame({ minWidth: 60, alignment: "trailing" }),
              ]}
            >
              {current?.label ?? "System"}
            </Text>
            <Image
              systemName="chevron.up.chevron.down"
              size={12}
              color="#8E8E93"
            />
          </HStack>
        }
      >
        {APPEARANCE_OPTIONS.map((o) => (
          <Button
            key={o.value}
            label={o.label}
            systemImage={o.value === pref ? "checkmark" : undefined}
            onPress={() => setPref(o.value)}
          />
        ))}
      </Menu>
    </HStack>
  );
}
