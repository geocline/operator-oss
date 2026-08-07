# LiteLLM Codex Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dynamic, Operator-tagged LiteLLM route that runs full coding tasks through an isolated Codex harness while leaving native Claude Code and native Codex behavior unchanged.

**Architecture:** A pure catalog module validates `model_info.operator` metadata and exposes a last-known-good capability snapshot. A new `litellm-codex` driver reuses the Codex SDK through a loopback credential relay, a separate `CODEX_HOME`, and the existing normalized runner/MCP seams. This is the first independently shippable sub-project; Conversations Dashboard, Card Tracker, and the Claude-harness route get separate follow-on plans after this runtime is stable.

**Tech Stack:** Next.js 16, TypeScript, React 19, SQLite via `better-sqlite3`, `@openai/codex-sdk`, Vitest, LiteLLM OpenAI-compatible API

---

## File structure

### New focused modules

- `lib/agents/litellm/types.ts` — sanitized catalog and compatibility types.
- `lib/agents/litellm/catalog.ts` — pure metadata validation and in-memory last-known catalog.
- `lib/agents/litellm/catalog-store.ts` — SQLite hydration/persistence and live `/model/info` refresh.
- `lib/agents/litellm/relay.ts` — loopback HTTP relay that keeps the real gateway token out of Codex shell subprocesses.
- `lib/agents/litellm/session-index.ts` — append-only, content-free mapping from harness thread IDs to Operator task/project metadata.
- `lib/agents/litellm/capabilities.ts` — capability descriptor built from the sanitized catalog.
- `lib/agents/litellm/driver.ts` — `AgentDriver` implementation using the Codex SDK.
- `app/api/agents/litellm-codex/models/refresh/route.ts` — explicit catalog refresh.
- `app/api/agents/litellm-codex/models/verify/route.ts` — explicit paid compatibility verification.

### Existing files changed

- `lib/agents/codex/capabilities.ts` — native GPT-5.6 Sol/Terra/Luna picker correction only.
- `lib/agents/types.ts` — managed-endpoint connection style and optional model metadata.
- `lib/agents/capabilities.ts` — SDK-free registration of `litellm-codex`.
- `lib/agents/registry.ts` — register the new driver.
- `lib/config.ts` and `.env.example` — LiteLLM endpoint/client-token/isolated-home settings.
- `app/api/agents/route.ts` — hydrate dynamic capabilities and expose managed connection state.
- `app/orchestrator/types.ts`, `AgentConnect.tsx`, and `SessionView.tsx` — refresh/status UI and unavailable-model state.
- `README.md` and `docs/ARCHITECTURE.md` — document the third route and security boundary.

## Task 1: Correct the native Codex model catalog

**Files:**
- Modify: `lib/agents/codex/capabilities.ts`
- Modify: `lib/agents/codex/pricing.ts`
- Modify: `tests/modelLabel.test.ts`
- Modify: `tests/codexReasoning.test.ts`

- [ ] **Step 1: Write failing catalog tests**

Add exact assertions:

```ts
it("offers the current GPT-5.6 family", () => {
  const values = CODEX_CAPABILITIES.models.map((m) => m.value);
  expect(values.slice(0, 3)).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
});

it("uses the 1.05M GPT-5.6 context window", () => {
  for (const model of CODEX_CAPABILITIES.models.filter((m) => m.value.startsWith("gpt-5.6-"))) {
    expect(model.contextWindow).toBe(1_050_000);
  }
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run tests/modelLabel.test.ts tests/codexReasoning.test.ts
```

Expected: FAIL because the picker begins with GPT-5.5 and has a 272,000-token constant.

- [ ] **Step 3: Add the three current entries without changing runtime construction**

Use:

```ts
const CTX_56 = 1_050_000;

models: [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", sub: "frontier capability", contextWindow: CTX_56, group: "Latest" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", sub: "balanced intelligence and cost", contextWindow: CTX_56, group: "Latest" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", sub: "efficient high-volume work", contextWindow: CTX_56, group: "Latest" },
  // Retain supported previous entries under Previous versions.
]
```

Extend the reasoning map to accept `max` only where the selected model declares it; do not change the existing default reasoning effort.

- [ ] **Step 4: Update pricing metadata conservatively**

Add exact published GPT-5.6 rows to `PRICES`, keep historical rows, and preserve longest-prefix matching. Do not label native subscription usage as billed cost.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run the Step 2 command.

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/agents/codex/capabilities.ts lib/agents/codex/pricing.ts tests/modelLabel.test.ts tests/codexReasoning.test.ts
git commit -m "fix: update native Codex model catalog"
```

## Task 2: Add LiteLLM configuration and sanitized catalog types

**Files:**
- Modify: `lib/config.ts`
- Modify: `.env.example`
- Modify: `tests/setup.ts`
- Create: `lib/agents/litellm/types.ts`
- Create: `tests/litellmCatalog.test.ts`

- [ ] **Step 1: Write failing configuration and type-contract tests**

Test isolated defaults and absolute override rejection:

```ts
expect(LITELLM_BASE_URL).toBe("http://127.0.0.1:4000/v1");
expect(LITELLM_CODEX_HOME.endsWith("/.operator/litellm-codex")).toBe(true);
expect(path.isAbsolute(LITELLM_CODEX_HOME)).toBe(true);
```

Define fixture expectations around:

```ts
export interface LiteLLMModel {
  value: string;
  label: string;
  description: string;
  harnesses: Array<"codex" | "claude">;
  kind: "coding";
  contextWindow: number | null;
  reasoningOptions: string[];
  sortOrder: number;
}
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/litellmCatalog.test.ts
```

Expected: FAIL because the config exports and module do not exist.

- [ ] **Step 3: Add server configuration**

Implement:

```ts
export const LITELLM_BASE_URL =
  (process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000/v1").replace(/\/+$/, "");

export const LITELLM_API_KEY =
  process.env.LITELLM_API_KEY || "sk-litellm-local";

const configuredLiteLLMHome = process.env.LITELLM_CODEX_HOME;
if (configuredLiteLLMHome && !path.isAbsolute(configuredLiteLLMHome)) {
  throw new Error("LITELLM_CODEX_HOME must be an absolute path");
}
export const LITELLM_CODEX_HOME =
  configuredLiteLLMHome || path.join(os.homedir(), ".operator", "litellm-codex");
```

Document all three variables in `.env.example`. State explicitly that
`OPENROUTER_OPERATOR_API_KEY` belongs to LiteLLM, not Operator.
Pin all import-time env values in `tests/setup.ts` so the suite never reads Geo's
live gateway settings.

- [ ] **Step 4: Add sanitized types**

Create only fields safe to persist or return to the browser. Do not include
`litellm_params`, API bases, provider keys, headers, or raw deployment objects.

- [ ] **Step 5: Run tests and confirm GREEN**

Run the Step 2 command.

- [ ] **Step 6: Commit**

```bash
git add lib/config.ts .env.example tests/setup.ts lib/agents/litellm/types.ts tests/litellmCatalog.test.ts
git commit -m "feat: define LiteLLM route configuration"
```

## Task 3: Validate Operator tags fail-closed

**Files:**
- Create: `lib/agents/litellm/catalog.ts`
- Modify: `tests/litellmCatalog.test.ts`

- [ ] **Step 1: Add failing parser tests**

Cover:

```ts
const result = parseLiteLLMModelInfo({
  data: [
    {
      model_name: "operator.frontier",
      model_info: {
        operator: {
          enabled: true,
          label: "Operator Frontier",
          kind: "coding",
          harnesses: ["codex"],
          description: "Quality-first",
          context_window: 1_000_000,
          sort_order: 10,
        },
      },
      litellm_params: { model: "openrouter/secret-physical-name", api_key: "secret" },
    },
  ],
});
expect(result.models).toEqual([{
  value: "operator.frontier",
  label: "Operator Frontier",
  description: "Quality-first",
  kind: "coding",
  harnesses: ["codex"],
  contextWindow: 1_000_000,
  reasoningOptions: [],
  sortOrder: 10,
}]);
expect(JSON.stringify(result)).not.toContain("secret");
```

Also test disabled entries, unrelated `task.*` aliases, `kind: image`, missing
labels, empty/unknown harnesses, duplicate names, invalid context windows, and
one invalid entry alongside one valid entry.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/litellmCatalog.test.ts
```

- [ ] **Step 3: Implement the pure parser**

Expose:

```ts
export function parseLiteLLMModelInfo(raw: unknown): LiteLLMParseResult;
export function replaceLiteLLMCatalog(next: LiteLLMCatalogSnapshot): void;
export function getLiteLLMCatalog(): LiteLLMCatalogSnapshot;
export function modelForHarness(value: string, harness: "codex" | "claude"): LiteLLMModel | null;
```

Use explicit type guards. Return sanitized errors as
`{ model: string, error: string }[]`. Sort by `sortOrder`, then label.

- [ ] **Step 4: Run tests and confirm GREEN**

Run the Step 2 command.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/litellm/catalog.ts tests/litellmCatalog.test.ts
git commit -m "feat: validate Operator-tagged LiteLLM models"
```

## Task 4: Persist and refresh the last-known-good catalog

**Files:**
- Create: `lib/agents/litellm/catalog-store.ts`
- Create: `tests/litellmCatalogStore.test.ts`
- Create: `app/api/agents/litellm-codex/models/refresh/route.ts`
- Create: `tests/litellmRefreshRoute.test.ts`

- [ ] **Step 1: Write failing cache and route tests**

Pin these behaviors:

```ts
await refreshLiteLLMCatalog(fetchOk);
expect(JSON.parse(getSetting("agent_model_catalog:litellm-codex")!)).toMatchObject({
  models: [{ value: "operator.frontier" }],
});

await expect(refreshLiteLLMCatalog(fetch503)).rejects.toThrow(/503/);
expect(getLiteLLMCatalog().models[0].value).toBe("operator.frontier");
```

The route test must prove:

- `POST` returns the sanitized catalog and excluded-entry errors.
- upstream authorization failure returns a sanitized 502 response;
- the response never contains `api_key`, `litellm_params`, or the gateway token;
- an empty valid refresh does not erase a nonempty last-known-good snapshot.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/litellmCatalogStore.test.ts tests/litellmRefreshRoute.test.ts
```

- [ ] **Step 3: Implement hydration and refresh**

Use:

```ts
const SETTING_KEY = "agent_model_catalog:litellm-codex";

export function hydrateLiteLLMCatalog(): LiteLLMCatalogSnapshot {
  const saved = getSetting(SETTING_KEY);
  // Parse persisted sanitized shape; ignore corrupt state without throwing.
}

export async function refreshLiteLLMCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<LiteLLMRefreshResult> {
  const response = await fetchImpl(`${LITELLM_BASE_URL.replace(/\/v1$/, "")}/model/info`, {
    headers: { Authorization: `Bearer ${LITELLM_API_KEY}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  // Validate, preserve last-known-good on failure/empty result, persist sanitized JSON.
}
```

- [ ] **Step 4: Implement the route through `apiGuard`**

The route calls `refreshLiteLLMCatalog()` and returns only
`{ models, errors, refreshedAt, stale: false }`.

- [ ] **Step 5: Run tests and confirm GREEN**

Run the Step 2 command.

- [ ] **Step 6: Commit**

```bash
git add lib/agents/litellm/catalog-store.ts app/api/agents/litellm-codex/models/refresh/route.ts tests/litellmCatalogStore.test.ts tests/litellmRefreshRoute.test.ts
git commit -m "feat: refresh and cache LiteLLM model catalog"
```

## Task 5: Register managed LiteLLM capabilities without loading SDKs

**Files:**
- Create: `lib/agents/litellm/capabilities.ts`
- Modify: `lib/agents/types.ts`
- Modify: `lib/agents/capabilities.ts`
- Modify: `app/orchestrator/types.ts`
- Modify: `tests/agentSwitch.test.ts`
- Modify: `tests/importGraph.test.ts`

- [ ] **Step 1: Write failing registration and import-graph tests**

Add:

```ts
expect(knownAgentIds()).toContain("litellm-codex");
expect(isKnownAgent("litellm-codex")).toBe(true);
expect(getCapabilities("litellm-codex").models).toEqual([]);
```

After replacing the in-memory catalog fixture, expect the dynamic model list.
Pin that `lib/agents/capabilities.ts` cannot reach `@openai/codex-sdk`,
`lib/agents/litellm/driver.ts`, or `lib/store.ts`.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/agentSwitch.test.ts tests/importGraph.test.ts tests/litellmCatalog.test.ts
```

- [ ] **Step 3: Extend descriptor types**

Add:

```ts
connectionStyle: "paste_code" | "device_code" | "managed_endpoint";
```

Rename no existing JSON fields. Preserve `loginStyle` as a backward-compatible
alias during this phase if removing it would broaden the change.

Build LiteLLM capabilities from sanitized catalog entries compatible with
`codex`; use a conservative 200,000 context window only when metadata is absent
and mark that option `contextWindowKnown: false`.

- [ ] **Step 4: Register the SDK-free capability**

Add `litellm-codex` to the static known-ID map using a getter/function that reads
only the pure in-memory catalog module.

- [ ] **Step 5: Run tests and confirm GREEN**

Run the Step 2 command.

- [ ] **Step 6: Commit**

```bash
git add lib/agents/litellm/capabilities.ts lib/agents/types.ts lib/agents/capabilities.ts app/orchestrator/types.ts tests/agentSwitch.test.ts tests/importGraph.test.ts tests/litellmCatalog.test.ts
git commit -m "feat: expose dynamic LiteLLM capabilities"
```

## Task 6: Add a credential-isolating loopback relay

**Files:**
- Create: `lib/agents/litellm/relay.ts`
- Create: `tests/litellmRelay.test.ts`

- [ ] **Step 1: Write failing relay tests**

Use an in-process fake upstream and assert:

```ts
const relay = await getLiteLLMRelay();
const response = await fetch(`${relay.baseUrl}/responses`, {
  method: "POST",
  headers: { Authorization: "Bearer harmless-child-token" },
  body: JSON.stringify({ model: "operator.frontier", input: "test" }),
});
expect(await response.json()).toEqual({ ok: true });
expect(upstreamAuthorization).toBe(`Bearer ${testGatewayToken}`);
expect(upstreamBody.model).toBe("operator.frontier");
```

Also prove loopback-only binding, streaming response passthrough, method/path/query
preservation, timeout/abort propagation, upstream error status passthrough,
incoming Authorization replacement, and no gateway token in returned errors.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/litellmRelay.test.ts
```

- [ ] **Step 3: Implement a singleton relay**

Bind an HTTP server to `127.0.0.1` on an ephemeral port. Forward only `/v1/*`
requests to `LITELLM_BASE_URL`, replace Authorization with the real gateway
token, remove hop-by-hop headers, and stream bodies in both directions.

Expose:

```ts
export async function getLiteLLMRelay(): Promise<{
  baseUrl: string;
  childApiKey: "operator-loopback-relay";
}>;
```

Store the singleton on `globalThis` so Next HMR cannot create multiple relays.

- [ ] **Step 4: Prove the child environment receives no real token**

Add a test that builds the exact driver child env and asserts:

```ts
expect(Object.values(childEnv)).not.toContain(testGatewayToken);
expect(childEnv.CODEX_API_KEY).toBeUndefined();
```

The SDK may inject only the harmless relay token.

- [ ] **Step 5: Run tests and confirm GREEN**

Run the Step 2 command.

- [ ] **Step 6: Commit**

```bash
git add lib/agents/litellm/relay.ts tests/litellmRelay.test.ts
git commit -m "feat: isolate LiteLLM gateway credentials"
```

## Task 7: Implement the `litellm-codex` driver

**Files:**
- Create: `lib/agents/litellm/driver.ts`
- Modify: `lib/agents/registry.ts`
- Create: `tests/litellmDriver.test.ts`
- Modify: `tests/agentDriver.test.ts`

- [ ] **Step 1: Write a failing driver-contract test**

Mock the Codex SDK boundary and assert the real runner receives normalized model,
assistant, tool, usage, and done events. Pin construction:

```ts
expect(Codex).toHaveBeenCalledWith(expect.objectContaining({
  baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
  apiKey: "operator-loopback-relay",
  env: expect.objectContaining({ CODEX_HOME: LITELLM_CODEX_HOME }),
}));
expect(Codex).not.toHaveBeenCalledWith(expect.objectContaining({
  baseUrl: LITELLM_BASE_URL,
  apiKey: LITELLM_API_KEY,
}));
```

Test exact model forwarding, isolated worktree, resume ID, Stop behavior,
reasoning allowlist, missing/removed model rejection, MCP configuration, and no
change to native `codexDriver`.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/litellmDriver.test.ts tests/agentDriver.test.ts
```

- [ ] **Step 3: Implement the driver**

Use the existing Codex event mapper and shared prompt builders. Before inference:

```ts
const selected = modelForHarness(task.model ?? "", "codex");
if (!selected) {
  yield { type: "error", content: `LiteLLM model "${task.model || "Default"}" is unavailable. Refresh the catalog and choose an available model.` };
  yield { type: "done", sessionId: task.session_id };
  return;
}
mkdirSync(LITELLM_CODEX_HOME, { recursive: true, mode: 0o700 });
const relay = await getLiteLLMRelay();
```

Create the SDK client with relay URL/key and `CODEX_HOME`. Pass the exact selected
model in `ThreadOptions`; never omit it. Reproduce Codex run controls without
changing `lib/agents/codex/driver.ts`.

- [ ] **Step 4: Add managed auth stubs**

`authStatus()` reports authenticated only when a valid hydrated catalog exists.
`verify()` refreshes the gateway catalog. Login methods return an actionable
managed-endpoint message and are never rendered by the UI.

- [ ] **Step 5: Register the driver and run focused tests**

Run the Step 2 command plus:

```bash
npx vitest run tests/agentSwitch.test.ts tests/importGraph.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add lib/agents/litellm/driver.ts lib/agents/registry.ts tests/litellmDriver.test.ts tests/agentDriver.test.ts
git commit -m "feat: run LiteLLM models through Codex harness"
```

## Task 8: Add transcript summarization and isolated session index

**Files:**
- Create: `lib/agents/litellm/session-index.ts`
- Modify: `lib/agents/litellm/driver.ts`
- Modify: `lib/agents/types.ts`
- Modify: `lib/agents/oneshots.ts`
- Create: `tests/litellmSessionIndex.test.ts`
- Modify: `tests/agentFallback.test.ts`
- Modify: `tests/agentSwitch.test.ts`

- [ ] **Step 1: Write failing session-index tests**

Assert a 0600 append-only JSONL record containing only:

```ts
{
  session_id: "thread-123",
  task_id: "task-1",
  project_id: "project-1",
  task_title: "Implement feature",
  project_path: "/workspace/project",
  harness: "codex",
  model: "operator.frontier",
  updated_at: "2026-08-07T12:00:00.000Z",
}
```

Assert it contains no prompt, response, tool input, API key, or environment.
Repeated writes for the same session append a newer record; consumers use last
record wins.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/litellmSessionIndex.test.ts tests/agentSwitch.test.ts
```

- [ ] **Step 3: Implement index append**

Write to `${LITELLM_CODEX_HOME}/operator-session-index.jsonl` using an append
operation and enforce 0600 permissions.

- [ ] **Step 4: Implement `/clear` summarization**

Extend the optional helper signature without changing native behavior:

```ts
canSummarizeTranscript?(task: Task): boolean;
summarizeTranscript?(
  transcript: string,
  project: Project,
  task?: Task,
): Promise<string>;
```

Make `lib/agents/oneshots.ts` pass the task as the third argument and choose the
utility helper when `canSummarizeTranscript(task) === false`. Existing
Claude/Codex drivers omit the predicate and keep their current behavior. The
LiteLLM driver returns false when `task.model` is no longer a current compatible
catalog entry, and otherwise summarizes through that exact model using a bounded
read-only Codex run through the same relay. Update `agentFallback.test.ts` to pin
both the task-aware preferred path and the pre-call utility fallback; never
select another gateway model silently.

- [ ] **Step 5: Verify handoff behavior**

Extend tests so a started `litellm-codex` task can hand off to native Claude or
Codex via the existing clear route, while direct PATCH remains forbidden.

- [ ] **Step 6: Run tests and confirm GREEN**

Run the Step 2 command and `npx vitest run tests/contextRefresh.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add lib/agents/litellm/session-index.ts lib/agents/litellm/driver.ts lib/agents/types.ts lib/agents/oneshots.ts tests/litellmSessionIndex.test.ts tests/agentFallback.test.ts tests/agentSwitch.test.ts
git commit -m "feat: preserve LiteLLM harness session metadata"
```

## Task 9: Add explicit model compatibility verification

**Files:**
- Create: `app/api/agents/litellm-codex/models/verify/route.ts`
- Create: `lib/agents/litellm/verification.ts`
- Create: `tests/litellmVerification.test.ts`
- Modify: `lib/agents/litellm/types.ts`

- [ ] **Step 1: Write failing verification tests**

Pin a read-only one-tool-call probe, persisted result keyed by
`litellm-codex:<model>`, sanitized errors, 30-second timeout, and no automatic
probe during refresh.

Expected result:

```ts
{
  model: "operator.frontier",
  harness: "codex",
  status: "compatible",
  verifiedAt: expect.any(String),
  error: null,
}
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/litellmVerification.test.ts tests/litellmRefreshRoute.test.ts
```

- [ ] **Step 3: Implement explicit verification**

Use a temporary read-only Codex thread through the relay. Prompt it to read one
known fixture file and answer with a fixed token. Store only status, timestamp,
model, harness, and sanitized error in SQLite settings.

- [ ] **Step 4: Implement the route**

Accept only `{ model: string }`, require the model to be currently tagged for
Codex, and return 400 for unknown/unavailable models.

- [ ] **Step 5: Run tests and confirm GREEN**

Run the Step 2 command.

- [ ] **Step 6: Commit**

```bash
git add app/api/agents/litellm-codex/models/verify/route.ts lib/agents/litellm/verification.ts lib/agents/litellm/types.ts tests/litellmVerification.test.ts
git commit -m "feat: verify LiteLLM model compatibility"
```

## Task 10: Add managed connection, refresh, and model-state UI

**Files:**
- Modify: `app/api/agents/route.ts`
- Modify: `app/orchestrator/AgentConnect.tsx`
- Modify: `app/orchestrator/SessionView.tsx`
- Modify: `app/orchestrator/types.ts`
- Modify: `app/globals.css`
- Create: `tests/litellmAgentUi.test.ts`

- [ ] **Step 1: Write failing UI/API tests**

Pin:

- `GET /api/agents` hydrates the snapshot before serializing capabilities;
- `litellm-codex` reports `managed_endpoint`;
- connected/degraded/disconnected state;
- Settings renders Verify and Refresh, never Sign in or API-key fields;
- the agent picker labels the new route `LiteLLM · Codex harness` in Phase 1;
- the session model picker has a Refresh action;
- invalid entries appear only in the refresh result;
- a selected removed model reads `Unavailable: <name>`;
- unverified model start shows a paid-request confirmation.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/litellmAgentUi.test.ts tests/agentSwitch.test.ts
```

- [ ] **Step 3: Hydrate capabilities in `GET /api/agents`**

Call `hydrateLiteLLMCatalog()` before `listDrivers()`. For managed endpoints,
derive connection state from the catalog snapshot rather than login records.
Do not shell out or call paid inference on GET.

- [ ] **Step 4: Render managed endpoint controls**

In `AgentConnect`, branch on `connectionStyle === "managed_endpoint"` and render:

```tsx
<button onClick={refresh}>Refresh models</button>
<button onClick={verifySelected} disabled={!selectedModel}>Test selected model</button>
```

Show last refresh time, model count, stale state, and sanitized error.

Keep the stored agent ID concrete (`litellm-codex`) while presenting the
user-facing route/harness split. Phase 1 has one LiteLLM harness, so the agent
row reads `LiteLLM · Codex harness`; Phase 2 may group
`litellm-codex`/`litellm-claude` under one LiteLLM route without migrating task
rows.

- [ ] **Step 5: Add picker refresh and unavailable state**

Refresh calls the route, then reloads `/api/agents`. Never set task.model to
null when the previous value disappears. Display and block it until Geo chooses
an available entry.

- [ ] **Step 6: Run tests and confirm GREEN**

Run the Step 2 command.

- [ ] **Step 7: Commit**

```bash
git add app/api/agents/route.ts app/orchestrator/AgentConnect.tsx app/orchestrator/SessionView.tsx app/orchestrator/types.ts app/globals.css tests/litellmAgentUi.test.ts
git commit -m "feat: manage LiteLLM models in Operator UI"
```

## Task 11: Document the gateway metadata contract

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `.env.example`
- Modify: `/Users/geo/Claude Projects/LiteLLM server/docs/HOW-TO-PLUG-IN.md`
- Test: `/Users/geo/Claude Projects/LiteLLM server/tests/gateway/test_docs.py`
- Test: `/Users/geo/Claude Projects/LiteLLM server/tests/gateway/test_config.py`

- [ ] **Step 1: Add failing LiteLLM documentation/config contract tests**

Require documentation of:

- `model_info.operator.enabled`;
- `kind: coding`;
- `harnesses: ["codex"]`;
- dedicated `OPENROUTER_OPERATOR_API_KEY`;
- Operator never receiving the provider key;
- validation/reload steps;
- no concrete provider model required by Operator code.

- [ ] **Step 2: Run LiteLLM focused tests and confirm RED**

From `/Users/geo/Claude Projects/LiteLLM server`:

```bash
.venv/bin/python -m pytest tests/gateway/test_docs.py tests/gateway/test_config.py -q
```

- [ ] **Step 3: Document the contract in both repositories**

Add a complete YAML example using a clearly illustrative model ID. Do not add
or modify a production model entry and do not create the dedicated provider key
without Geo explicitly supplying/authorizing that credential operation.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command plus:

```bash
scripts/validate-config.sh
```

- [ ] **Step 5: Commit repository changes separately**

In LiteLLM:

```bash
git add docs/HOW-TO-PLUG-IN.md tests/gateway/test_docs.py tests/gateway/test_config.py
git commit -m "docs: define Operator model metadata"
```

In Operator:

```bash
git add README.md docs/ARCHITECTURE.md .env.example
git commit -m "docs: explain LiteLLM coding-agent route"
```

## Task 12: Full regression and release evidence

**Files:**
- Modify only if verification exposes a defect in files already owned by this plan.

- [ ] **Step 1: Run Operator focused suites**

```bash
npx vitest run \
  tests/modelLabel.test.ts \
  tests/codexReasoning.test.ts \
  tests/litellmCatalog.test.ts \
  tests/litellmCatalogStore.test.ts \
  tests/litellmRefreshRoute.test.ts \
  tests/litellmRelay.test.ts \
  tests/litellmDriver.test.ts \
  tests/litellmSessionIndex.test.ts \
  tests/litellmVerification.test.ts \
  tests/litellmAgentUi.test.ts \
  tests/agentDriver.test.ts \
  tests/agentSwitch.test.ts \
  tests/importGraph.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the full Operator verification**

```bash
npm run verify
```

Expected: production audit, all Vitest files, TypeScript, production build, and
trace validation pass.

- [ ] **Step 3: Run the LiteLLM offline suite**

From `/Users/geo/Claude Projects/LiteLLM server`:

```bash
.venv/bin/python -m pytest -m "not live" -q
scripts/validate-config.sh
git diff --check
```

Expected: all offline tests and both config validations pass.

- [ ] **Step 4: Perform an isolated no-cost smoke test**

Start a temporary fake OpenAI-compatible upstream and point an isolated Operator
test process at it. Verify refresh, model selection, tool event normalization,
session index creation, Stop, and resume without contacting a paid provider.

- [ ] **Step 5: Gate paid live verification**

Do not add a production Operator-tagged model, create a new OpenRouter key,
reload LiteLLM, restart Operator, or run a paid compatibility test without
Geo's explicit operational authorization. Report the exact remaining live steps.

- [ ] **Step 6: Prepare the next independent plans**

After Phase 1B is stable, write:

- `docs/superpowers/plans/2026-08-07-operator-conversation-source.md`
- the Card Tracker plan in its own repository;
- `docs/superpowers/plans/2026-08-07-litellm-claude-harness.md`

Each plan must have its own TDD and release gate.
