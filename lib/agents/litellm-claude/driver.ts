import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Project, StreamEvent, Task } from "../../types";
import type { AgentDriver, AgentLoginSession } from "../types";
import { CLAUDE_CLI_PATH, LITELLM_CLAUDE_HOME } from "../../config";
import { buildHarnessEnv } from "../shared";
import { runClaudeTurn } from "../claude/driver";
import { liteLLMCapabilities } from "../litellm/capabilities";
import { modelForHarness } from "../litellm/catalog";
import { refreshLiteLLMCatalog } from "../litellm/catalog-store";
import { getLiteLLMRelay } from "../litellm/relay";

const SCRUBBED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "LITELLM_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_OPERATOR_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "MISTRAL_API_KEY",
  "AZURE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_REGION",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
] as const;
// Managed turns inherit useful process context (PATH, locale, tool locations)
// but no ambient credential-shaped value. The relay token is injected only
// after this scrub, so it is the child's sole model-provider credential.
const CREDENTIAL_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION)/i;

export function buildLiteLLMClaudeEnv(
  taskId: string,
  model: string,
  relayOrigin: string,
  childApiKey: string,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env = buildHarnessEnv(taskId, baseEnv);
  for (const key of SCRUBBED_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_NAME.test(key)) delete env[key];
  }
  const configDir = path.resolve(LITELLM_CLAUDE_HOME, taskId);
  env.ANTHROPIC_BASE_URL = relayOrigin.replace(/\/v1\/?$/, "");
  env.ANTHROPIC_AUTH_TOKEN = childApiKey;
  env.CLAUDE_CONFIG_DIR = configDir;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.ANTHROPIC_SMALL_FAST_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  return env;
}

async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController,
): AsyncGenerator<StreamEvent> {
  const selected = modelForHarness(task.model ?? "", "claude");
  if (!selected) {
    yield {
      type: "error",
      content: `Claude Code can't run "${task.model || "Default"}" over LiteLLM: the gateway isn't offering that model for the claude harness right now. Check that the gateway is up and that the model lists claude under operator.harnesses (or a passing operator.admissions record), then refresh models in Settings.`,
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }

  const relay = await getLiteLLMRelay();
  const env = buildLiteLLMClaudeEnv(
    task.id,
    selected.value,
    relay.baseUrl,
    relay.childApiKey,
  );
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  yield* runClaudeTurn(task, project, userText, abortController, {
    model: selected.value,
    env,
    settingSources: [],
    reportCost: false,
  });
}

const managedLogin = (error: string | null): AgentLoginSession => ({
  status: error ? "error" : "success",
  url: null,
  email: null,
  plan: "LiteLLM",
  error,
  log: "",
});

export const liteLLMClaudeDriver: AgentDriver = {
  id: "litellm-claude",
  label: "Claude Code",
  get capabilities() {
    return liteLLMCapabilities("claude");
  },
  runTurn,
  async authStatus() {
    const authenticated = liteLLMCapabilities("claude").models.length > 0;
    return {
      authenticated,
      method: authenticated ? "managed_endpoint" : null,
      email: null,
      plan: authenticated ? "LiteLLM" : null,
      error: authenticated ? null : "Refresh vetted models in Settings",
    };
  },
  async startLogin() {
    return managedLogin("This route uses Operator's managed model catalog.");
  },
  getLogin() {
    return null;
  },
  async submitLoginCode() {
    return managedLogin("This route does not use an interactive login.");
  },
  cancelLogin() {},
  async verify() {
    try {
      const snapshot = await refreshLiteLLMCatalog();
      const count = snapshot.models.filter((model) => model.harnesses.includes("claude")).length;
      return { ok: count > 0, output: `${count} Claude Code-vetted model(s)`, error: null };
    } catch (error) {
      return { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
};
