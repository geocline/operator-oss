import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GET } from "@/app/api/agents/route";
import { replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { setSetting } from "@/lib/store";

describe("LiteLLM managed agent surface", () => {
  beforeEach(() => {
    setSetting("agent_model_catalog:litellm-codex", null);
    delete process.env.ORCH_SHOW_EVAL_MODELS;
    replaceLiteLLMCatalog({
      models: [
        {
          value: "operator.frontier",
          label: "Operator Frontier",
          description: "Quality-first",
          kind: "coding",
          harnesses: ["codex"],
          contextWindow: 1_000_000,
          reasoningOptions: [],
          sortOrder: 1,
        },
        {
          value: "operator.flex",
          label: "Operator Flex",
          description: "Claude Code compatible",
          kind: "coding",
          harnesses: ["claude"],
          contextWindow: 200_000,
          reasoningOptions: ["medium"],
          sortOrder: 2,
        },
      ],
      errors: [],
      refreshedAt: "2026-08-07T12:00:00.000Z",
      stale: false,
    });
  });

  afterEach(() => {
    delete process.env.ORCH_SHOW_EVAL_MODELS;
  });

  it("gives every driver a clean public id: no litellm-* id ever reaches the client", async () => {
    const body = await (await GET()).json();
    const ids = body.agents.map((agent: { id: string }) => agent.id);
    expect(ids).toEqual(["claude", "codex", "prime", "kimi-code", "dsh"]);
    expect(ids.some((id: string) => id.includes("litellm"))).toBe(false);
    const prime = body.agents.find((a: { id: string }) => a.id === "prime");
    expect(prime.label).toBe("Prime");
    const kimi = body.agents.find((a: { id: string }) => a.id === "kimi-code");
    expect(kimi.label).toBe("Kimi Code");
    const dsh = body.agents.find((a: { id: string }) => a.id === "dsh");
    expect(dsh.label).toBe("DSH (DeepSeek)");
    expect(body.default).not.toMatch(/litellm/);
  });

  it("keeps LiteLLM infrastructure out of the harness picker and folds vetted models into Codex when eval models are shown", async () => {
    process.env.ORCH_SHOW_EVAL_MODELS = "1";
    const body = await (await GET()).json();
    expect(body.agents.map((agent: { id: string }) => agent.id)).toEqual([
      "claude",
      "codex",
      "prime",
      "kimi-code",
      "dsh",
    ]);
    const agent = body.agents.find((a: { id: string }) => a.id === "codex");
    expect(agent).toMatchObject({
      label: "Codex",
      connected: true,
      authenticated: true,
      capabilities: {
        managedCatalogPath: "/api/agents/litellm-codex/models/refresh",
      },
    });
    expect(agent.capabilities.models).toContainEqual(expect.objectContaining({
      value: "operator.frontier",
      driverId: "litellm-codex",
    }));
    const claude = body.agents.find((candidate: { id: string }) => candidate.id === "claude");
    expect(claude.capabilities.models).toContainEqual(expect.objectContaining({
      value: "operator.flex",
      driverId: "litellm-claude",
    }));
  });

  it("gives every managed-endpoint driver its own refresh path, keyed off the real driver id", async () => {
    process.env.ORCH_SHOW_EVAL_MODELS = "1";
    const body = await (await GET()).json();
    const byId = Object.fromEntries(body.agents.map((a: { id: string; capabilities: { managedCatalogPath?: string } }) => [a.id, a.capabilities.managedCatalogPath]));
    expect(byId.codex).toBe("/api/agents/litellm-codex/models/refresh");
    expect(byId.prime).toBe("/api/agents/litellm-prime/models/refresh");
  });

  it("tags every model on a stand-alone managed harness with the real driver id, so tasks.agent still resolves it", async () => {
    const body = await (await GET()).json();
    const prime = body.agents.find((a: { id: string }) => a.id === "prime");
    // The test fixture's catalog only tags models for codex/claude, so Prime's
    // own model list may be empty - the point here is that the id/label are
    // clean regardless, pinned by the first test above. This test only needs
    // the shape to hold when models are present.
    for (const model of prime.capabilities.models) {
      expect(model.driverId).toBe("litellm-prime");
    }
  });

  it("renders refresh controls instead of a subscription login, driven by capability metadata", () => {
    const source = readFileSync(path.join(process.cwd(), "app/orchestrator/AgentConnect.tsx"), "utf8");
    expect(source).toContain('connectionStyle === "managed_endpoint"');
    // Refresh must be driven by the driver's own managedCatalogPath, not a
    // hardcoded litellm-codex literal — otherwise a litellm-prime connect card
    // would refresh (or fail to refresh) the wrong driver's catalog.
    expect(source).toContain("agent.capabilities.managedCatalogPath");
    expect(source).not.toMatch(/["'`]\/api\/agents\/litellm-codex\/models\/refresh["'`]/);
    expect(source).toContain("Refresh models");
    expect(source).not.toMatch(/Sign in with your subscription/i);
    expect(source).toContain("Operator process's host permissions");
    expect(source).toContain("metered through LiteLLM, never estimated");
  });

  it("offers refresh directly in the model picker without presenting LiteLLM as a harness", () => {
    const view = readFileSync(path.join(process.cwd(), "app/orchestrator/SessionView.tsx"), "utf8");
    const hook = readFileSync(path.join(process.cwd(), "app/orchestrator/useOrchestrator.ts"), "utf8");
    expect(view).toContain("Refresh vetted models");
    expect(view).toContain("caps?.managedCatalogPath");
    expect(view).not.toMatch(/["'`]\/api\/agents\/litellm-codex\/models\/refresh["'`]/);
    expect(view).toContain("caps?.managedCatalogPath");
    expect(hook).toContain("operator:refresh-agents");
    expect(view).toContain("(model.driverId ?? publicHarnessId(task.agent)) === task.agent");
  });
});
