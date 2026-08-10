import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PRIME_OPERATOR_EXTENSION_PATH } from "@/lib/config";
import operatorExtension, {
  type PrimeRegisteredTool,
} from "@/scripts/prime-operator-extension";
import {
  SUGGEST_TASK,
  EXPOSE_SERVICE,
  PUBLISH_ARTIFACT,
  ASK_USER,
  PUBLISH_WORKSTREAM_UPDATE,
  PROPOSE_CARD_CHANGE,
} from "@/lib/agentToolDefs.mjs";

const SHARED_TOOLS = [ASK_USER, SUGGEST_TASK, EXPOSE_SERVICE, PUBLISH_ARTIFACT, PUBLISH_WORKSTREAM_UPDATE, PROPOSE_CARD_CHANGE];
const EXPECTED_NAMES = [
  "ask_user",
  "suggest_task",
  "expose_service",
  "publish_artifact",
  "publish_workstream_update",
  "propose_card_change",
];

function loadTools(): Map<string, PrimeRegisteredTool> {
  const tools = new Map<string, PrimeRegisteredTool>();
  operatorExtension({
    registerTool: (tool: PrimeRegisteredTool) => tools.set(tool.name, tool),
  });
  return tools;
}

function execute(tool: PrimeRegisteredTool, params: Record<string, unknown>) {
  return tool.execute("call-1", params, undefined, undefined, {} as never);
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  process.env.ORCH_TASK_ID = "task-9";
  process.env.ORCH_PROJECT_ID = "project-7";
  process.env.ORCH_BASE_URL = "http://127.0.0.1:3000";
  process.env.SERVICE_TOKEN = "secret-token";
  process.env.ORCH_ASK_POLL_MS = "5";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORCH_ASK_POLL_MS;
});

const jsonResponse = (body: Record<string, unknown>, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

describe("Prime Operator extension contract", () => {
  it("exports its packaged path from config", () => {
    expect(PRIME_OPERATOR_EXTENSION_PATH.endsWith("scripts/prime-operator-extension.ts")).toBe(true);
  });

  it("registers exactly the six shared Operator tools with shared descriptions", () => {
    const tools = loadTools();
    expect([...tools.keys()].sort()).toEqual([...EXPECTED_NAMES].sort());
    for (const def of SHARED_TOOLS) {
      expect(tools.get(def.name)?.description).toBe(def.description);
      expect(tools.get(def.name)?.label).toBeTruthy();
      expect(tools.get(def.name)?.parameters).toBeTruthy();
    }
  });

  it("keeps the extension source free of provider credential references", () => {
    const source = readFileSync(PRIME_OPERATOR_EXTENSION_PATH, "utf8");
    expect(source).not.toMatch(/OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|LITELLM_API_KEY/);
    expect(source).not.toMatch(/console\.log|console\.error/);
  });

  it("mirrors the stdio bridge tool registrations (parity pin)", () => {
    // Both surfaces must register from the same shared definitions, never
    // hardcoded strings, so names/descriptions cannot drift.
    const bridge = readFileSync("scripts/orch-mcp.mjs", "utf8");
    const extension = readFileSync(PRIME_OPERATOR_EXTENSION_PATH, "utf8");
    for (const constant of ["ASK_USER", "SUGGEST_TASK", "EXPOSE_SERVICE", "PUBLISH_ARTIFACT", "PUBLISH_WORKSTREAM_UPDATE", "PROPOSE_CARD_CHANGE"]) {
      expect(bridge).toContain(`${constant}.name`);
      expect(extension).toContain(`${constant}.name`);
    }
  });
});

describe("Prime Operator extension HTTP behavior", () => {
  it("expose_service posts to the internal route with ids, token, and JSON", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ text: "exposed at http://x" }));
    const tools = loadTools();
    const result = await execute(tools.get("expose_service")!, { name: "dev", port: 4310 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/internal/agent-tools/expose-service",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "x-service-token": "secret-token" },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      projectId: "project-7",
      taskId: "task-9",
      name: "dev",
      port: 4310,
    });
    expect(result.content).toEqual([{ type: "text", text: "exposed at http://x" }]);
  });

  it("suggest_task resolves per-turn title references to created task ids", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "task-a", text: "created A" }))
      .mockResolvedValueOnce(jsonResponse({ id: "task-b", text: "created B" }));
    const tools = loadTools();
    const suggest = tools.get("suggest_task")!;
    await execute(suggest, { title: "First", description: "d", priority: "med" });
    await execute(suggest, { title: "Second", description: "d", priority: "hi", blocked_by: ["First"] });
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.title).toBe("Second");
    // Dependencies are disabled instance-wide; the extension must not send refs.
    expect(secondBody.blocked_by ?? []).toEqual([]);
  });

  it("publish_artifact, publish_workstream_update, and propose_card_change hit their routes", async () => {
    const tools = loadTools();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["publish_artifact", { path: "out/report.html" }, "publish-artifact"],
      ["publish_workstream_update", { body: "Done" }, "publish-workstream-update"],
      ["propose_card_change", { kind: "complete_card", value: {} }, "propose-card-change"],
    ];
    for (const [name, params, route] of cases) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ text: "ok" }));
      await execute(tools.get(name)!, params);
      expect(fetchMock).toHaveBeenLastCalledWith(
        `http://127.0.0.1:3000/api/internal/agent-tools/${route}`,
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
      expect(body.projectId).toBe("project-7");
      expect(body.taskId).toBe("task-9");
    }
  });

  it("refuses to load with a non-loopback ORCH_BASE_URL (token containment)", () => {
    process.env.ORCH_BASE_URL = "http://evil.example.com:3000";
    expect(() => loadTools()).toThrow(/loopback/i);
    process.env.ORCH_BASE_URL = "http://127.0.0.1:3000";
  });

  it("surfaces endpoint errors as tool errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unknown project" }, false, 404));
    const tools = loadTools();
    await expect(
      execute(tools.get("expose_service")!, { name: "dev", port: 4310 }),
    ).rejects.toThrow(/unknown project/);
  });

  it("ask_user starts the durable ask then polls the wait endpoint until done", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ askId: "ask-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
      .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
      .mockResolvedValueOnce(jsonResponse({ status: "done", text: "They chose Option B" }));
    const tools = loadTools();
    const result = await execute(tools.get("ask_user")!, {
      questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(result.content).toEqual([{ type: "text", text: "They chose Option B" }]);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/internal/agent-tools/ask-user");
    expect(fetchMock.mock.calls[1][0]).toContain("/api/internal/agent-tools/ask-user/wait");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).askId).toBe("ask-1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
