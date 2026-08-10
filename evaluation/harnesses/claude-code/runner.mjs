import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  attributionFromGenerations,
  openRouterGeneration,
  redactSecrets,
  snapshotOpenRouterKey,
  writeJson,
} from "../prime-agent/compatibility-runner.mjs";

export const APPROVED_MODEL = "moonshotai/kimi-k3";

const DATED_APPROVED_MODEL = /^moonshotai\/kimi-k3(?:-\d{8})?$/;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(SCRIPT_DIR, "runs");
const KEYCHAIN_ACCOUNT = "geo";
const KEYCHAIN_SERVICE = "operator-harness-eval-openrouter-claude";

export function buildClaudeEnv({ baseEnv = process.env, secret, configDir }) {
  const env = { ...baseEnv };
  for (const name of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
  ]) {
    delete env[name];
  }
  return Object.assign(env, {
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: APPROVED_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: APPROVED_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: APPROVED_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: APPROVED_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: APPROVED_MODEL,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: "1",
  });
}

export function buildClaudeArgs(prompt, { maxBudgetUsd } = {}) {
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--safe-mode",
    "--no-chrome",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--dangerously-skip-permissions",
    "--model",
    APPROVED_MODEL,
  ];
  if (maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }
  args.push(prompt);
  return args;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function contentBlocks(event) {
  return Array.isArray(event?.message?.content) ? event.message.content : [];
}

export function parseClaudeEvents(input) {
  const events =
    typeof input === "string"
      ? input
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              throw new Error(`malformed Claude JSONL: ${line.slice(0, 120)}`);
            }
          })
      : input;
  if (!Array.isArray(events)) throw new Error("Claude events must be an array or JSONL string");

  const models = [];
  const generationIds = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let sessionId = null;
  let finalResponse = "";
  let reportedCost = null;
  const modelCallIds = new Set();
  const toolCallIds = new Set();
  const toolNames = [];
  const toolErrorIds = new Set();
  let resultUsage = null;

  for (const event of events) {
    if (event.session_id) sessionId = event.session_id;
    if (event.model) models.push(event.model);
    if (typeof event.request_id === "string" && event.request_id.startsWith("gen-")) {
      generationIds.push(event.request_id);
    }
    if (typeof event?.message?.id === "string" && event.message.id.startsWith("gen-")) {
      generationIds.push(event.message.id);
    }

    if (event.type === "assistant" && event.message) {
      if (typeof event.message.id === "string") modelCallIds.add(event.message.id);
      if (event.message.model) models.push(event.message.model);
      const eventUsage = event.message.usage ?? {};
      usage.input += Number(eventUsage.input_tokens ?? 0);
      usage.output += Number(eventUsage.output_tokens ?? 0);
      usage.cacheRead += Number(eventUsage.cache_read_input_tokens ?? 0);
      usage.cacheWrite += Number(eventUsage.cache_creation_input_tokens ?? 0);
      for (const block of contentBlocks(event)) {
        if (block.type === "tool_use") {
          toolCallIds.add(block.id ?? JSON.stringify(block));
          if (block.name && !toolNames.includes(block.name)) toolNames.push(block.name);
        }
      }
    }

    if (event.type === "user") {
      for (const block of contentBlocks(event)) {
        if (block.type === "tool_result" && block.is_error === true) {
          toolErrorIds.add(block.tool_use_id ?? JSON.stringify(block));
        }
      }
    }

    if (event.type === "result") {
      if (typeof event.result === "string") finalResponse = event.result;
      if (Number.isFinite(Number(event.total_cost_usd))) {
        reportedCost = Number(event.total_cost_usd);
      }
      if (event.usage) {
        resultUsage = {
          input: Number(event.usage.input_tokens ?? 0),
          output: Number(event.usage.output_tokens ?? 0),
          cacheRead: Number(event.usage.cache_read_input_tokens ?? 0),
          cacheWrite: Number(event.usage.cache_creation_input_tokens ?? 0),
        };
      }
      if (event.modelUsage && typeof event.modelUsage === "object") {
        for (const [model, modelUsage] of Object.entries(event.modelUsage)) {
          models.push(model, modelUsage?.canonicalModel);
        }
      }
    }
  }

  if (resultUsage) Object.assign(usage, resultUsage);
  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return {
    events,
    sessionId,
    finalResponse,
    models: unique(models),
    generationIds: unique(generationIds),
    modelCalls: modelCallIds.size,
    toolCalls: toolCallIds.size,
    toolNames,
    toolErrors: toolErrorIds.size,
    usage,
    reportedCost,
  };
}

function parseClaudeEventsTolerant(input) {
  const events = input
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return parseClaudeEvents(events);
}

export function assertKimiOnlyEvidence(models) {
  if (!Array.isArray(models) || models.length === 0) throw new Error("missing model evidence");
  for (const model of models) {
    if (!DATED_APPROVED_MODEL.test(model)) throw new Error(`forbidden model: ${model}`);
  }
}

export function assertCompatibilityResult(summary, { expectedContent, expectedHash }) {
  assertKimiOnlyEvidence(summary.models);
  if (summary.toolCalls < 1) throw new Error("Claude Code/Kimi did not use a tool");
  if (!summary.toolNames?.includes("Read") || !summary.toolNames?.includes("Bash")) {
    throw new Error("Claude Code/Kimi is missing required Read and Bash tools");
  }
  if (summary.toolErrors > 0) throw new Error("Claude Code/Kimi compatibility tool failed");
  if (
    !summary.finalResponse.includes(expectedContent) ||
    !summary.finalResponse.includes(expectedHash)
  ) {
    throw new Error("Claude Code/Kimi returned an incorrect compatibility answer");
  }
}

export function keyUsageDelta(before, after) {
  const beforeUsage = Number(before?.usage);
  const afterUsage = Number(after?.usage);
  if (!Number.isFinite(beforeUsage) || !Number.isFinite(afterUsage)) {
    throw new Error("OpenRouter key snapshots are missing numeric usage");
  }
  return Number((afterUsage - beforeUsage).toFixed(12));
}

export function generationCoverage({ keyDelta, generationCost }) {
  const unlinkedOverhead = Number((keyDelta - generationCost).toFixed(12));
  return {
    covered: unlinkedOverhead >= -1e-7,
    fullyAttributed: Math.abs(unlinkedOverhead) <= 1e-7,
    unlinkedOverhead,
  };
}

export function parseClaudeVersion(result) {
  const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  if (result?.status !== 0 || !match) throw new Error("unable to read Claude Code version");
  return match[1];
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function runClaudeProcess({
  executable = "claude",
  args,
  cwd,
  runDir,
  env,
  timeoutMs,
  maxCaptureBytes = MAX_CAPTURE_BYTES,
}) {
  const startedAt = Date.now();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let captureError = null;
    let settled = false;
    let killTimer;

    const capture = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (Buffer.byteLength(next) > maxCaptureBytes) {
        if (!captureError) {
          captureError = new Error("Claude Code output exceeded the capture limit");
          signalProcessGroup(child, "SIGTERM");
          killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 1_000);
        }
        return target;
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      rejectRun(error);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 1_000);
    }, timeoutMs);

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      const safeStdout = redactSecrets(stdout);
      const safeStderr = redactSecrets(stderr);
      writeFileSync(join(runDir, "events.jsonl"), safeStdout, { mode: 0o600 });
      writeFileSync(join(runDir, "stderr.txt"), safeStderr, { mode: 0o600 });
      const baseProcessResult = {
        exitCode,
        signal,
        timedOut,
        wallTimeMs: Date.now() - startedAt,
        stderr: safeStderr,
      };
      if (captureError) {
        captureError.processResult = {
          ...baseProcessResult,
          summary: parseClaudeEventsTolerant(safeStdout),
        };
        rejectRun(captureError);
        return;
      }
      let summary;
      try {
        summary = parseClaudeEvents(safeStdout);
      } catch (error) {
        error.processResult = {
          ...baseProcessResult,
          summary: parseClaudeEventsTolerant(safeStdout),
        };
        rejectRun(error);
        return;
      }
      resolveRun({
        ...baseProcessResult,
        summary,
      });
    });
  });
}

export function getClaudeOpenRouterKey() {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`unable to retrieve dedicated Claude OpenRouter key (status ${result.status})`);
  }
  const secret = result.stdout.trim();
  if (!/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(secret)) {
    throw new Error("Claude evaluation Keychain item is not a recognized OpenRouter key");
  }
  return secret;
}

function makeRunDirectory(root = RUNS_DIR) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(root, stamp);
  mkdirSync(join(runDir, "config"), { recursive: true });
  mkdirSync(join(runDir, "fixture"), { recursive: true });
  return runDir;
}

export async function collectClaudeAttribution(secret, runDir, before, parsed) {
  const generations = [];
  for (const generationId of parsed.generationIds) {
    generations.push(await openRouterGeneration(secret, generationId));
  }
  writeJson(join(runDir, "openrouter-generations.json"), generations);
  const generationAttribution = attributionFromGenerations(generations);
  let after;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    after = await snapshotOpenRouterKey(secret);
    const keyDelta = keyUsageDelta(before, after);
    const threshold =
      generationAttribution.generationCost > 0
        ? generationCoverage({
            keyDelta,
            generationCost: generationAttribution.generationCost,
          }).covered
        : keyDelta > 0;
    if (threshold) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      after = await snapshotOpenRouterKey(secret);
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  writeJson(join(runDir, "openrouter-after.json"), after);
  const openRouterSpendDelta = keyUsageDelta(before, after);
  const coverage = generationCoverage({
    keyDelta: openRouterSpendDelta,
    generationCost: generationAttribution.generationCost,
  });
  if (generationAttribution.generationCost > 0 && !coverage.covered) {
    throw new Error("dedicated Claude key did not cover visible generation cost within 60 seconds");
  }
  return {
    generations,
    generationIds: generationAttribution.generationIds,
    upstreamProviders: generationAttribution.upstreamProviders,
    generationCost: generationAttribution.generationCost,
    openRouterSpendDelta,
    unlinkedOverhead: coverage.unlinkedOverhead,
    fullyAttributed: coverage.fullyAttributed,
    attributionMode: generations.length > 0 ? "generation-records-and-dedicated-key" : "dedicated-key-delta",
  };
}

export async function runCompatibility({ outputRoot = RUNS_DIR } = {}) {
  const runDir = makeRunDirectory(resolve(outputRoot));
  const fixtureDir = join(runDir, "fixture");
  const configDir = join(runDir, "config");
  const fixtureContent = "CLAUDE-KIMI-COMPATIBILITY-7319\n";
  const fixturePath = join(fixtureDir, "facts.txt");
  writeFileSync(fixturePath, fixtureContent);
  const expectedHash = createHash("sha256").update(fixtureContent).digest("hex");
  const prompt = [
    "This is a deterministic harness compatibility check.",
    "Use the built-in Read tool to read facts.txt.",
    "Use the built-in Bash tool to run `shasum -a 256 facts.txt`.",
    "Then reply with the file's exact content and exact SHA-256 hash.",
    "Do not infer either value without using both tools.",
  ].join(" ");

  const secret = getClaudeOpenRouterKey();
  const before = await snapshotOpenRouterKey(secret);
  writeJson(join(runDir, "openrouter-before.json"), before);
  const startedAt = Date.now();
  let processResult;
  try {
    processResult = await runClaudeProcess({
      args: buildClaudeArgs(prompt),
      cwd: fixtureDir,
      runDir,
      env: buildClaudeEnv({ secret, configDir }),
      timeoutMs: 180_000,
    });
    if (processResult.timedOut) throw new Error("Claude Code compatibility run timed out");
    if (processResult.exitCode !== 0) {
      throw new Error(
        `Claude Code compatibility run exited ${processResult.exitCode}: ${processResult.stderr.slice(0, 4_000)}`,
      );
    }
    assertCompatibilityResult(processResult.summary, {
      expectedContent: fixtureContent.trim(),
      expectedHash,
    });
    const attribution = await collectClaudeAttribution(
      secret,
      runDir,
      before,
      processResult.summary,
    );
    const versionResult = spawnSync("claude", ["--version"], { encoding: "utf8" });
    const gates = {
      modelIdentity: true,
      readTool: true,
      bashTool: true,
      deterministicAnswer: true,
      usageVisible: processResult.summary.usage.total > 0,
      costVisible: attribution.openRouterSpendDelta > 0,
      fullyAttributed: attribution.fullyAttributed,
      interruptPassed: false,
      resumePassed: false,
    };
    const compatibilityEligible = Object.values(gates).every(Boolean);
    const summary = {
      status: compatibilityEligible ? "pass" : "incomplete",
      compatibilityEligible,
      harness: "Claude Code",
      claudeCodeVersion: parseClaudeVersion(versionResult),
      model: APPROVED_MODEL,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - startedAt,
      gates,
      finalResponse: processResult.summary.finalResponse,
      usage: {
        harness: processResult.summary.usage,
        harnessReportedCost: processResult.summary.reportedCost,
        modelCalls: processResult.summary.modelCalls,
        toolCalls: processResult.summary.toolCalls,
        toolErrors: processResult.summary.toolErrors,
        ...attribution,
      },
      sessionId: processResult.summary.sessionId,
      artifacts: { runDir },
    };
    writeJson(join(runDir, "summary.json"), summary);
    return summary;
  } catch (error) {
    processResult ??= error?.processResult;
    let attribution = null;
    let attributionError = null;
    if (processResult?.summary) {
      try {
        attribution = await collectClaudeAttribution(
          secret,
          runDir,
          before,
          processResult.summary,
        );
      } catch (meterError) {
        attributionError =
          meterError instanceof Error ? meterError.message : String(meterError);
      }
    }
    let after = null;
    try {
      after = await snapshotOpenRouterKey(secret);
      writeJson(join(runDir, "openrouter-after.json"), after);
    } catch {
      // The primary error is retained when metering is unavailable.
    }
    const failure = {
      status: "fail",
      harness: "Claude Code",
      model: APPROVED_MODEL,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - startedAt,
      error: redactSecrets(error instanceof Error ? error.stack ?? error.message : String(error)),
      usage:
        attribution ??
        (after === null
          ? null
          : {
              openRouterSpendDelta: keyUsageDelta(before, after),
              attributionMode: "dedicated-key-delta",
            }),
      attributionError,
      artifacts: { runDir },
    };
    writeJson(join(runDir, "summary.json"), failure);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { runDir });
  }
}

export async function recoverCompatibility(runDir) {
  const resolvedRunDir = resolve(runDir);
  const fixtureContent = readFileSync(join(resolvedRunDir, "fixture", "facts.txt"), "utf8");
  const expectedHash = createHash("sha256").update(fixtureContent).digest("hex");
  const events = readFileSync(join(resolvedRunDir, "events.jsonl"), "utf8");
  const parsed = parseClaudeEvents(events);
  assertCompatibilityResult(parsed, {
    expectedContent: fixtureContent.trim(),
    expectedHash,
  });
  const secret = getClaudeOpenRouterKey();
  const before = JSON.parse(readFileSync(join(resolvedRunDir, "openrouter-before.json"), "utf8"));
  const attribution = await collectClaudeAttribution(secret, resolvedRunDir, before, parsed);
  const previous = JSON.parse(readFileSync(join(resolvedRunDir, "summary.json"), "utf8"));
  const versionResult = spawnSync("claude", ["--version"], { encoding: "utf8" });
  const gates = {
    modelIdentity: true,
    readTool: parsed.toolNames.includes("Read"),
    bashTool: parsed.toolNames.includes("Bash"),
    deterministicAnswer: true,
    usageVisible: parsed.usage.total > 0,
    costVisible: attribution.openRouterSpendDelta > 0,
    fullyAttributed: attribution.fullyAttributed,
    interruptPassed: false,
    resumePassed: false,
  };
  const compatibilityEligible = Object.values(gates).every(Boolean);
  const summary = {
    status: compatibilityEligible ? "pass" : "incomplete",
    compatibilityEligible,
    recoveredAfterParserFix: true,
    recoveryNote:
      "The compatibility inference and tools succeeded originally; recovery reparsed preserved events and waited for delayed dedicated-key metering without another model call.",
    harness: "Claude Code",
    claudeCodeVersion: parseClaudeVersion(versionResult),
    model: APPROVED_MODEL,
    startedAt: previous.startedAt,
    finishedAt: new Date().toISOString(),
    originalEvaluatorWallTimeMs: previous.wallTimeMs,
    gates,
    finalResponse: parsed.finalResponse,
    usage: {
      harness: parsed.usage,
      harnessReportedCost: parsed.reportedCost,
      modelCalls: parsed.modelCalls,
      toolCalls: parsed.toolCalls,
      toolNames: parsed.toolNames,
      toolErrors: parsed.toolErrors,
      ...attribution,
    },
    sessionId: parsed.sessionId,
    artifacts: { runDir: resolvedRunDir },
  };
  writeJson(join(resolvedRunDir, "summary.json"), summary);
  return summary;
}

async function main() {
  const summary =
    process.argv[2] === "--recover"
      ? await recoverCompatibility(process.argv[3])
      : await runCompatibility();
  process.stdout.write(
    `${JSON.stringify({
      status: summary.status,
      cost: summary.usage.openRouterSpendDelta,
      modelCalls: summary.usage.modelCalls,
      toolCalls: summary.usage.toolCalls,
      runDir: summary.artifacts.runDir,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${redactSecrets(error.stack ?? String(error))}\n`);
    process.exitCode = 1;
  });
}
