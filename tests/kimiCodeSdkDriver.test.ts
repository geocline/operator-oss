import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const capture = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  prompt: "",
  interrupted: 0,
  closed: 0,
  resultStatus: "finished" as "finished" | "cancelled" | "max_steps_reached",
  promptError: false,
  resultError: false,
  questionResponses: [] as unknown[][],
  approvals: [] as unknown[][],
  writeSettlement: true,
}));

vi.mock("@/lib/agents/kimi-code/cli-contract", () => ({
  assertCompatibleKimiWireCli: vi.fn(),
}));

vi.mock("@/lib/agents/litellm/relay", () => ({
  getLiteLLMRelay: vi.fn().mockResolvedValue({
    baseUrl: "http://127.0.0.1:43210/v1",
    childApiKey: "operator-loopback-relay",
    generationIds: () => [],
    close: vi.fn(),
  }),
}));

vi.mock("@moonshot-ai/kimi-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moonshot-ai/kimi-agent-sdk")>();
  return {
    ...actual,
    createSession(options: Record<string, unknown>) {
      capture.options = options;
      if (
        capture.writeSettlement
        && typeof (options.env as Record<string, unknown> | undefined)
          ?.ORCH_KIMI_SETTLEMENT_FILE === "string"
      ) {
        const settlementFile = String(
          (options.env as Record<string, unknown>).ORCH_KIMI_SETTLEMENT_FILE,
        );
        mkdirSync(path.dirname(settlementFile), { recursive: true });
        writeFileSync(settlementFile, JSON.stringify({
          status: "settled",
          survivors: [],
          child_environment: {
            credential_keys: ["KIMI_API_KEY"],
            home_is_task_home: true,
          },
        }));
      }
      const sessionId = String(options.sessionId || "kimi-session-1");
      return {
        sessionId,
        prompt(text: string) {
          if (capture.promptError) throw new Error("simulated prompt setup failure");
          capture.prompt = text;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "ContentPart", payload: { type: "think", think: "private" } };
              yield {
                type: "QuestionRequest",
                payload: {
                  id: "rpc-request-1",
                  tool_call_id: "question-tool-1",
                  questions: [{
                    question: "Continue?",
                    header: "Continue",
                    options: [{ label: "Continue" }],
                  }],
                },
              };
              yield {
                type: "StatusUpdate",
                payload: {
                  token_usage: {
                    input_other: 10,
                    output: 2,
                    input_cache_read: 3,
                    input_cache_creation: 0,
                  },
                },
              };
              yield {
                type: "StatusUpdate",
                payload: {
                  token_usage: {
                    input_other: 20,
                    output: 4,
                    input_cache_read: 6,
                    input_cache_creation: 1,
                  },
                },
              };
              yield { type: "ContentPart", payload: { type: "text", text: "Kimi answer" } };
            },
            interrupt: async () => {
              capture.interrupted += 1;
            },
            approve: async (...args: unknown[]) => {
              capture.approvals.push(args);
            },
            respondQuestion: async (...args: unknown[]) => {
              capture.questionResponses.push(args);
            },
            result: capture.resultError
              ? Promise.reject(new Error("simulated SDK result failure"))
              : Promise.resolve({ status: capture.resultStatus }),
          };
        },
        close: async () => {
          capture.closed += 1;
        },
      };
    },
  };
});

import { submitAnswer } from "@/lib/asks";
import { createProject, createTask, updateTask } from "@/lib/store";
import { parseLiteLLMModelInfo, replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import {
  kimiCodeDriver,
  settleKimiCodeTask,
} from "@/lib/agents/kimi-code/driver";
import type { StreamEvent } from "@/lib/types";

function catalog() {
  replaceLiteLLMCatalog({
    ...parseLiteLLMModelInfo({
      data: [{
        model_name: "operator.kimi-k3",
        model_info: {
          operator: {
            enabled: true,
            label: "Kimi K3",
            kind: "coding",
            admissions: [{
              harness: "kimi-code",
              status: "passed",
              harness_version: "1.49.0",
              test_revision: "fixture",
              tested_at: "2026-08-13T00:00:00.000Z",
              requested_alias: "operator.kimi-k3",
              resolved_model: "moonshotai/kimi-k3-20260715",
            }],
            context_window: 1_048_576,
            reasoning_options: ["high"],
          },
        },
      }],
    }),
    refreshedAt: "2026-08-13T00:00:00.000Z",
    stale: false,
  });
}

async function collect(
  generator: AsyncGenerator<StreamEvent>,
  taskId: string,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of generator) {
    events.push(event);
    if (event.type === "ask") {
      submitAnswer(taskId, event.id, [["Continue"]]);
    }
  }
  return events;
}

describe("Kimi Code SDK-backed driver", () => {
  beforeEach(() => {
    capture.options = null;
    capture.prompt = "";
    capture.interrupted = 0;
    capture.closed = 0;
    capture.resultStatus = "finished";
    capture.promptError = false;
    capture.resultError = false;
    capture.questionResponses = [];
    capture.approvals = [];
    capture.writeSettlement = true;
    process.env.KIMI_CODE_CLI_PATH = "/bin/echo";
    catalog();
  });

  it("uses the exact isolated SDK session contract and native question bridge", async () => {
    const project = createProject({ name: "KimiSdk", repo_path: "/tmp/project" });
    const task = createTask({
      project_id: project.id,
      title: "T",
      agent: "litellm-kimi-code",
    });
    updateTask(task.id, {
      model: "operator.kimi-k3",
      reasoning: "think_hard",
      worktree_path: "/tmp/kimi-worktree",
      session_id: "prior-kimi-session",
    });

    const events = await collect(
      kimiCodeDriver.runTurn(
        { ...task, model: "operator.kimi-k3", reasoning: "think_hard", worktree_path: "/tmp/kimi-worktree", session_id: "prior-kimi-session" },
        project,
        "continue",
      ),
      task.id,
    );

    expect(capture.options).toMatchObject({
      workDir: "/tmp/kimi-worktree",
      sessionId: "prior-kimi-session",
      thinking: true,
      yoloMode: true,
      executable: expect.stringMatching(/scripts\/kimi-code-launcher\.mjs$/),
      env: expect.objectContaining({
        HOME: expect.stringContaining(task.id),
        KIMI_CODE_HOME: expect.stringContaining(task.id),
        KIMI_SHARE_DIR: expect.stringContaining(task.id),
        ORCH_KIMI_REAL_CLI: "/bin/echo",
        ORCH_KIMI_SETTLEMENT_FILE: expect.stringContaining("settlement"),
        ORCH_KIMI_TASK_HOME: expect.stringContaining(task.id),
        KIMI_MODEL_NAME: "operator.kimi-k3",
        KIMI_API_KEY: "operator-loopback-relay",
        KIMI_BASE_URL: "http://127.0.0.1:43210/v1",
        ORCH_KIMI_INLINE_CONFIG: expect.stringContaining("operator-relay"),
      }),
      externalTools: expect.arrayContaining([
        expect.objectContaining({ name: "suggest_task" }),
        expect.objectContaining({ name: "expose_service" }),
        expect.objectContaining({ name: "publish_artifact" }),
        expect.objectContaining({ name: "publish_workstream_update" }),
        expect.objectContaining({ name: "propose_card_change" }),
      ]),
      skillsDir: expect.stringContaining(task.id),
      shareDir: expect.stringContaining(task.id),
    });
    expect(capture.options).not.toHaveProperty("model");
    expect(capture.questionResponses).toEqual([[
      "rpc-request-1",
      "question-tool-1",
      { "Continue?": "Continue" },
    ]]);
    expect(capture.prompt).toBe("continue");
    expect(events).toEqual(expect.arrayContaining([
      { type: "session", sessionId: "prior-kimi-session" },
      { type: "model", model: "operator.kimi-k3" },
      { type: "ask", id: "question-tool-1", questions: expect.any(Array) },
      { type: "ask_answered", id: "question-tool-1", answers: [["Continue"]] },
      { type: "assistant", content: "Kimi answer" },
      { type: "done", sessionId: "prior-kimi-session" },
    ]));
    expect(events.filter((event) => event.type === "usage")).toHaveLength(0);
    expect(events).toContainEqual({
      type: "notice",
      content: expect.stringMatching(/token usage.*trusted.*cost.*not recorded/i),
    });
    expect(capture.closed).toBe(1);
  });

  it.each(["cancelled", "max_steps_reached"] as const)(
    "surfaces an unexpected %s terminal status as an error",
    async (resultStatus) => {
      capture.resultStatus = resultStatus;
      const project = createProject({ name: `Kimi-${resultStatus}` });
      const task = createTask({
        project_id: project.id,
        title: "T",
        agent: "litellm-kimi-code",
      });
      updateTask(task.id, { model: "operator.kimi-k3", reasoning: "think_hard" });

      const events = await collect(
        kimiCodeDriver.runTurn(
          { ...task, model: "operator.kimi-k3", reasoning: "think_hard" },
          project,
          "go",
        ),
        task.id,
      );

      expect(events).toContainEqual({
        type: "error",
        content: expect.stringMatching(new RegExp(resultStatus)),
      });
    },
  );

  it("emits an error and suppresses done when process settlement evidence is missing", async () => {
    capture.writeSettlement = false;
    const project = createProject({ name: "KimiUnsettled" });
    const task = createTask({
      project_id: project.id,
      title: "T",
      agent: "litellm-kimi-code",
    });
    updateTask(task.id, { model: "operator.kimi-k3", reasoning: "think_hard" });

    const events = await collect(
      kimiCodeDriver.runTurn(
        { ...task, model: "operator.kimi-k3", reasoning: "think_hard" },
        project,
        "go",
      ),
      task.id,
    );

    expect(events).toContainEqual({
      type: "error",
      content: expect.stringMatching(/settlement evidence is missing/i),
    });
    expect(events.some((event) => event.type === "done")).toBe(false);
    await expect(settleKimiCodeTask(task.id, 100)).rejects.toThrow(
      /settlement evidence is missing/i,
    );
  });

  it("surfaces failed settlement even when the turn was explicitly aborted", async () => {
    capture.writeSettlement = false;
    const project = createProject({ name: "KimiAbortUnsettled" });
    const task = createTask({
      project_id: project.id,
      title: "T",
      agent: "litellm-kimi-code",
    });
    updateTask(task.id, { model: "operator.kimi-k3", reasoning: "think_hard" });
    const abort = new AbortController();
    const events: StreamEvent[] = [];
    for await (const event of kimiCodeDriver.runTurn(
      { ...task, model: "operator.kimi-k3", reasoning: "think_hard" },
      project,
      "go",
      abort,
    )) {
      events.push(event);
      if (event.type === "session") abort.abort();
    }

    expect(events).toContainEqual({
      type: "error",
      content: expect.stringMatching(/settlement evidence is missing/i),
    });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it.each(["prompt", "result"] as const)(
    "settles and suppresses done after an SDK %s failure",
    async (failure) => {
      if (failure === "prompt") capture.promptError = true;
      else capture.resultError = true;
      const project = createProject({ name: `Kimi-${failure}-failure` });
      const task = createTask({
        project_id: project.id,
        title: "T",
        agent: "litellm-kimi-code",
      });
      updateTask(task.id, { model: "operator.kimi-k3", reasoning: "think_hard" });

      const events = await collect(
        kimiCodeDriver.runTurn(
          { ...task, model: "operator.kimi-k3", reasoning: "think_hard" },
          project,
          "go",
        ),
        task.id,
      );

      expect(events).toContainEqual({
        type: "error",
        content: expect.stringMatching(/simulated .* failure/i),
      });
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(capture.closed).toBe(1);
    },
  );

  it("interrupts and closes the SDK turn on Operator stop without an error", async () => {
    const project = createProject({ name: "KimiAbort" });
    const task = createTask({
      project_id: project.id,
      title: "T",
      agent: "litellm-kimi-code",
    });
    updateTask(task.id, { model: "operator.kimi-k3", reasoning: "think_hard" });
    const abort = new AbortController();
    const events: StreamEvent[] = [];
    for await (const event of kimiCodeDriver.runTurn(
      { ...task, model: "operator.kimi-k3", reasoning: "think_hard" },
      project,
      "go",
      abort,
    )) {
      events.push(event);
      if (event.type === "session") abort.abort();
    }

    expect(capture.interrupted).toBe(1);
    expect(capture.closed).toBe(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});
