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

const admission = (
  harness: "codex" | "claude" | "prime" | "kimi-code",
  requestedAlias: string,
  overrides: Record<string, unknown> = {},
) => ({
  harness,
  status: "passed",
  harness_version: `${harness}-2026.08`,
  test_revision: "operator-admission-v1",
  tested_at: "2026-08-10T12:00:00.000Z",
  requested_alias: requestedAlias,
  resolved_model: "provider/physical-model",
  ...overrides,
});

const valid = (
  overrides: Record<string, unknown> = {},
  modelName = "operator.frontier",
) => ({
  model_name: modelName,
  model_info: {
    operator: {
      enabled: true,
      label: "Operator Frontier",
      kind: "coding",
      admissions: [admission("codex", modelName)],
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
        admissions: [{
          harness: "codex",
          status: "passed",
          harnessVersion: "codex-2026.08",
          testRevision: "operator-admission-v1",
          testedAt: "2026-08-10T12:00:00.000Z",
          requestedAlias: "operator.frontier",
          resolvedModel: "provider/physical-model",
        }],
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
        valid({}, "operator.good"),
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
        valid({ label: "Zulu", sort_order: 20 }, "operator.z"),
        valid({
          label: "Alpha",
          admissions: [
            admission("codex", "operator.a"),
            admission("claude", "operator.a"),
          ],
          sort_order: 20,
        }, "operator.a"),
        valid({ label: "Duplicate" }, "operator.a"),
        valid({ admissions: [] }, "operator.bad"),
      ],
    });
    expect(result.models.map((m) => m.value)).toEqual(["operator.a", "operator.z"]);
    expect(result.models[0].harnesses).toEqual(["codex", "claude"]);
    expect(result.errors.map((e) => e.model)).toEqual(["operator.a", "operator.bad"]);
  });

  it("derives harness compatibility only from passing admission evidence", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        valid({
          // A claimed legacy harness must not bypass evidence.
          harnesses: ["codex", "claude", "prime"],
          admissions: [
            admission("codex", "operator.mixed"),
            admission("claude", "operator.mixed", { status: "failed" }),
          ],
        }, "operator.mixed"),
      ],
    });

    expect(result.models).toEqual([
      expect.objectContaining({
        value: "operator.mixed",
        harnesses: ["codex"],
        admissions: [
          expect.objectContaining({ harness: "codex", status: "passed" }),
          expect.objectContaining({ harness: "claude", status: "failed" }),
        ],
      }),
    ]);
  });

  it("keeps a failed admission pair invisible, since a recorded failure is evidence", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        valid({
          admissions: [admission("prime", "operator.failed", { status: "failed" })],
        }, "operator.failed"),
      ],
    });

    expect(result.models).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  // A gateway that never adopted the admission format still declares plain
  // `harnesses`. Dropping those models left a local instance with an empty
  // picker and an error advising a refresh that re-read the same config, so
  // they stay usable and are flagged instead.
  it("accepts a declared harness list with no admissions, flagged unvetted", () => {
    const result = parseLiteLLMModelInfo({
      data: [valid({ admissions: undefined, harnesses: ["codex", "prime"] }, "operator.claimed-only")],
    });

    expect(result.errors).toEqual([]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      value: "operator.claimed-only",
      harnesses: ["codex", "prime"],
      unvetted: true,
    });
  });

  it("never exposes Kimi Code from a legacy harness declaration without passing evidence", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        valid({
          admissions: undefined,
          harnesses: ["codex", "kimi-code"],
        }, "operator.unadmitted-kimi"),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.models).toEqual([
      expect.objectContaining({
        value: "operator.unadmitted-kimi",
        harnesses: ["codex"],
        unvetted: true,
      }),
    ]);
    expect(result.models[0].harnesses).not.toContain("kimi-code");
  });

  it("exposes Kimi Code only from a passing exact admission record", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        valid({
          harnesses: ["codex"],
          admissions: [
            admission("codex", "operator.admitted-kimi"),
            admission("kimi-code", "operator.admitted-kimi"),
          ],
        }, "operator.admitted-kimi"),
      ],
    });

    expect(result.models[0].harnesses).toEqual(["codex", "kimi-code"]);
  });

  it("still rejects an admissions key that is present but malformed", () => {
    const result = parseLiteLLMModelInfo({
      data: [valid({ admissions: [], harnesses: ["codex"] }, "operator.broken")],
    });

    expect(result.models).toEqual([]);
    expect(result.errors).toEqual([
      {
        model: "operator.broken",
        error: "operator.admissions must be an array of harness admission records",
      },
    ]);
  });

  it("lets evidence outrank the declared list when both are present", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        valid({
          harnesses: ["codex", "prime"],
          admissions: [admission("codex", "operator.mixed")],
        }, "operator.mixed"),
      ],
    });

    expect(result.models[0]).toMatchObject({ harnesses: ["codex"] });
    expect(result.models[0].unvetted).toBeUndefined();
  });

  it("reports malformed admission evidence without exposing its harness pair", () => {
    const result = parseLiteLLMModelInfo({
      data: [
        valid({
          admissions: [
            admission("codex", "operator.invalid", { tested_at: "yesterday" }),
            admission("claude", "operator.invalid", { requested_alias: "operator.somewhere-else" }),
            admission("prime", "operator.invalid", { harness_version: "" }),
          ],
        }, "operator.invalid"),
      ],
    });

    expect(result.models).toEqual([]);
    expect(result.errors).toEqual([
      { model: "operator.invalid", error: "operator.admissions[0].tested_at must be an ISO-8601 timestamp" },
      { model: "operator.invalid", error: "operator.admissions[1].requested_alias must equal model_name" },
      { model: "operator.invalid", error: "operator.admissions[2].harness_version must be nonempty" },
    ]);
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
        valid({ admissions: [admission("prime", "operator.kimi-k3")] }, "operator.kimi-k3"),
        valid({
          admissions: [
            admission("codex", "operator.dual"),
            admission("prime", "operator.dual"),
          ],
        }, "operator.dual"),
        valid({
          admissions: [
            admission("prime", "operator.dedupe"),
            admission("prime", "operator.dedupe"),
          ],
        }, "operator.dedupe"),
        valid({
          admissions: [{ ...admission("codex", "operator.bad"), harness: "openrouter" }],
        }, "operator.bad"),
      ],
    });
    expect(result.models.map((m) => [m.value, m.harnesses])).toEqual([
      ["operator.dedupe", ["prime"]],
      ["operator.dual", ["codex", "prime"]],
      ["operator.kimi-k3", ["prime"]],
    ]);
    expect(result.errors).toEqual([
      { model: "operator.dedupe", error: "operator.admissions must not repeat harness prime" },
      { model: "operator.bad", error: "operator.admissions[0].harness must be codex, claude, prime, or kimi-code" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/provider-secret|private\/provider-model|litellm_params/);
  });

  it("filters modelForHarness and capability model lists per harness", () => {
    replaceLiteLLMCatalog({
      ...parseLiteLLMModelInfo({
        data: [
          valid({}, "operator.codex-only"),
          valid({
            admissions: [admission("prime", "operator.kimi-k3")],
            label: "Kimi K3",
          }, "operator.kimi-k3"),
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
        data: [valid({
          admissions: [admission("prime", "operator.kimi-k3")],
        }, "operator.kimi-k3")],
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
