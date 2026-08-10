import { describe, expect, it } from "vitest";
import path from "node:path";
import { LITELLM_BASE_URL, LITELLM_CODEX_HOME } from "@/lib/config";
import {
  getLiteLLMCatalog,
  modelForHarness,
  parseLiteLLMModelInfo,
  replaceLiteLLMCatalog,
} from "@/lib/agents/litellm/catalog";
import { getCapabilities, isKnownAgent, knownAgentIds } from "@/lib/agents/capabilities";
import { liteLLMCapabilities } from "@/lib/agents/litellm/capabilities";

const valid = (overrides: Record<string, unknown> = {}) => ({
  model_name: "operator.frontier",
  model_info: {
    operator: {
      enabled: true,
      label: "Operator Frontier",
      kind: "coding",
      harnesses: ["codex"],
      description: "Quality-first",
      context_window: 1_000_000,
      sort_order: 10,
      ...overrides,
    },
  },
  litellm_params: {
    model: "openrouter/private/provider-model",
    api_key: "provider-secret",
  },
});

describe("LiteLLM configuration", () => {
  it("defaults to the loopback gateway and an isolated absolute Codex home", () => {
    expect(LITELLM_BASE_URL).toBe("http://127.0.0.1:4000/v1");
    expect(path.isAbsolute(LITELLM_CODEX_HOME)).toBe(true);
    expect(LITELLM_CODEX_HOME.endsWith("/litellm-codex")).toBe(true);
  });
});

describe("Operator-tagged LiteLLM catalog", () => {
  it("returns only sanitized picker metadata", () => {
    const result = parseLiteLLMModelInfo({ data: [valid()] });
    expect(result).toEqual({
      models: [{
        value: "operator.frontier",
        label: "Operator Frontier",
        description: "Quality-first",
        kind: "coding",
        harnesses: ["codex"],
        contextWindow: 1_000_000,
        reasoningOptions: [],
        sortOrder: 10,
      }],
      errors: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/provider-secret|private\/provider-model|litellm_params/);
  });

  it("excludes unrelated, disabled, image, and malformed entries independently", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        { model_name: "task.email.classify", model_info: {} },
        valid({ enabled: false }),
        valid({ kind: "image" }),
        valid({ label: "" }),
        { ...valid(), model_name: "operator.good" },
      ],
    });
    expect(result.models.map((m) => m.value)).toEqual(["operator.good"]);
    expect(result.errors).toEqual([
      { model: "operator.frontier", error: "operator.label must be nonempty" },
    ]);
  });

  it("deduplicates names, validates harnesses, and sorts deterministically", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        { ...valid({ label: "Zulu", sort_order: 20 }), model_name: "operator.z" },
        { ...valid({ label: "Alpha", harnesses: ["codex", "claude"], sort_order: 20 }), model_name: "operator.a" },
        { ...valid({ label: "Duplicate" }), model_name: "operator.a" },
        { ...valid({ harnesses: ["unknown"] }), model_name: "operator.bad" },
      ],
    });
    expect(result.models.map((m) => m.value)).toEqual(["operator.a", "operator.z"]);
    expect(result.models[0].harnesses).toEqual(["codex", "claude"]);
    expect(result.errors.map((e) => e.model)).toEqual(["operator.a", "operator.bad"]);
  });

  it("replaces the in-memory snapshot and resolves exact harness compatibility", () => {
    const parsed = parseLiteLLMModelInfo({ data: [valid()] });
    replaceLiteLLMCatalog({ ...parsed, refreshedAt: "2026-08-07T12:00:00.000Z", stale: false });
    expect(getLiteLLMCatalog().models).toHaveLength(1);
    expect(modelForHarness("operator.frontier", "codex")?.label).toBe("Operator Frontier");
    expect(modelForHarness("operator.frontier", "claude")).toBeNull();
    expect(modelForHarness("", "codex")).toBeNull();
  });

  it("accepts prime and mixed harness tags and rejects unknown strings", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        { ...valid({ harnesses: ["prime"] }), model_name: "operator.kimi-k3" },
        { ...valid({ harnesses: ["codex", "prime"] }), model_name: "operator.dual" },
        { ...valid({ harnesses: ["prime", "prime", "openrouter"] }), model_name: "operator.dedupe" },
        { ...valid({ harnesses: ["openrouter", "gpt"] }), model_name: "operator.bad" },
      ],
    });
    expect(result.models.map((m) => [m.value, m.harnesses])).toEqual([
      ["operator.dedupe", ["prime"]],
      ["operator.dual", ["codex", "prime"]],
      ["operator.kimi-k3", ["prime"]],
    ]);
    expect(result.errors).toEqual([
      { model: "operator.bad", error: "operator.harnesses must include codex, claude, or prime" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/provider-secret|private\/provider-model|litellm_params/);
  });

  it("filters modelForHarness and capability model lists per harness", () => {
    replaceLiteLLMCatalog({
      ...parseLiteLLMModelInfo({
        data: [
          { ...valid(), model_name: "operator.codex-only" },
          { ...valid({ harnesses: ["prime"], label: "Kimi K3" }), model_name: "operator.kimi-k3" },
        ],
      }),
      refreshedAt: "2026-08-10T12:00:00.000Z",
      stale: false,
    });
    expect(modelForHarness("operator.kimi-k3", "prime")?.label).toBe("Kimi K3");
    expect(modelForHarness("operator.kimi-k3", "codex")).toBeNull();
    expect(modelForHarness("operator.codex-only", "prime")).toBeNull();
    expect(liteLLMCapabilities("codex").models.map((m) => m.value)).toEqual(["operator.codex-only"]);
    expect(liteLLMCapabilities("prime").models.map((m) => m.value)).toEqual(["operator.kimi-k3"]);
  });

  it("exposes Auto-run-only, metered-cost capabilities for prime", () => {
    replaceLiteLLMCatalog({
      ...parseLiteLLMModelInfo({
        data: [{ ...valid({ harnesses: ["prime"] }), model_name: "operator.kimi-k3" }],
      }),
      refreshedAt: "2026-08-10T12:00:00.000Z",
      stale: false,
    });
    const caps = liteLLMCapabilities("prime");
    expect(caps.permissionModes).toEqual([
      expect.objectContaining({ value: "bypassPermissions", label: "Auto-run" }),
    ]);
    // Asks and Operator tools ride the Prime extension (Task 5 parity suite).
    expect(caps.supportsAsks).toBe(true);
    expect(caps.supportsMcpTools).toBe(true);
    expect(caps.reportsCostUsd).toBe(true);
    expect(caps.costIsEstimated).toBe(false);
    // Codex behavior is unchanged.
    const codex = liteLLMCapabilities("codex");
    expect(codex.permissionModes.map((p) => p.value)).toEqual(["bypassPermissions", "plan"]);
  });

  it("drives the SDK-free litellm-codex capability descriptor dynamically", () => {
    replaceLiteLLMCatalog({
      ...parseLiteLLMModelInfo({ data: [valid()] }),
      refreshedAt: "2026-08-07T12:00:00.000Z",
      stale: false,
    });
    expect(knownAgentIds()).toContain("litellm-codex");
    expect(isKnownAgent("litellm-codex")).toBe(true);
    expect(getCapabilities("litellm-codex").models).toEqual([
      expect.objectContaining({
        value: "operator.frontier",
        label: "Operator Frontier",
        contextWindow: 1_000_000,
      }),
    ]);
  });
});
