import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { LITELLM_KIMI_CODE_HOME } from "@/lib/config";
import {
  assertKimiCodeSettlement,
  ensureKimiCodeTaskHome,
  readKimiCodeIsolationEvidence,
  removeKimiCodeTaskState,
} from "@/lib/agents/kimi-code/session-paths";
import { createProject, createTask, getProject, getTask } from "@/lib/store";
import { DELETE as deleteTask } from "@/app/api/tasks/[id]/route";
import { DELETE as deleteProject } from "@/app/api/projects/[id]/route";
import { settleKimiCodeTask } from "@/lib/agents/kimi-code/driver";
import { POST as postMessage } from "@/app/api/tasks/[id]/messages/route";
import {
  claimTurn,
  isTaskDeleting,
  unregisterTurn,
} from "@/lib/abort";

vi.mock("@/lib/agents/kimi-code/driver", () => ({
  settleKimiCodeTask: vi.fn().mockResolvedValue(undefined),
}));

const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(() => {
  vi.mocked(settleKimiCodeTask).mockReset().mockResolvedValue(undefined);
  rmSync(LITELLM_KIMI_CODE_HOME, { recursive: true, force: true });
});

describe("Kimi Code task state retirement", () => {
  it("requires and summarizes names-only isolation evidence from real child settlements", () => {
    const home = ensureKimiCodeTaskHome("task-attestation");
    const settlements = path.join(home, "settlements");
    const valid = path.join(settlements, "valid.json");
    writeFileSync(valid, JSON.stringify({
      status: "settled",
      survivors: [],
      child_environment: {
        credential_keys: ["KIMI_API_KEY"],
        home_is_task_home: true,
      },
    }));

    expect(() => assertKimiCodeSettlement(valid)).not.toThrow();
    expect(readKimiCodeIsolationEvidence("task-attestation")).toEqual({
      taskStateIsolated: true,
      relayCredentialOnly: true,
      ambientCredentialLeak: false,
    });

    const invalid = path.join(settlements, "invalid.json");
    writeFileSync(invalid, JSON.stringify({
      status: "settled",
      survivors: [],
      child_environment: {
        credential_keys: ["GITHUB_TOKEN", "KIMI_API_KEY"],
        home_is_task_home: false,
      },
    }));
    expect(() => assertKimiCodeSettlement(invalid)).toThrow(/isolation/i);
    expect(readKimiCodeIsolationEvidence("task-attestation")).toEqual({
      taskStateIsolated: false,
      relayCredentialOnly: false,
      ambientCredentialLeak: true,
    });
  });

  it("removes only the target task and preserves sibling bytes", () => {
    const a = ensureKimiCodeTaskHome("task-a");
    const b = ensureKimiCodeTaskHome("task-b");
    writeFileSync(path.join(a, "session.jsonl"), "a\n");
    writeFileSync(path.join(b, "session.jsonl"), "b\n");

    removeKimiCodeTaskState("task-a");

    expect(existsSync(a)).toBe(false);
    expect(readFileSync(path.join(b, "session.jsonl"), "utf8")).toBe("b\n");
  });

  it("rejects traversal and removes symlinks without following them", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../escape"]) {
      expect(() => removeKimiCodeTaskState(bad)).toThrow(/task id/i);
    }
    mkdirSync(LITELLM_KIMI_CODE_HOME, { recursive: true, mode: 0o700 });
    const outside = path.join(os.tmpdir(), `kimi-cleanup-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "keep.txt"), "precious\n");
    symlinkSync(outside, path.join(LITELLM_KIMI_CODE_HOME, "task-link"));

    removeKimiCodeTaskState("task-link");

    expect(existsSync(path.join(LITELLM_KIMI_CODE_HOME, "task-link"))).toBe(false);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("precious\n");
    rmSync(outside, { recursive: true, force: true });
  });

  it("task deletion removes the Kimi Code task home", async () => {
    const project = createProject({ name: "KimiDeleteTask" });
    const task = createTask({ project_id: project.id, title: "T" });
    const home = ensureKimiCodeTaskHome(task.id);
    writeFileSync(path.join(home, "session.jsonl"), "history\n");

    const response = await deleteTask(new Request("http://x"), params(task.id));

    expect(response.status).toBe(200);
    expect(getTask(task.id)).toBeUndefined();
    expect(existsSync(home)).toBe(false);
  });

  it("refuses task deletion when Kimi process settlement cannot be proven", async () => {
    const project = createProject({ name: "KimiDeleteBlocked" });
    const task = createTask({ project_id: project.id, title: "T" });
    const home = ensureKimiCodeTaskHome(task.id);
    writeFileSync(path.join(home, "session.jsonl"), "history\n");
    vi.mocked(settleKimiCodeTask).mockRejectedValueOnce(
      new Error("process settlement timed out"),
    );

    const response = await deleteTask(new Request("http://x"), params(task.id));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/could not be settled/i),
    });
    expect(getTask(task.id)).toBeDefined();
    expect(existsSync(home)).toBe(true);
    expect(isTaskDeleting(task.id)).toBe(false);
    const controller = claimTurn(task.id);
    expect(controller).not.toBeNull();
    unregisterTurn(task.id, controller!);
  });

  it("blocks a concurrent successor turn throughout task teardown", async () => {
    const project = createProject({
      name: "KimiDeleteRace",
      repo_path: process.env.ORCH_TEST_TMP!,
    });
    const task = createTask({ project_id: project.id, title: "T" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(settleKimiCodeTask).mockImplementationOnce(() => held);

    const deleting = deleteTask(new Request("http://x"), params(task.id));
    await vi.waitFor(() => expect(isTaskDeleting(task.id)).toBe(true));
    const message = await postMessage(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ text: "race successor" }),
      }),
      params(task.id),
    );

    expect(message.status).toBe(409);
    expect(await message.json()).toMatchObject({
      error: expect.stringMatching(/delet/i),
    });
    release();
    expect((await deleting).status).toBe(200);
  });

  it("project deletion removes every Kimi task home before the cascade", async () => {
    const project = createProject({ name: "KimiDeleteProject" });
    const first = createTask({ project_id: project.id, title: "A" });
    const second = createTask({ project_id: project.id, title: "B" });
    const firstHome = ensureKimiCodeTaskHome(first.id);
    const secondHome = ensureKimiCodeTaskHome(second.id);

    const response = await deleteProject(new Request("http://x"), params(project.id));

    expect(response.status).toBe(200);
    expect(getProject(project.id)).toBeUndefined();
    expect(existsSync(firstHome)).toBe(false);
    expect(existsSync(secondHome)).toBe(false);
  });

  it("refuses project deletion when any Kimi process tree is unsettled", async () => {
    const project = createProject({ name: "KimiProjectBlocked" });
    const first = createTask({ project_id: project.id, title: "A" });
    const firstHome = ensureKimiCodeTaskHome(first.id);
    vi.mocked(settleKimiCodeTask).mockRejectedValueOnce(
      new Error("process settlement timed out"),
    );

    const response = await deleteProject(new Request("http://x"), params(project.id));

    expect(response.status).toBe(409);
    expect(getProject(project.id)).toBeDefined();
    expect(getTask(first.id)).toBeDefined();
    expect(existsSync(firstHome)).toBe(true);
  });

  it("blocks successor turns for every task during project teardown", async () => {
    const project = createProject({
      name: "KimiProjectRace",
      repo_path: process.env.ORCH_TEST_TMP!,
    });
    const first = createTask({ project_id: project.id, title: "A" });
    const second = createTask({ project_id: project.id, title: "B" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(settleKimiCodeTask)
      .mockImplementationOnce(() => held)
      .mockResolvedValueOnce(undefined);

    const deleting = deleteProject(new Request("http://x"), params(project.id));
    await vi.waitFor(() => {
      expect(isTaskDeleting(first.id)).toBe(true);
      expect(isTaskDeleting(second.id)).toBe(true);
    });
    const message = await postMessage(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ text: "race successor" }),
      }),
      params(second.id),
    );

    expect(message.status).toBe(409);
    release();
    expect((await deleting).status).toBe(200);
  });
});
