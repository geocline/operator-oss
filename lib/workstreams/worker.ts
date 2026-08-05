import type { WorkstreamBridgeResult } from "./client";
import {
  postWorkstreamProposalDetailed,
  postWorkstreamUpdateDetailed,
  reconcileWorkstreamStorage,
  registerWorkstreamConversation,
  readRemoteWorkstreamState,
  type RemoteWorkstreamState,
  type RemoteWorkstreamStateResult,
  type WorkstreamBridgeFailureCategory,
  type WorkstreamBridgeRequestOptions,
  type WorkstreamStorageReconcileResult,
} from "./client";
import { getDb } from "../db";
import { workEnded, workStarted } from "../idle";
import { validateCardFacingPayload } from "./sanitize";
import {
  claimDueWorkstreamEvents,
  enqueueWorkstreamEvent,
  getWorkstreamByTask,
  listWorkstreamLinks,
  markWorkstreamDelivered,
  markWorkstreamFailed,
  releaseWorkstreamClaim,
  setWorkstreamState,
} from "./store";
import type {
  WorkstreamLink,
  WorkstreamOutboxEvent,
} from "./types";

export const MAX_WORKSTREAM_DELIVERY_ATTEMPTS = 5;
export const WORKSTREAM_RETRY_BASE_MS = 5_000;
export const WORKSTREAM_RETRY_MAX_MS = 5 * 60_000;
export const NEVER_RETRY_WORKSTREAM_AT = Number.MAX_SAFE_INTEGER;
const WORKSTREAM_WORKER_INTERVAL_MS = 15_000;
const WORKSTREAM_WORKER_BATCH_SIZE = 20;
export const WORKSTREAM_RECONCILE_WARNING_INTERVAL_MS = 5 * 60_000;

export const WORKSTREAM_LIFECYCLE_MESSAGES = {
  activation: "This work is connected for updates.",
  work_started: "Work has started.",
  input_needed: "Input is needed before work can continue.",
  paused: "Updates are paused.",
  resumed: "Updates have resumed.",
  manual_completion: "Work is complete.",
} as const;

export type WorkstreamLifecycleKind =
  keyof typeof WORKSTREAM_LIFECYCLE_MESSAGES;

interface RoutineUpdatePayload {
  body: string;
  attachments: Array<{
    filename: string;
    content_type: string;
    content_base64: string;
  }>;
}

interface ProposedChangePayload {
  kind: "card_update" | "complete_card" | "archive_card";
  payload: Record<string, unknown>;
}

interface ConversationRegistrationPayload {
  [key: string]: unknown;
  session_id: string;
  source: "claude" | "codex";
  title?: string;
  summary?: string;
  project_path?: string;
  session_modified?: string;
}

const PROVIDER_SESSION_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SYNTHETIC_SESSION_IDS = new Set([
  "missing",
  "none",
  "null",
  "pending",
  "synthetic",
  "unknown",
]);
const MAX_CONVERSATION_TITLE_LENGTH = 300;
const MAX_CONVERSATION_SUMMARY_LENGTH = 4_000;
const MAX_CONVERSATION_PROJECT_PATH_LENGTH = 2_048;

export interface WorkstreamDeliveryContext {
  link: WorkstreamLink;
  event: WorkstreamOutboxEvent;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type WorkstreamDeliver = (
  context: WorkstreamDeliveryContext,
) => Promise<WorkstreamBridgeResult>;

export interface WorkstreamWorkerOptions
  extends WorkstreamBridgeRequestOptions {
  now?: number;
  limit?: number;
  deliver?: WorkstreamDeliver;
  reconcile?: (
    link: WorkstreamLink,
  ) => Promise<RemoteWorkstreamStateResult>;
  reconcileStorage?: () => Promise<WorkstreamStorageReconcileResult>;
}

export interface WorkstreamWorkerSummary {
  claimed: number;
  delivered: number;
  retried: number;
  permanentlyFailed: number;
}

type WorkerRegistry = {
  started: boolean;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<WorkstreamWorkerSummary>;
  storageReconciliation?: Promise<void>;
  storageReconciliationStatus?: WorkstreamStorageReconciliationStatus;
  lastStorageReconciliationWarningAt?: number;
};

export interface WorkstreamStorageReconciliationStatus {
  state: "idle" | "running" | "ok" | "error";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  category?: WorkstreamBridgeFailureCategory;
}

declare global {
  // eslint-disable-next-line no-var
  var __workstreamWorker: WorkerRegistry | undefined;
}

function workerRegistry(): WorkerRegistry {
  const registry = (global.__workstreamWorker ??= { started: false });
  registry.storageReconciliationStatus ??= {
    state: "idle",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
  return registry;
}

export function getWorkstreamStorageReconciliationStatus():
  WorkstreamStorageReconciliationStatus {
  return { ...workerRegistry().storageReconciliationStatus! };
}

function workstreamById(id: string): WorkstreamLink | undefined {
  return getDb()
    .prepare("SELECT * FROM workstream_links WHERE id = ?")
    .get(id) as WorkstreamLink | undefined;
}

function permanentFailure(error: string): WorkstreamBridgeResult {
  return {
    ok: false,
    retryable: false,
    category: "policy",
    error,
  };
}

function routinePayload(
  payload: Record<string, unknown>,
): RoutineUpdatePayload | null {
  const body = payload.body;
  const rawAttachments = payload.attachments;
  if (
    typeof body !== "string" ||
    !body.trim() ||
    !Array.isArray(rawAttachments)
  ) {
    return null;
  }
  const attachments: RoutineUpdatePayload["attachments"] = [];
  for (const value of rawAttachments) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const attachment = value as Record<string, unknown>;
    if (
      typeof attachment.filename !== "string" ||
      typeof attachment.content_type !== "string" ||
      typeof attachment.content_base64 !== "string"
    ) {
      return null;
    }
    attachments.push({
      filename: attachment.filename,
      content_type: attachment.content_type,
      content_base64: attachment.content_base64,
    });
  }
  const validation = validateCardFacingPayload({
    text: body,
    filenames: attachments.map((attachment) => attachment.filename),
  });
  return validation.ok ? { body, attachments } : null;
}

function proposalPayload(
  payload: Record<string, unknown>,
): ProposedChangePayload | null {
  const kind = payload.kind;
  const value = payload.payload;
  if (
    kind !== "card_update" &&
    kind !== "complete_card" &&
    kind !== "archive_card"
  ) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    kind,
    payload: value as Record<string, unknown>,
  };
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value;
}

function conversationRegistrationPayload(
  payload: Record<string, unknown>,
): ConversationRegistrationPayload | null {
  const sessionId = payload.session_id;
  const source = payload.source;
  if (
    typeof sessionId !== "string" ||
    !PROVIDER_SESSION_ID_RE.test(sessionId) ||
    SYNTHETIC_SESSION_IDS.has(sessionId.toLowerCase()) ||
    (source !== "claude" && source !== "codex")
  ) {
    return null;
  }
  const title = optionalBoundedString(
    payload.title,
    MAX_CONVERSATION_TITLE_LENGTH,
  );
  const summary = optionalBoundedString(
    payload.summary,
    MAX_CONVERSATION_SUMMARY_LENGTH,
  );
  const projectPath = optionalBoundedString(
    payload.project_path,
    MAX_CONVERSATION_PROJECT_PATH_LENGTH,
  );
  const sessionModified = optionalBoundedString(
    payload.session_modified,
    64,
  );
  if (
    title === null ||
    summary === null ||
    projectPath === null ||
    sessionModified === null ||
    (sessionModified !== undefined &&
      Number.isNaN(Date.parse(sessionModified)))
  ) {
    return null;
  }
  return {
    session_id: sessionId,
    source,
    ...(title !== undefined ? { title } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(projectPath !== undefined ? { project_path: projectPath } : {}),
    ...(sessionModified !== undefined
      ? { session_modified: sessionModified }
      : {}),
  };
}

export async function deliverWorkstreamOutboxEvent(
  context: WorkstreamDeliveryContext,
): Promise<WorkstreamBridgeResult> {
  const options: WorkstreamBridgeRequestOptions = {
    timeoutMs: context.timeoutMs,
    fetchImpl: context.fetchImpl,
  };
  if (context.event.event_type === "routine_update") {
    const payload = routinePayload(context.event.payload);
    if (!payload) {
      return permanentFailure(
        "queued update failed the card-facing delivery policy",
      );
    }
    return postWorkstreamUpdateDetailed(
      {
        externalWorkstreamId: context.link.external_workstream_id,
        idempotencyKey: context.event.idempotency_key,
        body: payload.body,
        attachments: payload.attachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.content_type,
          contentBase64: attachment.content_base64,
        })),
      },
      options,
    );
  }
  if (context.event.event_type === "conversation_registration") {
    const payload = conversationRegistrationPayload(context.event.payload);
    if (!payload) {
      return permanentFailure(
        "queued conversation registration is invalid",
      );
    }
    return registerWorkstreamConversation(
      {
        externalWorkstreamId: context.link.external_workstream_id,
        sessionId: payload.session_id,
        source: payload.source,
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
        ...(payload.project_path !== undefined
          ? { projectPath: payload.project_path }
          : {}),
        ...(payload.session_modified !== undefined
          ? { sessionModified: payload.session_modified }
          : {}),
      },
      options,
    );
  }
  const payload = proposalPayload(context.event.payload);
  if (!payload) {
    return permanentFailure(
      "queued proposal failed the card-facing delivery policy",
    );
  }
  return postWorkstreamProposalDetailed(
    {
      externalWorkstreamId: context.link.external_workstream_id,
      idempotencyKey: context.event.idempotency_key,
      kind: payload.kind,
      payload: payload.payload,
    },
    options,
  );
}

function retryDelay(attempts: number): number {
  return Math.min(
    WORKSTREAM_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    WORKSTREAM_RETRY_MAX_MS,
  );
}

function storedFailure(result: Exclude<WorkstreamBridgeResult, { ok: true }>) {
  return result.status
    ? `${result.category} (${result.status})`
    : result.category;
}

function localStateForRemote(
  state: RemoteWorkstreamState,
): "active" | "paused" | "disconnected" {
  return state === "active"
    ? "active"
    : state === "disconnected"
      ? "disconnected"
      : "paused";
}

async function eligibleLinksAfterReconciliation(
  options: WorkstreamWorkerOptions,
): Promise<string[] | undefined> {
  if (options.deliver && !options.reconcile) return undefined;
  const eligible: string[] = [];
  const reconcile =
    options.reconcile ??
    ((link: WorkstreamLink) =>
      readRemoteWorkstreamState(link.external_workstream_id, {
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      }));
  for (const link of listWorkstreamLinks()) {
    if (link.state === "disconnected") continue;
    let remote: RemoteWorkstreamStateResult;
    try {
      remote = await reconcile(link);
    } catch {
      continue;
    }
    if (!remote.ok) continue;
    const localState = localStateForRemote(remote.state);
    if (localState !== link.state) {
      setWorkstreamState(link.id, localState);
    }
    if (remote.state === "active") eligible.push(link.id);
  }
  return eligible;
}

export async function runWorkstreamWorkerOnce(
  options: WorkstreamWorkerOptions = {},
): Promise<WorkstreamWorkerSummary> {
  const now = options.now ?? Date.now();
  const eligibleLinkIds =
    options.deliver && !options.reconcile
      ? undefined
      : await eligibleLinksAfterReconciliation(options);
  const claimed = claimDueWorkstreamEvents(
    now,
    options.limit ?? WORKSTREAM_WORKER_BATCH_SIZE,
    eligibleLinkIds,
  );
  const summary: WorkstreamWorkerSummary = {
    claimed: claimed.length,
    delivered: 0,
    retried: 0,
    permanentlyFailed: 0,
  };
  if (claimed.length === 0) return summary;

  workStarted();
  try {
    for (const event of claimed) {
      const link = workstreamById(event.link_id);
      if (!link) continue;
      if (link.state !== "active") {
        releaseWorkstreamClaim(event.id, event.claim_token, now);
        continue;
      }
      let result: WorkstreamBridgeResult;
      try {
        result = await (options.deliver ?? deliverWorkstreamOutboxEvent)({
          link,
          event,
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        });
      } catch {
        result = {
          ok: false,
          retryable: true,
          category: "network",
          error: "workstream delivery failed unexpectedly",
        };
      }

      if (result.ok) {
        markWorkstreamDelivered(event.id, event.claim_token);
        summary.delivered++;
        continue;
      }
      if (result.category === "state") {
        let remoteState = result.remoteState;
        if (!remoteState && !options.deliver) {
          const reconciled = await readRemoteWorkstreamState(
            link.external_workstream_id,
            {
              timeoutMs: options.timeoutMs,
              fetchImpl: options.fetchImpl,
            },
          );
          if (reconciled.ok) remoteState = reconciled.state;
        }
        if (
          remoteState === "paused" ||
          remoteState === "activating" ||
          remoteState === "disconnected"
        ) {
          setWorkstreamState(link.id, localStateForRemote(remoteState));
          releaseWorkstreamClaim(event.id, event.claim_token, now);
          continue;
        }
      }
      const permanentlyFailed =
        !result.retryable ||
        event.attempts >= MAX_WORKSTREAM_DELIVERY_ATTEMPTS;
      markWorkstreamFailed(
        event.id,
        event.claim_token,
        storedFailure(result),
        permanentlyFailed
          ? NEVER_RETRY_WORKSTREAM_AT
          : now + retryDelay(event.attempts),
      );
      if (permanentlyFailed) summary.permanentlyFailed++;
      else summary.retried++;
    }
    return summary;
  } finally {
    workEnded();
  }
}

export function queueWorkstreamLifecycle(
  taskId: string,
  kind: WorkstreamLifecycleKind,
  occurrenceKey: string,
): WorkstreamOutboxEvent | undefined {
  const link = getWorkstreamByTask(taskId);
  if (!link || link.state === "disconnected") return undefined;
  const occurrence = occurrenceKey.trim();
  if (!occurrence) return undefined;
  try {
    return enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: `lifecycle:${link.id}:${kind}:${occurrence}`,
      eventType: "routine_update",
      payload: {
        body: WORKSTREAM_LIFECYCLE_MESSAGES[kind],
        attachments: [],
      },
    });
  } catch {
    return undefined;
  }
}

export function queueWorkstreamConversationRegistration(input: {
  taskId: string;
  sessionId: string;
  source: string;
  title?: string;
  projectPath?: string;
}): WorkstreamOutboxEvent | undefined {
  try {
    const link = getWorkstreamByTask(input.taskId);
    if (!link || link.state === "disconnected") return undefined;
    const payload = conversationRegistrationPayload({
      session_id: input.sessionId,
      source: input.source,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.projectPath !== undefined
        ? { project_path: input.projectPath }
        : {}),
    });
    if (!payload) return undefined;
    return enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey:
        `conversation:${link.id}:${payload.session_id}`,
      eventType: "conversation_registration",
      payload,
    });
  } catch {
    return undefined;
  }
}

export function queueManualWorkstreamCompletion(
  taskId: string,
  occurrenceKey: string,
): {
  comment?: WorkstreamOutboxEvent;
  proposal?: WorkstreamOutboxEvent;
} {
  const link = getWorkstreamByTask(taskId);
  if (!link || link.state === "disconnected") return {};
  const occurrence = occurrenceKey.trim();
  if (!occurrence) return {};
  const comment = queueWorkstreamLifecycle(
    taskId,
    "manual_completion",
    occurrence,
  );
  let proposal: WorkstreamOutboxEvent | undefined;
  try {
    proposal = enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: `lifecycle:${link.id}:complete_card:${occurrence}`,
      eventType: "proposed_change",
      payload: {
        kind: "complete_card",
        payload: {},
      },
    });
  } catch {
    proposal = undefined;
  }
  return { comment, proposal };
}

function warnForStorageReconciliationFailure(now: number): void {
  const registry = workerRegistry();
  const previous = registry.lastStorageReconciliationWarningAt;
  if (
    previous !== undefined &&
    now - previous < WORKSTREAM_RECONCILE_WARNING_INTERVAL_MS
  ) {
    return;
  }
  registry.lastStorageReconciliationWarningAt = now;
  console.warn("[workstreams] tracker storage reconciliation failed");
}

function triggerStorageReconciliation(
  options: WorkstreamWorkerOptions,
): Promise<void> {
  const registry = workerRegistry();
  if (registry.storageReconciliation) {
    return registry.storageReconciliation;
  }
  const attemptedAt = Date.now();
  const previous = registry.storageReconciliationStatus!;
  registry.storageReconciliationStatus = {
    state: "running",
    lastAttemptAt: attemptedAt,
    lastSuccessAt: previous.lastSuccessAt,
    lastFailureAt: previous.lastFailureAt,
  };
  workStarted();
  const running = Promise.resolve()
    .then(() =>
      options.reconcileStorage
        ? options.reconcileStorage()
        : reconcileWorkstreamStorage({
            timeoutMs: options.timeoutMs,
            fetchImpl: options.fetchImpl,
          }),
    )
    .then((result) => {
      const completedAt = Date.now();
      const status = registry.storageReconciliationStatus!;
      if (result.ok) {
        registry.storageReconciliationStatus = {
          state: "ok",
          lastAttemptAt: status.lastAttemptAt,
          lastSuccessAt: completedAt,
          lastFailureAt: status.lastFailureAt,
        };
        return;
      }
      registry.storageReconciliationStatus = {
        state: "error",
        lastAttemptAt: status.lastAttemptAt,
        lastSuccessAt: status.lastSuccessAt,
        lastFailureAt: completedAt,
        category: result.category,
      };
      warnForStorageReconciliationFailure(completedAt);
    })
    .catch(() => {
      const completedAt = Date.now();
      const status = registry.storageReconciliationStatus!;
      registry.storageReconciliationStatus = {
        state: "error",
        lastAttemptAt: status.lastAttemptAt,
        lastSuccessAt: status.lastSuccessAt,
        lastFailureAt: completedAt,
        category: "network",
      };
      warnForStorageReconciliationFailure(completedAt);
    })
    .finally(() => {
      workEnded();
      if (registry.storageReconciliation === running) {
        registry.storageReconciliation = undefined;
      }
    });
  registry.storageReconciliation = running;
  return running;
}

function scheduleNextWorkerTick(options: WorkstreamWorkerOptions) {
  const registry = workerRegistry();
  if (!registry.started || registry.timer) return;
  registry.timer = setTimeout(() => {
    registry.timer = undefined;
    void startWorkstreamWorker(options);
  }, WORKSTREAM_WORKER_INTERVAL_MS);
  registry.timer.unref?.();
}

async function runWorkstreamWorkerSafely(
  options: WorkstreamWorkerOptions,
) {
  void triggerStorageReconciliation(options);
  try {
    return await runWorkstreamWorkerOnce(options);
  } catch {
    console.warn("[workstreams] worker pass failed");
    return {
      claimed: 0,
      delivered: 0,
      retried: 0,
      permanentlyFailed: 0,
    };
  }
}

export function startWorkstreamWorker(
  options: WorkstreamWorkerOptions = {},
): Promise<WorkstreamWorkerSummary> {
  const registry = workerRegistry();
  if (registry.running) return registry.running;
  registry.started = true;
  const running = runWorkstreamWorkerSafely(options);
  registry.running = running;
  void running.then(() => {
    if (registry.running !== running) return;
    registry.running = undefined;
    scheduleNextWorkerTick(options);
  });
  return running;
}

export function stopWorkstreamWorkerForTests(): void {
  const registry = workerRegistry();
  registry.started = false;
  if (registry.timer) clearTimeout(registry.timer);
  registry.timer = undefined;
  registry.running = undefined;
  registry.storageReconciliation = undefined;
  registry.storageReconciliationStatus = {
    state: "idle",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
  registry.lastStorageReconciliationWarningAt = undefined;
}
