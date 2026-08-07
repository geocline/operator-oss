import { beforeEach, describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({
  codexOptions: null as Record<string, unknown> | null,
  threadOptions: null as Record<string, unknown> | null,
  resumed: null as string | null,
}));

vi.mock("@/lib/agents/litellm/relay", () => ({
  getLiteLLMRelay: vi.fn().mockResolvedValue({
    baseUrl: "http://127.0.0.1:43210/v1",
    childApiKey: "operator-loopback-relay",
  }),
}));

vi.mock("@openai/codex-sdk", () => {
  class Thread {
    id: string | null;
    constructor(id: string | null, options: Record<string, unknown>) {
      this.id = id;
      captures.threadOptions = options;
    }
    async runStreamed() {
      const self = this;
      return {
        events: (async function* () {
          self.id = "gateway-thread-1";
          yield { type: "thread.started", thread_id: "gateway-thread-1" };
          yield {
            type: "item.completed",
            item: { id: "a1", type: "agent_message", text: "Gateway answer" },
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              reasoning_output_tokens: 1,
              cached_input_tokens: 3,
            },
          };
        })(),
      };
    }
  }
  class Codex {
    constructor(options: Record<string, unknown>) {
      captures.codexOptions = options;
    }
    startThread(options: Record<string, unknown>) {
      return new Thread(null, options);
    }
    resumeThread(id: string, options: Record<string, unknown>) {
      captures.resumed = id;
      return new Thread(id, options);
    }
  }
  return { Codex };
});

import { createProject, createTask, updateTask } from "@/lib/store";
import { replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { buildLiteLLMHarnessEnv, liteLLMCodexDriver } from "@/lib/agents/litellm/driver";

async function collect(generator: AsyncGenerator<unknown>) {
  const events: unknown[] = [];
  for await (const event of generator) events.push(event);
  return events as Array<Record<string, unknown>>;
}

describe("LiteLLM Codex harness driver", () => {
  beforeEach(() => {
    captures.codexOptions = null;
    captures.threadOptions = null;
    captures.resumed = null;
    replaceLiteLLMCatalog({
      models: [{
        value: "operator.frontier",
        label: "Operator Frontier",
        description: "test",
        kind: "coding",
        harnesses: ["codex"],
        contextWindow: 1_000_000,
        reasoningOptions: ["medium"],
        sortOrder: 1,
      }],
      errors: [],
      refreshedAt: "2026-08-07T12:00:00.000Z",
      stale: false,
    });
  });

  it("uses the relay, isolated home, exact model, and zero-cost normalized stream", async () => {
    const project = createProject({ name: "Gateway" });
    const task = createTask({ project_id: project.id, title: "Run", agent: "litellm-codex" });
    updateTask(task.id, { model: "operator.frontier", reasoning: "think" });
    const current = { ...task, model: "operator.frontier", reasoning: "think" };

    const events = await collect(liteLLMCodexDriver.runTurn(current, project, "go"));

    expect(captures.codexOptions).toMatchObject({
      baseUrl: "http://127.0.0.1:43210/v1",
      apiKey: "operator-loopback-relay",
      env: expect.objectContaining({ CODEX_HOME: expect.stringContaining("/litellm-codex") }),
      config: expect.objectContaining({
        model_catalog_json: expect.stringMatching(/operator-model-catalog\.json$/),
      }),
    });
    expect(captures.threadOptions).toMatchObject({
      model: "operator.frontier",
      modelReasoningEffort: "medium",
      sandboxMode: "workspace-write",
    });
    expect(events).toEqual(expect.arrayContaining([
      { type: "model", model: "operator.frontier" },
      { type: "session", sessionId: "gateway-thread-1" },
      { type: "assistant", content: "Gateway answer" },
      expect.objectContaining({ type: "usage", usage: expect.objectContaining({ cost_usd: 0 }) }),
      { type: "done", sessionId: "gateway-thread-1" },
    ]));
    expect(Object.values(buildLiteLLMHarnessEnv(task.id))).not.toContain("real-gateway-secret");
  });

  it("fails closed before creating a paid thread when the selected model is unavailable", async () => {
    const project = createProject({ name: "Missing" });
    const task = createTask({ project_id: project.id, title: "Run", agent: "litellm-codex" });
    const events = await collect(liteLLMCodexDriver.runTurn({ ...task, model: "operator.removed" }, project, "go"));
    expect(events[0]).toMatchObject({ type: "error", content: expect.stringMatching(/unavailable/) });
    expect(captures.codexOptions).toBeNull();
  });
});
