import { describe, expect, it } from "vitest";
import {
  createProject,
  createTask,
  getTask,
  getSetting,
  listMessages,
  listTasks,
  updateTask,
} from "@/lib/store";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { POST as postMessage } from "@/app/api/tasks/[id]/messages/route";
import { withTaskLock } from "@/lib/taskLock";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { tmpDir } from "./helpers";

describe("suggested task launch configuration", () => {
  it("requires confirmation for the fresh-install seeded suggestion", () => {
    const seedProjectId = getSetting("seed_project_id");
    const seededSuggestion = seedProjectId
      ? listTasks(seedProjectId).find((task) => task.suggested === 1)
      : undefined;

    expect(seededSuggestion).toMatchObject({
      launch_config_required: 1,
      launch_config_confirmed_at: 0,
    });
  });

  it("requires confirmation for agent-suggested tasks only", () => {
    const project = createProject({ name: "Launch config" });
    const suggested = createTask({
      project_id: project.id,
      title: "Suggested follow-up",
      suggested: true,
    });
    const ordinary = createTask({
      project_id: project.id,
      title: "User-created task",
    });

    expect(getTask(suggested.id)).toMatchObject({
      launch_config_required: 1,
      launch_config_confirmed_at: 0,
    });
    expect(getTask(ordinary.id)).toMatchObject({
      launch_config_required: 0,
      launch_config_confirmed_at: 0,
    });
  });

  it("records confirmation only for an explicit supported configuration", async () => {
    const project = createProject({ name: "Confirm launch config" });
    const task = createTask({
      project_id: project.id,
      title: "Suggested follow-up",
      suggested: true,
      agent: "claude",
    });

    const response = await patchTask(
      new Request(`http://localhost/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "fable",
          reasoning: "think",
          confirm_launch_config: true,
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      model: "fable",
      reasoning: "think",
      launch_config_required: 1,
    });
    expect(body.launch_config_confirmed_at).toBeGreaterThan(0);

    const invalid = await patchTask(
      new Request(`http://localhost/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "not-a-real-model",
          reasoning: "think",
          confirm_launch_config: true,
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(invalid.status).toBe(400);
  });

  it("clears confirmation when launch settings change before the first turn", async () => {
    const project = createProject({ name: "Invalidate launch config" });
    const task = createTask({
      project_id: project.id,
      title: "Suggested follow-up",
      suggested: true,
    });
    updateTask(task.id, {
      model: "fable",
      reasoning: "think",
      launch_config_confirmed_at: Date.now(),
    });

    const response = await patchTask(
      new Request(`http://localhost/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus" }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.model).toBe("opus");
    expect(body.launch_config_confirmed_at).toBe(0);
  });

  it("blocks an unconfirmed required task before creating launch side effects", async () => {
    const project = createProject({ name: "Blocked launch config" });
    const task = createTask({
      project_id: project.id,
      title: "Suggested follow-up",
      description: "Do the follow-up",
      suggested: true,
    });

    const response = await postMessage(
      new Request(`http://localhost/api/tasks/${task.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/review.*setup/i);
    expect(listMessages(task.id)).toEqual([]);
    expect(getTask(task.id)).toMatchObject({
      started: 0,
      running: 0,
      suggested: 1,
    });
  });

  it("revalidates a previously confirmed setup before the first turn", async () => {
    const project = createProject({ name: "Stale launch config" });
    const task = createTask({
      project_id: project.id,
      title: "Suggested follow-up",
      suggested: true,
    });
    updateTask(task.id, {
      model: "removed-model",
      reasoning: "think",
      launch_config_confirmed_at: Date.now(),
    });

    const response = await postMessage(
      new Request(`http://localhost/api/tasks/${task.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/review setup/i),
    });
    expect(getTask(task.id)?.launch_config_confirmed_at).toBe(0);
  });

  it("revalidates after waiting for the task lock before first-launch side effects", async () => {
    const project = createProject({
      name: "Locked launch config",
      repo_path: tmpDir("locked-launch-"),
    });
    const task = createTask({
      project_id: project.id,
      title: "Suggested follow-up",
      suggested: true,
    });
    updateTask(task.id, {
      model: "fable",
      reasoning: "think",
      launch_config_confirmed_at: Date.now(),
    });

    let release!: () => void;
    let held!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withTaskLock(task.id, async () => {
      held();
      await gate;
    });
    await lockHeld;

    const launch = postMessage(
      new Request(`http://localhost/api/tasks/${task.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    updateTask(task.id, {
      title: "",
      description: "",
      model: "removed-model",
      launch_config_confirmed_at: 0,
    });
    release();
    await holder;

    const response = await launch;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/review setup/i),
    });
    expect(listMessages(task.id)).toEqual([]);
  });

  it("rejects launch-setting changes while an initial turn owns the task", async () => {
    const project = createProject({ name: "Claimed launch config" });
    const task = createTask({
      project_id: project.id,
      title: "Suggested follow-up",
      suggested: true,
    });
    updateTask(task.id, {
      model: "fable",
      reasoning: "think",
      launch_config_confirmed_at: Date.now(),
    });
    const controller = claimTurn(task.id);
    expect(controller).not.toBeNull();

    try {
      const response = await patchTask(
        new Request(`http://localhost/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus" }),
        }),
        { params: Promise.resolve({ id: task.id }) },
      );

      expect(response.status).toBe(409);
      expect(getTask(task.id)).toMatchObject({
        model: "fable",
        launch_config_confirmed_at: expect.any(Number),
      });
    } finally {
      unregisterTurn(task.id, controller!);
    }
  });
});
