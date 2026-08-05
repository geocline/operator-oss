import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, migrate } from "../lib/db";
import {
  createProject,
  createTask,
  findExternalSessionImport,
  findOrCreateExternalSessionImport,
  recordSession,
  updateTask,
} from "../lib/store";

vi.mock("node:os", () => ({
  default: {
    homedir: () => process.env.ORCH_TEST_TMP!,
  },
}));

const SESSION_ID = "historical-session-exact-id";
const CROSS_SOURCE_SESSION_ID = "same-opaque-id-across-sources";
let GET: typeof import("../app/open/route").GET;
let dashboardDbPath: string;
let projectPath: string;
let transcriptPath: string;

function taskCount(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
      count: number;
    }
  ).count;
}

function sessionCount(taskId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE task_id = ?")
      .get(taskId) as { count: number }
  ).count;
}

function importCount(sessionId: string): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM external_session_imports WHERE external_session_id = ?",
      )
      .get(sessionId) as { count: number }
  ).count;
}

function putDashboardSession(sessionId: string, source: string): void {
  const dashboardDb = new Database(dashboardDbPath);
  dashboardDb
    .prepare(
      `INSERT INTO sessions
       (session_id, title, file_path, project_path, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET source = excluded.source`,
    )
    .run(
      sessionId,
      "Historical exact session",
      transcriptPath,
      projectPath,
      source,
    );
  dashboardDb.close();
}

beforeAll(async () => {
  const testHome = process.env.ORCH_TEST_TMP!;
  const dashboardData = path.join(
    testHome,
    "Claude Projects",
    "conversations-dashboard",
    "data",
  );
  projectPath = path.join(testHome, "historical-project");
  transcriptPath = path.join(testHome, "historical-session.jsonl");
  dashboardDbPath = path.join(dashboardData, "index.db");
  fs.mkdirSync(dashboardData, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Continue this exact work." },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "I have the context." },
      }),
      "",
    ].join("\n"),
  );

  const dashboardDb = new Database(dashboardDbPath);
  dashboardDb.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      file_path TEXT,
      project_path TEXT,
      source TEXT
    )
  `);
  dashboardDb.close();
  putDashboardSession(SESSION_ID, "codex");

  ({ GET } = await import("../app/open/route"));
});

describe("historical session deep link", () => {
  it("redirects repeated imports of the same exact session to the original task", async () => {
    const requestUrl = `http://operator.test/open?session=${SESSION_ID}`;

    const first = await GET(new Request(requestUrl));
    const firstUrl = new URL(first.headers.get("location")!);
    const firstTaskId = firstUrl.searchParams.get("task");
    const firstProjectId = firstUrl.searchParams.get("project");
    const afterFirst = taskCount();

    expect(firstProjectId).toBeTruthy();
    expect(firstTaskId).toBeTruthy();
    recordSession({
      project_id: firstProjectId!,
      task_id: firstTaskId!,
      generation: 1,
      claude_session_id: "live-continuation-session-id",
    });

    const second = await GET(new Request(requestUrl));
    const secondUrl = new URL(second.headers.get("location")!);

    expect(secondUrl.searchParams.get("project")).toBe(firstProjectId);
    expect(secondUrl.searchParams.get("task")).toBe(firstTaskId);
    expect(taskCount()).toBe(afterFirst);
    expect(sessionCount(firstTaskId!)).toBe(1);
  });

  it("keeps identical opaque ids separate across agent sources", async () => {
    putDashboardSession(CROSS_SOURCE_SESSION_ID, "claude");
    const claude = await GET(
      new Request(
        `http://operator.test/open?session=${CROSS_SOURCE_SESSION_ID}&source=claude`,
      ),
    );
    const claudeTaskId = new URL(
      claude.headers.get("location")!,
    ).searchParams.get("task");

    putDashboardSession(CROSS_SOURCE_SESSION_ID, "codex");
    const codex = await GET(
      new Request(
        `http://operator.test/open?session=${CROSS_SOURCE_SESSION_ID}&source=codex`,
      ),
    );
    const codexTaskId = new URL(
      codex.headers.get("location")!,
    ).searchParams.get("task");

    expect(claudeTaskId).toBeTruthy();
    expect(codexTaskId).toBeTruthy();
    expect(codexTaskId).not.toBe(claudeTaskId);
    expect(sessionCount(claudeTaskId!)).toBe(0);
    expect(sessionCount(codexTaskId!)).toBe(0);
    expect(importCount(CROSS_SOURCE_SESSION_ID)).toBe(2);

    const ambiguous = await GET(
      new Request(
        `http://operator.test/open?session=${CROSS_SOURCE_SESSION_ID}`,
      ),
    );
    const ambiguousUrl = new URL(ambiguous.headers.get("location")!);
    expect(ambiguousUrl.pathname).toBe("/");
    expect(ambiguousUrl.searchParams.get("task")).toBeNull();
  });

  it("converges concurrent and later retry requests on one durable task", async () => {
    const sessionId = "concurrent-historical-session";
    putDashboardSession(sessionId, "codex");
    const before = taskCount();
    const requestUrl = `http://operator.test/open?session=${sessionId}&source=codex`;

    const [first, second] = await Promise.all([
      GET(new Request(requestUrl)),
      GET(new Request(requestUrl)),
    ]);
    const firstTaskId = new URL(
      first.headers.get("location")!,
    ).searchParams.get("task");
    const secondTaskId = new URL(
      second.headers.get("location")!,
    ).searchParams.get("task");

    expect(firstTaskId).toBeTruthy();
    expect(secondTaskId).toBe(firstTaskId);
    expect(taskCount()).toBe(before + 1);
    expect(importCount(sessionId)).toBe(1);
    expect(sessionCount(firstTaskId!)).toBe(0);

    const dashboardDb = new Database(dashboardDbPath);
    dashboardDb
      .prepare("UPDATE sessions SET file_path = ? WHERE session_id = ?")
      .run(path.join(projectPath, "missing-transcript.jsonl"), sessionId);
    dashboardDb.close();

    const retry = await GET(new Request(requestUrl));
    expect(
      new URL(retry.headers.get("location")!).searchParams.get("task"),
    ).toBe(firstTaskId);
    expect(taskCount()).toBe(before + 1);
  });

  it("rolls back task creation when a mapping cannot be committed", () => {
    const sessionId = "failed-import-session";
    const tasksBefore = taskCount();
    const importsBefore = importCount(sessionId);

    expect(() =>
      findOrCreateExternalSessionImport({
        source: "codex",
        external_session_id: sessionId,
        project_id: "missing-project",
        title: "Must roll back",
        description: "No orphan task or mapping may survive.",
        agent: "codex",
      }),
    ).toThrow();

    expect(taskCount()).toBe(tasksBefore);
    expect(importCount(sessionId)).toBe(importsBefore);
  });

  it("migrates a superseded generation-zero breadcrumb out of live sessions", async () => {
    const sourceId = "legacy-generation-zero-source";
    const project = createProject({ name: "Legacy imported session" });
    const task = createTask({
      project_id: project.id,
      title: "Continue: legacy import",
      description: "Continuation of a prior Codex session (legacy).",
      agent: "codex",
    });
    recordSession({
      project_id: project.id,
      task_id: task.id,
      generation: 0,
      claude_session_id: sourceId,
    });
    updateTask(task.id, {
      description: "The imported task was edited after creation.",
      agent: "claude",
    });

    migrate(getDb());

    expect(sessionCount(task.id)).toBe(0);
    expect(
      findExternalSessionImport(`legacy:${task.id}`, sourceId),
    ).toMatchObject({
      project_id: project.id,
      task_id: task.id,
    });

    putDashboardSession(sourceId, "codex");
    const reopened = await GET(
      new Request(
        `http://operator.test/open?session=${sourceId}&source=codex`,
      ),
    );
    expect(
      new URL(reopened.headers.get("location")!).searchParams.get("task"),
    ).toBe(task.id);
  });
});
