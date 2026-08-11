// Settings → Run defaults must actually reach a new task. A task row now always
// stores explicit run controls, so unless creation resolves the app-level
// defaults, setting "Plan mode" (or a cheaper default model) in Settings has no
// effect at all and every task silently starts on auto-run + the harness's most
// expensive model.

import { describe, it, expect, beforeEach } from "vitest";
import { createProject, getTask, setSetting, updateTask } from "@/lib/store";
import { POST as tasksPost } from "@/app/api/tasks/route";
import { PATCH as taskPatch } from "@/app/api/tasks/[id]/route";

function create(body: Record<string, unknown>) {
  return tasksPost(new Request("http://test/tasks", { method: "POST", body: JSON.stringify(body) }));
}

function patch(id: string, body: Record<string, unknown>) {
  return taskPatch(
    new Request("http://test/task", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  for (const key of [
    "default_model",
    "default_model:claude",
    "default_reasoning",
    "default_reasoning:claude",
    "default_permission_mode",
    "default_permission_mode:claude",
    "default_permission_mode:codex",
  ]) {
    setSetting(key, null);
  }
});

describe("app-level run defaults", () => {
  it("seeds an unspecified control from the agent-scoped default", async () => {
    setSetting("default_model:claude", "haiku");
    setSetting("default_reasoning:claude", "think_hard");
    setSetting("default_permission_mode:claude", "plan");
    const project = createProject({ name: "Defaults" });

    const res = await create({ project_id: project.id, title: "Inherit" });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.model).toBe("haiku");
    expect(task.reasoning).toBe("think_hard");
    expect(task.permission_mode).toBe("plan");
  });

  it("falls back to the legacy un-suffixed key, and an explicit value still wins", async () => {
    setSetting("default_permission_mode", "plan");
    const project = createProject({ name: "Legacy" });

    const inherited = await (await create({ project_id: project.id, title: "Inherit" })).json();
    expect(inherited.permission_mode).toBe("plan");

    const explicit = await (await create({
      project_id: project.id,
      title: "Explicit",
      permission_mode: "acceptEdits",
    })).json();
    expect(explicit.permission_mode).toBe("acceptEdits");
  });

  it("drops a default the chosen harness can't run instead of failing the request", async () => {
    // "acceptEdits" is Claude-only; Codex declares auto-run + plan.
    setSetting("default_permission_mode", "acceptEdits");
    setSetting("default_model", "opus");
    const project = createProject({ name: "Stale" });

    const task = await (await create({ project_id: project.id, title: "Codex", agent: "codex" })).json();
    expect(task.permission_mode).toBe("bypassPermissions");
    expect(task.model).toBe(null);
  });

  it("still 400s on a permission mode the caller sent that the harness can't run", async () => {
    const project = createProject({ name: "Reject" });
    const res = await create({
      project_id: project.id,
      title: "Bad",
      agent: "codex",
      permission_mode: "acceptEdits",
    });
    expect(res.status).toBe(400);
  });

  it("resets to the new agent's default on a harness switch, never a blanket auto-run", async () => {
    setSetting("default_permission_mode:codex", "plan");
    const project = createProject({ name: "Switch" });
    const task = await (await create({
      project_id: project.id,
      title: "Switch me",
      permission_mode: "acceptEdits",
    })).json();

    const res = await patch(task.id, { agent: "codex" });
    expect(res.status).toBe(200);
    expect(getTask(task.id)!.permission_mode).toBe("plan");
  });

  it("keeps auto-run as the floor when nothing is configured", async () => {
    const project = createProject({ name: "Unset" });
    const task = await (await create({ project_id: project.id, title: "Plain" })).json();
    expect(task.permission_mode).toBe("bypassPermissions");
    expect(task.model).toBe(null);
    expect(task.reasoning).toBe(null);
    // A started task's controls are its own; defaults only ever seed creation.
    updateTask(task.id, { started: 1 });
    expect(getTask(task.id)!.permission_mode).toBe("bypassPermissions");
  });
});
