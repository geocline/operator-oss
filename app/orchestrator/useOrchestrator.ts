"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Priority, Status, AskQuestion, AskAnswers } from "@/lib/types";
import type { GlobalWireEvent } from "@/lib/events";
import type { ResolveResult } from "../TaskChanges";
import { jget, jsend, saveTaskEdit } from "./api";
import { isAwaiting, blockerTitles, formatAnswersText } from "./format";
import { loadPersist, readUrlSel } from "./persist";
import { DEFAULT_SETTINGS, EMPTY_AGENTS, type AgentsBundle, type OnboardingT, type ProjectRow, type TaskRow } from "./types";
import { agentLabel, driverForModel, publicHarnessId } from "./agents";
import { useTaskStream } from "./useTaskStream";
import { useGlobalEvents } from "./useGlobalEvents";
import { describeEvent, notifyEnabled, showNotification } from "./notifications";
import { usePrefs } from "./usePrefs";
import { useRecaps } from "./useRecaps";

type Modal = null | "task" | "context" | "project" | "sessions";

// The /handoff command's final-turn prompt: written as a normal visible message
// so the document streams into the transcript, then the turn's last assistant
// message is carried verbatim into the next generation as its seed summary.
export const HANDOFF_PROMPT = `We are handing this session off to a fresh session that has NEVER seen this conversation. Write a comprehensive handoff document that lets it continue without re-deriving anything. Include, in this order: (1) Objective - what this task is trying to accomplish. (2) Current state - what is completed, with concrete facts: figures, dates, names, decisions and their rationale. (3) Key findings and data - every load-bearing number, file, or reference discovered. (4) Decisions and pushbacks - what was decided, what was rejected and why. (5) Open items / next steps, in priority order. (6) Do NOT redo - things already done that a naive fresh session might wrongly repeat. (7) Sources of truth - where the files, cards, and references live (absolute paths). If this task has a working folder, also save the document there as HANDOFF.md. Then output the COMPLETE document as your final message - the full text, not a pointer to the file.`;

// The orchestrator's single source of truth: all client state, the derived
// views over it, the data-loading effects, and every action callback. Returns a
// flat bag the composition root (Orchestrator.tsx) wires straight into the UI.
export function useOrchestrator() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selProj, setSelProj] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selTask, setSelTask] = useState<string | null>(null);
  // First-paint state: booted flips once the initial project fetch lands, so the
  // shell can show a column skeleton instead of a blank flash; a failed boot
  // surfaces as a retryable error screen instead of an empty workspace.
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // Which project the current `tasks` array actually belongs to — until it
  // matches the selected project, the tasks column shows a skeleton rather than
  // the previous project's (stale) list.
  const [tasksFor, setTasksFor] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  // Project-scoped running rollup — projectId -> the set of its task ids
  // currently running. Feeds ProjectsColumn's "a task is running here" dot for
  // projects that aren't the selected one, so a live turn in a collapsed
  // project is never invisible. Fed incrementally by useGlobalEvents on every
  // task lifecycle event, and replaced wholesale by reconcileRunning below.
  const [runningByProject, setRunningByProjectState] = useState<Map<string, Set<string>>>(new Map());
  const setRunningByProject = useCallback((projectId: string, taskId: string, on: boolean) => {
    setRunningByProjectState((prev) => {
      const existing = prev.get(projectId);
      const already = !!existing?.has(taskId);
      if (on === already) return prev; // no-op: skip the copy
      const next = new Map(prev);
      const set = new Set(existing ?? []);
      if (on) set.add(taskId); else set.delete(taskId);
      if (set.size) next.set(projectId, set); else next.delete(projectId);
      return next;
    });
  }, []);
  // The plain "does this project have anything running" view ProjectsColumn
  // actually renders — the per-task detail behind it doesn't matter there.
  const runningProjects = useMemo(
    () => new Set(Array.from(runningByProject.entries()).filter(([, ids]) => ids.size > 0).map(([id]) => id)),
    [runningByProject]
  );
  const [modal, setModal] = useState<Modal>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  const [termMounted, setTermMounted] = useState(false); // mount once, then keep alive across collapses
  const [termHeight, setTermHeight] = useState(300);
  // Managed-services drawer — same mount-once-keep-alive pattern as the terminal.
  const [servicesOpen, setServicesOpen] = useState(false);
  const [servicesMounted, setServicesMounted] = useState(false);
  const [servicesHeight, setServicesHeight] = useState(300);
  // Server-backed app defaults (e.g. default reasoning / permission mode a task
  // inherits). Stored in orchestrator.db, not localStorage, so runTurn can read them.
  const [appDefaults, setAppDefaults] = useState<Record<string, string>>({});
  // Agent capability descriptors (GET /api/agents): the model/reasoning/permission
  // pickers, per-task agent badges, cost/ask gates, and the new-task agent picker
  // all read from this — no hardcoded per-agent lists in the client.
  const [agents, setAgents] = useState<AgentsBundle>(EMPTY_AGENTS);
  // First-run onboarding. `onboarding` is the persisted wizard state (resume
  // point + connection); `wizardOpen` mounts the full-screen wizard over the app.
  const [onboarding, setOnboarding] = useState<OnboardingT | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Shown after the built-in tutorial task is merged — the "now build your own" nudge.
  const [nudge, setNudge] = useState(false);

  const project = useMemo(() => projects.find((p) => p.id === selProj) ?? null, [projects, selProj]);
  const activeProjects = useMemo(() => projects.filter((p) => !p.deprecated), [projects]);
  const deprecatedProjects = useMemo(() => projects.filter((p) => p.deprecated), [projects]);
  const realTasks = useMemo(() => tasks.filter((t) => !t.suggested), [tasks]);
  const suggested = useMemo(() => tasks.filter((t) => t.suggested), [tasks]);
  const task = useMemo(() => tasks.find((t) => t.id === selTask) ?? null, [tasks, selTask]);
  // taskId -> titles of its unfinished blockers. A task in this map is blocked:
  // it shows a "Blocked by" chip and its Start button is disabled. Recomputed from
  // the live task list, so a blocker hitting 'done' auto-unblocks dependents.
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const blockedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tasks) {
      const names = blockerTitles(t, tasksById);
      if (names.length) m.set(t.id, names);
    }
    return m;
  }, [tasks, tasksById]);

  // Cross-project "Needs you" surfacing. The selected project's tasks are live in
  // state (so its count reflects awaiting_input as it changes mid-turn); other
  // projects come from the server-computed awaiting_count on the project list.
  const liveAwaiting = useMemo(() => realTasks.filter((t) => isAwaiting(t)), [realTasks]);
  const needsYouTotal = useMemo(
    () => activeProjects.reduce((n, p) => n + (p.id === selProj ? liveAwaiting.length : p.awaiting_count), 0),
    [activeProjects, selProj, liveAwaiting]
  );

  const setTaskRunning = (id: string, on: boolean) =>
    setRunning((prev) => { const n = new Set(prev); on ? n.add(id) : n.delete(id); return n; });

  // Capture the URL selection synchronously on first render. The URL-sync effect
  // runs (once `hydrated` flips) before the async project fetch applies selection,
  // and would wipe the query string while selProj/selTask are still null — so we
  // must read ?project/?task before that happens, not inside the fetch callback.
  const urlSelRef = useRef<{ project?: string; task?: string; view?: string } | null>(null);
  if (urlSelRef.current === null) urlSelRef.current = readUrlSel();

  // selProjRef tracks selProj for callbacks/intervals that must read the latest
  // value without re-subscribing (the live stream handler + the recap sweep).
  const selProjRef = useRef(selProj);
  useEffect(() => { selProjRef.current = selProj; }, [selProj]);

  // Latest agents bundle for the live stream handler (context-window sizing),
  // read without re-subscribing the EventSource.
  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  const loadTasks = useCallback(async (projectId: string, selectFirst = true) => {
    const data = await jget<{ tasks: TaskRow[] }>(`/api/projects/${projectId}`);
    setTasks(data.tasks);
    setTasksFor(projectId);
    if (selectFirst) {
      const first = data.tasks.find((t) => !t.suggested);
      setSelTask(first ? first.id : null);
    }
    // Reconcile the running set only against THIS project's tasks — add/remove
    // ids it actually fetched. A partial per-project view must never imply that
    // tasks it can't see (running in other projects) have stopped; those are
    // cleared authoritatively by reconcileRunning() below.
    setRunning((prev) => { const n = new Set(prev); for (const t of data.tasks) t.running ? n.add(t.id) : n.delete(t.id); return n; });
  }, []);

  // Authoritative fleet-wide reconciliation of the running set. Cross-project
  // turn boundaries normally arrive on the global /api/events stream — but if
  // that stream was disconnected (laptop sleep, tunnel drop) when a turn ended,
  // the event is gone and the spinner would stick forever: the client only
  // refetches the SELECTED project's rows, so no other path would ever clear
  // it. useGlobalEvents calls this on every SSE reconnect; replacing the whole
  // set with the server's global truth drains any stale entries.
  const reconcileRunning = useCallback(async () => {
    try {
      const { ids, tasks: liveTasks } = await jget<{ ids: string[]; tasks: { id: string; project_id: string }[] }>("/api/running");
      setRunning(new Set(ids));
      // Wholesale replace, mirroring `running` above — this is the
      // authoritative fleet-wide truth, so any drift the incremental
      // per-event updates missed (a dark stream) is drained here too.
      const byProject = new Map<string, Set<string>>();
      for (const t of liveTasks) {
        const set = byProject.get(t.project_id) ?? new Set<string>();
        set.add(t.id);
        byProject.set(t.project_id, set);
      }
      setRunningByProjectState(byProject);
    } catch {}
  }, []);

  // Load the agent capability bundle (drives every run-control picker AND the
  // per-agent connected/authenticated/authBroken status). Re-runnable: any in-app
  // connect (wizard finish, Settings → Agents) calls this so the shared bundle —
  // and thus the New-task dialog's "· not connected" flag and the reconnect
  // banner — updates live, no reload. Declared above the event streams because
  // useGlobalEvents calls it when an agent's login dies or recovers.
  const refreshAgents = useCallback(
    () => jget<AgentsBundle>("/api/agents").then(setAgents).catch(() => {}),
    []
  );
  useEffect(() => { void refreshAgents(); }, [refreshAgents]);
  useEffect(() => {
    const refresh = () => { void refreshAgents(); };
    window.addEventListener("operator:refresh-agents", refresh);
    return () => window.removeEventListener("operator:refresh-agents", refresh);
  }, [refreshAgents]);

  // Agents that are connected on record but whose credentials just stopped
  // working — the titlebar reconnect banner's input. Normally empty.
  const brokenAgents = useMemo(() => agents.agents.filter((a) => !!a.authBroken), [agents]);

  // ---------- live task event stream + transcript state ----------
  const { msgsByTask, appendMsg } = useTaskStream({
    selTask, selProjRef, agentsRef, setTaskRunning, setTasks, setProjects, loadTasks,
  });
  // Always-open global lifecycle stream (GET /api/events): keeps spinners,
  // project badges, and the "N need you" pill live for tasks whose transcript
  // stream ISN'T open — only the selected task has one. It also feeds the
  // notifier, through a ref because that callback is declared below (it needs
  // settings + agents) while the subscription has to be set up here.
  const lifecycleRef = useRef<(ev: GlobalWireEvent) => void>(() => {});
  useGlobalEvents({
    selProjRef, setTaskRunning, setTasks, setProjects, loadTasks, reconcileRunning, refreshAgents, setRunningByProject,
    onLifecycle: (ev) => lifecycleRef.current(ev),
  });
  const messages = selTask ? msgsByTask[selTask] ?? [] : [];
  // No entry yet for the selected task = its SSE snapshot hasn't arrived — the
  // session view shows a transcript skeleton instead of an empty chat flash.
  const transcriptLoading = !!selTask && !(selTask in msgsByTask);
  // The tasks in state still belong to the previously selected project.
  const tasksLoading = !!project && tasksFor !== project.id;

  // ---------- prefs (appearance/settings/layout/view) + persistence ----------
  const { view, setView, taskView, setTaskView, appearance, setAppearance, settings, setSetting, setSettings, layout, setLayout, hydrated } =
    usePrefs({ selProj, selTask, urlSelRef, setSelProj, setSelTask });

  // ---------- project recaps + landing decision ----------
  const { recaps, fetchRecap } = useRecaps({ selProj, selTask, tasks, setSelTask, selProjRef });

  // Load server-backed app defaults (reasoning / permission mode) once.
  useEffect(() => {
    jget<Record<string, string>>("/api/settings").then(setAppDefaults).catch(() => {});
  }, []);

  // Onboarding: a fresh instance opens the wizard automatically; an already
  // set-up one (onboarding_complete) never sees it unless re-run from Settings.
  useEffect(() => {
    jget<OnboardingT>("/api/onboarding").then((o) => { setOnboarding(o); if (!o.complete) setWizardOpen(true); }).catch(() => {});
  }, []);

  const finishWizard = useCallback(() => {
    setWizardOpen(false);
    jget<OnboardingT>("/api/onboarding").then(setOnboarding).catch(() => {});
    // The wizard is the New-task dialog's "Connect" destination — pick up any
    // agent it just connected so the shared bundle reflects it immediately.
    void refreshAgents();
    // Land the user on the built-in tutorial: select the seeded "Welcome" project
    // and its ready "Try me" task (loadTasks(..., true) picks the first
    // non-suggested task), so the aha moment is one click away.
    const seed = projects.find((p) => p.seeded && !p.deprecated) ?? activeProjects[0];
    if (seed) {
      setSelProj(seed.id);
      setView("workspace");
      void loadTasks(seed.id, true);
    }
  }, [projects, activeProjects, loadTasks, setView, refreshAgents]);

  // "Re-run setup" from Settings: re-arm onboarding server-side and reopen it.
  const rerunOnboarding = useCallback(async () => {
    const o = await jsend<OnboardingT>("/api/onboarding", "DELETE");
    setOnboarding(o);
    setView("workspace");
    setWizardOpen(true);
  }, [setView]);

  // Who unlocked this instance (Cloudflare Access identity, shown in the
  // titlebar). null when enforcement is off — e.g. local dev — hides the chip.
  const [accessEmail, setAccessEmail] = useState<string | null>(null);
  useEffect(() => {
    jget<{ email: string | null }>("/api/me").then((r) => setAccessEmail(r.email)).catch(() => {});
  }, []);

  // initial load (also the Retry target when the first fetch fails)
  const boot = useCallback(() => {
    setBootError(null);
    jget<ProjectRow[]>("/api/projects").then((ps) => {
      setProjects(ps);
      const persisted = loadPersist();
      const url = urlSelRef.current ?? {};
      const active = ps.filter((p) => !p.deprecated);
      const wantProj = url.project ?? persisted.selProj;
      const wantTask = url.task ?? persisted.selTask;
      // Never land on a deprecated project — it must be restored before building.
      const persistedActive = active.find((p) => p.id === wantProj)?.id;
      const landProj = persistedActive ?? active[0]?.id ?? null;
      setSelProj(landProj);
      // Restore the task only if it belongs to the project we actually land on.
      // (If wantProj was missing/deprecated we fell back to active[0] — don't
      // carry over a task from a different project.) Validity within the project
      // is checked once its tasks load, below.
      if (wantTask && landProj === wantProj) setSelTask(wantTask);
      setBooted(true);
    }).catch((e) => {
      setBootError(e instanceof Error ? e.message : String(e));
    });
  }, []);
  useEffect(() => { boot(); }, [boot]);

  // Entering a project loads its tasks but does NOT auto-pick one — the landing
  // decision (recap vs. first task) is made in useRecaps once recap status is known.
  useEffect(() => { if (selProj) loadTasks(selProj, false); }, [selProj, loadTasks]);

  // A hidden tab gets throttled and its SSE streams may quietly die, so the
  // project badges / "needs you" counts drift while you're away. On the
  // hidden→visible transition, refetch the project list once — skipping brief
  // tab flips (the stream never missed a beat) so rapid alt-tabbing doesn't
  // spam the endpoint.
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      if (!hiddenAt || Date.now() - hiddenAt < 5_000) return;
      hiddenAt = 0;
      jget<ProjectRow[]>("/api/projects").then(setProjects).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // OS notifications, driven by the GLOBAL lifecycle stream so they cover every
  // task in every project - the previous version read this project's rows only,
  // which meant an agent waiting in any other project was silent. The mapping
  // from event to banner lives in ./notifications.ts; this only decides whether
  // an event is worth interrupting for RIGHT NOW.
  const notifyRef = useRef({ settings, agents, selTask });
  useEffect(() => { notifyRef.current = { settings, agents, selTask }; });

  // ---------- unviewed-completion marker (local only, no server state) ----------
  // A green dot on a task row whose turn finished while it WASN'T the one on
  // screen (or the tab itself wasn't visible to see it finish) — cleared the
  // moment the task is opened. Persisted per project in localStorage so it
  // survives a reload; `unviewed` mirrors the CURRENTLY selected project's
  // persisted set, which is all TasksColumn/TaskBoard ever need to render.
  const unviewedKey = (projectId: string) => `orch:unviewed:${projectId}`;
  const loadUnviewed = (projectId: string): Set<string> => {
    try {
      const raw = localStorage.getItem(unviewedKey(projectId));
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  };
  const saveUnviewed = (projectId: string, ids: Set<string>) => {
    try { localStorage.setItem(unviewedKey(projectId), JSON.stringify(Array.from(ids))); } catch {}
  };
  const [unviewed, setUnviewed] = useState<Set<string>>(new Set());
  const unviewedRef = useRef(unviewed);
  useEffect(() => { unviewedRef.current = unviewed; }, [unviewed]);
  // Switching projects: load that project's persisted set fresh (it may have
  // accrued markers from turns that finished while we were elsewhere).
  useEffect(() => { setUnviewed(selProj ? loadUnviewed(selProj) : new Set()); }, [selProj]);
  // Opening a task clears its own marker right away, local + persisted.
  useEffect(() => {
    if (!selTask || !selProj) return;
    setUnviewed((prev) => {
      if (!prev.has(selTask)) return prev;
      const next = new Set(prev);
      next.delete(selTask);
      saveUnviewed(selProj, next);
      return next;
    });
  }, [selTask, selProj]);

  const onLifecycle = useCallback((ev: GlobalWireEvent) => {
    // A pending /handoff completes on its turn's end — before the
    // selected-task early-return below, which only gates notifications.
    if (ev.type === "task" && ev.event === "turn_end") handoffDoneRef.current(ev.taskId);
    // Mark the task unviewed if its turn ended off-screen (a different task
    // selected, or the tab itself hidden) — the ONLY writer of this marker.
    if (ev.type === "task" && ev.event === "turn_end") {
      const tabVisible = typeof document !== "undefined" && document.visibilityState === "visible";
      const isSelected = ev.taskId === notifyRef.current.selTask;
      if (!isSelected || !tabVisible) {
        const existing = ev.projectId === selProjRef.current ? unviewedRef.current : loadUnviewed(ev.projectId);
        if (!existing.has(ev.taskId)) {
          const next = new Set(existing);
          next.add(ev.taskId);
          saveUnviewed(ev.projectId, next);
          if (ev.projectId === selProjRef.current) setUnviewed(next);
        }
      }
    }
    const { settings: s, agents: a, selTask: sel } = notifyRef.current;
    // Already looking at it, with the window in front: the screen IS the
    // notification. Anything in another task or another project still fires.
    if (
      ev.type === "task" &&
      ev.taskId === sel &&
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    ) return;
    const req = describeEvent(ev, (id) => agentLabel(a, id));
    if (!req || !notifyEnabled(s, req.kind)) return;
    showNotification(req, { sound: s.notifySound !== false, onOpen: goToTaskRef.current });
  }, []);
  // goToTask is defined further down; the ref keeps this callback stable so the
  // event subscription never churns.
  const goToTaskRef = useRef<(projectId: string, taskId: string) => void>(() => {});
  useEffect(() => { lifecycleRef.current = onLifecycle; }, [onLifecycle]);

  // Persist a server-backed app default and adopt the server's echoed-back state.
  const setAppDefault = async (key: string, value: string | null) => {
    const fresh = await jsend<Record<string, string>>("/api/settings", "PATCH", { [key]: value });
    setAppDefaults(fresh);
  };

  // ---------- sending a turn ----------
  // POST hands the turn to a detached server-side runner and returns at once;
  // everything that happens next (including the user-message echo) arrives
  // over the task's event stream. A reload mid-turn no longer kills it.
  const runTurn = useCallback(async (taskId: string, text: string, isInitial: boolean) => {
    setTaskRunning(taskId, true);
    setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, started: 1, status: "in_progress", suggested: 0, awaiting_input: 0 } : x)));
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok) {
        const raw = await res.text(); let msg = raw;
        try { msg = JSON.parse(raw).error ?? raw; } catch {}
        throw new Error(msg);
      }
    } catch (err) {
      setTaskRunning(taskId, false);
      appendMsg(taskId, { id: `e-${Date.now()}`, role: "system", content: err instanceof Error ? err.message : String(err), generation: tasks.find((t) => t.id === taskId)?.generation ?? 1 });
      try { const fresh = await jget<TaskRow>(`/api/tasks/${taskId}`); setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...fresh } : x))); } catch {}
    }
  }, [tasks, appendMsg]);

  // Submit the user's answer to an AskUserQuestion. In the common case the live
  // turn is parked waiting and continues in its existing stream (resolved:true).
  // If nothing was waiting (e.g. the turn was torn down by a page reload), resume
  // the session with the answer as a normal reply.
  const answerQuestion = useCallback(async (taskId: string, askId: string, questions: AskQuestion[], answers: AskAnswers) => {
    try {
      // No tool_use id to resolve against — e.g. a question persisted before
      // ask-id tracking was added, or one whose turn was already torn down. The
      // /answer route requires a non-empty askId, so skip it and just send the
      // choices as a normal reply, which resumes the current session.
      if (!askId) { await runTurn(taskId, formatAnswersText(questions, answers), false); return; }
      const { resolved } = await jsend<{ resolved: boolean }>(`/api/tasks/${taskId}/answer`, "POST", { askId, questions, answers });
      if (!resolved) await runTurn(taskId, formatAnswersText(questions, answers), false);
    } catch (err) {
      appendMsg(taskId, { id: `e-${Date.now()}`, role: "system", content: err instanceof Error ? err.message : String(err), generation: tasks.find((t) => t.id === taskId)?.generation ?? 1 });
      throw err;
    }
  }, [runTurn, tasks, appendMsg]);

  // Interrupt a running turn — the ONLY way one stops early now that turns are
  // detached from connections. The server aborts the SDK query, persists the
  // partial transcript, and publishes turn_end, which the event stream handler
  // turns into a task refresh (now awaiting_input, resumable).
  const stopTurn = useCallback(async (taskId: string) => {
    // Stop also cancels a pending /handoff — an aborted document-writing turn
    // must not auto-clear the session on its (aborted) turn_end.
    pendingHandoff.current.delete(taskId);
    try { await fetch(`/api/tasks/${taskId}/abort`, { method: "POST" }); } catch {}
  }, []);

  // Drop a queued (not-yet-run) follow-up. The server publishes `dequeued`,
  // which the stream handler turns into removing the bubble — so this is
  // fire-and-forget; no optimistic local mutation needed.
  const cancelQueued = useCallback(async (taskId: string, pendingId: string) => {
    try { await fetch(`/api/tasks/${taskId}/pending`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pendingId }) }); } catch {}
  }, []);

  // Materialize a conflicted merge in the task's worktree, then stream an AI
  // resolution turn into the transcript. Returns enough for TaskChanges to show
  // the right follow-up (review state, clean-merge done, or an error).
  const resolveConflictsWithAI = useCallback(async (taskId: string): Promise<ResolveResult> => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/merge/prepare`, { method: "POST" });
      const prep = await res.json();
      if (!res.ok || !prep?.ok) return { ok: false, error: prep?.error || "could not prepare the merge" };
      // Clean trial merge — it landed immediately, no AI needed.
      if (prep.clean) {
        if (selProj) loadTasks(selProj, false);
        try { const fresh = await jget<TaskRow>(`/api/tasks/${taskId}`); setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...fresh } : x))); } catch {}
        return prep.merged?.ok ? { ok: true, merged: true } : { ok: false, error: prep.merged?.error || "merge failed" };
      }
      // Conflicts present — stream the resolution turn (shows in the transcript).
      // Fire-and-forget: the caller switches to the chat view as soon as this
      // returns, so the user watches the resolution stream in live rather than
      // sitting on the "Changes" tab until the whole turn completes.
      void runTurn(taskId, prep.prompt, false);
      return { ok: true, conflicts: prep.conflicts, binaryConflicts: prep.binaryConflicts };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [runTurn, selProj, loadTasks]);

  // A merge just landed. Refresh the task list so its merged state shows, and —
  // if this was the tutorial (a task in the seeded Welcome project) — fire the
  // "now build your own" nudge, the payoff for finishing the loop.
  const onMerged = useCallback(() => {
    if (selProj) void loadTasks(selProj, false);
    if (project?.seeded) setNudge(true);
  }, [selProj, loadTasks, project]);

  // A PR was just opened (or updated) for a task. Refresh the task list so the
  // header's PR chip picks up the stored URL without waiting for the next poll.
  const onPrCreated = useCallback(() => {
    if (selProj) void loadTasks(selProj, false);
  }, [selProj, loadTasks]);

  // ---------- actions ----------
  const selectProject = (id: string) => { setSelProj(id); setSelTask(null); setView("workspace"); };

  // Jump to the next task waiting on the user: prefer one in the current project,
  // else switch to the first other project that has one (its group sits at the top).
  const jumpToNeedsYou = () => {
    if (liveAwaiting.length > 0) { setSelTask(liveAwaiting[0].id); return; }
    const p = activeProjects.find((p) => p.id !== selProj && p.awaiting_count > 0);
    if (p) selectProject(p.id);
  };

  // Jump straight to a specific task in any project — the "need you" dropdown's
  // row action. Setting selProj fires the load-tasks effect with selectFirst=false
  // (useEffect on selProj), so it won't clobber the selTask we set here.
  const goToTask = (projectId: string, taskId: string) => {
    setView("workspace");
    setSelProj(projectId);
    setSelTask(taskId);
  };
  // Clicking a notification banner opens the task it is about, in whichever
  // project that is.
  useEffect(() => { goToTaskRef.current = goToTask; });

  // Optional `agent` hands the task to another driver across the clear
  // boundary (same worktree, fresh context seeded with the summary) - the
  // "Continue with Codex" path when Claude quota runs low. `model` carries a
  // same-driver model pick across the boundary; `useLastAssistant` seeds the
  // next generation with the outgoing session's final assistant message (the
  // /handoff document) instead of an auto-summary.
  //
  // The fresh generation is NOT auto-started: the task returns to the
  // unstarted state with the composer open, so the user can adjust the model
  // and write (or edit) the opening prompt before anything runs. Sending a
  // message - or the Start button - launches generation N+1.
  const doClear = useCallback(async (taskId: string, generation: number, opts?: { agent?: string; model?: string | null; useLastAssistant?: boolean }) => {
    setTaskRunning(taskId, true);
    try {
      const body = opts && (opts.agent || opts.model !== undefined || opts.useLastAssistant)
        ? { ...(opts.agent ? { agent: opts.agent } : {}), ...(opts.model !== undefined ? { model: opts.model } : {}), ...(opts.useLastAssistant ? { useLastAssistant: true } : {}) }
        : undefined;
      const { summary } = await jsend<{ summary: string }>(`/api/tasks/${taskId}/clear`, "POST", body);
      appendMsg(taskId, { id: `sb-${Date.now()}`, role: "session_break", content: summary, generation });
      const fresh = await jget<TaskRow>(`/api/tasks/${taskId}`);
      setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...fresh } : x)));
    } finally {
      setTaskRunning(taskId, false);
    }
  }, [appendMsg]);
  const clearSession = useCallback(async (taskId: string, opts?: { agent?: string; model?: string | null; useLastAssistant?: boolean }) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t || running.has(taskId) || !t.started) return;
    await doClear(taskId, t.generation, opts);
  }, [tasks, running, doClear]);

  // /handoff: run one final, visible turn in the current session that writes a
  // comprehensive handoff document, then (on that turn's end, observed via the
  // global lifecycle stream) clear with the document as the carried summary and
  // the picked model applied. The fresh generation then waits for the user's
  // opening prompt like any other clear.
  const pendingHandoff = useRef(new Map<string, { model: string | null }>());
  const handoffSession = useCallback(async (taskId: string, model: string | null) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t || running.has(taskId) || !t.started) return;
    pendingHandoff.current.set(taskId, { model });
    await runTurn(taskId, HANDOFF_PROMPT, false);
  }, [tasks, running, runTurn]);
  // Completion hook, reached from onLifecycle via ref (onLifecycle is declared
  // above clearSession and must stay referentially stable). Calls doClear
  // directly: at turn_end time the local `running` set hasn't flipped yet, so
  // clearSession's guard would swallow the completion.
  const handoffDoneRef = useRef<(taskId: string) => void>(() => {});
  useEffect(() => {
    handoffDoneRef.current = (taskId: string) => {
      const pending = pendingHandoff.current.get(taskId);
      if (!pending) return;
      pendingHandoff.current.delete(taskId);
      const gen = tasks.find((x) => x.id === taskId)?.generation ?? 1;
      void doClear(taskId, gen, { model: pending.model, useLastAssistant: true });
    };
  }, [tasks, doClear]);

  // Cheap local patch: a mutation just took a task out of the "needs you" set,
  // so drop it from its project's badge now rather than waiting for the SSE
  // roundtrip (the published lifecycle event re-syncs the exact count moments
  // later; the selected project's pill reads liveAwaiting, so this only matters
  // once you navigate away).
  const decAwaiting = (t: TaskRow) =>
    setProjects((prev) => prev.map((p) => (p.id === t.project_id ? { ...p, awaiting_count: Math.max(0, p.awaiting_count - 1) } : p)));

  const setStatus = async (s: Status) => {
    if (!task) return;
    const wasAwaiting = isAwaiting(task);
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { status: s });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
    // The server clears awaiting_input on a manual status change.
    if (wasAwaiting) decAwaiting(task);
  };
  const setPriority = async (p: Priority) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { priority: p });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };
  const setModel = async (m: string | null) => {
    if (!task) return;
    const harness = publicHarnessId(task.agent) ?? task.agent;
    const driver = m ? driverForModel(agents, harness, m) : task.agent;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", {
      model: m,
      ...(task.started === 0 && driver !== task.agent ? { agent: driver } : {}),
    });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };
  // Move a not-yet-started task to another agent. The server rejects this once
  // a session exists (409) - that case goes through clearSession(id, agent),
  // which summarizes first so context survives the switch.
  const setAgent = async (a: string) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { agent: a });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };
  const setReasoning = async (r: string | null) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { reasoning: r });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };
  const setPermission = async (p: string | null) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { permission_mode: p });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };

  const createTask = async (input: { title: string; desc: string; priority: Priority; agent: string; model: string; reasoning: string; startNow: boolean; depends_on: string[]; workspace_mode: "direct" | "worktree"; permission_mode: string; subdir?: string }) => {
    if (!project) return;
    const t = await jsend<TaskRow>("/api/tasks", "POST", {
      project_id: project.id,
      title: input.title,
      description: input.desc,
      priority: input.priority,
      agent: input.agent,
      model: input.model,
      reasoning: input.reasoning,
      workspace_mode: input.workspace_mode,
      permission_mode: input.permission_mode,
      subdir: input.subdir ?? "",
    });
    // Dependencies are an edit-after-create step (the task id doesn't exist until now).
    if (input.depends_on.length) await jsend(`/api/tasks/${t.id}`, "PATCH", { depends_on: input.depends_on });
    await loadTasks(project.id, false);
    setSelTask(t.id);
    setModal(null);
    if (input.startNow) runTurn(t.id, "", true);
  };

  // A board drop: optionally re-status the dragged task (it landed in another
  // column) and persist the new manual order. `orderedIds` is the project's
  // full task list flattened in column order. Optimistic on both counts — the
  // card lands where it was dropped instantly; a failure reloads server truth.
  const moveTask = useCallback(async (id: string, patch: Partial<Pick<TaskRow, "status" | "suggested">>, orderedIds: string[]) => {
    const hasPatch = Object.keys(patch).length > 0;
    setTasks((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]));
      const listed = new Set(orderedIds);
      const next = [
        ...orderedIds.map((tid) => byId.get(tid)).filter((t): t is TaskRow => !!t),
        ...prev.filter((t) => !listed.has(t.id)),
      ];
      // Mirror the server: a manual status change clears the "your turn" flag.
      return hasPatch ? next.map((t) => (t.id === id ? { ...t, ...patch, awaiting_input: patch.status ? 0 : t.awaiting_input } : t)) : next;
    });
    try {
      if (hasPatch) {
        const fresh = await jsend<TaskRow>(`/api/tasks/${id}`, "PATCH", patch);
        setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, ...fresh } : x)));
      }
      await jsend("/api/tasks/reorder", "POST", { ids: orderedIds });
    } catch {
      if (selProjRef.current) void loadTasks(selProjRef.current, false);
    }
  }, [loadTasks]);

  const saveTask = async (id: string, patch: {
    title: string;
    description: string;
    priority: Priority;
    depends_on: string[];
    agent?: string;
    model?: string;
    reasoning?: string;
    confirm_launch_config?: boolean;
  }) => {
    const fresh = await saveTaskEdit<TaskRow>(id, patch);
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, ...fresh } : x)));
  };

  // Hard-deletes the task (and its worktree/branch server-side), closes the edit
  // modal, and drops it from the selection if it was the one being viewed.
  const removeTask = async (id: string) => {
    const t = tasks.find((x) => x.id === id);
    await jsend(`/api/tasks/${id}`, "DELETE");
    setTasks((prev) => prev.filter((x) => x.id !== id));
    // A deleted task can no longer need you — the task_deleted event confirms
    // with the server-recomputed count moments later.
    if (t && isAwaiting(t)) decAwaiting(t);
    setEditId(null);
    setSelTask((cur) => (cur === id ? null : cur));
  };

  const startSuggestion = async (id: string) => {
    const suggestion = tasks.find((entry) => entry.id === id);
    if (
      suggestion?.launch_config_required === 1 &&
      (suggestion.launch_config_confirmed_at === 0 ||
        !suggestion.model ||
        !suggestion.reasoning)
    ) {
      setEditId(id);
      return;
    }
    await jsend<TaskRow>(`/api/tasks/${id}`, "PATCH", { suggested: 0 });
    if (selProj) await loadTasks(selProj, false);
    setSelTask(id);
    runTurn(id, "", true);
  };
  const acceptSuggestion = async (id: string) => {
    await jsend<TaskRow>(`/api/tasks/${id}`, "PATCH", { suggested: 0 });
    if (selProj) await loadTasks(selProj, false);
  };
  const dismissSuggestion = async (id: string) => {
    await jsend(`/api/tasks/${id}`, "DELETE");
    if (selProj) await loadTasks(selProj, false);
  };

  const saveContext = async (patch: { name: string; context: string; repo_path: string; branch: string; dev_command: string; setup_command: string; test_command: string; run_in_repo: number }) => {
    if (!project) return;
    await jsend(`/api/projects/${project.id}`, "PATCH", patch);
    const ps = await jget<ProjectRow[]>("/api/projects");
    setProjects(ps);
    setModal(null);
  };
  const createProject = async (input: { name: string; sub: string; color: string; context: string; repo_path: string; branch?: string; run_in_repo?: number }) => {
    const p = await jsend<ProjectRow>("/api/projects", "POST", input);
    const ps = await jget<ProjectRow[]>("/api/projects");
    setProjects(ps);
    setSelProj(p.id);
    setSelTask(null);
    setModal(null);
  };
  const reorderProjects = useCallback((ids: string[]) => {
    // Optimistically reorder, then persist. On failure, reload from server.
    // `ids` covers only the active list; deprecated projects keep their order.
    setProjects((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      const reordered = ids.map((id) => byId.get(id)).filter((p): p is ProjectRow => !!p);
      const untouched = prev.filter((p) => !ids.includes(p.id));
      return [...reordered, ...untouched];
    });
    jsend("/api/projects/reorder", "POST", { ids }).catch(() => {
      jget<ProjectRow[]>("/api/projects").then(setProjects);
    });
  }, []);
  const removeProject = async (id: string) => {
    await jsend(`/api/projects/${id}`, "DELETE");
    const ps = await jget<ProjectRow[]>("/api/projects");
    setProjects(ps);
    setModal(null);
    if (selProj === id) { setSelProj(ps.find((p) => !p.deprecated)?.id ?? null); setSelTask(null); }
  };
  const setDeprecated = async (id: string, deprecated: boolean) => {
    await jsend(`/api/projects/${id}`, "PATCH", { deprecated: deprecated ? 1 : 0 });
    const ps = await jget<ProjectRow[]>("/api/projects");
    setProjects(ps);
    setModal(null);
    // Leaving a project that just got hidden: fall back to the first active one.
    if (deprecated && selProj === id) { setSelProj(ps.find((p) => !p.deprecated)?.id ?? null); setSelTask(null); }
    // Restoring: jump straight into the project so you can build on it again.
    if (!deprecated) { setSelProj(id); setSelTask(null); }
  };

  // Restore run defaults to built-ins: clear every server-backed default_* key
  // (agent-scoped and legacy) plus the reset of client-only settings.
  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    for (const key of Object.keys(appDefaults)) if (key.startsWith("default_") || key === "utility_agent") void setAppDefault(key, null);
  };

  // Set a project's default agent for new tasks (persisted; existing tasks keep
  // the agent they were created with).
  const setProjectDefaultAgent = async (agent: string) => {
    if (!project) return;
    await jsend(`/api/projects/${project.id}`, "PATCH", { default_agent: agent });
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, default_agent: agent } : p)));
  };

  return {
    // state + derived
    booted, bootError, retryBoot: boot, tasksLoading, transcriptLoading,
    projects, activeProjects, deprecatedProjects, selProj, setSelProj, project,
    tasks, realTasks, suggested, selTask, task, messages, running, runningProjects, unviewed,
    blockedBy, liveAwaiting, needsYouTotal,
    modal, setModal, editId, setEditId, view, setView, taskView, setTaskView,
    appearance, setAppearance, appearanceOpen, setAppearanceOpen,
    settings, setSetting, appDefaults, setAppDefault, agents, refreshAgents, brokenAgents,
    onboarding, wizardOpen, finishWizard, rerunOnboarding, nudge, setNudge, onMerged, onPrCreated,
    layout, setLayout, accessEmail, recaps,
    termOpen, setTermOpen, termMounted, setTermMounted, termHeight, setTermHeight,
    servicesOpen, setServicesOpen, servicesMounted, setServicesMounted, servicesHeight, setServicesHeight,
    // actions
    setSelTask, fetchRecap, runTurn, answerQuestion, stopTurn, cancelQueued, resolveConflictsWithAI,
    selectProject, jumpToNeedsYou, goToTask, clearSession, handoffSession, setStatus, setPriority, setModel, setAgent,
    setReasoning, setPermission, createTask, saveTask, removeTask, moveTask, startSuggestion, acceptSuggestion,
    dismissSuggestion, saveContext, createProject, reorderProjects, removeProject, setDeprecated,
    resetSettings, setProjectDefaultAgent,
  };
}
