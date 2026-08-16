# HANDOFF — Cross-harness testing waves 1–4

Last updated: 2026-08-13

Project root: `/Users/geo/Claude Projects/operator`

Operator branch/HEAD when prepared: `main` at `d21e8c5`

LiteLLM project: `/Users/geo/Claude Projects/LiteLLM server`

LiteLLM branch/HEAD when prepared: `main` at `2330000`

The completed Prime-integration handoff was archived unchanged as
`HANDOFF.old3.md`. Earlier history remains in `HANDOFF.old1.md` and
`HANDOFF.old2.md`.

## Start here

1. Read this file completely.
2. Read `AGENTS.md` if present, then `CLAUDE.md`.
3. Read the current Geo-facing recommendation:
   `kimi-code-and-cross-harness-recommendation-2026-08-13.html`.
4. Read the admission architecture:
   `docs/superpowers/specs/2026-08-10-harness-model-admission-design.html`.
5. Read the existing evidence:
   - `deepseek-pro-brain-diagnosis-2026-08-13.html`
   - `operator-litellm-production-repair-2026-08-07.html`
   - `docs/evaluations/2026-08-10-prime-kimi-acceptance.json`
6. Before editing either repository, run `git status --short`. Preserve all
   unrelated dirty and untracked files. Never use `git add .`.

## Geo’s requested outcome

Execute these four waves:

1. **Claude Code compatibility** — test Kimi K3 and DeepSeek V4 Pro through the
   existing Claude Code/LiteLLM adapter.
2. **Kimi Code pilot** — add Kimi Code as a fourth public harness, then test
   Kimi K3 and DeepSeek V4 Pro through it.
3. **Prime expansion** — test DeepSeek V4 Pro through Prime Agent and expose it
   there only if it passes.
4. **Same-task Kimi K3 bake-off** — compare Kimi K3 through Claude Code, Codex,
   Prime Agent, and Kimi Code, then recommend a default without removing other
   passing choices.

The product rule is permissive after proof: a model should appear under every
harness-model pairing that passes, regardless of vendor. LiteLLM remains hidden
routing infrastructure, not a user-facing harness.

## Current truth

- Live Operator runs on port 3000; LiteLLM runs on loopback port 4000.
- `operator.deepseek-v4-pro` is live under the Codex harness.
- `operator.kimi-k3` is live under Codex and Prime.
- Kimi K3 + Prime has the only dedicated immutable acceptance artifact:
  fresh turn, repository edit, resume, abort, process settlement, exact alias,
  provider reconciliation, and $0.0253008 provider cost all passed.
- Kimi K3, Kimi K2.7 Code, and DeepSeek V4 Pro previously completed real Codex
  turns, but those reports predate the structured admission-record format.
- `lib/agents/litellm-claude/driver.ts` already implements the hidden
  Claude Code/LiteLLM route with isolated task configuration and a disposable
  relay credential.
- No live model is currently tagged for the `claude` harness. There is no live
  Claude Code acceptance artifact for Kimi or DeepSeek.
- Kimi Code is not installed or integrated in this repository.
- `scripts/vet-litellm-model.ts` does not exist. Build the reusable admission
  runner before duplicating one-off paid tests.
- Moonshot explicitly recommends Kimi Code for Kimi K3. Kimi Code also supports
  OpenAI-compatible reasoning providers such as DeepSeek.
- Anthropic explicitly does not support non-Claude models in Claude Code.
  Claude pairings are valuable experiments, not vendor-supported production
  combinations, and must be rechecked after material Claude Code upgrades.

## Admission contract for every pairing

A basic answer is not a pass. Each exact model alias + harness version must prove:

1. **Identity** — requested alias and resolved physical model match; no fallback
   or substitution.
2. **Basic turn** — coherent streamed result through the exact harness transport.
3. **Tool loop** — list/read, edit, and harmless command tools use valid schemas
   and paired results.
4. **Operator bridge** — at least one scoped Operator MCP/extension tool works;
   include an interactive ask if that harness claims ask support.
5. **Repository result** — a disposable fixture gets the exact expected edit and
   its tests pass.
6. **Resume** — a second turn resumes the same harness session and recalls a
   planted fact.
7. **Stop** — interrupt settles the turn and leaves no busy task or child process.
8. **Usage** — tokens and trusted metered cost are recorded, or absence is
   explicitly marked incomplete; never treat missing cost as free.
9. **Isolation** — task state and credentials do not leak across harnesses/tasks.

Write one sanitized JSON artifact per pairing under `docs/evaluations/`.
Artifacts must include alias, resolved model, harness/version, test revision,
timestamp, individual gate results, session-ID hash, usage/cost reconciliation,
and process settlement. Never include prompts containing private data, provider
keys, relay tokens, local credentials, or raw private repository content.

## Wave 0 — preflight and reusable admission runner

Do this before Wave 1:

- Inspect the current dirty diff before changing catalog semantics. Several
  uncommitted files implement legacy `operator.harnesses` compatibility and an
  `unvetted` label. Treat those edits as user-owned in-progress work.
- Use strict TDD to create a reusable opt-in live admission runner or test
  harness. Start from `tests/primeAcceptance.live.test.ts`, but make the gates
  and evidence reducer harness-neutral.
- Keep paid live tests opt-in through explicit environment flags.
- Use disposable fixture repositories/worktrees only.
- Make every run fail closed on identity ambiguity, malformed tool events,
  incomplete repository results, or surviving processes.
- Run local fake-transport tests before any paid inference.
- Check provider balance read-only before paid runs. Do not purchase credits.
- Do not print or copy credentials. Provider keys stay in LiteLLM; harness
  children receive only Operator’s disposable loopback relay credential.

## Wave 1 — Claude Code compatibility

Pairings:

- `operator.kimi-k3` × `claude`
- `operator.deepseek-v4-pro` × `claude`

Implementation facts:

- Reuse `litellm-claude`; do not create another Claude driver.
- Reuse `runClaudeTurn()` and the current task-local `CLAUDE_CONFIG_DIR`.
- Keep all native Claude subscription state and credentials isolated and
  untouched.
- Pin all Claude background/subagent model variables to the selected exact alias.
- Test the LiteLLM Anthropic Messages translation, not merely direct OpenRouter.

Extra Claude gates:

- tool calls and tool results survive Anthropic-format translation;
- thinking/reasoning blocks do not poison the next tool step;
- background/small-model calls do not silently request a native Claude alias;
- streaming JSON maps cleanly into Operator events;
- resume and `/clear`-generation behavior remain correct;
- current Claude CLI version is recorded in the artifact.

Do not tag either model `claude` until all required gates pass. A failure should
record a failed admission and leave the existing Codex/Prime choices unchanged.

## Wave 2 — Kimi Code pilot

Pairings:

- `operator.kimi-k3` × `kimi-code`
- `operator.deepseek-v4-pro` × `kimi-code`

Architecture:

- Public harness label: **Kimi Code**
- Hidden driver ID: `litellm-kimi-code`
- New catalog harness value: `kimi-code`
- Prefer Moonshot’s official TypeScript package
  `@moonshot-ai/kimi-agent-sdk`; do not scrape TUI output.
- Pin the exact SDK/CLI version and package the matching executable in Docker.
- Add a task-local state root such as `LITELLM_KIMI_CODE_HOME`; never share the
  user’s global Kimi configuration or sessions.
- Use Kimi Code’s non-persisted model/provider override path or an equally
  secret-safe configuration. Do not write the real LiteLLM/OpenRouter key to a
  Kimi config file.
- Route inference through the existing loopback relay.
- Reuse the existing Operator MCP bridge for asks, suggested tasks, services,
  artifacts, workstream updates, and card changes.
- Normalize SDK text/thinking/tool/subagent/usage/approval/interrupt events into
  Operator’s existing `StreamEvent` contract.
- Keep the driver registered when unavailable so existing Kimi Code tasks fail
  actionably and never fall back to another harness.

Permission boundary:

- Do not call Kimi Code Plan mode a sandbox. Its Bash tool still follows
  permission rules.
- Before exposing Plan/Auto-run choices, test writes, Bash, network, subagents,
  hooks, approvals, and stop behavior.
- Start with only the permission modes whose behavior Operator can state
  honestly.

Use brainstorming, a written implementation plan, TDD, and independent review
before integrating this new driver.

## Wave 3 — DeepSeek through Prime

Pairing:

- `operator.deepseek-v4-pro` × `prime`

Requirements:

- Parameterize the existing Prime acceptance path; do not clone it.
- Preserve Prime’s disposable relay credential and task-local state.
- Preserve Auto-run-only UI unless external containment has been proven.
- Reconcile the exact physical DeepSeek identity and provider cost through
  trusted LiteLLM/OpenRouter records if Prime cannot report it in-stream.
- Prove no Prime worker, IPython kernel, subagent, or ZeroMQ process survives
  stop, timeout, deletion, or shutdown.
- Generalize the LiteLLM gateway test
  `test_kimi_k3_is_the_only_prime_approved_route` only after DeepSeek passes.
  Preserve the no-fallback and no-OpenAI/Anthropic-through-OpenRouter rules.

If DeepSeek fails Prime admission, keep it available under every other harness
it passes. Do not patch Prime until it resembles another harness merely to force
a pass.

## Wave 4 — controlled Kimi K3 bake-off

Harnesses:

- Claude Code
- Codex
- Prime Agent
- Kimi Code

Controls:

- exact alias `operator.kimi-k3`;
- same fallback-free LiteLLM/OpenRouter route;
- same repository snapshot copied into fresh disposable worktrees;
- same prompt, attachments, network access, and objective acceptance tests;
- closest equivalent high/max reasoning setting;
- closest equivalent autonomous workspace-write permission;
- fresh session with isolated harness state;
- no user/global custom skills, prompts, memory, or MCP beyond the explicit
  Operator test fixture.

Use one bounded debugging/implementation fixture with objective tests. Score in
this order:

1. correct repository result and passing tests;
2. tool-call validity and recovery from one seeded failure;
3. resume and stop reliability;
4. wall-clock time;
5. input/output/cache tokens and trusted provider cost;
6. number of tool/model steps and unnecessary churn;
7. qualitative workflow clarity.

Do not declare a winner from one stochastic anomaly. Repeat only a close,
failed-but-recoverable, or suspicious result. The final recommendation may name
one default while retaining every passing harness option.

Publish the final analysis as an HTML report for Geo.

## Gateway metadata warning

The current gateway uses legacy `operator.harnesses` declarations. Operator’s
dirty catalog work treats those as selectable but labels them unvetted.

Once `operator.admissions` is present, it is authoritative. Therefore:

- do not add only the newest passing harness to an admissions array;
- omitted harnesses will disappear even if they remain in `harnesses`;
- standardize evidence for every pairing that should remain selectable before
  converting a model from legacy declarations to admission records;
- failed records must remove only that exact harness-model pairing;
- validate and safely reload LiteLLM before refreshing Operator;
- verify the final live `/api/agents` matrix after every metadata change.

## Safety and scope

- No fallback models.
- Never route an OpenAI or Anthropic model through OpenRouter.
- Do not alter native Claude or Codex subscription login paths.
- Do not purchase credits.
- Use only the minimum paid calls necessary for the gates and controlled repeat.
- Stop after a reproducible incompatibility; report it instead of stacking
  speculative fixes.
- Do not restart or reload LiteLLM until its tests and validation pass.
- Do not commit, push, or open a PR unless Geo explicitly asks.

## Dirty worktrees to preserve

Operator already has user/session-owned changes, including:

- modified catalog compatibility work in
  `lib/agents/litellm/{catalog.ts,catalog-store.ts,capabilities.ts,types.ts}`;
- modified `lib/agents/litellm-claude/driver.ts`,
  `lib/agents/prime/driver.ts`, and related tests;
- modified `lib/workstreams/client.ts` unrelated to this testing mission;
- numerous untracked root HTML reports and `.superpowers/`;
- the two August 13 research reports;
- this handoff set and `HANDOFF.old3.md`.

LiteLLM server already has user-owned changes:

- `config/litellm.yaml`
- `inventory/llm-call-sites.yaml`
- `tests/gateway/test_config.py`
- untracked `tasks/`

Inspect and preserve all of them. Never discard, reset, overwrite, or bulk-stage
unrelated work.

## Verification before completion

For each wave:

- focused unit/contract tests pass;
- opt-in live artifact exists for every attempted pairing;
- failed pairings remain unavailable only under the failed harness;
- no credential material appears in artifacts or diffs;
- no child processes survive;
- live Operator returns the expected harness/model matrix.

Before final completion:

- `npm run verify` passes in Operator;
- LiteLLM config validation and its relevant offline suite pass;
- pinned Docker build and harness packaging smoke tests pass;
- native Claude and Codex subscription paths are rechecked;
- an independent code review has no unresolved Critical or Important findings;
- the HTML bake-off report clearly separates measured results from inference.

## Canonical file pointers

- Shared catalog: `lib/agents/litellm/`
- Claude managed adapter: `lib/agents/litellm-claude/driver.ts`
- Codex managed adapter: `lib/agents/litellm/driver.ts`
- Prime driver: `lib/agents/prime/`
- Driver registry: `lib/agents/registry.ts`
- Public harness merge: `app/api/agents/route.ts`
- Client routing helpers: `app/orchestrator/agents.ts`,
  `app/orchestrator/launchConfig.ts`
- Existing Prime live test: `tests/primeAcceptance.live.test.ts`
- Operator relay: `lib/agents/litellm/relay.ts`
- LiteLLM config:
  `/Users/geo/Claude Projects/LiteLLM server/config/litellm.yaml`
