// Shared implementations of the orchestrator's agent-facing tools
// (suggest_task / expose_service). One home for the LOGIC so both callers agree:
//   - the Claude driver's in-process SDK MCP server (lib/agents/claude/driver.ts)
//   - the internal HTTP endpoints the stdio bridge proxies to
//     (app/api/internal/agent-tools/*), which serve Codex and any future CLI
//
// The tool *definitions* (names/descriptions/params) live in lib/agentToolDefs.mjs;
// this file is the behaviour behind them. Both are deliberately split so the
// plain-Node bridge (scripts/orch-mcp.mjs) can import the defs without pulling in
// the TS/SQLite graph.

import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Project, Task, ServiceInfo, Priority, AskQuestion, ToolData } from "./types";
import { createTask, setTaskDeps, addMessage, updateMessage, updateTask } from "./store";
import { SUGGEST_TASK_DEPS_ENABLED } from "./agentToolDefs.mjs";
import { exposeService } from "./services";
import { publish } from "./events";
import { waitForAnswer, settleAsk } from "./asks";
import { turnSignal } from "./abort";
import { formatAnswers } from "./agents/shared";
import {
  claimWorkstreamEvent,
  enqueueWorkstreamEvent,
  getWorkstreamByTask,
  getWorkstreamOutboxEvent,
  markWorkstreamDelivered,
  markWorkstreamFailed,
  releaseWorkstreamClaim,
  setWorkstreamState,
} from "./workstreams/store";
import {
  validateCardFacingPayload,
  validateCardFacingText,
} from "./workstreams/sanitize";
import {
  postWorkstreamProposalDetailed,
  postWorkstreamUpdateDetailed,
} from "./workstreams/client";
import type { WorkstreamBridgeResult } from "./workstreams/client";
import type {
  WorkstreamLink,
  WorkstreamOutboxEvent,
} from "./workstreams/types";

/**
 * Resolve `blocked_by` refs against a per-session title→id map: an id passes
 * through; a title of a task suggested earlier this session maps to its id;
 * anything else is left as-is (setTaskDeps drops unknown/foreign ids safely).
 * Callers own the map because it is inherently session-scoped — the Claude
 * driver keeps one per turn, the stdio bridge keeps one per (per-turn) process.
 */
export function resolveTitleRefs(refs: string[] | undefined, createdByTitle: Map<string, string>): string[] {
  return (refs ?? []).map((ref) => createdByTitle.get(ref) ?? ref);
}

export interface SuggestTaskInput {
  title: string;
  description: string;
  priority?: Priority;
  /** Already resolved to task ids (see resolveTitleRefs) — id passes through to setTaskDeps. */
  blocked_by?: string[];
}

export type WorkstreamToolStatus =
  | "delivered"
  | "queued"
  | "paused"
  | "disconnected"
  | "rejected";

export interface WorkstreamToolResult {
  status: WorkstreamToolStatus;
  text: string;
  eventId?: string;
}

export interface PublishWorkstreamUpdateInput {
  body: string;
  files?: string[];
}

export type CardChangeKind =
  | "card_update"
  | "complete_card"
  | "archive_card";

export interface ProposeCardChangeInput {
  kind: CardChangeKind;
  value: Record<string, unknown>;
}

interface WorkstreamAttachmentPayload {
  filename: string;
  content_type: string;
  content_base64: string;
}

interface RoutineUpdatePayload extends Record<string, unknown> {
  body: string;
  attachments: WorkstreamAttachmentPayload[];
}

interface ProposedChangePayload extends Record<string, unknown> {
  kind: CardChangeKind;
  payload: Record<string, unknown>;
}

const WORKSTREAM_FILE_TYPES = new Map<string, string>([
  [".html", "text/html"],
  [".pdf", "application/pdf"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  // Plain-text and data formats - added 2026-08-07 per George. The old
  // allowlist was a readability preference, not a safety boundary, and it
  // blocked ordinary reference material from reaching the card at all.
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".xls", "application/vnd.ms-excel"],
  [".doc", "application/msword"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".svg", "image/svg+xml"],
  [".zip", "application/zip"],
]);
const MAX_WORKSTREAM_FILES = 5;
const MAX_WORKSTREAM_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSTREAM_FILES_TOTAL_BYTES = 8 * 1024 * 1024;
const CARD_UPDATE_FIELDS = new Set([
  "title",
  "description",
  "column",
  "deal_tag",
  "due_date",
  "date_started",
  "paused_until",
  "priority",
  "assignee_ids",
]);
const CARD_COLUMNS = new Set([
  "new",
  "in_progress",
  "reopened",
  "waiting",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rejected(text: string): WorkstreamToolResult {
  return { status: "rejected", text };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function workstreamIdempotencyKey(
  task: Task,
  eventType: "routine_update" | "proposed_change",
  payload: RoutineUpdatePayload | ProposedChangePayload,
): string {
  return `task-event:${createHash("sha256")
    .update(
      canonicalJson({
        task_id: task.id,
        generation: task.generation,
        event_type: eventType,
        payload,
      }),
    )
    .digest("hex")}`;
}

function linkedWorkstream(
  task: Task,
  project: Project,
): WorkstreamLink | WorkstreamToolResult {
  if (task.project_id !== project.id) {
    return rejected("The current task does not belong to this project.");
  }
  const link = getWorkstreamByTask(task.id);
  if (!link) {
    return rejected("This task is not linked to a card workstream.");
  }
  return link;
}

function isWorkstreamToolResult(
  value: WorkstreamLink | WorkstreamToolResult,
): value is WorkstreamToolResult {
  return "text" in value;
}

async function loadWorkstreamAttachments(
  task: Task,
  project: Project,
  rawFiles: unknown,
): Promise<
  | { ok: true; attachments: WorkstreamAttachmentPayload[] }
  | { ok: false; result: WorkstreamToolResult }
> {
  if (rawFiles === undefined) return { ok: true, attachments: [] };
  if (
    !Array.isArray(rawFiles) ||
    rawFiles.length > MAX_WORKSTREAM_FILES ||
    rawFiles.some((file) => typeof file !== "string" || !file.trim())
  ) {
    return {
      ok: false,
      result: rejected(
        `Files must be a list of at most ${MAX_WORKSTREAM_FILES} workspace file paths.`,
      ),
    };
  }
  const workspace = (task.worktree_path || project.repo_path).trim();
  if (!workspace) {
    return {
      ok: false,
      result: rejected(
        "Files cannot be attached because this task has no configured workspace.",
      ),
    };
  }

  let workspaceReal: string;
  try {
    workspaceReal = await fs.realpath(workspace);
  } catch {
    return {
      ok: false,
      result: rejected("The current task workspace is unavailable."),
    };
  }

  const attachments: WorkstreamAttachmentPayload[] = [];
  let totalBytes = 0;
  for (const suppliedPath of rawFiles) {
    let resolved: string;
    let stats;
    try {
      const candidate = path.isAbsolute(suppliedPath)
        ? suppliedPath
        : path.resolve(workspaceReal, suppliedPath);
      resolved = await fs.realpath(candidate);
      const relative = path.relative(workspaceReal, resolved);
      if (
        !relative ||
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        path.isAbsolute(relative)
      ) {
        return {
          ok: false,
          result: rejected(
            "Every attached file must be inside the current task workspace.",
          ),
        };
      }
      stats = await fs.stat(resolved);
    } catch {
      return {
        ok: false,
        result: rejected(
          "An attached file is unavailable or outside the current task workspace.",
        ),
      };
    }
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_WORKSTREAM_FILE_BYTES) {
      return {
        ok: false,
        result: rejected(
          `Each attached deliverable must be a non-empty file no larger than ${MAX_WORKSTREAM_FILE_BYTES / 1024 / 1024} MB.`,
        ),
      };
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_WORKSTREAM_FILES_TOTAL_BYTES) {
      return {
        ok: false,
        result: rejected(
          `Attached deliverables may total no more than ${MAX_WORKSTREAM_FILES_TOTAL_BYTES / 1024 / 1024} MB.`,
        ),
      };
    }

    const filename = path.basename(resolved);
    const contentType = WORKSTREAM_FILE_TYPES.get(
      path.extname(filename).toLowerCase(),
    );
    const filenameValidation = validateCardFacingPayload({
      text: "Deliverable attached.",
      filenames: [filename],
    });
    if (!contentType || !filenameValidation.ok) {
      return {
        ok: false,
        result: rejected(
          `The tracker has no upload handler for "${filename}". Convert it to a supported format or add its extension to WORKSTREAM_FILE_TYPES.`,
        ),
      };
    }
    const content = await fs.readFile(resolved);
    attachments.push({
      filename,
      content_type: contentType,
      content_base64: content.toString("base64"),
    });
  }
  return { ok: true, attachments };
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function validateProposal(
  input: ProposeCardChangeInput,
): WorkstreamToolResult | null {
  if (
    input.kind !== "card_update" &&
    input.kind !== "complete_card" &&
    input.kind !== "archive_card"
  ) {
    return rejected("That card change kind is not supported.");
  }
  if (
    !input.value ||
    typeof input.value !== "object" ||
    Array.isArray(input.value)
  ) {
    return rejected("The proposed value must be an object.");
  }
  const keys = Object.keys(input.value);
  if (input.kind !== "card_update") {
    return keys.length
      ? rejected(`${input.kind} requires an empty value object.`)
      : null;
  }
  if (!keys.length || keys.some((key) => !CARD_UPDATE_FIELDS.has(key))) {
    return rejected(
      "A card update must contain one or more supported card fields.",
    );
  }

  const value = input.value;
  if (
    "title" in value &&
    (typeof value.title !== "string" ||
      !value.title.trim() ||
      value.title.length > 500)
  ) {
    return rejected("The proposed title is invalid.");
  }
  if (
    "description" in value &&
    (typeof value.description !== "string" ||
      value.description.length > 50_000)
  ) {
    return rejected("The proposed description is invalid.");
  }
  if (
    "column" in value &&
    (typeof value.column !== "string" || !CARD_COLUMNS.has(value.column))
  ) {
    return rejected("The proposed card column is invalid.");
  }
  if (
    "deal_tag" in value &&
    value.deal_tag !== null &&
    (typeof value.deal_tag !== "string" || value.deal_tag.length > 100)
  ) {
    return rejected("The proposed deal tag is invalid.");
  }
  for (const field of ["due_date", "date_started", "paused_until"] as const) {
    if (field in value && value[field] !== null && !isRealDate(value[field])) {
      return rejected(`The proposed ${field} is invalid.`);
    }
  }
  if ("date_started" in value && value.date_started === null) {
    return rejected("The proposed date_started cannot be null.");
  }
  if ("priority" in value && typeof value.priority !== "boolean") {
    return rejected("The proposed priority is invalid.");
  }
  if (
    "assignee_ids" in value &&
    (!Array.isArray(value.assignee_ids) ||
      value.assignee_ids.length > 50 ||
      value.assignee_ids.some(
        (id) => typeof id !== "string" || !UUID_PATTERN.test(id),
      ) ||
      new Set(value.assignee_ids).size !== value.assignee_ids.length)
  ) {
    return rejected("The proposed assignees are invalid.");
  }
  for (const field of ["title", "description", "deal_tag"] as const) {
    if (
      typeof value[field] === "string" &&
      !validateCardFacingText(value[field], `value.${field}`).ok
    ) {
      return rejected(
        "The proposal contains an invalid card field value.",
      );
    }
  }
  return null;
}

async function deliverOutboxEvent(
  link: WorkstreamLink,
  event: WorkstreamOutboxEvent,
): Promise<WorkstreamToolResult> {
  if (event.state === "delivered") {
    return {
      status: "delivered",
      text: "This workstream item was already delivered.",
      eventId: event.id,
    };
  }
  const claimed = claimWorkstreamEvent(event.id);
  if (!claimed) {
    const current = getWorkstreamOutboxEvent(event.id);
    return {
      status: "queued",
      text:
        current?.state === "delivering"
          ? "This workstream item is already being delivered."
          : "This workstream item is queued for delivery.",
      eventId: event.id,
    };
  }

  let delivery: WorkstreamBridgeResult;
  if (claimed.event_type === "routine_update") {
    const payload = claimed.payload as unknown as RoutineUpdatePayload;
    delivery = await postWorkstreamUpdateDetailed({
      externalWorkstreamId: link.external_workstream_id,
      idempotencyKey: claimed.idempotency_key,
      body: payload.body,
      attachments: payload.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.content_type,
        contentBase64: attachment.content_base64,
      })),
    });
  } else {
    const payload = claimed.payload as unknown as ProposedChangePayload;
    delivery = await postWorkstreamProposalDetailed({
      externalWorkstreamId: link.external_workstream_id,
      idempotencyKey: claimed.idempotency_key,
      kind: payload.kind,
      payload: payload.payload,
    });
  }

  if (delivery.ok) {
    markWorkstreamDelivered(claimed.id, claimed.claim_token);
    return {
      status: "delivered",
      text:
        claimed.event_type === "routine_update"
          ? "The team-facing update was delivered."
          : "The card change was applied to the card.",
      eventId: claimed.id,
    };
  }
  if (
    delivery.category === "state" &&
    (delivery.remoteState === "paused" ||
      delivery.remoteState === "activating" ||
      delivery.remoteState === "disconnected")
  ) {
    releaseWorkstreamClaim(
      claimed.id,
      claimed.claim_token,
      Date.now(),
    );
    const localState =
      delivery.remoteState === "disconnected"
        ? "disconnected"
        : "paused";
    setWorkstreamState(link.id, localState);
    return {
      status:
        delivery.remoteState === "disconnected"
          ? "disconnected"
          : "paused",
      text:
        delivery.remoteState === "disconnected"
          ? "This card workstream is disconnected. Nothing was posted."
          : "This workstream is not active. The item remains safely queued.",
      eventId: claimed.id,
    };
  }
  if (!delivery.retryable) {
    markWorkstreamFailed(
      claimed.id,
      claimed.claim_token,
      delivery.error,
      Number.MAX_SAFE_INTEGER,
    );
    return {
      status: "rejected",
      text: `The tracker rejected this card-facing item. Nothing was posted. Reason: ${delivery.error}.`,
      eventId: claimed.id,
    };
  }
  markWorkstreamFailed(
    claimed.id,
    claimed.claim_token,
    delivery.error,
    Date.now() + 30_000,
  );
  return {
    status: "queued",
    text: "Delivery is temporarily unavailable. The item remains queued.",
    eventId: claimed.id,
  };
}

export async function publishWorkstreamUpdate(
  task: Task,
  project: Project,
  input: PublishWorkstreamUpdateInput,
): Promise<WorkstreamToolResult> {
  const link = linkedWorkstream(task, project);
  if (isWorkstreamToolResult(link)) return link;
  if (link.state === "disconnected") {
    return {
      status: "disconnected",
      text: "This card workstream is disconnected. No update was queued.",
    };
  }
  if (
    typeof input.body !== "string" ||
    !input.body.trim() ||
    input.body.length > 20_000
  ) {
    return rejected("The update body must contain 1 to 20000 characters.");
  }
  const attachments = await loadWorkstreamAttachments(
    task,
    project,
    input.files,
  );
  if (!attachments.ok) return attachments.result;
  const body = input.body.trim();
  const validation = validateCardFacingPayload({
    text: body,
    filenames: attachments.attachments.map(
      (attachment) => attachment.filename,
    ),
  });
  if (!validation.ok) {
    return rejected(
      "The update contains an invalid card-facing value.",
    );
  }
  const payload: RoutineUpdatePayload = {
    body,
    attachments: attachments.attachments,
  };
  const event = enqueueWorkstreamEvent({
    linkId: link.id,
    idempotencyKey: workstreamIdempotencyKey(
      task,
      "routine_update",
      payload,
    ),
    eventType: "routine_update",
    payload,
  });
  if (link.state === "paused") {
    return {
      status: "paused",
      text: "This workstream is paused. The update is safely queued.",
      eventId: event.id,
    };
  }
  return deliverOutboxEvent(link, event);
}

export async function proposeCardChange(
  task: Task,
  project: Project,
  input: ProposeCardChangeInput,
): Promise<WorkstreamToolResult> {
  const link = linkedWorkstream(task, project);
  if (isWorkstreamToolResult(link)) return link;
  if (link.state === "disconnected") {
    return {
      status: "disconnected",
      text: "This card workstream is disconnected. No proposal was queued.",
    };
  }
  const invalid = validateProposal(input);
  if (invalid) return invalid;
  const payload: ProposedChangePayload = {
    kind: input.kind,
    payload: input.value,
  };
  const event = enqueueWorkstreamEvent({
    linkId: link.id,
    idempotencyKey: workstreamIdempotencyKey(
      task,
      "proposed_change",
      payload,
    ),
    eventType: "proposed_change",
    payload,
  });
  if (link.state === "paused") {
    return {
      status: "paused",
      text: "This workstream is paused. The proposal is safely queued.",
      eventId: event.id,
    };
  }
  return deliverOutboxEvent(link, event);
}

/**
 * Create a suggested task in `project` and (optionally) set its dependencies.
 * Returns the created task plus the human-readable confirmation text both the
 * MCP server and the HTTP endpoint hand back to the agent verbatim. Bad deps
 * degrade to a note rather than throwing (setTaskDeps drops foreign ids and
 * rejects cycles).
 */
export function createSuggestedTask(project: Project, input: SuggestTaskInput): { task: Task; text: string } {
  const task = createTask({
    project_id: project.id,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "med",
    suggested: true,
  });
  let depNote = "";
  // Gated on SUGGEST_TASK_DEPS_ENABLED (lib/agentToolDefs.mjs), which is off:
  // no agent may leave a task blocked without the user choosing it. The check
  // is here as well as in the two tool schemas because this is the one choke
  // point both the in-process server and the internal HTTP endpoint pass
  // through - a blocked_by from a stale client or a direct POST is dropped
  // rather than quietly honored. The wiring below is unchanged and runs again
  // the moment the flag flips.
  if (SUGGEST_TASK_DEPS_ENABLED && input.blocked_by?.length) {
    try {
      setTaskDeps(task.id, input.blocked_by);
      depNote = ` Blocked by ${input.blocked_by.length} task(s).`;
    } catch (e) {
      depNote = ` (Could not set dependencies: ${(e as Error).message}.)`;
    }
  }
  return {
    task,
    text: `Suggested task "${input.title}" added to the project tray (id: ${task.id}).${depNote}`,
  };
}

/**
 * Register a service the agent just started (the expose_service tool). Records
 * the port/url so it shows in the Services panel and returns the URL to hand the
 * user, plus the confirmation text. We don't own the process — this entry is
 * informational (see lib/services.ts exposeService).
 */
/**
 * Surface an ask_user question card and wait for the answer — the bridge-served
 * counterpart of the Claude driver's AskUserQuestion hook. Unlike suggest_task /
 * expose_service this is asynchronous by nature: we persist + publish the ask
 * card here (the same tool-row shape the runner writes, so the UI and the
 * /answer route treat it identically), then park a DETACHED waiter on
 * lib/asks.ts. The bridge polls takeAskOutcome() via the wait endpoint — no
 * long-held HTTP request, per the house rule. The waiter is tied to the live
 * turn's abort signal, so a Stop settles it as a dismissal.
 */
export function startAskUser(task: Task, questions: AskQuestion[]): { askId: string } {
  const askId = `ask-${nanoid()}`;
  const data: ToolData = { title: "Question for you", ask: { id: askId, questions } };
  const m = addMessage(task.id, task.generation, "tool", JSON.stringify(data));
  // The turn is live but parked on the user — same flag the runner sets for
  // Claude asks, driving the "Needs your input" badges. Cleared on answer below;
  // the runner's turn-end finally re-settles it either way.
  updateTask(task.id, { awaiting_input: 1 });
  publish(task.id, { type: "ask", id: askId, questions, msgId: m.id, generation: task.generation });

  void waitForAnswer(task.id, askId, questions, turnSignal(task.id))
    .then((answers) => {
      data.ask = { id: askId, questions, answers };
      updateMessage(m.id, JSON.stringify(data));
      updateTask(task.id, { awaiting_input: 0 });
      publish(task.id, { type: "ask_answered", id: askId, answers, msgId: m.id, generation: task.generation });
      settleAsk(task.id, askId, formatAnswers(questions, answers));
    })
    .catch(() => {
      // Turn torn down (Stop) before an answer arrived. The card stays in the
      // transcript unanswered — answering it later falls back to the /answer
      // route's resolved:false path (a normal reply into a fresh turn).
      settleAsk(task.id, askId, "The user dismissed the question without answering.");
    });

  return { askId };
}

export function registerExposedService(project: Project, name: string, port: number): { info: ServiceInfo; url: string; text: string } {
  const info = exposeService(project, name.trim() || "dev", port);
  const url = info.url ?? `http://localhost:${port}`;
  const text =
    `Registered "${info.name}" on port ${port}. It's reachable at ${url} — ` +
    `give the user this exact URL. It now shows in the project's Services panel` +
    (info.visibility === "private"
      ? ` (visibility: private — only the signed-in owner can open it; they can share it from the panel).`
      : ` (visibility: ${info.visibility}).`);
  return { info, url, text };
}
