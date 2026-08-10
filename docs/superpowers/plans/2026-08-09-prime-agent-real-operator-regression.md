# Prime Agent Real Operator Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Prime Agent with Kimi K3 a real, reproducible Operator coding regression and measure whether it can diagnose, repair, and verify the project without being told the historical patch.

**Architecture:** Create a disposable worktree pinned to Operator commit `8da7e84`, reverse only that commit's production timestamp changes, and retain its regression test. Run Prime Agent headlessly through the same Kimi-only OpenRouter provider, capture the full RPC trace and authoritative generation costs, then verify the untouched targeted test, full suite, diff scope, and similarity to the historical fix.

**Tech Stack:** Git worktrees, Prime Agent JSONL RPC, Kimi K3 through the dedicated OpenRouter key, Node test runner, Vitest, HTML reporting.

---

### Task 1: Create the reproducible real regression

**Files:**
- Create at runtime: disposable Operator worktree from `8da7e84`
- Create: `evaluation/harnesses/prime-agent/real-tasks/transcript-timestamps/task.json`

- [x] Pin the fixture to commit `8da7e84`.
- [x] Reverse the production changes from that commit in `app/globals.css`, `app/orchestrator/SessionView.tsx`, and `app/orchestrator/Transcript.tsx`.
- [x] Keep `tests/transcriptTimestamps.test.ts` unchanged.
- [x] Install the pinned dependencies.
- [x] Run `npm test -- tests/transcriptTimestamps.test.ts` and require a genuine assertion failure.
- [x] Save the seeded diff and baseline failure output.

### Task 2: Add a reusable real-task runner

**Files:**
- Modify: `evaluation/harnesses/prime-agent/compatibility-runner.mjs`
- Modify: `evaluation/harnesses/prime-agent/compatibility-runner.test.mjs`
- Create: `evaluation/harnesses/prime-agent/real-task-runner.mjs`
- Create: `evaluation/harnesses/prime-agent/real-task-runner.test.mjs`

- [x] Write failing tests for immutable-test verification, forbidden-model rejection, and result scoring.
- [x] Export the minimal shared Prime RPC/config/attribution primitives.
- [x] Run one fresh Prime session with repository context enabled, auto-refinement off, and only `moonshotai/kimi-k3` reachable.
- [x] Stop the client before final metering on every failure path.
- [x] Record RPC events, session HTML, Git diff, test output, token usage, generation metadata, exact cost, and wall time.

### Task 3: Give Prime/Kimi the real task

**Prompt:**

```text
Operator has a transcript timestamp regression. User prompts and the first
assistant reply to each prompt must display their timestamp first. Tool calls,
question cards, system notices, and similar non-conversational rows must not
receive timestamps.

Diagnose the regression in this repository, reproduce it with the existing
tests, implement the smallest correct fix, and verify both the focused test and
the full test suite. Do not modify tests. Keep the change scoped to this bug and
finish with a concise diagnosis plus exact verification evidence.
```

- [x] Run exactly one uninterrupted Prime Agent session.
- [x] Do not steer, rescue, or supply the historical patch.
- [x] Stop on model substitution, low credits, runaway execution, or timeout.
- [x] Do not purchase credits.

### Task 4: Score and report

**Files:**
- Create: `prime-agent-kimi-k3-real-operator-task-2026-08-09.html`

- [x] Verify the target test passes and its file hash is unchanged.
- [x] Verify the full suite passes.
- [x] Compare the agent diff with the historical production fix.
- [x] Score correctness, tool use, autonomy, efficiency, and task closure.
- [x] Scan every artifact for secrets and forbidden models.
- [x] Shut down Prime Agent processes.
- [x] Create the Geo-facing HTML report and commit only evaluation artifacts.
