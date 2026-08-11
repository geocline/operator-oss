import { buildHarnessEnv } from "../shared";

/** Legacy default retained for old sessions; catalog admission is authoritative. */
export const APPROVED_PRIME_MODEL = "operator.kimi-k3";

export function assertPrimeModelAllowed(model: string | null | undefined): void {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("Prime turns require an explicit model; none was provided");
  }
  if (/[-/:]fallback\b/i.test(model)) {
    throw new Error(`Prime model alias "${model}" may not use a fallback route`);
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

// Denylisting six names is not enough: a provider credential under ANY name
// (GOOGLE_API_KEY, MISTRAL_API_KEY, a shell-profile leak) must not reach the
// Prime child. Strip everything whose NAME reads like a credential; the
// driver re-injects the only secrets the child may hold (the relay token and
// SERVICE_TOKEN) after this scrub.
const SECRET_NAME_PATTERN = /(API_?KEY|APIKEY|AUTH_?TOKEN|ACCESS_?TOKEN|SECRET|OPENROUTER|LITELLM)/i;

export function buildPrimeHarnessEnv(
  taskId: string,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env = buildHarnessEnv(taskId, baseEnv) as NodeJS.ProcessEnv;
  for (const key of PROVIDER_SECRET_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (SECRET_NAME_PATTERN.test(key)) delete env[key];
  }
  return env;
}
