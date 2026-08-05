import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "../lib/db";
import { recordSession } from "../lib/store";

vi.mock("node:os", () => ({
  default: {
    homedir: () => process.env.ORCH_TEST_TMP!,
  },
}));

const SESSION_ID = "historical-session-exact-id";
let GET: typeof import("../app/open/route").GET;

function taskCount(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
      count: number;
    }
  ).count;
}

beforeAll(async () => {
  const testHome = process.env.ORCH_TEST_TMP!;
  const dashboardData = path.join(
    testHome,
    "Claude Projects",
    "conversations-dashboard",
    "data",
  );
  const projectPath = path.join(testHome, "historical-project");
  const transcriptPath = path.join(testHome, "historical-session.jsonl");
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

  const dashboardDb = new Database(path.join(dashboardData, "index.db"));
  dashboardDb.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      file_path TEXT,
      project_path TEXT,
      source TEXT
    )
  `);
  dashboardDb
    .prepare(
      `INSERT INTO sessions
       (session_id, title, file_path, project_path, source)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      SESSION_ID,
      "Historical exact session",
      transcriptPath,
      projectPath,
      "codex",
    );
  dashboardDb.close();

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
  });
});
