import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "@/lib/store";
import { getLiteLLMCatalog, replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import {
  hydrateLiteLLMCatalog,
  refreshLiteLLMCatalog,
} from "@/lib/agents/litellm/catalog-store";

const SETTING = "agent_model_catalog:litellm-codex";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const payload = {
  data: [{
    model_name: "operator.frontier",
    model_info: {
      operator: {
        enabled: true,
        label: "Operator Frontier",
        kind: "coding",
        harnesses: ["codex"],
      },
    },
    litellm_params: { api_key: "never-persist", model: "private/model" },
  }],
};

describe("LiteLLM catalog persistence", () => {
  beforeEach(() => {
    setSetting(SETTING, null);
    replaceLiteLLMCatalog({ models: [], errors: [], refreshedAt: null, stale: false, error: null });
  });

  it("refreshes, sanitizes, and persists a last-known-good snapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(payload));
    const result = await refreshLiteLLMCatalog(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/model/info",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(result.models.map((m) => m.value)).toEqual(["operator.frontier"]);
    const stored = getSetting(SETTING)!;
    expect(stored).not.toMatch(/never-persist|private\/model|litellm_params/);

    replaceLiteLLMCatalog({ models: [], errors: [], refreshedAt: null, stale: false });
    expect(hydrateLiteLLMCatalog().models[0].value).toBe("operator.frontier");
  });

  it("preserves the good snapshot when refresh fails", async () => {
    await refreshLiteLLMCatalog(vi.fn().mockResolvedValue(response(payload)));
    await expect(
      refreshLiteLLMCatalog(vi.fn().mockResolvedValue(response({ error: "upstream-secret" }, 503))),
    ).rejects.toThrow(/503/);
    expect(getLiteLLMCatalog()).toMatchObject({
      models: [{ value: "operator.frontier" }],
      stale: true,
    });
    expect(getLiteLLMCatalog().error).not.toContain("upstream-secret");
  });

  it("does not replace a nonempty catalog with an empty refresh", async () => {
    await refreshLiteLLMCatalog(vi.fn().mockResolvedValue(response(payload)));
    await expect(
      refreshLiteLLMCatalog(vi.fn().mockResolvedValue(response({ data: [] }))),
    ).rejects.toThrow(/no valid Operator-tagged models/i);
    expect(getLiteLLMCatalog().models).toHaveLength(1);
  });

  it("ignores corrupt persisted state", () => {
    setSetting(SETTING, "{not json");
    expect(hydrateLiteLLMCatalog().models).toEqual([]);
  });
});
