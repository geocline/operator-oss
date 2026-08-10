import type { AgentCapabilities, AgentPickerOption } from "../types";
import type { LiteLLMHarness } from "./types";
import { getLiteLLMCatalog } from "./catalog";

const REASONING: Record<string, AgentPickerOption> = {
  low: { value: "off", label: "Low", sub: "low reasoning effort" },
  medium: { value: "think", label: "Medium", sub: "balanced reasoning effort" },
  high: { value: "think_hard", label: "High", sub: "greater reasoning depth" },
  xhigh: { value: "ultrathink", label: "Extra high", sub: "maximum compatible effort" },
};

const AUTO_RUN: AgentPickerOption = {
  value: "bypassPermissions",
  label: "Auto-run",
  sub: "workspace write, no approvals",
};
const PLAN_MODE: AgentPickerOption = {
  value: "plan",
  label: "Plan mode",
  sub: "read-only, propose without editing",
};

export function liteLLMCapabilities(harness: LiteLLMHarness = "codex"): AgentCapabilities {
  const catalog = getLiteLLMCatalog();
  const models = catalog.models.filter((m) => m.harnesses.includes(harness));
  const reasoning = new Set(models.flatMap((m) => m.reasoningOptions));
  // Prime is not an OS sandbox, so Plan mode stays hidden until an external
  // restriction test proves writes and network access are blocked.
  const prime = harness === "prime";
  return {
    models: models.map((m) => ({
      value: m.value,
      label: m.label,
      sub: m.description || "Operator-tagged LiteLLM model",
      contextWindow: m.contextWindow ?? 200_000,
      contextWindowKnown: m.contextWindow !== null,
      group: "LiteLLM",
      reasoningValues: m.reasoningOptions
        .map((value) => REASONING[value]?.value)
        .filter((value): value is string => Boolean(value)),
    })),
    reasoningOptions: [...reasoning].map((value) => REASONING[value]).filter(Boolean),
    permissionModes: prime ? [AUTO_RUN] : [AUTO_RUN, PLAN_MODE],
    // Prime asks/tools run through the Operator extension; enabled once the
    // tool-parity suite (tests/primeOperatorTools.test.ts) went green.
    supportsAsks: true,
    supportsMcpTools: true,
    reportsCostUsd: prime,
    costIsEstimated: false,
    supportsResume: true,
    apiKeyHint: null,
    loginStyle: "managed_endpoint",
    connectionStyle: "managed_endpoint",
    // Driver id follows the "litellm-<harness>" convention (litellm-codex,
    // litellm-prime) - see lib/agents/registry.ts. Computed here rather than
    // passed in so every caller gets the right path with no extra plumbing.
    managedCatalogPath: `/api/agents/litellm-${harness}/models/refresh`,
  };
}
