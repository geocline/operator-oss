import { getCapabilities, isKnownAgent } from "./capabilities";

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
