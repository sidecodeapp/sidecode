import type { ImageAttachment } from "@thinkite/protocol";
import * as Crypto from "expo-crypto";
import { router, Stack } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardController,
} from "react-native-keyboard-controller";
import { GitStatusBar } from "@/components/transcript/git-status-bar";
import { InputBar } from "@/components/transcript/input-bar";
import { useFilesystemRoots } from "@/hooks/use-filesystem-roots";
import { useLastUsedCwd, useSetLastUsedCwd } from "@/hooks/use-last-used-cwd";
import { useDrawerUI } from "@/lib/drawer-ui";
import { createSession } from "@/lib/sessions-collection";

/**
 * (drawer)/(stack)/index — new-session create page, URL `/`. Lives inside
 * the same Stack as the detail screen so it inherits the native UIKit
 * UINavigationBar (iOS 26 Liquid Glass) via Stack.Header / Stack.Toolbar.
 *
 * Sibling-of-detail layout means the "+ New" sidebar action and "tap a
 * session row" action both translate to `router.replace` within the same
 * Stack — no drawer-screen swap, no inner-Stack remount, no flicker. The
 * `(stack)` group is invisible in URLs, so this page is just `/`, not
 * `/session` — cold launch lands here directly.
 *
 * cwd selection precedence:
 *   1. `lastUsedCwd` (SecureStore) — what the user picked or opened
 *      most recently on THIS device. Set on session-row tap (sidebar)
 *      and on send below.
 *   2. `recentCwds[0]` from daemon `getFilesystemRoots` — server's
 *      best guess across all activity, used as the initial bootstrap
 *      default before the user has picked anything on this device.
 *   3. `undefined` — first launch with no session history. GitStatusBar
 *      shows a "Select a project" placeholder + chevron; tap opens the
 *      cwd picker. Send button stays disabled until cwd resolves.
 *
 * Flow on first send:
 *   1. Generate a fresh UUIDv4 client-side
 *   2. `createSession(...)` — its onMutate optimistically inserts the
 *      session row (so the sidebar + detail screen show it, with a title,
 *      immediately), and its mutationFn fires the first sendPrompt +
 *      reconciles via refetch
 *   3. `router.replace("/session/[id]")` immediately — the detail screen
 *      reads the just-inserted row via its own filtered live query
 *
 * The first sendPrompt fires HERE (not deferred to the detail screen)
 * because the daemon seeds an empty settled snapshot for a freshly-created
 * query — so the synthesized user_message + turn_started are recovered via
 * ring-buffer replay whenever the detail screen subscribes, regardless of
 * order. (Previously this was deferred to ChatPanel's first-send effect to
 * dodge the cursor race window; the daemon-side seed removes that need.)
 */
export default function NewSessionScreen() {
  const { openDrawer } = useDrawerUI();

  // Default cwd: client-side "last used" wins; otherwise fall back to
  // server's most-recent activity. Both can be undefined on a brand-
  // new install — handleSend gates on cwd being defined.
  const { data: lastUsedCwd } = useLastUsedCwd();
  const { data: roots } = useFilesystemRoots();
  const cwd = lastUsedCwd ?? roots?.recentCwds[0]?.path ?? undefined;
  const setLastUsedCwd = useSetLastUsedCwd();

  // The model picker lives INSIDE InputBar now (cliSessionId={null} =
  // draft mode: InputBar holds a local draft model seeded to
  // DEFAULT_MODEL). The chosen model arrives back via `rawSend`'s `model`
  // arg at send time and seeds `createSession`. No selection state here.

  // Create-bridged intent: a LOCAL pref (no session exists yet — nothing to
  // RPC) that rides out on the first send's `bridged` flag. Mirrors the detail
  // screen's header toggle, but here it just flips local state.
  const [createBridged, setCreateBridged] = useState(false);
  const toggleCreateBridged = useCallback(() => {
    // Turning OFF (→ private) needs no confirm — nothing is exposed yet.
    if (createBridged) {
      setCreateBridged(false);
      return;
    }
    // Turning ON (→ bridged) confirms first, like the other bridge toggles.
    Alert.alert(
      "Start Remote Control?",
      "The session you create will be bridged to the cloud from its first message — visible and controllable from claude.ai and Claude Desktop.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Start", onPress: () => setCreateBridged(true) },
      ],
    );
  }, [createBridged]);

  // Raw send — invoked for non-slash text AND for whitelisted
  // passthrough commands (/init, /review). On new-session only those
  // two passthrough commands are reachable; intercept commands aren't
  // in the new-session picker so the slash hook never dispatches
  // /clear or /model from here.
  const rawSend = useCallback(
    (text: string, images: ImageAttachment[] | undefined, model: string) => {
      if (cwd === undefined) {
        // Placeholder state — user hasn't picked and there's no
        // recent history to fall back on. InputBar.canSend already
        // gates on text/images presence; this is the extra cwd gate
        // so we don't ship a malformed sendPrompt to the daemon.
        return;
      }
      // Refresh "last used" so subsequent new-session opens default
      // to this same cwd even before the daemon records the activity.
      setLastUsedCwd.mutate(cwd);
      const newId = Crypto.randomUUID();
      // Optimistically create the session: `createSession`'s onMutate
      // inserts the row synchronously (so the sidebar + detail screen show
      // it — with a title — the instant we navigate), and its mutationFn
      // fires the first sendPrompt + reconciles via refetch. The daemon
      // seeds an empty settled snapshot for the freshly-created query, so
      // this sendPrompt firing before the detail screen subscribes is
      // race-free. sendPrompt failure rolls the optimistic row back.
      // `model` comes from InputBar's draft picker (the only place the
      // pre-create selection lives).
      createSession({
        cliSessionId: newId,
        text,
        cwd,
        images,
        model,
        bridged: createBridged,
      }).isPersisted.promise.catch((err) => {
        console.error("create session failed", err);
      });
      router.replace({
        pathname: "/session/[cliSessionId]",
        // `new: "1"` flags the detail screen's transcript subscribe to
        // take the daemon's brand-new-session fast path (skip the JSONL
        // scan — there's none yet — and dodge the cold-path await race
        // that drops the synthesized first user_message). Self-clearing:
        // the next navigation is another router.replace without it.
        params: { cliSessionId: newId, cwd, new: "1" },
      });
    },
    [cwd, setLastUsedCwd, createBridged],
  );

  const openCwdPicker = useCallback(() => {
    // Push the cwd-picker modal route. The sheet runs `setLastUsedCwd`
    // itself on confirm and pops via `router.dismissTo("/")` — this
    // screen just needs to open it. No callback wiring needed; the
    // `useLastUsedCwd()` query above re-fires on mutation invalidate.
    router.push("/cwd-picker");
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <Stack.Header transparent />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="line.3.horizontal" onPress={openDrawer} />
      </Stack.Toolbar>
      {/* Create-bridged toggle — same cloud↔cloud.fill vocabulary as the
          detail header, but a LOCAL intent (no session to bridge yet); it rides
          out on the first send. Claude orange when armed. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={createBridged ? "cloud.fill" : "cloud"}
          tintColor={createBridged ? "#DA7756" : undefined}
          onPress={toggleCreateBridged}
        />
      </Stack.Toolbar>
      <View className="flex-1 bg-white dark:bg-black pb-safe">
        <KeyboardAvoidingView
          behavior="padding"
          className="flex-1"
          keyboardVerticalOffset={8}
        >
          {/* Tap anywhere in the empty heading area to dismiss the
              keyboard — standard iOS chat pattern. `KeyboardController.dismiss()`
              from react-native-keyboard-controller goes through the same
              worklet pipeline as KAV's translate, so the close animation
              stays synced with the heading sliding back down (vs RN's
              `Keyboard.dismiss()` which can lag by a frame).
              `accessible={false}` so VoiceOver skips this dead-space
              control instead of announcing "button". InputBar lives
              OUTSIDE this Pressable so its own taps still focus the
              TextInput. */}
          <Pressable
            accessible={false}
            onPress={() => KeyboardController.dismiss()}
            className="flex-1 items-center justify-center px-6"
          >
            <Text className="text-2xl font-semibold text-black dark:text-white">
              New session
            </Text>
          </Pressable>

          {/* Composer chrome — GitStatusBar (cwd picker trigger) sits
            above InputBar inside the same KeyboardStickyView so they
            translate as one unit when the keyboard moves. Picker mode:
            cwd display + tap target only, `+N -M` hidden since the user
            is choosing a project, not reviewing its diff state.
            `offset.closed: -insets.bottom` lifts the composer above the
            home indicator (KSV is absolutely-positioned at bottom: 0,
            which is below the safe area); `offset.opened: -8` leaves an
            8pt visual gap above the keyboard.
            NOTE (likely stale — kept as history): an earlier attempt to
            collapse this into a single KeyboardAvoidingView misaligned the
            InputBar's `+` button on first keyboard show. The cause was
            @expo/ui's SwiftUI Menu Host async measurement + an iOS IME
            candidate-bar bug — BOTH now moot: the `+`/model pickers moved to
            the Nitro menu (@yyq1025/react-native-nitro-menu, pure UIKit, no
            Host), and the @expo/ui Host keyboard bug was fixed upstream. So
            this caveat probably no longer applies. */}
          <View>
            <GitStatusBar
              cwd={cwd}
              onPress={openCwdPicker}
              showChanges={false}
            />
            <InputBar cliSessionId={null} onSend={rawSend} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </>
  );
}
