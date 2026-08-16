import type { AgentCapabilities } from "../types";
import { liteLLMCapabilities } from "../litellm/capabilities";

export function kimiCodeCapabilities(): AgentCapabilities {
  const capabilities = liteLLMCapabilities("kimi-code");
  const high = capabilities.reasoningOptions.find(
    (option) => option.value === "think_hard",
  );
  return {
    ...capabilities,
    models: capabilities.models.map((model) => ({
      ...model,
      reasoningValues: model.reasoningValues?.includes("think_hard")
        ? ["think_hard"]
        : [],
    })),
    reasoningOptions: high ? [high] : [],
  };
}
