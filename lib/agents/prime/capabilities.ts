// SDK-free capability descriptor for the litellm-prime driver. Everything is
// derived from the shared Operator-tagged LiteLLM catalog filtered to the
// `prime` harness tag; the Prime-specific gates (Auto-run only, metered cost)
// live in liteLLMCapabilities("prime") so the two LiteLLM harnesses stay one
// implementation.

import type { AgentCapabilities } from "../types";
import { liteLLMCapabilities } from "../litellm/capabilities";

export function primeCapabilities(): AgentCapabilities {
  return liteLLMCapabilities("prime");
}
