import { describe, it, expect, beforeEach, vi } from "vitest";

// Per-task workspace mode: every task explicitly chooses the real project folder
// or an isolated worktree. Drives a scripted fake driver through the real routes
// + runner, like tests/turnRace.test.ts.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: AbortController) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import type { Task } from "@/lib/types";
import { createProject, createTask, getTask, updateProject } from "@/lib/store";
import { subscribe } from "@/lib/events";
import { POST as messagesPost } from "@/app/api/tasks/[id]/messages/route";
import { PATCH as taskPatch } from "@/app/api/tasks/[id]/route";
import { POST as tasksPost } from "@/app/api/tasks/route";
import { POST as mergePost } from "@/app/api/tasks/[id]/merge/route";
import { POST as mergePreparePost } from "@/app/api/tasks/[id]/merge/prepare/route";
import { GET as syncGet, POST as syncPost } from "@/app/api/tasks/[id]/sync/route";
import { GET as diffGet } from "@/app/api/tasks/[id]/diff/route";
import { makeRepo } from "./helpers";

function post(taskId: string, text: string) {
  return messagesPost(new Request("http://test/messages", { method: "POST", body: JSON.stringify({ text }) }), {
    params: Promise.resolve({ id: taskId }),
  });
}

function turnEnd(taskId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
  });
}

// Run one full scripted turn through the real messages route + runner.
async function runOneTurn(taskId: string) {
  runTurnMock.mockImplementation(async function* () {
    yield { type: "session", sessionId: "s1" };
    yield { type: "text", content: "ok" };
    yield { type: "done", sessionId: "s1" };
  });
  const ended = turnEnd(taskId);
  const res = await post(taskId, "go");
  expect(res.status).toBe(202);
  await ended;
}

beforeEach(() => {
  runTurnMock.mockReset();
});

describe("task workspace mode", () => {
  it("validates workspace mode at task creation", async () => {
    const project = createProject({ name: "CreateValidation", repo_path: await makeRepo() });
    const invalid = await tasksPost(new Request("http://test/tasks", {
      method: "POST",
      body: JSON.stringify({
        project_id: project.id,
        title: "Bad",
        workspace_mode: "mystery",
      }),
    }));
    expect(invalid.status).toBe(400);

    const invalidAccess = await tasksPost(new Request("http://test/tasks", {
      method: "POST",
      body: JSON.stringify({
        project_id: project.id,
        title: "Bad access",
        agent: "codex",
        permission_mode: "made-up",
      }),
    }));
    expect(invalidAccess.status).toBe(400);

    const valid = await tasksPost(new Request("http://test/tasks", {
      method: "POST",
      body: JSON.stringify({
        project_id: project.id,
        title: "Good",
        workspace_mode: "worktree",
        permission_mode: "bypassPermissions",
      }),
    }));
    expect(valid.status).toBe(201);
    expect(await valid.json()).toMatchObject({
      workspace_mode: "worktree",
      permission_mode: "bypassPermissions",
    });
  });

  it("allows workspace changes before start and rejects them after start", async () => {
    const project = createProject({ name: "PatchValidation", repo_path: await makeRepo() });
    const task = createTask({ project_id: project.id, title: "T" });
    const before = await taskPatch(new Request("http://test/task", {
      method: "PATCH",
      body: JSON.stringify({ workspace_mode: "worktree" }),
    }), { params: Promise.resolve({ id: task.id }) });
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ workspace_mode: "worktree" });

    const invalidAccess = await taskPatch(new Request("http://test/task", {
      method: "PATCH",
      body: JSON.stringify({ permission_mode: "made-up" }),
    }), { params: Promise.resolve({ id: task.id }) });
    expect(invalidAccess.status).toBe(400);

    await runOneTurn(task.id);
    const after = await taskPatch(new Request("http://test/task", {
      method: "PATCH",
      body: JSON.stringify({ workspace_mode: "direct" }),
    }), { params: Promise.resolve({ id: task.id }) });
    expect(after.status).toBe(409);
  });

  it("defaults new tasks to direct workspace and explicit full-power access", async () => {
    const project = createProject({ name: "Default", repo_path: await makeRepo() });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    expect(task.workspace_mode).toBe("direct");
    expect(task.permission_mode).toBe("bypassPermissions");
    await runOneTurn(task.id);
    const after = getTask(task.id)!;
    expect(after.worktree_path).toBe("");
    expect(after.work_branch).toBe("");
  });

  it("creates isolation only when the task explicitly requests a worktree", async () => {
    const project = createProject({ name: "Isolated", repo_path: await makeRepo(), run_in_repo: 1 });
    const task = createTask({
      project_id: project.id,
      title: "T",
      description: "d",
      workspace_mode: "worktree",
    });
    expect(task.workspace_mode).toBe("worktree");
    await runOneTurn(task.id);
    const after = getTask(task.id)!;
    expect(after.worktree_path).not.toBe("");
    expect(after.work_branch).not.toBe("");
  });

  it("does not let the legacy project toggle silently isolate a new task", async () => {
    const project = createProject({ name: "LegacyProjectDefault", repo_path: await makeRepo(), run_in_repo: 0 });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    expect(task.workspace_mode).toBe("direct");
    await runOneTurn(task.id);
    expect(getTask(task.id)!.worktree_path).toBe("");
  });

  it("skips worktree creation and runs the session in repo_path", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "Direct", repo_path: repo, run_in_repo: 1 });
    expect(project.run_in_repo).toBe(1);
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    await runOneTurn(task.id);

    // No worktree, no branch — worktree_path stays "" so drivers fall back to
    // repo_path (task.worktree_path || project.repo_path).
    const after = getTask(task.id)!;
    expect(after.worktree_path).toBe("");
    expect(after.work_branch).toBe("");
    expect(after.base_sha).toBe("");

    // The driver saw the same: its cwd fallback resolves to the repo itself.
    const [taskArg, projectArg] = runTurnMock.mock.calls[0] as [Task, { repo_path: string }];
    expect(taskArg.worktree_path).toBe("");
    expect(projectArg.repo_path).toBe(repo);
  });

  it("persists via createProject and updateProject", async () => {
    const p = createProject({ name: "Toggle", repo_path: await makeRepo() });
    expect(p.run_in_repo).toBe(1);
    expect(updateProject(p.id, { run_in_repo: 0 })!.run_in_repo).toBe(0);
    expect(updateProject(p.id, { run_in_repo: 1 })!.run_in_repo).toBe(1);
    expect(createProject({ name: "Explicit0", run_in_repo: 0 }).run_in_repo).toBe(0);
  });

  it("merge/sync/diff endpoints reject or report non-isolated for repo-direct tasks", async () => {
    const project = createProject({ name: "Guards", repo_path: await makeRepo(), run_in_repo: 1 });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    await runOneTurn(task.id);
    const params = { params: Promise.resolve({ id: task.id }) };

    const merge = await mergePost(new Request("http://test/merge", { method: "POST", body: "{}" }), params);
    expect(merge.status).toBe(400);

    const prepare = await mergePreparePost(new Request("http://test/prepare", { method: "POST", body: "{}" }), params);
    expect(prepare.status).toBe(400);

    const sync = await syncGet(new Request("http://test/sync"), params);
    expect(((await sync.json()) as { isolated: boolean }).isolated).toBe(false);

    const syncFf = await syncPost(new Request("http://test/sync", { method: "POST", body: "{}" }), params);
    expect(syncFf.status).toBe(400);

    const diff = await diffGet(new Request("http://test/diff"), params);
    const diffBody = (await diff.json()) as { isolated: boolean; workspacePath: string };
    expect(diffBody.isolated).toBe(false);
    expect(diffBody.workspacePath).toBe(project.repo_path);
  });

  it("a task that already has a worktree keeps it after the project toggle flips", async () => {
    const project = createProject({ name: "Grandfather", repo_path: await makeRepo(), run_in_repo: 0 });
    const task = createTask({
      project_id: project.id,
      title: "T",
      description: "d",
      workspace_mode: "worktree",
    });
    await runOneTurn(task.id);
    const isolated = getTask(task.id)!;
    expect(isolated.worktree_path).not.toBe("");

    updateProject(project.id, { run_in_repo: 1 });
    await runOneTurn(task.id);
    expect(getTask(task.id)!.worktree_path).toBe(isolated.worktree_path);
  });
});
