import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createProject, createTask, getTask, updateTask } from "../lib/store";
import {
  activateWorkstream,
  getWorkstreamOutboxEvent,
  setWorkstreamState,
} from "../lib/workstreams/store";
import {
  WORKSTREAM_LIFECYCLE_MESSAGES,
  queueWorkstreamLifecycle,
} from "../lib/workstreams/worker";

function linkedTask(label: string) {
  const project = createProject({
    name: `Lifecycle ${label} ${Date.now()} ${Math.random()}`,
  });
  const task = createTask({ project_id: project.id, title: label });
  const link = activateWorkstream({
    taskId: task.id,
    provider: "ardent",
    externalCardId: `card-${label}-${Math.random()}`,
    externalWorkstreamId: `remote-${label}-${Math.random()}`,
  });
  return { task, link };
}

describe("workstream lifecycle templates", () => {
  it("uses fixed privacy-safe text for every lifecycle event", () => {
    expect(WORKSTREAM_LIFECYCLE_MESSAGES).toEqual({
      activation: "This work is connected for updates.",
      work_started: "Work has started.",
      input_needed: "Input is needed before work can continue.",
      paused: "Updates are paused.",
      resumed: "Updates have resumed.",
      manual_completion: "Work is complete.",
    });
  });

  it("queues only deterministic templates and deduplicates the same occurrence", () => {
    const { task } = linkedTask("templates");
    const first = queueWorkstreamLifecycle(
      task.id,
      "work_started",
      "generation-1",
    );
    const duplicate = queueWorkstreamLifecycle(
      task.id,
      "work_started",
      "generation-1",
    );
    const input = queueWorkstreamLifecycle(
      task.id,
      "input_needed",
      "question-1",
    );

    expect(first?.id).toBe(duplicate?.id);
    expect(first?.payload).toEqual({
      body: WORKSTREAM_LIFECYCLE_MESSAGES.work_started,
      attachments: [],
    });
    expect(input?.payload).toEqual({
      body: WORKSTREAM_LIFECYCLE_MESSAGES.input_needed,
      attachments: [],
    });
    for (const [kind, occurrence] of [
      ["activation", "remote-1"],
      ["paused", "pause-1"],
      ["resumed", "resume-1"],
    ] as const) {
      expect(
        queueWorkstreamLifecycle(task.id, kind, occurrence)?.payload,
      ).toEqual({
        body: WORKSTREAM_LIFECYCLE_MESSAGES[kind],
        attachments: [],
      });
    }
  });

  it("blocks future lifecycle queueing after disconnect", () => {
    const { task, link } = linkedTask("disconnected");
    setWorkstreamState(link.id, "disconnected");

    expect(
      queueWorkstreamLifecycle(task.id, "input_needed", "question-1"),
    ).toBeUndefined();
  });

  it("queues completion only for an explicit manual status transition", async () => {
    const { task } = linkedTask("manual-completion");
    const route = await import("../app/api/tasks/[id]/route");

    const response = await route.PATCH(
      new Request(`http://operator.test/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);

    const rows = (
      await import("../lib/db")
    ).getDb()
      .prepare(
        "SELECT id, event_type FROM workstream_outbox WHERE link_id = (SELECT id FROM workstream_links WHERE task_id = ?) ORDER BY created_at, event_type",
      )
      .all(task.id) as { id: string; event_type: string }[];
    expect(rows).toHaveLength(2);
    const comment = rows.find((row) => row.event_type === "routine_update")!;
    const proposal = rows.find((row) => row.event_type === "proposed_change")!;
    expect(getWorkstreamOutboxEvent(comment.id)?.payload).toEqual({
      body: WORKSTREAM_LIFECYCLE_MESSAGES.manual_completion,
      attachments: [],
    });
    expect(getWorkstreamOutboxEvent(proposal.id)?.payload).toEqual({
      kind: "complete_card",
      payload: {},
    });

    await route.PATCH(
      new Request(`http://operator.test/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const count = (
      await import("../lib/db")
    ).getDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM workstream_outbox WHERE link_id = (SELECT id FROM workstream_links WHERE task_id = ?)",
      )
      .get(task.id) as { count: number };
    expect(count.count).toBe(2);
    expect(getTask(task.id)?.status).toBe("done");
  });

  it("integrates work-start and input-needed notices without inferring completion from turn end", async () => {
    const runner = await readFile(
      new URL("../lib/runner.ts", import.meta.url),
      "utf8",
    );
    expect(runner).toMatch(
      /ev\.type === "session"[\s\S]*queueWorkstreamLifecycle\([\s\S]*"work_started"/,
    );
    expect(runner).toMatch(
      /ev\.type === "ask"[\s\S]*queueWorkstreamLifecycle\([\s\S]*"input_needed"/,
    );
    expect(runner).not.toMatch(
      /queueWorkstreamLifecycle\([^)]*"manual_completion"/,
    );
    const finallyBlock = runner.slice(runner.indexOf("} finally {"));
    expect(finallyBlock).toMatch(
      /if \(!continued\)[\s\S]*queueWorkstreamLifecycle\([\s\S]*"input_needed"/,
    );
    expect(finallyBlock).not.toContain('"manual_completion"');
  });

  it("does not treat an ordinary completed turn as manual card completion", () => {
    const { task } = linkedTask("ordinary-turn");
    updateTask(task.id, {
      started: 1,
      running: 0,
      awaiting_input: 1,
      status: "in_progress",
    });
    expect(getTask(task.id)?.status).toBe("in_progress");
  });
});
