# Operator Briefing Design

Date: 2026-08-09
Status: Approved direction; written specification awaiting Geo review
Owner: Operator

## Purpose

Add one on-demand, workspace-level briefing that answers:

1. What is running now?
2. What genuinely needs Geo's attention, and why?
3. What changed since the last briefing?
4. Where should Geo resume?

This is not a messaging system or voice-assistant project. Operator already
provides the task conversation, a mobile PWA over Tailscale, browser
notifications, and compatibility with system dictation. The missing capability
is synthesis across projects.

## Product Decisions

- Add a top-bar `Brief me` action and a phone-friendly `/brief` page.
- Generate the briefing only when Geo opens or refreshes it.
- Keep the briefing factual and deterministic in the first release. Do not call
  an AI model.
- Add an optional `Read aloud` control using the browser's Speech Synthesis API.
  It never starts automatically.
- Do not add Telegram, scheduled messages, push notifications, phone pairing,
  microphone capture, transcription, or always-on narration.
- Include all non-deprecated projects and all real tasks. Exclude suggested
  tasks until they are accepted.
- Every generated briefing is an immutable historical record. Operator never
  replaces, automatically prunes, or silently deletes prior briefings.
- Add a `Briefing history` collection inside the briefing experience and a
  `Briefings` shortcut from the Artifacts area. Briefings remain a native
  global Operator record rather than being forced into task-owned artifact
  rows.
- Every briefing row links to the exact project or task.

## Why This Adds Value

Operator already has the underlying facts:

- `listNeedsYou()` and `awaiting_input`
- fleet-wide running state
- task status, priority, timestamps, and dependencies
- persisted tool, assistant, question, answer, error, and system messages
- project "where you left off" recaps
- task session summaries

The current UI presents those facts separately. It also treats every settled
in-progress turn as `awaiting_input`, even when the agent did not ask a
question. Consequently, the global "N need you" signal combines several
different situations:

- a live structured question that truly blocks the agent
- a recent turn ready for review or another instruction
- a failure that needs investigation
- an old in-progress session that has simply gone stale

The briefing makes those distinctions explicit instead of increasing the
volume of notifications.

## User Experience

### Entry

The Operator top bar gains a `Brief me` action. It navigates to `/brief`, which
uses the existing Operator origin and authentication and therefore works at the
same Tailscale URL on desktop and phone.

The briefing page has:

- `New briefing`, which generates and archives a new point-in-time briefing
- `Read aloud` when speech synthesis is supported
- `Stop` while speech is playing
- an "updated just now" timestamp
- `Briefing history`
- a return link to the Operator workspace

Opening `/brief` shows the newest stored briefing and does not create a
duplicate. The top-bar `Brief me` action generates a new briefing and opens its
permanent detail URL. A direct visit to `/brief` on the phone is therefore safe
to refresh repeatedly.

### Sections

#### 1. Needs your decision

This section contains only tasks with an unresolved structured question.

Each row shows:

- project
- task
- exact question, reduced to a safe readable sentence
- how long it has waited
- task priority
- `Open task`

Rows are ordered by:

1. high priority
2. longest waiting

This is the highest-salience section and is never hidden or collapsed.

#### 2. Problems to review

This section contains tasks whose latest meaningful state is a recorded turn
error or failed tool result.

Each row shows:

- project
- task
- a bounded, sanitized error summary
- when it happened
- `Open task`

The briefing never reads raw stack traces, filesystem paths, secrets, or long
tool output aloud.

#### 3. Active now

This section contains tasks with `running = 1`.

Each row shows:

- project
- task
- last meaningful activity, preferring:
  1. current unresolved question
  2. latest tool title and short detail
  3. latest assistant progress text
  4. `Agent is working`
- elapsed time since the task's latest activity
- `Open task`

Routine low-value tool detail is not included.

#### 4. Ready for review

This section contains settled in-progress tasks with `awaiting_input = 1` that
do not have an unresolved structured question or current failure.

Each row shows:

- project
- task
- a bounded lead from the latest assistant response
- how long it has waited
- `Open task`

Only tasks touched within the last seven days are expanded by default. Older
rows appear under a collapsed `Older open sessions` disclosure. This prevents
long-abandoned sessions from presenting as urgent decisions.

#### 5. Since your last briefing

This section compares the new task snapshot with the immediately preceding
stored briefing snapshot.

It reports:

- new tasks
- tasks that became active
- tasks that became ready or asked a question
- status changes
- newly merged tasks
- tasks updated since the prior briefing

The first briefing has no prior record. It labels the section `Recent activity`
and uses the previous 24 hours as its window.

The comparison describes only facts recoverable from the two immutable
snapshots. It does not claim a transition that cannot be proven.

#### 6. Where to pick up

This section shows up to five recently active projects that are not currently
represented by a live question or running task.

For each project:

- project name
- stored project recap when available
- recap age
- most recently touched task as a fallback when no recap exists
- `Open project`

The briefing does not generate or refresh project recaps. It reuses current
stored recaps so opening the page remains fast and free of model calls.

### Empty State

When nothing is active, waiting, failed, recently changed, or resumable:

> Everything is quiet. No task needs your attention right now.

The page still shows the refresh timestamp and a link back to the workspace.

## Classification Rules

Classification is pure and deterministic.

### Unresolved Question

A task has an unresolved question when its newest persisted tool message with
an `ask` payload has questions and no answers.

Corrupt tool-message JSON is ignored rather than failing the briefing.

### Current Failure

A task is considered failed for briefing purposes when the newest meaningful
message is:

- a failed tool result persisted in tool data
- a system/error message using Operator's failure form
- an agent-auth or usage-limit failure that remains current

An older failure followed by a later successful assistant response is not
presented as current.

### Ready

A task is ready when:

- `status = in_progress`
- `running = 0`
- `awaiting_input = 1`
- it has no unresolved question
- its latest meaningful state is not a current failure

The UI must say `Ready for review`, not `Needs your decision`.

### Stale

A ready task is stale when its latest meaningful activity is more than seven
days old. Seven days is a named constant and can be changed later without a
schema migration.

## Data Model

### Briefings Table

Add a `briefings` table:

| Column | Type | Meaning |
|-|-|-|
| `id` | text primary key | Opaque stable briefing id |
| `generated_at` | integer | Point-in-time generation timestamp |
| `previous_id` | text nullable | Immediately preceding briefing |
| `content_json` | text | Versioned classified sections rendered by the UI |
| `snapshot_json` | text | Bounded factual task snapshot used for comparison |
| `speech_text` | text | Sanitized deterministic read-aloud text |
| `decision_count` | integer | Cached history-list count |
| `problem_count` | integer | Cached history-list count |
| `active_count` | integer | Cached history-list count |
| `ready_count` | integer | Cached history-list count |

The snapshot shape inside `snapshot_json` is:

```json
{
  "version": 1,
  "generatedAt": 1786300000000,
  "tasks": {
    "<task-id>": {
      "status": "in_progress",
      "running": false,
      "awaitingInput": true,
      "updatedAt": 1786299000000,
      "mergedAt": 0,
      "generation": 1,
      "latestMessageId": "<message-id-or-null>"
    }
  }
}
```

Rules:

- Include only real tasks in non-deprecated projects.
- Cap the serialized snapshot at a documented maximum. If the cap is exceeded,
  retain the most recently updated tasks.
- Invalid JSON, unknown versions, impossible timestamps, or missing fields
  in the preceding record cause a first-brief comparison fallback rather than a
  server error.
- The snapshot contains no transcript text.
- Briefing rows are immutable after insertion.
- There is no automatic retention limit and no delete route in the first
  release.
- Generation and insertion happen in one database transaction. If insertion
  fails, the API reports failure and no partial briefing exists.

This requires one additive database migration.

### History and Permanent URLs

- `/brief` shows the newest briefing plus a chronological history list.
- `/brief/<id>` shows one immutable briefing.
- History is newest first and paginated.
- Each history row shows generation time and the four cached section counts.
- A `Briefings` collection shortcut in `/artifacts` links to `/brief`. It does
  not duplicate briefing rows into the `artifacts` table, whose records require
  task/project provenance that a global briefing does not have.
- Prior briefing URLs remain valid indefinitely unless the whole Operator
  database is intentionally removed or restored from an older backup.

## Server Architecture

### `lib/briefing.ts`

Owns:

- database reads for briefing candidates
- safe parsing of tool messages
- message sanitization and bounds
- classification
- priority ordering
- snapshot comparison
- deterministic speech-text construction

Its public functions use plain data inputs/outputs so classification and
comparison can be unit-tested without routes or React.

### Routes

- `POST /api/briefings`
  - builds and inserts one new immutable factual briefing
  - compares against the newest existing briefing
  - returns the new id and full content
  - serializes concurrent generation so two clicks cannot create two briefings
    against the same predecessor
  - does not call an agent or model
- `GET /api/briefings`
  - returns bounded, paginated history metadata
- `GET /api/briefings/<id>`
  - returns one stored immutable briefing
- `GET /api/briefings/latest`
  - returns the newest briefing or 404 when none exists

Both routes use Operator's existing origin authentication.

## Client Architecture

### `/brief`

Implement as a dedicated responsive page rather than a modal. A page:

- is linkable and refreshable
- works naturally on the phone
- preserves browser Back
- has enough vertical space for a real workspace briefing
- keeps the main orchestrator shell from accumulating another complex overlay

`/brief/<id>` uses the same presentation component with immutable stored data.
The history list stays reachable from both routes.

### Shared Components

Create focused briefing components:

- `BriefingPage`
- `BriefingSection`
- `BriefingTaskRow`
- `BriefingProjectRow`
- `BriefingHistory`
- `ReadAloudButton`

Do not add briefing logic to `app/Orchestrator.tsx` beyond navigation.

### Read Aloud

`Read aloud`:

- is visible only when `window.speechSynthesis` and
  `SpeechSynthesisUtterance` exist
- starts only after a user click
- reads the server-provided deterministic `speechText`
- cancels any existing Operator utterance before starting
- exposes `Stop`
- cancels on page unmount
- never reads raw errors, file paths, tool output, URLs, ids, or timestamps with
  millisecond precision

Speech failure leaves the text briefing fully usable and shows a small
non-blocking message.

No voice picker, speed setting, persona, microphone, or audio persistence is
part of this release.

## Sanitization and Privacy

- All briefing prose is derived from local Operator data.
- No new external network destination is introduced.
- Remove absolute paths, artifact ids, session ids, source ids, and URLs from
  spoken text.
- Bound every transcript-derived field before returning it.
- Strip Markdown and JSON/tool chrome.
- Never include attachment paths or raw tool-result bodies.
- HTML rendering uses React text nodes; no transcript-derived `dangerouslySetInnerHTML`.

## Error Handling

- Database read failure: return a normal 500 JSON error; page shows `Could not
  build the briefing` with Retry.
- Corrupt tool JSON: ignore that message and use the next safe fallback.
- Missing recap: show the most recently touched task instead.
- Invalid preceding snapshot: treat comparison as a first briefing.
- Insert failure: show `Could not save this briefing`; do not display an
  unarchived result as if it were permanent.
- Duplicate concurrent generation: return the single committed result to both
  callers.
- Missing historical id: return the normal not-found page without changing
  history.
- Unsupported speech synthesis: omit `Read aloud`.
- Speech error: stop playback and retain the readable briefing.
- Empty data: show the quiet-state message.

## Performance

- Use bounded queries rather than loading every full transcript.
- Fetch only the latest small set of messages needed to classify each current
  candidate.
- Cap expanded rows per section, with `Show all` for overflow.
- Build the page in one API request.
- No AI latency and no per-brief token cost.
- Target a sub-second local response for ordinary databases.

## Testing

### Unit Tests

- unresolved question classification
- answered question exclusion
- current failure classification
- old failure superseded by later success
- active task last-activity preference
- ready versus stale split
- priority and waiting-time ordering
- corrupt tool JSON fallback
- transcript sanitization and bounds
- first-brief 24-hour behavior
- snapshot diff for new, active, waiting, status-changed, merged, and updated
- invalid/oversized snapshot fallback
- deterministic speech text excludes sensitive/internal material

### Route Tests

- generation inserts one immutable briefing with all sections
- generation compares against the immediately preceding record
- concurrent generation produces one committed successor
- history metadata is newest first and paginated
- historical detail returns stored content without recalculation
- an unknown historical id returns 404
- there is no update or delete route
- deprecated projects and suggested tasks are excluded

### Component Tests

- loading, error, empty, and populated states
- exact task/project links
- overflow disclosures
- newest briefing and paginated history
- permanent historical briefing links
- Artifacts `Briefings` shortcut reaches `/brief`
- Read aloud hidden when unsupported
- Read aloud starts, stops, and cancels on unmount

### Integrated Verification

- desktop and narrow-phone layouts
- Tailscale `/brief` access through the existing Operator origin
- browser Back returns to the prior workspace state
- a live structured ask appears under `Needs your decision`
- a settled ordinary turn appears under `Ready for review`
- an old open session is collapsed under `Older open sessions`
- second visit accurately reports changes since the first
- the first briefing remains accessible after generating several more

## Scope Exclusions

Not in this release:

- Telegram
- SMS, email, Slack, or push delivery
- scheduled or automatic briefings
- browser notifications from the briefing
- microphone input or transcription
- always-on narration
- native macOS companion
- AI-generated briefing prose
- personas, custom voices, or voice settings
- manual briefing deletion, editing, or sharing
- automatic cleanup or status changes for stale tasks

## Success Criteria

The release succeeds when Geo can open one Operator page on desktop or phone
and, in under a minute:

1. identify every task waiting on a real decision
2. distinguish real questions from ordinary ready-for-review turns
3. see what agents are currently doing
4. understand what changed since the previous briefing
5. resume the most relevant project or task with one tap
6. optionally hear the same safe summary aloud
7. reopen any earlier briefing from Briefing History

It must accomplish this without a second messaging channel, an additional
account, scheduled interruptions, or new model usage.
