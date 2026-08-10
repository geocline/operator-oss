# HANDOFF - Operator task-edit save problem (archived)

Last updated: 2026-08-05
Project root: `/Users/geo/Claude Projects/operator`

## Start here

1. Read this file completely.
2. Read `AGENTS.md` if present and `CLAUDE.md`.
3. Read `/Users/geo/Claude Projects/Ardent/deal-tracker-app/tasks/todo.md`
   only for deal-tracker history relevant to the workstream integration.
4. Before editing, run `git status --short`.
5. Do not revert, delete, overwrite, stage, or commit unrelated untracked
   files.

The previous long-form handoff is preserved at `HANDOFF.old1.md`.

## Geo's current problem

In Operator, Geo opens a not-started task, clicks **Edit**, changes the task
description, and clicks **Save changes**.

The first implementation did not await the save, so failures were invisible.
Commit `fddfe78` changed the modal to await the save and show `Saving...` plus
an error message. Geo then reported that the button remained on `Saving...`
forever.

The investigation found:

- Direct PATCH requests to the task endpoint returned HTTP 200 in about 9 ms
  over both loopback and the Tailscale hostname.
- A newly loaded Operator page successfully opened the editor, submitted an
  unchanged task, and closed the modal.
- The stuck page therefore appeared to have an old or stalled browser request,
  rather than a blocked API or SQLite write.
- Geo's exact browser tab was not available through the connected browser
  surfaces, so the next session must not claim the issue is resolved on his
  real tab until he confirms it.

## Latest implementation

Operator `main` is at `f6d3ad8` and is pushed to
`geocline/operator-oss.git`.

That commit adds:

- A 15-second AbortController timeout specifically for task-edit saves.
- The user-facing error: `The save request timed out. Try again.`
- Preservation of title and description in the open modal after failure.
- A re-enabled **Save changes** button for retry.
- Modal close only after a successful retry.
- Behavioral tests for the exact 15,000 ms timeout, successful API response,
  saving state, error display, preserved form values, retry, and close on
  success.

Verification completed before the handoff:

- `npm run verify` passed.
- 50 test files passed, 454 tests passed.
- TypeScript passed.
- Production build passed.
- 75 Next server trace manifests validated.
- Independent review found no Critical or Important issues.
- Operator was safely restarted after confirming zero running tasks.
- The new service process listened on port 3000.
- A fresh browser test opened the WR2 task editor, saved, closed the modal,
  and produced no console errors.

## Exact next work

1. Ask Geo to hard-refresh his Operator page once.
2. Have him reopen the not-started task, re-enter the description if needed,
   and click **Save changes**.
3. Ask whether the modal closes and the edited description is still present
   after reopening the task.
4. If it still hangs, inspect the actual browser tab that Geo is using:
   - Capture the Operator URL.
   - Identify the exact task id.
   - Inspect the PATCH request in the Network panel.
   - Record whether it is pending, blocked, cancelled, or completed.
   - Read the response status/body and browser console.
   - Compare the task row in SQLite before and after the click.
5. Do not add another speculative fix. Use the captured boundary evidence to
   identify the root cause first.

The current test task used during verification was:

- Project: WR2
- Project id: `dSvBWuIkcdf810BXiF03L`
- Task: `Bancorp extension WR2`
- Task id: `A9RzSEbacklYAEtZKyo-y`
- Direct URL:
  `http://localhost:3000/?project=dSvBWuIkcdf810BXiF03L&task=A9RzSEbacklYAEtZKyo-y`

## Safety rules

- Never restart Operator while a turn is running. Immediately before a
  restart, run:

  ```bash
  sqlite3 /Users/geo/.zen-orchestrator/orchestrator.db \
    "SELECT title FROM tasks WHERE running=1"
  ```

  Restart only when it returns no rows.

- Do not put private filesystem paths, Geo-specific information, or Operator
  implementation details into tracker card comments.
- Tracker-facing automated comments must be attributed to `Geo's Bot`.
- Workstream updates belong in card comments, not Ari.
- Do not expose the Operator origin publicly. The Tailscale hostname is the
  intended private remote path.
- Do not commit Ardent corpus documents.
- Do not use `git add .`.

## Current integration state

- Operator: `f6d3ad8`, pushed on `main`, running locally on port 3000.
- Tracker app:
  `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app`
  at `94f70dd`, pushed on `main`.
- Conversations dashboard:
  `/Users/geo/Claude Projects/conversations-dashboard`
  at `a063093`; it has no configured git remote.
- Supabase migration 0046 was applied to production. It fixes the ambiguous
  `status` reference in `exchange_card_workstream`.
- Tracker production activation and the Operator workstream link were
  previously verified.

## Known unrelated files

The Operator worktree contains many untracked session artifacts:

- `.superpowers/`
- Root-level `*.html` reports

They belong to other sessions. Do not delete or commit them unless Geo
explicitly asks.

## Useful files

- `app/orchestrator/modals.tsx` - task editor state and feedback.
- `app/orchestrator/api.ts` - bounded task-edit request.
- `app/orchestrator/useOrchestrator.ts` - task save state update.
- `app/api/tasks/[id]/route.ts` - task PATCH endpoint.
- `tests/editTaskModal.test.ts` - modal failure/retry behavior.
- `tests/apiHelpers.test.ts` - exact timeout and success behavior.
- `/Users/geo/Claude Projects/.services/logs/operator.log`
- `/Users/geo/Claude Projects/.services/logs/operator.err`
- `/Users/geo/.zen-orchestrator/orchestrator.db`
