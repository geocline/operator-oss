// Notifications: the wire payload GET /api/events puts on the bus, and the
// mapping from those events to banners.
//
// The bug this replaces was structural, not cosmetic: the old notifier read the
// selected project's task rows, so an agent parked in any OTHER project could
// never notify. The fix is that the global stream carries the task title and
// project name itself, which is what these tests pin.

import { describe, it, expect, beforeEach } from "vitest";
import { createProject, createTask, updateTask } from "@/lib/store";
import { publish } from "@/lib/events";
import type { GlobalWireEvent } from "@/lib/events";
import { GET as eventsGet } from "@/app/api/events/route";
import { describeEvent, notifyEnabled } from "@/app/orchestrator/notifications";
import { DEFAULT_SETTINGS } from "@/app/orchestrator/types";

const label = (id: string) => (id === "codex" ? "Codex" : "Claude Code");

// Open the SSE stream, run `fire`, and collect the events it produced.
async function capture(fire: () => void, count: number): Promise<GlobalWireEvent[]> {
  const controller = new AbortController();
  const res = await eventsGet(new Request("http://test/api/events", { signal: controller.signal }));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: GlobalWireEvent[] = [];
  fire();
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (line.startsWith("data: ")) out.push(JSON.parse(line.slice(6)) as GlobalWireEvent);
    }
  }
  controller.abort();
  return out;
}

describe("global lifecycle payload", () => {
  it("carries the task title, project name, and agent so any project can be described", async () => {
    const project = createProject({ name: "Payments" });
    const task = createTask({ project_id: project.id, title: "Fix the webhook retry" });
    updateTask(task.id, { running: 1, status: "in_progress" });

    const [ev] = await capture(() => publish(task.id, { type: "ask", id: "a1", questions: [] }), 1);

    expect(ev).toMatchObject({
      type: "task",
      event: "awaiting_input",
      taskId: task.id,
      projectId: project.id,
      title: "Fix the webhook retry",
      projectName: "Payments",
      agent: "claude",
    });
  });

  it("reports a failed turn, classified so the client never parses provider text", async () => {
    const project = createProject({ name: "Billing" });
    const task = createTask({ project_id: project.id, title: "Nightly job" });

    const [plain] = await capture(
      () => publish(task.id, { type: "error", content: "TypeError: undefined is not a function" }),
      1,
    );
    expect(plain).toMatchObject({ event: "turn_failed", failure: "error" });

    const [limited] = await capture(
      () => publish(task.id, { type: "error", content: "Claude AI usage limit reached" }),
      1,
    );
    expect(limited).toMatchObject({ event: "turn_failed", failure: "limit" });
  });

  it("carries the persisted turn_started_at anchor so every viewer's elapsed clock agrees", async () => {
    const project = createProject({ name: "Payments" });
    const task = createTask({ project_id: project.id, title: "Fix the webhook retry" });
    const startedAt = Date.now();
    updateTask(task.id, { running: 1, status: "in_progress", turn_started_at: startedAt });

    const [running] = await capture(() => publish(task.id, { type: "session", sessionId: "s1" }), 1);
    expect(running).toMatchObject({ event: "turn_started", turn_started_at: startedAt });

    // Once the runner settles the row, the anchor is cleared back to null so a
    // stale clock never lingers past the turn it belonged to.
    updateTask(task.id, { running: 0, awaiting_input: 1, turn_started_at: null });
    const [ended] = await capture(() => publish(task.id, { type: "turn_end" }), 1);
    expect(ended).toMatchObject({ event: "turn_end", turn_started_at: null });
  });
});

const taskEvent = (over: Partial<Extract<GlobalWireEvent, { type: "task" }>> = {}) => ({
  type: "task" as const,
  event: "turn_end" as const,
  taskId: "t1",
  projectId: "p1",
  running: false,
  awaiting_input: true,
  status: "in_progress" as const,
  awaiting_count: 1,
  title: "Fix the webhook retry",
  projectName: "Payments",
  agent: "claude",
  turn_started_at: null,
  ...over,
});

describe("event to notification", () => {
  it("names the project, because the task may be one you cannot see", () => {
    const req = describeEvent(taskEvent({ event: "awaiting_input" }), label);
    expect(req).toMatchObject({
      kind: "question",
      title: "Claude Code has a question",
      body: "Payments · Fix the webhook retry",
      target: { projectId: "p1", taskId: "t1" },
    });
  });

  it("separates a finished turn from a question, which the task row alone cannot", () => {
    // Both states have awaiting_input=1 on the row: a turn that ends mid-task is
    // ALWAYS flagged as waiting on the user. Only the event tells them apart.
    expect(describeEvent(taskEvent({ event: "turn_end" }), label)).toMatchObject({
      kind: "finished",
      title: "Claude Code finished a turn",
    });
  });

  it("drops the per-task copy of a dead login in favour of the instance-wide one", () => {
    expect(describeEvent(taskEvent({ event: "turn_failed", failure: "auth" }), label)).toBeNull();
    expect(
      describeEvent({ type: "agent_auth", agent: "codex", broken: true, reason: "401" }, label),
    ).toMatchObject({ kind: "agent", title: "Codex needs reconnecting" });
    // A recovered login is good news, not an interruption.
    expect(
      describeEvent({ type: "agent_auth", agent: "codex", broken: false, reason: null }, label),
    ).toBeNull();
  });

  it("says what to do about a spent quota rather than just reporting a failure", () => {
    expect(describeEvent(taskEvent({ event: "turn_failed", failure: "limit" }), label)).toMatchObject({
      kind: "failed",
      title: "Claude Code hit its usage limit",
    });
  });

  it("stays quiet for boundaries that are not worth an interruption", () => {
    for (const event of ["turn_started", "ask_answered", "suggested", "task_updated"] as const) {
      expect(describeEvent(taskEvent({ event }), label)).toBeNull();
    }
    // A turn that ended on a task the user already closed out is not news.
    expect(describeEvent(taskEvent({ status: "done" }), label)).toBeNull();
    expect(describeEvent({ type: "task_deleted", taskId: "t1", projectId: "p1", awaiting_count: 0 }, label)).toBeNull();
  });
});

describe("notification preferences", () => {
  beforeEach(() => {});

  it("defaults every kind on, since an unseen prompt is the same as off", () => {
    for (const kind of ["question", "finished", "failed", "agent"] as const) {
      expect(notifyEnabled(DEFAULT_SETTINGS, kind)).toBe(true);
    }
  });

  it("honors an explicit opt-out", () => {
    expect(notifyEnabled({ ...DEFAULT_SETTINGS, notifyFinished: false }, "finished")).toBe(false);
    expect(notifyEnabled({ ...DEFAULT_SETTINGS, notifyFinished: false }, "question")).toBe(true);
  });
});
