/**
 * Slash-command whitelist for sidecode V0.
 *
 * Single source of truth for which `/command` strings the iOS picker
 * surfaces and which ones the daemon accepts via `sendPrompt`. Living
 * in protocol/ means the two sides can't drift — version mismatch is
 * caught by the existing `isProtocolCompatible` semver gate.
 *
 * V0 policy is intentionally tight:
 *   - Picker shows ONLY commands in this map, filtered by context
 *     (new-session vs in-session)
 *   - `/foo` not in this map → iOS rejects pre-send with a toast,
 *     daemon rejects with an `error` envelope as defense-in-depth.
 *   - No fall-through to "treat unknown /foo as prompt text" (Claude
 *     Code does fall through; sidecode deliberately doesn't). See
 *     thinkite/thinkite#10 for the trade-off discussion.
 *
 * Per-command `handling`:
 *
 *   - `passthrough`: iOS sends the literal `/cmd args` string via
 *     `sendPrompt`; daemon forwards to the SDK which executes it
 *     natively. Used for `/init`, `/review`, `/compact`.
 *
 *   - `intercept`: iOS dispatches to a sidecode-owned RPC or local
 *     navigation INSTEAD of `sendPrompt`. Daemon's `sendPrompt`
 *     handler rejects intercept-handling commands as "client bug —
 *     should have been intercepted client-side." Used for `/clear`
 *     (navigate to new-session screen; old session left in the list)
 *     and `/model` (reuses the existing `setSessionSelection` RPC).
 *
 * V0.5+ adds `/fork`, `/rename`, `/rewind` — all intercept-handling.
 * See thinkite/thinkite#10 for design notes.
 *
 * @[CLAUDE CODE COMMAND DRIFT] Claude Code ships new commands roughly
 * weekly. Sidecode is deliberately a curated subset; we don't track
 * upstream's full registry. Edit this file only when adding a
 * deliberately-supported command for V0.5+ and beyond.
 */

/** Which screen a command is offered on. */
export type CommandContext = "new-session" | "in-session";

/** Where the actual execution lives. See file header. */
export type CommandHandling = "passthrough" | "intercept";

export type SlashCommandSpec = {
  /** Command slug WITHOUT leading `/`. Must match the user-typed name. */
  readonly name: string;
  /** Screens that show this command in their picker. */
  readonly contexts: readonly CommandContext[];
  /** Execution flavor — see `CommandHandling` doc. */
  readonly handling: CommandHandling;
  /** Picker subtitle / placeholder for the parameter slot. Optional. */
  readonly argHint?: string;
  /** One-line picker description. Shown under the command name. */
  readonly description: string;
};

/**
 * V0 whitelist. Key order = picker display order — keep prompts first,
 * then session-state mutators. Edit deliberately.
 *
 * The `as const satisfies` pattern gives us both:
 *   - runtime: a plain object usable by `Object.values()` for the picker
 *   - types: `SlashCommandName` derived from the literal key union, so
 *     `SLASH_COMMANDS[name].handling` is narrowed without a cast.
 */
export const SLASH_COMMANDS = {
  init: {
    name: "init",
    contexts: ["new-session", "in-session"],
    handling: "passthrough",
    description: "Initialize project with a CLAUDE.md guide",
  },
  review: {
    name: "review",
    contexts: ["new-session", "in-session"],
    handling: "passthrough",
    argHint: "[PR]",
    description: "Review a pull request locally in your current session",
  },
  clear: {
    name: "clear",
    contexts: ["in-session"],
    handling: "intercept",
    description: "Start a new conversation with empty context",
  },
  compact: {
    name: "compact",
    contexts: ["in-session"],
    handling: "passthrough",
    argHint: "[instructions]",
    description: "Free up context by summarizing the conversation so far",
  },
  model: {
    name: "model",
    contexts: ["in-session"],
    handling: "intercept",
    argHint: "[model]",
    description: "Set the AI model for the current session",
  },
} as const satisfies Record<string, SlashCommandSpec>;

export type SlashCommandName = keyof typeof SLASH_COMMANDS;

/** True iff `name` (without leading `/`) is in the V0 whitelist. Acts
 *  as a type guard so callers can index `SLASH_COMMANDS[name]` after. */
export function isWhitelistedCommand(name: string): name is SlashCommandName {
  return Object.hasOwn(SLASH_COMMANDS, name);
}

/** Picker data source. Returns specs in `SLASH_COMMANDS` declared order. */
export function getCommandsForContext(
  ctx: CommandContext,
): readonly SlashCommandSpec[] {
  return Object.values(SLASH_COMMANDS).filter((c) =>
    // Widen the narrow literal-tuple type for `.includes()` — each
    // spec's `contexts` is narrowed by `as const` (e.g. `["in-session"]`
    // for `/clear`), which makes `.includes("new-session")` a type error
    // even though it's the correct runtime check.
    (c.contexts as readonly CommandContext[]).includes(ctx),
  );
}

/**
 * Parse a user-input string into `{ name, args }` if it looks like a
 * slash command, else `null`.
 *
 * Ported from Claude Code's `utils/slashCommandParsing.ts` (simplified —
 * we drop the `(MCP)` second-word marker since sidecode V0 doesn't
 * surface MCP commands).
 *
 * Splitting rule: first space separates name from args; everything
 * after the first space (joined back with single spaces) is `args`.
 * Trailing whitespace is trimmed before parsing.
 *
 * Examples:
 *   "/model claude-opus-4-7"   → { name: "model",  args: "claude-opus-4-7" }
 *   "/review 123 abc"          → { name: "review", args: "123 abc" }
 *   "/init"                    → { name: "init",   args: "" }
 *   "/model claude-opus-4-7 "  → trimmed → args: "claude-opus-4-7"
 *   "hello /model x"           → null (must start with `/`)
 *   "/"                        → null (empty name)
 */
export function parseSlashCommand(
  input: string,
): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const firstSpace = body.indexOf(" ");
  if (firstSpace === -1) {
    if (body.length === 0) return null;
    return { name: body, args: "" };
  }
  const name = body.slice(0, firstSpace);
  if (name.length === 0) return null;
  return { name, args: body.slice(firstSpace + 1).trim() };
}
