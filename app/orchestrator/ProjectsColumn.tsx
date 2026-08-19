"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { jget } from "./api";
import { fmtCost, relTime } from "./format";
import { SEARCH_MIN, type AgentInfo, type ProjectRow } from "./types";
import { SearchBar, HoverCard, useHoverCard } from "./shared";
import { subscribeGlobalEvents } from "./sharedEvents";

// One project row, its hover card, and the drag-reorder wiring, split out so
// the hover state (useHoverCard) is scoped per row instead of per column.
function ProjectRowItem({ p, selId, running, dragId, overId, onSelect, onDragStart, onDragOver, onDrop, onDragEnd }: {
  p: ProjectRow; selId: string | null; running: Set<string>;
  dragId: string | null; overId: string | null;
  onSelect: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const hover = useHoverCard();
  const isRunning = running.has(p.id);
  return (
    <>
      <button
        ref={anchorRef}
        className={`proj ${p.id === selId ? "sel" : ""} ${dragId === p.id ? "dragging" : ""} ${overId === p.id && dragId && dragId !== p.id ? "drag-over" : ""}`}
        onClick={onSelect}
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onMouseEnter={hover.scheduleOpen}
        onMouseLeave={hover.scheduleClose}
        title="Drag to reorder"
      >
        <div className="pic" style={{ background: p.color }}>
          {p.name[0]}
          {p.awaiting_count > 0 ? (
            <span className="proj-await" title={`${p.awaiting_count} task${p.awaiting_count !== 1 ? "s" : ""} waiting on your input`}>{p.awaiting_count}</span>
          ) : isRunning ? (
            <span className="proj-running" title="A task is running in this project" />
          ) : null}
        </div>
        <div className="pmeta">
          <div className="pname">{p.name}</div>
          <div className="psub">
            {p.task_count} task{p.task_count !== 1 ? "s" : ""}{p.sub ? ` · ${p.sub}` : ""}
            {p.cost_usd > 0 && <span className="psub-cost" title="Total spend across this project's tasks"> · {fmtCost(p.cost_usd)}</span>}
          </div>
        </div>
        <div className="pcount" title={p.last_activity ? `Last touched ${relTime(p.last_activity)}` : "Never touched"}>
          {p.last_activity ? relTime(p.last_activity) : "never"}
        </div>
      </button>
      <HoverCard
        open={hover.open}
        anchorRef={anchorRef}
        copyValue={p.repo_path}
        onEnter={hover.scheduleOpen}
        onLeave={hover.scheduleClose}
        onClose={hover.closeNow}
        content={
          <div className="hc-project">
            <div className="hc-title">{p.name}</div>
            <div className="hc-path">{p.repo_path}</div>
            <div className="hc-statuses">
              <div className="hc-status-row">
                <span className={`ldot ${p.awaiting_count > 0 ? "awaiting" : ""}`} style={p.awaiting_count > 0 ? undefined : { background: "var(--ink-3)" }} />
                <span>{p.awaiting_count} waiting on you</span>
              </div>
              <div className="hc-status-row">
                <span className={`ldot ${isRunning ? "running" : ""}`} style={isRunning ? undefined : { background: "var(--ink-3)" }} />
                <span>{isRunning ? "1 task running" : "0 tasks running"}</span>
              </div>
            </div>
          </div>
        }
      />
    </>
  );
}

// The "Recent" rail view: every real task across all active projects, most
// recently touched first — a cross-project "jump back in" list. Data is the
// same lite query that powers the ⌘K palette (GET /api/tasks); it refreshes
// off the shared global-events stream (no polling), debounced because one
// turn boundary can emit several lifecycle events back to back.
interface RecentTask {
  id: string;
  project_id: string;
  title: string;
  status: string;
  running: number;
  awaiting_input: number;
  updated_at: number;
  project_name: string;
  project_color: string;
  project_icon: string;
}

const RECENT_LIMIT = 25;

function RecentList({ selId, onGoToTask }: { selId: string | null; onGoToTask: (projectId: string, taskId: string) => void }) {
  const [tasks, setTasks] = useState<RecentTask[] | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const { tasks } = await jget<{ tasks: RecentTask[] }>("/api/tasks");
        if (alive) setTasks(tasks.slice(0, RECENT_LIMIT));
      } catch { /* transient — the next event retries */ }
    };
    void load();
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 400);
    };
    const off = subscribeGlobalEvents({
      onEvent: (ev) => { if (ev.type === "task" || ev.type === "task_deleted") bump(); },
      onCatchUp: bump,
    });
    return () => { alive = false; if (timer) clearTimeout(timer); off(); };
  }, []);
  if (tasks === null) return <div className="search-empty">Loading…</div>;
  if (tasks.length === 0) return <div className="search-empty">No sessions yet.</div>;
  return (
    <>
      {tasks.map((t) => (
        <button key={t.id} className={`proj ${t.project_id === selId ? "sel" : ""}`}
          onClick={() => onGoToTask(t.project_id, t.id)}
          title={`${t.project_name} — open this session`}>
          <div className="pic" style={{ background: t.project_color }}>
            {t.project_icon || t.project_name[0]}
            {t.awaiting_input ? (
              <span className="proj-await" title="Waiting on your input">!</span>
            ) : t.running ? (
              <span className="proj-running" title="Running" />
            ) : null}
          </div>
          <div className="pmeta">
            <div className="pname">{t.title}</div>
            <div className="psub">{t.project_name}</div>
          </div>
          <div className="pcount" title={`Last touched ${relTime(t.updated_at)}`}>{relTime(t.updated_at)}</div>
        </button>
      ))}
    </>
  );
}

// Footer line under "Your workspace": the real auth state per connected agent,
// from GET /api/agents (which reports the EFFECTIVE billing credential — an
// active API key outranks a stored subscription login; see issue #4).
function agentAuthLine(agents: AgentInfo[]): string {
  const parts = agents
    .filter((a) => a.authenticated)
    .map((a) =>
      a.account?.method === "api_key" ? `${a.label} · API key` : `${a.label} · ${a.account?.plan ? `${a.account.plan} login` : "subscription"}`,
    );
  return parts.length ? parts.join(", ") : "No agent connected";
}

export function ProjectsColumn({ projects, deprecated, agents, selId, running, width, onSelect, onGoToTask, onNew, onOpenAppearance, onReorder, onRestore, onCollapse, settingsActive, onOpenSettings, mobile }: {
  // Project ids with at least one task currently running (see the statusLadder
  // rollup, fed by useOrchestrator's runningByProject) — NOT task ids. A
  // project row's own status ladder: the amber "N waiting" badge always wins
  // (a project with a running task can still separately have one waiting on
  // you), a blue dot shows otherwise, idle shows nothing.
  projects: ProjectRow[]; deprecated: ProjectRow[]; agents: AgentInfo[]; selId: string | null; running: Set<string>; width: number;
  onSelect: (id: string) => void; onGoToTask: (projectId: string, taskId: string) => void; onNew: () => void; onOpenAppearance: () => void;
  onReorder: (ids: string[]) => void; onRestore: (id: string) => void; onCollapse: () => void;
  settingsActive: boolean; onOpenSettings: () => void; mobile?: boolean;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [showDeprecated, setShowDeprecated] = useState(false);
  // Rail view: grouped by project (default) or a flat most-recent-sessions
  // list across all projects. Sticky per browser.
  const [railView, setRailView] = useState<"projects" | "recent">(() => {
    if (typeof window !== "undefined" && localStorage.getItem("orch_rail_view") === "recent") return "recent";
    return "projects";
  });
  const pickRailView = (v: "projects" | "recent") => { setRailView(v); localStorage.setItem("orch_rail_view", v); };
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? projects.filter((p) => p.name.toLowerCase().includes(q) || (p.sub ?? "").toLowerCase().includes(q)) : projects;

  const drop = (targetId: string) => {
    if (dragId && dragId !== targetId) {
      const ids = projects.map((p) => p.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from !== -1 && to !== -1) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        onReorder(ids);
      }
    }
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className="col col-projects" style={{ flexBasis: width }}>
      <div className="col-head">
        <span className="ch-title">Projects</span>
        <span className="spacer" />
        <button className="icon-btn" title="Appearance" onClick={onOpenAppearance}>{Icon.sliders()}</button>
        <button className="icon-btn" title="New project" onClick={onNew}>{Icon.plus()}</button>
        {!mobile && <button className="icon-btn" title="Hide projects panel" onClick={onCollapse}>{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
      </div>
      <div className="seg" style={{ margin: "0 10px 8px" }}>
        <button className={railView === "projects" ? "on" : ""} onClick={() => pickRailView("projects")} title="Group by project">Projects</button>
        <button className={railView === "recent" ? "on" : ""} onClick={() => pickRailView("recent")} title="Most recently active sessions across all projects">Recent</button>
      </div>
      {railView === "projects" && projects.length >= SEARCH_MIN && <SearchBar value={query} onChange={setQuery} placeholder="Search projects…" />}
      <div className="scroll">
        <div className="proj-list">
          {railView === "recent" && <RecentList selId={selId} onGoToTask={onGoToTask} />}
          {railView === "projects" && shown.map((p) => (
            <ProjectRowItem
              key={p.id}
              p={p}
              selId={selId}
              running={running}
              dragId={dragId}
              overId={overId}
              onSelect={() => onSelect(p.id)}
              onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragId) setOverId(p.id); }}
              onDrop={(e) => { e.preventDefault(); drop(p.id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
            />
          ))}
          {railView === "projects" && q && shown.length === 0 && <div className="search-empty">No projects match “{query.trim()}”.</div>}
          {railView === "projects" && !q && (
          <button className="proj" style={{ color: "var(--ink-3)" }} onClick={onNew}>
            <div className="pic" style={{ background: "var(--surface-2)", color: "var(--ink-3)", boxShadow: "inset 0 0 0 1px var(--line-2)" }}>{Icon.plus()}</div>
            <div className="pmeta"><div className="pname" style={{ fontWeight: 600, color: "var(--ink-3)" }}>New project</div></div>
          </button>
          )}

          {railView === "projects" && !q && deprecated.length > 0 && (
            <div className="dep-area">
              <button className="dep-head" onClick={() => setShowDeprecated((s) => !s)} title="Projects you've set aside. Restore one to build on it again.">
                <span className={`dep-chev ${showDeprecated ? "open" : ""}`}>{Icon.chevRight()}</span>
                {Icon.archive()}
                <span className="dep-title">Deprecated</span>
                <span className="dep-count">{deprecated.length}</span>
              </button>
              {showDeprecated && deprecated.map((p) => (
                <div key={p.id} className="proj dep" title={`${p.name} — deprecated. Restore to continue building on it.`}>
                  <div className="pic" style={{ background: p.color }}>{p.name[0]}</div>
                  <div className="pmeta">
                    <div className="pname">{p.name}</div>
                    <div className="psub">{p.task_count} task{p.task_count !== 1 ? "s" : ""}{p.sub ? ` · ${p.sub}` : ""}</div>
                  </div>
                  <button className="icon-btn" title={`Restore ${p.name}`} onClick={() => onRestore(p.id)}>{Icon.restore()}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="proj-foot">
        <a className="nav-item" href="/artifacts" title="Published files from every project">
          {Icon.archive()} Artifacts
        </a>
        <button className={`nav-item${settingsActive ? " active" : ""}`} onClick={onOpenSettings} title="App settings">
          {Icon.gear()} Settings
        </button>
        <div className="user-chip">
          <div className="av">{Icon.bolt()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="un">Your workspace</div>
            <div className="ue">{agentAuthLine(agents)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
