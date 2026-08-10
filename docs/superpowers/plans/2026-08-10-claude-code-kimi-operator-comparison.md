# Claude Code/Kimi Operator Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the same Kimi K3 model and clean Operator regression through Claude Code, then compare Claude Code’s harness behavior with the completed Prime Agent run.

**Architecture:** Add a Claude Code evaluator beside the Prime evaluator, while reusing the immutable task definition, fixture construction, objective scoring, and OpenRouter attribution primitives. Claude Code runs non-interactively in safe mode with a dedicated configuration directory, built-in tools, no user/project customizations, no fallback, and every model role pinned to `moonshotai/kimi-k3`. A cheap compatibility call must prove Kimi tool use and observable attribution before the single scored coding run.

**Tech Stack:** Claude Code CLI 2.1.220, Node.js test runner, streamed JSON events, Git snapshot fixtures, Vitest, Kimi K3 through OpenRouter’s Anthropic-compatible endpoint, HTML reporting.

---

### Task 1: Add test-first Claude event and configuration helpers

**Files:**
- Create: `evaluation/harnesses/claude-code/runner.test.mjs`
- Create: `evaluation/harnesses/claude-code/runner.mjs`

- [x] **Step 1: Write failing tests for the hard model lock**

Test that the environment builder sets all primary, small/fast, and subagent model roles to `moonshotai/kimi-k3`, uses `https://openrouter.ai/api`, explicitly blanks `ANTHROPIC_API_KEY`, and never defines a fallback.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test evaluation/harnesses/claude-code/runner.test.mjs
```

Expected: failure because `runner.mjs` does not exist.

- [x] **Step 3: Implement the minimal environment builder**

Return an isolated child environment containing:

```js
{
  ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
  ANTHROPIC_AUTH_TOKEN: secret,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_MODEL: "moonshotai/kimi-k3",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "moonshotai/kimi-k3",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "moonshotai/kimi-k3",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "moonshotai/kimi-k3",
  CLAUDE_CODE_SUBAGENT_MODEL: "moonshotai/kimi-k3",
  CLAUDE_CONFIG_DIR: configDir,
  DISABLE_AUTOUPDATER: "1"
}
```

- [x] **Step 4: Add failing tests for streamed-event parsing**

Cover:

- assistant text extraction;
- tool-call and tool-error counts;
- input, output, cache-read, and cache-write usage;
- session ID extraction;
- generation/request ID extraction without accepting unrelated IDs;
- rejection of a result that reports another model or no model evidence.

- [x] **Step 5: Verify the new tests fail for missing behavior**

Run the same focused Node test and confirm the parser assertions fail.

- [x] **Step 6: Implement the minimal parser and process controls**

Add:

- JSONL parsing with malformed-line rejection;
- secret redaction before artifact writes;
- detached process launch;
- bounded timeout;
- SIGTERM followed by SIGKILL for the process group;
- result parsing that retains raw events, final response, usage, tool calls, errors, session ID, and model evidence.

- [x] **Step 7: Run the focused test and verify GREEN**

Run:

```bash
node --test evaluation/harnesses/claude-code/runner.test.mjs
```

Expected: all Claude runner unit tests pass.

### Task 2: Prove Claude Code/Kimi compatibility cheaply

**Files:**
- Create at runtime: `evaluation/harnesses/claude-code/runs/<timestamp>/`
- Modify: `evaluation/harnesses/claude-code/runner.mjs`

- [x] **Step 1: Retrieve only the dedicated Claude evaluation key**

Read macOS Keychain service `operator-harness-eval-openrouter-claude` without printing the secret. Record a redacted before-key usage snapshot.

- [x] **Step 2: Launch a safe-mode compatibility session**

Use:

```text
claude --print --verbose --output-format stream-json
       --safe-mode --no-chrome --strict-mcp-config
       --mcp-config {"mcpServers":{}}
       --dangerously-skip-permissions
       --model moonshotai/kimi-k3
```

Run inside a disposable fixture. Do not supply `--fallback-model`.

- [x] **Step 3: Require deterministic tool use**

Prompt Claude Code/Kimi to read a fixture file and use Bash to compute its SHA-256, then report both its exact content and hash. Require correct tool use and final answer.

- [x] **Step 4: Reconcile model identity and cost**

Use streamed request/generation identifiers when exposed. Otherwise, use the dedicated-key before/after delta and retain that limitation explicitly. Require every authoritative generation to resolve to exact or dated Kimi K3 and reject OpenAI, Anthropic, aliases, or fallback suffixes.

- [ ] **Step 5: Stop before the scored run on incompatibility**

If tool calls, tool results, model identity, event parsing, or per-run attribution fail, preserve the artifacts and report Claude Code/Kimi as incompatible. Do not rescue the run by changing models or enabling a fallback.

This gate was not satisfied: the coding run started before interrupt/resume
checks and complete attribution passed. The run is retained as provisional,
unscored evidence.

### Task 3: Run the identical clean Operator task once

**Files:**
- Create: `evaluation/harnesses/claude-code/real-task-runner.test.mjs`
- Create: `evaluation/harnesses/claude-code/real-task-runner.mjs`
- Reuse: `evaluation/harnesses/prime-agent/real-tasks/transcript-timestamps/task.json`
- Create at runtime: `evaluation/harnesses/claude-code/real-tasks/transcript-timestamps/runs/<timestamp>/`

- [x] **Step 1: Write failing tests for immutable-test, scope, and failure attribution**

Require:

- the regression-test SHA-256 is unchanged;
- the target repository has exactly one generic commit and no parent;
- only the three allowed production files may change;
- the Claude process is stopped before final attribution;
- a paid failure still records usage and cost.

- [x] **Step 2: Run the focused evaluator tests and verify RED**

Run:

```bash
node --test evaluation/harnesses/claude-code/runner.test.mjs evaluation/harnesses/claude-code/real-task-runner.test.mjs
```

Expected: real-task tests fail because the evaluator is incomplete.

- [x] **Step 3: Implement the clean fixture and evaluator**

Build the same standalone archive snapshot used for Prime:

- source commit `8da7e84`;
- reverse the historical production patch;
- keep `tests/transcriptTimestamps.test.ts` unchanged;
- create one generic initial commit with no parent;
- require the focused baseline to fail;
- run one uninterrupted Claude Code/Kimi session with the exact existing prompt.

- [x] **Step 4: Capture and verify the result**

Persist:

- streamed JSON events and stderr;
- final response;
- agent patch and changed files;
- focused test, full suite, and `tsc --noEmit`;
- wall time, model calls, tool calls, tool errors, tokens, and exact cost;
- OpenRouter before/after snapshots and generation metadata;
- Claude Code version and session ID.

- [x] **Step 5: Run focused evaluator tests and verify GREEN**

Run the Node tests again and require all to pass.

- [x] **Step 6: Execute exactly one scored coding run**

Do not steer, rescue, follow up, purchase credits, or invoke another model. Stop on substitution, low balance, runaway execution, or timeout.

### Task 4: Compare harness capabilities and report

**Files:**
- Create: `claude-code-kimi-k3-real-operator-task-2026-08-10.html`
- Create: `kimi-k3-prime-vs-claude-code-comparison-2026-08-10.html`
- Modify: `docs/superpowers/specs/2026-08-09-kimi-k3-harness-evaluation-design.md`

- [x] **Step 1: Apply the same objective score**

Use the Prime rubric unchanged: correctness 40, tools 20, autonomy 15, efficiency 15, closure 10.

- [x] **Step 2: Compare observed harness behavior**

Contrast:

- editing and search tools;
- shell execution and error recovery;
- persistent executable state;
- context reuse and cache behavior;
- planning/task tracking;
- interruption and session resume;
- subagents;
- built-in verification discipline;
- output closure;
- time, calls, tokens, and cost.

Distinguish documented capability from behavior actually observed in the run.

- [x] **Step 3: Produce Geo-facing HTML**

Create a standalone Claude report and a side-by-side Prime-versus-Claude HTML report, linking raw evidence and stating limitations. Do not claim that one task proves production superiority.

- [x] **Step 4: Verify before completion**

Run:

```bash
node --test \
  evaluation/harnesses/prime-agent/compatibility-runner.test.mjs \
  evaluation/harnesses/prime-agent/real-task-runner.test.mjs \
  evaluation/harnesses/claude-code/runner.test.mjs \
  evaluation/harnesses/claude-code/real-task-runner.test.mjs
git diff --check -- ':!evaluation/**/runs/**/*.patch'
```

Then verify:

- no Claude Code or Prime process remains;
- all artifacts are secret-scanned;
- every OpenRouter generation is Kimi K3;
- the dedicated Claude key’s cost delta reconciles;
- no credits were purchased.

- [x] **Step 5: Commit only evaluation artifacts**

Commit on `eval/kimi-prime-20260809` and preserve the Prime evidence unchanged.
