import { buildHarnessEnv } from "../shared";

/**
 * Hard policy: Prime may run only the exact approved Kimi alias. Never an
 * OpenAI or Anthropic model, never a provider-qualified or fallback-suffixed
 * value. Enforced before launch and re-checked against the resolved physical
 * identity before a turn may complete successfully.
 */
export const APPROVED_PRIME_MODEL = "operator.kimi-k3";

export function assertPrimeModelAllowed(model: string | null | undefined): void {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("Prime turns require an explicit model; none was provided");
  }
  if (model !== APPROVED_PRIME_MODEL) {
    throw new Error(
      `Prime may only run the approved alias "${APPROVED_PRIME_MODEL}"; got "${model}"`,
    );
  }
}

/**
 * Provider credentials stay inside LiteLLM. A Prime child receives only the
 * loopback relay token (injected by the driver at spawn), never these.
 */
const PROVIDER_SECRET_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "OPENROUTER_OPERATOR_API_KEY",
  "LITELLM_API_KEY",
] as const;

export function buildPrimeHarnessEnv(
  taskId: string,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env = buildHarnessEnv(taskId, baseEnv);
  for (const key of PROVIDER_SECRET_ENV) delete env[key];
  return env;
}
