# Prime Agent Kimi K3 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Prime Agent and run its controlled compatibility gates against only `moonshotai/kimi-k3`, producing attributable evidence before any scored benchmark task.

**Architecture:** Install the checksum-verified Prime Agent v0.7.1 stable release globally, but isolate all test configuration and sessions under a run-specific artifact directory. A small Node RPC runner retrieves the dedicated Prime key from macOS Keychain, exposes a one-model custom OpenRouter provider to Prime Agent, records JSONL events, and fails closed on any provider/model mismatch, missing usage, failed tool call, failed abort, or failed resume.

**Tech Stack:** Prime Agent JSONL RPC, Node.js 23 built-ins, OpenRouter Chat Completions and key metadata APIs, macOS Keychain, Node test runner, HTML evaluation report.

---

## File Structure

- `docs/superpowers/specs/2026-08-09-kimi-k3-harness-evaluation-design.md` — authoritative experiment policy, updated for the approved key isolation and OpenRouter restrictions.
- `evaluation/harnesses/prime-agent/compatibility-runner.mjs` — deterministic RPC orchestration, event capture, assertions, cost snapshotting, abort, and resume.
- `evaluation/harnesses/prime-agent/compatibility-runner.test.mjs` — parser and assertion tests using synthetic RPC events; no paid inference.
- `evaluation/harnesses/prime-agent/fixture/README.md` — harmless read-only fixture the model must inspect.
- `evaluation/harnesses/prime-agent/fixture/facts.txt` — deterministic content and continuity nonce.
- `evaluation/harnesses/prime-agent/runs/<timestamp>/` — sanitized run configuration, raw JSONL transcript, stderr log, summary JSON, and exported session HTML.
- `prime-agent-kimi-k3-compatibility-2026-08-09.html` — Geo-facing analysis deliverable.

### Task 1: Lock the approved safety and attribution policy

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-kimi-k3-harness-evaluation-design.md`

- [x] **Step 1: Replace stale key setup language**

Record that three 30-day dedicated inference keys already exist and that the Prime leg uses only the Prime key.

- [x] **Step 2: Add the hard OpenRouter allowlist**

State that OpenRouter requests are prohibited for all models except those Geo explicitly approves, that no OpenAI or Anthropic model may ever be used through OpenRouter, and that this evaluation approves only `moonshotai/kimi-k3`.

- [x] **Step 3: Review the spec diff**

Run:

```bash
git diff --check -- docs/superpowers/specs/2026-08-09-kimi-k3-harness-evaluation-design.md
git diff -- docs/superpowers/specs/2026-08-09-kimi-k3-harness-evaluation-design.md
```

Expected: no whitespace errors; only policy/setup text changes.

### Task 2: Install and verify Prime Agent

**Files:**
- No repository files changed.

- [x] **Step 1: Resolve the official stable manifest**

Run:

```bash
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json
```

Expected: stable version `v0.7.1` and SHA-256 `d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb`.

- [x] **Step 2: Run the inspected official installer**

Run the official installer non-interactively with IPython preparation enabled:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh |
  env PRIME_AGENT_INSTALLER_PLAIN=1 PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 sh
```

Expected: checksum verification succeeds and `prime-agent` is installed globally.

- [x] **Step 3: Verify the binary and runtime**

Run:

```bash
prime-agent --version
prime-agent doctor --json
```

Expected: version `0.7.1`; doctor reports a usable runtime or provides a repair command that can be run without model inference.

### Task 3: Build the deterministic fixture and RPC assertions with TDD

**Files:**
- Create: `evaluation/harnesses/prime-agent/fixture/README.md`
- Create: `evaluation/harnesses/prime-agent/fixture/facts.txt`
- Create: `evaluation/harnesses/prime-agent/compatibility-runner.test.mjs`
- Create: `evaluation/harnesses/prime-agent/compatibility-runner.mjs`

- [x] **Step 1: Create a harmless fixture**

`facts.txt` contains:

```text
HARNESS=prime-agent
CONTROL_MODEL=moonshotai/kimi-k3
CONTINUITY_NONCE=CEDAR-7391
VALUES=7,11,13
```

The README instructs the test subject not to modify the fixture.

- [x] **Step 2: Write failing parser and policy tests**

Tests must prove:

- the selected provider and model must exactly equal `operator-openrouter-kimi-only` and `moonshotai/kimi-k3`;
- assistant usage is accumulated without double-counting update events;
- a completed IPython call is recognized;
- missing usage, a tool error, or a different model fails the run;
- secrets matching an OpenRouter-key shape are redacted from persisted events.

Run:

```bash
node --test evaluation/harnesses/prime-agent/compatibility-runner.test.mjs
```

Expected: FAIL because `compatibility-runner.mjs` does not exist.

- [x] **Step 3: Implement the minimal reusable RPC runner**

The runner must:

- retrieve `operator-harness-eval-openrouter-prime` from Keychain without printing it;
- write an isolated `models.json` containing one custom provider and one model, with `apiKey` resolved from `OPENROUTER_API_KEY`;
- write isolated settings with telemetry and auto-refinement disabled;
- spawn Prime Agent with `--mode rpc`, `--offline`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-context-files`, and the exact custom provider/model;
- parse strict LF-delimited JSONL;
- capture stdout events and stderr without secrets;
- expose commands for prompt, abort, state, stats, export, and resume;
- enforce timeouts and terminate the process tree on failure;
- query the dedicated OpenRouter key counter before and after the run;
- never purchase credits or invoke another model.

- [x] **Step 4: Run the tests until green**

Run:

```bash
node --test evaluation/harnesses/prime-agent/compatibility-runner.test.mjs
```

Expected: all tests pass.

### Task 4: Run Prime Agent compatibility gates sequentially

**Files:**
- Create: `evaluation/harnesses/prime-agent/runs/<timestamp>/models.json`
- Create: `evaluation/harnesses/prime-agent/runs/<timestamp>/settings.json`
- Create: `evaluation/harnesses/prime-agent/runs/<timestamp>/events.jsonl`
- Create: `evaluation/harnesses/prime-agent/runs/<timestamp>/stderr.log`
- Create: `evaluation/harnesses/prime-agent/runs/<timestamp>/summary.json`
- Create: `evaluation/harnesses/prime-agent/runs/<timestamp>/session.html`

- [x] **Step 1: Snapshot the dedicated key**

Query `/api/v1/key` with the dedicated Prime key and record usage/limit metadata, never the key itself.

- [x] **Step 2: Gate model identity and deterministic response**

Prompt:

```text
Compatibility gate 1. Reply with exactly PRIME-KIMI-OK and nothing else.
```

Require the RPC model object and final assistant message to identify the exact custom provider and `moonshotai/kimi-k3`; reject any fallback.

- [x] **Step 3: Gate read-only and structured tool use**

Prompt:

```text
Compatibility gate 2. This fixture is read-only: do not modify any file. Use your built-in Python/IPython tool to list this directory, read facts.txt, calculate the sum of VALUES, and calculate the SHA-256 of facts.txt. Reply with exactly four lines: HARNESS, CONTROL_MODEL, VALUES_SUM, SHA256.
```

Require at least one successful IPython tool call, `VALUES_SUM=31`, the exact file hash, and a clean fixture diff.

- [x] **Step 4: Gate stop behavior**

Prompt:

```text
Compatibility gate 3. Use the Python/IPython tool to run time.sleep(30), then reply SLEEP-FINISHED.
```

Send RPC `abort` after `tool_execution_start`; require an accepted abort, an aborted/error terminal event, no `SLEEP-FINISHED`, and an idle reusable RPC process.

- [x] **Step 5: Gate resume behavior**

Close the first RPC process, relaunch with the saved session, and prompt:

```text
Compatibility gate 4. Without rereading facts.txt, reply with exactly CONTINUITY_NONCE=<the nonce you saw earlier>.
```

Require `CONTINUITY_NONCE=CEDAR-7391`, the same persisted session identity, and the exact Kimi model.

- [x] **Step 6: Capture usage and cost**

Request Prime session stats, export the session HTML, query the OpenRouter key counter again, and record the before/after spend delta plus harness-reported tokens, model calls, tool calls, errors, and wall time.

Stop immediately on a 402, unknown model, model substitution, missing usage, or low-credit condition. Do not purchase credits.

### Task 5: Verify and report the Prime result

**Files:**
- Create: `prime-agent-kimi-k3-compatibility-2026-08-09.html`

- [x] **Step 1: Run offline verification**

Run:

```bash
node --test evaluation/harnesses/prime-agent/compatibility-runner.test.mjs
git diff --check
git status --short
```

Expected: tests pass, no whitespace errors, and only evaluation/spec/report files are changed.

- [x] **Step 2: Validate the recorded evidence**

Check:

- exact provider/model identity on every assistant message;
- no OpenAI or Anthropic provider/model appears in the run transcript;
- no API-key pattern appears in any artifact;
- fixture files are unchanged;
- usage and cost reconcile between Prime and OpenRouter;
- Prime processes are shut down after evidence capture.

- [x] **Step 3: Write the HTML analysis**

The report must lead with pass/fail, show each compatibility gate, tokens, cost, wall time, tool/abort/resume evidence, errors, limitations, and the decision whether Prime Agent may proceed to scored Task 1.

- [x] **Step 4: Commit only evaluation files**

Run:

```bash
git add \
  docs/superpowers/specs/2026-08-09-kimi-k3-harness-evaluation-design.md \
  docs/superpowers/plans/2026-08-09-prime-agent-kimi-k3-compatibility.md \
  evaluation/harnesses/prime-agent \
  prime-agent-kimi-k3-compatibility-2026-08-09.html
git commit -m "test: run Prime Agent Kimi K3 compatibility gates"
```

Expected: one focused commit with no unrelated files.
