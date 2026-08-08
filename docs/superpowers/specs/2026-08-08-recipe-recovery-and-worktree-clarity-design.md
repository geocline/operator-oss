# Recipe Recovery and Worktree Clarity Design

## Goal

Land the pending Recipe PWA text-import repair without losing the existing
uncommitted live-checkout work, verify that a user can paste recipe text through
the web PWA, and make Operator explain its task-worktree workflow before an
agent or user mistakes isolation for being locked out.

## Current State

- Recipes project checkout:
  `/Users/geo/Claude Projects/recipe-pwa`
- Pending task workspace:
  `/Users/geo/.agent-orchestrator/worktrees/vmwwgFZPi981WuT6Lfp7X`
- Pending task branch:
  `orch/vmwwgFZPi981WuT6Lfp7X`
- The task workspace contains the import repair in:
  `server/index.js`, `server/recipeImport.js`, and
  `tests/recipeImport.test.js`.
- The live Recipes checkout contains separate tracked work in
  `TIKTOK_BREAD_DRINK_PIPELINE.md` and `server/index.js`, plus unrelated
  untracked artifacts that must remain untouched.
- Operator intentionally runs Git-backed tasks in isolated worktrees, but its
  prompt and Changes UI do not clearly explain that the project checkout is the
  merge target rather than the agent's writable directory.

## Design

### 1. Preserve and integrate Recipes work

Create a safety branch from the current Recipes checkout and commit only its
two tracked changes. Leave every untracked file and directory untouched.
Commit the pending import repair on the task branch, merge it into the safety
branch, and resolve `server/index.js` by preserving both the TikTok-ingest work
and the text-import error handling.

After tests and build pass, advance `main` to the verified combined result and
return the live checkout to `main`. This removes the dirty-base merge blocker
without discarding or hiding any existing tracked work.

### 2. Verify the paste-through-PWA path

Run the complete Recipe PWA Node test suite and Vite production build. Exercise
the live `/api/recipes/import` endpoint with a disposable test recipe while
temporarily directing recipe output to a temporary directory so verification
cannot modify Geo's real recipe library. Confirm that malformed model output,
timeouts, and valid pasted text follow the repaired behavior.

The original failed recipe cannot be recreated because the server never stored
its input. Success means the PWA is ready for Geo to paste the recipe again.

### 3. Explain isolation to every task agent

Extend `buildProjectContext()` with explicit runtime guidance whenever a task
has an isolated worktree:

- the task workspace is intentional and is the writable checkout;
- the configured project folder is the source repository and merge target;
- agents must make changes in the task workspace;
- agents must not call it the wrong folder or recommend copying patches into
  the project checkout as the normal workflow;
- completed changes reach the project through Operator's Changes tab and merge
  action.

This guidance is agent-agnostic and therefore reaches Claude, Codex, and
LiteLLM-backed Codex tasks.

### 4. Make the Changes UI self-explanatory

The task diff API will return the task workspace path, project checkout path,
and whether the project checkout is currently dirty. The Changes toolbar will
label both locations and show a preflight warning when the base checkout has
uncommitted changes.

The warning will explain that task edits are safe, but merging is blocked until
the project-checkout work is committed or stashed. It will not offer destructive
automation.

## Error Handling

- If Recipes integration conflicts, preserve both sides and rerun the complete
  test/build verification before advancing `main`.
- If the live import smoke test cannot use the configured model gateway, report
  the exact external failure and keep the verified code/tests intact.
- Operator path/status inspection is best-effort. A missing path produces no
  dirty warning rather than breaking the diff endpoint.
- No untracked Recipes artifacts are staged, moved, deleted, or committed.

## Testing

### Recipes

- Existing and new `tests/recipeImport.test.js` cases cover tolerant JSON
  normalization, required fields, retry/timeout behavior, and import failure
  recovery.
- `npm test`
- `npm run build`
- Temporary-directory API smoke test against the running PWA or an isolated
  server process.

### Operator

- Add a context test proving isolated-worktree guidance contains both paths and
  the merge workflow.
- Add a context test proving direct-repo tasks do not receive misleading
  worktree language.
- Add a diff-route/helper test proving dirty project-checkout state is reported.
- Add a UI source test proving both path labels and the merge-blocked warning
  are rendered.
- Run focused tests, then the full Operator test suite and production build.

## Success Criteria

1. Recipes `main` contains both the pre-existing tracked work and the text-import
   repair.
2. The live checkout is on `main` with no tracked changes left uncommitted;
   pre-existing untracked artifacts remain untouched.
3. Recipe tests and production build pass.
4. A pasted-text import succeeds through a disposable live/API smoke test, or
   any external gateway failure is precisely identified.
5. Operator agents are explicitly told that the worktree is intentional.
6. Operator's Changes UI displays the task workspace, project checkout, and
   dirty-base merge blocker before the user clicks Merge.

