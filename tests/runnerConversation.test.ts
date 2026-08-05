import { beforeEach, describe, expect, it, vi } from "vitest";

const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Claude",
    runTurn: (
      task: unknown,
      project: unknown,
      userText: string,
      abort?: AbortController,
    ) => runTurnMock(task, project, userText, abort),
  },
}));

vi.mock("@/lib/agents/codex/driver", () => ({
  codexDriver: {
    id: "codex",
    label: "Scripted Codex",
    runTurn: (
      task: unknown,
      project: unknown,
      userText: string,
      abort?: AbortController,
    ) => runTurnMock(task, project, userText, abort),
  },
}));

import { subscribe } from "../lib/events";
import { getDb } from "../lib/db";
import { startResumeTurn } from "../lib/runner";
import {
  createProject,
  createTask,
  getTask,
  updateProject,
} from "../lib/store";
import { activateWorkstream } from "../lib/workstreams/store";
import { queueWorkstreamConversationRegistration } from "../lib/workstreams/worker";
import type { StreamEvent } from "../lib/types";

function script(events: StreamEvent[]) {
  runTurnMock.mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

function waitForTurnEnd(taskId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribe(taskId, (event) => {
      if (event.type === "turn_end") {
        unsubscribe();
        resolve();
      }
    });
  });
}

function conversationRows(taskId: string): Array<{
  event_type: string;
  idempotency_key: string;
  payload: string;
}> {
  return getDb()
    .prepare(
      `SELECT o.event_type, o.idempotency_key, o.payload
       FROM workstream_outbox o
       JOIN workstream_links l ON l.id = o.link_id
       WHERE l.task_id = ? AND o.event_type = 'conversation_registration'
       ORDER BY o.created_at, o.id`,
    )
    .all(taskId) as Array<{
    event_type: string;
    idempotency_key: string;
    payload: string;
  }>;
}

beforeEach(() => {
  runTurnMock.mockReset();
});

describe("linked conversation registration from runner session events", () => {
  it("deduplicates the exact linked card and session independently of metadata", () => {
    const project = createProject({
      name: `Conversation identity ${Date.now()} ${Math.random()}`,
    });
    const task = createTask({
      project_id: project.id,
      title: "Stable conversation identity",
    });
    activateWorkstream({
      taskId: task.id,
      provider: "ardent",
      externalCardId: `card-conversation-identity-${Math.random()}`,
      externalWorkstreamId: `remote-conversation-identity-${Math.random()}`,
    });

    const first = queueWorkstreamConversationRegistration({
      taskId: task.id,
      sessionId: "shared-exact-session",
      source: "claude",
      title: "First metadata",
    });
    const retry = queueWorkstreamConversationRegistration({
      taskId: task.id,
      sessionId: "shared-exact-session",
      source: "codex",
      title: "Retry metadata",
    });

    expect(retry?.id).toBe(first?.id);
    expect(conversationRows(task.id)).toHaveLength(1);
  });

  it.each([
    ["claude", "claude-session-1", "claude"],
    ["codex", "019fca68-fdfd-77d2-ad8f-644df9d13e8a", "codex"],
  ] as const)(
    "durably queues the first exact %s session once",
    async (agent, sessionId, expectedSource) => {
      const project = createProject({
        name: `Wobbe ${agent} ${Date.now()} ${Math.random()}`,
        repo_path: `/Users/private/${agent}-project`,
      });
      updateProject(project.id, { default_agent: agent });
      const task = createTask({
        project_id: project.id,
        title: "Review closing package",
      });
      activateWorkstream({
        taskId: task.id,
        provider: "ardent",
        externalCardId: `card-${agent}-${Math.random()}`,
        externalWorkstreamId: `remote-${agent}-${Math.random()}`,
      });
      script([
        { type: "session", sessionId },
        { type: "session", sessionId },
        { type: "assistant", content: "Reviewing." },
        { type: "done", sessionId },
      ]);

      const done = waitForTurnEnd(task.id);
      await startResumeTurn(task, project, "go");
      await done;

      const rows = conversationRows(task.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe("conversation_registration");
      expect(rows[0].idempotency_key).toContain(sessionId);
      expect(JSON.parse(rows[0].payload)).toEqual({
        session_id: sessionId,
        source: expectedSource,
        title: `${project.name}: ${task.title}`,
        project_path: project.repo_path,
      });

      script([
        { type: "session", sessionId },
        { type: "done", sessionId },
      ]);
      const secondDone = waitForTurnEnd(task.id);
      await startResumeTurn(getTask(task.id)!, project, "continue");
      await secondDone;
      expect(conversationRows(task.id)).toHaveLength(1);
    },
  );

  it("does not queue missing or synthetic session values", async () => {
    const project = createProject({
      name: `Synthetic session ${Date.now()} ${Math.random()}`,
      repo_path: "/Users/private/synthetic-project",
    });
    const task = createTask({
      project_id: project.id,
      title: "Do not register placeholders",
    });
    activateWorkstream({
      taskId: task.id,
      provider: "ardent",
      externalCardId: `card-synthetic-${Math.random()}`,
      externalWorkstreamId: `remote-synthetic-${Math.random()}`,
    });
    script([
      { type: "session", sessionId: "" },
      { type: "session", sessionId: "synthetic" },
      { type: "done", sessionId: "synthetic" },
    ]);

    const done = waitForTurnEnd(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    expect(conversationRows(task.id)).toEqual([]);
  });

  it("keeps the coding turn successful when durable queueing fails", async () => {
    const project = createProject({
      name: `Queue isolation ${Date.now()} ${Math.random()}`,
    });
    const task = createTask({
      project_id: project.id,
      title: "Keep coding",
    });
    activateWorkstream({
      taskId: task.id,
      provider: "ardent",
      externalCardId: `card-queue-isolation-${Math.random()}`,
      externalWorkstreamId: `remote-queue-isolation-${Math.random()}`,
    });
    getDb().exec(`
      CREATE TRIGGER reject_conversation_registration
      BEFORE INSERT ON workstream_outbox
      WHEN NEW.event_type = 'conversation_registration'
      BEGIN
        SELECT RAISE(ABORT, 'forced registration failure');
      END;
    `);
    script([
      { type: "session", sessionId: "claude-session-safe" },
      { type: "assistant", content: "Coding continued." },
      { type: "done", sessionId: "claude-session-safe" },
    ]);

    try {
      const done = waitForTurnEnd(task.id);
      await startResumeTurn(task, project, "go");
      await done;
      expect(conversationRows(task.id)).toEqual([]);
    } finally {
      getDb().exec("DROP TRIGGER reject_conversation_registration");
    }
  });
});
