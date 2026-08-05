import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { init } from "../lib/db";
import { createProject, createTask } from "../lib/store";
import {
  WORKSTREAM_CLAIM_LEASE_MS,
  activateWorkstream,
  claimDueWorkstreamEvents,
  enqueueWorkstreamEvent,
  getWorkstreamByExternalCard,
  getWorkstreamByTask,
  markWorkstreamDelivered,
  markWorkstreamFailed,
  setWorkstreamState,
} from "../lib/workstreams/store";

function taskPair() {
  const project = createProject({ name: `Workstream ${Date.now()} ${Math.random()}` });
  return {
    first: createTask({ project_id: project.id, title: "First linked task" }),
    second: createTask({ project_id: project.id, title: "Second linked task" }),
  };
}

describe("workstream links", () => {
  it("keeps one stable task link for an external card across reactivation", () => {
    const { first, second } = taskPair();
    const original = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-stable",
      externalWorkstreamId: "remote-v1",
    });

    setWorkstreamState(original.id, "disconnected");
    const reactivated = activateWorkstream({
      taskId: second.id,
      provider: "ardent",
      externalCardId: "card-stable",
      externalWorkstreamId: "remote-v2",
    });

    expect(reactivated.id).toBe(original.id);
    expect(reactivated.task_id).toBe(first.id);
    expect(reactivated.external_workstream_id).toBe("remote-v2");
    expect(reactivated.state).toBe("active");
    expect(getWorkstreamByTask(first.id)?.id).toBe(original.id);
    expect(getWorkstreamByTask(second.id)).toBeUndefined();
    expect(getWorkstreamByExternalCard("ardent", "card-stable")?.id).toBe(original.id);
  });

  it("requires a fresh activation operation to leave disconnected", () => {
    const { first } = taskPair();
    const link = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-terminal",
      externalWorkstreamId: "remote-terminal",
    });
    setWorkstreamState(link.id, "disconnected");

    expect(() => setWorkstreamState(link.id, "active")).toThrow(
      /activation token/i,
    );
    expect(getWorkstreamByTask(first.id)?.state).toBe("disconnected");

    const reactivated = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-terminal",
      externalWorkstreamId: "remote-terminal-next",
      initialState: "paused",
    });
    expect(reactivated.state).toBe("paused");
  });
});

describe("workstream outbox", () => {
  it("keeps paused events queued and claims them after resume", () => {
    const { first } = taskPair();
    const link = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-paused",
      externalWorkstreamId: "remote-paused",
    });
    setWorkstreamState(link.id, "paused");

    const queued = enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: "paused-event",
      eventType: "routine_update",
      payload: { body: "Review is in progress." },
    });

    expect(queued.state).toBe("pending");
    expect(claimDueWorkstreamEvents(Date.now() + 1_000, 10)).toEqual([]);

    setWorkstreamState(link.id, "active");
    const claimed = claimDueWorkstreamEvents(Date.now() + 1_000, 10);
    expect(claimed.map((event) => event.id)).toContain(queued.id);
    expect(claimed.find((event) => event.id === queued.id)?.state).toBe("delivering");
  });

  it("blocks new events after disconnect", () => {
    const { first } = taskPair();
    const link = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-disconnected",
      externalWorkstreamId: "remote-disconnected",
    });
    setWorkstreamState(link.id, "disconnected");

    expect(() =>
      enqueueWorkstreamEvent({
        linkId: link.id,
        idempotencyKey: "blocked-event",
        eventType: "routine_update",
        payload: { body: "This must not queue." },
      }),
    ).toThrow(/disconnected/i);
  });

  it("deduplicates outbox rows by idempotency key", () => {
    const { first } = taskPair();
    const link = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-idempotent",
      externalWorkstreamId: "remote-idempotent",
    });
    const input = {
      linkId: link.id,
      idempotencyKey: "same-event",
      eventType: "routine_update" as const,
      payload: { body: "A stable result." },
    };

    const firstInsert = enqueueWorkstreamEvent(input);
    const duplicate = enqueueWorkstreamEvent({
      ...input,
      payload: { body: "A duplicate must not replace the original." },
    });
    const claimed = claimDueWorkstreamEvents(Date.now() + 1_000, 10);

    expect(duplicate.id).toBe(firstInsert.id);
    expect(duplicate.payload).toEqual({ body: "A stable result." });
    expect(claimed.filter((event) => event.id === firstInsert.id)).toHaveLength(1);
  });

  it("records delivery and schedules failed rows for a later retry", () => {
    const { first } = taskPair();
    const link = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-retry",
      externalWorkstreamId: "remote-retry",
    });
    const delivered = enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: "delivered-event",
      eventType: "routine_update",
      payload: { body: "Delivered." },
    });
    const retried = enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: "retry-event",
      eventType: "routine_update",
      payload: { body: "Retry me." },
    });

    const initiallyClaimed = claimDueWorkstreamEvents(Date.now() + 1_000, 10);
    expect(initiallyClaimed.map((event) => event.id)).toEqual(
      expect.arrayContaining([delivered.id, retried.id]),
    );

    const deliveredClaim = initiallyClaimed.find((event) => event.id === delivered.id)!;
    const retryClaim = initiallyClaimed.find((event) => event.id === retried.id)!;
    const done = markWorkstreamDelivered(delivered.id, deliveredClaim.claim_token);
    const retryAt = Date.now() + 60_000;
    const failed = markWorkstreamFailed(
      retried.id,
      retryClaim.claim_token,
      "temporary outage",
      retryAt,
    );
    expect(done.state).toBe("delivered");
    expect(done.delivered_at).toBeGreaterThan(0);
    expect(failed.state).toBe("failed");
    expect(failed.last_error).toBe("temporary outage");
    expect(claimDueWorkstreamEvents(retryAt - 1, 10)).toEqual([]);
    expect(claimDueWorkstreamEvents(retryAt, 10).map((event) => event.id)).toContain(retried.id);
  });

  it("reclaims a delivering event after its claim lease expires", () => {
    const { first } = taskPair();
    const link = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-claim-recovery",
      externalWorkstreamId: "remote-claim-recovery",
    });
    const queued = enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: "claim-recovery-event",
      eventType: "routine_update",
      payload: { body: "Recover after a worker restart." },
      nextAttemptAt: 1_000_000,
    });

    const firstClaim = claimDueWorkstreamEvents(1_000_000, 100).find(
      (event) => event.id === queued.id,
    )!;
    expect(firstClaim.state).toBe("delivering");
    expect(firstClaim.attempts).toBe(1);
    expect(firstClaim.claim_expires_at).toBe(1_000_000 + WORKSTREAM_CLAIM_LEASE_MS);
    expect(
      claimDueWorkstreamEvents(
        1_000_000 + WORKSTREAM_CLAIM_LEASE_MS - 1,
        100,
      ).some((event) => event.id === queued.id),
    ).toBe(false);

    const recovered = claimDueWorkstreamEvents(
      1_000_000 + WORKSTREAM_CLAIM_LEASE_MS,
      100,
    ).find((event) => event.id === queued.id);
    expect(recovered?.state).toBe("delivering");
    expect(recovered?.attempts).toBe(2);
  });

  it("only marks delivering events as delivered or failed", () => {
    const { first } = taskPair();
    const link = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-transition-guards",
      externalWorkstreamId: "remote-transition-guards",
    });
    const pending = enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: "pending-transition-event",
      eventType: "routine_update",
      payload: { body: "Still pending." },
      nextAttemptAt: 2_000_000,
    });

    expect(() => markWorkstreamDelivered(pending.id, "not-claimed")).toThrow(/delivering/i);
    expect(() =>
      markWorkstreamFailed(
        pending.id,
        "not-claimed",
        "must not fail yet",
        2_100_000,
      ),
    ).toThrow(/delivering/i);
    expect(enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: "pending-transition-event",
      eventType: "routine_update",
      payload: { body: "Duplicate." },
    }).state).toBe("pending");

    const claimed = claimDueWorkstreamEvents(2_000_000, 100).find(
      (event) => event.id === pending.id,
    )!;
    const delivered = markWorkstreamDelivered(claimed.id, claimed.claim_token);
    expect(delivered.state).toBe("delivered");
    expect(() =>
      markWorkstreamFailed(
        delivered.id,
        claimed.claim_token,
        "must not resurrect",
        2_200_000,
      ),
    ).toThrow(/delivering/i);
    expect(
      enqueueWorkstreamEvent({
        linkId: link.id,
        idempotencyKey: "pending-transition-event",
        eventType: "routine_update",
        payload: { body: "Duplicate." },
      }).state,
    ).toBe("delivered");
  });

  it("rejects a stale claimant after an expired lease is reclaimed", () => {
    const { first } = taskPair();
    const link = activateWorkstream({
      taskId: first.id,
      provider: "ardent",
      externalCardId: "card-claim-owner",
      externalWorkstreamId: "remote-claim-owner",
    });
    const queued = enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey: "claim-owner-event",
      eventType: "routine_update",
      payload: { body: "Only the current claimant may finish." },
      nextAttemptAt: 3_000_000,
    });
    const firstClaim = claimDueWorkstreamEvents(3_000_000, 100).find(
      (event) => event.id === queued.id,
    )!;
    const currentClaim = claimDueWorkstreamEvents(
      3_000_000 + WORKSTREAM_CLAIM_LEASE_MS,
      100,
    ).find((event) => event.id === queued.id)!;

    expect(firstClaim.claim_token).not.toBe(currentClaim.claim_token);
    expect(() =>
      markWorkstreamDelivered(queued.id, firstClaim.claim_token),
    ).toThrow(/claim/i);
    expect(() =>
      markWorkstreamFailed(
        queued.id,
        firstClaim.claim_token,
        "stale worker",
        3_100_000,
      ),
    ).toThrow(/claim/i);
    expect(
      markWorkstreamDelivered(queued.id, currentClaim.claim_token).state,
    ).toBe("delivered");
  });

  it("upgrades an old outbox schema before enqueueing and claiming", () => {
    const db = new Database(":memory:");
    init(db);
    db.exec(`
      DROP TABLE workstream_outbox;
      CREATE TABLE workstream_outbox (
        id                TEXT PRIMARY KEY,
        link_id           TEXT NOT NULL REFERENCES workstream_links(id) ON DELETE CASCADE,
        idempotency_key   TEXT NOT NULL UNIQUE,
        event_type        TEXT NOT NULL,
        payload           TEXT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'delivering', 'delivered', 'failed')),
        attempts          INTEGER NOT NULL DEFAULT 0,
        next_attempt_at   INTEGER NOT NULL,
        last_error        TEXT NOT NULL DEFAULT '',
        delivered_at      INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
    `);

    init(db);
    const columns = (
      db.prepare("PRAGMA table_info(workstream_outbox)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toContain("claim_expires_at");
    expect(columns).toContain("claim_token");

    const originalDb = global.__orchDb;
    global.__orchDb = db;
    try {
      const project = createProject({ name: "Legacy Workstream DB" });
      const task = createTask({ project_id: project.id, title: "Legacy task" });
      const link = activateWorkstream({
        taskId: task.id,
        provider: "ardent",
        externalCardId: "legacy-card",
        externalWorkstreamId: "legacy-remote",
      });
      const event = enqueueWorkstreamEvent({
        linkId: link.id,
        idempotencyKey: "legacy-event",
        eventType: "routine_update",
        payload: { body: "Migrated safely." },
        nextAttemptAt: 4_000_000,
      });
      const claimed = claimDueWorkstreamEvents(4_000_000, 10).find(
        (candidate) => candidate.id === event.id,
      );
      expect(claimed?.claim_expires_at).toBe(
        4_000_000 + WORKSTREAM_CLAIM_LEASE_MS,
      );
      expect(claimed?.claim_token).toBeTruthy();
    } finally {
      global.__orchDb = originalDb;
      db.close();
    }
  });
});
