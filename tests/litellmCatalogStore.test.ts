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
        admissions: [{
          harness: "codex",
          status: "passed",
          harness_version: "test",
          test_revision: "fixture",
          tested_at: "2026-08-10T00:00:00.000Z",
          requested_alias: "operator.frontier",
          resolved_model: "private/model",
        }],
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
    // Admission evidence intentionally keeps the resolved physical model, but
    // never provider credentials or the raw LiteLLM routing object.
    expect(stored).not.toMatch(/never-persist|litellm_params/);

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

  // This exact shape is what a cache written by an older build looks like, and
  // discarding it was how a working instance woke up with an empty picker after
  // an upgrade. It survives, flagged, matching a fresh parse of the same config.
  it("keeps a cached model with no admissions, flagged unvetted", () => {
    setSetting(SETTING, JSON.stringify({
      models: [{
        value: "operator.unvetted",
        label: "Unvetted",
        description: "",
        kind: "coding",
        harnesses: ["claude", "codex", "prime"],
        contextWindow: 200_000,
        reasoningOptions: [],
        sortOrder: 1,
      }],
      errors: [],
      refreshedAt: "2026-08-10T00:00:00.000Z",
      stale: false,
    }));
    const [model] = hydrateLiteLLMCatalog().models;
    expect(model).toMatchObject({
      value: "operator.unvetted",
      harnesses: ["claude", "codex", "prime"],
      unvetted: true,
    });
  });

  it("drops legacy cached Kimi Code claims while preserving existing harnesses", () => {
    setSetting(SETTING, JSON.stringify({
      models: [{
        value: "operator.unvetted",
        label: "Unvetted",
        description: "",
        kind: "coding",
        harnesses: ["codex", "kimi-code"],
        contextWindow: 200_000,
        reasoningOptions: [],
        sortOrder: 1,
      }],
      errors: [],
      refreshedAt: "2026-08-10T00:00:00.000Z",
      stale: false,
    }));

    expect(hydrateLiteLLMCatalog().models[0]).toMatchObject({
      harnesses: ["codex"],
      unvetted: true,
    });
  });

  // The unit tests above cover parse and hydrate separately, which is exactly
  // how a live instance still came up empty: the refresh persisted a snapshot
  // that its own loader then discarded. Round-trip the real pair.
  it("survives a refresh-then-reload round trip", async () => {
    const model = {
      model_name: "operator.kimi-k3",
      model_info: {
        operator: {
          enabled: true,
          kind: "coding",
          label: "Kimi K3",
          harnesses: ["codex", "prime"],
          context_window: 1_048_576,
        },
      },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [model] }), { status: 200 })) as unknown as typeof fetch;

    const refreshed = await refreshLiteLLMCatalog(fetchImpl);
    expect(refreshed.models.map((m) => m.value)).toEqual(["operator.kimi-k3"]);

    // What the next page load does: re-read the persisted snapshot.
    const [reloaded] = hydrateLiteLLMCatalog().models;
    expect(reloaded).toMatchObject({ value: "operator.kimi-k3", harnesses: ["codex", "prime"], unvetted: true });
  });

  it("keeps a passed dsh admission across a cache reload", () => {
    setSetting(SETTING, JSON.stringify({
      models: [{
        value: "operator.deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        description: "",
        kind: "coding",
        harnesses: ["dsh"],
        admissions: [{
          harness: "dsh",
          status: "passed",
          harnessVersion: "dsh-2026.08",
          testRevision: "operator-admission-v1",
          testedAt: "2026-08-16T00:00:00.000Z",
          requestedAlias: "operator.deepseek-v4-pro",
          resolvedModel: "deepseek/deepseek-v4-pro-20260423",
        }],
        contextWindow: 200_000,
        reasoningOptions: [],
        sortOrder: 1,
      }],
      errors: [],
      refreshedAt: "2026-08-16T00:00:00.000Z",
      stale: false,
    }));

    expect(hydrateLiteLLMCatalog().models[0]).toMatchObject({
      value: "operator.deepseek-v4-pro",
      harnesses: ["dsh"],
      unvetted: false,
    });
  });

  it("still drops a cached harness the current rules would reject", () => {
    setSetting(SETTING, JSON.stringify({
      models: [{
        value: "operator.bogus",
        label: "Bogus",
        description: "",
        kind: "coding",
        harnesses: ["telepathy"],
        contextWindow: 200_000,
        reasoningOptions: [],
        sortOrder: 1,
      }],
      errors: [],
      refreshedAt: "2026-08-10T00:00:00.000Z",
      stale: false,
    }));
    expect(hydrateLiteLLMCatalog().models).toEqual([]);
  });
});
