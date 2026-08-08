# Recipe Recovery and Worktree Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely land and verify the Recipe PWA text-import repair, then make Operator's isolated-worktree and merge workflow unmistakable.

**Architecture:** Preserve existing Recipes changes on an explicit safety branch, combine them with the task repair, verify the combined tree, and promote it to `main`. In Operator, extend the shared agent context and task-diff response so both agents and users see the intentional task workspace, project merge target, and dirty-base blocker.

**Tech Stack:** Git worktrees, Node.js test runner, Express, Vite, Next.js, TypeScript, React, Vitest.

---

### Task 1: Preserve and integrate Recipes work

**Files:**
- Modify: `/Users/geo/Claude Projects/recipe-pwa/TIKTOK_BREAD_DRINK_PIPELINE.md`
- Modify: `/Users/geo/Claude Projects/recipe-pwa/server/index.js`
- Modify: `/Users/geo/Claude Projects/recipe-pwa/server/recipeImport.js`
- Modify: `/Users/geo/Claude Projects/recipe-pwa/tests/recipeImport.test.js`

- [ ] Record both checkouts' status and diffs.
- [ ] Create `codex/recipes-live-wip-20260808` from the live checkout.
- [ ] Commit only the two pre-existing tracked changes.
- [ ] Run the task worktree's focused import tests before committing its repair.
- [ ] Commit only the three task-repair files on `orch/vmwwgFZPi981WuT6Lfp7X`.
- [ ] Merge the task branch into the safety branch, preserving both independent `server/index.js` changes.
- [ ] Confirm all pre-existing untracked files remain present and untracked.

### Task 2: Verify and promote Recipes

**Files:**
- Verify: `/Users/geo/Claude Projects/recipe-pwa/package.json`
- Verify: `/Users/geo/Claude Projects/recipe-pwa/server/index.js`
- Verify: `/Users/geo/Claude Projects/recipe-pwa/server/recipeImport.js`

- [ ] Run `npm test` from the combined Recipes checkout and require zero failures.
- [ ] Run `npm run build` and require exit code 0.
- [ ] Start an isolated Recipe PWA server with `RECIPES_PATH` pointing at a temporary directory.
- [ ] POST a representative pasted recipe to `/api/recipes/import`.
- [ ] Confirm a recipe is returned and written only inside the temporary directory.
- [ ] Advance `main` to the verified combined commit and switch the live checkout back to `main`.
- [ ] Recheck branch, tracked cleanliness, and preservation of untracked files.

### Task 3: Add isolated-worktree agent guidance with TDD

**Files:**
- Modify: `/Users/geo/Claude Projects/operator/tests/clearMidTurn.test.ts`
- Modify: `/Users/geo/Claude Projects/operator/lib/agents/shared.ts`

- [ ] Add a failing test asserting that `buildProjectContext()` names the task workspace, project checkout, and Changes-tab merge workflow.
- [ ] Run the focused test and confirm it fails because the guidance is absent.
- [ ] Add the minimal isolated-worktree guidance to `buildProjectContext()`.
- [ ] Add a direct-repo assertion that misleading worktree guidance is omitted.
- [ ] Run the focused test and confirm it passes.

### Task 4: Add dirty-base diff metadata and UI warning with TDD

**Files:**
- Modify: `/Users/geo/Claude Projects/operator/lib/git.ts`
- Modify: `/Users/geo/Claude Projects/operator/app/api/tasks/[id]/diff/route.ts`
- Modify: `/Users/geo/Claude Projects/operator/app/TaskChanges.tsx`
- Modify: `/Users/geo/Claude Projects/operator/tests/diff.test.ts`
- Create: `/Users/geo/Claude Projects/operator/tests/worktreeClarityUi.test.ts`

- [ ] Add a failing Git test for a helper that reports whether the project checkout has uncommitted changes.
- [ ] Run it and confirm the missing helper causes the expected failure.
- [ ] Implement the read-only dirty-check helper.
- [ ] Return `workspacePath`, `projectPath`, and `projectDirty` from the diff route.
- [ ] Add a failing UI source test for the two path labels and merge-blocked warning.
- [ ] Run it and confirm the strings are absent.
- [ ] Render both paths and the conditional warning in `TaskChanges`.
- [ ] Run focused Git and UI tests and confirm they pass.

### Task 5: Full verification and handoff

**Files:**
- Create: `/Users/geo/Claude Projects/operator/operator-recipes-recovery-report-2026-08-08.html`

- [ ] Run the full Operator test suite.
- [ ] Run the Operator production build.
- [ ] Inspect both repositories' final status and recent commits.
- [ ] Write an HTML report with the completed state and exact future workflow.
- [ ] Reopen/check the report and verify all file links and commands are correct.

