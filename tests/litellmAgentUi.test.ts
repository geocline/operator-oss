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
        managedCatalogPath: "/api/agents/litellm-codex/models/refresh",
      },
    });
  });

  it("gives every managed-endpoint driver its own refresh path, keyed off the driver id", async () => {
    const body = await (await GET()).json();
    const byId = Object.fromEntries(body.agents.map((a: { id: string; capabilities: { managedCatalogPath?: string } }) => [a.id, a.capabilities.managedCatalogPath]));
    expect(byId["litellm-codex"]).toBe("/api/agents/litellm-codex/models/refresh");
    expect(byId["litellm-prime"]).toBe("/api/agents/litellm-prime/models/refresh");
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

  it("offers refresh directly in the LiteLLM task model picker, keyed off capability metadata", () => {
    const view = readFileSync(path.join(process.cwd(), "app/orchestrator/SessionView.tsx"), "utf8");
    const hook = readFileSync(path.join(process.cwd(), "app/orchestrator/useOrchestrator.ts"), "utf8");
    expect(view).toContain("Refresh LiteLLM models");
    expect(view).toContain("caps?.managedCatalogPath");
    expect(view).not.toMatch(/["'`]\/api\/agents\/litellm-codex\/models\/refresh["'`]/);
    expect(view).toContain('caps?.connectionStyle === "managed_endpoint"');
    expect(hook).toContain("operator:refresh-agents");
  });
});
