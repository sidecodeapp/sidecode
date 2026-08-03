import {
  type CommandContext,
  type ImageAttachment,
  isWhitelistedCommand,
  MODELS,
  parseSlashCommand,
  SLASH_COMMANDS,
} from "@thinkite/protocol";
import * as Burnt from "burnt";
import { useRouter } from "expo-router";
import { useCallback } from "react";
import { updateSessionModel } from "@/lib/sessions-collection";

/**
 * Shared pre-send slash-command pipeline used by both the new-session
 * screen and the in-session ChatPanel. Returns a single function with
 * the same `(text, images, model)` shape as `<InputBar onSend>`, so
 * parents can drop it in front of their existing sendPrompt logic without
 * rewriting their data flow. `model` (the picker selection, supplied by
 * InputBar) is forwarded verbatim to `onPassthrough` so the parent's send
 * call can seed it:
 *
 *     const rawSend = useCallback((text, imgs, model) => { ... }, [...]);
 *     const onSend = useSlashCommandHandler({
 *       context: "in-session",
 *       sessionId: cliSessionId,
 *       onPassthrough: rawSend,
 *     });
 *     <InputBar onSend={onSend} />
 *
 * Pipeline (matches daemon's defense-in-depth check at sendPrompt):
 *
 *   1. Not a slash         → onPassthrough (most messages take this path)
 *   2. Not in whitelist    → Burnt error toast + haptic, no send
 *   3. Wrong context       → Burnt error toast + haptic, no send
 *   4. passthrough spec    → onPassthrough (daemon forwards to SDK)
 *   5. intercept spec
 *      - `/clear`          → `router.replace("/")` (sessions list top
 *                            is the new-session screen; old session
 *                            left in the list, no archive — matches
 *                            Claude Code semantics)
 *      - `/model <id>`     → validate against the bundled `MODELS`
 *                            table, dispatch via `updateSessionModel`
 *                            (same optimistic action the model chip uses)
 *      - `/model` no arg   → toast hint to tap the chip; opening the
 *                            chip's sheet programmatically would need a
 *                            new imperative API on InputBar, deferred
 *
 * V0 whitelist defined in `@thinkite/protocol/slash-commands`.
 * V0.5+ /fork /rename /rewind: each is intercept-handling, will gain a
 * new switch case here. See thinkite/thinkite#10.
 */
export type SlashCommandHandlerOpts =
  | {
      context: "new-session";
      onPassthrough: (
        text: string,
        images: ImageAttachment[] | undefined,
        model: string,
      ) => void;
    }
  | {
      context: "in-session";
      /** Required to dispatch `/model` via updateSessionModel. */
      sessionId: string;
      onPassthrough: (
        text: string,
        images: ImageAttachment[] | undefined,
        model: string,
      ) => void;
    };

export function useSlashCommandHandler(
  opts: SlashCommandHandlerOpts,
): (
  text: string,
  images: ImageAttachment[] | undefined,
  model: string,
) => boolean | void {
  const router = useRouter();
  const { context, onPassthrough } = opts;
  // `/model <id>` dispatches against this session; new-session has no
  // session id (the command is unreachable there — step 3 rejects it).
  const sessionId = opts.context === "in-session" ? opts.sessionId : null;

  return useCallback(
    (text: string, images: ImageAttachment[] | undefined, model: string) => {
      const parsed = parseSlashCommand(text);

      // 1. Not a slash command → passthrough (covers most messages).
      if (!parsed) {
        onPassthrough(text, images, model);
        return;
      }

      // 2. Not in V0 whitelist → reject + KEEP INPUT (industry
      //    convention: VS Code, Slack, Discord, Cursor all preserve
      //    text on rejected commands so the user can fix a typo
      //    without retyping). Single-line title to fit the SPIndicator
      //    pill; user discovers supported list via the `/` button.
      if (!isWhitelistedCommand(parsed.name)) {
        Burnt.toast({
          title: `/${parsed.name} isn't available`,
          preset: "error",
          haptic: "error",
          duration: 2,
        });
        return false;
      }

      const spec = SLASH_COMMANDS[parsed.name];

      // 3. Whitelisted but wrong screen (e.g. `/clear` typed on the
      //    new-session screen) → reject + keep input. Picker UI filters
      //    these out, but a user typing/pasting from memory trips here.
      //
      //    Cast widens spec.contexts past the `as const` literal-tuple
      //    narrowing — see `getCommandsForContext` in protocol/ for the
      //    same pattern.
      if (!(spec.contexts as readonly CommandContext[]).includes(context)) {
        Burnt.toast({
          title: `/${parsed.name} not on this screen`,
          preset: "error",
          haptic: "error",
          duration: 2,
        });
        return false;
      }

      // 4. Passthrough → let parent's sendPrompt handle the literal text.
      //    Input clears on the parent's normal "send happened" semantics.
      if (spec.handling === "passthrough") {
        onPassthrough(text, images, model);
        return;
      }

      // 5. Intercept → dispatch locally, NEVER call onPassthrough
      //    (otherwise the daemon's defense-in-depth would reject).
      switch (parsed.name) {
        case "clear":
          // New conversation. Old session stays in the list — no archive,
          // matching Claude Code's /clear (wipe screen but session still
          // resolvable). Implicit input clear is fine since we navigate
          // away anyway.
          router.replace("/");
          return;

        case "model": {
          // /model lives in in-session only (enforced by step 3), but
          // TypeScript can't narrow opts to the in-session arm via
          // spec.contexts. Re-check via the derived sessionId.
          if (sessionId === null) {
            return false;
          }
          const modelId = parsed.args.trim();
          if (!modelId) {
            // Hint, not error — keep input so user can append an id.
            Burnt.toast({
              title: "Tap the model chip to switch",
              preset: "none",
              duration: 2,
            });
            return false;
          }
          const hit = MODELS.find((m) => m.model === modelId);
          if (!hit) {
            // Keep input so user can fix the model id typo.
            Burnt.toast({
              title: `Unknown model: ${modelId}`,
              preset: "error",
              haptic: "error",
              duration: 2,
            });
            return false;
          }
          // Successful intercept — model switch dispatched (optimistic +
          // RPC via the same action the chip uses), clear input.
          updateSessionModel({ cliSessionId: sessionId, model: modelId });
          return;
        }
      }
    },
    [context, onPassthrough, router, sessionId],
  );
}
