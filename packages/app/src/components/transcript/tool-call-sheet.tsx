import { ModalBottomSheet } from "@swmansion/react-native-bottom-sheet";
import type { ToolCallDetail } from "@thinkite/protocol";
import { Asset } from "expo-asset";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkingTreeDiff } from "@/hooks/use-working-tree-diff";
import { ChunkedMarkdown } from "@/lib/markdown/chunked-markdown";
import { toolVerb } from "@/lib/tool-verbs";
import type { ToolRenderBlock } from "@/lib/transcript-blocks";
import workerPortableAsset from "../../../assets/pierre/worker-portable.pwt";
import PierreView from "./pierre-view";

// Pierre's off-thread highlight worker (worker-portable.js), vendored as a Metro
// asset so the DOM webview can fetch it (a Metro URL in dev). Resolved once;
// PierreView fetches this URI → Blob → `new Worker`. See metro.config.js +
// scripts/sync-pierre-worker.mjs.
const WORKER_ASSET_URI = Asset.fromModule(workerPortableAsset).uri;

/**
 * Single shared BottomSheet at transcript level (Paseo pattern). Each ToolBlock
 * row is a Pressable that calls `openToolCall(block)`; the sheet lives outside
 * the virtualized list, so its open state is independent of row-recycle.
 *
 * Shell: `@swmansion/react-native-bottom-sheet` (`ModalBottomSheet`, a NATIVE
 * Fabric sheet). Chosen over the previous `@expo/ui/community/bottom-sheet`
 * (SwiftUI `.sheet`) for two reasons:
 *   1. It keeps collapsed children MOUNTED (controlled `index`/`detents` model,
 *      no UISheetPresentationController), so the Pierre webview below stays
 *      RESIDENT + PRE-WARMED → fast first open. The SwiftUI sheet lazily
 *      mounts → cold every open.
 *   2. `ModalBottomSheet` (= `<BottomSheet modal/>` over a `BottomSheetProvider`
 *      portal) renders a dimming `scrim` backdrop we control via `scrimColor` /
 *      `scrimOpacities`. (The inline `BottomSheet`'s scrim is a no-op.)
 *
 * Content: a single resident `PierreView` (@pierre/diffs in an expo-dom WebView)
 * renders diff/code detail bodies; this replaces react-native-diffs
 * (`MarkdownView`) for tool detail. Error / `unknown` / empty bodies render
 * NATIVELY in an overlaid region while the webview is hidden (display:none) but
 * stays mounted/warm. See `describeDetail`.
 *
 * Open flow (flash-free): on tap we swap the webview content while the sheet is
 * still collapsed, then open (`setIndex`) only after the new payload PAINTS
 * (`onReady`). Warm-reuse: re-tapping a row whose content is already painted
 * opens instantly (compared by content string, robust to callId reuse).
 */

interface ToolCallSheetContextValue {
  openToolCall: (block: ToolRenderBlock) => void;
  /** Open the working-tree diff for `cwd` (wired to GitStatusBar's tap). */
  openGitDiff: (cwd: string) => void;
  closeToolCall: () => void;
}

const ToolCallSheetContext = createContext<ToolCallSheetContextValue | null>(
  null,
);

export function useToolCallSheet(): ToolCallSheetContextValue {
  const ctx = useContext(ToolCallSheetContext);
  if (!ctx) {
    throw new Error(
      "useToolCallSheet must be used within ToolCallSheetProvider",
    );
  }
  return ctx;
}

// Closed / half / (near-)full. Fixed, NOT content-sized: a measured detent left
// a small file stuck at a previous large file's height (spike finding). The
// webview owns its own vertical scroll.
const HALF = 0.5;
const FULL = 1;
// Per-detent scrim alpha: transparent when closed, dimmed (not blacked out) at
// half + full so the transcript stays faintly visible behind.
const SCRIM_OPACITIES = [0, 0.5, 0.5];

interface WebviewPayload {
  kind: "diff" | "code" | "multifile";
  content: string;
  name?: string;
  /** Hide Pierre's filename header + line-number gutter — true for
   *  command/search output (bash, grep, glob). */
  noHeader?: boolean;
  noLineNumbers?: boolean;
}

// Pre-warm payload: a tiny file so shiki loads before the first real open.
const WARMUP: WebviewPayload = {
  kind: "code",
  content: "// warm\n",
  name: "warm.ts",
  noHeader: true,
};

/** What the sheet is currently showing. The resident webview is shared across
 *  both — tool detail (static, from a block) and the live working-tree diff. */
type Showing =
  | { kind: "tool"; block: ToolRenderBlock }
  | { kind: "gitDiff"; cwd: string }
  | null;

export function ToolCallSheetProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const { height } = useWindowDimensions();
  // Bottom safe-area inset (home indicator). Fed to PierreView so the multi-file
  // CodeView's last line clears it — single-file File/PatchDiff get this for free
  // from WKWebView's content inset, but CodeView's internal CSS scroll does not.
  const insets = useSafeAreaInsets();
  const detents = useMemo(
    () => [0, Math.round(height * HALF), Math.round(height * FULL)],
    [height],
  );

  const [showing, setShowing] = useState<Showing>(null);
  const [index, setIndex] = useState(0); // 0 closed · 1 half · 2 full
  // The resident webview always renders the LAST webview payload, so a native
  // body (error/unknown/loading) overlaid on top never discards warm content.
  const [webview, setWebview] = useState<WebviewPayload>(WARMUP);
  // gitDiff only: false until the fetched diff has PAINTED, so an opaque loading
  // overlay hides the prior payload until then (no flash). Stays true across
  // live refetches (re-tokenize happens in place behind nothing).
  const [diffReady, setDiffReady] = useState(false);

  // Warm-reuse / flash-free bookkeeping (RN-side; never crosses the bridge).
  const renderedContent = useRef<string>(WARMUP.content);
  const pendingContent = useRef<string>(WARMUP.content);
  const awaitingOpen = useRef(false); // tool open waits on first paint
  const awaitingDiffPaint = useRef(false); // gitDiff reveal waits on paint

  // Working-tree diff: one-shot RPC via react-query, fetched only while the
  // git-diff sheet is open. structuralSharing keeps `data` referentially stable
  // across byte-identical refetches → the effect below no-ops (no re-tokenize).
  // GitStatusBar invalidates ["workingTreeDiff", cwd] on git changes.
  const gitDiffCwd = showing?.kind === "gitDiff" ? showing.cwd : undefined;
  const diffQuery = useWorkingTreeDiff(gitDiffCwd, {
    enabled: gitDiffCwd !== undefined && index > 0,
  });
  const diffData = diffQuery.data;

  // Push fetched diff content into the resident webview. Reference-stable
  // `diffData` means an unchanged refetch doesn't re-fire this.
  useEffect(() => {
    if (showing?.kind !== "gitDiff") return;
    if (!diffData?.isRepo || diffData.diff === "") return;
    if (diffData.diff === renderedContent.current) {
      // Already painted (reopen of an unchanged diff) → reveal now, no swap.
      setDiffReady(true);
      return;
    }
    pendingContent.current = diffData.diff;
    awaitingDiffPaint.current = true;
    setWebview({ kind: "multifile", content: diffData.diff });
  }, [showing, diffData]);

  const openToolCall = useCallback((b: ToolRenderBlock) => {
    KeyboardController.dismiss(); // sheet open dismisses the composer keyboard
    const d = describeDetail(b);
    setShowing({ kind: "tool", block: b });
    if (d.mode === "native") {
      // No webview to wait on — open immediately (from closed; keep half/full).
      awaitingOpen.current = false;
      setIndex((i) => (i === 0 ? 1 : i));
      return;
    }
    if (d.content === renderedContent.current) {
      // Already painted → instant warm open, no re-tokenize.
      awaitingOpen.current = false;
      setIndex((i) => (i === 0 ? 1 : i));
      return;
    }
    // Swap content while collapsed; `onReady` opens the sheet after it paints.
    pendingContent.current = d.content;
    awaitingOpen.current = true;
    setWebview({
      kind: d.kind,
      content: d.content,
      name: d.name,
      noHeader: d.noHeader,
      noLineNumbers: d.noLineNumbers,
    });
  }, []);

  const openGitDiff = useCallback((cwd: string) => {
    KeyboardController.dismiss(); // sheet open dismisses the composer keyboard
    // Open immediately with a loading overlay (there's a fetch + tokenize
    // before content is ready); the diff fills in via the effect + diffReady.
    awaitingOpen.current = false;
    setDiffReady(false);
    setShowing({ kind: "gitDiff", cwd });
    setIndex((i) => (i === 0 ? 1 : i));
  }, []);

  const closeToolCall = useCallback(() => {
    awaitingOpen.current = false;
    setIndex(0); // keep `showing` + `webview` so re-opening is warm
  }, []);

  // Fired by the webview once shiki has loaded and the payload has painted.
  const onReady = useCallback(() => {
    renderedContent.current = pendingContent.current;
    if (awaitingDiffPaint.current) {
      awaitingDiffPaint.current = false;
      setDiffReady(true);
    }
    if (awaitingOpen.current) {
      awaitingOpen.current = false;
      setIndex((i) => (i === 0 ? 1 : i));
    }
  }, []);

  const value = useMemo(
    () => ({ openToolCall, openGitDiff, closeToolCall }),
    [openToolCall, openGitDiff, closeToolCall],
  );

  // ── Body: webview vs an opaque native overlay (loading/empty/error/etc.) ──
  const toolDesc =
    showing?.kind === "tool" ? describeDetail(showing.block) : null;

  let nativeNode: ReactNode = null;
  if (showing?.kind === "tool") {
    if (toolDesc?.mode === "native") nativeNode = toolDesc.node;
  } else if (showing?.kind === "gitDiff") {
    if (diffQuery.isError) {
      nativeNode = <DiffNote text="Couldn't load the diff." />;
    } else if (diffData?.isRepo === false) {
      nativeNode = <DiffNote text="Not a git repository." />;
    } else if (diffData && diffData.diff === "") {
      nativeNode = <DiffNote text="No changes." />;
    } else if (!diffReady) {
      nativeNode = <DiffNote text="Loading diff…" spinner />;
    }
  }
  // The resident webview is ALWAYS laid out — never display:none. A native body
  // hides it by overlaying an opaque cover (below), NOT by un-laying-it-out.
  // Reason: a display:none → flex toggle makes WKWebView reveal its last
  // *composited* frame (e.g. the startup WARMUP `// warm`) and skip recompositing
  // the freshly-swapped payload until a forced relayout — so opening a webview
  // tool right after a native one showed stale `// warm` until the sheet closed
  // (close scrolls via the `collapsed` effect, which forces the recomposite).
  // Keeping it permanently laid out removes that transition entirely.

  const surface = (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: scheme === "dark" ? "#000000" : "#ffffff",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          borderCurve: "continuous",
        },
      ]}
    />
  );

  return (
    <ToolCallSheetContext.Provider value={value}>
      {children}
      {/* Renders into the root BottomSheetProvider's portal (app/_layout.tsx),
          which sits above the navigator so the sheet + scrim cover the native
          header. Do NOT wrap a second BottomSheetProvider here — the nearest
          one wins, and a screen-level host renders below the nav bar again. */}
      <ModalBottomSheet
        index={index}
        detents={detents}
        onIndexChange={setIndex}
        scrimColor="#000000"
        scrimOpacities={SCRIM_OPACITIES}
        surface={surface}
      >
        {/* Grabber affordance (the native sheet draws none). */}
        <View className="items-center pt-1">
          <View className="h-1 w-9 rounded-full bg-gray-300 dark:bg-gray-700" />
        </View>
        <View className="flex-row items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          {showing?.kind === "tool" ? (
            // Same `<verb> <summary>` line as the transcript row (ToolBlock),
            // so the sheet header reads as a continuation of the tapped row.
            <Text
              numberOfLines={1}
              className="flex-1 text-base text-gray-700 dark:text-gray-300"
            >
              <Text
                className={
                  showing.block.status === "failed"
                    ? "text-red-600 dark:text-red-400"
                    : "text-gray-500 dark:text-gray-400"
                }
              >
                {toolVerb(showing.block.detail)}
              </Text>
              {showing.block.summary ? ` ${showing.block.summary}` : ""}
            </Text>
          ) : showing?.kind === "gitDiff" ? (
            <Text
              numberOfLines={1}
              className="flex-1 text-base font-medium text-gray-800 dark:text-gray-200"
            >
              {diffData
                ? `${diffData.fileCount} ${
                    diffData.fileCount === 1 ? "file" : "files"
                  } changed${diffData.truncated ? " (truncated)" : ""}`
                : "Working tree"}
            </Text>
          ) : (
            <View className="flex-1" />
          )}
        </View>

        <View className="flex-1">
          {/* Resident webview — stays mounted/warm + ALWAYS laid out. A native
              body or the gitDiff loader hides it by overlaying an opaque cover
              (below), never via display:none (see the note above). */}
          <View style={{ flex: 1 }}>
            <PierreView
              kind={webview.kind}
              content={encodeURIComponent(webview.content)}
              name={webview.name}
              disableFileHeader={webview.noHeader}
              disableLineNumbers={webview.noLineNumbers}
              scheme={scheme}
              onReady={onReady}
              collapsed={index === 0}
              bottomInset={insets.bottom}
              workerUri={WORKER_ASSET_URI}
              dom={{
                matchContents: false,
                scrollEnabled: true,
                // Hide native WKWebView scroll indicators (CSS
                // ::-webkit-scrollbar can't touch the iOS document indicator).
                showsVerticalScrollIndicator: false,
                showsHorizontalScrollIndicator: false,
                style: { flex: 1, backgroundColor: "transparent" },
                contentInsetAdjustmentBehavior: "never",
                automaticallyAdjustContentInsets: false,
              }}
            />
          </View>
          {/* Opaque overlay ON TOP of the webview — covers it for loading /
              empty / error / tool-native (so a painting webview behind isn't
              seen). Same color as `surface`. */}
          {nativeNode !== null ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: scheme === "dark" ? "#000000" : "#ffffff",
                },
              ]}
            >
              <ScrollView contentContainerStyle={NATIVE_CONTENT}>
                {nativeNode}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </ModalBottomSheet>
    </ToolCallSheetContext.Provider>
  );
}

/** Small native status line for the sheet body (loading / empty / error). */
function DiffNote({ text, spinner }: { text: string; spinner?: boolean }) {
  return (
    <View className="flex-row items-center gap-2 py-2">
      {spinner ? <ActivityIndicator /> : null}
      <Text className="text-sm text-gray-500 dark:text-gray-400">{text}</Text>
    </View>
  );
}

const NATIVE_CONTENT = { padding: 16, paddingBottom: 48 } as const;

// ─── Detail → render descriptor ────────────────────────────────────────────

type Descriptor =
  | {
      mode: "webview";
      kind: "diff" | "code";
      content: string;
      name?: string;
      /** Plain command/search output (bash, grep, glob): hide the filename
       *  header AND the line-number gutter — it's not source/line-addressable. */
      noHeader?: boolean;
      noLineNumbers?: boolean;
    }
  | { mode: "native"; node: ReactNode };

/**
 * Map a tool block to how its body renders. Diffs and code-shaped output
 * (bash/read/grep/glob/monitor) go to the Pierre webview; everything else —
 * errors, empty output, markdown-bearing tools (web_fetch/agent via
 * ChunkedMarkdown), field-shaped tools (tasks, schedule_wakeup, ask_user),
 * and `unknown` — renders natively inside the sheet's ScrollView.
 */
function describeDetail(block: ToolRenderBlock): Descriptor {
  const isError = block.status === "failed";
  const { detail, error } = block;
  switch (detail.type) {
    case "bash": {
      // Command (with `$ `/`> ` prefixes) + captured output, like Claude Desktop.
      const body = formatBashBody(detail.command, detail.output);
      return body.length === 0
        ? NATIVE_EMPTY
        : {
            mode: "webview",
            kind: "code",
            content: body,
            name: "command.sh",
            noHeader: true,
            noLineNumbers: true,
          };
    }
    case "edit":
    case "write": {
      // Failed Edit/Write: the unified diff was computed from input and never
      // applied — show the error, not a diff that implies a successful change.
      if (isError) return errorNative(error ?? "Tool failed.");
      return detail.unifiedDiff.length === 0
        ? NATIVE_EMPTY
        : { mode: "webview", kind: "diff", content: detail.unifiedDiff };
    }
    case "read": {
      if (isError) return errorNative(error ?? "Read failed.");
      return detail.content.length === 0
        ? NATIVE_EMPTY
        : {
            mode: "webview",
            kind: "code",
            content: detail.content,
            name: basename(detail.filePath),
          };
    }
    case "grep":
    case "glob":
      if (isError) return errorNative(error ?? "Tool failed.");
      return detail.output.length === 0
        ? NATIVE_EMPTY
        : {
            mode: "webview",
            kind: "code",
            content: detail.output,
            name: "results.txt",
            noHeader: true,
            noLineNumbers: true,
          };
    case "web_search":
      // Result list (title + URL per line) — plain native text, no need
      // for the webview's tokenizer or horizontal code scroll.
      if (isError) return errorNative(error ?? "Search failed.");
      return detail.output.length === 0
        ? NATIVE_EMPTY
        : { mode: "native", node: <FieldText>{detail.output}</FieldText> };
    case "monitor": {
      // Monitor is a watch command — same command+output body as Bash.
      const body = formatBashBody(detail.command, detail.output);
      return body.length === 0
        ? NATIVE_EMPTY
        : {
            mode: "webview",
            kind: "code",
            content: body,
            name: "command.sh",
            noHeader: true,
            noLineNumbers: true,
          };
    }
    case "web_fetch":
      if (isError) return errorNative(error ?? "Fetch failed.");
      return { mode: "native", node: <WebFetchDetail detail={detail} /> };
    case "agent":
      if (isError) return errorNative(error ?? "Agent failed.");
      return { mode: "native", node: <AgentDetail detail={detail} /> };
    case "ask_user":
      return { mode: "native", node: <AskUserDetail detail={detail} /> };
    case "task_create":
      return labeledFields([
        ["Subject", detail.subject],
        ["Description", detail.description],
        ["Active form", detail.activeForm],
        ["Task ID", detail.taskId ? `#${detail.taskId}` : undefined],
      ]);
    case "task_update":
      return labeledFields([
        ["Task ID", `#${detail.taskId}`],
        ["Status", detail.status],
        ["Active form", detail.activeForm],
      ]);
    case "task_stop":
      return labeledFields([["Task ID", `#${detail.taskId}`]]);
    case "schedule_wakeup":
      return labeledFields([
        ["Delay", `${detail.delaySeconds}s`],
        ["Reason", detail.reason],
        ["Prompt", detail.prompt],
      ]);
    case "unknown":
      return {
        mode: "native",
        node: <UnknownDetail detail={detail} isError={isError} error={error} />,
      };
  }
}

const NATIVE_EMPTY: Descriptor = { mode: "native", node: <EmptyOutput /> };

function errorNative(text: string): Descriptor {
  return { mode: "native", node: <ErrorBanner text={text} /> };
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

// ─── Native bodies ─────────────────────────────────────────────────────────

function EmptyOutput() {
  return (
    <Text className="text-xs italic text-gray-500 dark:text-gray-400">
      (no output)
    </Text>
  );
}

function ErrorBanner({ text }: { text: string }) {
  return (
    <View className="rounded border border-red-300 bg-red-50 p-2 dark:border-red-800 dark:bg-red-950">
      <Text selectable className="text-xs text-red-700 dark:text-red-300">
        {text}
      </Text>
    </View>
  );
}

function UnknownDetail({
  detail,
  isError,
  error,
}: {
  detail: Extract<ToolCallDetail, { type: "unknown" }>;
  isError: boolean;
  error: string | null;
}) {
  const inputJson = prettyJson(detail.input);
  const hasOutput = detail.output.length > 0;
  // For unknown tools we don't know whether the diagnostic lives in `output`
  // or only in `error` — surface the error banner only when output is empty.
  const showErrorBanner = isError && !hasOutput;
  return (
    <View>
      {showErrorBanner ? (
        <View className="mb-3">
          <ErrorBanner text={error ?? "Tool failed."} />
        </View>
      ) : null}
      <SectionLabel>Input</SectionLabel>
      <Text
        selectable
        className="rounded bg-gray-100 p-2 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100"
      >
        {inputJson}
      </Text>
      {hasOutput ? (
        <View className="mt-3">
          <SectionLabel error={isError}>Output</SectionLabel>
          <Text
            selectable
            className="rounded bg-gray-100 p-2 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100"
          >
            {detail.output}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Monospace-ish selectable text block, same chrome as UnknownDetail input. */
function FieldText({ children }: { children: string }) {
  return (
    <Text
      selectable
      className="rounded bg-gray-100 p-2 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100"
    >
      {children}
    </Text>
  );
}

/** Labeled-fields native body; skips empty/undefined values. */
function labeledFields(
  fields: Array<[label: string, value: string | undefined]>,
): Descriptor {
  const visible = fields.filter(
    (f): f is [string, string] => f[1] !== undefined && f[1].length > 0,
  );
  if (visible.length === 0) return NATIVE_EMPTY;
  return {
    mode: "native",
    node: (
      <View>
        {visible.map(([label, value], i) => (
          <View key={label} className={i > 0 ? "mt-3" : undefined}>
            <SectionLabel>{label}</SectionLabel>
            <FieldText>{value}</FieldText>
          </View>
        ))}
      </View>
    ),
  };
}

function WebFetchDetail({
  detail,
}: {
  detail: Extract<ToolCallDetail, { type: "web_fetch" }>;
}) {
  return (
    <View>
      <SectionLabel>URL</SectionLabel>
      <FieldText>{detail.url}</FieldText>
      <View className="mt-3">
        <SectionLabel>Prompt</SectionLabel>
        <FieldText>{detail.prompt}</FieldText>
      </View>
      <View className="mt-3">
        <SectionLabel>Output</SectionLabel>
        {/* WebFetch output is the fetch-side model's prose summary —
            markdown, not raw page text. Render it like chat. */}
        {detail.output.length > 0 ? (
          <ChunkedMarkdown markdown={detail.output} streamDone />
        ) : (
          <EmptyOutput />
        )}
      </View>
    </View>
  );
}

function AgentDetail({
  detail,
}: {
  detail: Extract<ToolCallDetail, { type: "agent" }>;
}) {
  return (
    <View>
      <SectionLabel>Prompt</SectionLabel>
      <FieldText>{detail.prompt}</FieldText>
      <View className="mt-3">
        <SectionLabel>Output</SectionLabel>
        {/* The subagent's final text — markdown prose, render like chat.
            Its intermediate tool calls live in the subagent JSONL and are
            not surfaced here (V0.5+ Background Tasks panel). */}
        {detail.output.length > 0 ? (
          <ChunkedMarkdown markdown={detail.output} streamDone />
        ) : (
          <EmptyOutput />
        )}
      </View>
    </View>
  );
}

function AskUserDetail({
  detail,
}: {
  detail: Extract<ToolCallDetail, { type: "ask_user" }>;
}) {
  return (
    <View>
      {detail.questions.map((q, i) => (
        <View key={i} className={i > 0 ? "mt-3" : undefined}>
          <SectionLabel>{q.header || `Question ${i + 1}`}</SectionLabel>
          <Text
            selectable
            className="mb-1 text-sm text-gray-900 dark:text-gray-100"
          >
            {q.question}
          </Text>
          <Text className="text-sm text-gray-500 dark:text-gray-400">
            {detail.answers?.[i]
              ? `Answered: ${detail.answers[i]}`
              : "(unanswered)"}
          </Text>
        </View>
      ))}
    </View>
  );
}

function SectionLabel({
  children,
  error,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <Text
      className={`mb-1 text-[10px] font-medium uppercase tracking-wider ${
        error
          ? "text-red-600 dark:text-red-400"
          : "text-gray-500 dark:text-gray-400"
      }`}
    >
      {children}
    </Text>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Compose a Bash detail body the way Claude Desktop does: the command prefixed
 * with `$ ` (continuation lines with `> ` like an interactive shell), then the
 * captured output below. We always show the command — even when output is empty
 * — so a Bash invocation stays visible after its expected silence (`cd`, etc.).
 */
function formatBashBody(command: string, output: string): string {
  const cmdLines = command.split("\n");
  const cmdFormatted = cmdLines
    .map((line, i) => (i === 0 ? `$ ${line}` : `> ${line}`))
    .join("\n");
  return output.length > 0 ? `${cmdFormatted}\n${output}` : cmdFormatted;
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
