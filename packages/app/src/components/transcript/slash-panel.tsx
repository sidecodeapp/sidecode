import type { SlashCommandSpec } from "@thinkite/protocol";
import { GlassView } from "expo-glass-effect";
import {
  Pressable,
  ScrollView,
  Text,
  useColorScheme,
  View,
} from "react-native";

/**
 * Overlay command picker shown above the composer when the user enters
 * slash-command mode (i.e. their text starts with `/` and the cursor
 * hasn't crossed a space yet — that detection lives in `InputBar`).
 *
 * Visual: Liquid Glass capsule matching the InputBar's chrome.
 * Layout: parent positions absolutely (typically `bottom: '100%'` of
 * the composer wrap with an 8pt gap). This component is height-
 * agnostic and caps at PANEL_MAX_HEIGHT below so 3 two-line rows fit
 * even on iPhone SE under a keyboard.
 *
 * Empty `commands` renders a "No matching commands" sentinel rather
 * than collapsing — preserves layout predictability when the user
 * over-types past any prefix match.
 */

// 3 rows × ~54pt (title text-sm ~20pt + subtitle text-xs ~16pt + mt-0.5
// 2pt + py-2 16pt) + 8pt vertical scroll padding ≈ 170pt.
const PANEL_MAX_HEIGHT = 180;

export function SlashPanel({
  commands,
  onPick,
}: {
  commands: readonly SlashCommandSpec[];
  onPick: (commandName: string) => void;
}) {
  const isDark = useColorScheme() === "dark";
  return (
    <GlassView
      isInteractive
      style={{
        borderRadius: 18,
        borderCurve: "continuous",
        // Fallback for iOS<26 / Android: solid-ish background so the
        // panel reads as a card. On iOS 26+ the Liquid Glass material
        // sits in front of this color.
        backgroundColor: isDark
          ? "rgba(28,28,30,0.55)"
          : "rgba(255,255,255,0.55)",
        maxHeight: PANEL_MAX_HEIGHT,
      }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="py-1"
      >
        {commands.length === 0 ? (
          <View className="px-4 py-3">
            <Text className="text-sm text-zinc-500 dark:text-zinc-400">
              No matching commands
            </Text>
          </View>
        ) : (
          commands.map((c) => (
            <Pressable
              key={c.name}
              onPress={() => onPick(c.name)}
              className="px-4 py-2"
            >
              {/* Row 1: `/cmd [argHint]` — argHint muted (POSIX
                  placeholder convention). Single Text so the hint
                  chunk inherits baseline. */}
              <Text className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {c.name}
                {c.argHint && (
                  <Text className="text-zinc-400 dark:text-zinc-500 font-normal">
                    {" "}
                    {c.argHint}
                  </Text>
                )}
              </Text>
              {/* Row 2: description subtitle */}
              <Text
                className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5"
                numberOfLines={1}
              >
                {c.description}
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </GlassView>
  );
}
