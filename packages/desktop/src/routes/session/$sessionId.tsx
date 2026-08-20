import { ChatComposer, ChatComposerInput } from "@astryxdesign/core/Chat";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { Text } from "@astryxdesign/core/Text";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@astryxdesign/core/ToggleButton";
import {
  CheckIcon,
  CommandLineIcon,
  DocumentPlusIcon,
} from "@heroicons/react/24/outline";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { MODELS, prettyModel } from "@thinkite/protocol";
import { useState } from "react";
import { DiffPanel } from "../../components/DiffPanel";
import { TerminalPane } from "../../components/TerminalPane";
import { TranscriptPanel } from "../../components/TranscriptPanel";
import { daemonRpc } from "../../lib/daemon-rpc";
import { sessionStateCollection } from "../../lib/sessions-collection";
import { sendUserMessage } from "../../lib/transcript-collections";

// Session screen: transcript center column with a live composer (daemon
// sendPrompt over /rpc), and an
// IntelliJ-style tool-window strip on the right edge — a vertical toggle
// group that both picks the surface (terminal/diff) and closes the panel
// (ToggleButtonGroup single mode: clicking the active button deselects →
// null → closed). The strip stays visible when the panel is closed, so the
// affordance never disappears.
//
// `$sessionId` IS the Claude Code session uuid (cliSessionId) — the
// collection key, aligned with the iOS routes. The loader gates on the
// collection's first snapshot; a stale link bounces to the landing page.
// The component then reads the LIVE row so title / activity keep updating
// while the screen is open.
export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params }) => {
    await sessionStateCollection.preload();
    if (sessionStateCollection.get(params.sessionId) === undefined) {
      throw redirect({ to: "/" });
    }
  },
  component: SessionRoute,
});

type Surface = "terminal" | "diff";

// Tool-panel UI state is PER SESSION, in memory (the t3code drawer pattern:
// per-thread height/open state, reset on app restart). Keying the Session
// component on the id makes every useState below per-session for free; these
// maps carry the state across remounts within one app run.
const surfaceBySession = new Map<string, Surface | null>();
const panelSizeBySession = new Map<string, number>();

function SessionRoute() {
  const { sessionId } = Route.useParams();
  return <Session key={sessionId} sessionId={sessionId} />;
}

function Session({ sessionId }: { sessionId: string }) {
  const { data: rows } = useLiveQuery(
    (q) =>
      q
        .from({ s: sessionStateCollection })
        .where(({ s }) => eq(s.cliSessionId, sessionId)),
    [sessionId],
  );
  const session = rows[0];
  // `has` not `??`: null is a real remembered value ("closed"), which `??`
  // would silently swallow. Default for an unvisited session: closed.
  const [surface, setSurface] = useState<Surface | null>(() =>
    surfaceBySession.has(sessionId)
      ? (surfaceBySession.get(sessionId) as Surface | null)
      : null,
  );
  // Both surfaces mount on FIRST VISIT and stay mounted (t3code's drawer
  // pattern: `return null` until terminalOpen). For the terminal that
  // structural gate IS the lazy attach — an unopened panel never mounts,
  // never connects, never spawns a shell; after first open it stays mounted
  // so closing the panel keeps the xterm buffer instead of re-replaying
  // the scrollback ring.
  const [diffVisited, setDiffVisited] = useState(surface === "diff");
  const [terminalVisited, setTerminalVisited] = useState(
    surface === "terminal",
  );

  const rightPanel = useResizable({
    defaultSize: panelSizeBySession.get(sessionId) ?? 560,
    minSizePx: 320,
    onSizeChange: (size) => panelSizeBySession.set(sessionId, size),
  });

  // Composer → optimistic send (transcript-collections.ts): the user
  // bubble paints synchronously via the collection's optimistic overlay
  // under a client-minted uuid; the daemon's synthesized append (same
  // uuid) lands on it seamlessly through the subscribe stream. A rejected
  // send auto-rolls the bubble back — here we just restore the draft and
  // surface the error in the composer's status slot.
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // The just-sent prompt's uuid — TranscriptPanel pins that row near the top
  // while the reply streams below it (anchoredEndSpace). iOS ChatPanel
  // lifecycle: kept across turns (clearing collapses the reserved space and
  // jumps the viewport), replaced by the next send, reset with the
  // per-session remount; only a failed send rolls it back.
  const [anchorUuid, setAnchorUuid] = useState<string | null>(null);

  const submit = (value: string) => {
    const text = value.trim();
    if (text === "" || session === undefined) return;
    setDraft("");
    setSendError(null);
    const userMessageUuid = crypto.randomUUID();
    setAnchorUuid(userMessageUuid);
    const tx = sendUserMessage({
      cliSessionId: sessionId,
      userMessageUuid,
      text,
      cwd: session.cwd,
      model: currentModel ?? undefined,
    });
    void tx.isPersisted.promise.catch((err: unknown) => {
      setDraft(value);
      setAnchorUuid((cur) => (cur === userMessageUuid ? null : cur));
      setSendError(err instanceof Error ? err.message : String(err));
    });
  };

  const stop = () => {
    void daemonRpc.interrupt(sessionId).catch((err) => {
      setSendError(err instanceof Error ? err.message : String(err));
    });
  };

  // Model picker (official astryx pattern: DropdownMenu in footerActions,
  // like the ai-chat template's mode picker). Selection commits at PICK
  // time via setSessionSelection (daemon applies to the live query, then
  // persists) — sendPrompt also forwards it, matching iOS. The optimistic
  // value wins over the live row until the daemon's push catches up (they
  // converge to equal); a rejected commit rolls back to the previous pick.
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const currentModel = pickedModel ?? session?.model ?? null;

  const pickModel = (model: string) => {
    if (model === currentModel) return;
    const previous = pickedModel;
    setPickedModel(model);
    setSendError(null);
    void daemonRpc.setSessionSelection(sessionId, model).catch((err) => {
      setPickedModel(previous);
      setSendError(err instanceof Error ? err.message : String(err));
    });
  };

  const pick = (v: string | null) => {
    const s = v === "terminal" || v === "diff" ? v : null;
    setSurface(s);
    if (s === "diff") setDiffVisited(true);
    if (s === "terminal") setTerminalVisited(true);
    surfaceBySession.set(sessionId, s);
  };

  // Row deleted while the screen is open (daemon-side delete pushed a
  // session_state_removed) — nothing to render; the sidebar link is gone.
  if (session === undefined) return null;

  return (
    <Layout
      height="fill"
      content={
        <LayoutContent padding={0}>
          <div className="flex h-full min-h-0 flex-col">
            {/* Tailwind borders default to currentColor (near-black); pin
                them to the astryx token so they match component dividers. */}
            <div
              className="flex items-center gap-3 border-b px-4 py-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="flex min-w-0 items-baseline gap-3">
                <Heading level={5} maxLines={1}>
                  {session.title}
                </Heading>
                <Text size="sm" color="secondary" maxLines={1}>
                  {session.cwd}
                </Text>
              </div>
            </div>
            {/* Self-owned transcript shell: the LegendList inside
                TranscriptPanel is the single scroll writer (landing, follow,
                scroll button); the composer is a plain flex sibling — no
                ChatLayout, so nothing else ever touches scrollTop. The whole
                Session subtree remounts per session (SessionRoute key), so
                scroll position, the follow lock, and the draft never
                survive a switch (t3code resets on thread open too).
                Composer slots stay reserved for their rightful owners
                (headerContext = context usage, drawer = attachments); the
                git status bar will wrap this composer in a stack. */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="relative min-h-0 flex-1">
                <TranscriptPanel
                  claudeSessionId={sessionId}
                  isRunning={session.activity === "running"}
                  anchorUuid={anchorUuid}
                />
              </div>
              {/* Same max-w-3xl as the transcript's per-row column (t3code),
                  so the composer aligns with the message column. */}
              <div className="mx-auto w-full max-w-3xl shrink-0 pb-3">
                <ChatComposer
                  onSubmit={submit}
                  onStop={stop}
                  isStopShown={session.activity === "running"}
                  value={draft}
                  onChange={setDraft}
                  placeholder="Message Claude…"
                  status={
                    sendError
                      ? { type: "error", message: sendError }
                      : undefined
                  }
                  footerActions={
                    <DropdownMenu
                      button={{
                        label:
                          currentModel !== null
                            ? prettyModel(currentModel)
                            : "Model",
                        variant: "ghost",
                        size: "sm",
                      }}
                      items={MODELS.map((m) => ({
                        label: m.displayName,
                        // prettyModel-based match so a legacy `…[1m]` row id
                        // still checkmarks its bare entry.
                        icon:
                          currentModel !== null &&
                          prettyModel(currentModel) === m.displayName
                            ? CheckIcon
                            : undefined,
                        onClick: () => pickModel(m.model),
                      }))}
                    />
                  }
                  input={<ChatComposerInput />}
                />
              </div>
            </div>
          </div>
        </LayoutContent>
      }
      end={
        <>
          {surface !== null && (
            <ResizeHandle
              direction="horizontal"
              hasDivider
              isReversed
              isAlwaysVisible={false}
              resizable={rightPanel.props}
              label="Resize tool panel"
            />
          )}
          {/* Panel body — always mounted (terminal buffer), width-zeroed when
              closed. Plain div rather than LayoutPanel so closing doesn't
              unmount children. */}
          <div
            style={{
              width: surface === null ? 0 : rightPanel.size,
              flexShrink: 0,
              overflow: "hidden",
              height: "100%",
            }}
          >
            {terminalVisited ? (
              <div
                className={
                  surface === "terminal" ? "h-full min-h-0 p-2" : "hidden"
                }
              >
                <TerminalPane sessionId={sessionId} cwd={session.cwd} />
              </div>
            ) : null}
            {diffVisited ? (
              <div className={surface === "diff" ? "h-full min-h-0" : "hidden"}>
                <DiffPanel active={surface === "diff"} dir={session.cwd} />
              </div>
            ) : null}
          </div>
          {/* IntelliJ-style tool-window strip: always visible, single-select,
              re-click deselects → closes the panel. */}
          <div
            className="flex h-full shrink-0 flex-col items-center border-l px-1 py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            <ToggleButtonGroup
              label="Tool windows"
              orientation="vertical"
              size="lg"
              value={surface}
              onChange={pick}
            >
              <ToggleButton
                value="terminal"
                label="Terminal"
                isIconOnly
                tooltip="Terminal"
                icon={<Icon icon={CommandLineIcon} size="md" />}
              />
              <ToggleButton
                value="diff"
                label="Diff"
                isIconOnly
                tooltip="Diff"
                icon={<Icon icon={DocumentPlusIcon} size="md" />}
              />
            </ToggleButtonGroup>
          </div>
        </>
      }
    />
  );
}
