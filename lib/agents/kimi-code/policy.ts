import path from "node:path";
import { LITELLM_KIMI_CODE_HOME } from "../../config";
import { buildHarnessEnv } from "../shared";

const SAFE_TASK_ID = /^[A-Za-z0-9_-]+$/;
const CREDENTIAL_NAME =
  /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION)/i;

export interface KimiCodeModelRoute {
  value: string;
  label: string;
  contextWindow: number | null;
  reasoningOptions: string[];
}

export function kimiEffortForReasoning(
  reasoning: string | null,
  supported: string[],
): "low" | "medium" | "high" | "xhigh" {
  const selected = reasoning === null || reasoning === "think_hard"
    ? "high"
    : null;
  if (!selected || !supported.includes(selected)) {
    throw new Error(
      `Kimi Code Wire CLI supports only high reasoning for this pairing; preset ${reasoning ?? "default"} is not supported.`,
    );
  }
  return selected;
}

export function kimiCodeTaskHome(taskId: string): string {
  if (!SAFE_TASK_ID.test(taskId)) {
    throw new Error("Kimi Code task id must contain only letters, digits, hyphens, or underscores");
  }
  return path.join(LITELLM_KIMI_CODE_HOME, taskId);
}

export function buildKimiCodeEnv(
  taskId: string,
  model: KimiCodeModelRoute,
  relayBaseUrl: string,
  relayToken: string,
  reasoning: string | null,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env = buildHarnessEnv(taskId, baseEnv);
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_NAME.test(key)) delete env[key];
  }

  const taskHome = kimiCodeTaskHome(taskId);
  env.HOME = taskHome;
  env.KIMI_CODE_HOME = taskHome;
  env.KIMI_SHARE_DIR = taskHome;
  env.KIMI_DISABLE_TELEMETRY = "1";
  env.DO_NOT_TRACK = "1";
  kimiEffortForReasoning(reasoning, model.reasoningOptions);
  // The official Wire CLI accepts inline config, but its provider fields are
  // deliberately inert: the disposable relay key, URL, and exact model alias
  // are overlaid from environment variables only inside the supervised child.
  env.ORCH_KIMI_INLINE_CONFIG = JSON.stringify({
    default_model: "operator-relay",
    models: {
      "operator-relay": {
        provider: "operator-relay",
        model: "operator-placeholder",
        max_context_size: model.contextWindow ?? 200_000,
        capabilities: ["thinking"],
        display_name: model.label,
      },
    },
    providers: {
      "operator-relay": {
        type: "kimi",
        base_url: "http://127.0.0.1:1/v1",
        api_key: "",
      },
    },
  });
  env.KIMI_MODEL_NAME = model.value;
  env.KIMI_API_KEY = relayToken;
  env.KIMI_BASE_URL = relayBaseUrl.replace(/\/+$/, "");
  env.KIMI_MODEL_MAX_CONTEXT_SIZE = String(model.contextWindow ?? 200_000);
  // Wire CLI 1.49 otherwise treats the entire remaining context window as
  // the completion budget. A million-token model would therefore advertise
  // roughly 930k output tokens to OpenRouter, which is both unsafe and commonly
  // rejected at credit preflight. Keep each agent step explicitly bounded.
  env.KIMI_MODEL_MAX_COMPLETION_TOKENS = "16384";
  env.KIMI_MODEL_CAPABILITIES = "thinking";
  return env;
}
