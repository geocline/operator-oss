# Prime Agent Operator Integration Plan

> **For the implementing agent:** REQUIRED SUB-SKILL: use
> `superpowers:test-driven-development` for every behavior change and
> `superpowers:verification-before-completion` before claiming completion.
> Execute one task at a time; do not start paid smoke tests until all local and
> Docker-free tests pass.

**Goal:** Add `litellm-prime` as an additive Operator harness for the exact
approved Kimi alias while preserving native Claude and Codex subscription
behavior.

**Architecture:** Prime runs as a pinned external CLI over JSONL RPC. Its driver
reuses Operator's LiteLLM catalog and credential relay, but owns task-local Prime
state, event normalization, process-tree cleanup, and a Prime extension for
Operator tools. The existing runner, database session fields, task worktrees,
usage store, and generic agent UI remain the shared product seam.

**Canonical design:**
`docs/superpowers/specs/2026-08-10-prime-agent-operator-integration-design.md`

**Cross-repository dependency:** the Kimi route tag is configured in
`/Users/geo/Claude Projects/LiteLLM server/config/litellm.yaml`. Do not modify
that repository until its own `git status --short` is inspected and unrelated
changes are identified.

---

## Task 1: Extend the shared LiteLLM catalog for Prime

**Files:**

- Modify: `lib/agents/litellm/types.ts`
- Modify: `lib/agents/litellm/catalog.ts`
- Modify: `lib/agents/litellm/capabilities.ts`
- Modify: `lib/agents/litellm/session-index.ts`
- Modify: `tests/litellmCatalog.test.ts`
- Modify: `tests/litellmSessionIndex.test.ts`

- [ ] Add failing tests that accept `harnesses: ["prime"]` and
  `["codex", "prime"]`, reject unknown strings, sanitize provider details, and
  return different model lists for `codex` and `prime`.
- [ ] Change `LiteLLMHarness` to `"codex" | "claude" | "prime"` and update the
  parser's explicit allowlist and error to name all three accepted values.
- [ ] Refactor `liteLLMCapabilities(harness)` so model filtering is driven by the
  argument. Prime capabilities must expose Auto-run only, report metered rather
  than estimated cost, and initially set `supportsAsks` and `supportsMcpTools`
  to false.
- [ ] Extend session-index records to allow `harness: "prime"` without changing
  the on-disk JSONL format.
- [ ] Run:

  ```bash
  npx vitest run tests/litellmCatalog.test.ts tests/litellmSessionIndex.test.ts
  ```

  Expected: all focused tests pass.

- [ ] Commit only these paths with:

  ```bash
  git commit -m "feat: add Prime to the LiteLLM harness catalog"
  ```

## Task 2: Add fail-closed Prime configuration and task-local paths

**Files:**

- Modify: `lib/config.ts`
- Modify: `.env.example`
- Modify: `tests/setup.ts`
- Create: `lib/agents/prime/session-paths.ts`
- Create: `lib/agents/prime/policy.ts`
- Create: `tests/primePolicy.test.ts`

- [ ] Write failing tests for the absolute `LITELLM_PRIME_HOME` default and
  override, task-ID path containment, `0700` directories, and child environment
  removal of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `OPENROUTER_API_KEY`,
  `OPENROUTER_OPERATOR_API_KEY`, and `LITELLM_API_KEY`.
- [ ] Add `LITELLM_PRIME_HOME`, default
  `path.join(os.homedir(), ".operator", "litellm-prime")`, and reject relative
  overrides at module load.
- [ ] Implement `primeTaskPaths(taskId, generation)` with validated path
  segments beneath `<home>/<taskId>/config` and
  `<home>/<taskId>/sessions/<generation>`. Reject separators, `..`, empty
  identifiers, and any resolved path outside the home.
- [ ] Implement `buildPrimeHarnessEnv(taskId)` from `buildHarnessEnv`, remove all
  provider secrets, and inject only relay/tool context needed by the child.
- [ ] Implement exact alias policy for `operator.kimi-k3`; reject absent,
  unknown, OpenAI, Anthropic, fallback-suffixed, and provider-qualified values.
- [ ] Run:

  ```bash
  npx vitest run tests/primePolicy.test.ts
  ```

  Expected: all policy and path tests pass without reading live credentials.

- [ ] Commit:

  ```bash
  git commit -m "feat: isolate Prime task state and model policy"
  ```

## Task 3: Implement the Prime JSONL RPC client and process lifecycle

**Files:**

- Create: `lib/agents/prime/rpc.ts`
- Create: `tests/fixtures/prime/fake-prime-agent.mjs`
- Create: `tests/fixtures/prime/events-success.jsonl`
- Create: `tests/fixtures/prime/events-abort.jsonl`
- Create: `tests/primeRpc.test.ts`

- [ ] Write failing tests for start, prompt correlation, streamed events,
  `get_state`, `get_session_stats`, resume, malformed JSON, unexpected EOF,
  nonzero exit, timeout, and concurrent request IDs.
- [ ] Make the fake executable spawn a child worker in abort tests so the test
  proves process-group cleanup, not just parent exit.
- [ ] Implement a line-buffered RPC client using `child_process.spawn` with
  detached process-group ownership on POSIX. Keep stdout protocol-only; capture a
  bounded stderr tail for actionable errors.
- [ ] Wire an external `AbortSignal` to RPC `abort`, wait for an aborted/error
  terminal event, then escalate SIGTERM to SIGKILL for the full process group.
- [ ] In every error path, stop and await the client before collecting final
  events and usage. Do not snapshot attribution while the process can still
  generate.
- [ ] Run:

  ```bash
  npx vitest run tests/primeRpc.test.ts
  ```

  Expected: all RPC tests pass and the fake worker PID no longer exists after
  abort, timeout, and forced failure.

- [ ] Commit:

  ```bash
  git commit -m "feat: add Prime RPC process client"
  ```

## Task 4: Normalize Prime events into Operator events

**Files:**

- Create: `lib/agents/prime/events.ts`
- Create: `tests/primeEvents.test.ts`
- Add: sanitized JSONL fixtures under `tests/fixtures/prime/`

- [ ] Write failing table tests for agent/session start, model identity,
  assistant update accumulation, a single assistant emission at message end,
  tool start/update/end pairing, tool errors, usage, abort, and done.
- [ ] Implement a stateful normalizer keyed by message and tool-call IDs.
  Unknown events are ignored and recorded in bounded diagnostics; malformed
  required events produce an Operator error.
- [ ] Require both requested alias and resolved physical Kimi identity in the
  terminal metadata. Treat missing identity or OpenAI/Anthropic/fallback identity
  as a policy error and suppress `done` success.
- [ ] Do not use Codex's event mapper or pricing table.
- [ ] Run:

  ```bash
  npx vitest run tests/primeEvents.test.ts
  ```

  Expected: all mapping and identity tests pass with exactly one transcript row
  per assistant message.

- [ ] Commit:

  ```bash
  git commit -m "feat: normalize Prime RPC events"
  ```

## Task 5: Add the Operator tool extension for Prime

**Files:**

- Create: `scripts/prime-operator-extension.ts`
- Modify: `lib/config.ts`
- Modify: `tests/agentTools.test.ts`
- Create: `tests/primeOperatorTools.test.ts`
- Reference without behavior change: `scripts/orch-mcp.mjs`
- Reference without behavior change: `lib/agentToolDefs.mjs`

- [ ] Write failing source/contract tests requiring the six exact tool names and
  their shared definitions: `ask_user`, `suggest_task`, `expose_service`,
  `publish_artifact`, `publish_workstream_update`, and `propose_card_change`.
- [ ] Add HTTP mock tests that assert every call uses the corresponding
  `/api/internal/agent-tools/*` route, task/project IDs, JSON content type, and
  `x-service-token`.
- [ ] Implement a Prime extension using `pi.registerTool()` for each shared tool.
  Mirror `ask_user`'s durable polling and `suggest_task`'s per-turn
  title-to-task-ID dependency resolution from `scripts/orch-mcp.mjs`.
- [ ] Export `PRIME_OPERATOR_EXTENSION_PATH` from `lib/config.ts`.
- [ ] Ensure the extension has no imports or logging paths that can expose
  provider credentials, and never receives those values in its environment.
- [ ] Run:

  ```bash
  npx vitest run tests/agentTools.test.ts tests/primeOperatorTools.test.ts
  ```

  Expected: all shared schemas and route behaviors match the existing bridges.

- [ ] Commit:

  ```bash
  git commit -m "feat: bridge Operator tools into Prime"
  ```

## Task 6: Implement the `litellm-prime` driver

**Files:**

- Create: `lib/agents/prime/capabilities.ts`
- Create: `lib/agents/prime/driver.ts`
- Modify: `lib/agents/litellm/capabilities.ts`
- Modify: `tests/agentDriver.test.ts`
- Create: `tests/primeDriver.test.ts`

- [ ] Write failing driver-contract tests for exact ID/label, managed-endpoint
  status, fresh turn, resume, selected model, project context, task worktree,
  extension loading, session indexing, usage, unavailable model, missing CLI,
  abort, and cleanup after a paid failure.
- [ ] Implement `primeCapabilities()` from
  `liteLLMCapabilities("prime")`. Enable `supportsAsks` and `supportsMcpTools`
  only now that Task 5's parity suite is green.
- [ ] Spawn Prime with `--mode rpc`, exact executable path, task `--cwd`,
  task-local `--session-dir`, generated provider config, Operator extension, and
  flags that disable telemetry, refinement, user/global extensions, user skills,
  and prompt templates while preserving repository context files.
- [ ] Route all inference through `getLiteLLMRelay()` and pass the relay child
  token only. Validate the model before launch and validate resolved identity
  before a successful `done`.
- [ ] Use `get_session_stats` only after the process settles. Persist trusted
  token/cost values; set unknown cost to zero and mark it unestimated.
- [ ] Append the opaque Prime session ID with `harness: "prime"`.
- [ ] Run:

  ```bash
  npx vitest run tests/agentDriver.test.ts tests/primeDriver.test.ts
  ```

  Expected: the real Operator runner consumes the fake Prime stream and all
  lifecycle tests pass.

- [ ] Commit:

  ```bash
  git commit -m "feat: add the LiteLLM Prime driver"
  ```

## Task 7: Register Prime and make managed catalogs driver-generic

**Files:**

- Modify: `lib/agents/registry.ts`
- Modify: `lib/agents/capabilities.ts`
- Modify: `lib/agents/types.ts`
- Modify: `app/api/agents/route.ts`
- Create: `app/api/agents/[id]/models/refresh/route.ts`
- Retain compatibility: `app/api/agents/litellm-codex/models/refresh/route.ts`
- Modify: `tests/agentSwitch.test.ts`
- Modify: `tests/litellmAgentUi.test.ts`
- Create: `tests/primeAgentUi.test.ts`

- [ ] Write failing tests that require `litellm-prime` in both the runtime and
  SDK-free registries, reject unknown IDs strictly on task writes, and prove an
  unavailable registered Prime task does not fall back to Claude.
- [ ] Add optional capability metadata
  `managedCatalogPath: "/api/agents/[id]/models/refresh"` or an equivalent
  server-generated URL safe for the browser.
- [ ] Register `primeAgentDriver` and `primeCapabilities()` in the mirrored
  registries. Preserve `DEFAULT_AGENT = "claude"`.
- [ ] Add a generic refresh route that resolves the driver strictly, requires
  managed-endpoint capability, and refreshes the shared LiteLLM catalog. Keep the
  old Codex URL as a compatibility wrapper until callers and tests migrate.
- [ ] Run:

  ```bash
  npx vitest run tests/agentSwitch.test.ts tests/litellmAgentUi.test.ts tests/primeAgentUi.test.ts
  ```

  Expected: both LiteLLM drivers appear, refresh safely, and unknown agents 404.

- [ ] Commit:

  ```bash
  git commit -m "feat: register Prime and generalize model refresh"
  ```

## Task 8: Add Prime selection, branding, and honest UI copy

**Files:**

- Modify: `app/orchestrator/AgentConnect.tsx`
- Modify: `app/orchestrator/SessionView.tsx`
- Modify: `app/orchestrator/SettingsView.tsx`
- Modify: `app/orchestrator/QuotaView.tsx`
- Modify: `app/Orchestrator.tsx`
- Modify: `app/icons.tsx`
- Modify: `app/globals.css`
- Modify: `tests/litellmAgentUi.test.ts`
- Modify: `tests/primeAgentUi.test.ts`
- Modify: `tests/modelLabel.test.ts`
- Modify: `tests/launchConfig.test.ts`

- [ ] Write failing UI tests for the Prime label/icon, Kimi picker visibility,
  generic refresh URL, Auto-run-only permissions, unavailable-model message,
  metered cost wording, and absence from native subscription-quota advice.
- [ ] Drive managed refresh from agent capability metadata instead of the
  `litellm-codex` literal in `AgentConnect.tsx` and `SessionView.tsx`.
- [ ] Add a distinct Prime avatar/mark using the existing icon system and CSS;
  do not add an external image dependency.
- [ ] Update Settings language so managed routes are not described as
  subscription logins and state plainly that Prime has the Operator process's
  host permissions.
- [ ] Add `prime`, `kimi`, `litellm`, and `openrouter` command-palette keywords.
- [ ] Keep Claude as the default and do not rewrite existing task/project agent
  values.
- [ ] Run:

  ```bash
  npx vitest run tests/litellmAgentUi.test.ts tests/primeAgentUi.test.ts tests/modelLabel.test.ts tests/launchConfig.test.ts
  ```

  Expected: all picker, copy, and launch-control assertions pass.

- [ ] Commit:

  ```bash
  git commit -m "feat: expose Prime Agent in Operator"
  ```

## Task 9: Clean up task-local Prime state safely

**Files:**

- Modify: `lib/agents/prime/session-paths.ts`
- Modify: `app/api/tasks/[id]/route.ts`
- Modify: `lib/runner.ts` only if the existing settle hook is insufficient
- Modify: `tests/deleteMidTurn.test.ts`
- Modify: `tests/clearMidTurn.test.ts`
- Create: `tests/primeCleanup.test.ts`

- [ ] Write failing tests for delete while idle, delete during a turn, `/clear`
  generation rollover, Operator shutdown, symlink/path traversal defense, and
  preservation of other tasks' Prime state.
- [ ] Add a driver-scoped cleanup hook or explicit Prime cleanup call only after
  the existing abort owner reports the turn settled.
- [ ] Remove `<LITELLM_PRIME_HOME>/<task-id>` without following symlinks and only
  after verifying the resolved parent is the configured Prime home.
- [ ] Keep `/clear` histories under generation-specific session directories and
  preserve prior generations for transcript lineage unless hard deletion was
  requested.
- [ ] Run:

  ```bash
  npx vitest run tests/deleteMidTurn.test.ts tests/clearMidTurn.test.ts tests/primeCleanup.test.ts
  ```

  Expected: no Prime PID or task directory survives hard deletion, and unrelated
  task directories remain byte-for-byte unchanged.

- [ ] Commit:

  ```bash
  git commit -m "feat: retire Prime task state safely"
  ```

## Task 10: Tag the Kimi route in the LiteLLM server

**Files in `/Users/geo/Claude Projects/LiteLLM server`:**

- Modify: `config/litellm.yaml`
- Modify or create the repository's focused config test
- Update that repository's environment example only if the existing dedicated
  Kimi credential name is not already documented

- [ ] Run `git status --short` in the LiteLLM repository and stop if the Kimi
  entry has overlapping unowned changes.
- [ ] Add a failing config test that requires exactly one
  `model_name: operator.kimi-k3`, `operator.enabled: true`,
  `operator.kind: coding`, and `operator.harnesses` containing `prime`.
- [ ] Assert no `fallbacks`, `default_fallbacks`, OpenAI model, Anthropic model,
  or alternate provider target can service the alias.
- [ ] Add `prime` to the existing Kimi Operator tag without changing the physical
  model or dedicated credential.
- [ ] Run the repository's YAML/config tests and an authenticated
  `/model/info` read. Expected: the sanitized entry exposes
  `operator.kimi-k3` with `prime`; no credential or physical provider parameters
  are returned to Operator's browser response.
- [ ] Commit in the LiteLLM repository with:

  ```bash
  git commit -m "feat: approve Kimi for the Prime harness"
  ```

## Task 11: Package pinned Prime Agent

**Files:**

- Modify: `Dockerfile`
- Modify: `docker/entrypoint.sh`
- Modify: `docker-compose.yml` only if measured limits are insufficient
- Modify: `.env.example`
- Modify: `docs/SELF_HOSTING.md`
- Create or modify: the Docker smoke-test script used by this repository

- [ ] Add a failing static/build test requiring a single
  `PRIME_AGENT_VERSION=0.7.1` pin, the official checksum-verified installer, and
  `prime-agent --version` verification.
- [ ] Install Prime in the runtime image without using `latest`. Copy
  `scripts/prime-operator-extension.ts` and its shared definitions with
  root-owned, non-writable permissions.
- [ ] Create `LITELLM_PRIME_HOME` as a restrictive directory at entrypoint and
  retain the existing subscription-key stripping for Claude/OpenAI/Anthropic.
- [ ] Build and run the image. Exercise one fake RPC turn with an IPython worker,
  stop it, and inspect the container process list for orphan Prime, worker,
  kernel, and ZeroMQ processes.
- [ ] Measure peak memory under the compose limits before changing them. Modify
  resource limits only if the smoke test demonstrates a reproducible failure.
- [ ] Commit:

  ```bash
  git commit -m "build: package pinned Prime Agent"
  ```

## Task 12: Document, verify, and run one controlled Kimi acceptance test

**Files:**

- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SELF_HOSTING.md`
- Modify: `HANDOFF.md`
- Add: a sanitized Prime acceptance artifact under the existing evaluation
  artifact convention

- [ ] Document the supported-agent row, `litellm-prime` architecture,
  task-local state, Auto-run-only permissions, host-access warning, model policy,
  abort escalation, usage semantics, and rollback order.
- [ ] Run focused regression suites:

  ```bash
  npx vitest run tests/litellmCatalog.test.ts tests/primePolicy.test.ts tests/primeRpc.test.ts tests/primeEvents.test.ts tests/primeOperatorTools.test.ts tests/primeDriver.test.ts tests/primeAgentUi.test.ts tests/agentSwitch.test.ts tests/deleteMidTurn.test.ts
  ```

  Expected: all focused tests pass.

- [ ] Run the repository gate:

  ```bash
  npm run verify
  ```

  Expected: lint, typecheck, unit tests, production build, and trace validation
  all pass.

- [ ] Before any paid call, confirm the LiteLLM alias, resolved physical Kimi
  model, dedicated provider key attribution, and available balance. Do not
  purchase credits.
- [ ] Run one disposable fixture-repository task through
  `litellm-prime`, resume it once, and abort a deliberate long tool once.
- [ ] Record prompt, exact alias, resolved identity, token fields, trusted cost,
  wall time, tool trace, session ID hash, abort evidence, and process-tree
  settlement. Redact keys, full session content, and Geo-specific paths.
- [ ] Reconcile the recorded cost with LiteLLM/provider attribution. If the
  difference is below the provider's documented precision, label it rounding;
  otherwise fail acceptance and investigate before enabling Prime generally.
- [ ] Confirm native Claude and native Codex still authenticate through their
  subscription homes and no OpenRouter calls exist for either provider.
- [ ] Request an independent code review. Fix every Critical and Important
  finding, rerun `npm run verify`, and only then mark the integration complete.

---

## Final release checklist

- [ ] Prime 0.7.1 is pinned and version-verified.
- [ ] `litellm-prime` is registered in both driver maps.
- [ ] Kimi is the only approved Prime model.
- [ ] No OpenAI or Anthropic model can reach OpenRouter.
- [ ] No fallback is configured.
- [ ] Prime child processes never receive provider credentials.
- [ ] Prime state is task-local and hard-delete cleanup is contained.
- [ ] Stop settles parent, worker, kernel, and subagent processes.
- [ ] All six Operator tools pass parity tests.
- [ ] Cost is trusted or explicitly absent; no Codex estimate is shown.
- [ ] Existing task agents and default agent are unchanged.
- [ ] Docker smoke and `npm run verify` pass.
- [ ] Handoff records exact commits, validation evidence, and any paid-test cost.

