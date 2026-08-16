import { describe, expect, it } from "vitest";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  execFileSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { executeAdmission, type AdmissionTransport } from "@/lib/agents/admission-runner";
import { createLiteLLMRelay, type LiteLLMRelay } from "@/lib/agents/litellm/relay";
import {
  clearLiveAdmissionCandidateForTest,
  parseLiteLLMModelInfo,
  replaceLiteLLMCatalog,
  setLiveAdmissionCandidateForTest,
} from "@/lib/agents/litellm/catalog";
import { buildLiteLLMClaudeEnv } from "@/lib/agents/litellm-claude/driver";
import { buildKimiCodeEnv } from "@/lib/agents/kimi-code/policy";
import { readKimiCodeIsolationEvidence } from "@/lib/agents/kimi-code/session-paths";
import { liteLLMCapabilities } from "@/lib/agents/litellm/capabilities";
import { buildDshHarnessEnv } from "@/lib/agents/dsh/policy";
import { dshTaskPaths } from "@/lib/agents/dsh/session-paths";
import {
  createProject,
  createTask,
  getTask,
  updateTask,
} from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { ensureWorktree } from "@/lib/git";
import { abortTurn } from "@/lib/abort";
import { submitAnswer } from "@/lib/asks";
import { subscribe } from "@/lib/events";
import { makeRepo } from "./helpers";
import type { StreamEvent, TaskStreamEvent } from "@/lib/types";

const LIVE = process.env.MODEL_ADMISSION_LIVE === "1";
const REAL_GATEWAY = "http://127.0.0.1:4000/v1";
const liveDescribe = LIVE ? describe : describe.skip;
type LiveHarness = "claude" | "kimi-code" | "dsh";

const LIVE_HARNESSES: Record<LiveHarness, {
  driver: "litellm-claude" | "litellm-kimi-code" | "litellm-dsh";
  reasoning: "think" | "think_hard";
}> = {
  claude: { driver: "litellm-claude", reasoning: "think" },
  "kimi-code": { driver: "litellm-kimi-code", reasoning: "think_hard" },
  dsh: { driver: "litellm-dsh", reasoning: "think" },
};

type Candidate = {
  alias: string;
  expectedResolvedModel: string;
  artifactSlug: string;
};

const CANDIDATES: Record<string, Candidate> = {
  "operator.kimi-k3": {
    alias: "operator.kimi-k3",
    expectedResolvedModel: "moonshotai/kimi-k3-20260715",
    artifactSlug: "kimi-k3",
  },
  "operator.deepseek-v4-pro": {
    alias: "operator.deepseek-v4-pro",
    expectedResolvedModel: "deepseek/deepseek-v4-pro-20260423",
    artifactSlug: "deepseek-v4-pro",
  },
};

function privateEnv(): Record<string, string> {
  const text = readFileSync(
    path.join(process.env.HOME!, ".litellm", ".env"),
    "utf8",
  );
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^"|"$/g, "");
  }
  return env;
}

function selectedHarness(): LiveHarness {
  const value = process.env.MODEL_ADMISSION_HARNESS || "claude";
  if (value !== "claude" && value !== "kimi-code" && value !== "dsh") {
    throw new Error("MODEL_ADMISSION_HARNESS must be claude, kimi-code, or dsh");
  }
  return value;
}

/**
 * The dsh runtime binary has no --version flag (it prints its config usage
 * line for any argv), so its version is read from the pip dist-info that
 * ships alongside it: DSH_CLI_PATH lives at
 * <venv>/.../site-packages/deepseek_harness_runtime/runtime/<binary>, and the
 * same site-packages dir carries deepseek_harness_sdk-<version>.dist-info.
 */
function dshVersion(cliPath: string): string {
  const sitePackages = path.dirname(path.dirname(path.dirname(cliPath)));
  const distInfo = readdirSync(sitePackages).find((name) =>
    /^deepseek_harness_sdk-.+\.dist-info$/.test(name),
  );
  if (!distInfo) {
    throw new Error(`No deepseek_harness_sdk dist-info next to DSH_CLI_PATH (${sitePackages})`);
  }
  return `deepseek-harness-sdk ${distInfo.replace(/^deepseek_harness_sdk-/, "").replace(/\.dist-info$/, "")}`;
}

function harnessVersion(harness: LiveHarness): string {
  if (harness === "dsh") {
    const cli = process.env.DSH_CLI_PATH;
    if (!cli) throw new Error("DSH_CLI_PATH must be set for a dsh live admission");
    return dshVersion(cli);
  }
  const executable = harness === "claude"
    ? process.env.CLAUDE_CLI_PATH || path.join(process.env.HOME!, ".local", "bin", "claude")
    : process.env.KIMI_CODE_CLI_PATH || path.join(process.cwd(), "node_modules", ".bin", "kimi");
  return execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
}

function testRevision(): string {
  const head = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const hash = createHash("sha256");
  for (const file of [
    "lib/agents/admission.ts",
    "lib/agents/admission-runner.ts",
    "lib/agents/litellm/relay.ts",
    "lib/agents/kimi-code/driver.ts",
    "lib/agents/kimi-code/events.ts",
    "lib/agents/kimi-code/cli-contract.ts",
    "lib/agents/kimi-code/policy.ts",
    "lib/agents/kimi-code/session-paths.ts",
    "scripts/kimi-code-launcher.mjs",
    "lib/agents/dsh/driver.ts",
    "lib/agents/dsh/events.ts",
    "lib/agents/dsh/policy.ts",
    "lib/agents/dsh/rpc.ts",
    "lib/agents/dsh/session-paths.ts",
    "package.json",
    "package-lock.json",
    "tests/kimiCodeCliContract.test.ts",
    "tests/kimiCodeLauncher.test.ts",
    "tests/modelAdmission.live.test.ts",
  ]) {
    hash.update(readFileSync(path.join(process.cwd(), file)));
  }
  return `${head}+wave0.${hash.digest("hex").slice(0, 12)}`;
}

function streamEvent(event: TaskStreamEvent): StreamEvent | null {
  if (
    event.type === "user"
    || event.type === "queued"
    || event.type === "dequeued"
    || event.type === "snapshot"
    || event.type === "turn_end"
    || event.type === "agent_auth"
  ) {
    return null;
  }
  return event;
}

function collectTurn(
  taskId: string,
  onEvent?: (event: StreamEvent) => void,
): { events: StreamEvent[]; done: Promise<void> } {
  const events: StreamEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((doneResolve) => {
    resolve = doneResolve;
  });
  const unsubscribe = subscribe(taskId, (raw) => {
    if (raw.type === "turn_end") {
      unsubscribe();
      resolve();
      return;
    }
    const event = streamEvent(raw);
    if (!event) return;
    events.push(event);
    onEvent?.(event);
    if (event.type === "ask") {
      const answers = event.questions.map(() => ["Continue"]);
      queueMicrotask(() => {
        submitAnswer(taskId, event.id, answers);
      });
    }
  });
  return { events, done };
}

async function gatewayModelInfo(
  gatewayKey: string,
): Promise<Record<string, unknown>> {
  const response = await fetch("http://127.0.0.1:4000/model/info", {
    headers: { Authorization: `Bearer ${gatewayKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`LiteLLM model-info preflight failed with HTTP ${response.status}`);
  }
  return await response.json() as Record<string, unknown>;
}

function admitCandidateInMemory(
  raw: Record<string, unknown>,
  alias: string,
): void {
  const data = Array.isArray(raw.data)
    ? structuredClone(raw.data) as Array<Record<string, unknown>>
    : [];
  let found = false;
  for (const entry of data) {
    if (entry.model_name !== alias) continue;
    found = true;
    const modelInfo = entry.model_info as Record<string, unknown>;
    const operator = modelInfo.operator as Record<string, unknown>;
  }
  if (!found) throw new Error(`Gateway did not expose candidate ${alias}`);
  const parsed = parseLiteLLMModelInfo({ data });
  if (parsed.errors.length) {
    throw new Error(`Candidate catalog parse failed: ${parsed.errors[0].error}`);
  }
  replaceLiteLLMCatalog({
    ...parsed,
    refreshedAt: new Date().toISOString(),
    stale: false,
    error: null,
  });
}

async function openRouterUsage(apiKey: string): Promise<number> {
  const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter key-usage check failed with HTTP ${response.status}`);
  }
  const body = await response.json() as { data?: { usage?: number } };
  if (typeof body.data?.usage !== "number") {
    throw new Error("OpenRouter key-usage response omitted usage");
  }
  return body.data.usage;
}

async function settledOpenRouterUsage(
  apiKey: string,
  baseline: number,
  expectedDelta: number,
): Promise<number> {
  let latest = await openRouterUsage(apiKey);
  let stableSamples = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const next = await openRouterUsage(apiKey);
    stableSamples = Math.abs(next - latest) < 1e-9
      ? stableSamples + 1
      : 0;
    latest = next;
    const delta = Math.max(0, latest - baseline);
    const reconciled =
      Math.abs(delta - expectedDelta) <= Math.max(0.001, expectedDelta * 0.05);
    if (stableSamples >= 2 && reconciled) return latest;
  }
  return latest;
}

type Generation = {
  id: string;
  model: string;
  provider: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
};

async function openRouterGeneration(
  apiKey: string,
  id: string,
): Promise<Generation> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const url = new URL("https://openrouter.ai/api/v1/generation");
    url.searchParams.set("id", id);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    lastStatus = response.status;
    if (response.ok) {
      const body = await response.json() as {
        data?: Record<string, unknown>;
      };
      const data = body.data ?? {};
      if (
        typeof data.model === "string"
        && typeof data.total_cost === "number"
      ) {
        return {
          id,
          model: data.model,
          provider:
            typeof data.provider_name === "string"
              ? data.provider_name
              : "(unknown)",
          cost: data.total_cost,
          inputTokens:
            typeof data.native_tokens_prompt === "number"
              ? data.native_tokens_prompt
              : Number(data.tokens_prompt ?? 0),
          outputTokens:
            typeof data.native_tokens_completion === "number"
              ? data.native_tokens_completion
              : Number(data.tokens_completion ?? 0),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(
    `OpenRouter generation ${id} was not reconcilable (last HTTP ${lastStatus})`,
  );
}

function candidateBinding(
  raw: Record<string, unknown>,
  alias: string,
): string | null {
  const data = Array.isArray(raw.data)
    ? raw.data as Array<Record<string, unknown>>
    : [];
  const entry = data.find((candidate) => candidate.model_name === alias);
  const params = entry?.litellm_params as Record<string, unknown> | undefined;
  return typeof params?.model === "string" ? params.model : null;
}

function harnessProcessPids(
  harness: LiveHarness,
  alias: string,
): string[] {
  const rows = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  return rows
    .split("\n")
    .filter(
      (line) => harness === "claude"
        ? line.includes(alias)
          && /(?:^|\s)(?:claude|.*\/claude)(?:\s|$)/.test(line)
        : harness === "dsh"
        ? /dsh-jsonrpc-agent|\bsleep 300\b/.test(line)
        : /@moonshot-ai\/kimi-code|\/kimi-code\/dist\/main\.mjs|node_modules\/\.bin\/kimi|(?:^|\s)\S*\/kimi(?:\s|$).*(?:--wire|--work-dir)|\bsleep 300\b/.test(line),
    )
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter(Boolean);
}

liveDescribe("live harness-model admission", () => {
  it(
    "runs one explicit harness/LiteLLM candidate and writes sanitized evidence",
    { timeout: 900_000 },
    async () => {
      const alias = process.env.MODEL_ADMISSION_ALIAS ?? "";
      const candidate = CANDIDATES[alias];
      if (!candidate) {
        throw new Error(
          `MODEL_ADMISSION_ALIAS must be one of: ${Object.keys(CANDIDATES).join(", ")}`,
        );
      }
      const harness = selectedHarness();
      const harnessConfig = LIVE_HARNESSES[harness];
      const secrets = privateEnv();
      const gatewayKey = secrets.LITELLM_MASTER_KEY;
      const providerKey = secrets.OPENROUTER_OPERATOR_API_KEY;
      if (!gatewayKey || !providerKey) {
        throw new Error("Live admission credentials are unavailable");
      }

      const gatewayInfo = await gatewayModelInfo(gatewayKey);
      const binding = candidateBinding(gatewayInfo, candidate.alias);
      if (
        !binding
        || !binding.startsWith("openrouter/")
        || /fallback/i.test(binding)
      ) {
        throw new Error("Candidate alias is not bound to one fallback-free OpenRouter route");
      }
      admitCandidateInMemory(gatewayInfo, candidate.alias);
      setLiveAdmissionCandidateForTest(candidate.alias, harness);
      const processBaseline = new Set(harnessProcessPids(harness, candidate.alias));

      const relayGlobal = globalThis as typeof globalThis & {
        __operatorLiteLLMRelay?: Promise<LiteLLMRelay>;
      };
      let relay: LiteLLMRelay | null = null;
      let artifact;
      try {
        const providerUsageBefore = await openRouterUsage(providerKey);
        relay = await createLiteLLMRelay({
          upstreamBaseUrl: REAL_GATEWAY,
          gatewayToken: gatewayKey,
        });
        const activeRelay = relay;
        relayGlobal.__operatorLiteLLMRelay = Promise.resolve(activeRelay);

        const repo = await makeRepo();
        writeFileSync(path.join(repo, "fixture.txt"), "ADMISSION-FIXTURE-SEED\n");
        writeFileSync(path.join(repo, "result.txt"), "PENDING\n");
        writeFileSync(
          path.join(repo, "package.json"),
          `${JSON.stringify({
            private: true,
            scripts: { test: "node test.mjs" },
          }, null, 2)}\n`,
        );
        writeFileSync(
          path.join(repo, "test.mjs"),
          [
            'import { readFileSync } from "node:fs";',
            'const actual = readFileSync(new URL("./result.txt", import.meta.url), "utf8");',
            'if (actual !== "PLANTED_FACT_7391\\n") {',
            '  throw new Error(`unexpected result: ${JSON.stringify(actual)}`);',
            "}",
            "",
          ].join("\n"),
        );
        execFileSync(
          "git",
          ["add", "fixture.txt", "result.txt", "package.json", "test.mjs"],
          { cwd: repo },
        );
        execFileSync("git", ["commit", "-m", "add admission fixture", "--no-verify"], {
          cwd: repo,
          stdio: "ignore",
        });

        const project = createProject({
          name: "ModelAdmission",
          repo_path: repo,
        });
        const task = createTask({
          project_id: project.id,
          title: "Harness admission",
          description: "Disposable live compatibility fixture.",
        });
        const worktree = await ensureWorktree(repo, task.id);
        if (!worktree) throw new Error("Admission fixture worktree was not created");
        updateTask(task.id, {
          agent: harnessConfig.driver,
          model: candidate.alias,
          reasoning: harnessConfig.reasoning,
          permission_mode: harness === "claude" ? null : "bypassPermissions",
          worktree_path: worktree.path,
          work_branch: worktree.branch,
        });

        // dsh has no Operator tool bridge or interactive-ask surface
        // (AgentCapabilities.supportsMcpTools/supportsAsks are false), so its
        // fixture prompt omits the bridge/ask steps and the pairing waives
        // those gates by declared capability instead of failing them.
        const capabilities = liteLLMCapabilities(harness);
        const bridgeSteps = capabilities.supportsMcpTools
          ? [
              '4. Call the orchestrator suggest_task tool once with title "Admission bridge proof", a short description, and low priority.',
              // AskUserQuestion schemas (Claude Code and Kimi Code alike)
              // require 2-4 options; a one-option ask fails tool validation
              // before any QuestionRequest reaches the wire, which is exactly
              // how the Aug 13 interactive-ask gates failed on every harness.
              '5. Call AskUserQuestion with one single-select question, header "Continue", and exactly two options labeled "Continue" and "Stop". Wait for the answer.',
              "6. After the answer, reply with the exact token ADMISSION_OK.",
            ]
          : ["4. Reply with the exact token ADMISSION_OK."];
        const transport: AdmissionTransport = {
        async runFresh() {
          const turn = collectTurn(task.id);
          await startResumeTurn(
            getTask(task.id)!,
            project,
            [
              "Complete this admission fixture exactly in order.",
              "1. Use the Read tool to read fixture.txt.",
              "2. Use the Edit tool (not Write) to replace the full contents of result.txt from PENDING to PLANTED_FACT_7391, preserving one trailing newline.",
              "3. Use Bash to run npm test.",
              ...bridgeSteps,
              "Do not skip, reorder, or substitute any step.",
            ].join("\n"),
          );
          await turn.done;
          return turn.events;
        },
        async runResume() {
          const turn = collectTurn(task.id);
          await startResumeTurn(
            getTask(task.id)!,
            project,
            "Without reading any file, reply with the exact planted fact from the prior turn and nothing else.",
          );
          await turn.done;
          return turn.events;
        },
        async runStop(onEvent) {
          let interruptRequested = false;
          const fireAbort = () => {
            if (interruptRequested) return;
            interruptRequested = abortTurn(task.id);
          };
          const turn = collectTurn(task.id, (event) => {
            onEvent(event);
            if (event.type === "tool") fireAbort();
          });
          await startResumeTurn(
            getTask(task.id)!,
            project,
            'Use Bash to run exactly: sleep 300. After it finishes, reply with "SLEEP_FINISHED".',
          );
          const fallback = setTimeout(fireAbort, 20_000);
          await turn.done;
          clearTimeout(fallback);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const after = getTask(task.id);
          return {
            events: turn.events,
            interruptRequested,
            settled: after?.running === 0,
            taskBusy: after?.running === 1,
            survivingProcesses: harnessProcessPids(harness, candidate.alias)
              .filter((pid) => !processBaseline.has(pid)),
          };
        },
        async verifyRepository() {
          const expectedEditPresent =
            readFileSync(path.join(worktree.path, "result.txt"), "utf8")
            === "PLANTED_FACT_7391\n";
          let testsPassed = false;
          try {
            execFileSync("npm", ["test"], {
              cwd: worktree.path,
              stdio: "ignore",
              timeout: 30_000,
            });
            testsPassed = true;
          } catch {
            testsPassed = false;
          }
          return {
            expectedEditPresent,
            testsPassed,
            disposable: worktree.path.startsWith(process.env.ORCH_TEST_TMP!),
          };
        },
        async reconcileIdentityAndCost() {
          const generationIds = activeRelay.generationIds();
          const records = await Promise.all(
            generationIds.map((id) => openRouterGeneration(providerKey, id)),
          );
          const physicalModels = [...new Set(records.map((record) => record.model))];
          const providers = [...new Set(records.map((record) => record.provider))];
          const providerCostUsd = records.reduce(
            (sum, record) => sum + record.cost,
            0,
          );
          const providerUsageAfter = await settledOpenRouterUsage(
            providerKey,
            providerUsageBefore,
            providerCostUsd,
          );
          const inputTokens = records.reduce(
            (sum, record) => sum + record.inputTokens,
            0,
          );
          const outputTokens = records.reduce(
            (sum, record) => sum + record.outputTokens,
            0,
          );
          return {
            identity: {
              requestedAlias: candidate.alias,
              resolvedModel:
                physicalModels.length === 1 ? physicalModels[0] : null,
              fallbackFree:
                !!binding
                && !/fallback/i.test(binding)
                && generationIds.length > 0,
              trustedSource: records.length ? "provider" : "incomplete",
            },
            usage: {
              inputTokens,
              outputTokens,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: records.length ? providerCostUsd : null,
              costStatus: records.length ? "trusted" : "missing",
            },
            providerReconciliation: {
              generationIds,
              physicalModels,
              providers,
              providerCostUsd: records.length ? providerCostUsd : null,
              keyUsageDeltaUsd: Math.max(
                0,
                providerUsageAfter - providerUsageBefore,
              ),
              complete:
                generationIds.length > 0
                && records.length === generationIds.length,
            },
            diagnostics: [
              `${records.length} provider generation(s) reconciled`,
              "gateway alias binding was fallback-free",
            ],
          };
        },
        async verifyIsolation() {
          if (harness === "kimi-code") {
            return readKimiCodeIsolationEvidence(task.id);
          }
          if (harness === "dsh") {
            // Reproduce the driver's exact child-env assembly: lib/agents/dsh/
            // driver.ts injects these after buildDshHarnessEnv's scrub, and
            // lib/agents/dsh/rpc.ts spawns with that env verbatim (no
            // process.env re-merge, unlike the Kimi SDK). Seed the base env
            // with canary ambient credentials to prove the scrub strips
            // credential-shaped names, not just known provider keys.
            const current = getTask(task.id)!;
            const paths = dshTaskPaths(task.id, current.generation);
            const env = buildDshHarnessEnv(task.id, {
              ...process.env,
              GITHUB_TOKEN: "canary-ambient-credential",
              NPM_TOKEN: "canary-ambient-credential",
              AWS_SECRET_ACCESS_KEY: "canary-ambient-credential",
            });
            env.DEEPSEEK_API_KEY = activeRelay.childApiKey;
            env.DEEPSEEK_BASE_URL = activeRelay.baseUrl;
            env.DSH_CWD = worktree.path;
            env.DSH_SESSION_ROOT = paths.sessionDir;
            env.DSH_CORDIS_CONFIG = paths.configFile;
            env.DO_NOT_TRACK = "1";
            env.ORCH_TASK_ID = task.id;
            env.ORCH_PROJECT_ID = project.id;
            env.SERVICE_TOKEN = process.env.SERVICE_TOKEN || "";
            const credentialShaped =
              /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION)/i;
            // The only credential-shaped names the driver deliberately
            // re-injects: the relay key, the local service token, and the
            // session-persistence path (a directory, matched by "SESSION").
            const allowed = new Set([
              "DEEPSEEK_API_KEY",
              "SERVICE_TOKEN",
              "DSH_SESSION_ROOT",
            ]);
            const unexpected = Object.keys(env).filter(
              (key) => credentialShaped.test(key) && !allowed.has(key),
            );
            return {
              taskStateIsolated:
                paths.taskHome.startsWith(process.env.ORCH_TEST_TMP!)
                && paths.sessionDir.startsWith(paths.taskHome),
              relayCredentialOnly:
                env.DEEPSEEK_API_KEY === activeRelay.childApiKey
                && env.SERVICE_TOKEN === (process.env.SERVICE_TOKEN || "")
                && unexpected.length === 0,
              ambientCredentialLeak: unexpected.length > 0,
            };
          }
          const env = harness === "claude"
            ? buildLiteLLMClaudeEnv(
                task.id,
                candidate.alias,
                activeRelay.baseUrl,
                activeRelay.childApiKey,
              )
            : buildKimiCodeEnv(
                task.id,
                {
                  value: candidate.alias,
                  label: candidate.alias,
                  contextWindow: 1_048_576,
                  reasoningOptions: ["high"],
                },
                activeRelay.baseUrl,
                activeRelay.childApiKey,
                task.reasoning,
              );
          const credentialKeys = Object.keys(env).filter((key) =>
            /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION)/i.test(key),
          );
          const expectedCredential = harness === "claude"
            ? "ANTHROPIC_AUTH_TOKEN"
            : "KIMI_API_KEY";
          const stateHome = harness === "claude"
            ? env.CLAUDE_CONFIG_DIR
            : env.KIMI_CODE_HOME;
          return {
            taskStateIsolated:
              stateHome.startsWith(process.env.ORCH_TEST_TMP!),
            relayCredentialOnly:
              credentialKeys.length === 1
              && credentialKeys[0] === expectedCredential
              && env[expectedCredential] === activeRelay.childApiKey,
            ambientCredentialLeak: credentialKeys.some(
              (key) => key !== expectedCredential,
            ),
          };
        },
        };
        artifact = await executeAdmission({
          pairing: {
            alias: candidate.alias,
            expectedResolvedModel: candidate.expectedResolvedModel,
            harness,
            harnessVersion: harnessVersion(harness),
            testRevision: testRevision(),
            requiresOperatorBridge: capabilities.supportsMcpTools,
            requiresInteractiveAsk: capabilities.supportsAsks,
          },
          transport,
          optIn: true,
        });
      } finally {
        if (relay) await relay.close();
        delete relayGlobal.__operatorLiteLLMRelay;
        clearLiveAdmissionCandidateForTest();
      }
      const artifactPath = path.join(
        process.cwd(),
        "docs",
        "evaluations",
        `${artifact.tested_at.slice(0, 10)}-${harness}-${candidate.artifactSlug}-admission.json`,
      );
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
        mode: 0o600,
      });

      expect(artifact.status).toBe("passed");
    },
  );
});
