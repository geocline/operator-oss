import { existsSync } from "node:fs";
import path from "node:path";
import { createSession } from "@moonshot-ai/kimi-agent-sdk";
import type { Session } from "@moonshot-ai/kimi-agent-sdk";
import type { Project, StreamEvent, Task } from "../../types";
import type { AgentDriver, AgentLoginSession } from "../types";
import { KIMI_CODE_CLI_PATH, LITELLM_KIMI_CODE_HOME } from "../../config";
import { waitForAnswer } from "../../asks";
import { modelForHarness } from "../litellm/catalog";
import { refreshLiteLLMCatalog } from "../litellm/catalog-store";
import { appendOperatorSessionIndex } from "../litellm/session-index";
import { getLiteLLMRelay } from "../litellm/relay";
import {
  buildProjectContext,
  buildWorkstreamRuntimeGuidance, taskCwd,
} from "../shared";
import { getWorkstreamByTask } from "../../workstreams/store";
import { kimiCodeCapabilities } from "./capabilities";
import { mapKimiCodeEvent, newKimiCodeState } from "./events";
import { buildKimiCodeEnv, kimiCodeTaskHome } from "./policy";
import {
  assertKimiCodeSettlement,
  createKimiCodeSettlementPath,
  ensureKimiCodeTaskHome,
} from "./session-paths";
import { kimiCodeOperatorTools } from "./tools";
import { assertCompatibleKimiWireCli } from "./cli-contract";

function cliPath(): string {
  return process.env.KIMI_CODE_CLI_PATH || KIMI_CODE_CLI_PATH;
}

function launcherPath(): string {
  return path.join(process.cwd(), "scripts", "kimi-code-launcher.mjs");
}

type LiveKimiSession = {
  session: Session;
  settlementFile: string;
};

const liveSessions = (globalThis as typeof globalThis & {
  __operatorKimiCodeSessions?: Map<string, Set<LiveKimiSession>>;
}).__operatorKimiCodeSessions ??= new Map<string, Set<LiveKimiSession>>();

type KimiQuestionRequest = {
  id: string;
  tool_call_id: string;
  questions: Array<{ question: string }>;
};

function trackSession(taskId: string, live: LiveKimiSession): void {
  if (!liveSessions.has(taskId)) liveSessions.set(taskId, new Set());
  liveSessions.get(taskId)!.add(live);
}

function untrackSession(taskId: string, live: LiveKimiSession): void {
  const sessions = liveSessions.get(taskId);
  sessions?.delete(live);
  if (sessions?.size === 0) liveSessions.delete(taskId);
}

async function closeAndVerify(live: LiveKimiSession): Promise<void> {
  await live.session.close();
  assertKimiCodeSettlement(live.settlementFile);
}

export async function settleKimiCodeTask(
  taskId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const sessions = [...(liveSessions.get(taskId) ?? [])];
  if (!sessions.length) return;
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`Kimi Code process settlement timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ).unref();
  });
  await Promise.race([
    Promise.all(sessions.map(closeAndVerify)).then(() => undefined),
    timeout,
  ]);
}

async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController,
): AsyncGenerator<StreamEvent> {
  const selected = modelForHarness(task.model ?? "", "kimi-code");
  if (!selected) {
    yield {
      type: "error",
      content: `Kimi Code can't run "${task.model || "(none)"}": the LiteLLM gateway is not offering that exact model for the kimi-code harness.`,
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }
  const executable = cliPath();
  if (path.isAbsolute(executable) && !existsSync(executable)) {
    yield {
      type: "error",
      content: `Kimi Code is missing at ${executable}. Install the pinned Kimi Code CLI (or set KIMI_CODE_CLI_PATH); this task stays on Kimi Code and will not fall back to another harness.`,
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }
  try {
    assertCompatibleKimiWireCli(executable);
  } catch (error) {
    yield {
      type: "error",
      content: error instanceof Error ? error.message : String(error),
    };
    yield { type: "done", sessionId: task.session_id };
    return;
  }
  const relay = await getLiteLLMRelay();
  const home = ensureKimiCodeTaskHome(task.id);
  const settlementFile = createKimiCodeSettlementPath(task.id);
  const env = buildKimiCodeEnv(
    task.id,
    selected,
    relay.baseUrl,
    relay.childApiKey,
    task.reasoning,
  );
  env.ORCH_KIMI_REAL_CLI = executable;
  env.ORCH_KIMI_SETTLEMENT_FILE = settlementFile;
  env.ORCH_KIMI_TASK_HOME = home;
  const suggested: string[] = [];
  const session = createSession({
    workDir: taskCwd(task, project),
    ...(task.session_id ? { sessionId: task.session_id } : {}),
    // The environment overlay selects the exact temporary model. Passing
    // `model` here would add `-m`, which has higher priority and would bypass
    // the isolated inline provider contract.
    thinking: task.reasoning !== "off",
    yoloMode: true,
    executable: launcherPath(),
    env,
    shareDir: home,
    skillsDir: path.join(home, "skills"),
    externalTools: kimiCodeOperatorTools(
      task,
      project,
      (title) => suggested.push(title),
    ),
    clientInfo: { name: "operator", version: "1" },
  });
  const live = { session, settlementFile };
  trackSession(task.id, live);
  let turn: ReturnType<Session["prompt"]> | null = null;
  let interruptPromise: Promise<void> | null = null;
  const requestInterrupt = (): Promise<void> => {
    interruptPromise ??= turn
      ? turn.interrupt().catch(() => undefined)
      : Promise.resolve();
    return interruptPromise;
  };
  const interrupt = () => {
    void requestInterrupt();
  };
  abortController?.signal.addEventListener("abort", interrupt, { once: true });
  const state = newKimiCodeState();
  let yieldedError = false;
  let processSettled = false;

  try {
    const guidance = buildWorkstreamRuntimeGuidance(
      getWorkstreamByTask(task.id)?.state === "active",
    );
    const prompt = task.session_id
      ? [guidance, userText].filter(Boolean).join("\n\n---\n\n")
      : [buildProjectContext(project, task), guidance, userText]
          .filter(Boolean)
          .join("\n\n---\n\n");
    turn = session.prompt(prompt);
    abortController?.signal.addEventListener("abort", interrupt, { once: true });
    yield { type: "session", sessionId: session.sessionId };
    yield { type: "model", model: selected.value };
    for await (const nativeEvent of turn) {
      if (abortController?.signal.aborted) continue;
      if (nativeEvent.type === "QuestionRequest") {
        const questionRequest = nativeEvent.payload as KimiQuestionRequest;
        const mapped = mapKimiCodeEvent(nativeEvent, state);
        const ask = mapped.find(
          (event): event is Extract<StreamEvent, { type: "ask" }> =>
            event.type === "ask",
        );
        if (!ask) {
          yieldedError = true;
          yield {
            type: "error",
            content: "Kimi Code emitted an invalid question request.",
          };
          continue;
        }
        const waiting = waitForAnswer(
          task.id,
          ask.id,
          ask.questions,
          abortController?.signal,
        );
        yield ask;
        try {
          const answers = await waiting;
          const response = Object.fromEntries(
            questionRequest.questions.map((question, index) => [
              question.question,
              (answers[index] ?? []).join(", "),
            ]),
          );
          await turn.respondQuestion(
            questionRequest.id,
            questionRequest.tool_call_id,
            response,
          );
          yield { type: "ask_answered", id: ask.id, answers };
        } catch {
          if (!abortController?.signal.aborted) {
            yieldedError = true;
            yield {
              type: "error",
              content: "Kimi Code question was dismissed before it could continue.",
            };
          }
        }
        continue;
      }
      if (nativeEvent.type === "ApprovalRequest") {
        try {
          await turn.approve(nativeEvent.payload.id, "approve_for_session");
        } catch (error) {
          yieldedError = true;
          yield {
            type: "error",
            content: `Kimi Code approval failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }
      for (const event of mapKimiCodeEvent(nativeEvent, state)) {
        if (event.type === "error") yieldedError = true;
        yield event;
      }
    }
    const result = await turn.result;
    if (
      result.status !== "finished"
      && !abortController?.signal.aborted
    ) {
      yieldedError = true;
      yield {
        type: "error",
        content: `Kimi Code ended with terminal status ${result.status}.`,
      };
    }
    if (state.calls.size > 0 && !abortController?.signal.aborted) {
      yieldedError = true;
      yield {
        type: "error",
        content: `Kimi Code ended with ${state.calls.size} unpaired tool call(s).`,
      };
    }
    if (state.malformedEvents.length > 0 && !yieldedError && !abortController?.signal.aborted) {
      yield {
        type: "error",
        content: `Kimi Code emitted malformed events: ${state.malformedEvents.join("; ")}`,
      };
    }
    if (state.latestTokenUsage && !yieldedError) {
      yield {
        type: "notice",
        content:
          "Kimi Code reported token usage, but trusted metered cost was not recorded in-stream; provider reconciliation is required.",
      };
    }
  } catch (error) {
    yieldedError = true;
    if (!abortController?.signal.aborted) {
      yield {
        type: "error",
        content: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    abortController?.signal.removeEventListener("abort", interrupt);
    if (abortController?.signal.aborted) {
      await requestInterrupt();
    }
    try {
      await closeAndVerify(live);
      processSettled = true;
    } catch (error) {
      yieldedError = true;
      yield {
        type: "error",
        content: error instanceof Error ? error.message : String(error),
      };
    }
    if (processSettled) {
      untrackSession(task.id, live);
    }
  }

  if (yieldedError || !processSettled) return;
  for (const title of suggested) yield { type: "suggested", title };
  appendOperatorSessionIndex(LITELLM_KIMI_CODE_HOME, {
    session_id: session.sessionId,
    task_id: task.id,
    project_id: project.id,
    task_title: task.title,
    project_path: project.repo_path,
    harness: "kimi-code",
    model: selected.value,
    updated_at: new Date().toISOString(),
  });
  yield { type: "done", sessionId: session.sessionId };
}

const managedLogin = (error: string | null): AgentLoginSession => ({
  status: error ? "error" : "success",
  url: null,
  email: null,
  plan: "LiteLLM",
  error,
  log: "",
});

export const kimiCodeDriver: AgentDriver = {
  id: "litellm-kimi-code",
  label: "Kimi Code",
  get capabilities() {
    return kimiCodeCapabilities();
  },
  runTurn,
  async authStatus() {
    const authenticated = kimiCodeCapabilities().models.length > 0;
    return {
      authenticated,
      method: authenticated ? "managed_endpoint" : null,
      email: null,
      plan: authenticated ? "LiteLLM" : null,
      error: authenticated ? null : "Refresh admitted models in Settings",
    };
  },
  async startLogin() {
    return managedLogin("Kimi Code uses Operator's managed LiteLLM catalog.");
  },
  getLogin() {
    return null;
  },
  async submitLoginCode() {
    return managedLogin("Kimi Code does not use an interactive login here.");
  },
  cancelLogin() {},
  async verify() {
    try {
      const snapshot = await refreshLiteLLMCatalog();
      const models = snapshot.models.filter((model) =>
        model.harnesses.includes("kimi-code"),
      );
      return {
        ok: models.length > 0,
        output: `${models.length} Kimi Code-admitted model(s)`,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
