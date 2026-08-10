import assert from "node:assert/strict";
import test from "node:test";

import {
  assertImmutableTest,
  parsePorcelainPaths,
  scoreRealTask,
} from "./real-task-runner.mjs";

test("rejects any modification to the regression test", () => {
  assert.doesNotThrow(() => assertImmutableTest("same-hash", "same-hash"));
  assert.throws(() => assertImmutableTest("before", "after"), /regression test was modified/);
});

test("preserves the leading status column when parsing porcelain output", () => {
  assert.deepEqual(
    parsePorcelainPaths(
      " M app/globals.css\n M app/orchestrator/SessionView.tsx\n M app/orchestrator/Transcript.tsx\n",
    ),
    [
      "app/globals.css",
      "app/orchestrator/SessionView.tsx",
      "app/orchestrator/Transcript.tsx",
    ],
  );
});

test("awards a full objective score to a scoped verified repair", () => {
  const result = scoreRealTask({
    focusedTestPassed: true,
    fullSuitePassed: true,
    testUnchanged: true,
    changedFiles: [
      "app/globals.css",
      "app/orchestrator/SessionView.tsx",
      "app/orchestrator/Transcript.tsx",
    ],
    allowedFiles: [
      "app/globals.css",
      "app/orchestrator/SessionView.tsx",
      "app/orchestrator/Transcript.tsx",
    ],
    toolErrors: 0,
    userInterventions: 0,
    hasDiagnosis: true,
    hasVerificationEvidence: true,
  });

  assert.equal(result.objectivePass, true);
  assert.equal(result.score, 100);
});

test("fails objective correctness when tests are edited or verification fails", () => {
  const result = scoreRealTask({
    focusedTestPassed: true,
    fullSuitePassed: false,
    testUnchanged: false,
    changedFiles: ["tests/transcriptTimestamps.test.ts"],
    allowedFiles: ["app/orchestrator/Transcript.tsx"],
    toolErrors: 1,
    userInterventions: 0,
    hasDiagnosis: false,
    hasVerificationEvidence: false,
  });

  assert.equal(result.objectivePass, false);
  assert.ok(result.score < 50);
});
