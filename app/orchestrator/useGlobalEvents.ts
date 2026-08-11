"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { GlobalWireEvent } from "@/lib/events";
import { jget } from "./api";
import { subscribeGlobalEvents } from "./sharedEvents";
import type { ProjectRow, TaskRow } from "./types";

// One always-open EventSource on GET /api/events: coarse lifecycle events for
// EVERY task across EVERY project (turn started / awaiting input / answered /
// suggestion created / turn ended / mutation-route settles and deletions).
// This is what clears spinners and updates
// the "needs you" badges for tasks whose transcript stream isn't open — only
// the selected task has one (useTaskStream) — replacing the old 10s poll.
export function useGlobalEvents({ selProjRef, setTaskRunning, setTasks, setProjects, loadTasks, reconcileRunning, refreshAgents, onLifecycle }: {
  selProjRef: MutableRefObject<string | null>;
  setTaskRunning: (id: string, on: boolean) => void;
  setTasks: React.Dispatch<React.SetStateAction<TaskRow[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectRow[]>>;
  loadTasks: (projectId: string, selectFirst?: boolean) => Promise<void>;
  reconcileRunning: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  /**
   * Every event, before any state patching, for consumers that care about the
   * transition rather than the resulting state - notifications, above all. It
   * hangs off this hook rather than taking its own subscription so there stays
   * exactly one stream per tab (see sharedEvents.ts on the connection budget).
   */
  onLifecycle?: (ev: GlobalWireEvent) => void;
}) {
  // Apply one lifecycle event. The payload is a fresh snapshot of the task
  // row's running/awaiting_input/status (read after the runner persisted it),
  // so applying it is idempotent — overlaps with the selected task's own
  // stream, which fires for the same boundaries, are harmless.
  const handle = (ev: GlobalWireEvent) => {
    onLifecycle?.(ev);
    // An agent's login died or came back. Refetch the shared agents bundle
    // rather than patching state locally, so the reconnect banner, the Settings
    // cards, and the New-task picker all read one server-side truth. Rare event
    // (once per outage), so the extra fetch costs nothing.
    if (ev.type === "agent_auth") { void refreshAgents(); return; }
    // A task was hard-deleted (possibly in another tab — in this one the local
    // removal already happened, so the replay is a no-op). Drop it and adopt
    // the recomputed project badge the event carries; there's no row left to
    // re-fetch.
    if (ev.type === "task_deleted") {
      setTaskRunning(ev.taskId, false);
      setTasks((prev) => prev.filter((t) => t.id !== ev.taskId));
      setProjects((prev) => prev.map((p) => (p.id === ev.projectId ? { ...p, awaiting_count: ev.awaiting_count } : p)));
      return;
    }
    if (ev.type !== "task") return;
    setTaskRunning(ev.taskId, ev.running);
    setTasks((prev) => prev.map((t) => {
      if (t.id !== ev.taskId) return t;
      // A launch publishes turn_started before the agent session opens, i.e.
      // while the row's status is still "not_started" — don't regress a task
      // the client already optimistically flipped to in_progress; the session-
      // open event re-fires turn_started with the settled status moments later.
      const status = ev.running && ev.status === "not_started" && t.status === "in_progress" ? t.status : ev.status;
      return { ...t, running: ev.running ? 1 : 0, awaiting_input: ev.awaiting_input ? 1 : 0, status };
    }));
    // Project badge + titlebar pill: the event carries the project's fresh
    // awaiting count, so no /api/projects refetch is needed.
    setProjects((prev) => prev.map((p) => (p.id === ev.projectId ? { ...p, awaiting_count: ev.awaiting_count } : p)));
    // A suggested task was created (by a turn in that project) — surface it in
    // the Suggested tray right away if that project is on screen.
    if (ev.event === "suggested" && selProjRef.current === ev.projectId) void loadTasks(ev.projectId, false);
  };
  // Route through a ref so the EventSource effect never re-subscribes.
  const handleRef = useRef(handle);
  useEffect(() => { handleRef.current = handle; });

  useEffect(() => {
    // The stream itself is shared across tabs (sharedEvents.ts): one tab holds
    // the real EventSource, the rest listen over a BroadcastChannel — Chrome's
    // six-connection HTTP/1.1 budget is per origin across ALL tabs, and a tab
    // fleet each holding its own streams starved every mutation request.
    return subscribeGlobalEvents({
      onEvent: (ev) => handleRef.current(ev),
      onCatchUp: () => {
        // The stream is a live tail with no snapshot: anything published while
        // no tab held a connection (laptop sleep, tunnel drop, leader-tab
        // death) is gone — refetch the authoritative lists once to catch up.
        // reconcileRunning drains the running set fleet-wide: a turn_end
        // missed while dark, on a task in a project we've navigated away from,
        // is invisible to the two refetches below (they only cover the selected
        // project's rows) and would leave that spinner stuck forever.
        jget<ProjectRow[]>("/api/projects").then(setProjects).catch(() => {});
        if (selProjRef.current) void loadTasks(selProjRef.current, false);
        void reconcileRunning();
        // An agent_auth event fired while we were dark would be lost, leaving a
        // stale banner — or none when the login is in fact dead. The bundle
        // carries the persisted flag, so refetch it too.
        void refreshAgents();
      },
    });
    // All deps are stable (a ref, a setState, []-memoized callbacks).
  }, [selProjRef, setProjects, loadTasks, reconcileRunning, refreshAgents]);
}
