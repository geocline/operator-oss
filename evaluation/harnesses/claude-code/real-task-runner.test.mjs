import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFixtureIsolation,
  collectAfterProcess,
  evaluateRunOutcome,
} from "./real-task-runner.mjs";

test("requires a one-commit target repository with no parent", () => {
  assert.doesNotThrow(() =>
    assertFixtureIsolation({
      isolatedHistory: true,
      visibleCommitCount: 1,
      hasParent: false,
    }),
  );
  assert.throws(
    () =>
      assertFixtureIsolation({
        isolatedHistory: true,
        visibleCommitCount: 2,
        hasParent: true,
      }),
    /fixture history is not isolated/,
  );
});

test("uses the unchanged Prime objective rubric and requires typecheck", () => {
  const result = evaluateRunOutcome({
    focusedTestPassed: true,
    fullSuitePassed: true,
    typecheckPassed: true,
    supplementalPassed: true,
    testUnchanged: true,
    changedFiles: ["app/orchestrator/Transcript.tsx"],
    allowedFiles: [
      "app/globals.css",
      "app/orchestrator/SessionView.tsx",
      "app/orchestrator/Transcript.tsx",
    ],
    toolErrors: 0,
    finalResponse: "The timestamp render regression is fixed. 513 tests passed.",
  });
  assert.equal(result.status, "pass");
  assert.equal(result.scoring.score, 100);

  const failedTypecheck = evaluateRunOutcome({
    focusedTestPassed: true,
    fullSuitePassed: true,
    typecheckPassed: false,
    supplementalPassed: true,
    testUnchanged: true,
    changedFiles: ["app/orchestrator/Transcript.tsx"],
    allowedFiles: ["app/orchestrator/Transcript.tsx"],
    toolErrors: 0,
    finalResponse: "The timestamp regression is fixed and tests passed.",
  });
  assert.equal(failedTypecheck.status, "fail");

  const missedExplicitEdgeCase = evaluateRunOutcome({
    focusedTestPassed: true,
    fullSuitePassed: true,
    typecheckPassed: true,
    supplementalPassed: false,
    testUnchanged: true,
    changedFiles: ["app/orchestrator/Transcript.tsx"],
    allowedFiles: ["app/orchestrator/Transcript.tsx"],
    toolErrors: 0,
    finalResponse: "The timestamp regression is fixed and tests passed.",
  });
  assert.equal(missedExplicitEdgeCase.status, "pass");
  assert.equal(missedExplicitEdgeCase.scoring.score, 100);
  assert.equal(missedExplicitEdgeCase.scoring.objectivePass, true);
  assert.equal(missedExplicitEdgeCase.requirementsSatisfied, false);
});

test("waits for Claude process termination before collecting attribution", async () => {
  const order = [];
  const result = await collectAfterProcess(
    Promise.resolve().then(() => {
      order.push("process-stopped");
      return { exitCode: 0 };
    }),
    async (processResult) => {
      order.push(`attribution-after-${processResult.exitCode}`);
      return { cost: 0.1 };
    },
  );

  assert.deepEqual(order, ["process-stopped", "attribution-after-0"]);
  assert.deepEqual(result, {
    processResult: { exitCode: 0 },
    attribution: { cost: 0.1 },
  });
});
