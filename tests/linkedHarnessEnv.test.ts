import { describe, expect, it } from "vitest";
import { createProject, createTask } from "../lib/store";
import { activateWorkstream } from "../lib/workstreams/store";
import { buildHarnessEnv } from "../lib/agents/shared";

describe("linked harness environment", () => {
  it("preserves the process environment and injects the linked-workstream flag", () => {
    const project = createProject({ name: "Linked harness env" });
    const task = createTask({
      project_id: project.id,
      title: "Linked task",
    });
    activateWorkstream({
      taskId: task.id,
      provider: "ardent",
      externalCardId: "card-linked-env",
      externalWorkstreamId: "remote-linked-env",
    });

    expect(
      buildHarnessEnv(task.id, {
        PATH: "/usr/bin",
        EXISTING_VALUE: "kept",
        EMPTY_VALUE: undefined,
      }),
    ).toEqual({
      PATH: "/usr/bin",
      EXISTING_VALUE: "kept",
      DEAL_TRACKER_LINKED_WORKSTREAM: "1",
    });
  });

  it("omits the flag for an unlinked Operator task even if the parent environment contains it", () => {
    const project = createProject({ name: "Unlinked harness env" });
    const task = createTask({
      project_id: project.id,
      title: "Unlinked task",
    });

    expect(
      buildHarnessEnv(task.id, {
        PATH: "/usr/bin",
        DEAL_TRACKER_LINKED_WORKSTREAM: "1",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("wires the scoped environment into both task harness drivers", async () => {
    const fs = await import("node:fs/promises");
    const claude = await fs.readFile(
      new URL("../lib/agents/claude/driver.ts", import.meta.url),
      "utf8",
    );
    const codex = await fs.readFile(
      new URL("../lib/agents/codex/driver.ts", import.meta.url),
      "utf8",
    );

    expect(claude).toContain("env: overrides.env ?? buildHarnessEnv(task.id)");
    expect(codex).toContain("env: buildHarnessEnv(task.id)");
  });
});
