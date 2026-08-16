# UI Batch One: clarity - spec

Owner: lead agent (Fable) in Geo's session, 2026-08-15. Implementation delegated in three work packages (A, B, C below). Companion running log: `docs/superpowers/plans/2026-08-15-ui-batch-one-progress.md`.

Ground rules for every implementer:
- The working tree carries UNCOMMITTED LiteLLM/Prime/Kimi work (notably `app/orchestrator/Composer.tsx`, `SessionView.tsx`, `useOrchestrator.ts`, `Orchestrator.tsx`, `lib/agents/*`, `tests/setup.ts`). Build ON TOP of what is on disk. Never revert or re-generate a file; targeted edits only. Run `git diff` on each file you touched before finishing and confirm only intended hunks.
- No commits. No `git add`. Leave everything as working-tree changes.
- Tests: vitest, serial (`npx vitest run tests/<file>.test.ts` during dev). React tests use `react-test-renderer` (see `tests/newTaskExecutionControls.test.ts` for the pattern) or source-text assertions (see `tests/worktreeClarityUi.test.ts`). New env-read-at-import config goes in `tests/setup.ts`.
- No em dashes anywhere. Match surrounding code style. No new dependencies.

## Design decisions (apply across packages)

1. **Color convention flips to: amber = waiting on you, blue = running.** Today `TasksColumn.tsx` L40 uses blue for awaiting and amber for running; that inverts. Amber/attention must win visually everywhere.
2. **One status dot per row, hard precedence:** `awaiting` (amber, reason label) > `running` (blue) > `unviewed-done` (green, local unread marker) > none (idle, slot space reserved - never remove the element, render it empty).
3. **Suppress, don't disable:** a control that cannot act does not render. Exceptions: momentary in-flight states (a Stop button while stopping) may disable.
4. **`turn_started_at`** becomes a persisted task column so elapsed clocks survive reload and recompute identically everywhere.

---

## Package A - server: turn timestamps + public harness ids + routing guard

Files: `lib/db.ts`, `lib/types.ts`, `lib/store.ts`, `lib/runner.ts`, `app/api/events/route.ts`, `app/api/agents/route.ts`, `app/orchestrator/agents.ts`, `app/orchestrator/types.ts`, `lib/agents/litellm/capabilities.ts`, `lib/agents/litellm/catalog.ts` (read), tests.

### A1. `turn_started_at`
- Add nullable integer column `turn_started_at` to `tasks` via the existing migration pattern in `lib/db.ts`. Type it on `Task` (`lib/types.ts` ~L37-66) and the client `TaskRow` (`app/orchestrator/types.ts`).
- `lib/runner.ts`: at turn start (where `startedAt = Date.now()` exists, ~L227) also `updateTask(id, { turn_started_at: startedAt })` alongside the existing start-of-turn row writes. In the `finally` that settles the row (~L419-423), set `turn_started_at: null` when the turn ends.
- `app/api/events/route.ts` (~L106-123): the wire payload already re-reads the task row; add `turn_started_at: t.turn_started_at ?? null` to the published object and to `GlobalTaskWireEvent` in `lib/events.ts` (~L31-48). No timestamp invention in the route.
- Tests: extend `tests/notifications.test.ts` style coverage - a started turn publishes `turn_started_at` as a number; after `turn_end` the task row reads null.

### A2. Public harness ids: `prime` and `kimi-code`
Today `app/api/agents/route.ts` L22 hides `litellm-codex`/`litellm-claude` and remaps them onto `codex`/`claude`; `litellm-prime` and `litellm-kimi-code` leak raw. Fix by generalizing the existing alias mechanism, NOT inventing a new one:
- Add a single alias map (suggest in `lib/agents/capabilities.ts`): `PUBLIC_AGENT_IDS = { "litellm-prime": "prime", "litellm-kimi-code": "kimi-code" }` with reverse lookup. `/api/agents` publishes those two agents under their public ids and labels ("Prime", "Kimi Code"), with each model option carrying `driverId: "litellm-prime" | "litellm-kimi-code"` exactly like the gateway pattern at L36-41. Stored `tasks.agent` keeps the real driver id (existing `driverForModel` handles this).
- `app/orchestrator/agents.ts` `publicHarnessId` (L7-11): add the two new mappings so `visibleCaps` filtering (`SessionView.tsx` L358-365) and `useOrchestrator.setModel` L517 behave identically for all four harnesses.
- Mirror the L77-81 default-agent remap for the two new ids.
- Tests: extend `tests/litellmAgentUi.test.ts` - public list contains ids `claude, codex, prime, kimi-code` only; no id containing "litellm" reaches the client; model driverIds still resolve.

### A3. Subscription-only routing guard (Geo's hard rule)
Anthropic-family and OpenAI-family models must NEVER be offered on a LiteLLM route.
- Server guard in `lib/agents/litellm/capabilities.ts` (or the catalog it filters): exclude any catalog model whose id/family matches Anthropic (`claude*`, `anthropic/*`) or OpenAI (`gpt*`, `o[0-9]*`, `openai/*`, `codex*`) from EVERY litellm harness's model list. Belt-and-suspenders: same check where a turn resolves its model for a litellm driver (follow the `assertPrimeModelAllowed` pattern in `lib/agents/prime/policy.ts`) so a hand-edited task row cannot route them either.
- Gateway pairings (the merged `litellm-claude`/`litellm-codex` models inside the public `claude`/`codex` agents, `app/api/agents/route.ts` L36-41) are eval machinery: gate them behind env flag `ORCH_SHOW_EVAL_MODELS` (default off) added to `lib/config.ts` + `.env.example`. Off = the merge step is skipped entirely.
- Tests: new `tests/harnessRouting.test.ts` - (1) litellm capabilities never contain an Anthropic/OpenAI-family model even if the catalog does; (2) with the flag unset, `/api/agents` claude/codex entries contain no `driverId` pointing at a litellm driver; (3) with flag set, they do.

---

## Package B - rows and rollup: status ladder, project signal, titlebar suppression

Files: NEW `app/orchestrator/statusLadder.ts`, `app/orchestrator/TasksColumn.tsx`, `app/orchestrator/TaskBoard.tsx`, `app/orchestrator/ProjectsColumn.tsx`, `app/orchestrator/useGlobalEvents.ts`, `app/orchestrator/useOrchestrator.ts` (minimal), `app/Orchestrator.tsx` (props + titlebar), `app/globals.css`, tests. Depends on A1's `turn_started_at` only for the optional row clock; do not block on it.

### B1. `statusLadder.ts` (pure, unit-tested)
```ts
type RowStatus =
  | { kind: "awaiting"; label: "Needs your input" }
  | { kind: "running"; label: "Working" }
  | { kind: "unviewed"; label: "Finished while you were away" }
  | { kind: "none" };
rowStatus(task: { status; awaiting_input; running }, opts: { running: boolean; unviewed: boolean }): RowStatus
```
Precedence exactly: awaiting > running > unviewed > none. `isAwaiting` from `format.ts` L201 stays the single awaiting predicate.

### B2. Unviewed-completion marker (local only, no server state)
- In `useOrchestrator.ts`: a `Map<taskId, true>` in state + localStorage (`orch:unviewed:<projectId>`) written when a global `turn_end` event arrives for a task that is NOT currently selected (or tab hidden); cleared when the task becomes selected. Expose as `unviewed: Set<string>`.
- Wire through `Orchestrator.tsx` into `TasksColumn`/`TaskBoard`.

### B3. Row rendering
- `TasksColumn.tsx` TaskCard: replace the dual signals (StatusDot + colored activity bullet) with ONE ladder dot. Amber pulse for awaiting with the reason in the row foot (`waiting on you - approval` vs `- question`: derive from whether the task's awaiting came with an open ask; if unknown, plain "waiting on you"). Blue steady-animate for running. Green for unviewed. Idle renders an empty `.dot-slot` (fixed width, no reflow). Delete the now-dead `.slabel` markup OR convert it to a visually-hidden accessible label (`.sr-only`, not `display:none`) matching the ladder label - prefer the latter for a11y.
- Same ladder applied to `TaskBoard.tsx` BoardCard (keep `.bc-bar` progress bar for running).
- Colors: amber `var(--amber)` = attention, blue `var(--blue)` = running, green reuse existing success var. Update the `.activity` bullets accordingly (they currently invert).

### B4. Project rollup (the thing dsh forgot)
- Maintain `runningByProject: Map<projectId, Set<taskId>>` fed by global events in `useGlobalEvents.ts` (payload has `projectId`, `taskId`, `running`); seed on catch-up from `/api/running` if it carries project ids, else extend that route to include them (check `tests/runningTasks.test.ts`).
- `ProjectsColumn.tsx`: the currently dead `running` prop becomes real. Each project row gets the SAME ladder, project-scoped: amber badge (existing `.proj-await` count, restyle amber to match convention) > blue dot when any task runs > nothing. A collapsed/unselected project can now never hide a waiting task.

### B5. Titlebar and empty-state suppression (from the audit)
- `app/Orchestrator.tsx` L458-475: Services and Terminal buttons render only when `project` is set (remove `disabled` + tooltip pattern).
- `TasksColumn.tsx` L163 area: hide the Sessions header button when the project has zero started tasks.
- Keep the two localhost dashboard links as-is (deliberate quick links, Geo's own).

### B6. Tests
New `tests/statusLadder.test.ts` (pure fn matrix: all 4 kinds + precedence pairs). New `tests/projectRollup.test.ts` (react-test-renderer on ProjectsColumn: running dot appears, awaiting badge wins, idle renders empty slot). Source-text assertion that Services/Terminal render conditionally (worktreeClarityUi pattern).

---

## Package C - session pane: composer takeover, turn clock, remaining suppressions

Files: `app/orchestrator/SessionView.tsx`, `app/orchestrator/Composer.tsx`, `app/orchestrator/Transcript.tsx`, `app/orchestrator/SessionRail.tsx`, `app/orchestrator/format.ts`, `app/globals.css`, tests. Builds on the WIP `/handoff` + post-clear composer state - do not disturb them.

### C1. Composer takeover for asks
Today the pending `AskView` renders inline in the transcript (`Transcript.tsx` L154-224) and the composer stays a normal textarea. Change to dsh's model:
- When the selected task has an unanswered ask (`awaitingAnswer`, `SessionView.tsx` L396-399), the composer input area is REPLACED by an `AskPanel`: question header chips, options, free-text "Other", submit - reusing the existing answer flow (`onAnswer` -> `answerQuestion`, replay-guarded server side). Multiple questions keep the existing one-card-all-questions layout.
- Add a **"Chat about it"** action on the panel: switches the composer back to the normal textarea in "answering by chat" mode - the next message sent is submitted through the SAME answer endpoint as free-text (server already accepts custom text via `formatAnswersText` fallback; if no `askId` resolution, existing fallback runs a normal turn - keep that). A small dismissible strip above the textarea says "Answering: <first question header>" so the mode is visible; canceling the strip returns to the panel.
- The transcript's pending `AskView` becomes NON-interactive (question text as context, controls removed, subtle "answer below" pointer); the answered state rendering (L161-173) is unchanged. Rationale: decision lives where the hands are; history stays in the flow.
- The takeover must survive tab switches within the session pane (it is keyed off task state, not local component state).

### C2. Turn clock
- `format.ts`: add `elapsed(startMs, nowMs)` -> "1:42" / "12:03" / "1:02:11".
- `SessionView.tsx` thinking bubble (L499-501): when `running && !awaitingAnswer`, anchor = `task.turn_started_at` (Package A) falling back to the last non-queued `user` message's `createdAt`. Render nothing extra for the first 15 s, then append a muted `.turn-clock` next to the typing dots, ticking 1 s. Survives reload because the anchor is persisted.
- Header: same anchored elapsed appears in the `.sh-tools` chip row while running (small, muted). No per-row clock in this batch.

### C3. Suppressions in the session pane
- `SessionRail.tsx` L66: the permanently-disabled "Open live" button -> render nothing when no URL.
- Renew: three controls, three gates today (`SessionView.tsx` L746 header disabled while running; `Composer.tsx` L234 always enabled; `SessionRail.tsx` L101). Unify on ONE rule: Renew is a real mid-turn capability (`tests/clearMidTurn.test.ts` pins it), so all three render enabled whenever `task.started === 1`, and are suppressed (not disabled) otherwise. Remove the `disabled={running}` guards.
- Ask submit: when incomplete, show the reason inline under the button ("Answer question N to send") instead of a silently disabled button (button may stay disabled, the reason must be visible).
- `WorktreePrune.tsx` L219-224: remove the not-built disabled checkbox and its label (feature does not exist; suppress).
- Hero Start button (`SessionView.tsx` L279-281): move the blocked/not-connected reason from `title` to a visible `.start-reason` line under the button. Labels unchanged.

### C4. Tests
New `tests/composerTakeover.test.ts` (react-test-renderer: awaiting ask -> panel renders instead of textarea; Chat-about-it -> textarea with mode strip; answer submit calls onAnswer with the ask id). New `tests/turnClock.test.ts` (pure `elapsed`; component gating: no clock <15 s with fake timers). Extend source-text assertions for SessionRail/WorktreePrune suppressions.

---

## Integration order and verification

1. A lands first (types feed B and C), then B and C in parallel (disjoint files; both touch `globals.css` - B owns new ladder classes, C owns `.turn-clock`/takeover classes, append-only sections marked with comments).
2. After each package: `npx tsc --noEmit` (if configured, else `npm run build`), package test files green.
3. After all three: full `npm test`, then manual browser verification with `npm run dev` (launch config in `.claude/launch.json` if present): ladder on rows, rollup on projects, takeover on a real ask, clock past 15 s, picker shows only clean harness names, no litellm strings anywhere user-visible.
4. `git diff` review of every touched file against this spec. No commit.

Out of scope (explicitly deferred to batch two): queue dock, hover cards, produced-files footer, plugin registries, per-row elapsed clocks, board drag affordances, suggestion-button visible reasons.
