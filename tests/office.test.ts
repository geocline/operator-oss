import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addTaskNote,
  createProject,
  createTask,
  listOfficeProjects,
  listOfficeTasks,
  updateProject,
  updateTask,
  upsertTaskVisual,
} from "../lib/store";
import { activateWorkstream, setWorkstreamState } from "../lib/workstreams/store";

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeProject(overrides: Partial<{ deprecated: boolean }> = {}) {
  const project = createProject({ name: `Office ${Date.now()} ${Math.random()}` });
  if (overrides.deprecated) updateProject(project.id, { deprecated: 1 });
  return project;
}

describe("GET /api/office data (listOfficeProjects / listOfficeTasks)", () => {
  it("lists active projects only", () => {
    const active = makeProject();
    const deprecated = makeProject({ deprecated: true });
    const projects = listOfficeProjects();
    expect(projects.some((p) => p.id === active.id)).toBe(true);
    expect(projects.some((p) => p.id === deprecated.id)).toBe(false);
  });

  it("excludes done, cancelled, and suggested tasks", () => {
    const project = makeProject();
    const notStarted = createTask({ project_id: project.id, title: "Not started" });
    const inProgress = createTask({ project_id: project.id, title: "In progress" });
    updateTask(inProgress.id, { status: "in_progress" });
    const done = createTask({ project_id: project.id, title: "Done" });
    updateTask(done.id, { status: "done" });
    const cancelled = createTask({ project_id: project.id, title: "Cancelled" });
    updateTask(cancelled.id, { status: "cancelled" });
    const suggested = createTask({ project_id: project.id, title: "Suggested", suggested: true });

    const ids = listOfficeTasks()
      .filter((t) => t.project_id === project.id)
      .map((t) => t.id);
    expect(ids).toContain(notStarted.id);
    expect(ids).toContain(inProgress.id);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(cancelled.id);
    expect(ids).not.toContain(suggested.id);
  });

  it("excludes tasks belonging to a deprecated project", () => {
    const project = makeProject({ deprecated: true });
    const task = createTask({ project_id: project.id, title: "Orphaned" });
    const ids = listOfficeTasks().map((t) => t.id);
    expect(ids).not.toContain(task.id);
  });

  it("carries display_name/avatar defaults and overrides", () => {
    const project = makeProject();
    const bare = createTask({ project_id: project.id, title: "Bare" });
    const styled = createTask({ project_id: project.id, title: "Styled" });
    upsertTaskVisual(styled.id, { display_name: "Sty", avatar: { hat: "red" } });

    const rows = listOfficeTasks();
    const bareRow = rows.find((t) => t.id === bare.id)!;
    const styledRow = rows.find((t) => t.id === styled.id)!;
    expect(bareRow.display_name).toBe("");
    expect(bareRow.avatar).toBeNull();
    expect(styledRow.display_name).toBe("Sty");
    expect(styledRow.avatar).toEqual({ hat: "red" });
  });

  it("surfaces the latest note only", () => {
    const project = makeProject();
    const task = createTask({ project_id: project.id, title: "Noted" });
    addTaskNote(task.id, task.generation, "first");
    // Ensure ordering is deterministic even within the same millisecond.
    addTaskNote(task.id, task.generation, "second");
    const row = listOfficeTasks().find((t) => t.id === task.id)!;
    expect(row.latest_note?.content).toBe("second");
  });

  it("returns null latest_note when there are none", () => {
    const project = makeProject();
    const task = createTask({ project_id: project.id, title: "No notes" });
    const row = listOfficeTasks().find((t) => t.id === task.id)!;
    expect(row.latest_note).toBeNull();
  });

  it("builds card_url only when linked (non-disconnected) and the base URL is configured", () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example/");
    const project = makeProject();
    const linked = createTask({ project_id: project.id, title: "Linked" });
    const link = activateWorkstream({
      taskId: linked.id,
      provider: "ardent",
      externalCardId: "card-123",
      externalWorkstreamId: "ws-123",
    });
    const paused = createTask({ project_id: project.id, title: "Paused" });
    const pausedLink = activateWorkstream({
      taskId: paused.id,
      provider: "ardent",
      externalCardId: "card-456",
      externalWorkstreamId: "ws-456",
    });
    setWorkstreamState(pausedLink.id, "paused");
    const disconnected = createTask({ project_id: project.id, title: "Disconnected" });
    const disconnectedLink = activateWorkstream({
      taskId: disconnected.id,
      provider: "ardent",
      externalCardId: "card-789",
      externalWorkstreamId: "ws-789",
    });
    setWorkstreamState(disconnectedLink.id, "disconnected");
    const unlinked = createTask({ project_id: project.id, title: "Unlinked" });

    const rows = listOfficeTasks();
    expect(rows.find((t) => t.id === linked.id)?.card_url).toBe(
      "https://tracker.example/?card=card-123",
    );
    expect(rows.find((t) => t.id === paused.id)?.card_url).toBe(
      "https://tracker.example/?card=card-456",
    );
    expect(rows.find((t) => t.id === disconnected.id)?.card_url).toBeNull();
    expect(rows.find((t) => t.id === unlinked.id)?.card_url).toBeNull();
    void link;
  });

  it("returns null card_url when the tracker base URL isn't configured", () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "");
    const project = makeProject();
    const linked = createTask({ project_id: project.id, title: "Linked" });
    activateWorkstream({
      taskId: linked.id,
      provider: "ardent",
      externalCardId: "card-abc",
      externalWorkstreamId: "ws-abc",
    });
    const row = listOfficeTasks().find((t) => t.id === linked.id)!;
    expect(row.card_url).toBeNull();
  });
});
