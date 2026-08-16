import { describe, expect, it } from "vitest";
import path from "node:path";
import { GET } from "@/app/api/agents/route";
import { parseLiteLLMModelInfo, replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { getCapabilities, knownAgentIds } from "@/lib/agents/capabilities";
import { getDriver, getDriverStrict, listDrivers } from "@/lib/agents/registry";
import { LITELLM_KIMI_CODE_HOME } from "@/lib/config";
import {
  buildKimiCodeEnv,
  kimiEffortForReasoning,
  kimiCodeTaskHome,
} from "@/lib/agents/kimi-code/policy";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import type { StreamEvent } from "@/lib/types";

const MODEL_INFO = {
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
};

function catalog() {
  replaceLiteLLMCatalog({
    ...parseLiteLLMModelInfo(MODEL_INFO),
    refreshedAt: "2026-08-13T00:00:00.000Z",
    stale: false,
  });
}

async function collect(
  taskId: string,
  project: ReturnType<typeof createProject>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of getDriver("litellm-kimi-code").runTurn(
    getTask(taskId)!,
    project,
    "go",
  )) {
    out.push(event);
  }
  return out;
}

describe("Kimi Code public harness surface", () => {
  it("parses exact kimi-code admission metadata", () => {
    const parsed = parseLiteLLMModelInfo(MODEL_INFO);
    expect(parsed.errors).toEqual([]);
    expect(parsed.models[0]).toMatchObject({
      value: "operator.kimi-k3",
      harnesses: ["kimi-code"],
    });
  });

  it("registers one public Kimi Code driver in runtime and SDK-free maps", () => {
    catalog();
    expect(knownAgentIds()).toContain("litellm-kimi-code");
    expect(listDrivers().map((driver) => driver.id)).toContain("litellm-kimi-code");
    expect(getDriver("litellm-kimi-code").id).toBe("litellm-kimi-code");
    expect(getDriverStrict("litellm-kimi-code")?.label).toBe("Kimi Code");
  });

  it("exposes Auto-run only and only kimi-code-admitted models", async () => {
    catalog();
    const caps = getCapabilities("litellm-kimi-code");
    expect(caps.permissionModes.map((mode) => mode.value)).toEqual(["bypassPermissions"]);
    expect(caps.models.map((model) => model.value)).toEqual(["operator.kimi-k3"]);
    expect(caps.reasoningOptions.map((option) => option.value)).toEqual(["think_hard"]);
    expect(caps.models[0].reasoningValues).toEqual(["think_hard"]);
    expect(caps.supportsAsks).toBe(true);
    expect(caps.supportsMcpTools).toBe(true);
    expect(caps.reportsCostUsd).toBe(false);
    expect(caps.managedCatalogPath).toBe("/api/agents/litellm-kimi-code/models/refresh");

    const body = await (await GET()).json();
    // Public id: the raw "litellm-kimi-code" driver id never reaches the client
    // (see lib/agents/capabilities.ts PUBLIC_AGENT_IDS) - tasks.agent still
    // stores the real id, which is what every other assertion here checks.
    const kimi = body.agents.find((agent: { id: string }) => agent.id === "kimi-code");
    expect(kimi).toMatchObject({ label: "Kimi Code", connected: true });
  });

  it("fails actionably when the pinned CLI is missing and never falls back", async () => {
    catalog();
    process.env.KIMI_CODE_CLI_PATH = "/nonexistent/kimi";
    const project = createProject({ name: "KimiNoCli" });
    const task = createTask({ project_id: project.id, title: "T" });
    updateTask(task.id, {
      agent: "litellm-kimi-code",
      model: "operator.kimi-k3",
    });
    try {
      const events = await collect(task.id, project);
      expect(events[0]).toMatchObject({
        type: "error",
        content: expect.stringMatching(/Kimi Code.*missing/i),
      });
      expect(events.at(-1)).toMatchObject({ type: "done" });
    } finally {
      delete process.env.KIMI_CODE_CLI_PATH;
    }
  });
});

describe("Kimi Code task-local policy", () => {
  it("builds an exact non-persisted relay-only model overlay", () => {
    const env = buildKimiCodeEnv(
      "task-1",
      {
        value: "operator.kimi-k3",
        label: "Kimi K3",
        contextWindow: 1_048_576,
        reasoningOptions: ["medium", "high"],
      },
      "http://127.0.0.1:4567/v1",
      "operator-loopback-relay",
      "think_hard",
      {
        PATH: "/bin",
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_AUTH_TOKEN: "anthropic-secret",
        OPENROUTER_API_KEY: "provider-secret",
        LITELLM_API_KEY: "gateway-secret",
        GITHUB_TOKEN: "github-secret",
        NPM_TOKEN: "npm-secret",
        KIMI_MODEL_API_KEY: "stale-secret",
        SERVICE_TOKEN: "service-secret",
      },
    );

    expect(env).toMatchObject({
      PATH: "/bin",
      KIMI_CODE_HOME: kimiCodeTaskHome("task-1"),
      KIMI_DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      KIMI_MODEL_NAME: "operator.kimi-k3",
      KIMI_API_KEY: "operator-loopback-relay",
      KIMI_BASE_URL: "http://127.0.0.1:4567/v1",
      KIMI_SHARE_DIR: kimiCodeTaskHome("task-1"),
      KIMI_MODEL_MAX_CONTEXT_SIZE: "1048576",
      KIMI_MODEL_MAX_COMPLETION_TOKENS: "16384",
      KIMI_MODEL_CAPABILITIES: "thinking",
      ORCH_KIMI_INLINE_CONFIG: expect.stringContaining("operator-relay"),
    });
    expect(kimiCodeTaskHome("task-1")).toBe(
      path.join(LITELLM_KIMI_CODE_HOME, "task-1"),
    );
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENROUTER_API_KEY",
      "LITELLM_API_KEY",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "SERVICE_TOKEN",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    const credentialKeys = Object.keys(env).filter((key) =>
      /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION)/i.test(key)
      && key !== "KIMI_MODEL_MAX_COMPLETION_TOKENS",
    );
    expect(credentialKeys).toEqual(["KIMI_API_KEY"]);
  });

  it.each([
    ["think_hard", "high"],
    [null, "high"],
  ])("maps Operator reasoning %s to the exact supported Wire CLI effort %s", (reasoning, effort) => {
    const env = buildKimiCodeEnv(
      "task-effort",
      {
        value: "operator.kimi-k3",
        label: "Kimi K3",
        contextWindow: 1_048_576,
        reasoningOptions: ["high"],
      },
      "http://127.0.0.1:4567/v1",
      "operator-loopback-relay",
      reasoning,
      {},
    );
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
    expect(kimiEffortForReasoning(reasoning, ["high"])).toBe(effort);
  });

  it.each(["off", "think", "ultrathink"])(
    "rejects unsupported Wire CLI reasoning preset %s",
    (reasoning) => {
      expect(() => kimiEffortForReasoning(reasoning, ["high", "xhigh"]))
        .toThrow(/not supported/i);
    },
  );

  it.each(["", "..", "../escape", "a/b", "a\\b"])(
    "rejects unsafe task id %j",
    (taskId) => {
      expect(() => kimiCodeTaskHome(taskId)).toThrow(/task id/i);
    },
  );
});
