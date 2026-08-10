# HANDOFF — Prime Agent integration

Last updated: 2026-08-10

Project root: `/Users/geo/Claude Projects/operator`

Branch/HEAD when prepared: `main` at `71dabb4`

## Start here

1. Read this file completely.
2. Read `AGENTS.md` if present, then read `CLAUDE.md`.
3. Read the canonical Prime integration design:
   `docs/superpowers/specs/2026-08-10-prime-agent-operator-integration-design.md`.
4. Execute the plan:
   `docs/superpowers/plans/2026-08-10-prime-agent-operator-integration.md`.
5. Review the Geo-facing research summary:
   `prime-agent-operator-integration-research-2026-08-10.html`.
6. Before editing, run `git status --short`. Do not revert, delete, overwrite,
   stage, or commit unrelated dirty/untracked files. Do not use `git add .`.

The superseded task-save handoff is preserved at `HANDOFF.old2.md`. The earlier
historical handoff remains at `HANDOFF.old1.md`.

## Decision

Geo approved adding Prime Agent to Operator as the preferred harness option for
approved Kimi models.

Implement a new concrete driver:

- Driver ID: `litellm-prime`
- User label: `Prime Agent`
- Initial model alias: `operator.kimi-k3`
- Billing route: Operator → loopback relay → LiteLLM → approved Kimi provider

This is additive:

- native Claude Code remains on the Anthropic subscription;
- native Codex remains on the OpenAI subscription;
- `litellm-codex` remains available;
- Claude remains Operator's default agent unless Geo changes it later;
- existing tasks and projects must not be retargeted.

Hard policy: OpenRouter may run only models Geo explicitly approves. Never route
an OpenAI or Anthropic model through OpenRouter. Never configure a fallback.

## Current state — IMPLEMENTED 2026-08-10

The integration is implemented, verified, and live-acceptance tested. Commits
(main): 9dfd686, 632ce5b, 0aa2c0e, 50396bc, 446d6a0, 7662714, ddcc5b7,
15a020f, b6e0e29, 4fa3064, b3b804e, 7a4061b, c4417b2, e43b512 (plus the
LiteLLM server repo commit 2330000 tagging `operator.kimi-k3` with `prime`).

Validation evidence:

- Focused suites (catalog, policy, RPC, events, tools, driver, UI, cleanup,
  agent switch, packaging) pass; `npm run verify` passes end to end.
- Docker: prime-agent 0.7.1 installed from the official GitHub release
  tarball, sha256-pinned; smoke test (`scripts/prime-docker-smoke.sh`) passes,
  including the orphan-process check.
- Live acceptance (`PRIME_ACCEPTANCE=1 npx vitest run
  tests/primeAcceptance.live.test.ts`) passed: fresh turn with a real
  workspace edit, one resume, one abort, no surviving prime/ipykernel
  processes. Sanitized artifact with provider-side reconciliation:
  `docs/evaluations/2026-08-10-prime-kimi-acceptance.json` — all four
  generations resolved to `moonshotai/kimi-k3-20260715`, total $0.0253.
- Native Claude (Max) and Codex (ChatGPT) subscription logins re-verified
  authenticated and untouched.

Two evidence-driven deviations from the original plan, both recorded in
commit messages: (1) prime-agent 0.7.1 cannot observe the physical model
through the credential-preserving relay, so the in-stream identity gate is
exact-alias + provider + no-fallback, `resolvedModel` validated only when
present, and physical identity is reconciled out-of-band (the alias→physical
binding is fallback-free and test-pinned in the LiteLLM repo); (2) the npm
wrapper re-execs the real binary into its own process group, so stop() kills
the full descendant tree (snapshot + group + pid, SIGTERM→SIGKILL), pinned by
a dedicated escaped-group regression test.

Prime cost is recorded as 0/unestimated in Operator (allowed by plan Task 6);
trusted attribution lives with LiteLLM/provider records.

Prime Agent 0.7.1 was separately evaluated with Kimi and passed the core
compatibility gates for exact model selection, tool execution, abort, resume,
usage, and cost attribution. The real-task run showed that Prime is viable, but
the new driver must independently enforce production policy and lifecycle rules.

The repository audit found:

- the existing `AgentDriver`, runner, abort owner, session persistence, usage
  store, and task switching are reusable;
- no database migration is needed;
- Prime should run as a pinned external CLI over JSONL RPC;
- Prime state must be isolated under
  `~/.operator/litellm-prime/<task-id>/`;
- the current LiteLLM catalog and credential relay should be reused;
- a Prime extension must expose all six Operator tools through the existing
  authenticated internal endpoints;
- the managed model-refresh UI is currently hardcoded to
  `litellm-codex` and must be generalized;
- Prime is not an OS sandbox, so the first release must expose Auto-run only.

## Exact next work

Start with Task 1 in
`docs/superpowers/plans/2026-08-10-prime-agent-operator-integration.md`.

Use strict TDD. Complete and verify each plan task before moving to the next.
Do not begin a paid Kimi acceptance run until all local tests, the full
`npm run verify` gate, and the Docker-free lifecycle tests pass.

Before editing the separate LiteLLM server repository in plan Task 10, inspect:

```text
/Users/geo/Claude Projects/LiteLLM server
```

Run its `git status --short` first and preserve unrelated work.

## Non-negotiable implementation rules

- Validate `operator.kimi-k3` before launch and the resolved physical Kimi model
  before successful completion.
- Provider credentials stay in LiteLLM. A Prime child receives only the
  loopback relay token.
- Keep the Prime driver registered when the CLI or model is unavailable so an
  existing Prime task fails actionably rather than falling back to Claude.
- Disable Prime telemetry, automatic refinement, and user/global Prime
  extensions, skills, and prompt templates initially.
- Keep built-in IPython, subagents, and repository context files available.
- Stop the full process tree before collecting final failure attribution.
- Prove no Prime daemon, worker, kernel, subagent, or ZeroMQ process survives
  abort, timeout, deletion, or shutdown.
- Do not expose Plan mode until an external OS/container restriction test proves
  that writes and network access are blocked.
- Do not purchase credits. If the approved provider balance is insufficient for
  final acceptance, stop and tell Geo.

## Validation required before completion

- Focused Prime catalog, policy, RPC, event, tools, driver, UI, cleanup, and
  agent-switch suites pass.
- `npm run verify` passes.
- Pinned Docker build and orphan-process smoke test pass.
- The LiteLLM Kimi alias has a `prime` harness tag and no fallback.
- One controlled real Kimi task completes, resumes once, and aborts once.
- Exact model identity, tokens, trusted cost, tool trace, and process settlement
  are recorded in a sanitized artifact.
- Native Claude and Codex subscription paths are rechecked.
- An independent review finds no unresolved Critical or Important issues.

## Known dirty/untracked files

This worktree already contains user/session-owned changes:

- `.superpowers/`
- `HANDOFF.old1.md`
- numerous root-level HTML reports
- this planning set:
  - `docs/superpowers/specs/2026-08-10-prime-agent-operator-integration-design.md`
  - `docs/superpowers/plans/2026-08-10-prime-agent-operator-integration.md`
  - `prime-agent-operator-integration-research-2026-08-10.html`
  - `HANDOFF.md`
  - `HANDOFF.old2.md`
  - `docs/NEXT-SESSION-PROMPT.md`

Do not delete or bulk-stage any of them. The planning and handoff files have not
been committed.
