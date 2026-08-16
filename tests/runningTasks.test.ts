import { describe, expect, it } from "vitest";
import { createProject, createTask, updateTask, listRunningTaskIds, listRunningTasksLite } from "../lib/store";

// Backs the client's fleet-wide running-set reconciliation (GET /api/running).
// The client holds only the selected project's tasks, so a turn_end missed while
// the global /api/events stream was disconnected is never learned locally;
// reconciling against this authoritative list on SSE reconnect is what clears
// the stale spinner.
describe("listRunningTaskIds", () => {
  it("returns running task ids across projects and excludes idle/suggested ones", () => {
    const a = createProject({ name: "A" });
    const b = createProject({ name: "B" });

    const aRun = createTask({ project_id: a.id, title: "A running", description: "" });
    const aIdle = createTask({ project_id: a.id, title: "A idle", description: "" });
    const bRun = createTask({ project_id: b.id, title: "B running", description: "" });
    const bSuggested = createTask({ project_id: b.id, title: "B suggested", description: "" });

    updateTask(aRun.id, { running: 1 });
    updateTask(bRun.id, { running: 1 });
    // A running-but-suggested task never surfaces to the client, so exclude it.
    updateTask(bSuggested.id, { running: 1, suggested: 1 });

    const ids = listRunningTaskIds().sort();
    expect(ids).toEqual([aRun.id, bRun.id].sort());
    expect(ids).not.toContain(aIdle.id);
    expect(ids).not.toContain(bSuggested.id);
  });

  it("drains to empty once every turn has ended — so a reconnect resync clears everything", () => {
    const p = createProject({ name: "Drain" });
    const t = createTask({ project_id: p.id, title: "T", description: "" });

    updateTask(t.id, { running: 1 });
    expect(listRunningTaskIds()).toContain(t.id);

    updateTask(t.id, { running: 0 });
    expect(listRunningTaskIds()).not.toContain(t.id);
  });
});

// Backs GET /api/running's `tasks` field — the client's project-scoped running
// rollup (ProjectsColumn's blue dot) needs to know WHICH project a running
// task belongs to, not just its id.
describe("listRunningTasksLite", () => {
  it("carries each running task's project id, excluding idle/suggested ones", () => {
    const a = createProject({ name: "A" });
    const b = createProject({ name: "B" });

    const aRun = createTask({ project_id: a.id, title: "A running", description: "" });
    const aIdle = createTask({ project_id: a.id, title: "A idle", description: "" });
    const bRun = createTask({ project_id: b.id, title: "B running", description: "" });
    const bSuggested = createTask({ project_id: b.id, title: "B suggested", description: "" });

    updateTask(aRun.id, { running: 1 });
    updateTask(bRun.id, { running: 1 });
    updateTask(bSuggested.id, { running: 1, suggested: 1 });

    // Containment, not exact equality — earlier tests in this file leave their
    // own running rows behind (nothing here resets them), same as
    // listRunningTaskIds' first test above.
    const rows = listRunningTasksLite();
    expect(rows).toContainEqual({ id: aRun.id, project_id: a.id });
    expect(rows).toContainEqual({ id: bRun.id, project_id: b.id });
    expect(rows.some((r) => r.id === aIdle.id)).toBe(false);
    expect(rows.some((r) => r.id === bSuggested.id)).toBe(false);
  });
});
