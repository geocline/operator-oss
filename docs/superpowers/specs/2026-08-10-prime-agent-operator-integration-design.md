# Prime Agent Operator Integration Design

**Date:** 2026-08-10  
**Status:** Approved direction; implementation not started  
**Owner decision:** Add Prime Agent as the preferred Operator harness for approved Kimi models while preserving native Claude Code and native Codex.

## Objective

Add Prime Agent as an additive Operator driver so a task can run an explicitly
approved Kimi model through Prime's coding harness. The integration must preserve
Operator's existing task lifecycle, worktrees, agent-tool features, session
persistence, usage records, and model-routing policy.

The first supported combination is:

| Route | Harness | Model alias | Driver ID | Billing |
|---|---|---|---|---|
| LiteLLM | Prime Agent | `operator.kimi-k3` | `litellm-prime` | Metered provider account behind LiteLLM |

Native Claude Code remains subscription-backed. Native Codex remains
subscription-backed. Neither may be routed through OpenRouter.

## Research basis

Prime Agent 0.7.1 provides the runtime surfaces Operator needs:

- `prime-agent --mode rpc` uses strict JSON Lines over stdin/stdout.
- RPC supports prompt, abort, resume, state inspection, model/thinking settings,
  streamed message/tool events, and session statistics.
- `--cwd` and `--session-dir` let Operator bind execution and durable state to a
  task.
- Prime extensions can register custom tools in RPC mode.
- The built-in IPython worker and subagents are features worth preserving.

The completed Kimi evaluation established that Prime can run a real repository
task, resume, abort, call tools, and report usage. That evaluation is evidence of
fit, not production code. Production must use the existing LiteLLM gateway and
Operator policy boundary.

Prime is not an operating-system sandbox. Its worker and IPython kernel run with
the permissions of the Operator process. Operator's task worktree isolates Git
changes but does not prevent reads elsewhere on the host.

## Integration options

### Option A — additive `litellm-prime` driver (recommended)

Add one concrete driver using the existing LiteLLM catalog and relay, with a
Prime-specific RPC adapter and task-local state.

Advantages:

- no database migration;
- preserves side-by-side Codex-versus-Prime selection for Kimi;
- reuses the runner, task switching, usage persistence, and managed endpoint UI;
- keeps provider credentials behind LiteLLM;
- can be disabled or rolled back without affecting subscription drivers.

### Option B — split route, harness, and model into database columns

This is conceptually cleaner for many future harnesses, but it requires a schema
migration, picker redesign, conversion of existing tasks, and broader regression
work. It is unnecessary for one new valid route/harness combination.

### Option C — replace the LiteLLM Codex driver with Prime

This is the smallest diff but removes the controlled comparison and risks
misinterpreting existing `litellm-codex` sessions. It is rejected.

## Selected architecture

### Driver identity and catalog

- Add `litellm-prime` with the user-facing label **Prime Agent**.
- Keep `litellm-codex` unchanged.
- Extend `LiteLLMHarness` to `"codex" | "claude" | "prime"`.
- Build each LiteLLM driver's capabilities from the same sanitized catalog,
  filtered by its harness.
- Tag `operator.kimi-k3` with `harnesses: ["codex", "prime"]` only if both
  combinations remain approved.
- Preserve the existing SQLite catalog setting as a shared legacy-compatible
  store for the first release. The catalog is route-level data, so both drivers
  read the same last-known-good snapshot.
- Generalize the refresh endpoint and UI to use an agent's managed-catalog
  metadata instead of hardcoding `litellm-codex`.

### Fail-closed model policy

The gateway remains the authoritative model-policy boundary.

- Operator sends only the exact LiteLLM alias `operator.kimi-k3`.
- The Prime driver validates the selected alias before process launch.
- Prime receives an Operator-generated provider configuration that exposes only
  the approved alias and the loopback relay.
- No provider fallback, default model, dynamic unfiltered catalog, or model
  substitution is allowed.
- OpenRouter-backed OpenAI and Anthropic models are prohibited.
- Missing or mismatched resolved-model attribution fails the turn.
- Provider credentials remain in LiteLLM. The Prime child sees only the relay's
  disposable local token.

### Process and RPC boundary

Create `lib/agents/prime/` as an SDK-free subprocess adapter:

- `rpc.ts` owns JSONL request/response correlation, stdout parsing, timeouts,
  abort, and process-group termination.
- `events.ts` converts Prime events into Operator `StreamEvent` values.
- `session-paths.ts` creates task-local configuration and session paths.
- `policy.ts` builds the allowlisted Prime provider/model configuration and
  sanitizes the child environment.
- `driver.ts` implements `AgentDriver`.

The driver launches the pinned `prime-agent` executable with RPC mode, the task
worktree as `--cwd`, and a task-generation-specific `--session-dir`. It must not
import Prime's internal Python packages into Next.js.

### State isolation

Add `LITELLM_PRIME_HOME`, defaulting to `~/.operator/litellm-prime`. Every task
gets:

```text
<LITELLM_PRIME_HOME>/<task-id>/
  config/
  sessions/<generation-or-session-id>/
```

Prime global/user extensions, skills, prompt templates, telemetry, and automatic
continual refinement are disabled in the first release. Project context files
remain enabled so repository instructions such as `AGENTS.md` are honored.
Prime's built-in IPython and subagent facilities remain enabled.

Task deletion removes only that task's Prime directory after its process tree has
settled. Session metadata can use the existing opaque `tasks.session_id` and
sessions table fields, so no schema migration is required.

### Event normalization

Map Prime RPC events as follows:

| Prime event | Operator event |
|---|---|
| session/agent start with session ID | `session` |
| selected and resolved model | `model` |
| final assistant `message_end` | `assistant` |
| `tool_execution_start` | `tool` |
| `tool_execution_end` | `tool_result` |
| Operator `ask_user` extension result | existing `ask` lifecycle through the internal endpoint |
| session statistics | `usage` |
| protocol/process/policy failure | `error` |
| settled turn | `done` |

Incremental assistant updates are accumulated and emitted once at message end so
Operator does not create duplicate transcript rows. Tool calls are paired by
Prime tool-call ID. Abort is considered successful only after the RPC trace
contains an aborted/error terminal result or the process is forcibly settled;
an ordinary completed turn must not pass the abort gate.

### Operator tool parity

Prime's extension API, not Codex MCP configuration, supplies Operator tools.
Create an Operator-owned Prime extension that registers the names and schemas
from `lib/agentToolDefs.mjs` and calls the same authenticated loopback endpoints
used by `scripts/orch-mcp.mjs`:

- `ask_user`
- `suggest_task`
- `expose_service`
- `publish_artifact`
- `publish_workstream_update`
- `propose_card_change`

The extension receives only `ORCH_TASK_ID`, `ORCH_PROJECT_ID`,
`ORCH_BASE_URL`, and `SERVICE_TOKEN`. It must never receive LiteLLM or provider
credentials. `supportsAsks` and `supportsMcpTools` become true only after all
tool-contract tests pass.

### Permissions

Prime's current process boundary cannot honestly enforce Operator's existing
Codex read-only plan mode against all Python and shell access. The first release
therefore exposes **Auto-run only**. Plan mode may be added later only with an
external container/OS policy and a verification test that proves writes and
network access are blocked.

The UI and documentation must state that Prime runs with the Operator process's
host permissions.

### Usage and cost

- Read token and cost fields from Prime `get_session_stats` after the turn
  settles.
- Persist input, output, cache, and total token fields through the existing
  runner.
- Record a dollar cost only when it is returned by a trusted metering path and
  reconciles with LiteLLM attribution.
- Never apply native Codex price estimates to Prime/Kimi.
- A failure after inference must stop the process tree before collecting the
  final event and key-usage snapshots, so late charges are not lost.
- The UI labels Prime cost as metered, not subscription-covered.

### UI and product behavior

Most of Operator's task, project, handoff, and picker code is already
capability-driven. Required visible changes are:

- a Prime Agent picker entry and distinct icon/avatar;
- a managed LiteLLM catalog refresh action that works for both LiteLLM drivers;
- Kimi models shown only when their `prime` tag is present;
- unavailable Prime sessions fail actionably and never fall back to Claude;
- Prime usage excluded from native Claude/Codex quota advice;
- command-palette terms for Prime, Kimi, LiteLLM, and OpenRouter;
- explicit Auto-run and host-permission wording.

Existing projects and tasks retain their current agents. Claude remains the
default unless Geo changes it after Prime ships.

### Packaging

- Pin Prime Agent 0.7.1 in `Dockerfile`; do not install `latest`.
- Use the official installer with its exact-version argument and checksum
  verification, then assert `prime-agent --version`.
- Copy the Operator Prime extension into the runtime image.
- Create the Prime home with restrictive permissions in `docker/entrypoint.sh`.
- Verify Docker resource limits with Prime's daemon, IPython worker, and
  subagents running.
- Keep `package.json` and `package-lock.json` unchanged unless the implementation
  proves a new Node dependency is necessary.

## Failure and rollback behavior

- If Prime is not installed, keep the driver registered and show an actionable
  unavailable error. Never resolve an existing Prime task through Claude.
- If catalog refresh fails, retain the last-known-good catalog and mark it stale.
- If a selected model disappears, block the turn and require reselection.
- Stop uses RPC abort first, then SIGTERM and SIGKILL against the full process
  group, and waits for the worker/kernel tree to settle.
- Rollback order: disable new Prime selection, settle active turns, hand off or
  clear Prime sessions, preserve task-local state for recovery, and remove
  packaging only after no task references `litellm-prime`.

## Acceptance criteria

1. `litellm-prime` appears as an additive agent and does not change existing
   task defaults.
2. Only a `prime`-tagged `operator.kimi-k3` model can launch.
3. OpenAI, Anthropic, unknown, fallback, and mismatched physical models fail
   before or during the turn with no silent substitution.
4. Fresh, resume, tool, ask, malformed-RPC, nonzero-exit, timeout, abort, and
   missing-session-state tests pass.
5. Prime processes, workers, kernels, and subagents do not survive Stop, task
   deletion, Operator shutdown, or timeout.
6. Prime state never crosses task boundaries.
7. All six Operator tools behave the same as the Claude/Codex paths.
8. Usage is persisted without a Codex pricing estimate; trusted costs reconcile.
9. Native Claude and Codex continue to use their subscription paths.
10. `npm run verify` and a pinned Docker smoke test pass.
11. A real Kimi task completes in a disposable fixture repository, resumes once,
    aborts once, and produces sanitized evidence with no secrets.

