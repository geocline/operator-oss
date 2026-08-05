import { nanoid } from "nanoid";
import { getDb } from "../db";
import type {
  ActivateWorkstreamInput,
  EnqueueWorkstreamEventInput,
  WorkstreamEventPayload,
  WorkstreamLink,
  WorkstreamOutboxEvent,
  WorkstreamState,
} from "./types";

type StoredOutboxEvent = Omit<WorkstreamOutboxEvent, "payload"> & {
  payload: string;
};

export const WORKSTREAM_CLAIM_LEASE_MS = 60_000;

function requireValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function decodeEvent(row: StoredOutboxEvent | undefined): WorkstreamOutboxEvent | undefined {
  if (!row) return undefined;
  return {
    ...row,
    payload: JSON.parse(row.payload) as WorkstreamEventPayload,
  };
}

function getOutboxEvent(id: string): WorkstreamOutboxEvent | undefined {
  const row = getDb()
    .prepare("SELECT * FROM workstream_outbox WHERE id = ?")
    .get(id) as StoredOutboxEvent | undefined;
  return decodeEvent(row);
}

export function getWorkstreamOutboxEvent(
  id: string,
): WorkstreamOutboxEvent | undefined {
  return getOutboxEvent(id);
}

export function activateWorkstream(input: ActivateWorkstreamInput): WorkstreamLink {
  const taskId = requireValue(input.taskId, "taskId");
  const provider = requireValue(input.provider, "provider");
  const externalCardId = requireValue(input.externalCardId, "externalCardId");
  const externalWorkstreamId = requireValue(
    input.externalWorkstreamId,
    "externalWorkstreamId",
  );
  const initialState = input.initialState ?? "active";
  const db = getDb();

  return db.transaction(() => {
    const existing = getWorkstreamByExternalCard(provider, externalCardId);
    const now = Date.now();
    if (existing) {
      db.prepare(
        `UPDATE workstream_links
         SET external_workstream_id = ?, state = ?, updated_at = ?
         WHERE id = ?`,
      ).run(externalWorkstreamId, initialState, now, existing.id);
      return getWorkstreamByExternalCard(provider, externalCardId)!;
    }

    const id = nanoid();
    db.prepare(
      `INSERT INTO workstream_links
         (id, task_id, provider, external_card_id, external_workstream_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      taskId,
      provider,
      externalCardId,
      externalWorkstreamId,
      initialState,
      now,
      now,
    );
    return getWorkstreamByExternalCard(provider, externalCardId)!;
  })();
}

export function getWorkstreamByTask(taskId: string): WorkstreamLink | undefined {
  return getDb()
    .prepare("SELECT * FROM workstream_links WHERE task_id = ?")
    .get(taskId) as WorkstreamLink | undefined;
}

export function getWorkstreamByExternalCard(
  provider: string,
  externalCardId: string,
): WorkstreamLink | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM workstream_links WHERE provider = ? AND external_card_id = ?",
    )
    .get(provider, externalCardId) as WorkstreamLink | undefined;
}

export function setWorkstreamState(
  linkId: string,
  state: WorkstreamState,
): WorkstreamLink {
  const current = getDb()
    .prepare("SELECT * FROM workstream_links WHERE id = ?")
    .get(linkId) as WorkstreamLink | undefined;
  if (!current) throw new Error("Workstream link not found");
  if (current.state === "disconnected" && state !== "disconnected") {
    throw new Error(
      "Disconnected workstreams require a new activation token",
    );
  }
  const result = getDb()
    .prepare(
      "UPDATE workstream_links SET state = ?, updated_at = ? WHERE id = ?",
    )
    .run(state, Date.now(), linkId);
  if (result.changes !== 1) throw new Error("Workstream link not found");
  return getDb()
    .prepare("SELECT * FROM workstream_links WHERE id = ?")
    .get(linkId) as WorkstreamLink;
}

export function listWorkstreamLinks(): WorkstreamLink[] {
  return getDb()
    .prepare(
      "SELECT * FROM workstream_links ORDER BY created_at ASC, id ASC",
    )
    .all() as WorkstreamLink[];
}

export function enqueueWorkstreamEvent(
  input: EnqueueWorkstreamEventInput,
): WorkstreamOutboxEvent {
  const linkId = requireValue(input.linkId, "linkId");
  const idempotencyKey = requireValue(input.idempotencyKey, "idempotencyKey");
  const db = getDb();

  return db.transaction(() => {
    const duplicate = db
      .prepare("SELECT * FROM workstream_outbox WHERE idempotency_key = ?")
      .get(idempotencyKey) as StoredOutboxEvent | undefined;
    if (duplicate) {
      if (duplicate.link_id !== linkId) {
        throw new Error("Idempotency key belongs to another workstream");
      }
      return decodeEvent(duplicate)!;
    }

    const link = db
      .prepare("SELECT * FROM workstream_links WHERE id = ?")
      .get(linkId) as WorkstreamLink | undefined;
    if (!link) throw new Error("Workstream link not found");
    if (link.state === "disconnected") {
      throw new Error("Cannot enqueue an event for a disconnected workstream");
    }

    const serializedPayload = JSON.stringify(input.payload);
    if (serializedPayload === undefined) {
      throw new Error("Workstream event payload must be JSON serializable");
    }
    const now = Date.now();
    const id = nanoid();
    db.prepare(
      `INSERT INTO workstream_outbox
         (id, link_id, idempotency_key, event_type, payload, state,
          attempts, next_attempt_at, claim_expires_at, last_error,
          delivered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 0, '', 0, ?, ?)`,
    ).run(
      id,
      linkId,
      idempotencyKey,
      input.eventType,
      serializedPayload,
      input.nextAttemptAt ?? now,
      now,
      now,
    );
    return getOutboxEvent(id)!;
  })();
}

export function claimDueWorkstreamEvents(
  now: number,
  limit: number,
  eligibleLinkIds?: readonly string[],
): WorkstreamOutboxEvent[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  if (eligibleLinkIds && eligibleLinkIds.length === 0) return [];
  const db = getDb();

  return db.transaction(() => {
    const eligibleSql = eligibleLinkIds
      ? ` AND o.link_id IN (${eligibleLinkIds.map(() => "?").join(",")})`
      : "";
    const due = db
      .prepare(
        `SELECT o.id
         FROM workstream_outbox o
         JOIN workstream_links l ON l.id = o.link_id
         WHERE l.state = 'active'
           ${eligibleSql}
           AND (
             (o.state IN ('pending', 'failed') AND o.next_attempt_at <= ?)
             OR (o.state = 'delivering' AND o.claim_expires_at <= ?)
           )
         ORDER BY o.next_attempt_at ASC, o.created_at ASC, o.id ASC
         LIMIT ?`,
      )
      .all(
        ...(eligibleLinkIds ?? []),
        now,
        now,
        safeLimit,
      ) as { id: string }[];
    const claim = db.prepare(
      `UPDATE workstream_outbox
       SET state = 'delivering', attempts = attempts + 1,
           claim_expires_at = ?, claim_token = ?, updated_at = ?
       WHERE id = ?
         AND (
           (state IN ('pending', 'failed') AND next_attempt_at <= ?)
           OR (state = 'delivering' AND claim_expires_at <= ?)
         )`,
    );
    for (const event of due) {
      claim.run(
        now + WORKSTREAM_CLAIM_LEASE_MS,
        nanoid(),
        now,
        event.id,
        now,
        now,
      );
    }
    return due
      .map((event) => getOutboxEvent(event.id))
      .filter((event): event is WorkstreamOutboxEvent => event !== undefined);
  })();
}

export function releaseWorkstreamClaim(
  id: string,
  claimToken: string,
  nextAttemptAt = Date.now(),
): WorkstreamOutboxEvent {
  const token = requireValue(claimToken, "claimToken");
  const now = Date.now();
  const result = getDb()
    .prepare(
      `UPDATE workstream_outbox
       SET state = 'pending', attempts = MAX(0, attempts - 1),
           next_attempt_at = ?, claim_expires_at = 0, claim_token = '',
           last_error = '', updated_at = ?
       WHERE id = ? AND state = 'delivering' AND claim_token = ?`,
    )
    .run(nextAttemptAt, now, id, token);
  if (result.changes !== 1) {
    const event = getOutboxEvent(id);
    if (event?.state === "delivering") {
      throw new Error(
        "Claim token does not own this workstream outbox event",
      );
    }
    if (event) {
      throw new Error("Workstream outbox event must be delivering");
    }
    throw new Error("Workstream outbox event not found");
  }
  return getOutboxEvent(id)!;
}

export function claimWorkstreamEvent(
  id: string,
  now = Date.now(),
): WorkstreamOutboxEvent | undefined {
  const claimToken = nanoid();
  const result = getDb()
    .prepare(
      `UPDATE workstream_outbox
       SET state = 'delivering', attempts = attempts + 1,
           claim_expires_at = ?, claim_token = ?, updated_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM workstream_links l
           WHERE l.id = workstream_outbox.link_id AND l.state = 'active'
         )
         AND (
           (state IN ('pending', 'failed') AND next_attempt_at <= ?)
           OR (state = 'delivering' AND claim_expires_at <= ?)
         )`,
    )
    .run(
      now + WORKSTREAM_CLAIM_LEASE_MS,
      claimToken,
      now,
      id,
      now,
      now,
    );
  return result.changes === 1 ? getOutboxEvent(id) : undefined;
}

export function markWorkstreamDelivered(
  id: string,
  claimToken: string,
): WorkstreamOutboxEvent {
  const token = requireValue(claimToken, "claimToken");
  const now = Date.now();
  const result = getDb()
    .prepare(
      `UPDATE workstream_outbox
       SET state = 'delivered', delivered_at = ?, claim_expires_at = 0,
           claim_token = '', last_error = '', updated_at = ?
       WHERE id = ? AND state = 'delivering' AND claim_token = ?`,
    )
    .run(now, now, id, token);
  if (result.changes !== 1) {
    const event = getOutboxEvent(id);
    if (event?.state === "delivering") {
      throw new Error("Claim token does not own this workstream outbox event");
    }
    if (event) {
      throw new Error("Workstream outbox event must be delivering");
    }
    throw new Error("Workstream outbox event not found");
  }
  return getOutboxEvent(id)!;
}

export function markWorkstreamFailed(
  id: string,
  claimToken: string,
  error: string,
  nextAttemptAt: number,
): WorkstreamOutboxEvent {
  const token = requireValue(claimToken, "claimToken");
  const result = getDb()
    .prepare(
      `UPDATE workstream_outbox
       SET state = 'failed', last_error = ?, next_attempt_at = ?,
           claim_expires_at = 0, claim_token = '', updated_at = ?
       WHERE id = ? AND state = 'delivering' AND claim_token = ?`,
    )
    .run(error, nextAttemptAt, Date.now(), id, token);
  if (result.changes !== 1) {
    const event = getOutboxEvent(id);
    if (event?.state === "delivering") {
      throw new Error("Claim token does not own this workstream outbox event");
    }
    if (event) {
      throw new Error("Workstream outbox event must be delivering");
    }
    throw new Error("Workstream outbox event not found");
  }
  return getOutboxEvent(id)!;
}
