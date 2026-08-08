# Operator Mobile Artifacts and Durable Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private global artifact library with explicit agent publishing, durable question-card replies, transcript timestamps, and one-tap copy controls.

**Architecture:** Store published files outside worktrees under `DB_DIR`, with metadata in SQLite and authenticated routes for listing, previewing, and downloading. Expose one shared `publish_artifact` domain function through both Claude’s in-process MCP server and the portable Codex bridge. Preserve existing message timestamps through SSE, persist live ask answers as idempotent user rows, and enhance the existing Markdown/message renderers with copy controls.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, better-sqlite3, Node filesystem APIs, MCP SDK, Vitest, React Test Renderer.

---

## File Structure

- Create `lib/artifacts.ts`: artifact validation, durable copy, list/get, URL, cleanup, MIME policy.
- Modify `lib/db.ts`: artifact table plus message provenance migration.
- Modify `lib/types.ts`: artifact/message/event types.
- Modify `lib/store.ts`: provenance-aware message insertion and idempotent ask-answer insertion.
- Modify `lib/agentToolDefs.mjs`: portable `publish_artifact` definition.
- Modify `lib/agentTools.ts`: shared publish tool adapter.
- Modify `lib/agents/claude/driver.ts`: Claude MCP exposure.
- Modify `scripts/orch-mcp.mjs`: Codex/LiteLLM MCP exposure.
- Create `app/api/internal/agent-tools/publish-artifact/route.ts`: bridge endpoint.
- Create `app/api/artifacts/route.ts`: global metadata feed.
- Create `app/api/artifacts/[id]/route.ts`: one metadata row.
- Create `app/api/artifacts/[id]/content/route.ts`: safe inline bytes.
- Create `app/api/artifacts/[id]/download/route.ts`: original download.
- Create `app/artifacts/page.tsx`: global responsive library.
- Create `app/artifacts/[id]/page.tsx`: artifact detail/preview.
- Modify `app/orchestrator/ProjectsColumn.tsx`: global Artifacts navigation.
- Modify `app/orchestrator/types.ts`: client timestamps and provenance.
- Modify `app/orchestrator/useTaskStream.ts`: preserve server timestamps/provenance.
- Modify `app/orchestrator/Transcript.tsx`: timestamp, artifact notice, and message copy UI.
- Modify `app/Markdown.tsx`: fenced-code copy UI.
- Modify `app/globals.css`: artifact, timestamp, and copy responsive styles.
- Modify `app/api/tasks/[id]/answer/route.ts`: persist accepted live ask answers.
- Modify `lib/runner.ts` and `app/api/tasks/[id]/messages/route.ts`: timestamped live events.
- Create `tests/artifacts.test.ts`: storage, traversal, durability, routes, CSP.
- Create `tests/transcriptDurability.test.ts`: timestamps and idempotent answer rows.
- Create `tests/transcriptCopy.test.ts`: copy-control rendering contracts.
- Modify `tests/orchMcp.test.ts`, `tests/agentTools.test.ts`, and `tests/codexEvents.test.ts`: tool/event regressions.

### Task 1: Artifact Domain and Database

**Files:**
- Create: `tests/artifacts.test.ts`
- Create: `lib/artifacts.ts`
- Modify: `lib/db.ts`
- Modify: `lib/types.ts`

- [ ] **Step 1: Write failing artifact-domain tests**

Test the intended API directly:

```ts
const artifact = publishArtifact({
  task,
  project,
  sourcePath: "report.html",
  title: "Lease Report",
});
expect(readArtifact(artifact.id)?.title).toBe("Lease Report");
expect(fs.readFileSync(artifactPath(artifact), "utf8")).toContain("<h1>");
expect(() => publishArtifact({ task, project, sourcePath: "../outside.html" }))
  .toThrow(/inside the current task workspace/i);
```

Also delete the source file after publishing and assert the stored artifact is
still readable.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/artifacts.test.ts`

Expected: FAIL because `lib/artifacts.ts` and the artifact table do not exist.

- [ ] **Step 3: Add schema and domain implementation**

Create the `artifacts` table and indexes, then implement:

```ts
export function publishArtifact(input: PublishArtifactInput): Artifact
export function listArtifacts(input?: ArtifactQuery): ArtifactListItem[]
export function getArtifact(id: string): Artifact | undefined
export function artifactPath(row: Artifact): string
export function removeArtifactFilesForTask(taskId: string): void
```

Validation must use `realpath`, reject workspace-root/self/outside paths,
require a regular non-empty file, enforce 10 MB, choose MIME server-side, write
to a generated path under `ARTIFACTS_DIR`, and remove the copy if insertion
fails.

- [ ] **Step 4: Run artifact-domain tests and verify GREEN**

Run: `npm test -- tests/artifacts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/artifacts.ts lib/db.ts lib/types.ts tests/artifacts.test.ts
git commit -m "feat: add durable artifact storage"
```

### Task 2: Publish Tool Across Agent Harnesses

**Files:**
- Modify: `tests/agentTools.test.ts`
- Modify: `tests/orchMcp.test.ts`
- Modify: `lib/agentToolDefs.mjs`
- Modify: `lib/agentTools.ts`
- Modify: `lib/agents/claude/driver.ts`
- Modify: `scripts/orch-mcp.mjs`
- Create: `app/api/internal/agent-tools/publish-artifact/route.ts`

- [ ] **Step 1: Write failing tool-contract tests**

Assert the shared handler publishes a workspace file and returns both stable
URLs:

```ts
const result = publishTaskArtifact(task, project, {
  path: "report.html",
  title: "Report",
});
expect(result.status).toBe("published");
expect(result.url).toMatch(/\/artifacts\/[^/]+$/);
expect(result.libraryUrl).toMatch(/\/artifacts$/);
```

Assert `scripts/orch-mcp.mjs` registers `publish_artifact` and routes it to the
new internal endpoint.

- [ ] **Step 2: Run the tool tests and verify RED**

Run: `npm test -- tests/agentTools.test.ts tests/orchMcp.test.ts`

Expected: FAIL because the definition and handler are absent.

- [ ] **Step 3: Implement the portable tool**

Add a tool definition with required `path` and optional `title`. Use the same
shared `publishTaskArtifact()` from Claude and the HTTP bridge. The readable
result must instruct the agent to give Geo the exact URL.

- [ ] **Step 4: Run tool tests and verify GREEN**

Run: `npm test -- tests/agentTools.test.ts tests/orchMcp.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agentToolDefs.mjs lib/agentTools.ts lib/agents/claude/driver.ts scripts/orch-mcp.mjs app/api/internal/agent-tools/publish-artifact/route.ts tests/agentTools.test.ts tests/orchMcp.test.ts
git commit -m "feat: expose artifact publishing to agents"
```

### Task 3: Authenticated Artifact Routes

**Files:**
- Modify: `tests/artifacts.test.ts`
- Create: `app/api/artifacts/route.ts`
- Create: `app/api/artifacts/[id]/route.ts`
- Create: `app/api/artifacts/[id]/content/route.ts`
- Create: `app/api/artifacts/[id]/download/route.ts`

- [ ] **Step 1: Add failing route and security tests**

Call route handlers with a published artifact and assert:

```ts
expect(list.status).toBe(200);
expect(items[0].task_title).toBe(task.title);
expect(content.headers.get("content-security-policy")).toContain("sandbox");
expect(content.headers.get("content-security-policy")).toContain("script-src 'none'");
expect(download.headers.get("content-disposition")).toContain("attachment");
```

Also assert missing ids return 404 and JSON never contains `storage_name` or an
absolute path.

- [ ] **Step 2: Run route tests and verify RED**

Run: `npm test -- tests/artifacts.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement route handlers**

Use bounded query parsing (`limit` 1–100), joined project/task labels, safe
headers, server-generated paths, `nosniff`, a restrictive CSP for HTML, and
attachment disposition for downloads.

- [ ] **Step 4: Run route tests and verify GREEN**

Run: `npm test -- tests/artifacts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/artifacts tests/artifacts.test.ts
git commit -m "feat: serve authenticated artifacts safely"
```

### Task 4: Global Mobile Artifact Library

**Files:**
- Create: `tests/artifactUi.test.ts`
- Create: `app/artifacts/page.tsx`
- Create: `app/artifacts/[id]/page.tsx`
- Modify: `app/orchestrator/ProjectsColumn.tsx`
- Modify: `app/Orchestrator.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Write failing UI contract tests**

Read the page and navigation sources and assert the required affordances:

```ts
expect(page).toContain('href={`/artifacts/${artifact.id}`}');
expect(page).toContain("Copy link");
expect(page).toContain("task_id");
expect(projectsColumn).toContain('href="/artifacts"');
```

The tests also require a `<time>` element and responsive artifact classes.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `npm test -- tests/artifactUi.test.ts`

Expected: FAIL because the page and navigation do not exist.

- [ ] **Step 3: Implement library and detail pages**

Build a client library view that fetches `/api/artifacts`, filters by a
debounced search query, renders recent cards, copies stable links, and deep
links to project/task. Build a server detail page with sandboxed preview iframe
and download/back actions. Add an Artifacts nav item to the projects footer.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `npm test -- tests/artifactUi.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/artifacts app/orchestrator/ProjectsColumn.tsx app/Orchestrator.tsx app/globals.css tests/artifactUi.test.ts
git commit -m "feat: add global mobile artifact library"
```

### Task 5: Durable User Replies and Timestamps

**Files:**
- Create: `tests/transcriptDurability.test.ts`
- Modify: `lib/db.ts`
- Modify: `lib/types.ts`
- Modify: `lib/store.ts`
- Modify: `lib/runner.ts`
- Modify: `lib/agentTools.ts`
- Modify: `app/api/tasks/[id]/answer/route.ts`
- Modify: `app/api/tasks/[id]/messages/route.ts`
- Modify: `app/orchestrator/types.ts`
- Modify: `app/orchestrator/useTaskStream.ts`
- Modify: `app/orchestrator/Transcript.tsx`

- [ ] **Step 1: Write failing persistence and event tests**

Verify ask answers are idempotent and timestamps survive snapshots:

```ts
const first = addAskAnswerMessage(task.id, 1, "ask-1", "Budget?\n$5M");
const second = addAskAnswerMessage(task.id, 1, "ask-1", "Budget?\n$5M");
expect(second.id).toBe(first.id);
expect(listMessages(task.id).filter(m => m.source === "ask_answer")).toHaveLength(1);
expect(snapshot.messages[0].created_at).toBeGreaterThan(0);
```

Add a source test requiring the client to map `created_at`, `source`, and
`source_id`.

- [ ] **Step 2: Run durability tests and verify RED**

Run: `npm test -- tests/transcriptDurability.test.ts`

Expected: FAIL because message provenance and client timestamps are absent.

- [ ] **Step 3: Implement provenance, answer persistence, and event timestamps**

Add `messages.source`, `messages.source_id`, and the partial unique index.
Implement `addAskAnswerMessage()`. When `/answer` resolves a live ask, persist
the human-readable questions and answers exactly once. Add database timestamps
to all persisted live events and map them into `Msg.createdAt`.

- [ ] **Step 4: Render timestamps and answer badges**

Render semantic `<time dateTime=...>` values beside every user and assistant
prose header. Render `answer` for `source === "ask_answer"`. Never hide user
messages; preserve existing assistant/tool condensation.

- [ ] **Step 5: Run durability tests and verify GREEN**

Run: `npm test -- tests/transcriptDurability.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/db.ts lib/types.ts lib/store.ts lib/runner.ts lib/agentTools.ts app/api/tasks/[id]/answer/route.ts app/api/tasks/[id]/messages/route.ts app/orchestrator/types.ts app/orchestrator/useTaskStream.ts app/orchestrator/Transcript.tsx tests/transcriptDurability.test.ts
git commit -m "fix: keep every user reply visible with timestamps"
```

### Task 6: Copy Controls

**Files:**
- Create: `tests/transcriptCopy.test.ts`
- Modify: `app/Markdown.tsx`
- Modify: `app/orchestrator/Transcript.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Write failing copy-control tests**

Require message and fenced-code copy components:

```ts
expect(markdownSource).toContain("CodeBlock");
expect(markdownSource).toContain("navigator.clipboard.writeText");
expect(transcriptSource).toContain('aria-label="Copy message"');
expect(css).toContain(".copy-btn");
```

- [ ] **Step 2: Run copy tests and verify RED**

Run: `npm test -- tests/transcriptCopy.test.ts`

Expected: FAIL because copy controls are absent.

- [ ] **Step 3: Implement message and code copying**

Create a small reusable client copy button with `Copied`/error feedback and an
ARIA live status. Message copy receives the original Markdown source. The
Markdown `pre` override extracts only code children for fenced-block copy.

- [ ] **Step 4: Run copy tests and verify GREEN**

Run: `npm test -- tests/transcriptCopy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/Markdown.tsx app/orchestrator/Transcript.tsx app/globals.css tests/transcriptCopy.test.ts
git commit -m "feat: add one-tap transcript copy controls"
```

### Task 7: Integrated Regression, Cleanup, and Delivery

**Files:**
- Modify only files implicated by failing checks.

- [ ] **Step 1: Run focused feature tests**

Run:

```bash
npm test -- tests/artifacts.test.ts tests/artifactUi.test.ts tests/transcriptDurability.test.ts tests/transcriptCopy.test.ts tests/agentTools.test.ts tests/orchMcp.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run full verification**

Run: `npm run verify`

Expected: production audit, all Vitest tests, TypeScript, production build, and
trace validation pass with exit code 0.

- [ ] **Step 3: Inspect the exact committed diff**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD~7..HEAD
```

Confirm no unrelated user files are staged or committed.

- [ ] **Step 4: Check for running Operator tasks**

Run:

```bash
sqlite3 /Users/geo/.zen-orchestrator/orchestrator.db "SELECT title FROM tasks WHERE running=1"
```

Expected: no rows. If rows exist, do not restart Operator.

- [ ] **Step 5: Restart and smoke-test when safe**

Use the existing Operator service manager, then verify:

```bash
curl -s http://127.0.0.1:3000/api/artifacts
curl -s http://127.0.0.1:3000/
```

Expected: the artifact API returns JSON and the root returns Operator HTML.

- [ ] **Step 6: Commit verification-only fixes when present**

If verification required a code change, stage the exact named files shown by
`git status --short` individually and commit them with:

```bash
git commit -m "fix: harden artifact and transcript delivery"
```

If verification changed no code, do not create an empty commit.
