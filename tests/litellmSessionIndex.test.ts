import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendOperatorSessionIndex } from "@/lib/agents/litellm/session-index";

describe("Operator LiteLLM session index", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("appends content-free 0600 metadata for Conversation Dashboard", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "operator-session-index-"));
    dirs.push(home);
    const file = appendOperatorSessionIndex(home, {
      session_id: "thread-123",
      task_id: "task-1",
      project_id: "project-1",
      task_title: "Implement feature",
      project_path: "/workspace/project",
      harness: "codex",
      model: "operator.frontier",
      updated_at: "2026-08-07T12:00:00.000Z",
    });
    const row = JSON.parse(readFileSync(file, "utf8").trim());
    expect(row).toEqual(expect.objectContaining({
      session_id: "thread-123",
      task_id: "task-1",
      harness: "codex",
      model: "operator.frontier",
    }));
    expect(JSON.stringify(row)).not.toMatch(/prompt|response|api.key|environment/i);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("accepts prime harness records without changing the JSONL format", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "operator-session-index-"));
    dirs.push(home);
    const file = appendOperatorSessionIndex(home, {
      session_id: "prime-abc",
      task_id: "task-2",
      project_id: "project-1",
      task_title: "Prime task",
      project_path: "/workspace/project",
      harness: "prime",
      model: "operator.kimi-k3",
      updated_at: "2026-08-10T12:00:00.000Z",
    });
    const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      harness: "prime",
      model: "operator.kimi-k3",
    }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
