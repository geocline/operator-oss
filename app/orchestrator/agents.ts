// Client-side helpers over the agents capability bundle (GET /api/agents).
// Every run control + label the UI shows is derived from this data rather than
// hardcoded per agent, so adding a driver server-side surfaces in the UI with
// no client edits. Pure functions (no React) so any module can import them.
import type { AgentsBundle, AgentInfo, AgentCapabilities } from "./types";

// Mirrors the server-side alias map (lib/agents/capabilities.ts PUBLIC_AGENT_IDS)
// plus the litellm-codex/litellm-claude gateway fold GET /api/agents does
// inline - a task's real tasks.agent (any "litellm-*" driver id) resolves to
// the public agent id its capabilities/picker live under, so caps lookups and
// model-picker filtering behave identically for all four harnesses.
const PUBLIC_HARNESS_IDS: Record<string, string> = {
  "litellm-codex": "codex",
  "litellm-claude": "claude",
  "litellm-prime": "prime",
  "litellm-kimi-code": "kimi-code",
  "litellm-dsh": "dsh",
};

export function publicHarnessId(id: string | null | undefined): string | null | undefined {
  if (id == null) return id;
  return PUBLIC_HARNESS_IDS[id] ?? id;
}

export function findAgent(bundle: AgentsBundle, id: string | null | undefined): AgentInfo | undefined {
  const publicId = publicHarnessId(id);
  return bundle.agents.find((a) => a.id === publicId);
}

export function driverForModel(bundle: AgentsBundle, harnessId: string, model: string): string {
  return findAgent(bundle, harnessId)?.capabilities.models.find((option) => option.value === model)?.driverId
    ?? harnessId;
}

// The human name for an agent id, e.g. "Claude Code" / "Codex". Falls back to
// the raw id (or a generic "Agent") so a task carrying an unknown/legacy id
// still labels sensibly.
export function agentLabel(bundle: AgentsBundle, id: string | null | undefined): string {
  return findAgent(bundle, id)?.label || id || "Agent";
}

// The capability descriptor for a task's agent — drives its model/reasoning/
// permission pickers and feature gates (asks, cost display). Undefined until the
// bundle loads or for an unknown id; callers treat undefined as "no data yet".
export function capsFor(bundle: AgentsBundle, id: string | null | undefined): AgentCapabilities | undefined {
  return findAgent(bundle, id)?.capabilities;
}

// The agent a new task should default to: the project's default, else the app
// default — but only when that agent is actually connected. Otherwise fall to
// the first connected agent (a Codex-only instance must not default new tasks
// to an unconnected Claude), and only when NOTHING is connected fall back to
// mere existence so the picker still renders (with its connect CTA).
export function defaultAgentFor(bundle: AgentsBundle, projectDefault: string | null | undefined): string {
  const want = findAgent(bundle, projectDefault || bundle.default);
  if (want?.authenticated) return want.id;
  const connected = bundle.agents.find((a) => a.authenticated);
  return connected?.id ?? want?.id ?? bundle.agents[0]?.id ?? bundle.default;
}
