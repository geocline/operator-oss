# Option A Card Workstreams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Geo-triggered, private card-to-Operator workstream with safe automatic comments and files, durable retries, pause and disconnect controls, and approval-gated consequential card changes.

**Architecture:** The tracker owns the card-facing workstream state and approval records. Operator owns the task link and durable delivery outbox. A dedicated bridge secret authenticates server-to-server calls. Harnesses publish through one provider-neutral MCP tool, and a fail-closed privacy validator runs before every card-facing write.

**Tech Stack:** Next.js, TypeScript, React, SQLite with better-sqlite3, Supabase Postgres and Storage, MCP, Vitest

---

## Required safeguards

- Do not restart Operator while any task has `running=1`.
- Do not commit or push unless Geo explicitly asks.
- Preserve unrelated untracked files and foreign `.superpowers` artifacts.
- Preserve the tracker Refresh control and `attachmentSignedUrlOptions()`.
- Never post raw transcript text to a card.
- Use the visible author label `Workstream Update`.
- Do not use Ari for workstream comments or approvals.
- Use a dedicated bridge secret, not Operator's `SERVICE_TOKEN`.

### Task 1: Operator workstream persistence and privacy validation

**Files:**
- Modify: `lib/db.ts`
- Modify: `lib/store.ts`
- Create: `lib/workstreams/types.ts`
- Create: `lib/workstreams/sanitize.ts`
- Create: `lib/workstreams/store.ts`
- Test: `tests/workstreams.test.ts`
- Test: `tests/workstreamSanitize.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Test that one external card ID maps to one task, reactivation reuses the link, pause preserves queued events, disconnect blocks new events, and idempotency keys cannot create duplicate outbox rows.

- [ ] **Step 2: Run the focused tests and confirm feature-missing failures**

Run: `npm test -- tests/workstreams.test.ts`

Expected: FAIL because the workstream tables and store functions do not exist.

- [ ] **Step 3: Add SQLite schema**

Add `workstream_links` and `workstream_outbox` in `lib/db.ts`. Use foreign keys, check constraints, a unique active card mapping, and a unique outbox idempotency key. Do not add provider-specific columns to `tasks`.

- [ ] **Step 4: Add typed store operations**

Implement:

```ts
activateWorkstream(input)
getWorkstreamByTask(taskId)
getWorkstreamByExternalCard(provider, externalCardId)
setWorkstreamState(linkId, state)
enqueueWorkstreamEvent(input)
claimDueWorkstreamEvents(now, limit)
markWorkstreamDelivered(id)
markWorkstreamFailed(id, error, nextAttemptAt)
```

- [ ] **Step 5: Write failing privacy tests**

Cover user paths, Windows paths, `file://`, localhost, loopback and private URLs, Temp Outputs, handoff and prompt references, session IDs, UUIDs, internal task terms, branch and worktree terms, and the names Geo, George, Ari, Operator, Claude, Codex, ChatGPT, and harness.

Also cover clean status text and supported filenames.

- [ ] **Step 6: Run the privacy tests and confirm expected rejection failures**

Run: `npm test -- tests/workstreamSanitize.test.ts`

Expected: FAIL because `validateCardFacingText()` and `validateCardFacingFilename()` do not exist.

- [ ] **Step 7: Implement fail-closed validation**

Return a structured list of violations. Reject the whole payload instead of silently redacting it. Allow only HTML, PDF, XLSX, DOCX, PPTX, PNG, JPG, JPEG, GIF, and WEBP attachments.

- [ ] **Step 8: Run focused and full Operator tests**

Run:

```bash
npm test -- tests/workstreams.test.ts tests/workstreamSanitize.test.ts
npm test
```

Expected: all tests pass.

### Task 2: Tracker owner-only workstream schema and bridge API

**Files:**
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/supabase/migrations/0044_card_workstreams.sql`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/supabase/migrations/0045_workstream_actions.sql`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/lib/server/workstream-auth.ts`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/lib/server/workstream-policy.ts`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/app/api/cards/[id]/workstream/route.ts`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/app/api/workstream-bridge/exchange/route.ts`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/app/api/workstream-bridge/update/route.ts`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/app/api/workstream-bridge/proposals/route.ts`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/app/api/workstream-actions/[id]/approve/route.ts`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/app/api/workstream-actions/[id]/reject/route.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/.env.example`
- Test: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/lib/server/workstream-policy.test.mjs`

- [ ] **Step 1: Add a tracker test command using Node's built-in test runner**

Add a script that runs `.test.mjs` files without introducing a new runtime dependency.

- [ ] **Step 2: Write failing policy tests**

Test owner-email matching, fixed author attribution, allowed routine action kinds, approval-required action kinds, idempotency, state enforcement, field allowlists, and supported attachment formats.

- [ ] **Step 3: Run the policy test and confirm feature-missing failure**

Run: `npm run test:workstreams`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 4: Add migrations**

`0044_card_workstreams.sql` must create owner-only `card_workstreams` with activation-token hashing, active, paused, and disconnected states, timestamps, and RLS that requires both `owner_id = auth.uid()` and the configured Geo identity enforced at the API.

`0045_workstream_actions.sql` must create idempotent routine and proposed actions with pending, approved, rejected, executed, and failed states.

- [ ] **Step 5: Add session and bridge authentication**

Authenticated card routes require Geo's session and configured owner email. Bridge routes require `ARDENT_WORKSTREAM_BRIDGE_TOKEN` using constant-time comparison.

- [ ] **Step 6: Implement manual activation and token exchange**

The authenticated activation route creates or reactivates the workstream only after the click and returns a short-lived opaque token. The bridge exchange consumes that token once and returns only the card ID, card title, deal tag, project path needed for local routing, and workstream ID.

- [ ] **Step 7: Implement routine update delivery**

The bridge update route must:

1. Re-read workstream state.
2. Reject paused or disconnected delivery unless a verified post-now override exists.
3. Validate body and filenames.
4. Enforce idempotency.
5. Upload supported files to the existing private bucket.
6. Insert the normal comment with `author_label = 'Workstream Update'`.
7. Use the workstream owner as the required comment author.
8. Record success or failure.

- [ ] **Step 8: Implement proposed changes and atomic approval**

Only allow explicit card fields and action kinds. Approval must lock one pending row, apply it once through a fixed mapping, and record the authenticated decision. Unknown fields, arbitrary table names, and destructive actions without dedicated handlers must fail.

- [ ] **Step 9: Run tracker tests, lint, and build**

Run:

```bash
npm run test:workstreams
npm run lint
npm run build
```

Expected: all commands exit 0.

### Task 3: Manual activation and controls in both applications

**Files:**
- Modify: `app/open/route.ts`
- Create: `app/api/tasks/[id]/workstream/route.ts`
- Create: `app/api/tasks/[id]/workstream/[command]/route.ts`
- Create: `lib/workstreams/client.ts`
- Create: `lib/workstreams/delivery.ts`
- Modify: `app/orchestrator/types.ts`
- Modify: `app/orchestrator/SessionView.tsx`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/components/CardModal.tsx`
- Create: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/components/WorkstreamControls.tsx`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/lib/types.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/lib/store/types.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/lib/store/supabase.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/lib/store/local.ts`
- Test: `tests/openWorkstream.test.ts`

- [ ] **Step 1: Write failing activation and deduplication tests**

Test that activation creates or reuses the lane task by stable workstream or card ID, including when the linked task is done. Verify that a missing or invalid token creates nothing.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npm test -- tests/openWorkstream.test.ts`

Expected: FAIL because `/open` does not accept a workstream token or create a durable link.

- [ ] **Step 3: Implement Operator token exchange and task linking**

Keep session and path routing behavior. Add workstream activation as the first, explicit branch. Deduplicate by stable external card ID instead of a path embedded in task description.

- [ ] **Step 4: Add Operator task controls**

Show linked, paused, and disconnected state in the task header. Provide Pause, Resume, Post update now, and Disconnect. Disconnect keeps the task and transcript.

- [ ] **Step 5: Add Geo-only tracker controls**

Extract workstream UI from `CardModal.tsx`. Before activation show Work in Operator. After activation show Open in Operator, Pause or Resume updates, Post update now, Disconnect, and pending proposals.

Open a blank browser window synchronously before awaiting activation to avoid popup blocking.

- [ ] **Step 6: Preserve existing AI Workspace behavior**

Keep Create project folder, Refresh, Copy project path, Copy cd + claude, Check again, and Continue in Operator. Do not duplicate signed URL logic or change attachment rendering.

- [ ] **Step 7: Hide private integration data from non-owner users**

The workstream controls and project path must not render for Andrew or Don. Card-facing team comments and uploaded deliverables remain visible normally.

- [ ] **Step 8: Run focused tests and both builds**

Run:

```bash
npm test -- tests/openWorkstream.test.ts
npm run build
cd "/Users/geo/Claude Projects/Ardent/deal-tracker-app/app" && npm run lint && npm run build
```

Expected: all commands exit 0.

### Task 4: Harness-neutral update and proposal tools

**Files:**
- Modify: `lib/agentToolDefs.mjs`
- Modify: `lib/agentTools.ts`
- Modify: `scripts/orch-mcp.mjs`
- Modify: `lib/agents/claude/driver.ts`
- Modify: `lib/agents/shared.ts`
- Create: `app/api/internal/agent-tools/publish-workstream-update/route.ts`
- Create: `app/api/internal/agent-tools/propose-card-change/route.ts`
- Modify: `tests/orchMcp.test.ts`
- Modify: `tests/agentTools.test.ts`

- [ ] **Step 1: Write failing MCP bridge tests**

Require `publish_workstream_update` and `propose_card_change` in the portable tool list. Verify task and project scoping, fixed author behavior, privacy failures, paused state, idempotency, and proposal queuing.

- [ ] **Step 2: Run focused tests and confirm the tools are missing**

Run: `npm test -- tests/orchMcp.test.ts tests/agentTools.test.ts`

Expected: FAIL because the tool definitions and routes do not exist.

- [ ] **Step 3: Add shared tool definitions**

`publish_workstream_update` accepts a concise self-contained body and optional supported files. It never accepts an author, agent, session, source, card ID, or workstream ID from the model.

`propose_card_change` accepts one allowlisted action kind and structured value. The task link determines the target card.

- [ ] **Step 4: Implement shared tool behavior**

Resolve the link from the current task, validate before enqueueing, persist to the outbox, attempt immediate delivery, and return a clear delivered, queued, paused, disconnected, or rejected result.

- [ ] **Step 5: Mount the tools for all harnesses**

Add both tools to Claude's in-process MCP server and the portable stdio bridge used by Codex and future drivers.

- [ ] **Step 6: Add linked-task runtime guidance**

Append a short Operator-owned runtime rule only when a task has an active workstream. Tell the harness to use the structured tool for team-facing updates and never copy raw internal detail. Do not put these behavior rules in project context, CLAUDE.md, AGENTS.md, or card content.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
npm test -- tests/orchMcp.test.ts tests/agentTools.test.ts
npm test
```

Expected: all tests pass.

### Task 5: Durable retry, lifecycle templates, and approval UI

**Files:**
- Create: `lib/workstreams/worker.ts`
- Create: `app/api/internal/workstreams/restore/route.ts`
- Modify: `server.js`
- Modify: `lib/runner.ts`
- Modify: `app/api/tasks/[id]/route.ts`
- Modify: `app/api/tasks/[id]/route.ts`
- Modify: `app/orchestrator/SessionView.tsx`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/src/components/WorkstreamControls.tsx`
- Test: `tests/workstreamDelivery.test.ts`
- Test: `tests/runnerWorkstream.test.ts`

- [ ] **Step 1: Write failing retry and lifecycle tests**

Test restart recovery, exponential retry, no delivery while paused, delivery after resume, no duplicate comment after timeout, template start and input-needed notices, and no completion notice on ordinary turn end.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- tests/workstreamDelivery.test.ts tests/runnerWorkstream.test.ts`

Expected: FAIL because the worker and lifecycle integration do not exist.

- [ ] **Step 3: Implement outbox delivery**

Claim rows transactionally, deliver with a bounded timeout, mark delivered by idempotency key, and retry temporary failures. Permanent privacy or policy failures remain visible and do not retry forever.

- [ ] **Step 4: Restore pending delivery at boot**

Use the existing startup restoration pattern and idle accounting. Do not clear the workstream outbox on startup.

- [ ] **Step 5: Add template lifecycle events**

Queue only deterministic templates for activation, work start, input needed, pause, resume, and explicit manual completion. Do not infer completion from `turn_end`.

- [ ] **Step 6: Implement proposal approval controls**

Render pending changes in the private AI Workspace area with old and proposed values, Approve, and Reject. Refresh the card after an executed approval.

- [ ] **Step 7: Run focused and full verification**

Run:

```bash
npm test -- tests/workstreamDelivery.test.ts tests/runnerWorkstream.test.ts
npm test
npm run build
cd "/Users/geo/Claude Projects/Ardent/deal-tracker-app/app" && npm run test:workstreams && npm run lint && npm run build
```

Expected: all commands exit 0.

### Task 6: Rules, deployment preparation, and browser verification

**Files:**
- Modify: `/Users/geo/Claude Projects/Ardent/CLAUDE.md`
- Modify: `/Users/geo/.claude/skills/deal-tracker-card/SKILL.md`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/src/index.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/src/db.ts`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-mcp/card_admin.mjs`
- Modify: `HANDOFF.md`
- Modify: `/Users/geo/Claude Projects/Ardent/deal-tracker-app/tasks/todo.md`
- Create: `option-a-implementation-report.html`

- [ ] **Step 1: Align card-writing rules**

Document Workstream Update as the only visible identity for linked workstream comments. Keep Ari separate. Remove conflicting instructions that require Geo's Claude or Geo's Codex for this path.

- [ ] **Step 2: Harden the legacy MCP path**

Make workstream posting require activation state, fixed neutral attribution, privacy validation, and idempotency. Keep unrelated manual MCP behavior compatible.

- [ ] **Step 3: Strengthen the final sweep**

Add case-insensitive checks for names, harness terminology, UUIDs, internal URLs, paths, and forbidden attachment formats.

- [ ] **Step 4: Prepare secrets without exposing them**

Generate a dedicated bridge token and add it to local ignored env files. Do not print it, commit it, or reuse `SERVICE_TOKEN`.

- [ ] **Step 5: Apply tracker migrations only after local verification**

Run migrations 0044 and 0045 through the established production process. Verify tables, constraints, RLS, and function definitions before dependent deployment.

- [ ] **Step 6: Verify tracker in a signed-in browser**

Verify Geo-only controls, manual activation, normal Comments attribution, pause, resume, post-now, disconnect, proposal approval, Refresh, Continue in Operator, offline Check again, and attachment download behavior.

- [ ] **Step 7: Verify Operator restart safely**

Run:

```sql
SELECT title FROM tasks WHERE running=1;
```

Only when zero rows are returned, build Operator, restart its launchd services, check health, and verify the linked task UI.

- [ ] **Step 8: Produce the HTML implementation report**

Record files changed, tests and builds run, migration and deployment state, browser results, any remaining manual steps, and recovery instructions. Do not claim completion without fresh command evidence.
