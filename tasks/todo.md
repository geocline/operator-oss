# Office view + card status sync (2026-09-07)

Goal: a visual "office floor" of every live Operator task (avatar per task, rooms by state), a per-task
status log that syncs to the linked Ardent tracker card, and round-trip links Operator <-> card <-> floor.

## Decisions (Geo, 2026-09-07)
- One floor for all active projects by default; project switcher narrows to one office.
- Rooms map to existing task fields, no new statuses:
  - Reception = status not_started
  - Bullpen = in_progress and running = 1
  - Break Room = in_progress and running = 0 (waiting on Geo / idle after a turn)
  - The Warehouse = status on_hold
  - done / cancelled leave the floor (Alumni drawer lists them)
- Edit a short display alias, never the title. Name tag = alias (default first ~14 chars of title).
- Default avatar look = deterministic from task id; per-task override.
- Status log = the EXISTING task_notes table (already "where the user left off" breadcrumbs, survives /clear).
  Newest first. Latest note = "my status". Nothing is deleted on retire; card is the long-term home.
- Card sync = new workstream outbox event `status_note` -> tracker AI Workspace panel (latest + expandable log).
  Respects paused/disconnected links. Never touches the comment thread.
- v1 renders with DOM/CSS + <canvas> avatars from a ported portraitArt.ts (MIT, from munder-difflin). No Pixi.
- Tileset skin (LimeZu paid vs CC0/flat) decided separately; it is a skin over the same room layout.

## Contracts (fixed so agents can work in parallel)

### Operator DB
- `task_visuals(task_id TEXT PK REFERENCES tasks ON DELETE CASCADE, display_name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '' /* JSON recipe, opaque to server, <= 2KB */, updated_at INTEGER NOT NULL)`

### Operator API
- `GET /api/office` -> `{ projects: {id,name}[], tasks: OfficeTask[] }` where OfficeTask =
  `{ id, project_id, title, status, running, awaiting_input, started, agent, priority, updated_at, turn_started_at,
     display_name: string /* '' when unset */, avatar: object|null, latest_note: {content, created_at}|null,
     card_url: string|null }`. Excludes done/cancelled and suggested=1. Active projects only.
- `PATCH /api/tasks/[id]/visual` body `{ display_name?: string (<=24 chars), avatar?: object|null }` -> the row.
- `GET /api/tasks/[id]/workstream` additionally returns `card_url` (`${ARDENT_TRACKER_BASE_URL}/?card=<external_card_id>`)
  when the link exists and the base URL is configured.
- Existing `GET/POST /api/tasks/[id]/notes` unchanged in shape. POST additionally enqueues `status_note`
  when the task has an active workstream link.

### Operator -> tracker wire (workstream outbox, event_type `status_note`)
POST `${ARDENT_TRACKER_BASE_URL}/api/workstream-bridge/update` (same auth as routine_update) with
`{ workstream_id, event_type: "status_note", note: { id, content, created_at, generation }, task_status }`.
Content passes `lib/workstreams/sanitize.ts` card-facing rules; a violation fails the event (no retry storm).

### Tracker
- Persist status notes per workstream (id unique, idempotent). Expose in the card workstream owner response.
- AI Workspace panel: "Operator status" line = latest note + relative time; expandable, scrollable older log.

## Work split (parallel agents, strict file ownership)
- [x] A backend (operator): lib/db.ts, lib/store.ts, lib/types.ts, lib/workstreams/{types,store,worker}.ts,
      app/api/office/route.ts, app/api/tasks/[id]/visual/route.ts, app/api/tasks/[id]/notes/route.ts, tests/
- [x] B session links (operator): lib/workstreams/client.ts (export trackerCardUrl), app/api/tasks/[id]/workstream/route.ts,
      app/orchestrator/SessionView.tsx (Open card button; latest-status line -> Notes tab), app/orchestrator/types.ts
- [x] C office view (operator): app/orchestrator/office/** (portraitArt port + ATTRIBUTION), app/Orchestrator.tsx,
      app/orchestrator/useOrchestrator.ts (view id "office"), CSS, command palette entry, mobile layout
- [x] D tracker (deal-tracker-app): bridge update route accepts status_note, storage, owner response, CardModal AI Workspace UI, tests

## Verify
- [x] `npm test` green in operator (902 passed); tracker `npm run test:workstreams` 118/118; `npx tsc --noEmit` clean in both
- [x] Manual (preview on :3210, tmp DB): Open card link resolves to `${ARDENT_TRACKER_BASE_URL}/?card=<id>`; Status line in header shows newest note
- [x] Supabase migration 0053 applied 2026-09-08 via SQL editor (table + index + policy confirmed). Card-panel render of a live note still to be eyeballed on a real linked task.
- [x] Office view: all four rooms populate; Bullpen walk cycle; task moved Warehouse -> Break Room live on a status PATCH; alias + look persisted via PATCH visual; mobile stack + bottom sheet
- [x] README.md updated (Office view bullet + tracker linking bullet)

## Review (2026-09-07)
- Coordinator fixes after the agents: Bullpen canvases were blank until the first rAF tick (now paint frame 0 synchronously in Avatar.tsx);
  name tags were clipped at 56px (slot 104px, tag 84px, truncate at 16 chars); tests/workstreamCommands.test.ts updated for card_url.
- Geo must apply `/Users/geo/Claude Projects/Ardent/deal-tracker-app/app/supabase/migrations/0053_workstream_status_notes.sql`
  in the Supabase SQL editor before status notes can land on cards.
- Not committed (per Geo's request to hold commits); two repos have pending work: operator and deal-tracker-app.
- Deferred: `?view=office` deep link / browser-back for the office view (navHistory.ts); desktop room props.

## Phase 3: LimeZu skin (hosted-only) - DONE 2026-09-08 (verified in preview; asset paths fixed to include 1_Interiors/16x16/)
- Assets (purchased, Complete Version) extracted at `/Users/geo/Claude Projects/operator-private-assets/limezu/moderninteriors-win/`.
  Never copy into this repo. Serve at runtime from `ORCH_OFFICE_SKIN_DIR` (new env in lib/config.ts + .env.example) via a
  read-only static route; when unset the office renders the flat CSS rooms.
- 16x16 sheets to use: `1_Interiors/16x16/Room_Builder_16x16.png` (floors/walls) and `1_Interiors/16x16/Interiors_16x16.png` (furniture).
- Room layout stays the same four rooms; skin swaps floor/wall/plaque via CSS custom properties + a per-room background tile canvas.
- Credit LimeZu (https://limezu.itch.io/) in the office view's About/attribution.
