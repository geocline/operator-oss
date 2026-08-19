import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskCwd } from "@/lib/agents/shared";
import type { Project, Task } from "@/lib/types";

// taskCwd resolves the directory an agent session starts in: workspace root
// (worktree if set, else repo_path) descended into the task's optional
// starting subfolder — with escapes rejected and missing folders degrading to
// the root instead of failing the turn.
describe("taskCwd", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-cwd-"));
  mkdirSync(join(root, "deals", "stonegate"), { recursive: true });
  const project = { repo_path: root } as Project;
  const task = (subdir: string, worktree = "") => ({ subdir, worktree_path: worktree } as Task);

  it("descends into an existing subfolder of the project", () => {
    expect(taskCwd(task("deals/stonegate"), project)).toBe(join(root, "deals", "stonegate"));
  });

  it("falls back to the root when the subfolder is missing", () => {
    expect(taskCwd(task("deals/renamed"), project)).toBe(root);
  });

  it("rejects escapes and absolute paths", () => {
    expect(taskCwd(task("../outside"), project)).toBe(root);
    expect(taskCwd(task("deals/../../outside"), project)).toBe(root);
    expect(taskCwd(task("/etc"), project)).toBe(root);
  });

  it("prefers the worktree as the workspace root", () => {
    const wt = mkdtempSync(join(tmpdir(), "orch-wt-"));
    mkdirSync(join(wt, "deals"), { recursive: true });
    expect(taskCwd(task("deals", wt), project)).toBe(join(wt, "deals"));
  });

  it("ignores an empty subdir", () => {
    expect(taskCwd(task(""), project)).toBe(root);
  });
});
