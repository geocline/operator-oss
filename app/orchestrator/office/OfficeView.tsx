"use client";

// Office view — a visual floor of every live task, grouped into rooms by
// status/running/awaiting_input (tasks/todo.md "Decisions"). Mounted by
// app/Orchestrator.tsx the same way InsightsView is: a top-bar icon replaces
// the workspace with this view.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { jget } from "../api";
import { subscribeGlobalEvents } from "../sharedEvents";
import type { AgentsBundle } from "../types";
import "./office.css";
import { Avatar, ProjectBadge } from "./Avatar";
import { DetailPanel } from "./DetailPanel";
import { AlumniDrawer } from "./AlumniDrawer";
import { recipeFromSeed, type Recipe } from "./portraitArt";
import { RoomSkin } from "./skin/RoomSkin";
import { ROOM_LABEL, roomFor, type OfficePayload, type OfficeTask, type RoomId } from "./types";

const ROOM_ORDER: RoomId[] = ["reception", "bullpen", "breakroom", "warehouse"];
const REFETCH_DEBOUNCE_MS = 300;
const FILTER_STORAGE_KEY = "orch_office_project_filter";

function useNarrow(maxWidth: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [maxWidth]);
  return narrow;
}

/** Fetch GET /api/office/skin once on mount. Empty ORCH_OFFICE_SKIN_DIR (the
 * default) reports { enabled: false } and the Office view renders its plain
 * CSS rooms unchanged — this never retries or polls. */
function useOfficeSkinEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    jget<{ enabled: boolean }>("/api/office/skin")
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => setEnabled(false));
  }, []);
  return enabled;
}

/** Fetch GET /api/office, refetch (debounced) on global task lifecycle events
 * and on window focus. Never opens its own EventSource — subscribeGlobalEvents
 * shares the one connection the app already holds (sharedEvents.ts). */
function useOfficeData() {
  const [data, setData] = useState<OfficePayload | null>(null);
  const [error, setError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNow = useCallback(() => {
    jget<OfficePayload>("/api/office")
      .then((d) => { setData(d); setError(false); })
      .catch(() => setError(true));
  }, []);

  const scheduleRefetch = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fetchNow, REFETCH_DEBOUNCE_MS);
  }, [fetchNow]);

  useEffect(() => { fetchNow(); }, [fetchNow]);
  useEffect(() => subscribeGlobalEvents({ onEvent: () => scheduleRefetch(), onCatchUp: () => scheduleRefetch() }), [scheduleRefetch]);
  useEffect(() => {
    const onFocus = () => scheduleRefetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scheduleRefetch]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const patchLocal = useCallback((taskId: string, patch: Partial<Pick<OfficeTask, "display_name" | "avatar">>) => {
    setData((d) => (d ? { ...d, tasks: d.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) } : d));
  }, []);

  return { data, error, patchLocal };
}

function nameTag(t: OfficeTask): string {
  if (t.display_name) return t.display_name;
  return t.title.length > 16 ? `${t.title.slice(0, 15).trimEnd()}…` : t.title;
}

/** FLIP: when a task's room assignment changes, its avatar slot reparents in
 * the DOM (it moves from one room's list to another's). Plain CSS transitions
 * can't animate across that reparent, so on every render where room
 * assignments changed we measure the new rect, diff it against the last
 * measured rect, and animate the delta away with a transform. */
function useRoomFlip(slotRefs: React.MutableRefObject<Map<string, HTMLDivElement>>, signature: string) {
  const prevRects = useRef(new Map<string, DOMRect>());
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const newRects = new Map<string, DOMRect>();
    slotRefs.current.forEach((el, id) => newRects.set(id, el.getBoundingClientRect()));

    if (mounted.current && !document.hidden) {
      newRects.forEach((rect, id) => {
        const old = prevRects.current.get(id);
        const el = slotRefs.current.get(id);
        if (!old || !el) return;
        const dx = old.left - rect.left;
        const dy = old.top - rect.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        void el.offsetWidth; // force reflow so the jump-back applies before the transition
        requestAnimationFrame(() => {
          el.style.transition = "transform 600ms ease";
          el.style.transform = "";
        });
      });
    }
    prevRects.current = newRects;
    mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}

function AvatarSlot({
  task, projectName, slotRefs, onSelect, selected,
}: {
  task: OfficeTask;
  projectName: string;
  slotRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onSelect: (id: string) => void;
  selected: boolean;
}) {
  const recipe: Recipe = task.avatar ?? recipeFromSeed(task.id);
  const room = roomFor(task);
  const waiting = room === "breakroom" && task.awaiting_input === 1;
  const label = `${nameTag(task)} — ${task.title} (${ROOM_LABEL[room]}${waiting ? ", waiting on you" : ""})`;
  return (
    <div
      ref={(el) => { if (el) slotRefs.current.set(task.id, el); else slotRefs.current.delete(task.id); }}
      className={`ofc-slot${selected ? " selected" : ""}`}
    >
      <button className="ofc-slot-btn" onClick={() => onSelect(task.id)} aria-label={label} title={task.title}>
        <Avatar recipe={recipe} walking={room === "bullpen"} />
        {waiting && <span className="ofc-waiting-badge" title="Waiting on you">!</span>}
      </button>
      <div className="ofc-nametag">
        <ProjectBadge id={task.project_id} name={projectName || task.project_id} />
        <span className="ofc-nametag-text" title={task.title}>{nameTag(task)}</span>
      </div>
    </div>
  );
}

function Room({
  id, tasks, projectNames, slotRefs, onSelect, selectedId, skinned,
}: {
  id: RoomId;
  tasks: OfficeTask[];
  projectNames: Map<string, string>;
  slotRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onSelect: (id: string) => void;
  selectedId: string | null;
  skinned: boolean;
}) {
  return (
    <section className={`ofc-room ofc-room-${id}`} role="region" aria-label={ROOM_LABEL[id]}>
      <div className="ofc-plaque">{ROOM_LABEL[id]}<span className="ofc-room-count">{tasks.length}</span></div>
      <div className="ofc-room-floor">
        {skinned && <RoomSkin room={id} />}
        {tasks.length === 0 ? (
          <div className="ofc-room-empty">Empty</div>
        ) : (
          tasks.map((t) => (
            <AvatarSlot
              key={t.id}
              task={t}
              projectName={projectNames.get(t.project_id) ?? ""}
              slotRefs={slotRefs}
              onSelect={onSelect}
              selected={t.id === selectedId}
            />
          ))
        )}
      </div>
    </section>
  );
}

export function OfficeView({
  agents, onGoToTask, onClose,
}: {
  agents: AgentsBundle;
  onGoToTask: (projectId: string, taskId: string) => void;
  onClose: () => void;
}) {
  const { data, error, patchLocal } = useOfficeData();
  const skinEnabled = useOfficeSkinEnabled();
  const narrow = useNarrow(768);
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const slotRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    try { const saved = localStorage.getItem(FILTER_STORAGE_KEY); if (saved) setProjectFilter(saved); } catch { /* ignore */ }
  }, []);
  const setFilter = (id: string) => {
    setProjectFilter(id);
    try { localStorage.setItem(FILTER_STORAGE_KEY, id); } catch { /* ignore */ }
  };

  const projectNames = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p.name])), [data]);
  const visibleTasks = useMemo(() => {
    const all = data?.tasks ?? [];
    return projectFilter === "all" ? all : all.filter((t) => t.project_id === projectFilter);
  }, [data, projectFilter]);

  const byRoom = useMemo(() => {
    const m: Record<RoomId, OfficeTask[]> = { reception: [], bullpen: [], breakroom: [], warehouse: [] };
    for (const t of visibleTasks) m[roomFor(t)].push(t);
    return m;
  }, [visibleTasks]);

  const roomSignature = useMemo(() => visibleTasks.map((t) => `${t.id}:${roomFor(t)}`).sort().join(","), [visibleTasks]);
  useRoomFlip(slotRefs, roomSignature);

  // Pause CSS idle-bob animations while the tab is hidden (the walking rAF
  // loop already checks document.hidden itself).
  const floorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = floorRef.current;
    if (!el) return;
    const sync = () => el.classList.toggle("paused", document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const selectedTask = selectedId ? (data?.tasks.find((t) => t.id === selectedId) ?? null) : null;

  const goToTask = (projectId: string, taskId: string) => { setSelectedId(null); onGoToTask(projectId, taskId); };

  return (
    <div className="ofc-view">
      <div className="ofc-header">
        <div className="ofc-title">Office</div>
        <div className="ofc-switcher" role="tablist" aria-label="Filter by project">
          <button className={`ofc-chip${projectFilter === "all" ? " on" : ""}`} onClick={() => setFilter("all")} role="tab" aria-selected={projectFilter === "all"}>
            All projects
          </button>
          {(data?.projects ?? []).map((p) => (
            <button key={p.id} className={`ofc-chip${projectFilter === p.id ? " on" : ""}`} onClick={() => setFilter(p.id)} role="tab" aria-selected={projectFilter === p.id}>
              {p.name}
            </button>
          ))}
        </div>
        <button className="icon-btn ofc-close" onClick={onClose} aria-label="Close office view" title="Close">×</button>
      </div>

      {error && !data ? (
        <div className="empty" style={{ margin: "auto" }}>
          <div className="e-t">Couldn&apos;t reach the office</div>
          <div className="e-s">GET /api/office isn&apos;t answering yet — it may still be landing.</div>
        </div>
      ) : data && visibleTasks.length === 0 ? (
        <div className="empty" style={{ margin: "auto" }}>
          <div className="e-t">The office is empty.</div>
          <div className="e-s">Start a task and someone will show up at Reception.</div>
        </div>
      ) : (
        <div ref={floorRef} className={`ofc-floor${narrow ? " narrow" : ""}${skinEnabled ? " ofc-skinned" : ""}`}>
          {ROOM_ORDER.map((id) => (
            <Room key={id} id={id} tasks={byRoom[id]} projectNames={projectNames} slotRefs={slotRefs} onSelect={setSelectedId} selectedId={selectedId} skinned={skinEnabled} />
          ))}
        </div>
      )}

      {skinEnabled && (
        <div className="ofc-attribution">
          Interior tiles:{" "}
          <a href="https://limezu.itch.io/" target="_blank" rel="noopener noreferrer">Modern Interiors by LimeZu</a>
        </div>
      )}

      <AlumniDrawer onGoToTask={goToTask} />

      {selectedTask && !narrow && (
        <DetailPanel
          task={selectedTask}
          projectName={projectNames.get(selectedTask.project_id) ?? ""}
          agents={agents}
          mobile={false}
          onClose={() => setSelectedId(null)}
          onGoToTask={goToTask}
          onPatched={patchLocal}
        />
      )}
      {selectedTask && narrow && (
        <>
          <div className="ofc-sheet-scrim" onClick={() => setSelectedId(null)} />
          <DetailPanel
            task={selectedTask}
            projectName={projectNames.get(selectedTask.project_id) ?? ""}
            agents={agents}
            mobile
            onClose={() => setSelectedId(null)}
            onGoToTask={goToTask}
            onPatched={patchLocal}
          />
        </>
      )}
    </div>
  );
}
