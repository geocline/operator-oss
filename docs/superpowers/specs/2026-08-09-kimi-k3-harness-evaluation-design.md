# Kimi K3 Harness Evaluation Design

**Date:** 2026-08-09  
**Status:** Approved direction; pending Geo's review of this written specification  
**Model under test:** `operator.kimi-k3` → `openrouter/moonshotai/kimi-k3`

## Objective

Evaluate Prime Agent, Codex, and Claude Code as agent harnesses while holding the
underlying model constant. The experiment must determine whether Prime Agent
adds enough quality, efficiency, persistence, or self-improvement to justify an
Operator integration.

The model is not being benchmarked against other models. Every scored run uses
the same Kimi K3 deployment through the same local LiteLLM gateway and dedicated
OpenRouter billing route.

## Validated Premises

### Kimi K3

The local gateway exposes `operator.kimi-k3` as
`openrouter/moonshotai/kimi-k3`. The public Kimi and OpenRouter catalogs describe
it as:

- 1,048,576-token context;
- always-on reasoning;
- text and image input;
- tool calling;
- long-horizon coding and knowledge-work support.

OpenRouter's catalog currently lists Kimi K3 at $3 per million prompt tokens,
$15 per million completion tokens, and $0.30 per million cached-input tokens.

### Claude Code

Claude Code CLI 2.1.220 supports:

- `ANTHROPIC_BASE_URL` and gateway bearer/API-key credentials;
- arbitrary `--model` values;
- gateway model discovery with
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`;
- non-interactive streaming JSON output;
- tool, model, usage, session, and completion events.

Anthropic documents gateways with custom model names, but explicitly does not
support routing Claude Code to non-Claude models. Kimi K3 through Claude Code is
therefore a valid experimental configuration, not a supported production
combination. A read-only tool-call preflight must pass before it enters the
scored comparison.

### Prime Agent

Prime Agent is not installed on this machine. Its public beta supports a custom
OpenAI-compatible provider, arbitrary model definitions, JSONL RPC, streamed
tool events, session resume, abort, compaction, recursive agents, and continual
harness refinement.

### OpenRouter access

The machine has a working dedicated Operator inference key. Read-only account
checks succeeded without exposing the key.

Snapshot observed on 2026-08-09:

- total credits purchased: $155;
- total account usage: $141.821137552;
- approximate remaining credits: $13.178862448;
- Operator-key usage this month: $2.323087992;
- Operator-key usage today at observation time: $0.

The ordinary inference key can read its own usage but cannot create additional
keys. Creating per-harness keys would require a separate OpenRouter Management
API key or an explicitly authorized dashboard action.

## Approaches Considered

### 1. Quick smoke comparison

Run three tasks once through each harness.

This is cheap and fast, but one bad stochastic run could determine the result.
It is useful only as a compatibility check.

### 2. Fixed full benchmark

Run five tasks twice through all three harnesses.

This produces stronger evidence but spends budget on obvious failures and may
exhaust the current OpenRouter balance before longitudinal behavior is tested.

### 3. Adaptive paired evaluation — selected

Run compatibility gates first, then one matched pass across five tasks. Repeat
only close, anomalous, or failed-but-recoverable cases. Reserve the final phase
for a longitudinal Prime Agent refinement test.

This gives the best evidence per dollar and makes failed compatibility visible
before expensive tasks begin.

## Experimental Controls

Every cold-comparison run uses:

- the exact `operator.kimi-k3` model alias;
- the same LiteLLM gateway;
- the same prompt text and attachments;
- the same repository snapshot copied into a fresh disposable worktree;
- the same network availability;
- the closest equivalent high reasoning setting;
- the closest equivalent autonomous workspace-write permission;
- a fresh session with no prior conversation;
- isolated harness configuration, memory, skill, and session directories;
- no pre-existing user or project customization beyond the test fixture's
  explicit instructions;
- no fallback model.

Harness-native system prompts, context management, tools, and recovery policies
remain enabled because those are the variables being evaluated.

Prime Agent auto-refinement is disabled during the cold comparison. Its
longitudinal refinement phase is scored separately.

## Compatibility Gates

No scored task runs until each harness passes:

1. model identity: response resolves to Kimi K3 with no fallback;
2. basic response: answer a deterministic short prompt;
3. read-only tool use: list and read a fixture file;
4. structured tool use: call a harmless deterministic tool and consume the
   result;
5. usage visibility: emit or otherwise expose prompt and completion usage;
6. stop behavior: interrupt an active request without leaving the harness busy;
7. resume behavior: continue the same session and reference a prior fact.

Claude Code additionally must prove that LiteLLM's Anthropic-format translation
preserves tool calls and tool results for Kimi K3. If it fails, it is reported
as incompatible rather than patched until it resembles another harness.

## Task Suite

### Task 1: Repository orientation

Inspect a small unfamiliar repository and produce an evidence-backed architecture
brief with file references.

Objective checks:

- cited paths exist;
- claimed components are present;
- no files are changed;
- required architecture questions are answered.

### Task 2: Seeded bug diagnosis and repair

Find and fix a behavioral bug with a failing regression test.

Objective checks:

- original failure reproduced;
- targeted test passes;
- full suite passes;
- no unrelated changes;
- diagnosis names the actual cause.

### Task 3: Bounded feature implementation

Implement a small feature from a realistic but precise specification.

Objective checks:

- acceptance tests pass;
- public behavior matches the specification;
- existing behavior remains intact;
- diff remains within scope.

### Task 4: Tool-driven research and synthesis

Answer a source-based question using the harness's available research tools and
produce a concise cited recommendation.

Objective checks:

- sources support the claims;
- sources are primary where required;
- citations resolve;
- unsupported claims are absent;
- the result closes the requested decision.

### Task 5: Multi-turn continuity and recovery

Start a task, introduce a correction or new constraint midstream, interrupt it,
resume, and finish.

Objective checks:

- the correction is honored;
- completed work is not unnecessarily repeated;
- session state survives resume;
- final tests pass;
- no stale assumption remains in the answer.

## Longitudinal Prime Agent Phase

After the cold comparison, run a short sequence in one Prime Agent session:

1. complete an initial task;
2. expose a repeated mistake or inefficient behavior;
3. run local continual-harness refinement;
4. inspect and save the proposed harness-state diff;
5. run a matched follow-up task;
6. compare behavior before and after refinement;
7. test rollback.

The refinement passes only if it produces a specific, reviewable change that
improves the follow-up without causing a regression. Merely creating memory or
using more tokens is not improvement.

## Measurement and Cost Attribution

### Authoritative inference metrics

OpenRouter usage is authoritative for billable inference:

- prompt tokens;
- completion tokens;
- reasoning tokens;
- cached tokens and cache writes when present;
- total tokens;
- exact charged cost;
- upstream inference cost when present;
- model and provider identity;
- generation ID;
- latency.

OpenRouter returns usage automatically in completed and final streaming
responses. It also exposes generation metadata by generation ID.

### Harness metrics

Record separately:

- wall-clock duration;
- number of model requests;
- number and type of tool calls;
- tool failures and retries;
- context compactions;
- child agents or subagents created;
- user interventions;
- files read and changed;
- diff size;
- test commands and outcomes;
- stop and resume behavior;
- final harness-reported usage.

Harness-reported usage is diagnostic. It is not substituted for OpenRouter's
billable numbers when the two disagree.

### Per-run attribution

Runs execute sequentially. Before and after every run, record the dedicated
Operator key's usage counter. During the run, capture usage objects and
generation IDs from the harness/gateway response path.

If unrelated traffic changes the key counter or a harness hides required
generation usage, pause the evaluation. The preferred recovery is three
temporary OpenRouter keys—one each for Prime Agent, Codex, and Claude
Code—created only after explicit authorization. A custom metering proxy is not
part of the initial design.

### Spend policy

There is no arbitrary $20 benchmark cutoff. The runner reports cumulative spend
after every task and stops before the OpenRouter balance is exhausted.

Because the observed balance is about $13.18, the evaluation cannot spend more
without new credits. No credit purchase is implied by this specification.

## Scoring

Each task receives 100 points:

- 40: objective correctness and acceptance tests;
- 20: tool selection and execution reliability;
- 15: autonomy, recovery, and persistence;
- 15: efficiency, including tokens, cost, time, and unnecessary work;
- 10: communication and task closure.

Objective tests and repository checks are scored first. Qualitative outputs are
blinded as A/B/C before review. Harness identity is revealed only after scores
and notes are locked.

Any model fallback, silent task omission, fabricated success claim, or
unrecoverable workspace corruption is a scored failure.

## Reporting

The final HTML report includes:

- compatibility matrix;
- task-by-task outcome table;
- prompt, completion, reasoning, cached, and total tokens;
- exact cost and wall time;
- model-call and tool-call counts;
- test pass/fail evidence;
- intervention and recovery notes;
- blinded qualitative scores;
- transcripts, diffs, and artifacts;
- cold-comparison ranking;
- Prime Agent before/after-refinement result;
- recommendation: reject, revisit, Labs integration, or production candidate.

## Error Handling

- Unknown or substituted model: stop that harness immediately.
- Claude Code protocol incompatibility: record it; do not alter the model or
  prompt to rescue the score.
- Missing usage: stop before the next scored run and repair instrumentation.
- OpenRouter 402 or low balance: stop; do not purchase credits automatically.
- Tool loop or runaway output: interrupt, record the failure, and preserve logs.
- Dirty or corrupted fixture: discard only that disposable copy and recreate it
  from the pinned source.
- Concurrent key usage: stop attribution and use isolated keys or rerun.

## Out of Scope

- Integrating Prime Agent into Operator.
- Implementing Operator's `litellm-claude` driver.
- Comparing Kimi K3 with DeepSeek, MiniMax, GLM, or another model.
- Changing production model aliases.
- Enabling Prime Agent global refinement.
- Purchasing OpenRouter credits.
- Automatically creating, rotating, or deleting OpenRouter keys.

## Acceptance Criteria

The evaluation is complete when:

1. all three harnesses either pass the compatibility gate or have a documented
   reproducible incompatibility;
2. every compatible harness runs the same scored task set under the controls;
3. every scored run has attributable tokens, cost, time, transcript, and
   outcome evidence;
4. close or anomalous results receive a repeat while credits permit;
5. Prime Agent's longitudinal refinement is tested if Prime passes compatibility;
6. the final HTML report distinguishes model behavior from harness behavior and
   makes a supported Operator integration recommendation.

## Sources

- Anthropic, [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)
- Anthropic, [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)
- OpenRouter, [Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- OpenRouter, [Generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
- OpenRouter, [Current API-key metadata](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
- Moonshot AI, [Kimi Code configuration](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)
- Prime Intellect, [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)

