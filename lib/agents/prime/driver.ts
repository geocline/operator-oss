import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Project, StreamEvent, Task } from "../../types";
import type { AgentDriver, AgentLoginSession } from "../types";
import {
  INTERNAL_BASE_URL,
  LITELLM_PRIME_HOME,
  PRIME_OPERATOR_EXTENSION_PATH,
} from "../../config";
import { buildProjectContext, buildWorkstreamRuntimeGuidance, makeQueue, taskCwd } from "../shared";
import { getWorkstreamByTask } from "../../workstreams/store";
import { liteLLMCapabilities } from "../litellm/capabilities";
import { modelForHarness } from "../litellm/catalog";
import { refreshLiteLLMCatalog } from "../litellm/catalog-store";
import { getLiteLLMRelay } from "../litellm/relay";
import { appendOperatorSessionIndex } from "../litellm/session-index";
import { mapPrimeEvent, newPrimeState } from "./events";
import { assertPrimeModelAllowed, buildPrimeHarnessEnv } from "./policy";
import { startPrimeRpc, type PrimeRpcClient } from "./rpc";
import { ensurePrimeTaskDirs } from "./session-paths";

/**
 * The litellm-prime driver: Prime Agent as a pinned external CLI over JSONL
 * RPC, billing through Operator's loopback LiteLLM relay against the exact
 * exact Prime-vetted model alias. Additive next to native Claude/Codex;
 * see docs/superpowers/specs/2026-08-10-prime-agent-operator-integration-design.md.
 *
 * Prime is NOT an OS sandbox — the child runs with the Operator process's host
 * permissions, which is why primeCapabilities() exposes Auto-run only.
 */

const PROVIDER_ID = "operator-litellm";

// Live RPC clients by task id (HMR-surviving, like lib/abort.ts) so task
// deletion can await real process-tree settlement instead of racing it.
const liveClients = (globalThis as typeof globalThis & {
  __operatorPrimeClients?: Map<string, Set<PrimeRpcClient>>;
}).__operatorPrimeClients ??= new Map<string, Set<PrimeRpcClient>>();
(globalThis as typeof globalThis & { __operatorPrimeClients?: Map<string, Set<PrimeRpcClient>> }).__operatorPrimeClients = liveClients;

function trackClient(taskId: string, client: PrimeRpcClient): void {
  if (!liveClients.has(taskId)) liveClients.set(taskId, new Set());
  liveClients.get(taskId)!.add(client);
  void client.settled.then(() => {
    const set = liveClients.get(taskId);
    set?.delete(client);
    if (set && set.size === 0) liveClients.delete(taskId);
  });
}

/**
 * Stop and await every live Prime client for a task (bounded). Called by the
 * task DELETE route before its Prime state is removed, so no process from the
 * task can outlive (or re-populate) the directory being retired.
 */
export async function settlePrimeTask(taskId: string, timeoutMs = 15_000): Promise<void> {
  const clients = [...(liveClients.get(taskId) ?? [])];
  if (!clients.length) return;
  await Promise.race([
    Promise.all(clients.map((client) => client.stop().catch(() => undefined))),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/** Resolved per turn so a relocated CLI or a test override applies without a restart. */
function primeCliPath(): string {
  return process.env.PRIME_CLI_PATH || "prime-agent";
}

/**
 * Task-local Prime provider/model configuration. Written fresh every turn so a
 * catalog or relay change applies on the next turn; contains no credentials —
 * the relay child token arrives via env (PRIME_RELAY_API_KEY) only.
 */
function writePrimeConfig(
  configDir: string,
  relayBaseUrl: string,
  model: { value: string; label: string; contextWindow: number | null },
): void {
  const models = {
    providers: {
      [PROVIDER_ID]: {
        baseUrl: relayBaseUrl,
        api: "openai-completions",
        apiKey: "PRIME_RELAY_API_KEY",
        authHeader: true,
        models: [
          {
            id: model.value,
            name: model.label,
            reasoning: true,
            input: ["text"],
            contextWindow: model.contextWindow ?? 200_000,
            maxTokens: 32_768,
          },
        ],
      },
    },
  };
  const settings = {
    defaultProvider: PROVIDER_ID,
    defaultModel: model.value,
    telemetry: { enabled: false },
    autoRefine: { enabled: false, compact: false },
  };
  writeFileSync(path.join(configDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path.join(configDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController,
): AsyncGenerator<StreamEvent> {
  const selected = modelForHarness(task.model ?? "", "prime");
  if (!selected) {
    yield {
      type: "error",
      content: `Prime can't run "${task.model || "(none)"}": the LiteLLM gateway isn't offering that model for Prime right now. Check that the gateway is up and that the model lists prime under operator.harnesses (or a passing operator.admissions record), then refresh models in Settings.`,
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }
  try {
    assertPrimeModelAllowed(selected.value);
  } catch (error) {
    yield { type: "error", content: error instanceof Error ? error.message : String(error) };
    yield { type: "done", sessionId: task.session_id };
    return;
  }

  const cli = primeCliPath();
  if (path.isAbsolute(cli) && !existsSync(cli)) {
    yield {
      type: "error",
      content: `The prime-agent CLI is missing at ${cli}. Install the pinned Prime Agent (or set PRIME_CLI_PATH); this task stays on Prime and will not fall back to another agent.`,
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }

  let client: PrimeRpcClient | null = null;
  const expectedResolvedModel = selected.admissions?.find(
    (admission) => admission.harness === "prime" && admission.status === "passed",
  )?.resolvedModel;
  const state = newPrimeState(selected.value, expectedResolvedModel);
  const queue = makeQueue<StreamEvent>();
  let agentEnded = false;
  let sawUsage = false;

  try {
    const paths = ensurePrimeTaskDirs(task.id, task.generation);
    const relay = await getLiteLLMRelay();
    writePrimeConfig(paths.configDir, relay.baseUrl, selected);

    const env = buildPrimeHarnessEnv(task.id);
    env.PRIME_RELAY_API_KEY = relay.childApiKey;
    env.PRIME_AGENT_CODING_AGENT_DIR = paths.configDir;
    env.PRIME_AGENT_SESSION_DIR = paths.sessionDir;
    env.PRIME_AGENT_TELEMETRY = "0";
    env.DO_NOT_TRACK = "1";
    env.PI_SKIP_VERSION_CHECK = "1";
    // The Operator extension's per-turn wiring (same contract as orch-mcp.mjs).
    env.ORCH_TASK_ID = task.id;
    env.ORCH_PROJECT_ID = project.id;
    env.ORCH_BASE_URL = INTERNAL_BASE_URL;
    env.SERVICE_TOKEN = process.env.SERVICE_TOKEN || "";

    const args = [
      "--mode", "rpc",
      "--cwd", taskCwd(task, project),
      "--provider", PROVIDER_ID,
      "--model", selected.value,
      "--session-dir", paths.sessionDir,
      // Only the Operator extension loads; user/global extensions, skills, and
      // prompt templates stay off in the first release. Repository context
      // files (AGENTS.md/CLAUDE.md) deliberately remain enabled.
      "--extension", PRIME_OPERATOR_EXTENSION_PATH,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
    ];
    if (task.session_id) args.push("--resume", task.session_id);

    client = startPrimeRpc({
      executable: cli,
      args,
      cwd: taskCwd(task, project),
      env,
      signal: abortController?.signal,
      onEvent(event) {
        for (const mapped of mapPrimeEvent(event, state)) {
          // The driver owns the terminal done (after stats + session index).
          if (mapped.type === "done") continue;
          if (mapped.type === "usage") sawUsage = true;
          queue.push(mapped);
        }
        if (event.type === "agent_end") {
          agentEnded = true;
          queue.close();
        }
      },
    });
    trackClient(task.id, client);
    void client.settled.then(() => queue.close());

    const guidance = buildWorkstreamRuntimeGuidance(getWorkstreamByTask(task.id)?.state === "active");
    const prompt = task.session_id
      ? [guidance, userText].filter(Boolean).join("\n\n---\n\n")
      : [buildProjectContext(project, task), guidance, userText].filter(Boolean).join("\n\n---\n\n");

    // Real prime-agent reports its persisted session file via get_state, not
    // agent_start; fetch it up front so resume and the session index work.
    let promptError: Error | null = null;
    const sessionProbe = client
      .request("get_state", {}, { timeoutMs: 30_000 })
      .then((res) => {
        const file = (res.data as { sessionFile?: unknown } | undefined)?.sessionFile;
        if (typeof file === "string" && file.trim() && !state.sessionId) {
          state.sessionId = file;
          queue.push({ type: "session", sessionId: file });
        }
      })
      .catch(() => {
        // Session identity comes from the stream (fake CLI) or stays null;
        // a failed probe alone must not kill the turn.
      });

    // A failed prompt request may race the queue closing on process exit, so
    // the failure is kept aside and yielded after the drain if needed.
    const promptDone = sessionProbe.then(() =>
      client!.request("prompt", { message: prompt }).catch((error: Error) => {
        promptError = error;
        queue.close();
      }),
    );

    let yieldedError = false;
    for await (const event of queue.drain()) {
      // Abort must end the stream without an error event.
      if (event.type === "error" && (abortController?.signal.aborted || state.outcome === "aborted")) continue;
      if (event.type === "error") yieldedError = true;
      yield event;
    }
    await promptDone;
    if (promptError && !yieldedError && !abortController?.signal.aborted) {
      yield { type: "error", content: (promptError as Error).message };
    }

    // Trusted usage backstop: per-message usage is primary; when a turn ended
    // without one, read session stats while the process is still alive. Cost
    // is metered or absent — never estimated.
    if (agentEnded && !sawUsage && !abortController?.signal.aborted) {
      try {
        const stats = await client.request("get_session_stats", {}, { timeoutMs: 5_000 });
        const usage = (stats.data as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } | undefined)?.usage;
        if (usage) {
          yield {
            type: "usage",
            usage: {
              cost_usd: typeof usage.cost?.total === "number" ? usage.cost.total : 0,
              input_tokens: usage.input ?? 0,
              output_tokens: usage.output ?? 0,
              cache_read_tokens: usage.cacheRead ?? 0,
              cache_creation_tokens: usage.cacheWrite ?? 0,
            },
          };
        }
      } catch {
        // Stats are best-effort; the turn still settles.
      }
    }
  } catch (error) {
    if (!abortController?.signal.aborted) {
      yield { type: "error", content: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    // Settle the whole process tree BEFORE final attribution/session bookkeeping
    // — nothing may still be generating when the turn reports its outcome.
    if (client) await client.stop();
  }

  const sessionId = state.sessionId ?? task.session_id;
  if (sessionId) {
    appendOperatorSessionIndex(LITELLM_PRIME_HOME, {
      session_id: sessionId,
      task_id: task.id,
      project_id: project.id,
      task_title: task.title,
      project_path: project.repo_path,
      harness: "prime",
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

export const primeAgentDriver: AgentDriver = {
  id: "litellm-prime",
  label: "Prime Agent",
  get capabilities() {
    return liteLLMCapabilities("prime");
  },
  runTurn,
  async authStatus() {
    const status = liteLLMCapabilities("prime").models.length > 0;
    return {
      authenticated: status,
      method: status ? "managed_endpoint" : null,
      email: null,
      plan: status ? "LiteLLM" : null,
      error: status ? null : "Refresh LiteLLM models in Settings",
    };
  },
  async startLogin() {
    return managedLogin("Prime runs against the managed local LiteLLM endpoint; refresh its model catalog instead.");
  },
  getLogin() {
    return null;
  },
  async submitLoginCode() {
    return managedLogin("Prime does not use an interactive login.");
  },
  cancelLogin() {},
  async verify() {
    try {
      const snapshot = await refreshLiteLLMCatalog();
      const primeModels = snapshot.models.filter((m) => m.harnesses.includes("prime"));
      return { ok: primeModels.length > 0, output: `${primeModels.length} Prime-tagged model(s)`, error: null };
    } catch (error) {
      return { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
};
