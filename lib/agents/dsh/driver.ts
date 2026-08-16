import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, StreamEvent, Task } from "../../types";
import type { AgentDriver, AgentLoginSession } from "../types";
import { DSH_CLI_PATH, INTERNAL_BASE_URL, LITELLM_DSH_HOME } from "../../config";
import { buildProjectContext, buildWorkstreamRuntimeGuidance, makeQueue } from "../shared";
import { getWorkstreamByTask } from "../../workstreams/store";
import { liteLLMCapabilities } from "../litellm/capabilities";
import { modelForHarness } from "../litellm/catalog";
import { refreshLiteLLMCatalog } from "../litellm/catalog-store";
import { getLiteLLMRelay } from "../litellm/relay";
import { appendOperatorSessionIndex } from "../litellm/session-index";
import { mapDshEvent, newDshState, type DshSessionEvent } from "./events";
import { assertDshModelAllowed, buildDshHarnessEnv } from "./policy";
import { startDshRpc, type DshRpcClient } from "./rpc";
import { ensureDshTaskDirs } from "./session-paths";

/**
 * The litellm-dsh driver: DeepSeek Harness (dsh) as a pinned external runtime
 * over real JSON-RPC 2.0 stdio, billing through Operator's loopback LiteLLM
 * relay. See docs/superpowers/specs/2026-08-16-litellm-dsh-driver.md.
 *
 * There is no working npm package for the JSON-RPC composition this driver
 * needs (`@deepseek-ai/dsh-sdk-jsonrpc-server` and every LLM-adapter plugin
 * peer-depend on `@deepseek-ai/dsh-environment`, which does not exist on the
 * npm registry - confirmed via `npm view`/`pnpm add` 404s during this build).
 * The Python SDK's platform wheel (`deepseek-harness-runtime-bin`, installed
 * via `pip install deepseek-harness-sdk`) ships a prebuilt single-file
 * executable of the exact same composition, which this driver spawns
 * directly - no Python at runtime, same as spawning any other pinned CLI.
 *
 * dsh is NOT an OS sandbox in the composition this driver drives (no sandbox
 * plugin is wired in), which is why dshCapabilities() exposes Auto-run only.
 * The packaged binary also has no MCP-client plugin compiled in (verified by
 * scanning it for `@deepseek-ai/dsh-mcp-client` - absent), so the Operator
 * orchestrator tools (suggest_task/expose_service/ask_user) do not attach to
 * dsh tasks in this pass.
 */

// Live RPC clients by task id (HMR-surviving, like lib/agents/prime/driver.ts)
// so task deletion can await real process-tree settlement instead of racing it.
const liveClients = (globalThis as typeof globalThis & {
  __operatorDshClients?: Map<string, Set<DshRpcClient>>;
}).__operatorDshClients ??= new Map<string, Set<DshRpcClient>>();
(globalThis as typeof globalThis & { __operatorDshClients?: Map<string, Set<DshRpcClient>> }).__operatorDshClients = liveClients;

function trackClient(taskId: string, client: DshRpcClient): void {
  if (!liveClients.has(taskId)) liveClients.set(taskId, new Set());
  liveClients.get(taskId)!.add(client);
  void client.settled.then(() => {
    const set = liveClients.get(taskId);
    set?.delete(client);
    if (set && set.size === 0) liveClients.delete(taskId);
  });
}

/**
 * Stop and await every live dsh client for a task (bounded). Called by the
 * task DELETE route before its dsh state is removed, so no process from the
 * task can outlive (or re-populate) the directory being retired.
 */
export async function settleDshTask(taskId: string, timeoutMs = 15_000): Promise<void> {
  const clients = [...(liveClients.get(taskId) ?? [])];
  if (!clients.length) return;
  await Promise.race([
    Promise.all(clients.map((client) => client.stop().catch(() => undefined))),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/** Resolved per turn so a relocated binary or a test override applies without a restart. */
function dshCliPath(): string {
  return process.env.DSH_CLI_PATH || DSH_CLI_PATH;
}

/**
 * Task-local dsh composition. Written fresh every turn (no secrets - the
 * relay base URL/key arrive as env only, never on disk). Loads the bare
 * plugin names that ARE compiled into the packaged runtime binary (verified
 * by scanning it: `strings dsh-jsonrpc-agent-pkg-* | grep '@deepseek-ai/dsh-'`)
 * - read/write/edit + bash tool surface, JSONL session persistence, and
 * checkpointing. No MCP entry: the binary has no MCP-client plugin bundled.
 */
function writeDshConfig(configFile: string): void {
  const yaml = [
    "- id: sdk-jsonrpc-server",
    "  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'",
    "  config:",
    "    maxTokensAsSuccess: true",
    "",
    "- id: agent-core",
    "  name: '@deepseek-ai/dsh-agent-spine-demo'",
    "  config:",
    "    workspaceContext:",
    "      maxBytes: 65536",
    "    skills:",
    "      enabled: false",
    "",
    "- id: llm-deepseek",
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
    "",
    "- id: sessions",
    "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    "  config:",
    "    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'",
    "",
    "- id: session-checkpoints",
    "  name: '@deepseek-ai/dsh-session-checkpoint-policy'",
    "",
    "- id: subprocess",
    "  name: '@deepseek-ai/dsh-subprocess-local'",
    "",
    "- id: bash",
    "  name: '@deepseek-ai/dsh-bash-local'",
    "  config:",
    "    cwd: !!js process.env.DSH_CWD ?? process.cwd()",
    "",
    "- id: fs-local",
    "  name: '@deepseek-ai/dsh-fs-local'",
    "  config:",
    "    cwd: !!js process.env.DSH_CWD ?? process.cwd()",
    "",
    "- id: fs-observation-policy",
    "  name: '@deepseek-ai/dsh-fs-observation-policy'",
    "",
    "- id: tool-fs",
    "  name: '@deepseek-ai/dsh-tool-fs'",
    "",
  ].join("\n");
  writeFileSync(configFile, yaml, { mode: 0o600 });
}

async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController,
): AsyncGenerator<StreamEvent> {
  const selected = modelForHarness(task.model ?? "", "dsh");
  if (!selected) {
    yield {
      type: "error",
      content: `dsh can't run "${task.model || "(none)"}": the LiteLLM gateway isn't offering that model for dsh right now. Check that the gateway is up and that the model lists dsh under operator.harnesses (or a passing operator.admissions record), then refresh models in Settings.`,
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }
  try {
    assertDshModelAllowed(selected.value);
  } catch (error) {
    yield { type: "error", content: error instanceof Error ? error.message : String(error) };
    yield { type: "done", sessionId: task.session_id };
    return;
  }

  const cli = dshCliPath();
  if (!cli || (path.isAbsolute(cli) && !existsSync(cli))) {
    yield {
      type: "error",
      content: `The dsh runtime is not installed. Run \`pip install deepseek-harness-sdk\` and set DSH_CLI_PATH to the resolved dsh-jsonrpc-agent executable (python -c "from deepseek_harness_runtime import bundled_runtime_path; print(bundled_runtime_path())"); this task stays on dsh and will not fall back to another agent.`,
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }

  let client: DshRpcClient | null = null;
  const state = newDshState();
  const queue = makeQueue<StreamEvent>();
  let agentEnded = false;

  const dshSessionId = task.session_id || randomUUID();

  try {
    const paths = ensureDshTaskDirs(task.id, task.generation);
    const relay = await getLiteLLMRelay();
    writeDshConfig(paths.configFile);

    const workDir = task.worktree_path || project.repo_path || process.cwd();
    const env = buildDshHarnessEnv(task.id);
    env.DEEPSEEK_API_KEY = relay.childApiKey;
    env.DEEPSEEK_BASE_URL = relay.baseUrl;
    env.DSH_CWD = workDir;
    env.DSH_SESSION_ROOT = paths.sessionDir;
    env.DSH_CORDIS_CONFIG = paths.configFile;
    env.DO_NOT_TRACK = "1";
    // The Operator process's tool-context wiring (same contract as
    // orch-mcp.mjs), unused by this driver in this pass (no MCP entry in the
    // composition) but harmless to carry for parity/future wiring.
    env.ORCH_TASK_ID = task.id;
    env.ORCH_PROJECT_ID = project.id;
    env.ORCH_BASE_URL = INTERNAL_BASE_URL;
    env.SERVICE_TOKEN = process.env.SERVICE_TOKEN || "";

    client = startDshRpc({
      executable: cli,
      args: [],
      cwd: workDir,
      env,
      signal: abortController?.signal,
      onNotification(notification) {
        if (notification.method === "session.event") {
          const event = notification.params.event as DshSessionEvent | undefined;
          if (!event) return;
          for (const mapped of mapDshEvent(event, state)) {
            queue.push(mapped);
          }
          if (event.type === "turn/end") {
            agentEnded = true;
            queue.close();
          }
        }
      },
    });
    trackClient(task.id, client);
    void client.settled.then(() => queue.close());

    await client.request("initialize", { cwd: workDir, provider: "deepseek-official", model: selected.value });
    queue.push({ type: "session", sessionId: dshSessionId });
    queue.push({ type: "model", model: selected.value });

    const guidance = buildWorkstreamRuntimeGuidance(getWorkstreamByTask(task.id)?.state === "active");
    const prompt = task.session_id
      ? [guidance, userText].filter(Boolean).join("\n\n---\n\n")
      : [buildProjectContext(project, task), guidance, userText].filter(Boolean).join("\n\n---\n\n");

    let promptError: Error | null = null;
    const promptDone = client
      .request("session/prompt", { sessionId: dshSessionId, contentBlocks: [{ type: "text", text: prompt }] })
      .catch((error: Error) => {
        promptError = error;
        queue.close();
      });

    let yieldedError = false;
    for await (const event of queue.drain()) {
      if (event.type === "error" && (abortController?.signal.aborted || state.outcome === "aborted")) continue;
      if (event.type === "error") yieldedError = true;
      yield event;
    }
    await promptDone;
    if (promptError && !yieldedError && !abortController?.signal.aborted) {
      yield { type: "error", content: (promptError as Error).message };
    }

    if (agentEnded && state.latestTokenUsage && !yieldedError) {
      yield {
        type: "notice",
        content: "dsh reported token usage, but trusted metered cost was not recorded in-stream; provider reconciliation is required.",
      };
    }
  } catch (error) {
    if (!abortController?.signal.aborted) {
      yield { type: "error", content: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    // Settle the whole process tree BEFORE final bookkeeping - nothing may
    // still be generating when the turn reports its outcome.
    if (client) await client.stop();
  }

  appendOperatorSessionIndex(LITELLM_DSH_HOME, {
    session_id: dshSessionId,
    task_id: task.id,
    project_id: project.id,
    task_title: task.title,
    project_path: project.repo_path,
    harness: "dsh",
    model: selected.value,
    updated_at: new Date().toISOString(),
  });
  yield { type: "done", sessionId: dshSessionId };
}

const managedLogin = (error: string | null): AgentLoginSession => ({
  status: error ? "error" : "success",
  url: null,
  email: null,
  plan: "LiteLLM",
  error,
  log: "",
});

export const dshDriver: AgentDriver = {
  id: "litellm-dsh",
  label: "DSH (DeepSeek)",
  get capabilities() {
    return liteLLMCapabilities("dsh");
  },
  runTurn,
  async authStatus() {
    const status = liteLLMCapabilities("dsh").models.length > 0;
    return {
      authenticated: status,
      method: status ? "managed_endpoint" : null,
      email: null,
      plan: status ? "LiteLLM" : null,
      error: status ? null : "Refresh LiteLLM models in Settings",
    };
  },
  async startLogin() {
    return managedLogin("dsh runs against the managed local LiteLLM endpoint; refresh its model catalog instead.");
  },
  getLogin() {
    return null;
  },
  async submitLoginCode() {
    return managedLogin("dsh does not use an interactive login.");
  },
  cancelLogin() {},
  async verify() {
    try {
      const snapshot = await refreshLiteLLMCatalog();
      const dshModels = snapshot.models.filter((m) => m.harnesses.includes("dsh"));
      return { ok: dshModels.length > 0, output: `${dshModels.length} dsh-tagged model(s)`, error: null };
    } catch (error) {
      return { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
};
