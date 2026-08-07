import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GET } from "@/app/api/agents/route";
import { replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { setSetting } from "@/lib/store";

describe("LiteLLM managed agent surface", () => {
  beforeEach(() => {
    setSetting("agent_model_catalog:litellm-codex", null);
    replaceLiteLLMCatalog({
      models: [{
        value: "operator.frontier",
        label: "Operator Frontier",
        description: "Quality-first",
        kind: "coding",
        harnesses: ["codex"],
        contextWindow: 1_000_000,
        reasoningOptions: [],
        sortOrder: 1,
      }],
      errors: [],
      refreshedAt: "2026-08-07T12:00:00.000Z",
      stale: false,
    });
  });

  it("reports a catalog-backed managed endpoint as connected", async () => {
    const body = await (await GET()).json();
    const agent = body.agents.find((a: { id: string }) => a.id === "litellm-codex");
    expect(agent).toMatchObject({
      label: "LiteLLM · Codex harness",
      connected: true,
      authenticated: true,
      account: { plan: "LiteLLM", method: "managed_endpoint" },
      capabilities: {
        connectionStyle: "managed_endpoint",
        models: [{ value: "operator.frontier" }],
      },
    });
  });

  it("renders refresh controls instead of a subscription login", () => {
    const source = readFileSync(path.join(process.cwd(), "app/orchestrator/AgentConnect.tsx"), "utf8");
    expect(source).toContain('connectionStyle === "managed_endpoint"');
    expect(source).toContain("/api/agents/litellm-codex/models/refresh");
    expect(source).toContain("Refresh models");
  });

  it("offers refresh directly in the LiteLLM task model picker", () => {
    const view = readFileSync(path.join(process.cwd(), "app/orchestrator/SessionView.tsx"), "utf8");
    const hook = readFileSync(path.join(process.cwd(), "app/orchestrator/useOrchestrator.ts"), "utf8");
    expect(view).toContain("Refresh LiteLLM models");
    expect(view).toContain("/api/agents/litellm-codex/models/refresh");
    expect(hook).toContain("operator:refresh-agents");
  });
});
