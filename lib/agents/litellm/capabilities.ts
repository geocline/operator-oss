import type { AgentCapabilities, AgentPickerOption } from "../types";
import type { LiteLLMHarness } from "./types";
import { getLiteLLMCatalog } from "./catalog";
import { isSubscriptionOnlyModelId } from "./family";

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
  // Subscription-only rule: an Anthropic/OpenAI-family model must never be
  // offered on a LiteLLM route, no matter what the gateway's catalog declares
  // (see ./family.ts). This is the primary filter; modelForHarness (./catalog.ts)
  // repeats the check at turn-resolution time as belt-and-suspenders.
  const models = catalog.models.filter(
    (m) => m.harnesses.includes(harness) && !isSubscriptionOnlyModelId(m.value)
  );
  const reasoning = new Set(models.flatMap((m) => m.reasoningOptions));
  // Prime is not an OS sandbox, so Plan mode stays hidden until an external
  // restriction test proves writes and network access are blocked. dsh runs
  // the same way (bash/fs tools with no sandbox plugin wired in the
  // composition Operator drives it with) - see lib/agents/dsh/driver.ts.
  const autoRunOnly = harness === "prime" || harness === "kimi-code" || harness === "dsh";
  // dsh has no orchestrator-tool bridge yet: its packaged runtime binary does
  // not bundle an MCP client plugin (verified by scanning it for
  // @deepseek-ai/dsh-mcp-client - absent), so suggest_task/expose_service/
  // ask_user cannot attach and there is no interactive ask surface either.
  const supportsOperatorTools = harness !== "dsh";
  return {
    models: models.map((m) => ({
      value: m.value,
      label: m.label,
      // An unvetted model is one the gateway simply declares for this harness,
      // with no admission record behind it. It stays selectable - this is a
      // local tool, not a certification program - but the picker says so rather
      // than implying a test that never happened.
      sub: [m.description || "Operator-tagged LiteLLM model", m.unvetted ? "untested pairing" : ""]
        .filter(Boolean)
        .join(" · "),
      contextWindow: m.contextWindow ?? 200_000,
      contextWindowKnown: m.contextWindow !== null,
      group: "LiteLLM",
      reasoningValues: m.reasoningOptions
        .map((value) => REASONING[value]?.value)
        .filter((value): value is string => Boolean(value)),
    })),
    reasoningOptions: [...reasoning].map((value) => REASONING[value]).filter(Boolean),
    permissionModes: autoRunOnly ? [AUTO_RUN] : [AUTO_RUN, PLAN_MODE],
    // Prime asks/tools run through the Operator extension; enabled once the
    // tool-parity suite (tests/primeOperatorTools.test.ts) went green.
    supportsAsks: supportsOperatorTools,
    supportsMcpTools: supportsOperatorTools,
    reportsCostUsd: harness === "prime",
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
