// The generic per-driver model-refresh route (app/api/agents/[id]/models/refresh)
// replaces the litellm-codex-only endpoint. It must resolve drivers strictly
// (unknown id -> 404, never a silent fallback to Claude), require the
// managed-endpoint capability before touching the catalog (a non-managed
// driver like "claude" -> 4xx, not a refresh), and refresh the one shared
// LiteLLM catalog for either managed harness (litellm-codex, litellm-prime).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { POST as refresh } from "@/app/api/agents/[id]/models/refresh/route";
import { POST as legacyCodexRefresh } from "@/app/api/agents/litellm-codex/models/refresh/route";
import { replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { primeCapabilities } from "@/lib/agents/prime/capabilities";
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

describe("Prime Agent UI surface (data/route-level, no DOM rendering)", () => {
  it("gives Prime a distinct brand mark keyed by driver id", () => {
    const icons = readFileSync(path.join(process.cwd(), "app/icons.tsx"), "utf8");
    expect(icons).toMatch(/"litellm-prime":\s*\(p\?: P\) => Brand/);
  });

  it("colors the Prime avatar distinctly from Claude and Codex", () => {
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toMatch(/\.av\.cc\.litellm-prime\s*\{[^}]*color:/);
  });

  it("exposes litellm-prime with the Prime Agent label via GET /api/agents", async () => {
    const { GET } = await import("@/app/api/agents/route");
    const body = await (await GET()).json();
    const prime = body.agents.find((a: { id: string }) => a.id === "litellm-prime");
    expect(prime).toBeTruthy();
    expect(prime.label).toBe("Prime Agent");
  });

  it("offers Auto-run only, never Plan mode, for litellm-prime", async () => {
    const { GET } = await import("@/app/api/agents/route");
    const body = await (await GET()).json();
    const prime = body.agents.find((a: { id: string }) => a.id === "litellm-prime");
    const modes = prime.capabilities.permissionModes.map((m: { value: string }) => m.value);
    expect(modes).toEqual(["bypassPermissions"]);
    expect(modes).not.toContain("plan");
  });

  it("reports Prime cost as metered, never estimated", async () => {
    const { GET } = await import("@/app/api/agents/route");
    const body = await (await GET()).json();
    const prime = body.agents.find((a: { id: string }) => a.id === "litellm-prime");
    expect(prime.capabilities.reportsCostUsd).toBe(true);
    expect(prime.capabilities.costIsEstimated).toBe(false);
  });

  it("shows only prime-tagged Kimi models for litellm-prime, keeping litellm-codex separate", () => {
    setSetting("agent_model_catalog:litellm-codex", null);
    replaceLiteLLMCatalog({
      models: [
        {
          value: "operator.kimi-k3",
          label: "Kimi K3",
          description: "",
          kind: "coding",
          harnesses: ["prime"],
          contextWindow: 200_000,
          reasoningOptions: [],
          sortOrder: 1,
        },
        {
          value: "operator.frontier",
          label: "Operator Frontier",
          description: "",
          kind: "coding",
          harnesses: ["codex"],
          contextWindow: 200_000,
          reasoningOptions: [],
          sortOrder: 2,
        },
      ],
      errors: [],
      refreshedAt: "2026-08-10T00:00:00.000Z",
      stale: false,
    });
    const caps = primeCapabilities();
    expect(caps.models.map((m: { value: string }) => m.value)).toEqual(["operator.kimi-k3"]);
    expect(caps.models.map((m: { value: string }) => m.value)).not.toContain("operator.frontier");
  });

  it("tells the Connect card Prime runs with host permissions and metered cost, not a subscription login", () => {
    const source = readFileSync(path.join(process.cwd(), "app/orchestrator/AgentConnect.tsx"), "utf8");
    expect(source).toContain("litellm-prime");
    expect(source).toContain("Operator process's host permissions");
    expect(source).toContain("metered through LiteLLM, never estimated");
  });

  it("keeps Prime out of native Claude/Codex subscription-quota advice", () => {
    const source = readFileSync(path.join(process.cwd(), "app/orchestrator/QuotaView.tsx"), "utf8");
    expect(source).not.toMatch(/litellm|prime|kimi/i);
  });

  it("adds Prime/Kimi/LiteLLM/OpenRouter command-palette keywords", () => {
    const source = readFileSync(path.join(process.cwd(), "app/Orchestrator.tsx"), "utf8");
    const keywordsLine = source.split("\n").find((l) => l.includes("connect-agent"));
    expect(keywordsLine).toBeTruthy();
    for (const kw of ["prime", "kimi", "litellm", "openrouter"]) {
      expect(keywordsLine).toContain(kw);
    }
  });

  it("an unavailable Prime session fails actionably and never falls back to Claude", () => {
    const source = readFileSync(path.join(process.cwd(), "app/orchestrator/SessionView.tsx"), "utf8");
    // Model options are always derived from the task's own agent capabilities
    // (capsFor), never hardcoded to Claude — so an unresolvable litellm-prime
    // model surfaces its own picker/empty state instead of quietly switching.
    expect(source).toContain("capsFor(agents, task.agent)");
  });
});

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
