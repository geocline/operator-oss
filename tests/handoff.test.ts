import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// /handoff server contract: the clear route's `useLastAssistant` body option
// carries the outgoing session's final assistant message (the purpose-written
// handoff document) verbatim into the next generation instead of an
// auto-summary, and `model` rides across the boundary. Plus the messages
// route's typed-initial override: a typed first message replaces the
// title+description priming prompt (the post-/clear "edit your first prompt"
// flow), while the bare Start path keeps the old behavior.
const { runTurnMock, summarizeMock } = vi.hoisted(() => ({ runTurnMock: vi.fn(), summarizeMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
    summarizeTranscript: (transcript: string, project: unknown) => summarizeMock(transcript, project),
  },
}));

import { createProject, createTask, getTask, updateTask, addMessage, listSummaries } from "@/lib/store";
import { POST as clearRoute } from "@/app/api/tasks/[id]/clear/route";
import { POST as messagesRoute } from "@/app/api/tasks/[id]/messages/route";

function clear(taskId: string, body?: unknown) {
  return clearRoute(
    new Request("http://test/clear", { method: "POST", ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) }),
    { params: Promise.resolve({ id: taskId }) }
  );
}

function send(taskId: string, text: string) {
  return messagesRoute(
    new Request("http://test/messages", { method: "POST", body: JSON.stringify({ text }), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ id: taskId }) }
  );
}

beforeEach(() => {
  runTurnMock.mockReset();
  summarizeMock.mockReset();
  summarizeMock.mockResolvedValue("AUTO SUMMARY");
});

describe("/clear with useLastAssistant (the /handoff boundary)", () => {
  it("seeds the next generation with the last assistant message and carries the picked model", async () => {
    const project = createProject({ name: "HandoffDoc" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { started: 1, model: "sonnet" });
    addMessage(task.id, 1, "user", "please write the handoff doc");
    addMessage(task.id, 1, "assistant", "working on it…");
    addMessage(task.id, 1, "assistant", "# HANDOFF\nEverything you need to continue.");

    const res = await clear(task.id, { useLastAssistant: true, model: "opus" });
    const body = (await res.json()) as { summary: string; generation: number };

    // The document is carried verbatim — no lossy re-summarization.
    expect(body.summary).toBe("# HANDOFF\nEverything you need to continue.");
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(listSummaries(task.id)[0].summary).toBe("# HANDOFF\nEverything you need to continue.");

    const t = getTask(task.id)!;
    expect(t.generation).toBe(2);
    expect(t.model).toBe("opus");
    expect(t.resolved_model).toBeNull();
    // The fresh generation waits for the user's opening prompt.
    expect(t.started).toBe(0);
  });

  it("model: null resets to the driver default; omitting model keeps the current one", async () => {
    const project = createProject({ name: "HandoffModel" });
    const a = createTask({ project_id: project.id, title: "A", description: "" });
    updateTask(a.id, { started: 1, model: "sonnet" });
    addMessage(a.id, 1, "assistant", "doc");
    await clear(a.id, { useLastAssistant: true, model: null });
    expect(getTask(a.id)!.model).toBeNull();

    const b = createTask({ project_id: project.id, title: "B", description: "" });
    updateTask(b.id, { started: 1, model: "sonnet" });
    addMessage(b.id, 1, "assistant", "doc");
    await clear(b.id, { useLastAssistant: true });
    expect(getTask(b.id)!.model).toBe("sonnet");
  });

  it("falls back to the auto-summary when the session has no assistant text", async () => {
    const project = createProject({ name: "HandoffFallback" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { started: 1 });
    addMessage(task.id, 1, "user", "only a user message here");

    const res = await clear(task.id, { useLastAssistant: true });
    const body = (await res.json()) as { summary: string };
    expect(body.summary).toBe("AUTO SUMMARY");
    expect(summarizeMock).toHaveBeenCalledTimes(1);
  });
});

describe("typed first message overrides the title+description priming", () => {
  function repoDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-repo-"));
  }
  function scriptedTurn() {
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" };
      yield { type: "done", sessionId: "s1" };
    });
  }
  function turnPrompt(): string {
    return runTurnMock.mock.calls[0][2] as string;
  }
  async function settleTurn() {
    // The detached runner owns the turn after POST returns; give it a beat.
    for (let i = 0; i < 50 && runTurnMock.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  }

  it("uses the typed text as the opening prompt of an unstarted generation", async () => {
    const project = createProject({ name: "TypedFirst", repo_path: repoDir() });
    const task = createTask({ project_id: project.id, title: "Title", description: "Description", workspace_mode: "direct" });
    scriptedTurn();
    const res = await send(task.id, "Read HANDOFF.md before doing anything.");
    expect(res.status).toBe(202);
    await settleTurn();
    expect(turnPrompt()).toBe("Read HANDOFF.md before doing anything.");
  });

  it("keeps title+description when nothing is typed (the Start button path)", async () => {
    const project = createProject({ name: "BareStart", repo_path: repoDir() });
    const task = createTask({ project_id: project.id, title: "Title", description: "Description", workspace_mode: "direct" });
    scriptedTurn();
    const res = await send(task.id, "");
    expect(res.status).toBe(202);
    await settleTurn();
    expect(turnPrompt()).toBe("Title\n\nDescription");
  });
});
