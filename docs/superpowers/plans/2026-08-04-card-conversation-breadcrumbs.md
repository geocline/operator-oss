# Card Conversation Breadcrumbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically attach the exact creating or updating coding conversation to a tracker card and visibly attribute automated comments to Geo's Bot.

**Architecture:** The MCP resolves a normalized session context from trusted Claude, Codex, or Operator runtime identity and retrieves exact metadata from the conversations dashboard. Standalone card writes upsert the breadcrumb directly. Linked Operator sessions register through a dedicated authenticated tracker bridge route after the provider returns its exact session ID. No component may guess the newest conversation.

**Tech Stack:** TypeScript, MCP, Next.js, Supabase, SQLite, Vitest, Node test runner

---

## File map

- `deal-tracker-mcp/src/session-context.ts`: Resolve and validate exact native session identity.
- `deal-tracker-mcp/src/tracker.ts`: Fetch exact session metadata from the local dashboard.
- `deal-tracker-mcp/src/db.ts`: Upsert the breadcrumb after standalone card/comment writes.
- `deal-tracker-mcp/src/index.ts`: Return structured breadcrumb status and fixed Geo's Bot attribution.
- `deal-tracker-app/app/src/app/api/workstream-bridge/conversation/route.ts`: Register linked Operator sessions.
- `deal-tracker-app/app/supabase/migrations/0044_card_workstreams.sql`: Fix linked comment attribution.
- `operator/lib/workstreams/client.ts`: Call the linked-session registration route.
- `operator/lib/runner.ts`: Register the exact provider session on the first session event.
- `Ardent/CLAUDE.md` and the `deal-tracker-card` skill: Require automatic exact breadcrumbs without manual session guessing.

### Task 1: Resolve exact standalone session identity

**Files:**
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/src/session-context.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/src/tracker.ts`
- Test: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/test/session-context.test.mjs`

- [ ] **Step 1: Write failing resolver tests**

Cover normalized injected context, `CLAUDE_SESSION_ID`,
`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, and
`CODEX_COMPANION_SESSION_ID`. Prove precedence is deterministic, invalid IDs
are rejected, and no resolver consults a newest-session endpoint.

```ts
export interface ConversationContext {
  sessionId: string;
  source: "claude" | "codex";
  projectPath?: string;
}

export function resolveConversationContext(
  env: NodeJS.ProcessEnv,
): ConversationContext | null;
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
node --test test/session-context.test.mjs
```

Expected: module or export missing.

- [ ] **Step 3: Implement the resolver**

Use this priority:

```text
DEAL_TRACKER_SESSION_ID + DEAL_TRACKER_SESSION_SOURCE
CLAUDE_SESSION_ID
CLAUDE_CODE_SESSION_ID
CODEX_THREAD_ID
CODEX_COMPANION_SESSION_ID
```

Accept UUIDs and provider-safe opaque identifiers only. Never search by recency.

- [ ] **Step 4: Add exact dashboard lookup**

Add:

```ts
export interface ExactConversation {
  session_id: string;
  source: "claude" | "codex";
  title: string;
  summary: string;
  project_path: string;
  modified_at: string | null;
}

export async function getExactConversation(
  sessionId: string,
): Promise<ExactConversation>;
```

Call the exact session endpoint. Validate that the returned `session_id`
matches the requested identifier.

- [ ] **Step 5: Run focused tests**

Expected: all resolver and exact-lookup tests pass.

### Task 2: Attach breadcrumbs after standalone card writes

**Files:**
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/src/db.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/src/index.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/test/smoke.mjs`
- Test: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/test/breadcrumbs.test.mjs`

- [ ] **Step 1: Write failing breadcrumb tests**

Test:

- `create_card` upserts exactly one `card_conversations` row.
- Repeating the same card/session pair is idempotent.
- `add_comment` refreshes or creates the current breadcrumb.
- Dashboard failure preserves the valid card/comment result and returns
  `needs_retry`.
- Missing trusted session identity returns `unavailable`.
- No fallback selects the newest conversation.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
node --test test/breadcrumbs.test.mjs
```

- [ ] **Step 3: Add structured breadcrumb status**

```ts
export type BreadcrumbStatus =
  | { status: "attached"; session_id: string }
  | { status: "already_attached"; session_id: string }
  | { status: "needs_retry"; session_id: string; reason: string }
  | { status: "unavailable"; reason: string };
```

Do not expose local paths in the human-readable MCP text response.

- [ ] **Step 4: Implement idempotent upsert**

Use the existing `(card_id, session_id)` conflict key and set:

```ts
{
  card_id,
  session_id,
  source,
  title,
  summary,
  project_path,
  session_modified,
  added_by: ownerId
}
```

Return `attached` or `already_attached` based on the existing row.

- [ ] **Step 5: Integrate card creation and comments**

After the primary write succeeds, resolve and attach the breadcrumb. Never roll
back a successful card or comment because the local dashboard is offline.

Set standalone automated comment attribution to:

```ts
export const MANUAL_COMMENT_AUTHOR_LABEL = "Geo's Bot";
```

- [ ] **Step 6: Verify standalone behavior**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all MCP tests and TypeScript build pass.

### Task 2A: Expose exact annotation revision from the conversation dashboard

**Files:**
- Modify: `/Users/geo/Claude Projects/conversations-dashboard/main.py`
- Test: `/Users/geo/Claude Projects/conversations-dashboard/test_session_detail.py`

- [ ] **Step 1: Write the failing endpoint test**

Create a session and annotation whose transcript modification and annotation
update times differ. Assert `GET /api/sessions/{session_id}` returns both the
session modification value and `annotation_updated`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
python3 -m pytest test_session_detail.py -q
```

Expected: `annotation_updated` is absent.

- [ ] **Step 3: Return the stored annotation revision**

Include `a.updated AS annotation_updated` in the exact-session query and return
the value as `annotation_updated`. Do not change search ranking or introduce a
recent-session fallback.

- [ ] **Step 4: Use the effective revision in the MCP**

Set exact-conversation `modified_at` to the latest valid timestamp across the
session modification time and `annotation_updated`. Preserve compare-and-set
ordering so older metadata cannot overwrite newer metadata.

- [ ] **Step 5: Verify dashboard and MCP**

Run:

```bash
cd "/Users/geo/Claude Projects/conversations-dashboard"
python3 -m pytest test_session_detail.py -q

cd "/Users/geo/Claude Projects/Ardent/deal-tracker-mcp"
npm test
npm run build
```

### Task 3: Register exact linked Operator sessions

**Files:**
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/app/api/workstream-bridge/conversation/route.ts`
- Modify: `/Users/geo/Claude Projects/operator/lib/workstreams/client.ts`
- Modify: `/Users/geo/Claude Projects/operator/lib/runner.ts`
- Test: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/tests/workstreams/routes.test.ts`
- Test: `/Users/geo/Claude Projects/operator/tests/runnerWorkstream.test.ts`

- [ ] **Step 1: Write failing bridge and runner tests**

Prove:

- The bridge route requires the dedicated bridge token.
- The route resolves the card through the workstream ID.
- The route upserts only the exact supplied provider session.
- Operator invokes registration on the first exact provider `session` event.
- Retries use the same card/session key.
- Registration failure does not abort the coding turn.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
cd "/Users/geo/Claude Projects/operator"
npm test -- tests/runnerWorkstream.test.ts

cd "/Users/geo/Claude Projects/Ardent/deal-tracker-app/app"
npm run test:workstreams
```

- [ ] **Step 3: Implement the tracker bridge route**

Request:

```ts
{
  workstream_id: string;
  session_id: string;
  source: "claude" | "codex";
  title?: string;
  summary?: string;
  project_path?: string;
  session_modified?: string;
}
```

Authenticate with `ARDENT_WORKSTREAM_BRIDGE_TOKEN`, re-read the workstream and
card, reject closed/deleted cards, and upsert `card_conversations` with the
workstream owner as `added_by`.

- [ ] **Step 4: Add the Operator client**

```ts
export async function registerWorkstreamConversation(input: {
  externalWorkstreamId: string;
  sessionId: string;
  source: "claude" | "codex";
  title?: string;
  projectPath?: string;
}): Promise<WorkstreamBridgeResult>;
```

- [ ] **Step 5: Register from the runner**

When the driver emits the first exact `session` event, call the bridge once for
the linked task. Keep the coding turn independent of breadcrumb availability.
Do not register on guessed or synthetic session values.

- [ ] **Step 6: Run focused tests**

Expected: linked-session route and runner tests pass.

### Task 4: Apply final bot identity in tracker SQL and UI contracts

**Files:**
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/supabase/migrations/0044_card_workstreams.sql`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/lib/server/workstream-policy.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/tests/workstreams/policy.test.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/tests/workstreams/migrations.test.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/CLAUDE.md`
- Modify: `/Users/geo/.claude/skills/deal-tracker-card/SKILL.md`

- [ ] **Step 1: Write failing identity tests**

Assert the only linked comment label is:

```text
Geo's Bot · Workstream Update
```

Assert standalone MCP comments use:

```text
Geo's Bot
```

Assert no schema accepts arbitrary author, agent, source, or session-label
fields.

- [ ] **Step 2: Update the fixed SQL label**

Replace the linked workstream label in the posting RPC. Keep the underlying
owner foreign key unchanged.

- [ ] **Step 3: Update rules**

Document:

- exact automatic conversation breadcrumbs;
- no newest-session guessing;
- standalone bot label;
- linked workstream bot label;
- human browser comments remain human-attributed;
- no manual authorization phrase.

- [ ] **Step 4: Run tracker verification**

Run:

```bash
npm run test:workstreams
npm run lint
npx tsc --noEmit
npm run build
git diff --check
```

### Task 5: Cross-repository review, commit, push, migrate, and verify

**Files:**
- Create: `/Users/geo/Claude Projects/operator/card-conversation-breadcrumbs-implementation-report.html`
- Modify: `/Users/geo/Claude Projects/operator/HANDOFF.md`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/tasks/todo.md`

- [ ] **Step 1: Run all local verification**

Operator:

```bash
npm test
npx tsc --noEmit
npm run build
git diff --check
```

Tracker:

```bash
npm run test:workstreams
npm run lint
npx tsc --noEmit
npm run build
git diff --check
```

MCP:

```bash
npm test
npm run build
git diff --check
```

- [ ] **Step 2: Perform an independent final review**

Review exact-session identity, no-recency fallback, comment attribution,
workstream state, migrations, privacy, idempotency, and preservation of Refresh
and attachment behavior. Fix every blocking finding before rollout.

- [ ] **Step 3: Create production secrets**

Generate one dedicated bridge token. Store it only in ignored local Operator and
tracker environment files and in the tracker production environment. Never log
or commit it.

- [ ] **Step 4: Commit repositories in dependency order**

Use focused commits that include only this project:

```text
deal-tracker-mcp: feat: add exact card conversation breadcrumbs
deal-tracker-app: feat: add private card workstreams and bot breadcrumbs
operator: feat: add card-linked workstream delivery
Ardent root: docs: align tracker workstream rules
```

Do not stage unrelated dirty files.

- [ ] **Step 5: Push tracker dependencies and deploy**

Push the MCP repository if it has a configured remote. Push the tracker app and
confirm its production deployment is healthy. Push Operator after its full
suite remains green.

- [ ] **Step 6: Apply migrations in verified order**

Apply migrations `0044` and `0045` using the established production Supabase
process. Verify tables, functions, grants, RLS, legacy path removal, and fixed
labels before exercising write routes.

- [ ] **Step 7: Verify in a signed-in browser**

Create a test card from a real conversation, confirm the breadcrumb appears in
AI Workspace, click `Continue in Operator`, post a standalone bot comment, post
a linked workstream update, and verify the two exact visible labels.

Also verify Pause, Resume, Post update now, Disconnect, proposal approval,
Refresh, Continue in Operator, Check again, and attachment download behavior.

- [ ] **Step 8: Restart Operator safely**

Query:

```sql
SELECT title FROM tasks WHERE running=1;
```

Restart only when the result is empty. Then verify health, boot outbox restore,
and linked task controls.

- [ ] **Step 9: Produce the HTML report**

Record exact commits, pushes, deployment, migrations, browser evidence, service
state, recovery instructions, and any remaining limitations.

## Plan self-review

- Spec coverage: exact identity, create/update breadcrumbs, Operator-linked
  sessions, bot labels, safe failure, UI return path, and rollout are covered.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: session source, breadcrumb status, and bridge request names
  are consistent across tasks.
- Scope: all changes belong to the single breadcrumb and bot-attribution flow.
