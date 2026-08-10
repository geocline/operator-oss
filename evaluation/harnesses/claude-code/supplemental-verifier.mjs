import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cleanupFixture,
  prepareFixture,
} from "../prime-agent/real-task-runner.mjs";
import {
  redactSecrets,
  writeJson,
} from "../prime-agent/compatibility-runner.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const TASK_PATH = join(
  REPO_ROOT,
  "evaluation/harnesses/prime-agent/real-tasks/transcript-timestamps/task.json",
);
const TEST_SOURCE = join(SCRIPT_DIR, "supplemental-artifact-notice.test.ts");
const MAX_BUFFER = 64 * 1024 * 1024;

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: options.timeoutMs,
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

export function verifySavedPatch(runDir) {
  const resolvedRunDir = resolve(runDir);
  const task = JSON.parse(readFileSync(TASK_PATH, "utf8"));
  const scratch = mkdtempSync(join(tmpdir(), "operator-harness-supplemental-"));
  const fixtureArtifacts = join(scratch, "fixture-artifacts");
  mkdirSync(fixtureArtifacts);
  let fixture;
  try {
    fixture = prepareFixture(fixtureArtifacts, task);
    const apply = run("git", ["apply", join(resolvedRunDir, "agent.patch")], {
      cwd: fixture.repoPath,
    });
    if (apply.exitCode !== 0) throw new Error(`saved patch failed to apply: ${apply.stderr}`);
    const testPath = join(
      fixture.repoPath,
      "tests",
      "harnessSupplementalArtifactNotice.test.ts",
    );
    cpSync(TEST_SOURCE, testPath);
    const verification = run(
      "npx",
      ["vitest", "run", "tests/harnessSupplementalArtifactNotice.test.ts"],
      { cwd: fixture.repoPath, timeoutMs: 120_000 },
    );
    writeJson(
      join(resolvedRunDir, "host-supplemental-artifact-notice.json"),
      verification,
    );
    return verification;
  } finally {
    if (fixture) cleanupFixture(fixture.repoPath, fixture.tempParent);
    else cleanupFixture("", scratch);
  }
}

function main() {
  const result = verifySavedPatch(process.argv[2]);
  process.stdout.write(
    `${JSON.stringify({
      status: result.exitCode === 0 ? "pass" : "fail",
      exitCode: result.exitCode,
      runDir: resolve(process.argv[2]),
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${redactSecrets(error.stack ?? String(error))}\n`);
    process.exitCode = 1;
  }
}
