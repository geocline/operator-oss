# Linked Workstream MCP Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Operator's non-interactive Codex tasks to execute the two task-scoped linked-workstream MCP writes without a nonexistent interactive approval prompt.

**Architecture:** Keep the current `approvalPolicy: "never"` and workspace sandbox. Add per-tool `approval_mode: "approve"` overrides only inside the dynamically registered `orchestrator` MCP server, leaving all other MCP tools and servers unchanged.

**Tech Stack:** TypeScript, OpenAI Codex SDK configuration, Vitest, Next.js, SQLite-backed Operator runtime.

---

### Task 1: Pin the narrow MCP approval contract

**Files:**
- Modify: `tests/codexReasoning.test.ts`
- Modify: `lib/agents/codex/driver.ts`

- [ ] **Step 1: Write the failing regression test**

Add this import and test to `tests/codexReasoning.test.ts`, following the
repository's existing source-contract test pattern:

```ts
import { readFile } from "node:fs/promises";

describe("codex orchestrator MCP approvals", () => {
  it("pre-approves only linked workstream writes for non-interactive turns", async () => {
    const source = await readFile(
      new URL("../lib/agents/codex/driver.ts", import.meta.url),
      "utf8",
    );
    const approvals = source.match(
      /tools:\s*\{([\s\S]*?)\n\s{10}\},\n\s{8}\},/,
    )?.[1];

    expect(approvals).toContain(
      'publish_workstream_update: { approval_mode: "approve" }',
    );
    expect(approvals).toContain(
      'propose_card_change: { approval_mode: "approve" }',
    );
    expect(approvals).not.toMatch(
      /\b(?:suggest_task|expose_service|ask_user)\b/,
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/codexReasoning.test.ts
```

Expected: FAIL because `orchestrator.tools` is currently undefined.

### Task 2: Add the minimal per-tool approval override

**Files:**
- Modify: `lib/agents/codex/driver.ts`
- Test: `tests/codexReasoning.test.ts`

- [ ] **Step 1: Implement the two explicit approvals**

Add the following inside the existing `orchestrator` MCP server configuration,
next to `tool_timeout_sec`:

```ts
tools: {
  publish_workstream_update: {
    approval_mode: "approve",
  },
  propose_card_change: {
    approval_mode: "approve",
  },
},
```

- [ ] **Step 2: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/codexReasoning.test.ts tests/linkedHarnessEnv.test.ts tests/orchMcp.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Commit the implementation**

Run:

```bash
git add lib/agents/codex/driver.ts tests/codexReasoning.test.ts
git commit -m "fix: preapprove linked Codex workstream tools"
```

### Task 3: Verify and deploy Operator safely

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the complete verification matrix**

Run:

```bash
npm run verify
```

Expected: audit succeeds, all Vitest tests pass, TypeScript passes, the
production build succeeds, and build traces validate.

- [ ] **Step 2: Confirm no task is running**

Run:

```bash
sqlite3 /Users/geo/.zen-orchestrator/orchestrator.db \
  "SELECT id,title FROM tasks WHERE running=1"
```

Expected: no rows. If rows are returned, do not restart.

- [ ] **Step 3: Restart Operator using the established service process**

Identify the current Operator process and its parent/service launcher, stop only
that service, and start it with the same production command and environment.
Do not stop or alter unrelated Node processes.

- [ ] **Step 4: Verify the service**

Run loopback health and version checks against port 3000 and inspect the
Operator error log.

Expected: HTTP 200, the new build is running, and no startup error appears.

### Task 4: Resume the same linked session and verify delivery

**Files:**
- Existing deliverables:
  - `/Users/geo/.agent-orchestrator/worktrees/CnD7bcqgvbaSpqh3869L-/fortress-api-access-review.html`
  - `/Users/geo/.agent-orchestrator/worktrees/CnD7bcqgvbaSpqh3869L-/fortress-api-access-todo.html`

- [ ] **Step 1: Resume the existing Operator task**

Send a follow-up message to Operator task `CnD7bcqgvbaSpqh3869L-`, which resumes
Codex session `019fd881-fa26-7b53-84fb-6087e1cc5393`, instructing it to retry
the same logical linked-workstream update with both existing HTML files.

- [ ] **Step 2: Wait for the resumed turn**

Monitor the exact Codex session until it completes or needs attention.

Expected: `publish_workstream_update` executes instead of returning
`user cancelled MCP tool call`.

- [ ] **Step 3: Verify Card Tracker state**

Read the linked card bundle and confirm that one workstream update comment and
both HTML attachment filenames are present. The existing workstream
idempotency logic must prevent duplicate delivery if the logical update was
already accepted.
