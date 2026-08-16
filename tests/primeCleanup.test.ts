import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LITELLM_PRIME_HOME } from "@/lib/config";
import { ensurePrimeTaskDirs, removePrimeTaskState } from "@/lib/agents/prime/session-paths";
import { createProject, createTask, getTask } from "@/lib/store";
import { registerTurn, unregisterTurn, hasTurn } from "@/lib/abort";
import { DELETE } from "@/app/api/tasks/[id]/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(() => {
  rmSync(LITELLM_PRIME_HOME, { recursive: true, force: true });
});

describe("removePrimeTaskState", () => {
  it("removes only the target task's state; siblings stay byte-for-byte", () => {
    const a = ensurePrimeTaskDirs("task-a", 0);
    const b = ensurePrimeTaskDirs("task-b", 0);
    writeFileSync(path.join(a.sessionDir, "session.jsonl"), "a-data\n");
    writeFileSync(path.join(b.sessionDir, "session.jsonl"), "b-data\n");

    removePrimeTaskState("task-a");

    expect(existsSync(a.taskHome)).toBe(false);
    expect(readFileSync(path.join(b.sessionDir, "session.jsonl"), "utf8")).toBe("b-data\n");
  });

  it("rejects traversal and separator task ids", () => {
    for (const bad of ["..", ".", "a/../b", "a/b", "a\\b", "", "  "]) {
      expect(() => removePrimeTaskState(bad)).toThrow();
    }
  });

  it("removes a symlinked task home as a link without following it", () => {
    mkdirSync(LITELLM_PRIME_HOME, { recursive: true, mode: 0o700 });
    const outside = path.join(os.tmpdir(), `prime-cleanup-target-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "keep.txt"), "precious\n");
    symlinkSync(outside, path.join(LITELLM_PRIME_HOME, "task-link"));

    removePrimeTaskState("task-link");

    expect(existsSync(path.join(LITELLM_PRIME_HOME, "task-link"))).toBe(false);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("precious\n");
    rmSync(outside, { recursive: true, force: true });
  });

  it("is a no-op when the task never ran Prime", () => {
    expect(() => removePrimeTaskState("task-never-prime")).not.toThrow();
  });
});

describe("task deletion retires Prime state", () => {
  it("hard delete removes the task's Prime directory while idle", async () => {
    const project = createProject({ name: "PrimeDelIdle" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    const dirs = ensurePrimeTaskDirs(task.id, 0);
    writeFileSync(path.join(dirs.sessionDir, "session.jsonl"), "history\n");
    const other = ensurePrimeTaskDirs("task-other", 0);

    const res = await DELETE(new Request("http://x"), params(task.id));
    expect(res.status).toBe(200);
    expect(getTask(task.id)).toBeUndefined();
    expect(existsSync(dirs.taskHome)).toBe(false);
    expect(existsSync(other.taskHome)).toBe(true);
  });

  it("aborts a live turn first, then removes the Prime directory", async () => {
    const project = createProject({ name: "PrimeDelLive" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    const dirs = ensurePrimeTaskDirs(task.id, 1);
    const controller = new AbortController();
    registerTurn(task.id, controller);
    controller.signal.addEventListener(
      "abort",
      () => unregisterTurn(task.id, controller),
      { once: true },
    );

    await DELETE(new Request("http://x"), params(task.id));

    expect(controller.signal.aborted).toBe(true);
    expect(hasTurn(task.id)).toBe(false);
    expect(existsSync(dirs.taskHome)).toBe(false);
  });
});

describe("/clear generation rollover", () => {
  it("keeps prior generations' session dirs alongside the new one", () => {
    const gen0 = ensurePrimeTaskDirs("task-gens", 0);
    writeFileSync(path.join(gen0.sessionDir, "session.jsonl"), "gen0\n");
    const gen1 = ensurePrimeTaskDirs("task-gens", 1);
    expect(readFileSync(path.join(gen0.sessionDir, "session.jsonl"), "utf8")).toBe("gen0\n");
    expect(existsSync(gen1.sessionDir)).toBe(true);
    expect(gen0.sessionDir).not.toBe(gen1.sessionDir);
  });
});
