// The generic per-driver model-refresh route (app/api/agents/[id]/models/refresh)
// replaces the litellm-codex-only endpoint. It must resolve drivers strictly
// (unknown id -> 404, never a silent fallback to Claude), require the
// managed-endpoint capability before touching the catalog (a non-managed
// driver like "claude" -> 4xx, not a refresh), and refresh the one shared
// LiteLLM catalog for either managed harness (litellm-codex, litellm-prime).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as refresh } from "@/app/api/agents/[id]/models/refresh/route";
import { POST as legacyCodexRefresh } from "@/app/api/agents/litellm-codex/models/refresh/route";
import { replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { setSetting } from "@/lib/store";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const modelInfoResponse = () =>
  new Response(
    JSON.stringify({
      data: [{
        model_name: "operator.frontier",
        model_info: {
          operator: {
            enabled: true,
            label: "Operator Frontier",
            kind: "coding",
            harnesses: ["codex", "prime"],
          },
        },
        litellm_params: { api_key: "never-persist", model: "private/model" },
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

describe("generic managed model-catalog refresh route", () => {
  beforeEach(() => {
    setSetting("agent_model_catalog:litellm-codex", null);
    replaceLiteLLMCatalog({ models: [], errors: [], refreshedAt: null, stale: false, error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(modelInfoResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("404s an unknown agent id instead of falling back to a default driver", async () => {
    const res = await refresh(new Request("http://test"), params("gemini"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/unknown agent/i);
  });

  it("rejects a registered driver that has no managed catalog to refresh", async () => {
    const res = await refresh(new Request("http://test"), params("claude"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await res.json()).error).toMatch(/managed model catalog/i);
  });

  it("refreshes the shared LiteLLM catalog for litellm-prime", async () => {
    const res = await refresh(new Request("http://test"), params("litellm-prime"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.map((m: { value: string }) => m.value)).toContain("operator.frontier");
  });

  it("refreshes the shared LiteLLM catalog for litellm-codex", async () => {
    const res = await refresh(new Request("http://test"), params("litellm-codex"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.map((m: { value: string }) => m.value)).toContain("operator.frontier");
  });

  it("keeps the old litellm-codex-only URL working as a compatibility wrapper", async () => {
    const res = await legacyCodexRefresh(new Request("http://test", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.map((m: { value: string }) => m.value)).toContain("operator.frontier");
  });
});
