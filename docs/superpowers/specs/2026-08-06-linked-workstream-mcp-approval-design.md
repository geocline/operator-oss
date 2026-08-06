# Linked Workstream MCP Approval Design

## Problem

Operator launches Codex task turns non-interactively with
`approvalPolicy: "never"`. The linked workstream MCP server is present and its
`publish_workstream_update` schema correctly accepts optional workspace files,
but Codex cancels every call before the MCP server executes it. The rollout log
records a zero-duration result of `user cancelled MCP tool call`, including for
an update with no attachments.

The failure is therefore at the Codex MCP approval boundary. It is not caused
by attachment paths, HTML validation, the Operator internal endpoint, Card
Tracker, or workstream state.

## Selected Design

Keep Operator's existing non-interactive sandbox and approval policy. In the
per-turn Codex MCP configuration, explicitly approve only the two linked
workstream tools that are intentionally authorized by the task harness:

- `publish_workstream_update`
- `propose_card_change`

Do not change the approval behavior for `suggest_task`, `expose_service`,
`ask_user`, or any other MCP server.

## Data Flow

1. Operator starts or resumes a linked Codex task.
2. The Codex driver registers the task-scoped `orchestrator` MCP server with
   task ID, project ID, loopback origin, and service token.
3. The driver marks the two workstream tools with MCP
   `approval_mode: "approve"`.
4. Codex executes those calls without trying to surface an unavailable
   interactive approval.
5. The existing MCP bridge posts to Operator's authenticated internal route.
6. Operator resolves the destination exclusively from the current task link,
   validates the body and files, queues the outbox event, and delivers it
   through Card Tracker's atomic workstream endpoint.

No card ID, workstream ID, author identity, or destination becomes
model-controlled.

## Failure Handling

- Missing or invalid task/project scope remains rejected by Operator.
- Files outside the task workspace remain rejected.
- Unsupported or privacy-invalid attachments remain rejected.
- Paused and disconnected workstreams retain their existing behavior.
- Tracker delivery failures remain queued or rejected according to the
  existing outbox policy.
- Only the premature Codex approval cancellation changes.

## Verification

1. Add a regression test that inspects the Codex per-turn configuration and
   fails until the two workstream tools are explicitly approved.
2. Confirm unrelated orchestrator tools do not receive the override.
3. Run the focused Codex driver and linked-harness tests.
4. Run the repository verification command.
5. Confirm no Operator task is running before restart.
6. Restart Operator and verify the service is listening.
7. Resume the existing `Fortress API access` Codex session through its
   Operator task with the same logical attachment request.
8. Confirm the linked card receives one comment with both HTML attachments.

## Scope

This change is limited to Operator's Codex driver configuration and its tests.
It does not modify Card Tracker, attachment validation, workstream routing,
global Codex settings, or unrelated MCP permissions.
