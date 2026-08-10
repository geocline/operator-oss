import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RpcClient,
  assertModelIdentity,
  assistantText,
  attributionFromGenerations,
  collectRunAttribution,
  configurePrimeRun,
  getPrimeOpenRouterKey,
  parsePrimeAgentVersion,
  redactSecrets,
  snapshotOpenRouterKey,
  stopBeforeAttribution,
  summarizeEvents,
  writeJson,
} from "./compatibility-runner.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const TASK_DIR = join(SCRIPT_DIR, "real-tasks", "transcript-timestamps");
const TASK_PATH = join(TASK_DIR, "task.json");
const RUNS_DIR = join(TASK_DIR, "runs");
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
      `${label} failed with exit ${result.exitCode}\n${result.stderr || result.stdout}`.slice(0, 12_000),
    );
  }
}

export function assertImmutableTest(beforeHash, afterHash) {
  if (beforeHash !== afterHash) throw new Error("regression test was modified");
}

export function parsePorcelainPaths(output) {
  return output
    .split("\n")
    .filter((line) => line.length >= 4)
    .map((line) => line.slice(3));
}

export function scoreRealTask({
  focusedTestPassed,
  fullSuitePassed,
  testUnchanged,
  changedFiles,
  allowedFiles,
  toolErrors,
  userInterventions,
  hasDiagnosis,
  hasVerificationEvidence,
}) {
  const scoped = changedFiles.every((path) => allowedFiles.includes(path));
  const correctness =
    (focusedTestPassed ? 15 : 0) +
    (fullSuitePassed ? 15 : 0) +
    (testUnchanged ? 10 : 0);
  const tools = toolErrors === 0 ? 20 : Math.max(0, 20 - toolErrors * 8);
  const autonomy = userInterventions === 0 ? 15 : Math.max(0, 15 - userInterventions * 5);
  const efficiency = scoped ? 15 : 0;
  const closure = (hasDiagnosis ? 5 : 0) + (hasVerificationEvidence ? 5 : 0);
  return {
    objectivePass: focusedTestPassed && fullSuitePassed && testUnchanged && scoped,
    score: correctness + tools + autonomy + efficiency + closure,
    components: { correctness, tools, autonomy, efficiency, closure },
    scoped,
  };
}

function makeRunDirectory() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(RUNS_DIR, stamp);
  mkdirSync(join(runDir, "config"), { recursive: true });
  mkdirSync(join(runDir, "sessions"), { recursive: true });
  cpSync(TASK_PATH, join(runDir, "task.json"));
  return runDir;
}

export function prepareFixture(runDir, task) {
  const tempParent = mkdtempSync(join(tmpdir(), "operator-prime-real-"));
  const repoPath = join(tempParent, "repo");
  mkdirSync(repoPath);
  try {
    const archive = spawnSync("git", ["archive", "--format=tar", task.pinnedCommit], {
      cwd: REPO_ROOT,
      encoding: null,
      maxBuffer: MAX_BUFFER,
    });
    if (archive.status !== 0 || !archive.stdout) {
      throw new Error(`fixture archive failed with exit ${archive.status}`);
    }
    const extract = spawnSync("tar", ["-x", "-C", repoPath], {
      input: archive.stdout,
      encoding: null,
      maxBuffer: MAX_BUFFER,
    });
    if (extract.status !== 0) throw new Error(`fixture extraction failed with exit ${extract.status}`);
    requireSuccess(run("git", ["init", "--quiet"], { cwd: repoPath }), "fixture repository initialization");

    const historicalPatch = run(
      "git",
      ["show", "--format=", "--binary", task.historicalFixCommit, "--", ...task.productionFiles],
      { cwd: REPO_ROOT },
    );
    requireSuccess(historicalPatch, "historical patch extraction");
    writeFileSync(join(runDir, "historical-fix.patch"), historicalPatch.stdout);

    const reversePatch = run("git", ["apply", "-R", "--whitespace=nowarn", "-"], {
      cwd: repoPath,
      input: historicalPatch.stdout,
    });
    requireSuccess(reversePatch, "regression seeding");

    writeFileSync(
      join(runDir, "seeded-regression.patch"),
      run(
        "git",
        ["show", "--format=", "--binary", task.historicalFixCommit, "--", ...task.productionFiles],
        { cwd: REPO_ROOT },
      ).stdout,
    );

    requireSuccess(run("git", ["add", "-A"], { cwd: repoPath }), "snapshot staging");
    requireSuccess(
      run(
        "git",
        [
          "-c",
          "user.name=Operator Harness Evaluation",
          "-c",
          "user.email=operator-eval@localhost",
          "commit",
          "-m",
          "Initial Operator evaluation snapshot",
        ],
        { cwd: repoPath },
      ),
      "snapshot commit",
    );
    const seededCommit = run("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    requireSuccess(seededCommit, "snapshot commit resolution");
    const parents = run("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: repoPath });
    requireSuccess(parents, "snapshot parent check");
    if (parents.stdout.trim().split(/\s+/).length !== 1) {
      throw new Error("evaluation snapshot unexpectedly exposes parent history");
    }

    const install = run("npm", ["ci"], { cwd: repoPath, timeoutMs: 180_000 });
    requireSuccess(install, "fixture dependency installation");
    writeJson(join(runDir, "fixture-install.json"), install);

    const testPath = join(repoPath, task.immutableTest);
    const testHash = sha256(testPath);
    if (testHash !== task.immutableTestSha256) {
      throw new Error(`immutable regression test hash mismatch before run: ${testHash}`);
    }

    const baseline = run("npm", ["test", "--", task.immutableTest], {
      cwd: repoPath,
      timeoutMs: 120_000,
    });
    writeJson(join(runDir, "baseline-focused-test.json"), baseline);
    if (baseline.exitCode === 0) throw new Error("seeded regression did not fail the focused test");

    writeJson(join(runDir, "fixture.json"), {
      sourceRepo: REPO_ROOT,
      disposableRepo: repoPath,
      pinnedCommit: task.pinnedCommit,
      seededCommit: seededCommit.stdout.trim(),
      immutableTestHash: testHash,
      changedPaths: task.productionFiles,
      baselineFailureConfirmed: true,
      isolatedHistory: true,
      visibleCommitCount: 1,
    });
    return { tempParent, repoPath, testHash, seededCommit: seededCommit.stdout.trim() };
  } catch (error) {
    rmSync(tempParent, { recursive: true, force: true });
    throw error;
  }
}

function changedFiles(repoPath, baseCommit) {
  const result = run("git", ["diff", "--name-only", baseCommit], { cwd: repoPath });
  requireSuccess(result, "changed-file listing");
  return result.stdout.trim().split("\n").filter(Boolean);
}

export function cleanupFixture(repoPath, tempParent) {
  rmSync(tempParent, { recursive: true, force: true });
}

export async function runRealTask() {
  const task = JSON.parse(readFileSync(TASK_PATH, "utf8"));
  const runDir = makeRunDirectory();
  const startedAt = Date.now();
  const secret = getPrimeOpenRouterKey();
  const configDir = configurePrimeRun(runDir);
  const before = await snapshotOpenRouterKey(secret);
  writeJson(join(runDir, "openrouter-before.json"), before);

  let fixture;
  let client;
  let gates = {};
  try {
    fixture = prepareFixture(runDir, task);
    const beforeStatus = run("git", ["status", "--short"], { cwd: fixture.repoPath });
    if (beforeStatus.stdout.trim()) throw new Error("seeded fixture is not clean before the agent run");

    client = new RpcClient({
      runDir,
      configDir,
      secret,
      cwd: fixture.repoPath,
      loadContextFiles: true,
    });
    const state = (await client.command("get_state")).data;
    assertModelIdentity(state.model);

    const promptStartedAt = Date.now();
    const promptEvents = await client.prompt(task.prompt, 20 * 60_000);
    const promptWallTimeMs = Date.now() - promptStartedAt;
    const eventSummary = summarizeEvents(promptEvents, { allowToolErrors: true });
    const finalResponse = assistantText(promptEvents);
    writeFileSync(join(runDir, "final-response.txt"), `${finalResponse}\n`);
    const stats = (await client.command("get_session_stats")).data;
    await client.command("export_html", { outputPath: join(runDir, "session.html") });
    await client.close();
    client = undefined;

    const agentDiff = run("git", ["diff", "--binary", fixture.seededCommit], { cwd: fixture.repoPath });
    requireSuccess(agentDiff, "agent diff capture");
    writeFileSync(join(runDir, "agent.patch"), agentDiff.stdout);
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

    const agentPatchHash = createHash("sha256").update(agentDiff.stdout).digest("hex");
    const historicalPatchHash = sha256(join(runDir, "historical-fix.patch"));
    const hasDiagnosis = /(cause|regression|timestamp|render)/i.test(finalResponse);
    const hasVerificationEvidence = /(test|pass|vitest|verified|verification)/i.test(finalResponse);
    const scoring = scoreRealTask({
      focusedTestPassed: focused.exitCode === 0,
      fullSuitePassed: full.exitCode === 0,
      testUnchanged: fixture.testHash === afterTestHash,
      changedFiles: filesChanged,
      allowedFiles: task.productionFiles,
      toolErrors: eventSummary.toolErrors,
      userInterventions: 0,
      hasDiagnosis,
      hasVerificationEvidence,
    });

    const attribution = await collectRunAttribution(secret, runDir, before);
    if (Math.abs(attribution.generationCost - eventSummary.usage.cost) > 1e-7) {
      throw new Error("Prime and OpenRouter generation costs do not reconcile");
    }

    gates = {
      baselineFailure: true,
      modelIdentity: true,
      focusedTestPassed: focused.exitCode === 0,
      fullSuitePassed: full.exitCode === 0,
      typecheckPassed: typecheck.exitCode === 0,
      testUnchanged: fixture.testHash === afterTestHash,
      scopedDiff: scoring.scoped,
    };
    const versionResult = run("prime-agent", ["--version"]);
    const summary = {
      status: scoring.objectivePass && typecheck.exitCode === 0 ? "pass" : "fail",
      harness: "Prime Agent",
      model: "moonshotai/kimi-k3",
      primeAgentVersion: parsePrimeAgentVersion({
        status: versionResult.exitCode,
        stdout: versionResult.stdout,
        stderr: versionResult.stderr,
      }),
      taskId: task.id,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - startedAt,
      agentWallTimeMs: promptWallTimeMs,
      gates,
      scoring,
      changedFiles: filesChanged,
      exactHistoricalPatch: agentPatchHash === historicalPatchHash,
      agentPatchSha256: agentPatchHash,
      historicalPatchSha256: historicalPatchHash,
      finalResponse,
      usage: {
        harness: stats.tokens,
        harnessCost: stats.cost,
        modelCalls: eventSummary.modelCalls,
        toolCalls: eventSummary.toolCalls,
        toolErrors: eventSummary.toolErrors,
        openRouterSpendDelta: attribution.openRouterSpendDelta,
        openRouterGenerationCost: attribution.generationCost,
        generationIds: attribution.generationIds,
        upstreamProviders: attribution.upstreamProviders,
      },
      artifacts: { runDir },
    };
    writeJson(join(runDir, "summary.json"), summary);
    return summary;
  } catch (error) {
    const clients = [client].filter(Boolean);
    client = undefined;
    let attribution = null;
    let attributionError = null;
    try {
      attribution = await stopBeforeAttribution(clients, () =>
        collectRunAttribution(secret, runDir, before, { enforceIdentity: false }),
      );
    } catch (meterError) {
      attributionError = meterError instanceof Error ? meterError.message : String(meterError);
    }
    const failure = {
      status: "fail",
      harness: "Prime Agent",
      model: "moonshotai/kimi-k3",
      taskId: task.id,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - startedAt,
      error: redactSecrets(error instanceof Error ? error.stack ?? error.message : String(error)),
      gates,
      usage: attribution
        ? {
            openRouterSpendDelta: attribution.openRouterSpendDelta,
            openRouterGenerationCost: attribution.generationCost,
            generationIds: attribution.generationIds,
          }
        : null,
      attributionError,
      artifacts: { runDir },
    };
    writeJson(join(runDir, "summary.json"), failure);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { runDir });
  } finally {
    await client?.forceStop();
    if (fixture) cleanupFixture(fixture.repoPath, fixture.tempParent);
  }
}

export function recoverCompletedRun(runDir, agentCommit) {
  const task = JSON.parse(readFileSync(join(runDir, "task.json"), "utf8"));
  const originalSummary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
  const fixtureRecord = JSON.parse(readFileSync(join(runDir, "fixture.json"), "utf8"));
  const tempParent = mkdtempSync(join(tmpdir(), "operator-prime-recovery-"));
  const repoPath = join(tempParent, "repo");
  let worktreeAdded = false;
  try {
    const add = run("git", ["worktree", "add", "--detach", repoPath, agentCommit], {
      cwd: REPO_ROOT,
      timeoutMs: 60_000,
    });
    requireSuccess(add, "recovery worktree creation");
    worktreeAdded = true;

    const install = run("npm", ["ci"], { cwd: repoPath, timeoutMs: 180_000 });
    requireSuccess(install, "recovery dependency installation");
    writeJson(join(runDir, "recovery-install.json"), install);

    const resolvedCommit = run("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    requireSuccess(resolvedCommit, "agent commit resolution");
    const agentDiff = run(
      "git",
      ["diff", "--binary", fixtureRecord.seededCommit, resolvedCommit.stdout.trim()],
      { cwd: repoPath },
    );
    requireSuccess(agentDiff, "recovered agent diff");
    writeFileSync(join(runDir, "agent.patch"), agentDiff.stdout);

    const files = run(
      "git",
      ["diff", "--name-only", fixtureRecord.seededCommit, resolvedCommit.stdout.trim()],
      { cwd: repoPath },
    );
    requireSuccess(files, "recovered changed-file list");
    const filesChanged = files.stdout.trim().split("\n").filter(Boolean);

    const afterTestHash = sha256(join(repoPath, task.immutableTest));
    assertImmutableTest(fixtureRecord.immutableTestHash, afterTestHash);
    const focused = run("npm", ["test", "--", task.immutableTest], {
      cwd: repoPath,
      timeoutMs: 120_000,
    });
    writeJson(join(runDir, "host-focused-test.json"), focused);
    const full = run("npm", ["test"], { cwd: repoPath, timeoutMs: 180_000 });
    writeJson(join(runDir, "host-full-test.json"), full);
    const typecheck = run("npx", ["tsc", "--noEmit"], { cwd: repoPath, timeoutMs: 180_000 });
    writeJson(join(runDir, "host-typecheck.json"), typecheck);

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const eventSummary = summarizeEvents(events, { allowToolErrors: true });
    const finalResponse = readFileSync(join(runDir, "final-response.txt"), "utf8").trim();
    const generations = JSON.parse(readFileSync(join(runDir, "openrouter-generations.json"), "utf8"));
    const generationAttribution = attributionFromGenerations(generations);
    const before = JSON.parse(readFileSync(join(runDir, "openrouter-before.json"), "utf8"));
    const after = JSON.parse(readFileSync(join(runDir, "openrouter-after.json"), "utf8"));
    const spendDelta = Number((Number(after.usage) - Number(before.usage)).toFixed(12));

    const agentPatchHash = createHash("sha256").update(agentDiff.stdout).digest("hex");
    const historicalPatchHash = sha256(join(runDir, "historical-fix.patch"));
    const scoring = scoreRealTask({
      focusedTestPassed: focused.exitCode === 0,
      fullSuitePassed: full.exitCode === 0,
      testUnchanged: fixtureRecord.immutableTestHash === afterTestHash,
      changedFiles: filesChanged,
      allowedFiles: task.productionFiles,
      toolErrors: eventSummary.toolErrors,
      userInterventions: 0,
      hasDiagnosis: /(cause|regression|timestamp|render)/i.test(finalResponse),
      hasVerificationEvidence: /(test|pass|vitest|verified|verification)/i.test(finalResponse),
    });
    const gates = {
      baselineFailure: fixtureRecord.baselineFailureConfirmed === true,
      modelIdentity: true,
      focusedTestPassed: focused.exitCode === 0,
      fullSuitePassed: full.exitCode === 0,
      typecheckPassed: typecheck.exitCode === 0,
      testUnchanged: fixtureRecord.immutableTestHash === afterTestHash,
      scopedDiff: scoring.scoped,
    };
    const passed = scoring.objectivePass && typecheck.exitCode === 0;
    const summary = {
      status: passed ? "pass" : "fail",
      recoveredAfterMeteringDelay: true,
      harness: "Prime Agent",
      model: "moonshotai/kimi-k3",
      primeAgentVersion: "0.7.1",
      taskId: task.id,
      startedAt: originalSummary.startedAt,
      finishedAt: new Date().toISOString(),
      originalEvaluatorWallTimeMs: originalSummary.wallTimeMs,
      agentCommit: resolvedCommit.stdout.trim(),
      gates,
      scoring,
      changedFiles: filesChanged,
      exactHistoricalPatch: agentPatchHash === historicalPatchHash,
      agentPatchSha256: agentPatchHash,
      historicalPatchSha256: historicalPatchHash,
      finalResponse,
      usage: {
        harness: {
          input: eventSummary.usage.input,
          output: eventSummary.usage.output,
          cacheRead: eventSummary.usage.cacheRead,
          cacheWrite: eventSummary.usage.cacheWrite,
          total: eventSummary.usage.total,
        },
        harnessCost: eventSummary.usage.cost,
        modelCalls: eventSummary.modelCalls,
        toolCalls: eventSummary.toolCalls,
        toolErrors: eventSummary.toolErrors,
        openRouterSpendDelta: spendDelta,
        openRouterGenerationCost: generationAttribution.generationCost,
        generationIds: generationAttribution.generationIds,
        upstreamProviders: generationAttribution.upstreamProviders,
      },
      artifacts: { runDir },
    };
    writeJson(join(runDir, "summary.json"), summary);
    return summary;
  } finally {
    if (worktreeAdded) cleanupFixture(repoPath, tempParent);
    else rmSync(tempParent, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv[2] === "--recover") {
    const runDir = resolve(process.argv[3]);
    const summary = recoverCompletedRun(runDir, process.argv[4]);
    process.stdout.write(
      `${JSON.stringify({
        status: summary.status,
        score: summary.scoring.score,
        cost: summary.usage.openRouterSpendDelta,
        exactHistoricalPatch: summary.exactHistoricalPatch,
        runDir: summary.artifacts.runDir,
      })}\n`,
    );
    return;
  }
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
