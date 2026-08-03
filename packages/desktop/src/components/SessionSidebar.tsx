import { Button } from "@astryxdesign/core/Button";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  type SessionRow,
  sessionStateCollection,
} from "../lib/sessions-collection";

// Global session sidebar (t3code-style, grouped by day instead of project).
// Rows come from the daemon's subscribeSessions push stream via the
// session-states collection — new sessions and activity flips appear live,
// no polling. The dot marks sessions Claude is actively working in.

function dayLabel(ts: number, now: Date): string {
  const d = new Date(ts);
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SessionSidebar() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const { data: sessions } = useLiveQuery((q) =>
    q
      .from({ s: sessionStateCollection })
      .orderBy(({ s }) => s.lastActivityAt, "desc"),
  );

  // Current session id, straight off the location — the sidebar sits outside
  // the route tree, so route params aren't available via useParams here.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const selectedId = pathname.match(/^\/session\/([^/]+)$/)?.[1];

  // Day groups, newest first (rows arrive sorted by lastActivityAt desc).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q),
        )
      : sessions;
    const now = new Date();
    const out: { label: string; rows: SessionRow[] }[] = [];
    for (const s of filtered) {
      const label = dayLabel(s.lastActivityAt, now);
      const last = out.at(-1);
      if (last?.label === label) last.rows.push(s);
      else out.push({ label, rows: [s] });
    }
    return out;
  }, [sessions, query]);

  return (
    <SideNav
      resizable={{ autoSaveId: "sidecode:sidebar-width" }}
      header={<SideNavHeading heading="thinkite" />}
      topContent={
        <div className="flex flex-col gap-2">
          <Button
            label="New session"
            variant="secondary"
            size="sm"
            icon={<PlusIcon />}
            style={{ width: "100%" }}
            onClick={() => void navigate({ to: "/" })}
          />
          <TextInput
            label="Search sessions"
            isLabelHidden
            placeholder="Search"
            size="sm"
            startIcon={MagnifyingGlassIcon}
            value={query}
            onChange={setQuery}
          />
        </div>
      }
    >
      {groups.length === 0 ? (
        <div className="px-3 py-2">
          <Text size="sm" color="secondary">
            {query ? "No matches." : "No sessions yet."}
          </Text>
        </div>
      ) : (
        groups.map((g) => (
          <SideNavSection key={g.label} title={g.label}>
            {g.rows.map((s) => (
              <SideNavItem
                key={s.cliSessionId}
                label={s.title}
                isSelected={s.cliSessionId === selectedId}
                onClick={() =>
                  void navigate({
                    to: "/session/$sessionId",
                    params: { sessionId: s.cliSessionId },
                  })
                }
                endContent={
                  s.activity === "running" ? (
                    <StatusDot variant="success" label="Claude running" />
                  ) : (
                    <Text size="xsm" color="secondary">
                      {timeLabel(s.lastActivityAt)}
                    </Text>
                  )
                }
              />
            ))}
          </SideNavSection>
        ))
      )}
    </SideNav>
  );
}
