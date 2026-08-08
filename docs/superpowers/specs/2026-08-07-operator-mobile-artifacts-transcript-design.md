# Operator Mobile Artifacts and Durable Transcript Design

Date: 2026-08-07  
Status: Approved for implementation planning  
Owner: Operator

## Purpose

Make finished agent deliverables easy to open from a phone and make Operator
transcripts reliable enough that Geo can always find, timestamp, and copy what
either side said.

The release combines four related improvements:

1. A global, recent-first artifact library inside Operator.
2. An explicit agent tool for publishing finished files into that library.
3. Permanent, chronological display of every user submission, including
   answers sent through question cards.
4. Timestamps and copy controls throughout the human-readable transcript.

## Product Decisions

- The artifact library lives inside Operator at `/artifacts`; it is not a
  separate repository or service.
- The library covers every non-deprecated Operator project in one feed.
- Artifacts appear only when an agent explicitly publishes them.
- The natural-language instruction Geo needs to remember is “Publish that
  artifact” or “Publish `<filename>`.”
- The agent-facing mechanism is a portable `publish_artifact` MCP tool,
  available to every supported agent in the same way as Operator’s existing
  workstream tools.
- Published files are copied into Operator-owned durable storage. The library
  never depends on the source worktree continuing to exist.
- Every artifact records its originating project and task and links back to the
  exact task.
- Every user input path produces a persistent, visible transcript entry.
- Every user message and assistant prose section displays a timestamp.
- Every user and assistant message can be copied as a whole. Every fenced code
  block can also be copied independently.
- The first release remains private behind Operator’s existing authentication.
  Public or tokenized artifact sharing is out of scope.

## User Experience

### Publishing

Geo asks an agent to create an HTML report and then says:

> Publish that artifact.

The agent calls `publish_artifact` with the workspace-relative file path and an
optional human-readable title. Operator:

1. Validates that the file is inside the task workspace.
2. Validates the type and size.
3. Copies the bytes into Operator-owned artifact storage.
4. Inserts an immutable metadata record.
5. Returns the stable artifact URL.
6. Emits a transcript notice with `Open artifact`, `Copy link`, and
   `View all artifacts` actions.

The tool result is explicit. A successful result names the published artifact
and returns its stable URL. A rejected result explains exactly what must change,
such as an unsupported extension or oversized file.

### Artifact Library

`/artifacts` is a phone-first page on the existing Operator origin. It shows:

- Artifact title and filename.
- File type.
- Publish timestamp in the viewer’s local timezone.
- Project tag.
- Task tag.
- Open, copy-link, and download actions.

The default order is newest first. A compact search field matches title,
filename, project name, and task title. The first release may include a simple
file-type filter, but it does not add folders or user-defined tags.

Tapping the task tag opens:

`/?project=<project-id>&task=<task-id>`

The project tag opens the project in Operator. Navigation preserves normal
browser back behavior so Geo can return to the artifact list.

### Transcript

The transcript preserves the existing distinction between user and agent
content while adding a consistent metadata row:

- Speaker.
- Local timestamp.
- Copy button.

All controls remain visible and finger-sized on touch devices. Desktop styling
may make controls visually quieter until hover or focus, but they remain
keyboard reachable.

Question-card answers no longer exist only as state inside the tool card. On
submission, Operator persists a separate human-readable user transcript entry
containing each question and Geo’s selected or free-text answer. The original
question card remains in place and becomes read-only. This creates an auditable
sequence:

1. Agent question.
2. Geo’s visible answer.
3. Agent continuation.

The answer entry is transcript-only context metadata when the live agent has
already received the structured answer through the ask bridge; it must not be
sent to the agent a second time. On the fallback path where no live ask is
waiting, the existing normal-resume message remains the single agent input and
the visible user entry is that same persisted message.

Persisting a live question-card answer is idempotent by ask id. Retrying the
HTTP request may deliver the existing success result, but it cannot create a
second visible user entry.

### Copying

The message-level Copy button copies the message’s readable source text, not
rendered HTML. It includes links as their Markdown URLs and excludes speaker
labels, timestamps, tool chrome, and copy-button labels.

Each fenced code block receives its own Copy button through the Markdown
renderer. It copies only the code text, excluding the fence and language label.

After copying, the button briefly reads `Copied`. Clipboard failure produces a
small visible error and leaves the text selectable; it is never silently
ignored.

## Architecture

### Storage

Add an `artifacts` table:

| Column | Type | Meaning |
|---|---|---|
| `id` | text primary key | Opaque public identifier |
| `project_id` | text | Originating project |
| `task_id` | text | Originating task |
| `generation` | integer | Session generation at publication |
| `title` | text | Display title |
| `filename` | text | Sanitized original filename |
| `content_type` | text | Server-selected MIME type |
| `byte_size` | integer | Stored byte count |
| `sha256` | text | Content fingerprint |
| `storage_name` | text | Server-generated on-disk filename |
| `created_at` | integer | Publication time |

Foreign keys reference projects and tasks. Deleting a task or project deletes
the metadata rows and triggers best-effort removal of the corresponding stored
files. A failed filesystem cleanup does not block the database deletion and is
logged for later maintenance.

Artifact bytes live under:

`<DB_DIR>/artifacts/<artifact-id>/<storage-name>`

The directory is outside every repository and worktree. The server generates
both path segments; user-supplied paths never participate in the serving path.

Publishing the same source bytes twice creates two publication records because
the timestamp and task context may differ. The checksum supports integrity
checks and future deduplication without making deduplication part of this
release.

### Supported Files

The first release supports the existing workstream deliverable allowlist:

- HTML
- PDF
- DOCX
- XLSX
- PPTX
- PNG, JPEG, GIF, and WebP
- Markdown, text, CSV, and JSON
- SVG
- ZIP
- Legacy Office formats already recognized by Operator

The maximum is 10 MB per artifact, matching Operator’s current chat-upload
ceiling. The publish tool accepts one file per call. An agent publishing several
files calls it once per file, yielding independent library entries and URLs.

### Agent Tool

Add `publish_artifact` to the shared agent-tool layer and expose it through:

- The Claude in-process MCP server.
- The Codex/LiteLLM stdio MCP bridge.
- The internal authenticated HTTP endpoint used by that bridge.

Input:

```json
{
  "path": "reports/lease-analysis.html",
  "title": "Lease Analysis"
}
```

`path` is required and may be workspace-relative or absolute. `title` is
optional; the filename stem is the fallback.

Validation follows the hardened workstream-attachment pattern:

- Resolve the task’s current workspace.
- Resolve symlinks with `realpath`.
- Require the file to remain strictly inside that workspace.
- Require a regular, non-empty file.
- Select MIME type from the server allowlist, never from caller input.
- Enforce the size limit before reading the full file.
- Sanitize the display filename and title.

On success, the tool returns structured data plus readable text:

```json
{
  "status": "published",
  "artifactId": "<id>",
  "title": "Lease Analysis",
  "url": "<operator-origin>/artifacts/<id>",
  "libraryUrl": "<operator-origin>/artifacts"
}
```

The tool is an explicit action. Creating or editing an HTML file does not
publish it automatically.

### Server Routes

- `GET /api/artifacts`
  - Returns recent artifact metadata joined with project and task labels.
  - Supports bounded `q`, `type`, `limit`, and cursor parameters.
  - Default page size: 50; maximum: 100.
- `GET /api/artifacts/<id>`
  - Returns metadata for one artifact.
- `GET /api/artifacts/<id>/content`
  - Serves inline content when safe to preview.
- `GET /api/artifacts/<id>/download`
  - Serves the original bytes with attachment disposition.
- `POST /api/internal/agent-tools/publish-artifact`
  - Authenticated bridge endpoint mirroring the shared tool implementation.

All routes remain behind Operator’s existing authentication. An unknown,
deleted, or inaccessible artifact returns 404 without revealing filesystem
paths.

### Safe HTML Preview

Agent-generated HTML must not execute with Operator’s application privileges.
The artifact detail page embeds HTML content in a sandboxed iframe. The content
response applies a restrictive Content Security Policy:

- Sandboxed unique origin.
- No scripts.
- No top navigation.
- Inline styles allowed.
- Images allowed from the artifact response, data URLs, and HTTPS.
- No access to Operator cookies or storage.

The detail page also offers `Download original`. Interactive HTML that requires
JavaScript is intentionally unsupported in the first release. This is a
security boundary, not a presentation preference.

PDF and browser-native image/text formats preview inline. Office and archive
formats display metadata with a download action.

### Artifact UI Integration

Add an `Artifacts` entry to Operator’s global navigation rather than to a
single project. The page is a normal application route so it works at the same
private phone hostname and uses the existing theme.

When a publish event occurs in the currently open task, the transcript receives
a persisted system notice containing the artifact id. The client renders that
notice as an artifact card instead of relying on a fragile Markdown filesystem
link.

### Transcript Data

The `messages` table already stores `created_at`; the client currently drops it.
Add `createdAt` to the client `Msg` shape and preserve it through:

- Snapshot mapping.
- Queued-message mapping.
- Every live transcript event.
- Ask-answer persistence.
- Session-break rendering where a timestamp is meaningful.

Live events use the timestamp of the database row they represent. They do not
invent a separate client timestamp. Pending-message events use the pending row’s
stored timestamp.

Add `source TEXT NOT NULL DEFAULT 'chat'` and nullable `source_id TEXT` columns
to `messages`, plus a partial unique index on `(task_id, source, source_id)`
when `source_id` is not null. Historical and ordinary messages retain
`source='chat'`. A live question-card answer is stored as:

- `role='user'`
- `source='ask_answer'`
- `source_id=<ask-id>`
- `content=<human-readable questions and answers>`

Persist this row only after the answer submission is accepted. The unique index
makes retries idempotent without wrapping metadata into user-visible Markdown.
The snapshot and live event expose `source`, allowing the client to render a
small `answer` badge. The content remains ordinary readable text for transcript
summarization.

No user entry is collapsed. Assistant tool calls may remain condensed because
they are machinery rather than user conversation. Consecutive assistant prose
segments may suppress repeated speaker labels, but each prose section still
shows its own timestamp and copy control.

## Error Handling

- Publishing failure does not delete or modify the source file.
- If the database insert fails after the file copy, remove the orphaned copy
  best-effort and return an error.
- If the copy fails, do not insert metadata.
- If an artifact file is unexpectedly missing, the library retains enough
  metadata to show an unavailable state and logs the integrity failure.
- Copy failures are visible in the transcript UI.
- If persisting a question-card answer fails, do not visually claim that it was
  saved. Keep the answer controls populated and offer retry.
- Artifact-list fetch errors show retry UI without breaking the rest of
  Operator.

## Accessibility and Mobile Requirements

- Copy, open, download, project, and task controls have at least a 44 px touch
  target where practical.
- Copy-result status uses an ARIA live region.
- Timestamps use semantic `<time>` elements with machine-readable values and
  full date/time in the accessible label.
- The artifact list is usable at 320 px viewport width without horizontal
  scrolling.
- Artifact titles and task names wrap instead of truncating essential context.
- Keyboard focus order follows visible order.

## Testing

### Artifact Domain

- Migration creates the artifact table on new and existing databases.
- Publishing accepts a valid file inside the workspace.
- Relative and absolute in-workspace paths behave identically.
- Parent traversal and symlink escape are rejected.
- Directories, empty files, unsupported types, and oversized files are
  rejected.
- A published copy remains available after the source file and worktree are
  removed.
- Metadata records the correct project, task, generation, MIME type, size, and
  checksum.
- Database or filesystem failures do not leave inconsistent records.

### Routes and Security

- Artifact list is newest first and filters correctly.
- Task deep links contain the correct project and task ids.
- Unknown ids return 404.
- Serving routes never expose an absolute filesystem path.
- HTML responses carry the required sandbox and CSP headers.
- HTML cannot execute a script or navigate the Operator page.
- Download responses use a safe filename and attachment disposition.

### Transcript

- Snapshot messages retain their database timestamps.
- Live and queued messages show their persisted timestamps.
- Main-composer messages remain after reload.
- Question-card answers create a permanent user entry and remain after reload.
- The structured answer is delivered to a live ask exactly once.
- Fallback answer/resume does not create duplicate agent input.
- User messages are never hidden by condensation.
- Assistant prose sections show timestamps even when repeated speaker labels
  are suppressed.

### Copying

- Message copy returns source text and URLs without UI chrome.
- Code-block copy returns code only.
- Copy buttons work with mouse, keyboard, and touch.
- Successful copy announces `Copied`.
- Clipboard rejection produces visible feedback.

### Regression

- Existing transcript streaming, reconnection, queueing, ask-answer behavior,
  context renewal, and tool condensation continue to pass.
- Claude, native Codex, and LiteLLM Codex all expose the publish tool.
- Existing workstream attachment publishing remains unchanged.
- Production build and the full Operator verification suite pass.

## Rollout

This is one release but should be implemented in independently testable slices:

1. Artifact storage, schema, and publish-domain function.
2. Agent tool and bridge exposure.
3. Artifact routes and secure preview.
4. Global Artifacts UI and task deep links.
5. Timestamp propagation and rendering.
6. Permanent question-answer transcript entries.
7. Message and code-block copy controls.
8. Integrated mobile and regression verification.

No data backfill is needed for timestamps because historical messages already
have `created_at`. Existing HTML files are not auto-imported; Geo can ask an
agent to publish any older file that should enter the library.

## Out of Scope

- A separate artifact repository or server.
- Automatic filesystem scanning.
- Public or tokenized sharing.
- In-browser editing.
- User-defined folders or tags.
- Artifact version comparison.
- Script-enabled HTML.
- Automatic import of existing repository HTML files.

## Success Criteria

The release is successful when Geo can:

1. Ask an agent to create and publish an HTML report using ordinary language.
2. Open one memorable private Operator URL on a phone and see the new report at
   the top.
3. Identify its project and task and return to that task with one tap.
4. Review a transcript and find every response Geo submitted, including
   question-card answers.
5. See when each user and assistant prose section arrived.
6. Copy any complete message, link-bearing response, or fenced code block with
   one button.
