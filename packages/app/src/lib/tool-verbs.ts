import type { ToolCallDetail } from "@thinkite/protocol";

/**
 * Past-tense verb for a tool-call row: `<verb> <summary>` where the verb is
 * muted (red on failure) and the daemon-computed summary is the object
 * ("Read chat-markdown.tsx", "Searched <pattern>", "Ran agent Explore: …").
 *
 * Vocabulary harvested from claude.ai/code (2026-06-12, live probe):
 * Read / Ran / Searched / Created / Edited / Searched web / Fetched /
 * Ran agent / Used <name>. Failure keeps the verb — only the color flips.
 * `running` rows also render past tense by design (no -ing forms): the
 * web's progressive labels swap mid-turn, which reads as flicker in a
 * virtualized list, and the row settles within a couple hundred ms anyway.
 *
 * Tools with no web counterpart follow the same families:
 * task_create/update/stop → "… task", schedule_wakeup → "Scheduled",
 * monitor → "Ran" (it spawns a watch command, Bash-adjacent),
 * ask_user → "Asked" (historical Desktop transcripts only — the daemon
 * disallows AskUserQuestion in sidecode-driven turns).
 */
export function toolVerb(detail: ToolCallDetail): string {
  switch (detail.type) {
    case "bash":
    case "monitor":
      return "Ran";
    case "read":
      return "Read";
    case "edit":
      return "Edited";
    case "write":
      return "Created";
    case "grep":
    case "glob":
      return "Searched";
    case "agent":
      return "Ran agent";
    case "web_fetch":
      return "Fetched";
    case "web_search":
      return "Searched web";
    case "task_create":
      return "Created task";
    case "task_update":
      return "Updated task";
    case "task_stop":
      return "Stopped task";
    case "ask_user":
      return "Asked";
    case "schedule_wakeup":
      return "Scheduled";
    case "unknown":
      return "Used";
  }
}
