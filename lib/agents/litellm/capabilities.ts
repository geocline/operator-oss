import type { AgentCapabilities, AgentPickerOption } from "../types";
import { getLiteLLMCatalog } from "./catalog";

const REASONING: Record<string, AgentPickerOption> = {
  low: { value: "off", label: "Low", sub: "low reasoning effort" },
  medium: { value: "think", label: "Medium", sub: "balanced reasoning effort" },
  high: { value: "think_hard", label: "High", sub: "greater reasoning depth" },
  xhigh: { value: "ultrathink", label: "Extra high", sub: "maximum compatible effort" },
};

export function liteLLMCapabilities(): AgentCapabilities {
  const catalog = getLiteLLMCatalog();
  const reasoning = new Set(
    catalog.models
      .filter((m) => m.harnesses.includes("codex"))
      .flatMap((m) => m.reasoningOptions),
  );
  return {
    models: catalog.models
      .filter((m) => m.harnesses.includes("codex"))
      .map((m) => ({
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
    permissionModes: [
      { value: "bypassPermissions", label: "Auto-run", sub: "workspace write, no approvals" },
      { value: "plan", label: "Plan mode", sub: "read-only, propose without editing" },
    ],
    supportsAsks: true,
    supportsMcpTools: true,
    reportsCostUsd: false,
    costIsEstimated: false,
    supportsResume: true,
    apiKeyHint: null,
    loginStyle: "managed_endpoint",
    connectionStyle: "managed_endpoint",
  };
}
