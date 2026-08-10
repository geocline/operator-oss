import { describe, it, expect, beforeEach, vi } from "vitest";

// Per-project "Run tasks directly in the project folder" (projects.run_in_repo):
// tasks skip worktree isolation entirely — worktree_path stays "", the agent
// session runs in project.repo_path, and the diff/sync/merge surfaces report
// non-isolated instead of erroring. Drives a scripted fake driver through the
// real routes + runner, like tests/turnRace.test.ts.
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

describe("run_in_repo projects", () => {
  it("defaults ON: new projects run tasks directly in the repo", async () => {
    const project = createProject({ name: "Default", repo_path: await makeRepo() });
    expect(project.run_in_repo).toBe(1);
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    await runOneTurn(task.id);
    const after = getTask(task.id)!;
    expect(after.worktree_path).toBe("");
    expect(after.work_branch).toBe("");
  });

  it("opting out restores per-task worktree isolation", async () => {
    const project = createProject({ name: "OptOut", repo_path: await makeRepo(), run_in_repo: 0 });
    expect(project.run_in_repo).toBe(0);
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    await runOneTurn(task.id);
    const after = getTask(task.id)!;
    expect(after.worktree_path).not.toBe("");
    expect(after.work_branch).not.toBe("");
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

  it("a task that already has a worktree keeps it after the toggle flips on", async () => {
    const project = createProject({ name: "Grandfather", repo_path: await makeRepo(), run_in_repo: 0 });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    await runOneTurn(task.id);
    const isolated = getTask(task.id)!;
    expect(isolated.worktree_path).not.toBe("");

    updateProject(project.id, { run_in_repo: 1 });
    await runOneTurn(task.id);
    expect(getTask(task.id)!.worktree_path).toBe(isolated.worktree_path);
  });
});
