export interface ExchangedWorkstream {
  workstream_id: string;
  card_id: string;
  title: string;
  deal_tag: string | null;
  project_path: string;
  status: "activating";
  activation_ack_token: string;
}

export type RemoteWorkstreamState =
  | "activating"
  | "active"
  | "paused"
  | "disconnected";

export type RemoteWorkstreamStateResult =
  | { ok: true; state: RemoteWorkstreamState }
  | Extract<WorkstreamBridgeResult, { ok: false }>;

export type WorkstreamBridgeFailureCategory =
  | "configuration"
  | "timeout"
  | "network"
  | "server"
  | "rate_limit"
  | "policy"
  | "auth"
  | "not_found"
  | "state"
  | "invalid_response";

export type WorkstreamBridgeResult =
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      retryable: boolean;
      category: WorkstreamBridgeFailureCategory;
      error: string;
      status?: number;
      remoteState?: RemoteWorkstreamState;
    };

export interface WorkstreamBridgeRequestOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WorkstreamStorageReconcileSummary {
  claimed: number;
  kept: number;
  deleted: number;
  retried: number;
  failed: number;
}

export type WorkstreamStorageReconcileResult =
  | { ok: true; summary: WorkstreamStorageReconcileSummary }
  | Extract<WorkstreamBridgeResult, { ok: false }>;

export interface RegisterWorkstreamConversationInput {
  externalWorkstreamId: string;
  sessionId: string;
  source: "claude" | "codex";
  title?: string;
  summary?: string;
  projectPath?: string;
  sessionModified?: string;
}

const DEFAULT_WORKSTREAM_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_WORKSTREAM_BRIDGE_RESPONSE_BYTES = 64 * 1024;

function trackerConfig(): { baseUrl: string; token: string } | null {
  const rawBaseUrl = process.env.ARDENT_TRACKER_BASE_URL?.trim();
  const token = process.env.ARDENT_WORKSTREAM_BRIDGE_TOKEN?.trim();
  if (!rawBaseUrl || !token) return null;
  try {
    const url = new URL(rawBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { baseUrl: url.toString().replace(/\/$/, ""), token };
  } catch {
    return null;
  }
}

async function boundedJsonObject(
  response: Response,
): Promise<Record<string, unknown> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_WORKSTREAM_BRIDGE_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    ) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function failureForStatus(
  status: number,
  explicitlyRetryable: boolean,
  safeBody: Record<string, unknown> | null,
): Exclude<WorkstreamBridgeResult, { ok: true }> {
  const remoteState = remoteStateFrom(safeBody);
  const retryable =
    explicitlyRetryable ||
    status === 429 ||
    status === 423 ||
    status >= 500 ||
    remoteState === "paused" ||
    remoteState === "activating";
  const category: WorkstreamBridgeFailureCategory =
    status === 429
      ? "rate_limit"
      : status >= 500
        ? "server"
        : status === 401 || status === 403
          ? "auth"
          : status === 404
            ? "not_found"
            : status === 409 || status === 423
              ? "state"
              : "policy";
  return {
    ok: false,
    retryable,
    category,
    status,
    ...(remoteState ? { remoteState } : {}),
    error: retryable
      ? "tracker delivery is temporarily unavailable"
      : `tracker rejected the card-facing request${rejectionDetail(safeBody)}`,
  };
}

// Compact summary of WHY the tracker rejected a request, so the agent can fix
// the content instead of guessing. The tracker's free-text `error` may embed
// rejected content, so it is never retained — only structured violation
// codes/fields (enum-like identifiers such as "internal_identity in
// attachments[0].content"), each vetted against a strict charset.
const SAFE_VIOLATION_TOKEN = /^[A-Za-z0-9_.\[\]-]{1,64}$/;
function rejectionDetail(safeBody: Record<string, unknown> | null): string {
  if (!safeBody || !Array.isArray(safeBody.violations)) return "";
  const violations = safeBody.violations
    .filter(
      (v): v is { code: string; field: string } =>
        !!v &&
        typeof v === "object" &&
        typeof (v as { code?: unknown }).code === "string" &&
        typeof (v as { field?: unknown }).field === "string" &&
        SAFE_VIOLATION_TOKEN.test((v as { code: string }).code) &&
        SAFE_VIOLATION_TOKEN.test((v as { field: string }).field),
    )
    .slice(0, 5)
    .map((v) => `${v.code} in ${v.field}`);
  return violations.length ? ` (${violations.join("; ")})` : "";
}

function remoteStateFrom(value: unknown): RemoteWorkstreamState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nested =
    record.workstream &&
    typeof record.workstream === "object" &&
    !Array.isArray(record.workstream)
      ? (record.workstream as Record<string, unknown>).status
      : undefined;
  const state = nested ?? record.status;
  return state === "activating" ||
    state === "active" ||
    state === "paused" ||
    state === "disconnected"
    ? state
    : null;
}

function storageReconcileSummary(
  value: unknown,
): WorkstreamStorageReconcileSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = (value as Record<string, unknown>).summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return null;
  }
  const record = summary as Record<string, unknown>;
  const fields = [
    "claimed",
    "kept",
    "deleted",
    "retried",
    "failed",
  ] as const;
  if (
    fields.some(
      (field) =>
        typeof record[field] !== "number" ||
        !Number.isSafeInteger(record[field]) ||
        (record[field] as number) < 0,
    )
  ) {
    return null;
  }
  return {
    claimed: record.claimed as number,
    kept: record.kept as number,
    deleted: record.deleted as number,
    retried: record.retried as number,
    failed: record.failed as number,
  };
}

async function bridgeDeliveryRequest(
  route: string,
  body: Record<string, unknown>,
  options: WorkstreamBridgeRequestOptions = {},
): Promise<WorkstreamBridgeResult> {
  const config = trackerConfig();
  if (!config) {
    return {
      ok: false,
      retryable: true,
      category: "configuration",
      error: "tracker delivery is not configured",
    };
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(
    1,
    Math.min(
      options.timeoutMs ?? DEFAULT_WORKSTREAM_DELIVERY_TIMEOUT_MS,
      60_000,
    ),
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${config.baseUrl}${route}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const safeBody = await boundedJsonObject(response);
      return failureForStatus(
        response.status,
        safeBody?.retryable === true,
        safeBody,
      );
    }
    const value = await boundedJsonObject(response);
    if (!value) {
      return {
        ok: false,
        retryable: true,
        category: "invalid_response",
        error: "tracker returned an invalid delivery response",
        status: response.status,
      };
    }
    return { ok: true, value };
  } catch (cause) {
    if (
      controller.signal.aborted ||
      (cause instanceof Error && cause.name === "AbortError")
    ) {
      return {
        ok: false,
        retryable: true,
        category: "timeout",
        error: "tracker delivery timed out",
      };
    }
    return {
      ok: false,
      retryable: true,
      category: "network",
      error: "tracker delivery network failure",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function bridgeRequest(
  route: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const config = trackerConfig();
  if (!config) return null;
  try {
    const response = await fetch(`${config.baseUrl}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const value = (await response.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function exchangedWorkstream(value: unknown): ExchangedWorkstream | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const field of [
    "workstream_id",
    "card_id",
    "title",
    "project_path",
    "activation_ack_token",
  ] as const) {
    if (typeof row[field] !== "string" || !row[field].trim()) return null;
  }
  const status = row.status;
  if (status !== "activating") return null;
  const dealTag = row.deal_tag;
  if (
    dealTag !== null &&
    dealTag !== undefined &&
    typeof dealTag !== "string"
  ) {
    return null;
  }
  return {
    workstream_id: (row.workstream_id as string).trim(),
    card_id: (row.card_id as string).trim(),
    title: (row.title as string).trim(),
    deal_tag:
      typeof dealTag === "string" && dealTag.trim()
        ? dealTag.trim()
        : null,
    project_path: (row.project_path as string).trim(),
    status,
    activation_ack_token: (row.activation_ack_token as string).trim(),
  };
}

export async function exchangeWorkstreamToken(
  activationToken: string,
): Promise<ExchangedWorkstream | null> {
  const config = trackerConfig();
  const token = activationToken.trim();
  if (!config || !token) return null;
  return exchangedWorkstream(
    await bridgeRequest("/api/workstream-bridge/exchange", {
      activation_token: token,
    }),
  );
}

export async function acknowledgeWorkstreamActivation(input: {
  externalWorkstreamId: string;
  activationAckToken: string;
}): Promise<boolean> {
  const value = await bridgeRequest(
    "/api/workstream-bridge/activation/ack",
    {
      workstream_id: input.externalWorkstreamId,
      activation_ack_token: input.activationAckToken,
    },
  );
  return remoteStateFrom(value) === "active";
}

export async function readRemoteWorkstreamState(
  externalWorkstreamId: string,
  options: WorkstreamBridgeRequestOptions = {},
): Promise<RemoteWorkstreamStateResult> {
  const result = await bridgeDeliveryRequest(
    "/api/workstream-bridge/state",
    { workstream_id: externalWorkstreamId },
    options,
  );
  if (!result.ok) return result;
  const state = remoteStateFrom(result.value);
  if (state) return { ok: true, state };
  return {
    ok: false,
    retryable: true,
    category: "invalid_response",
    error: "tracker returned an invalid workstream state",
  };
}

export async function reconcileWorkstreamStorage(
  options: WorkstreamBridgeRequestOptions = {},
): Promise<WorkstreamStorageReconcileResult> {
  const result = await bridgeDeliveryRequest(
    "/api/workstream-bridge/reconcile",
    { limit: 20 },
    options,
  );
  if (!result.ok) return result;
  const summary = storageReconcileSummary(result.value);
  if (summary) return { ok: true, summary };
  return {
    ok: false,
    retryable: true,
    category: "invalid_response",
    error: "tracker returned an invalid reconciliation response",
  };
}

export async function registerWorkstreamConversation(
  input: RegisterWorkstreamConversationInput,
  options: WorkstreamBridgeRequestOptions = {},
): Promise<WorkstreamBridgeResult> {
  return bridgeDeliveryRequest(
    "/api/workstream-bridge/conversation",
    {
      workstream_id: input.externalWorkstreamId,
      session_id: input.sessionId,
      source: input.source,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.projectPath !== undefined
        ? { project_path: input.projectPath }
        : {}),
      ...(input.sessionModified !== undefined
        ? { session_modified: input.sessionModified }
        : {}),
    },
    options,
  );
}

export type WorkstreamCommand =
  | "pause"
  | "resume"
  | "disconnect"
  | "post-now";

export async function sendWorkstreamCommand(
  externalWorkstreamId: string,
  command: WorkstreamCommand,
): Promise<Record<string, unknown> | null> {
  return bridgeRequest("/api/workstream-bridge/control", {
    workstream_id: externalWorkstreamId,
    command,
  });
}

export async function postWorkstreamUpdate(
  input: {
    externalWorkstreamId: string;
    idempotencyKey: string;
    body: string;
    oneShotToken?: string;
    attachments?: Array<{
      filename: string;
      contentType: string;
      contentBase64: string;
    }>;
  },
): Promise<Record<string, unknown> | null> {
  const result = await postWorkstreamUpdateDetailed(input);
  return result.ok ? result.value : null;
}

export async function postWorkstreamUpdateDetailed(
  input: {
    externalWorkstreamId: string;
    idempotencyKey: string;
    body: string;
    oneShotToken?: string;
    attachments?: Array<{
      filename: string;
      contentType: string;
      contentBase64: string;
    }>;
  },
  options: WorkstreamBridgeRequestOptions = {},
): Promise<WorkstreamBridgeResult> {
  return bridgeDeliveryRequest("/api/workstream-bridge/update", {
    workstream_id: input.externalWorkstreamId,
    idempotency_key: input.idempotencyKey,
    body: input.body,
    attachments: (input.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      content_base64: attachment.contentBase64,
    })),
    ...(input.oneShotToken
      ? { one_shot_token: input.oneShotToken }
      : {}),
  }, options);
}

export async function postWorkstreamProposal(input: {
  externalWorkstreamId: string;
  idempotencyKey: string;
  kind: "card_update" | "complete_card" | "archive_card";
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const result = await postWorkstreamProposalDetailed(input);
  return result.ok ? result.value : null;
}

export async function postWorkstreamProposalDetailed(
  input: {
    externalWorkstreamId: string;
    idempotencyKey: string;
    kind: "card_update" | "complete_card" | "archive_card";
    payload: Record<string, unknown>;
  },
  options: WorkstreamBridgeRequestOptions = {},
): Promise<WorkstreamBridgeResult> {
  return bridgeDeliveryRequest("/api/workstream-bridge/proposals", {
    workstream_id: input.externalWorkstreamId,
    idempotency_key: input.idempotencyKey,
    kind: input.kind,
    payload: input.payload,
  }, options);
}
