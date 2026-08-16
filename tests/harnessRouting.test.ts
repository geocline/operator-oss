// Subscription-only routing guard (spec A3, Geo's hard rule): an
// Anthropic-family (claude*/anthropic/*) or OpenAI-family (gpt*/o<digit>*/
// openai/*/codex*) model must never be reachable over a LiteLLM/gateway route,
// even if a misconfigured gateway catalog offers one or a task row is
// hand-edited to point at one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/agents/route";
import { liteLLMCapabilities } from "@/lib/agents/litellm/capabilities";
import { modelForHarness, replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import type { LiteLLMCatalogSnapshot, LiteLLMHarness } from "@/lib/agents/litellm/types";
import { setSetting } from "@/lib/store";

const ALL_HARNESSES: LiteLLMHarness[] = ["codex", "claude", "prime", "kimi-code"];

const disallowedAndAllowedCatalog: LiteLLMCatalogSnapshot = {
  models: [
    // Disallowed: Anthropic/OpenAI family, declared for every harness anyway.
    { value: "claude-opus-4-8", label: "Claude Opus", description: "", kind: "coding", harnesses: ALL_HARNESSES, contextWindow: 200_000, reasoningOptions: [], sortOrder: 1 },
    { value: "anthropic/claude-3-5-sonnet", label: "Anthropic Claude", description: "", kind: "coding", harnesses: ALL_HARNESSES, contextWindow: 200_000, reasoningOptions: [], sortOrder: 2 },
    { value: "gpt-5.5", label: "GPT-5.5", description: "", kind: "coding", harnesses: ALL_HARNESSES, contextWindow: 200_000, reasoningOptions: [], sortOrder: 3 },
    { value: "o3-mini", label: "o3-mini", description: "", kind: "coding", harnesses: ALL_HARNESSES, contextWindow: 200_000, reasoningOptions: [], sortOrder: 4 },
    { value: "openai/gpt-4o", label: "OpenAI GPT-4o", description: "", kind: "coding", harnesses: ALL_HARNESSES, contextWindow: 200_000, reasoningOptions: [], sortOrder: 5 },
    { value: "codex-mini", label: "Codex Mini", description: "", kind: "coding", harnesses: ALL_HARNESSES, contextWindow: 200_000, reasoningOptions: [], sortOrder: 6 },
    // Allowed: an ordinary operator-tagged gateway model, not in either family.
    { value: "operator.kimi-k3", label: "Kimi K3", description: "", kind: "coding", harnesses: ALL_HARNESSES, contextWindow: 200_000, reasoningOptions: [], sortOrder: 7 },
  ],
  errors: [],
  refreshedAt: "2026-08-15T00:00:00.000Z",
  stale: false,
};

describe("subscription-only LiteLLM routing guard", () => {
  beforeEach(() => {
    setSetting("agent_model_catalog:litellm-codex", null);
    delete process.env.ORCH_SHOW_EVAL_MODELS;
    replaceLiteLLMCatalog(disallowedAndAllowedCatalog);
  });

  afterEach(() => {
    delete process.env.ORCH_SHOW_EVAL_MODELS;
  });

  it("(1) never lists an Anthropic/OpenAI-family model on any LiteLLM harness's capabilities, even when the catalog offers one", () => {
    for (const harness of ["codex", "claude", "prime", "kimi-code"] as const) {
      const caps = liteLLMCapabilities(harness);
      const values = caps.models.map((m) => m.value);
      expect(values).not.toContain("claude-opus-4-8");
      expect(values).not.toContain("anthropic/claude-3-5-sonnet");
      expect(values).not.toContain("gpt-5.5");
      expect(values).not.toContain("o3-mini");
      expect(values).not.toContain("openai/gpt-4o");
      expect(values).not.toContain("codex-mini");
      // The allowed model stays reachable - the guard isn't accidentally
      // blanket-excluding everything.
      expect(values).toContain("operator.kimi-k3");
    }
  });

  it("(1b) rejects a hand-edited task row at turn-model-resolution time (belt-and-suspenders), regardless of what the catalog declares", () => {
    for (const harness of ["codex", "claude", "prime", "kimi-code"] as const) {
      expect(modelForHarness("claude-opus-4-8", harness)).toBeNull();
      expect(modelForHarness("gpt-5.5", harness)).toBeNull();
      expect(modelForHarness("o3-mini", harness)).toBeNull();
      expect(modelForHarness("openai/gpt-4o", harness)).toBeNull();
      expect(modelForHarness("codex-mini", harness)).toBeNull();
      expect(modelForHarness("anthropic/claude-3-5-sonnet", harness)).toBeNull();
      // The allowed model still resolves normally.
      expect(modelForHarness("operator.kimi-k3", harness)).not.toBeNull();
    }
  });

  it("(2) with ORCH_SHOW_EVAL_MODELS unset, the public claude/codex agents carry no driverId pointing at a litellm driver", async () => {
    const body = await (await GET()).json();
    const claude = body.agents.find((a: { id: string }) => a.id === "claude");
    const codex = body.agents.find((a: { id: string }) => a.id === "codex");
    const driverIds = [...claude.capabilities.models, ...codex.capabilities.models].map(
      (m: { driverId?: string }) => m.driverId,
    );
    expect(driverIds.every((id: string | undefined) => !id || !id.startsWith("litellm-"))).toBe(true);
  });

  it("(3) with ORCH_SHOW_EVAL_MODELS=1, the public claude/codex agents carry the gateway-merged litellm driverIds", async () => {
    process.env.ORCH_SHOW_EVAL_MODELS = "1";
    const body = await (await GET()).json();
    const claude = body.agents.find((a: { id: string }) => a.id === "claude");
    const codex = body.agents.find((a: { id: string }) => a.id === "codex");
    expect(claude.capabilities.models.some((m: { driverId?: string }) => m.driverId === "litellm-claude")).toBe(true);
    expect(codex.capabilities.models.some((m: { driverId?: string }) => m.driverId === "litellm-codex")).toBe(true);
  });
});
