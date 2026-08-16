# UI Batch Two: clarity - spec

Owner: lead agent (Fable), 2026-08-15. Follows batch one (committed d2c216b; spec `2026-08-15-ui-batch-one-clarity.md` - its Ground rules apply verbatim here: build on disk state, targeted edits, no commits, no em dashes, vitest conventions, react-test-renderer or source-text tests). Progress log: `docs/superpowers/plans/2026-08-15-ui-batch-one-progress.md` (shared log for both batches).

Scope, four items from the dsh borrow list Geo approved: queue dock, hover cards, produced-files footer, mini plugin registries. Packages D and E run in parallel (disjoint files), F runs after both (it refactors what they touch).

## Package D - hover cards + row polish

Files: `app/orchestrator/shared.tsx` (new HoverCard component), `app/orchestrator/TasksColumn.tsx`, `app/orchestrator/ProjectsColumn.tsx`, `app/globals.css` (append-only block `/* --- batch-two: hover cards (Package D) --- */`), new tests. Do NOT touch SessionView.tsx, Transcript.tsx, Composer.tsx (Package E owns them now).

D1. `HoverCard` in shared.tsx: portaled (createPortal to document.body), opens after ~350ms hover on the anchor, survives the anchor-to-card pointer gap with a short grace timeout, closes on leave/Escape/scroll. Clicking the card copies its primary value to the clipboard and shows a transient "Copied" state ONLY after the clipboard write resolves. Text selection inside the card must not trigger the copy. Keyboard: the card is presentational; do not trap focus.
D2. Task rows (TasksColumn TaskCard): hover card shows the full untruncated title, relative time, and EVERY ladder status that applies (the one-dot precedence hides lower levels on the row; the card lists all that are true, each with its own small dot + label, e.g. amber "Needs your input" AND blue "Working"). Click copies the task title.
D3. Project rows (ProjectsColumn): hover card shows full project name, working directory path, awaiting count and running count. Click copies the working directory path.
D4. Tests: new `tests/hoverCard.test.ts` - react-test-renderer on the HoverCard contract where feasible (open state renders content; copy handler called with primary value) plus source-text assertions for the demoted-statuses list and the clipboard-then-Copied ordering. Do not break existing row tests (statusLadder, projectRollup, suggestedTaskUi).

## Package E - queue dock + produced-files footer

Files: `app/orchestrator/SessionView.tsx`, `app/orchestrator/Transcript.tsx`, `app/orchestrator/Composer.tsx`, `app/orchestrator/format.ts`, `app/globals.css` (append-only block `/* --- batch-two: dock + produced files (Package E) --- */`), new tests. Do NOT touch TasksColumn/ProjectsColumn/shared.tsx (Package D owns them).

E1. Queue dock. Today queued messages render as pinned `.msg.user.queued` bubbles below the live turn (SessionView ~L504-506, drawn in Transcript ~L255-275 with a `.queued-x` cancel). Replace with a dock strip between transcript and composer: one pending message renders as a single compact row; two or more collapse to "N queued messages" with an expand toggle (aria-expanded, bounded scroll ~180px). Each expanded row: single-line preview, cancel (existing dequeue path - preserve its API call exactly), and "Edit" which cancels the row and places its text into the composer draft (existing localStorage draft mechanism in Composer). Emptying the queue resets the dock to collapsed for the next time. The dock hides entirely at zero (suppress, don't disable). Keep the transcript free of queued bubbles afterward.
E2. Produced-files footer. After a reply run settles (running goes false), the last assistant message of that run gets a quiet footer lane of file chips: the files actually touched by tool calls since the previous user message. Derive ONLY from tool messages' structured data (`ToolData` built by lib/agents/shared.ts - edit/write style calls carry paths and diffs; read-only calls do not count) - NEVER from the assistant's prose. Show basenames (full path in title attr), max 6 chips plus "+ N more", deduped, most-recently-touched first. Clicking a chip is out of scope (no dead affordance - chips are plain informational spans this batch). Pure derivation helper `producedFiles(messages, fromIndex)` lives in format.ts and is unit-tested.
E3. Tests: new `tests/queueDock.test.ts` (1 message = row, 3 messages = collapsed count, expand, cancel calls the dequeue handler, edit moves text to draft callback, empty resets collapsed) and `tests/producedFiles.test.ts` (pure helper: dedupe, ordering, read-only tools excluded, prose paths ignored, cap + overflow count). Do not break composerTakeover, turnClock, composerAttachments, transcriptTimestamps, queue.test.ts (server FIFO - your changes are client-side only).

## Package F - mini plugin registries (after D and E land)

Files: new `app/orchestrator/registry.ts` (or registries/ dir), then refactors inside Transcript.tsx, Composer.tsx, statusLadder call sites; tests. NOT Cordis, NOT dynamic loading, NOT third-party plugins - four in-repo registries (~200 lines total) that existing code registers into at module load, so adding a tool card / slash command / row-status contributor / composer seat is one `register*()` call instead of editing a switch:

F1. `registerToolCard(toolName | intent, Component)` - Transcript's ToolView dispatch consults the registry first, falls back to the current generic rendering. Move ONE existing specialized rendering (the ask card dispatch) onto it as proof.
F2. `registerCommand({ name, description, run })` - Composer's slash menu reads the registry; move `/clear`, `/handoff`, `/help` onto it with behavior identical (source-text + existing tests must stay green).
F3. `registerSessionStatus(fn: (task, ctx) => RowStatus | null)` - statusLadder consumers fold registry contributors at a fixed precedence slot (below built-ins this batch). Ship with zero external contributors; the seam exists for Chief later.
F4. `registerComposerSeat(seat: "left" | "right", { order, Component })` - Composer foot renders registered seats; move the attach button onto it as proof.
Tests: new `tests/uiRegistries.test.ts` - registration + dispatch for each registry, duplicate-name rejection, fallback behavior. ALL existing tests stay green (this package changes no behavior, only seams).

## Integration and verification

D + E parallel -> I review -> F -> full `npm test` + `npx tsc --noEmit` -> browser pass on the ui-batch-preview launch config (fresh DB copy; verify dock collapse/expand/edit, hover cards with demoted statuses, produced-files chips on a real historical transcript, registries invisible = nothing changed visually). No commit without Geo's go-ahead.
