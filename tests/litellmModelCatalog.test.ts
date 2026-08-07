import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LiteLLMModel } from "@/lib/agents/litellm/types";
import { writeLiteLLMModelCatalog } from "@/lib/agents/litellm/model-catalog";

const models: LiteLLMModel[] = [
  {
    value: "operator.frontier",
    label: "Operator Frontier",
    description: "A metered coding model",
    kind: "coding",
    harnesses: ["codex"],
    contextWindow: 200_000,
    reasoningOptions: ["low", "medium", "high"],
    sortOrder: 1,
  },
  {
    value: "operator.claude-only",
    label: "Claude only",
    description: "",
    kind: "coding",
    harnesses: ["claude"],
    contextWindow: 100_000,
    reasoningOptions: [],
    sortOrder: 2,
  },
];

describe("LiteLLM Codex model catalog", () => {
  it("writes only Codex-tagged aliases with explicit metadata and no credentials", () => {
    const home = path.join(process.env.LITELLM_CODEX_HOME!, "catalog-test");
    const catalogPath = writeLiteLLMModelCatalog(home, models);
    const raw = readFileSync(catalogPath, "utf8");
    const parsed = JSON.parse(raw) as { models: Array<Record<string, unknown>> };

    expect(path.isAbsolute(catalogPath)).toBe(true);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]).toMatchObject({
      slug: "operator.frontier",
      display_name: "Operator Frontier",
      model: "operator.frontier",
      provider: "operator_litellm",
      context_window: 200_000,
      truncation_policy: { mode: "tokens", limit: 200_000 },
      supports_tools: true,
      supported_reasoning_levels: [
        { effort: "low", description: "Low reasoning effort" },
        { effort: "medium", description: "Medium reasoning effort" },
        { effort: "high", description: "High reasoning effort" },
      ],
    });
    expect(raw).not.toMatch(/api.?key|openrouter|authorization/i);
    expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
  });
});
