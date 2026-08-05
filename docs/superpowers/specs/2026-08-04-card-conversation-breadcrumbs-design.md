# Card Conversation Breadcrumbs and Bot Attribution

**Date:** August 4, 2026

## Goal

Whenever a supported coding conversation creates or updates a tracker card, the
card should retain an exact breadcrumb to that conversation in AI Workspace.
Automated comments must clearly identify `Geo's Bot` rather than appearing to
come directly from Geo.

## Approved visible identities

- Standalone automated comment: `Geo's Bot`
- Connected workstream comment: `Geo's Bot · Workstream Update`
- Human comments entered in the tracker: unchanged, with Geo's normal identity

The database may continue using Geo's user ID where a foreign key is required.
The visible `author_label` is the authoritative display identity for automated
comments.

## Exact session identity

The integration must use the exact creating or updating session. It must never
guess from the newest or most recently modified conversation.

Runtime identity is resolved from trusted harness context:

1. A normalized tracker session context injected by Operator or a supported
   session hook.
2. Native Claude or Codex session identifiers when available.
3. An explicit session identifier supplied by the current harness as a recovery
   path.

The resolved identifier and source are validated before use. The MCP retrieves
metadata for that exact identifier from the local conversations dashboard.

## Create and update flow

For `create_card`:

1. Validate and create the card.
2. Resolve the exact current session.
3. Fetch the exact session's title, source, project path, summary, and modified
   time from the conversations dashboard.
4. Upsert a `card_conversations` breadcrumb for the new card.
5. Return both the card result and breadcrumb status.

For standalone `add_comment`:

1. Validate and insert the comment with `author_label = "Geo's Bot"`.
2. Resolve and upsert the current conversation breadcrumb.
3. Return both the comment result and breadcrumb status.

For connected workstream updates:

1. Keep the task-derived workstream destination.
2. Insert the comment with
   `author_label = "Geo's Bot · Workstream Update"`.
3. Ensure the linked Operator session is represented in AI Workspace.

The existing `attach_conversation` tool remains as an explicit recovery tool and
for attaching older conversations.

## Failure behavior

Card creation and a valid comment are not rolled back if the local conversations
dashboard is temporarily unavailable.

The tool must return a clear structured result:

- `attached`: exact breadcrumb is present.
- `already_attached`: the idempotent breadcrumb already existed.
- `needs_retry`: the card/comment succeeded, but exact session metadata could
  not be attached.
- `unavailable`: no trustworthy current session identity was available.

Failures must never silently attach a different conversation. A retry uses the
same card and session pair, so it cannot create duplicate breadcrumbs.

## AI Workspace behavior

The breadcrumb appears in the existing AI Workspace conversation list with:

- conversation title;
- source;
- last activity;
- `Continue in Operator`.

The feature does not depend on the breadcrumb being secret. Operator navigation
still works only where the local conversation and Operator service are
available. Local paths, raw session identifiers, and internal URLs are not
copied into card comments.

Existing owner-only project paths and workstream controls remain protected.

## Attribution rules

Automated paths may not omit the visible bot label or accept an arbitrary label.

- `add_comment` has the fixed label `Geo's Bot`.
- Workstream SQL has the fixed label
  `Geo's Bot · Workstream Update`.
- Legacy Claude, Codex, agent, and session-name attribution inputs remain
  removed.
- Direct writes remain blocked only inside a linked workstream context.
  Standalone card creation and updates remain available.

## Verification

Tests must prove:

1. Claude, Codex, and Operator runtime contexts resolve the exact session.
2. No identity falls back to the newest conversation.
3. Card creation attaches one breadcrumb idempotently.
4. Standalone updates refresh or attach the current breadcrumb.
5. Dashboard failure preserves the successful card/comment and reports
   `needs_retry`.
6. Standalone comments display `Geo's Bot`.
7. Workstream comments display `Geo's Bot · Workstream Update`.
8. Human browser comments retain the human identity.
9. `Continue in Operator` uses the attached exact session.
10. No card-facing comment contains local paths, raw session IDs, or internal
    navigation URLs.

## Scope

This change covers automatic conversation breadcrumbs and automated comment
identity. It does not make local conversations remotely accessible to other
tracker users and does not change normal human comment attribution.
