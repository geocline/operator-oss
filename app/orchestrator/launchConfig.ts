import type {
  AgentPickerOption,
  AgentsBundle,
  TaskRow,
} from "./types";
import { findAgent } from "./agents";

export type LaunchConfigurationSelection = {
  agent: string;
  model: string;
  reasoning: string;
};

export function needsLaunchConfiguration(
  task: TaskRow,
  agents?: AgentsBundle,
): boolean {
  if (task.started !== 0 || task.launch_config_required !== 1) return false;
  if (task.launch_config_confirmed_at === 0) return true;
  return agents ? launchConfigurationSummary(task, agents) === null : false;
}

export function launchConfigurationSummary(
  task: TaskRow,
  agents: AgentsBundle,
): string | null {
  if (task.launch_config_confirmed_at === 0) return null;
  const harness = findAgent(agents, task.agent);
  const capabilities = harness?.capabilities;
  const model = capabilities?.models.find(
    (option) => option.value === task.model,
  );
  const reasoning = reasoningChoicesFor(
    agents,
    task.agent,
    task.model ?? "",
  ).find(
    (option) => option.value === task.reasoning,
  );
  if (!harness || !model || !reasoning) return null;
  return `${harness.label} · ${model.label} · ${reasoning.label}`;
}

export function reasoningChoicesFor(
  agents: AgentsBundle,
  agent: string,
  model: string,
): AgentPickerOption[] {
  const capabilities = findAgent(agents, agent)?.capabilities;
  if (!capabilities) return [];
  const modelOption = capabilities.models.find(
    (option) => option.value === model,
  );
  const supported = modelOption?.reasoningValues;
  return supported
    ? capabilities.reasoningOptions.filter((option) =>
        supported.includes(option.value),
      )
    : capabilities.reasoningOptions;
}

export function suggestLaunchConfiguration(
  task: TaskRow,
  agents: AgentsBundle,
  appDefaults: Record<string, string>,
  agent = task.agent,
): LaunchConfigurationSelection {
  const capabilities = findAgent(agents, agent)?.capabilities;
  const model =
    capabilities?.models.some((option) => option.value === task.model)
      ? task.model!
      : capabilities?.models[0]?.value ?? "";
  const reasoningChoices = reasoningChoicesFor(agents, agent, model);
  const validReasoning = new Set(
    reasoningChoices.map((option) => option.value),
  );
  const defaultReasoning =
    appDefaults[`default_reasoning:${agent}`] ??
    appDefaults.default_reasoning;
  const reasoning =
    (task.agent === agent &&
    task.reasoning &&
    validReasoning.has(task.reasoning)
      ? task.reasoning
      : null) ??
    (defaultReasoning && validReasoning.has(defaultReasoning)
      ? defaultReasoning
      : null) ??
    (validReasoning.has("think") ? "think" : null) ??
    reasoningChoices[0]?.value ??
    "";
  return { agent, model, reasoning };
}
