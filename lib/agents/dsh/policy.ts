import { buildHarnessEnv } from "../shared";
import { isSubscriptionOnlyModelId } from "../litellm/family";

// dsh (DeepSeek Harness) is DeepSeek's own coding agent - Geo's standing
// "a lab's own harness runs its own models best" rule pairs it only with
// DeepSeek-family models. isSubscriptionOnlyModelId is belt-and-suspenders
// (already enforced at the catalog/capabilities choke points): an
// Anthropic/OpenAI alias must never reach this driver's spawn path either.
const DEEPSEEK_FAMILY = /deepseek/i;

export function assertDshModelAllowed(model: string | null | undefined): void {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("dsh turns require an explicit model; none was provided");
  }
  if (isSubscriptionOnlyModelId(model)) {
    throw new Error(`dsh model alias "${model}" is a subscription-only family and may not route through LiteLLM`);
  }
  if (!DEEPSEEK_FAMILY.test(model)) {
    throw new Error(`dsh only runs DeepSeek-family models; "${model}" does not look like one`);
  }
}

/**
 * Provider credentials stay inside LiteLLM. A dsh child receives only the
 * loopback relay token (injected by the driver at spawn, as DEEPSEEK_API_KEY)
 * and DEEPSEEK_BASE_URL pointed at the relay - never a real provider key.
 *
 * The name pattern is the broad credential-shaped one from
 * scripts/kimi-code-launcher.mjs, not Prime's narrower provider-key list: an
 * ambient GITHUB_TOKEN/NPM_TOKEN/COOKIE in the server's environment must not
 * reach the child either (the gap the Aug 14 admission security review found
 * in Prime's scrub). No allowlist is needed here because the driver injects
 * everything the child legitimately holds (DEEPSEEK_API_KEY, DSH_SESSION_ROOT,
 * SERVICE_TOKEN, ...) AFTER this scrub runs.
 */
const PROVIDER_SECRET_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "OPENROUTER_OPERATOR_API_KEY",
  "LITELLM_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
] as const;

const SECRET_NAME_PATTERN =
  /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION|OPENROUTER|LITELLM|DEEPSEEK)/i;

export function buildDshHarnessEnv(
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
