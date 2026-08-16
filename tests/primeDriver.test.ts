import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LITELLM_PRIME_HOME, PRIME_OPERATOR_EXTENSION_PATH } from "@/lib/config";
import { parseLiteLLMModelInfo, replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { primeAgentDriver } from "@/lib/agents/prime/driver";
import { primeCapabilities } from "@/lib/agents/prime/capabilities";
import { getDriver, listDrivers } from "@/lib/agents/registry";
import { createProject, createTask, getTask, getTaskUsage, listMessages, updateProject, updateTask } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import type { Project, StreamEvent, Task, TaskStreamEvent } from "@/lib/types";

const FIXTURES = path.join(__dirname, "fixtures", "prime");
const FAKE = path.join(FIXTURES, "fake-prime-agent.mjs");
const DRIVER_EVENTS = path.join(FIXTURES, "events-driver-success.jsonl");

const KIMI = {
  model_name: "operator.kimi-k3",
  model_info: {
    operator: {
      enabled: true,
      label: "Kimi K3",
      kind: "coding",
      admissions: [{
        harness: "prime",
        status: "passed",
        harness_version: "prime-agent-test",
        test_revision: "fixture",
        tested_at: "2026-08-10T00:00:00.000Z",
        requested_alias: "operator.kimi-k3",
        resolved_model: "moonshotai/kimi-k3",
      }],
      description: "Approved Kimi alias",
      context_window: 1_048_576,
      sort_order: 5,
    },
  },
};

function primeCatalog() {
  replaceLiteLLMCatalog({
    ...parseLiteLLMModelInfo({ data: [KIMI] }),
    refreshedAt: "2026-08-10T12:00:00.000Z",
    stale: false,
  });
}

async function collectTurn(task: Task, project: Project, text: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of primeAgentDriver.runTurn(task, project, text)) out.push(ev);
  return out;
}

function makeFixture(agentEnv: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(agentEnv)) process.env[key] = value;
  return () => {
    for (const key of Object.keys(agentEnv)) delete process.env[key];
  };
}

let restoreEnv: (() => void) | null = null;

beforeEach(() => {
  primeCatalog();
  // The driver execs the CLI path directly (shebang), like the real binary.
  chmodSync(FAKE, 0o755);
  process.env.PRIME_CLI_PATH = FAKE;
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
  delete process.env.PRIME_CLI_PATH;
  rmSync(LITELLM_PRIME_HOME, { recursive: true, force: true });
});

describe("litellm-prime driver identity", () => {
  it("has the exact id, label, and managed-endpoint capability surface", () => {
    expect(primeAgentDriver.id).toBe("litellm-prime");
    expect(primeAgentDriver.label).toBe("Prime Agent");
    const caps = primeCapabilities();
    expect(caps.loginStyle).toBe("managed_endpoint");
    expect(caps.permissionModes.map((p) => p.value)).toEqual(["bypassPermissions"]);
    expect(caps.supportsAsks).toBe(true);
    expect(caps.supportsMcpTools).toBe(true);
    expect(caps.reportsCostUsd).toBe(true);
    expect(caps.costIsEstimated).toBe(false);
    expect(caps.models.map((m) => m.value)).toEqual(["operator.kimi-k3"]);
  });

  it("is registered and never falls back to Claude for existing Prime tasks", () => {
    expect(listDrivers().map((d) => d.id)).toContain("litellm-prime");
    expect(getDriver("litellm-prime").id).toBe("litellm-prime");
  });
});

describe("litellm-prime turns", () => {
  it("fails actionably without spawning when the model is not in the Prime catalog", async () => {
    const project = createProject({ name: "PrimeNoModel" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.frontier" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    expect(events[0].type).toBe("error");
    // Actionable means naming the model and where to look, not telling the user
    // to refresh a catalog that would come back identical.
    const message = (events[0] as { content: string }).content;
    expect(message).toContain("operator.frontier");
    expect(message).toMatch(/gateway/i);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("fails actionably when the Prime CLI is missing instead of falling back", async () => {
    process.env.PRIME_CLI_PATH = "/nonexistent/prime-agent";
    const project = createProject({ name: "PrimeNoCli" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.kimi-k3" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    expect(events[0].type).toBe("error");
    expect((events[0] as { content: string }).content).toMatch(/prime/i);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("runs a full turn through the real runner with the fake CLI", async () => {
    const argsFile = path.join(os.tmpdir(), `prime-args-${process.pid}.json`);
    const envFile = path.join(os.tmpdir(), `prime-env-${process.pid}.json`);
    restoreEnv = makeFixture({
      FAKE_PRIME_EVENTS: DRIVER_EVENTS,
      FAKE_PRIME_ARGS_FILE: argsFile,
      FAKE_PRIME_ENV_FILE: envFile,
      OPENROUTER_API_KEY: "sk-or-secret-test",
    });

    const project = createProject({ name: "PrimeContract" });
    updateProject(project.id, { default_agent: "litellm-prime" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    expect(task.agent).toBe("litellm-prime");
    updateTask(task.id, { model: "operator.kimi-k3" });

    const events: TaskStreamEvent[] = [];
    let resolve!: () => void;
    const finished = new Promise<void>((r) => (resolve = r));
    const unsub = subscribe(task.id, (ev) => {
      events.push(ev);
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
    await startResumeTurn(getTask(task.id)!, project, "go");
    await finished;

    const after = getTask(task.id)!;
    expect(after).toMatchObject({
      started: 1,
      running: 0,
      awaiting_input: 1,
      resolved_model: "moonshotai/kimi-k3",
    });
    expect(after.session_id).toBe("/tmp/fake-prime/session.jsonl");

    // Trusted metered usage, never a Codex estimate.
    expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: 0.0091, turns: 1 });

    const msgs = listMessages(task.id);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Task complete.")).toBe(true);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["done", "turn_end"]);
    expect(events.some((e) => e.type === "error")).toBe(false);

    // Task-local state landed under this task's Prime home, per generation.
    expect(existsSync(path.join(LITELLM_PRIME_HOME, task.id, "config", "models.json"))).toBe(true);
    expect(existsSync(path.join(LITELLM_PRIME_HOME, task.id, "sessions", String(after.generation)))).toBe(true);

    // Session index appended with the prime harness tag.
    const index = readFileSync(path.join(LITELLM_PRIME_HOME, "operator-session-index.jsonl"), "utf8");
    expect(JSON.parse(index.trim().split("\n").at(-1)!)).toMatchObject({
      task_id: task.id,
      harness: "prime",
      model: "operator.kimi-k3",
    });

    // Spawn contract: RPC mode, pinned provider/model, task-local session dir,
    // the Operator extension, no user skills/prompt templates, context files on.
    const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(argv).toContain("rpc");
    expect(argv[argv.indexOf("--model") + 1]).toBe("operator.kimi-k3");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("operator-litellm");
    expect(argv[argv.indexOf("--extension") + 1]).toBe(PRIME_OPERATOR_EXTENSION_PATH);
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--no-prompt-templates");
    expect(argv).not.toContain("--no-context-files");

    // The child env carries only the relay token and tool context — never
    // provider or gateway credentials.
    const childEnv = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
    expect(childEnv.PRIME_RELAY_API_KEY).toBe("operator-loopback-relay");
    expect(childEnv.ORCH_TASK_ID).toBe(task.id);
    expect(childEnv.ORCH_PROJECT_ID).toBe(project.id);
    for (const secret of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LITELLM_API_KEY"]) {
      expect(childEnv[secret]).toBeUndefined();
    }
    expect(childEnv.PRIME_AGENT_TELEMETRY).toBe("0");

    rmSync(argsFile, { force: true });
    rmSync(envFile, { force: true });
  });

  it("resumes an existing session id via --resume", async () => {
    const argsFile = path.join(os.tmpdir(), `prime-resume-args-${process.pid}.json`);
    restoreEnv = makeFixture({
      FAKE_PRIME_EVENTS: DRIVER_EVENTS,
      FAKE_PRIME_ARGS_FILE: argsFile,
    });
    const project = createProject({ name: "PrimeResume" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.kimi-k3", session_id: "/tmp/prior.jsonl" });
    const events = await collectTurn(getTask(task.id)!, project, "continue");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(argv[argv.indexOf("--resume") + 1]).toBe("/tmp/prior.jsonl");
    rmSync(argsFile, { force: true });
  });

  it("settles with an error and done when the CLI dies after spending money", async () => {
    restoreEnv = makeFixture({ FAKE_PRIME_EXIT_NONZERO: "1" });
    const project = createProject({ name: "PrimePaidFail" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.kimi-k3" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("ends without an error event when aborted mid-turn", async () => {
    restoreEnv = makeFixture({ FAKE_PRIME_EVENTS: path.join(FIXTURES, "events-abort.jsonl") });
    const project = createProject({ name: "PrimeAbort" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.kimi-k3" });
    const abort = new AbortController();
    const events: StreamEvent[] = [];
    const gen = primeAgentDriver.runTurn(getTask(task.id)!, project, "go", abort);
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === "tool" && !abort.signal.aborted) abort.abort();
    }
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });
});
