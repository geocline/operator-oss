# Operator LiteLLM Agent Routing Design

**Date:** 2026-08-07
**Status:** Approved architecture, pending written-spec review
**Program order:** Codex harness first, Claude Code harness second

## Objective

Add LiteLLM as a new, centrally managed model route in Operator without changing
the behavior, authentication, endpoints, or session stores of Operator's existing
Claude Code and Codex subscription drivers.

Geo must be able to:

1. Add or replace a model in the central LiteLLM configuration.
2. Mark only selected models as visible to Operator.
3. Refresh Operator's model catalog without changing Operator code.
4. Run a tagged model as a full coding agent through a supported harness.
5. Attribute OpenRouter usage to a dedicated company-chargeable API key.
6. Search, archive, and attach LiteLLM-backed Operator conversations through
   Conversations Dashboard and Card Tracker.
7. Later use the Claude Code harness with compatible LiteLLM models without
   disturbing native Claude Code.

## Non-negotiable boundaries

- Native Claude Code remains subscription-backed and unchanged.
- Native Codex remains subscription-backed and unchanged.
- OpenRouter stays behind LiteLLM. Operator does not connect to OpenRouter
  directly and never receives an OpenRouter key.
- Operator contains no hard-coded Kimi, DeepSeek, OpenRouter, or other
  third-party model catalog.
- A removed or unavailable LiteLLM model never silently falls back to a
  different model.
- LiteLLM credentials and provider credentials never reach the browser,
  transcript content, task prompts, or project worktrees.
- Image generation is a separate capability phase, not a coding-model entry in
  the first implementation.

## Terminology

- **Route:** Where inference is billed and authenticated: native Claude,
  native Codex, or LiteLLM.
- **Harness:** The coding-agent loop that exposes tools, executes commands,
  edits files, manages turns, and resumes sessions: Claude Code or Codex.
- **Model:** The model selected from the route's catalog.
- **Driver:** Operator's implementation adapter. A driver represents one valid
  route/harness combination.

The user-facing design separates route, harness, and model. Internally, the
existing `tasks.agent` field continues to hold a concrete driver ID so the
current runner and registry seam remain intact.

## Valid combinations

| Route | Harness | Catalog | Billing | Driver ID |
|-|-|-|-|-|
| Native Claude | Claude Code | Existing Claude capabilities | Existing subscription | `claude` |
| Native Codex | Codex | Existing Codex capabilities | Existing subscription | `codex` |
| LiteLLM | Codex | Dynamically tagged compatible entries | Metered through LiteLLM | `litellm-codex` |
| LiteLLM | Claude Code | Dynamically tagged compatible entries | Metered through LiteLLM | `litellm-claude` |

Phase 1 implements `litellm-codex`. Phase 2 implements `litellm-claude` only
after the Codex-harness route is stable.

## Native Codex model-picker correction

The existing native Codex capability descriptor is stale. A small prerequisite
change will add GPT-5.6 Sol, Terra, and Luna to the native Codex picker using
their accepted model IDs and correct context/reasoning metadata.

This change is catalog-only. It must not change native Codex authentication,
base URL, SDK construction, session location, tool configuration, defaults, or
runtime controls.

## LiteLLM catalog contract

Operator discovers models from the running gateway's authenticated
`/model/info` endpoint. It does not use a provider catalog or OpenRouter's model
list.

An entry is visible only when its custom `model_info` contains:

```yaml
model_info:
  operator:
    enabled: true
    label: "Operator Frontier"
    kind: "coding"
    harnesses: ["codex"]
    description: "Quality-first coding route"
    context_window: 1000000
    sort_order: 10
```

### Required fields

- `enabled`: must be exactly `true`.
- `label`: nonempty user-facing name.
- `kind`: must be `coding` for the first implementation.
- `harnesses`: nonempty list containing `codex`, and later optionally `claude`.

### Optional fields

- `description`: short picker subtitle.
- `context_window`: positive integer used by the context gauge.
- `sort_order`: integer ordering hint.
- `reasoning_options`: explicit reasoning levels known to work.

Unknown fields are ignored. Invalid tagged entries are excluded and surfaced in
the refresh result as configuration errors; they do not break the valid catalog.
Entries with `kind: image` are reserved for the later image-generation phase.

The value persisted in `tasks.model` is the LiteLLM `model_name`, not the
underlying provider model. Geo can therefore keep a stable name such as
`operator.frontier` and change its physical target centrally, or tag a specific
model entry for direct evaluation.

## Dedicated OpenRouter accounting

LiteLLM holds a separate provider credential such as
`OPENROUTER_OPERATOR_API_KEY` in its private environment. Operator-tagged
OpenRouter deployments reference that environment variable:

```yaml
- model_name: operator.frontier
  litellm_params:
    model: openrouter/<provider-model-id>
    api_key: os.environ/OPENROUTER_OPERATOR_API_KEY
  model_info:
    operator:
      enabled: true
      label: "Operator Frontier"
      kind: "coding"
      harnesses: ["codex"]
```

Operator itself authenticates only to the loopback LiteLLM gateway using a
gateway client token. A separate OpenRouter key provides key-level usage and
limit reporting. A separate OpenRouter workspace/account is required only if
Geo needs a separate funding pool or invoice rather than usage-based internal
chargeback.

## Operator server configuration

Add env-driven settings with documented defaults:

- `LITELLM_BASE_URL=http://127.0.0.1:4000/v1`
- `LITELLM_API_KEY` for the loopback gateway client token
- `LITELLM_CODEX_HOME` as an optional absolute-path override

The OpenRouter provider key is never an Operator environment variable.

The default LiteLLM Codex home is resolved in code from the operating-system
home directory as `.operator/litellm-codex`; `~` is not accepted in the env
override. This isolates gateway-backed harness configuration and Codex JSONL
sessions from `~/.codex`, preserving the native subscription-backed Codex
installation.

## Dynamic refresh and last-known catalog

Operator adds an explicit refresh action for the LiteLLM catalog.

1. The server calls LiteLLM `/model/info`.
2. It validates and filters the `model_info.operator` metadata.
3. It persists the validated catalog as the last-known-good snapshot in
   Operator's SQLite settings.
4. It updates the `litellm-codex` capability descriptor returned by
   `GET /api/agents`.
5. The UI rerenders the picker and reports included entries, excluded invalid
   entries, and gateway errors.

Catalog discovery and credentials remain server-side. A failed refresh preserves
the last-known-good snapshot and shows a stale/error state. It never replaces a
valid snapshot with an empty catalog.

If a task references a model absent from the current catalog, Operator displays
it as unavailable and blocks the next turn with an actionable error. It does not
send a null model or inherit a gateway default.

## LiteLLM Codex-harness driver

`litellm-codex` is a new `AgentDriver`. It reuses the Codex SDK and normalized
event mapper but has its own construction and capabilities.

For every turn it:

1. Resolves the exact selected tagged LiteLLM model.
2. Creates a Codex SDK client with the LiteLLM base URL and gateway client token.
3. Sets the isolated `CODEX_HOME`.
4. Uses the task's existing isolated worktree and Operator MCP configuration.
5. Streams events through the existing normalized `StreamEvent` contract.
6. Persists the gateway-backed thread ID as the task session ID.
7. Reports the selected LiteLLM model name and, when actually exposed by the
   response path, the resolved physical model.

The driver supports Operator asks, MCP tools, workstream tools, Stop, resume,
permission controls, and usage events through the same downstream runner used by
Claude and Codex.

Reasoning settings are capability-driven. Operator sends only reasoning values
declared by the tagged model. It does not assume that every provider accepts the
native Codex reasoning vocabulary.

The driver implements transcript summarization for `/clear` and harness handoff.
Project recap/context drafting may initially fall back to the configured utility
agent under Operator's existing one-shot policy.

## Managed-endpoint connection state

LiteLLM does not have a user login flow inside Operator. Extend the agent
connection descriptor with a managed-endpoint style:

- Connected: gateway responds and returns at least one valid tagged model.
- Degraded: last-known catalog exists but refresh/verification currently fails.
- Disconnected: no valid catalog has ever been loaded.

Claude's paste-code login and Codex's device-code login remain unchanged.
Settings provides LiteLLM status, Verify, and Refresh actions but never displays
or edits the provider key.

## Compatibility verification

Refresh is discovery-only and must not incur paid inference automatically.

Operator offers an explicit, low-cost compatibility check per tagged model and
harness. The check runs read-only, exercises one tool call, and records:

- model name;
- harness;
- success/failure;
- verification timestamp;
- concise sanitized error.

Unverified models may be visible but are marked `Not tested`. Starting one
shows an explicit confirmation before any paid request; a failed verification
marks the combination incompatible until it is retested. Compatibility results
are advisory and keyed by model name plus harness.

## Picker and task behavior

The UI presents:

1. Route: Claude subscription, Codex subscription, or LiteLLM.
2. Harness: shown for LiteLLM; Codex first, Claude Code after Phase 2.
3. Model: capability-driven list filtered to the selected harness.

The underlying agent IDs remain concrete driver IDs. This avoids a database
schema rewrite and preserves the existing registry/runner design.

Before a task starts, route, harness, and model can change freely. Operator
resets model-specific reasoning and permission selections as it already does on
an agent change.

After a session starts, changing harnesses uses Operator's existing handoff
flow: summarize the current generation, start a fresh session in the same
worktree, and carry the summary forward. Native Claude, native Codex, and
gateway session IDs are never handed to another driver.

## Conversation storage and archival

Gateway-backed Codex-harness JSONL sessions live under the isolated
`LITELLM_CODEX_HOME`, not `~/.codex`.

Operator also appends a small session index record when a thread is created,
mapping:

- gateway thread ID;
- Operator task ID;
- Operator project ID;
- task title;
- project path;
- harness;
- selected LiteLLM model.

No prompt or response content is duplicated into the index.

Conversations Dashboard gains a third source named `operator`:

- live path: the isolated gateway session directory;
- format: Codex JSONL, reusing the existing parser;
- title/deep-link metadata: the Operator session index;
- archive path: `conversations-archive/operator`;
- source label and filter: `Operator`.

The nightly archive copies Operator JSONL and its session index without deletion,
matching the existing Claude/Codex preservation model. Source preflight and
health checks include Operator without changing the semantics of the two existing
sources.

## Card Tracker integration

Card Tracker expands `ConversationSource` from `claude | codex` to
`claude | codex | operator`.

The change includes:

- database check constraints and the attachment RPC;
- server request validation;
- local and Supabase stores;
- search results and source filters;
- an Operator badge;
- attachment snapshots;
- conversation deep links.

An attached Operator conversation opens the exact Operator task using the
Operator project/task IDs from Conversations Dashboard metadata. It does not
offer a misleading `codex resume` or `claude --resume` command.

Existing Claude and Codex attachment behavior remains unchanged.

## Error handling

- Gateway unreachable: preserve last-known catalog; show degraded state.
- Gateway unauthorized: show a configuration error without echoing a token.
- Invalid tagged metadata: exclude only that entry and report its model name.
- Selected model removed: mark unavailable and block; never fall back.
- Model/harness incompatibility: record sanitized failure and recommend another
  tagged compatible model.
- Mid-turn provider failure: persist partial normalized events and emit the
  existing recoverable task error flow.
- Isolated session store unavailable: fail before inference so a paid turn is
  not run without durable harness state.
- Conversations Dashboard or Card Tracker unavailable: the Operator turn still
  runs; indexing and attachment are downstream concerns.

## Security and privacy

- Provider keys stay in LiteLLM's private environment.
- Operator receives only a loopback gateway token.
- Browser APIs return sanitized catalog metadata, never `litellm_params`.
- `/model/info` responses are filtered server-side before persistence.
- Errors redact authorization headers, keys, provider request bodies, and raw
  LiteLLM configuration.
- The implementation must prove that the gateway token is absent from shell-tool
  subprocess environments. If the Codex harness cannot enforce that directly,
  Operator must interpose a loopback credential boundary rather than exposing
  the token to commands run in a project worktree.
- The compatibility check is read-only and runs inside the task worktree.
- Transcript archives remain local and follow current read-only indexing rules.

## Observability and cost

Phase 1 records selected model, harness, token usage, turn duration, and
verification state. Exact per-turn cost is shown only if the LiteLLM/Codex event
path exposes a trustworthy value. Operator must not label an estimate as billed
cost.

OpenRouter's dedicated key remains the authoritative company-chargeback source.
Per-task cost attribution inside Operator is a follow-on unless exact LiteLLM
cost data can be captured without enabling sensitive prompt logging.

## Implementation phases

### Phase 0: Native Codex catalog correction

- Add GPT-5.6 Sol, Terra, and Luna to the native Codex picker.
- Update context/reasoning/pricing metadata and tests.
- Do not change the native driver runtime.

### Phase 1A: LiteLLM metadata and discovery

- Document and validate `model_info.operator`.
- Add secure config, refresh API, last-known catalog, and managed connection UI.
- Do not hard-code a third-party model.

### Phase 1B: LiteLLM through Codex harness

- Add `litellm-codex`.
- Isolate `CODEX_HOME`.
- Implement turns, resume, MCP, asks, summarization, verification, and tests.

### Phase 1C: Conversation preservation

- Add the `operator` source and archive flow to Conversations Dashboard.
- Add exact task deep-link metadata.

### Phase 1D: Card Tracker attachment

- Add `operator` to storage, API, database constraints, search, badges, and
  exact Operator links.

### Phase 2: LiteLLM through Claude Code harness

- Add `litellm-claude` with a separate isolated Claude configuration/session
  directory.
- Reuse the same tag contract with `harnesses: ["claude"]`.
- Verify Anthropic-compatible tool behavior per model.
- Leave native Claude Code unchanged.

### Phase 3: Image generation

- Add a separate `kind: image` catalog and image-generation tool/UI.
- Use LiteLLM/OpenRouter image endpoints directly rather than presenting an
  image model as a coding harness.

## Verification strategy

### Operator

- Contract tests for registry and capability maps.
- Dynamic catalog parsing, invalid-entry isolation, cache, and stale behavior.
- Secret-redaction and server-only discovery tests.
- Driver contract through the real runner with a mocked gateway/SDK boundary.
- MCP, asks, Stop, resume, missing-model, reasoning, and handoff tests.
- Native Claude/Codex regression tests.
- Production build and trace validation.

### LiteLLM gateway

- Config validation for custom Operator metadata.
- Tests proving Operator-tagged entries use the dedicated provider-key
  environment variable.
- Existing aliases and non-Operator models remain unchanged.
- Explicit paid live verification only after Geo authorizes it.

### Conversations Dashboard

- Third-source parsing using Codex-format fixtures.
- Source health, incremental indexing, archive precedence, search, filters,
  session detail, and exact Operator metadata tests.
- Claude/Codex regression tests.

### Card Tracker

- Type, route, RPC, migration, local store, Supabase store, UI, search, badge,
  attachment, and deep-link tests.
- Existing Claude/Codex attachment regression tests.

### End-to-end acceptance

1. Add a tagged test model in LiteLLM using the dedicated Operator key.
2. Refresh Operator and see only eligible tagged entries.
3. Verify the model/harness combination explicitly.
4. Start a task through `litellm-codex`.
5. Confirm tools, edits, streaming, Stop/resume, and handoff.
6. Confirm the session appears as `Operator` in Conversations Dashboard.
7. Confirm nightly-style archive behavior using an isolated fixture.
8. Search and attach the session in Card Tracker.
9. Open the attachment back to the exact Operator task.
10. Confirm native Claude Code and Codex tasks still use their original
    subscriptions, stores, and behavior.

## Scope exclusions

- No automatic model recommendation or benchmark-based promotion.
- No automatic paid compatibility tests during refresh.
- No direct OpenRouter option in Operator.
- No provider-key editor in Operator.
- No custom coding-agent loop.
- No semantic conversation search changes.
- No image generation in the Codex-harness phase.
- No changes to hosted Operator control-plane behavior.
