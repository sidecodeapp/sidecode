/**
 * Building blocks shared between batch normalize (`normalize.ts`) and the
 * incremental query runner (`runtime/run-query.ts`):
 *
 *   - Anthropic ContentBlock zod schemas (text/tool_use/tool_result + the
 *     per-role discriminated unions)
 *   - Per-tool input schemas (Bash, Read, Edit, Write, Grep, Glob)
 *   - `buildDetailFromInput(name, rawInput)`: maps SDK tool_use into a typed
 *     `ToolCallDetail` variant, with a fallback `unknown` for tools we don't
 *     specially-render in V0
 *   - `attachOutputToDetail(detail, outputText)`: in-place plug of a textual
 *     tool_result into whichever field of the variant holds it
 *   - `summaryFor(detail, name)`: row object label the iOS row renders
 *     after a past-tense verb (see app tool-verbs.ts)
 *   - `extractText(raw)`: pull text from a `tool_result.content` (string or
 *     ContentBlock[])
 *
 * F2's incremental runner needs the same primitives the batch normalize does
 * — pulling them here keeps single-source-of-truth, so a fix to (say) Edit's
 * unifiedDiff format only touches one place.
 */

import { grepMode, type ToolCallDetail } from "@thinkite/protocol";
import { structuredPatch } from "diff";
import { z } from "zod";
import { detectLanguageForPath } from "./language-detect.ts";

// ─── Anthropic ContentBlock schemas ─────────────────────────────────────

export const textBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional().default(false),
});

/**
 * Anthropic ImageBlockParam. `source.type` covers both inline base64 and
 * URL forms; V0 only emits the base64 branch (mobile uploads images as
 * inline data). URL/file branches are accepted at parse time so a third-
 * party CLI's session JSONL doesn't crash normalize — we just skip those
 * images downstream rather than fail the whole user message.
 *
 * `media_type` is left wide here (z.string()) so unsupported formats like
 * image/gif / image/webp don't blow up the discriminated union; the
 * downstream filter rejects anything other than image/jpeg | image/png
 * to match the protocol's imageAttachment.mediaType enum.
 */
export const imageBlock = z.object({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("base64"),
      media_type: z.string(),
      data: z.string(),
    }),
    z.object({
      type: z.literal("url"),
      url: z.string(),
    }),
  ]),
});

export const assistantContentBlock = z.discriminatedUnion("type", [
  textBlock,
  toolUseBlock,
]);

export const userContentBlock = z.discriminatedUnion("type", [
  textBlock,
  toolResultBlock,
  imageBlock,
]);

// ─── Per-tool input schemas ─────────────────────────────────────────────
//
// Mirror the SDK's `ToolInputSchemas` shape but only the fields we surface.
// Failed parse → fallback to `unknown` variant (defensive: malformed
// Claude output never crashes normalization).

const bashInputSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  run_in_background: z.boolean().optional(),
});

const readInputSchema = z.object({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  pages: z.string().optional(),
});

const editInputSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const writeInputSchema = z.object({
  file_path: z.string(),
  content: z.string(),
});

const grepInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  output_mode: grepMode.optional(),
});

const globInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

// ─── Per-tool input schemas (extended V0 set) ─────────────────────────
// Order matches the toolCallDetail discriminated union in protocol/index.ts.
// Field names mirror SDK input (snake_case where SDK uses snake_case);
// the detail builders below normalize to camelCase per the timeline
// schema convention.

const agentInputSchema = z.object({
  // Optional per SDK AgentInput — omitted means the default catch-all agent.
  subagent_type: z.string().optional(),
  description: z.string(),
  prompt: z.string(),
  // Per-spawn model override; absent in the common inherit case.
  model: z.string().optional(),
});

const webFetchInputSchema = z.object({
  url: z.string(),
  prompt: z.string(),
});

const webSearchInputSchema = z.object({
  query: z.string(),
});

const taskCreateInputSchema = z.object({
  subject: z.string(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
});

const taskUpdateInputSchema = z.object({
  taskId: z.string(),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .optional(),
  activeForm: z.string().optional(),
});

const taskStopInputSchema = z.object({
  // SDK input uses snake_case here (verified via probe on real sessions).
  task_id: z.string(),
});

const askUserInputSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      multiSelect: z.boolean(),
      options: z.array(
        z.object({
          label: z.string(),
          description: z.string(),
        }),
      ),
    }),
  ),
});

const scheduleWakeupInputSchema = z.object({
  delaySeconds: z.number(),
  reason: z.string(),
  prompt: z.string(),
});

const monitorInputSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
});

// ─── Detail builder ─────────────────────────────────────────────────────

export function buildDetailFromInput(
  name: string,
  rawInput: unknown,
): ToolCallDetail {
  switch (name) {
    case "Bash": {
      const parsed = bashInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { command, description, run_in_background } = parsed.data;
      return {
        type: "bash",
        command,
        description,
        output: "", // populated by tool_result attachment
        // Carry the background flag (default `false` collapses to undefined
        // for cleaner wire output). taskId is populated later by the
        // tool_result parser when the SDK reports back the task id.
        runInBackground: run_in_background ? true : undefined,
      };
    }

    case "Read":
    case "FileRead": {
      const parsed = readInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { file_path, offset, limit, pages } = parsed.data;
      return {
        type: "read",
        filePath: file_path,
        content: "", // populated by tool_result attachment
        language: detectLanguageForPath(file_path),
        offset,
        limit,
        pages,
      };
    }

    case "Edit":
    case "FileEdit": {
      const parsed = editInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { file_path, old_string, new_string, replace_all } = parsed.data;
      return {
        type: "edit",
        filePath: file_path,
        oldString: old_string,
        newString: new_string,
        replaceAll: replace_all,
        unifiedDiff: makeUnifiedDiff(file_path, old_string, new_string),
      };
    }

    case "Write":
    case "FileWrite": {
      const parsed = writeInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { file_path, content } = parsed.data;
      return {
        type: "write",
        filePath: file_path,
        content,
        // Treat every Write as create-from-empty — we lack the prior file
        // content (sidecar stripped by getSessionMessages), so an "update"
        // diff isn't reconstructible. The all-green new-file diff is still
        // the right visual: shows what was written.
        unifiedDiff: makeUnifiedDiff(file_path, "", content),
      };
    }

    case "Grep": {
      const parsed = grepInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { pattern, path, output_mode } = parsed.data;
      return {
        type: "grep",
        pattern,
        path,
        // SDK default per GrepInput docs.
        mode: output_mode ?? "files_with_matches",
        output: "", // populated by tool_result attachment
      };
    }

    case "Glob": {
      const parsed = globInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { pattern, path } = parsed.data;
      return {
        type: "glob",
        pattern,
        path,
        output: "", // populated by tool_result attachment
      };
    }

    case "Agent": {
      const parsed = agentInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { subagent_type, description, prompt, model } = parsed.data;
      return {
        type: "agent",
        // "" = SDK omitted subagent_type (default agent); summaryFor skips
        // the empty head instead of rendering ": description".
        subagentType: subagent_type ?? "",
        description,
        prompt,
        model,
        output: "", // subagent's final text, populated by tool_result attachment
      };
    }

    case "WebFetch": {
      const parsed = webFetchInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { url, prompt } = parsed.data;
      return {
        type: "web_fetch",
        url,
        prompt,
        output: "", // populated by tool_result attachment
      };
    }

    case "WebSearch": {
      const parsed = webSearchInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { query } = parsed.data;
      return {
        type: "web_search",
        query,
        output: "", // populated by tool_result attachment
      };
    }

    case "TaskCreate": {
      const parsed = taskCreateInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { subject, description, activeForm } = parsed.data;
      // taskId not in input — SDK generates it and returns via tool_result.
      // attachOutputToDetail (task_create case) parses it out and patches
      // the detail in place. Placeholder empty string keeps the discriminated
      // shape valid in the meantime (live: between tool_use and tool_result).
      return {
        type: "task_create",
        taskId: "",
        subject,
        description,
        activeForm,
      };
    }

    case "TaskUpdate": {
      const parsed = taskUpdateInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { taskId, status, activeForm } = parsed.data;
      return {
        type: "task_update",
        taskId,
        status,
        activeForm,
      };
    }

    case "TaskStop": {
      const parsed = taskStopInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      // SDK uses snake_case (task_id) — normalize to camelCase taskId.
      return {
        type: "task_stop",
        taskId: parsed.data.task_id,
      };
    }

    case "AskUserQuestion": {
      const parsed = askUserInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      return {
        type: "ask_user",
        questions: parsed.data.questions,
        // answers populated post-hoc by attachOutputToDetail when the
        // tool_result lands (user picked an option). Undefined while pending.
      };
    }

    case "ScheduleWakeup": {
      const parsed = scheduleWakeupInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { delaySeconds, reason, prompt } = parsed.data;
      return {
        type: "schedule_wakeup",
        delaySeconds,
        reason,
        prompt,
      };
    }

    case "Monitor": {
      const parsed = monitorInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { command, description } = parsed.data;
      return {
        type: "monitor",
        command,
        description,
        // taskId comes from tool_result; Monitor always spawns a background
        // task so the result line carries it analogously to Bash background.
        output: "", // populated by tool_result attachment
      };
    }

    default:
      return unknownDetail(name, rawInput);
  }
}

function unknownDetail(name: string, rawInput: unknown): ToolCallDetail {
  return { type: "unknown", toolName: name, input: rawInput, output: "" };
}

/**
 * Compose a git-style unified diff (`diff --git` + `---`/`+++` headers +
 * `@@` hunks), shaped for Pierre's PatchDiff (iOS tool-call sheet).
 *
 * The headers are REQUIRED, not cosmetic: Pierre's `parsePatchFiles`
 * needs file boundaries — a hunks-only string parses as metadata with
 * ZERO files, and `getSingularPatch` (inside `<PatchDiff>`) throws "must
 * contain exactly 1 file diff". This was exactly the iOS sheet crash on
 * every Edit/Write detail (found 2026-06-12).
 *
 * The GIT form specifically (not plain `--- x`/`+++ x` headers) is
 * load-bearing too: in non-git mode Pierre splits files on `^---\s+\S`
 * ANYWHERE in the patch, and a deleted content line that itself starts
 * with `-- ` (SQL/Lua/Haskell comments) renders as `--- foo` in the hunk
 * body — a phantom second file → same throw. Git mode only splits on
 * `diff --git` lines, and hunk-body lines always carry a +/-/space/\\
 * prefix, so no content can forge that boundary. Mirrors git-watch's
 * synthesizeAddPatch, which is why the working-tree path never crashed.
 *
 * Basename (not the absolute path) in all three header lines — drives
 * shiki language inference by extension and avoids leaking `/Users/...`
 * into the rendered header. Verified against @pierre/diffs@1.2.7:
 * `--- a/<name>` / `+++ b/<name>` parse via FILENAME_HEADER_REGEX_GIT
 * (prefixes stripped, spaces in names fine).
 *
 * We use jsdiff's `structuredPatch` rather than `createPatch` to skip the
 * `Index:` / `===` boilerplate Pierre doesn't need.
 *
 * Output for a small Edit:
 *   diff --git a/foo.ts b/foo.ts
 *   --- a/foo.ts
 *   +++ b/foo.ts
 *   @@ -1,3 +1,3 @@
 *   -const x = 1;
 *   +const x = 2;
 *    const y = 3;
 *
 * Empty oldString === newString produces an empty string (no hunks — the
 * sheet shows "(no output)" instead of an empty diff shell).
 */
function makeUnifiedDiff(
  filePath: string,
  oldString: string,
  newString: string,
): string {
  // Suppress jsdiff's "\ No newline at end of file" markers by padding a
  // final newline onto both sides (line content is unchanged). The marker
  // asserts something about the FILE end, but Edit diffs compare file
  // FRAGMENTS — a snippet ending without \n says nothing about the file —
  // so the marker is noise stated as fact (and Pierre renders it as a
  // dedicated row). Claude's own UIs drop it too. "" stays "" (Write's
  // create-from-empty diff must keep the empty side truly empty).
  const a =
    oldString === "" || oldString.endsWith("\n") ? oldString : `${oldString}\n`;
  const b =
    newString === "" || newString.endsWith("\n") ? newString : `${newString}\n`;
  const patch = structuredPatch(filePath, filePath, a, b);
  if (patch.hunks.length === 0) return "";
  const name = basenameOf(filePath);
  return (
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n` +
    patch.hunks
      .map(
        (h) =>
          `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` +
          h.lines.join("\n"),
      )
      .join("\n")
  );
}

/**
 * Plug textual tool_result output into whichever field of the detail
 * variant carries it (varies per type — bash.output, read.content, etc.).
 * Mutates `detail` in place.
 */
export function attachOutputToDetail(
  detail: ToolCallDetail,
  output: string,
): void {
  switch (detail.type) {
    case "bash":
      detail.output = output;
      // For background spawn, the SDK confirms with a one-line message:
      //   "Command running in background with ID: bxxxxxx. Output is being
      //    written to: /…/tasks/bxxxxxx.output. You will be notified …"
      // Parse the task id (path-based regex covers Monitor too) so the
      // transcript row can deep-link into the Background Tasks panel.
      if (detail.runInBackground) {
        detail.taskId = parseBackgroundTaskId(output);
      }
      return;
    case "monitor":
      detail.output = output;
      // Monitor always spawns a background task.
      detail.taskId = parseBackgroundTaskId(output);
      return;
    case "read":
      detail.content = stripLineNumberPrefix(output);
      return;
    case "grep":
    case "glob":
    case "unknown":
    // New variants whose `output` slot mirrors the SDK tool_result text.
    case "agent":
    case "web_fetch":
    case "web_search":
      detail.output = output;
      return;
    // edit/write don't surface tool_result text — input is sufficient.
    case "edit":
    case "write":
    // TaskUpdate / TaskStop / ScheduleWakeup: tool_result is just a
    // confirmation string ("Updated task #1 status" / "Next wakeup
    // scheduled for …"). No useful structured fields to extract — UI
    // shows the row summary from the input alone.
    case "task_update":
    case "task_stop":
    case "schedule_wakeup":
      return;
    case "task_create": {
      // Input lacks taskId — SDK generates it and returns inline in the
      // confirmation message. Patch the placeholder "" in detail.taskId
      // (set by buildDetailFromInput) with the real id so subsequent
      // TaskUpdate/TaskStop rows can reference it.
      const id = parseTaskCreatedId(output);
      if (id !== undefined) detail.taskId = id;
      return;
    }
    case "ask_user": {
      // tool_result encodes the user's choice per question. Daemon
      // populates detail.answers so the UI can render "selected: <label>"
      // alongside the original questions.
      const answers = parseAskUserAnswers(output);
      if (answers !== undefined) detail.answers = answers;
      return;
    }
  }
}

// ─── Summary (row object label) ─────────────────────────────────────────

/**
 * The OBJECT part of the iOS transcript row. The app prepends a past-tense
 * verb derived from detail.type (tool-verbs.ts: "Read" / "Edited" /
 * "Searched" / …, claude.ai/code vocabulary), so summaries here must read
 * as the verb's object — never restate the action ("#1 stopped" would
 * render "Stopped task #1 stopped").
 */
export function summaryFor(detail: ToolCallDetail, name: string): string {
  switch (detail.type) {
    case "bash":
      return detail.description || truncate(detail.command, 60);
    case "read":
    case "edit":
    case "write":
      return basenameOf(detail.filePath);
    case "grep":
      return detail.path
        ? `"${detail.pattern}" in ${basenameOf(detail.path)}`
        : `"${detail.pattern}"`;
    case "glob":
      return detail.pattern;
    case "agent": {
      // "Explore (haiku): Find usages" / "Explore: Find usages" /
      // "(haiku): …" never happens — bare model becomes the head.
      const head = detail.subagentType
        ? detail.model
          ? `${detail.subagentType} (${detail.model})`
          : detail.subagentType
        : (detail.model ?? "");
      const desc = truncate(detail.description, 50);
      return head ? `${head}: ${desc}` : desc;
    }
    case "web_fetch": {
      // Host only — full URL clutters the row. Falls back to raw if
      // URL.parse fails (shouldn't happen for SDK-issued URLs).
      try {
        return new URL(detail.url).host;
      } catch {
        return truncate(detail.url, 50);
      }
    }
    case "web_search":
      return `"${truncate(detail.query, 50)}"`;
    case "task_create":
      return detail.subject;
    case "task_update":
      return detail.activeForm
        ? `#${detail.taskId} ${truncate(detail.activeForm, 40)}`
        : `#${detail.taskId}${detail.status ? `: ${detail.status}` : ""}`;
    case "task_stop":
      return `#${detail.taskId}`;
    case "ask_user": {
      const first = detail.questions[0];
      if (!first) return "Ask user";
      return first.header || truncate(first.question, 50);
    }
    case "schedule_wakeup":
      return `+${detail.delaySeconds}s · ${truncate(detail.reason, 40)}`;
    case "monitor":
      return detail.description || truncate(detail.command, 60);
    case "unknown":
      return name;
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────

/**
 * Pull text from a tool_result.content field. Anthropic spec allows either
 * a string or an array of `{ type: "text", text: string }` (and image/etc.
 * blocks we don't surface in V0).
 */
export function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  const parts: string[] = [];
  for (const b of raw) {
    const parsed = textBlock.safeParse(b);
    if (parsed.success) parts.push(parsed.data.text);
  }
  return parts.join("");
}

/**
 * Strip Claude Code's `<right-justified line number>\t` prefix from Read
 * tool output. Only strips when EVERY non-empty line matches, to avoid
 * mangling content that happens to start with digits + tab.
 */
function stripLineNumberPrefix(text: string): string {
  if (text.length === 0) return text;
  const lines = text.split("\n");
  const re = /^\s*\d+\t/;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (!re.test(line)) return text;
  }
  return lines.map((l) => (l.length === 0 ? "" : l.replace(re, ""))).join("\n");
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Extract the SDK-generated task id from a TaskCreate tool_result like:
 *   "Task #1 created successfully: Install react-qrcode-logo in menubar"
 * Returns the numeric id as a string (matching the schema's `taskId: string`
 * field; TaskUpdate/TaskStop's input field is also string). Undefined on
 * shape mismatch — caller leaves the placeholder "" in detail.taskId.
 */
function parseTaskCreatedId(output: string): string | undefined {
  return /^Task #(\d+) created/.exec(output)?.[1];
}

/**
 * Extract the user's selected option labels from an AskUserQuestion
 * tool_result like:
 *   'User has answered your questions: "Q1"="A1", "Q2"="A2". You can now …'
 * Each answer is the right-hand side of a `="…"` pair. The order matches
 * the order Claude posed the questions, so the array maps 1:1 onto
 * detail.questions[]. Multi-select answers come as `"[Opt A, Opt B]"`;
 * unanswered ones as `"[No preference]"`. We forward the raw bracket
 * form for the UI to format.
 */
function parseAskUserAnswers(output: string): string[] | undefined {
  if (!output.startsWith("User has answered")) return undefined;
  const answers: string[] = [];
  for (const match of output.matchAll(/="([^"]+)"/g)) {
    answers.push(match[1] as string);
  }
  return answers.length > 0 ? answers : undefined;
}

/**
 * Extract the SDK-generated background task ID from a tool_result message
 * like:
 *   "Command running in background with ID: b2yeeqzmy. Output is being
 *    written to: /…/tasks/b2yeeqzmy.output. You will be notified when …"
 *
 * Matches against the file path rather than the "ID: …" prefix so the
 * same regex works for both Bash background spawns and Monitor (whose
 * SDK response uses similar wording but may diverge in the prefix).
 * Returns undefined if no match — caller leaves detail.taskId as-is.
 */
function parseBackgroundTaskId(output: string): string | undefined {
  return /\/tasks\/([a-z0-9]+)\.output/i.exec(output)?.[1];
}
