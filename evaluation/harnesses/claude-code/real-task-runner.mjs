import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertImmutableTest,
  cleanupFixture,
  prepareFixture,
  scoreRealTask,
} from "../prime-agent/real-task-runner.mjs";
import {
  redactSecrets,
  snapshotOpenRouterKey,
  writeJson,
} from "../prime-agent/compatibility-runner.mjs";
import {
  APPROVED_MODEL,
  assertKimiOnlyEvidence,
  buildClaudeArgs,
  buildClaudeEnv,
  collectClaudeAttribution,
  generationCoverage,
  getClaudeOpenRouterKey,
  parseClaudeVersion,
  runClaudeProcess,
} from "./runner.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const TASK_PATH = join(
  REPO_ROOT,
  "evaluation/harnesses/prime-agent/real-tasks/transcript-timestamps/task.json",
);
const TASK_ROOT = join(SCRIPT_DIR, "real-tasks", "transcript-timestamps");
const RUNS_DIR = join(TASK_ROOT, "runs");
const SUPPLEMENTAL_TEST_SOURCE = join(SCRIPT_DIR, "supplemental-artifact-notice.test.ts");
const MAX_BUFFER = 64 * 1024 * 1024;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: options.timeoutMs,
    env: { ...process.env, ...options.env },
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status,
    signal: result.signal,
    stdout: redactSecrets(result.stdout ?? ""),
    stderr: redactSecrets(result.stderr ?? ""),
    wallTimeMs: Date.now() - startedAt,
    error: result.error ? redactSecrets(result.error.message) : null,
  };
}

function requireSuccess(result, label) {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}\n${result.stderr || result.stdout}`.slice(
        0,
        12_000,
      ),
    );
  }
}

function makeRunDirectory() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(RUNS_DIR, stamp);
  mkdirSync(join(runDir, "config"), { recursive: true });
  cpSync(TASK_PATH, join(runDir, "task.json"));
  return runDir;
}

export function assertFixtureIsolation({ isolatedHistory, visibleCommitCount, hasParent }) {
  if (isolatedHistory !== true || visibleCommitCount !== 1 || hasParent !== false) {
    throw new Error("fixture history is not isolated");
  }
}

export function evaluateRunOutcome({
  focusedTestPassed,
  fullSuitePassed,
  typecheckPassed,
  supplementalPassed,
  testUnchanged,
  changedFiles,
  allowedFiles,
  toolErrors,
  finalResponse,
}) {
  const scoring = scoreRealTask({
    focusedTestPassed,
    fullSuitePassed,
    testUnchanged,
    changedFiles,
    allowedFiles,
    toolErrors,
    userInterventions: 0,
    hasDiagnosis: /(cause|regression|timestamp|render)/i.test(finalResponse),
    hasVerificationEvidence: /(test|pass|vitest|verified|verification)/i.test(finalResponse),
  });
  return {
    status: scoring.objectivePass && typecheckPassed ? "pass" : "fail",
    scoring,
    requirementsSatisfied: supplementalPassed !== false,
  };
}

export async function collectAfterProcess(processPromise, collectAttribution) {
  const processResult = await processPromise;
  const attribution = await collectAttribution(processResult);
  return { processResult, attribution };
}

function changedFiles(repoPath, baseCommit) {
  const result = run("git", ["diff", "--name-only", baseCommit], { cwd: repoPath });
  requireSuccess(result, "changed-file listing");
  return result.stdout.trim().split("\n").filter(Boolean);
}

export async function runRealTask() {
  const task = JSON.parse(readFileSync(TASK_PATH, "utf8"));
  const runDir = makeRunDirectory();
  const configDir = join(runDir, "config");
  const startedAt = Date.now();
  const secret = getClaudeOpenRouterKey();
  const before = await snapshotOpenRouterKey(secret);
  writeJson(join(runDir, "openrouter-before.json"), before);

  let fixture;
  let processResult;
  let gates = {};
  try {
    fixture = prepareFixture(runDir, task);
    const fixtureRecord = JSON.parse(readFileSync(join(runDir, "fixture.json"), "utf8"));
    const parents = run("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
      cwd: fixture.repoPath,
    });
    requireSuccess(parents, "fixture parent verification");
    assertFixtureIsolation({
      isolatedHistory: fixtureRecord.isolatedHistory,
      visibleCommitCount: Number(
        run("git", ["rev-list", "--all", "--count"], { cwd: fixture.repoPath }).stdout.trim(),
      ),
      hasParent: parents.stdout.trim().split(/\s+/).length > 1,
    });
    const beforeStatus = run("git", ["status", "--short"], { cwd: fixture.repoPath });
    if (beforeStatus.stdout.trim()) throw new Error("seeded fixture is not clean before Claude Code");

    processResult = await runClaudeProcess({
      args: buildClaudeArgs(task.prompt),
      cwd: fixture.repoPath,
      runDir,
      env: buildClaudeEnv({ secret, configDir }),
      timeoutMs: 20 * 60_000,
    });
    if (processResult.timedOut) throw new Error("Claude Code real task timed out");
    if (processResult.exitCode !== 0) {
      throw new Error(
        `Claude Code real task exited ${processResult.exitCode}: ${processResult.stderr.slice(0, 8_000)}`,
      );
    }
    assertKimiOnlyEvidence(processResult.summary.models);
    if (!processResult.summary.finalResponse) {
      throw new Error("Claude Code completed without a final response");
    }
    writeFileSync(
      join(runDir, "final-response.txt"),
      `${processResult.summary.finalResponse}\n`,
      { mode: 0o600 },
    );

    const agentDiff = run("git", ["diff", "--binary", fixture.seededCommit], {
      cwd: fixture.repoPath,
    });
    requireSuccess(agentDiff, "agent diff capture");
    writeFileSync(join(runDir, "agent.patch"), agentDiff.stdout, { mode: 0o600 });
    const filesChanged = changedFiles(fixture.repoPath, fixture.seededCommit);
    const afterTestHash = sha256(join(fixture.repoPath, task.immutableTest));
    assertImmutableTest(fixture.testHash, afterTestHash);

    const focused = run("npm", ["test", "--", task.immutableTest], {
      cwd: fixture.repoPath,
      timeoutMs: 120_000,
    });
    writeJson(join(runDir, "host-focused-test.json"), focused);
    const full = run("npm", ["test"], { cwd: fixture.repoPath, timeoutMs: 180_000 });
    writeJson(join(runDir, "host-full-test.json"), full);
    const typecheck = run("npx", ["tsc", "--noEmit"], {
      cwd: fixture.repoPath,
      timeoutMs: 120_000,
    });
    writeJson(join(runDir, "host-typecheck.json"), typecheck);
    const supplementalTestPath = join(
      fixture.repoPath,
      "tests",
      "harnessSupplementalArtifactNotice.test.ts",
    );
    cpSync(SUPPLEMENTAL_TEST_SOURCE, supplementalTestPath);
    const supplemental = run(
      "npx",
      ["vitest", "run", "tests/harnessSupplementalArtifactNotice.test.ts"],
      { cwd: fixture.repoPath, timeoutMs: 120_000 },
    );
    writeJson(join(runDir, "host-supplemental-artifact-notice.json"), supplemental);
    rmSync(supplementalTestPath);

    const outcome = evaluateRunOutcome({
      focusedTestPassed: focused.exitCode === 0,
      fullSuitePassed: full.exitCode === 0,
      typecheckPassed: typecheck.exitCode === 0,
      supplementalPassed: supplemental.exitCode === 0,
      testUnchanged: fixture.testHash === afterTestHash,
      changedFiles: filesChanged,
      allowedFiles: task.productionFiles,
      toolErrors: processResult.summary.toolErrors,
      finalResponse: processResult.summary.finalResponse,
    });
    const attribution = await collectClaudeAttribution(
      secret,
      runDir,
      before,
      processResult.summary,
    );
    const coverage = generationCoverage({
      keyDelta: attribution.openRouterSpendDelta,
      generationCost: attribution.generationCost,
    });
    const agentPatchHash = createHash("sha256").update(agentDiff.stdout).digest("hex");
    const historicalPatchHash = sha256(join(runDir, "historical-fix.patch"));
    gates = {
      baselineFailure: true,
      fixtureHistoryIsolated: true,
      modelIdentity: true,
      focusedTestPassed: focused.exitCode === 0,
      fullSuitePassed: full.exitCode === 0,
      typecheckPassed: typecheck.exitCode === 0,
      supplementalArtifactNoticePassed: supplemental.exitCode === 0,
      testUnchanged: fixture.testHash === afterTestHash,
      scopedDiff: outcome.scoring.scoped,
      visibleGenerationsCovered: coverage.covered,
      fullyAttributed: coverage.fullyAttributed,
    };
    const versionResult = spawnSync("claude", ["--version"], { encoding: "utf8" });
    const evaluationStatus =
      !coverage.fullyAttributed
        ? "provisional-unscored"
        : outcome.requirementsSatisfied
          ? outcome.status
          : "requirements-miss";
    const summary = {
      status: evaluationStatus,
      automatedStatus: outcome.status,
      requirementsSatisfied: outcome.requirementsSatisfied,
      harness: "Claude Code",
      claudeCodeVersion: parseClaudeVersion(versionResult),
      model: APPROVED_MODEL,
      taskId: task.id,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - startedAt,
      agentWallTimeMs: processResult.wallTimeMs,
      methodology: {
        targetRepositoryHistoryIsolated: true,
        filesystemHermetic: false,
        externalHistoryAccessObservedInTrace: false,
        safeMode: true,
        noFallbackModel: true,
      },
      gates,
      scoring: outcome.scoring,
      changedFiles: filesChanged,
      exactHistoricalPatch: agentPatchHash === historicalPatchHash,
      agentPatchSha256: agentPatchHash,
      historicalPatchSha256: historicalPatchHash,
      finalResponse: processResult.summary.finalResponse,
      usage: {
        harness: processResult.summary.usage,
        harnessReportedCost: processResult.summary.reportedCost,
        modelCalls: processResult.summary.modelCalls,
        toolCalls: processResult.summary.toolCalls,
        toolNames: processResult.summary.toolNames,
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
    const failure = {
      status: "fail",
      harness: "Claude Code",
      model: APPROVED_MODEL,
      taskId: task.id,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - startedAt,
      error: redactSecrets(error instanceof Error ? error.stack ?? error.message : String(error)),
      gates,
      usage: attribution
        ? {
            openRouterSpendDelta: attribution.openRouterSpendDelta,
            generationCost: attribution.generationCost,
            generationIds: attribution.generationIds,
            unlinkedOverhead: attribution.unlinkedOverhead,
          }
        : null,
      attributionError,
      artifacts: { runDir },
    };
    writeJson(join(runDir, "summary.json"), failure);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { runDir });
  } finally {
    if (fixture) cleanupFixture(fixture.repoPath, fixture.tempParent);
  }
}

async function main() {
  const summary = await runRealTask();
  process.stdout.write(
    `${JSON.stringify({
      status: summary.status,
      score: summary.scoring.score,
      cost: summary.usage.openRouterSpendDelta,
      wallTimeMs: summary.wallTimeMs,
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
