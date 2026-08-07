import { mkdirSync } from "node:fs";
import { Codex } from "@openai/codex-sdk";
import type {
  ApprovalMode,
  CodexOptions,
  ModelReasoningEffort,
  SandboxMode,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { Project, StreamEvent, Task } from "../../types";
import type { AgentDriver, AgentLoginSession } from "../types";
import { LITELLM_CODEX_HOME, CODEX_CLI_PATH, INTERNAL_BASE_URL, ORCH_MCP_SCRIPT } from "../../config";
import { buildHarnessEnv, buildProjectContext, buildWorkstreamRuntimeGuidance } from "../shared";
import { getWorkstreamByTask } from "../../workstreams/store";
import { mapThreadEvent, newState } from "../codex/events";
import { liteLLMCapabilities } from "./capabilities";
import { getLiteLLMCatalog, modelForHarness } from "./catalog";
import { refreshLiteLLMCatalog } from "./catalog-store";
import { writeLiteLLMModelCatalog } from "./model-catalog";
import { getLiteLLMRelay } from "./relay";
import { appendOperatorSessionIndex } from "./session-index";

const EFFORT: Record<string, ModelReasoningEffort> = {
  off: "low",
  think: "medium",
  think_hard: "high",
  ultrathink: "xhigh",
};

type RunControls = {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  networkAccessEnabled: boolean;
};

function runControls(mode: string | null): RunControls {
  return mode === "plan"
    ? { sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false }
    : { sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: true };
}

function orchestratorMcpConfig(
  project: Project,
  task: Task,
  modelCatalogPath: string,
): CodexOptions["config"] {
  return {
    model_catalog_json: modelCatalogPath,
    mcp_servers: {
      orchestrator: {
        command: process.execPath,
        args: [ORCH_MCP_SCRIPT],
        tool_timeout_sec: 86_400,
        tools: {
          publish_workstream_update: { approval_mode: "approve" },
          propose_card_change: { approval_mode: "approve" },
        },
        env: {
          ORCH_TASK_ID: task.id,
          ORCH_PROJECT_ID: project.id,
          ORCH_BASE_URL: INTERNAL_BASE_URL,
          SERVICE_TOKEN: process.env.SERVICE_TOKEN || "",
        },
      },
    },
  };
}

export function buildLiteLLMHarnessEnv(taskId: string): Record<string, string> {
  const env = buildHarnessEnv(taskId);
  delete env.LITELLM_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_OPERATOR_API_KEY;
  env.CODEX_HOME = LITELLM_CODEX_HOME;
  return env;
}

async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController,
): AsyncGenerator<StreamEvent> {
  const selected = modelForHarness(task.model ?? "", "codex");
  if (!selected) {
    yield {
      type: "error",
      content: `LiteLLM model "${task.model || "Default"}" is unavailable. Refresh the catalog and choose an available model.`,
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }

  mkdirSync(LITELLM_CODEX_HOME, { recursive: true, mode: 0o700 });
  const modelCatalogPath = writeLiteLLMModelCatalog(
    LITELLM_CODEX_HOME,
    getLiteLLMCatalog().models,
  );
  const relay = await getLiteLLMRelay();
  const controls = runControls(task.permission_mode);
  const requestedEffort = task.reasoning ? EFFORT[task.reasoning] : undefined;
  const allowedEffort = requestedEffort && selected.reasoningOptions.includes(requestedEffort)
    ? requestedEffort
    : undefined;
  const threadOptions: ThreadOptions = {
    workingDirectory: task.worktree_path || project.repo_path || process.cwd(),
    skipGitRepoCheck: true,
    sandboxMode: controls.sandboxMode,
    approvalPolicy: controls.approvalPolicy,
    networkAccessEnabled: controls.networkAccessEnabled,
    model: selected.value,
    ...(allowedEffort ? { modelReasoningEffort: allowedEffort } : {}),
  };
  const codex = new Codex({
    codexPathOverride: CODEX_CLI_PATH || undefined,
    baseUrl: relay.baseUrl,
    apiKey: relay.childApiKey,
    config: orchestratorMcpConfig(project, task, modelCatalogPath),
    env: buildLiteLLMHarnessEnv(task.id),
  });
  const thread = task.session_id
    ? codex.resumeThread(task.session_id, threadOptions)
    : codex.startThread(threadOptions);
  const guidance = buildWorkstreamRuntimeGuidance(getWorkstreamByTask(task.id)?.state === "active");
  const prompt = task.session_id
    ? [guidance, userText].filter(Boolean).join("\n\n---\n\n")
    : [buildProjectContext(project, task), guidance, userText].filter(Boolean).join("\n\n---\n\n");

  yield { type: "model", model: selected.value };
  try {
    const { events } = await thread.runStreamed(prompt, { signal: abortController?.signal });
    const state = newState(selected.value);
    for await (const event of events) {
      for (const mapped of mapThreadEvent(event, state)) {
        // The native Codex mapper estimates OpenAI pricing. A LiteLLM alias may
        // resolve to any provider, so zero the untrustworthy estimate.
        if (mapped.type === "usage") mapped.usage.cost_usd = 0;
        yield mapped;
      }
    }
  } catch (error) {
    if (!abortController?.signal.aborted) {
      yield { type: "error", content: error instanceof Error ? error.message : String(error) };
    }
  }
  const sessionId = thread.id ?? task.session_id;
  if (sessionId) {
    appendOperatorSessionIndex(LITELLM_CODEX_HOME, {
      session_id: sessionId,
      task_id: task.id,
      project_id: project.id,
      task_title: task.title,
      project_path: project.repo_path,
      harness: "codex",
      model: selected.value,
      updated_at: new Date().toISOString(),
    });
  }
  yield { type: "done", sessionId };
}

const managedLogin = (error: string | null): AgentLoginSession => ({
  status: error ? "error" : "success",
  url: null,
  email: null,
  plan: "LiteLLM",
  error,
  log: "",
});

export const liteLLMCodexDriver: AgentDriver = {
  id: "litellm-codex",
  label: "LiteLLM · Codex harness",
  get capabilities() {
    return liteLLMCapabilities();
  },
  runTurn,
  async authStatus() {
    const status = liteLLMCapabilities().models.length > 0;
    return {
      authenticated: status,
      method: status ? "managed_endpoint" : null,
      email: null,
      plan: status ? "LiteLLM" : null,
      error: status ? null : "Refresh LiteLLM models in Settings",
    };
  },
  async startLogin() {
    return managedLogin("LiteLLM is a managed local endpoint; refresh its model catalog instead.");
  },
  getLogin() {
    return null;
  },
  async submitLoginCode() {
    return managedLogin("LiteLLM does not use an interactive login.");
  },
  cancelLogin() {},
  async verify() {
    try {
      const snapshot = await refreshLiteLLMCatalog();
      return { ok: snapshot.models.length > 0, output: `${snapshot.models.length} tagged model(s)`, error: null };
    } catch (error) {
      return { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
};
