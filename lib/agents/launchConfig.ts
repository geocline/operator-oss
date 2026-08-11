import { getCapabilities, isKnownAgent } from "./capabilities";
import { getSetting } from "../store";
import type { AgentPickerOption } from "./types";

/** The run controls that carry an app-level default (Settings → Run defaults). */
export type RunDefaultKey =
  | "default_model"
  | "default_reasoning"
  | "default_permission_mode";

/**
 * The app-level default for one run control: agent-scoped first
 * ("default_model:claude"), then the legacy un-suffixed key — the same
 * resolution the drivers use, so a task created here and a turn run later agree
 * on what "the default" means. Null when nothing is configured.
 */
export function appRunDefault(key: RunDefaultKey, agent: string): string | null {
  return getSetting(`${key}:${agent}`) ?? getSetting(key);
}

/**
 * An app default is only usable if the chosen harness still offers it — models
 * and permission modes are per-CLI vocabularies, and a stored default survives
 * an agent switch, a CLI upgrade that drops a model, and a catalog refresh.
 * A stale one is dropped (null) rather than rejected: it's the instance's
 * setting, not something the caller sent, so it must never fail their request.
 */
export function usableRunDefault(
  options: readonly AgentPickerOption[],
  value: string | null,
): string | null {
  return value && options.some((option) => option.value === value) ? value : null;
}

/** The app default for a run control, already filtered against the harness. */
export function resolvedRunDefault(key: RunDefaultKey, agent: string): string | null {
  const capabilities = getCapabilities(agent);
  const options =
    key === "default_model"
      ? capabilities.models
      : key === "default_reasoning"
        ? capabilities.reasoningOptions
        : capabilities.permissionModes;
  return usableRunDefault(options, appRunDefault(key, agent));
}

export type LaunchConfiguration = {
  agent: string;
  model: string | null;
  reasoning: string | null;
};

export function validateLaunchConfiguration(
  config: LaunchConfiguration,
): string | null {
  if (!isKnownAgent(config.agent)) {
    return `Choose a registered harness before confirming setup.`;
  }
  const capabilities = getCapabilities(config.agent);
  const model = capabilities.models.find(
    (option) => option.value === config.model,
  );
  if (
    !config.model ||
    !model
  ) {
    return "Choose a model supported by this harness before confirming setup.";
  }
  const supportedReasoning = model.reasoningValues;
  if (
    !config.reasoning ||
    !capabilities.reasoningOptions.some(
      (option) =>
        option.value === config.reasoning &&
        (!supportedReasoning || supportedReasoning.includes(option.value)),
    )
  ) {
    return "Choose a Thinking strength supported by this model before confirming setup.";
  }
  return null;
}
