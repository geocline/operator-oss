import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LITELLM_DSH_HOME } from "@/lib/config";
import { parseLiteLLMModelInfo, replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { dshDriver } from "@/lib/agents/dsh/driver";
import { getDriver, listDrivers } from "@/lib/agents/registry";
import { createProject, createTask, getTask, listMessages, updateProject, updateTask } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import type { Project, StreamEvent, Task, TaskStreamEvent } from "@/lib/types";

const FIXTURES = path.join(__dirname, "fixtures", "dsh");
const FAKE = path.join(FIXTURES, "fake-dsh.mjs");
const DRIVER_EVENTS = path.join(FIXTURES, "events-driver-success.jsonl");

const DEEPSEEK_MODEL = {
  model_name: "operator.deepseek-v4",
  model_info: {
    operator: {
      enabled: true,
      label: "DeepSeek V4",
      kind: "coding",
      admissions: [{
        harness: "dsh",
        status: "passed",
        harness_version: "dsh-test",
        test_revision: "fixture",
        tested_at: "2026-08-16T00:00:00.000Z",
        requested_alias: "operator.deepseek-v4",
        resolved_model: "deepseek-chat",
      }],
      description: "Approved DeepSeek alias",
      context_window: 1_000_000,
      sort_order: 5,
    },
  },
};

function dshCatalog() {
  replaceLiteLLMCatalog({
    ...parseLiteLLMModelInfo({ data: [DEEPSEEK_MODEL] }),
    refreshedAt: "2026-08-16T12:00:00.000Z",
    stale: false,
  });
}

async function collectTurn(task: Task, project: Project, text: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of dshDriver.runTurn(task, project, text)) out.push(ev);
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
  dshCatalog();
  chmodSync(FAKE, 0o755);
  process.env.DSH_CLI_PATH = FAKE;
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
  delete process.env.DSH_CLI_PATH;
  rmSync(LITELLM_DSH_HOME, { recursive: true, force: true });
});

describe("litellm-dsh driver identity", () => {
  it("has the exact id, label, and managed-endpoint capability surface", () => {
    expect(dshDriver.id).toBe("litellm-dsh");
    expect(dshDriver.label).toBe("DSH (DeepSeek)");
    const caps = dshDriver.capabilities;
    expect(caps.loginStyle).toBe("managed_endpoint");
    expect(caps.permissionModes.map((p) => p.value)).toEqual(["bypassPermissions"]);
    // No MCP-client plugin is compiled into the packaged runtime binary
    // (verified live), so dsh gets neither operator asks nor MCP tools.
    expect(caps.supportsAsks).toBe(false);
    expect(caps.supportsMcpTools).toBe(false);
    expect(caps.reportsCostUsd).toBe(false);
    expect(caps.costIsEstimated).toBe(false);
    expect(caps.models.map((m) => m.value)).toEqual(["operator.deepseek-v4"]);
  });

  it("is registered and never falls back to Claude for existing dsh tasks", () => {
    expect(listDrivers().map((d) => d.id)).toContain("litellm-dsh");
    expect(getDriver("litellm-dsh").id).toBe("litellm-dsh");
  });
});

describe("litellm-dsh turns", () => {
  it("fails actionably without spawning when the model is not in the dsh catalog", async () => {
    const project = createProject({ name: "DshNoModel" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.frontier" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    expect(events[0].type).toBe("error");
    const message = (events[0] as { content: string }).content;
    expect(message).toContain("operator.frontier");
    expect(message).toMatch(/gateway/i);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("fails actionably when the model is not a DeepSeek-family alias, even if admitted", async () => {
    replaceLiteLLMCatalog({
      ...parseLiteLLMModelInfo({
        data: [{
          model_name: "operator.mystery",
          model_info: {
            operator: {
              enabled: true,
              label: "Mystery",
              kind: "coding",
              admissions: [{
                harness: "dsh",
                status: "passed",
                harness_version: "dsh-test",
                test_revision: "fixture",
                tested_at: "2026-08-16T00:00:00.000Z",
                requested_alias: "operator.mystery",
                resolved_model: "not-deepseek",
              }],
              description: "",
              sort_order: 1,
            },
          },
        }],
      }),
      refreshedAt: "2026-08-16T12:00:00.000Z",
      stale: false,
    });
    const project = createProject({ name: "DshWrongFamily" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.mystery" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    expect(events[0].type).toBe("error");
    expect((events[0] as { content: string }).content).toMatch(/DeepSeek-family/i);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("fails actionably when the dsh binary is missing instead of falling back", async () => {
    process.env.DSH_CLI_PATH = "/nonexistent/dsh-jsonrpc-agent";
    const project = createProject({ name: "DshNoCli" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.deepseek-v4" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    expect(events[0].type).toBe("error");
    expect((events[0] as { content: string }).content).toMatch(/pip install deepseek-harness-sdk/i);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("fails actionably when DSH_CLI_PATH is unset", async () => {
    delete process.env.DSH_CLI_PATH;
    const project = createProject({ name: "DshUnsetCli" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.deepseek-v4" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    expect(events[0].type).toBe("error");
    expect((events[0] as { content: string }).content).toMatch(/pip install deepseek-harness-sdk/i);
  });

  it("runs a full turn through the real runner with the fake CLI", async () => {
    const argsFile = path.join(os.tmpdir(), `dsh-args-${process.pid}.json`);
    const envFile = path.join(os.tmpdir(), `dsh-env-${process.pid}.json`);
    restoreEnv = makeFixture({
      FAKE_DSH_EVENTS: DRIVER_EVENTS,
      FAKE_DSH_ARGS_FILE: argsFile,
      FAKE_DSH_ENV_FILE: envFile,
      OPENROUTER_API_KEY: "sk-or-secret-test",
    });

    const project = createProject({ name: "DshContract" });
    updateProject(project.id, { default_agent: "litellm-dsh" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    expect(task.agent).toBe("litellm-dsh");
    updateTask(task.id, { model: "operator.deepseek-v4" });

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
    expect(after).toMatchObject({ started: 1, running: 0, awaiting_input: 1 });
    expect(after.session_id).toBeTruthy();

    const msgs = listMessages(task.id);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Task complete.")).toBe(true);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["done", "turn_end"]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    // Token usage was tracked but never fabricated into a cost figure.
    expect(events.some((e) => e.type === "notice")).toBe(true);

    // Task-local state landed under this task's dsh home, per generation.
    expect(existsSync(path.join(LITELLM_DSH_HOME, task.id, "config", "cordis.yml"))).toBe(true);
    expect(existsSync(path.join(LITELLM_DSH_HOME, task.id, "sessions", String(after.generation)))).toBe(true);

    const index = readFileSync(path.join(LITELLM_DSH_HOME, "operator-session-index.jsonl"), "utf8");
    expect(JSON.parse(index.trim().split("\n").at(-1)!)).toMatchObject({
      task_id: task.id,
      harness: "dsh",
      model: "operator.deepseek-v4",
    });

    // Spawn contract: no args (the composition path travels via
    // DSH_CORDIS_CONFIG env, not argv).
    const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(argv).toEqual([]);

    // The child env carries the relay token as DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL
    // and tool context - never a real provider or gateway credential.
    const childEnv = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
    expect(childEnv.DEEPSEEK_API_KEY).toBe("operator-loopback-relay");
    expect(childEnv.DEEPSEEK_BASE_URL).toBeTruthy();
    expect(childEnv.DSH_CORDIS_CONFIG).toBe(path.join(LITELLM_DSH_HOME, task.id, "config", "cordis.yml"));
    expect(childEnv.ORCH_TASK_ID).toBe(task.id);
    expect(childEnv.ORCH_PROJECT_ID).toBe(project.id);
    for (const secret of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LITELLM_API_KEY"]) {
      expect(childEnv[secret]).toBeUndefined();
    }

    rmSync(argsFile, { force: true });
    rmSync(envFile, { force: true });
  });

  it("resumes an existing session id via the same dsh sessionId", async () => {
    restoreEnv = makeFixture({ FAKE_DSH_EVENTS: DRIVER_EVENTS });
    const project = createProject({ name: "DshResume" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.deepseek-v4", session_id: "prior-session-id" });
    const events = await collectTurn(getTask(task.id)!, project, "continue");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", sessionId: "prior-session-id" });
  });

  it("settles with an error and done when the binary dies after spending money", async () => {
    restoreEnv = makeFixture({ FAKE_DSH_EXIT_NONZERO: "1" });
    const project = createProject({ name: "DshPaidFail" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.deepseek-v4" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("surfaces the turn/end error reason (e.g. an auth failure) as an actionable error", async () => {
    restoreEnv = makeFixture({ FAKE_DSH_EVENTS: path.join(FIXTURES, "events-auth-error.jsonl") });
    const project = createProject({ name: "DshAuthError" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.deepseek-v4" });
    const events = await collectTurn(getTask(task.id)!, project, "go");
    const error = events.find((e) => e.type === "error");
    expect(error).toBeTruthy();
    expect((error as { content: string }).content).toMatch(/smoke test: no real key/);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("ends without an error event when aborted mid-turn", async () => {
    restoreEnv = makeFixture({ FAKE_DSH_EVENTS: path.join(FIXTURES, "events-abort.jsonl") });
    const project = createProject({ name: "DshAbort" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { model: "operator.deepseek-v4" });
    const abort = new AbortController();
    const events: StreamEvent[] = [];
    const gen = dshDriver.runTurn(getTask(task.id)!, project, "go", abort);
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === "tool" && !abort.signal.aborted) abort.abort();
    }
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });
});
