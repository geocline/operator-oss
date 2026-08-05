import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject, createTask } from "../lib/store";
import {
  WORKSTREAM_CLAIM_LEASE_MS,
  activateWorkstream,
  claimDueWorkstreamEvents,
  claimWorkstreamEvent,
  enqueueWorkstreamEvent,
  getWorkstreamByTask,
  getWorkstreamOutboxEvent,
  releaseWorkstreamClaim,
  setWorkstreamState,
} from "../lib/workstreams/store";
import {
  MAX_WORKSTREAM_DELIVERY_ATTEMPTS,
  NEVER_RETRY_WORKSTREAM_AT,
  WORKSTREAM_RECONCILE_WARNING_INTERVAL_MS,
  WORKSTREAM_RETRY_BASE_MS,
  getWorkstreamStorageReconciliationStatus,
  runWorkstreamWorkerOnce,
  startWorkstreamWorker,
  stopWorkstreamWorkerForTests,
} from "../lib/workstreams/worker";
import {
  postWorkstreamUpdateDetailed,
  reconcileWorkstreamStorage,
  registerWorkstreamConversation,
  readRemoteWorkstreamState,
  type WorkstreamBridgeResult,
  type WorkstreamStorageReconcileResult,
} from "../lib/workstreams/client";
import { deliverWorkstreamOutboxEvent } from "../lib/workstreams/worker";
import { activity } from "../lib/idle";

function linkedEvent(label: string, nextAttemptAt: number) {
  const project = createProject({
    name: `Delivery ${label} ${Date.now()} ${Math.random()}`,
  });
  const task = createTask({ project_id: project.id, title: label });
  const link = activateWorkstream({
    taskId: task.id,
    provider: "ardent",
    externalCardId: `card-${label}-${Math.random()}`,
    externalWorkstreamId: `remote-${label}-${Math.random()}`,
  });
  const event = enqueueWorkstreamEvent({
    linkId: link.id,
    idempotencyKey: `delivery:${label}:${Math.random()}`,
    eventType: "routine_update",
    payload: { body: "The review is ready.", attachments: [] },
    nextAttemptAt,
  });
  return { link, event };
}

const deliveredResult: WorkstreamBridgeResult = {
  ok: true,
  value: { delivered: true },
};

afterEach(() => {
  stopWorkstreamWorkerForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("typed workstream bridge delivery", () => {
  it("runs one bounded tracker storage reconciliation through the dedicated bridge route", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        summary: {
          claimed: 3,
          kept: 1,
          deleted: 1,
          retried: 1,
          failed: 0,
        },
      }),
    );

    const result = await reconcileWorkstreamStorage({
      timeoutMs: 25,
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      ok: true,
      summary: {
        claimed: 3,
        kept: 1,
        deleted: 1,
        retried: 1,
        failed: 0,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tracker.example/api/workstream-bridge/reconcile",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer bridge-secret",
        }),
        body: JSON.stringify({ limit: 20 }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns only a safe typed failure when reconciliation fails", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const sensitive =
      "failed at /Users/private/worktree with bridge-secret and SQLSTATE 42P01";

    const result = await reconcileWorkstreamStorage({
      fetchImpl: vi.fn().mockResolvedValue(
        Response.json(
          { error: sensitive, retryable: true },
          { status: 503 },
        ),
      ),
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      category: "server",
      status: 503,
    });
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(JSON.stringify(result)).not.toContain("/Users/private");
    expect(JSON.stringify(result)).not.toContain("bridge-secret");
  });

  it("registers one exact provider conversation through the dedicated bridge route", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ status: "attached" }),
    );

    const result = await registerWorkstreamConversation(
      {
        externalWorkstreamId: "remote-conversation",
        sessionId: "019fca68-fdfd-77d2-ad8f-644df9d13e8a",
        source: "codex",
        title: "Wobbe: Review closing package",
        summary: "Closing package review is underway.",
        projectPath: "/Users/private/worktree",
        sessionModified: "2026-08-04T18:30:00.000Z",
      },
      { fetchImpl: fetchMock },
    );

    expect(result).toEqual({
      ok: true,
      value: { status: "attached" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tracker.example/api/workstream-bridge/conversation",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer bridge-secret",
        }),
        body: JSON.stringify({
          workstream_id: "remote-conversation",
          session_id: "019fca68-fdfd-77d2-ad8f-644df9d13e8a",
          source: "codex",
          title: "Wobbe: Review closing package",
          summary: "Closing package review is underway.",
          project_path: "/Users/private/worktree",
          session_modified: "2026-08-04T18:30:00.000Z",
        }),
      }),
    );
  });

  it("keeps conversation-registration failures generic and retryable", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const rejectedDetail =
      "Rejected /Users/private/worktree at file:///private/run; bridge-secret";
    const result = await registerWorkstreamConversation(
      {
        externalWorkstreamId: "remote-conversation",
        sessionId: "claude-session-1",
        source: "claude",
        projectPath: "/Users/private/worktree",
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json(
            { error: rejectedDetail, retryable: true },
            { status: 503 },
          ),
        ),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      category: "server",
    });
    expect(JSON.stringify(result)).not.toContain(rejectedDetail);
    expect(JSON.stringify(result)).not.toContain("bridge-secret");
    expect(JSON.stringify(result)).not.toContain("/Users/private");
    expect(JSON.stringify(result)).not.toContain("file://");
  });

  it("delivers a durable conversation-registration event without card-facing sanitization", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const project = createProject({
      name: `Conversation delivery ${Date.now()} ${Math.random()}`,
    });
    const task = createTask({
      project_id: project.id,
      title: "Conversation delivery",
    });
    const link = activateWorkstream({
      taskId: task.id,
      provider: "ardent",
      externalCardId: "card-conversation-delivery",
      externalWorkstreamId: "remote-conversation-delivery",
    });
    const event = enqueueWorkstreamEvent({
      linkId: link.id,
      idempotencyKey:
        "conversation:codex:019fca68-fdfd-77d2-ad8f-644df9d13e8a",
      eventType: "conversation_registration",
      payload: {
        session_id: "019fca68-fdfd-77d2-ad8f-644df9d13e8a",
        source: "codex",
        title: "Wobbe: Review closing package",
        project_path: "/Users/private/worktree",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ status: "already_attached" }),
    );

    const result = await deliverWorkstreamOutboxEvent({
      link,
      event,
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      ok: true,
      value: { status: "already_attached" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tracker.example/api/workstream-bridge/conversation",
      expect.objectContaining({
        body: JSON.stringify({
          workstream_id: "remote-conversation-delivery",
          session_id: "019fca68-fdfd-77d2-ad8f-644df9d13e8a",
          source: "codex",
          title: "Wobbe: Review closing package",
          project_path: "/Users/private/worktree",
        }),
      }),
    );
    setWorkstreamState(link.id, "disconnected");
  });

  it.each(["active", "paused", "disconnected", "activating"] as const)(
    "parses provider-neutral remote state %s",
    async (status) => {
      vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
      vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({ workstream: { status }, retryable: false }),
      );

      const state = await readRemoteWorkstreamState("remote-state", {
        fetchImpl: fetchMock,
      });

      expect(state).toEqual({ ok: true, state: status });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://tracker.example/api/workstream-bridge/state",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ workstream_id: "remote-state" }),
        }),
      );
    },
  );

  it("classifies timeouts and server failures as retryable", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const timeoutFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const timedOut = await postWorkstreamUpdateDetailed(
      {
        externalWorkstreamId: "remote-timeout",
        idempotencyKey: "timeout-key",
        body: "The review is ready.",
      },
      { timeoutMs: 5, fetchImpl: timeoutFetch },
    );
    const unavailable = await postWorkstreamUpdateDetailed(
      {
        externalWorkstreamId: "remote-server",
        idempotencyKey: "server-key",
        body: "The review is ready.",
      },
      {
        fetchImpl: vi
          .fn()
          .mockResolvedValue(new Response(null, { status: 503 })),
      },
    );

    expect(timedOut).toMatchObject({
      ok: false,
      retryable: true,
      category: "timeout",
    });
    expect(unavailable).toMatchObject({
      ok: false,
      retryable: true,
      category: "server",
      status: 503,
    });
  });

  it("classifies policy failures as permanent without retaining rejected content", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const rejectedText =
      "Rejected private path /Users/example/private and bridge-secret";
    const result = await postWorkstreamUpdateDetailed(
      {
        externalWorkstreamId: "remote-policy",
        idempotencyKey: "policy-key",
        body: "The review is ready.",
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json(
            { error: rejectedText, retryable: false },
            { status: 422 },
          ),
        ),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      category: "policy",
      status: 422,
    });
    expect(JSON.stringify(result)).not.toContain(rejectedText);
    expect(JSON.stringify(result)).not.toContain("bridge-secret");
  });
});

describe("durable workstream worker", () => {
  it("preserves a queued row and its attempt budget while the tracker is paused", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const now = 9_000_000;
    const { link, event } = linkedEvent("remote-paused", now);
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        workstream: { status: "paused" },
        retryable: false,
      }),
    );

    const summary = await runWorkstreamWorkerOnce({
      now,
      fetchImpl: fetchMock,
    });

    expect(summary.claimed).toBe(0);
    expect(getWorkstreamByTask(link.task_id)?.state).toBe("paused");
    expect(getWorkstreamOutboxEvent(event.id)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    setWorkstreamState(link.id, "disconnected");
  });

  it("reconciles a tracker resume and eventually delivers the preserved row", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const now = 9_100_000;
    const { link, event } = linkedEvent("remote-resumed", now);
    setWorkstreamState(link.id, "paused");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          workstream: { status: "active" },
          retryable: false,
        }),
      )
      .mockResolvedValueOnce(Response.json({ delivered: true }));

    const summary = await runWorkstreamWorkerOnce({
      now,
      fetchImpl: fetchMock,
    });

    expect(summary.delivered).toBe(1);
    expect(getWorkstreamByTask(link.task_id)?.state).toBe("active");
    expect(getWorkstreamOutboxEvent(event.id)?.state).toBe("delivered");
  });

  it("makes a tracker disconnect terminal locally without claiming queued rows", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const now = 9_200_000;
    const { link, event } = linkedEvent("remote-disconnected", now);
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          workstream_id?: string;
        };
        return Response.json({
          workstream: {
            status:
              body.workstream_id === link.external_workstream_id
                ? "disconnected"
                : "active",
          },
          retryable: false,
        });
      },
    );

    await runWorkstreamWorkerOnce({ now, fetchImpl: fetchMock });

    expect(getWorkstreamByTask(link.task_id)?.state).toBe("disconnected");
    expect(getWorkstreamOutboxEvent(event.id)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    setWorkstreamState(link.id, "disconnected");
  });

  it("releases a claim without consuming an attempt when a delivery race finds remote pause", async () => {
    const now = 9_300_000;
    const { link, event } = linkedEvent("pause-race", now);
    const deliver = vi.fn().mockResolvedValue({
      ok: false,
      retryable: true,
      category: "state",
      status: 423,
      remoteState: "paused",
      error: "workstream is temporarily non-active",
    } satisfies WorkstreamBridgeResult);

    const summary = await runWorkstreamWorkerOnce({ now, deliver });

    expect(summary.claimed).toBe(1);
    expect(getWorkstreamByTask(link.task_id)?.state).toBe("paused");
    expect(getWorkstreamOutboxEvent(event.id)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    setWorkstreamState(link.id, "disconnected");
  });

  it.each(["paused", "disconnected"] as const)(
    "releases later batch claims when the link becomes %s during delivery",
    async (nextState) => {
      const now = 9_350_000;
      const { link, event: first } = linkedEvent(
        `batch-${nextState}`,
        now,
      );
      const second = enqueueWorkstreamEvent({
        linkId: link.id,
        idempotencyKey: `delivery:batch-${nextState}:second`,
        eventType: "routine_update",
        payload: { body: "The second update remains durable.", attachments: [] },
        nextAttemptAt: now + 1,
      });
      const deliver = vi.fn().mockImplementation(async () => {
        if (deliver.mock.calls.length === 1) {
          setWorkstreamState(link.id, nextState);
        }
        return deliveredResult;
      });

      const summary = await runWorkstreamWorkerOnce({
        now: now + 1,
        deliver,
      });

      expect(summary).toMatchObject({ claimed: 2, delivered: 1 });
      expect(getWorkstreamOutboxEvent(first.id)?.state).toBe("delivered");
      expect(getWorkstreamOutboxEvent(second.id)).toMatchObject({
        state: "pending",
        attempts: 0,
        next_attempt_at: now + 1,
        claim_expires_at: 0,
        claim_token: "",
      });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(getWorkstreamByTask(link.task_id)?.state).toBe(nextState);
      if (nextState === "paused") {
        setWorkstreamState(link.id, "disconnected");
      }
    },
  );

  it("recovers an expired claim after restart and delivers it once", async () => {
    const now = 10_000_000;
    const { event } = linkedEvent("restart", now);
    const abandoned = claimDueWorkstreamEvents(now, 1)[0];
    expect(abandoned.id).toBe(event.id);

    const deliver = vi.fn().mockResolvedValue(deliveredResult);
    const summary = await runWorkstreamWorkerOnce({
      now: now + WORKSTREAM_CLAIM_LEASE_MS,
      deliver,
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(getWorkstreamOutboxEvent(event.id)?.state).toBe("delivered");
  });

  it("uses exponential retries and stops after the bounded attempt count", async () => {
    let now = 20_000_000;
    const { event } = linkedEvent("backoff", now);
    const temporary: WorkstreamBridgeResult = {
      ok: false,
      retryable: true,
      category: "server",
      status: 503,
      error: "tracker temporarily unavailable",
    };
    const deliver = vi.fn().mockResolvedValue(temporary);

    for (let attempt = 1; attempt <= MAX_WORKSTREAM_DELIVERY_ATTEMPTS; attempt++) {
      await runWorkstreamWorkerOnce({ now, deliver });
      const row = getWorkstreamOutboxEvent(event.id)!;
      expect(row.attempts).toBe(attempt);
      if (attempt < MAX_WORKSTREAM_DELIVERY_ATTEMPTS) {
        expect(row.next_attempt_at).toBe(
          now + WORKSTREAM_RETRY_BASE_MS * 2 ** (attempt - 1),
        );
        now = row.next_attempt_at;
      } else {
        expect(row.next_attempt_at).toBe(NEVER_RETRY_WORKSTREAM_AT);
      }
    }

    expect(deliver).toHaveBeenCalledTimes(MAX_WORKSTREAM_DELIVERY_ATTEMPTS);
    expect(
      claimDueWorkstreamEvents(NEVER_RETRY_WORKSTREAM_AT - 1, 10),
    ).toEqual([]);
  });

  it("leaves permanent policy failures visible without retrying them", async () => {
    const now = 30_000_000;
    const { event } = linkedEvent("permanent", now);
    const deliver = vi.fn().mockResolvedValue({
      ok: false,
      retryable: false,
      category: "policy",
      status: 422,
      error: "tracker rejected the card-facing payload",
    } satisfies WorkstreamBridgeResult);

    await runWorkstreamWorkerOnce({ now, deliver });
    const row = getWorkstreamOutboxEvent(event.id)!;

    expect(row).toMatchObject({
      state: "failed",
      attempts: 1,
      next_attempt_at: NEVER_RETRY_WORKSTREAM_AT,
    });
    await runWorkstreamWorkerOnce({
      now: NEVER_RETRY_WORKSTREAM_AT - 1,
      deliver,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("retains paused rows and delivers them after resume", async () => {
    const now = 40_000_000;
    const { link, event } = linkedEvent("paused-worker", now);
    setWorkstreamState(link.id, "paused");
    const deliver = vi.fn().mockResolvedValue(deliveredResult);

    expect(await runWorkstreamWorkerOnce({ now, deliver })).toMatchObject({
      claimed: 0,
    });
    expect(getWorkstreamOutboxEvent(event.id)?.state).toBe("pending");
    setWorkstreamState(link.id, "active");
    expect(await runWorkstreamWorkerOnce({ now, deliver })).toMatchObject({
      delivered: 1,
    });
    expect(getWorkstreamOutboxEvent(event.id)?.state).toBe("delivered");
  });

  it("counts only active delivery work as idle-blocking background work", async () => {
    const now = 45_000_000;
    linkedEvent("idle-accounting", now);
    const before = activity().openWork;
    let release!: (value: WorkstreamBridgeResult) => void;
    const deliver = vi.fn(
      () =>
        new Promise<WorkstreamBridgeResult>((resolve) => {
          release = resolve;
        }),
    );

    const running = runWorkstreamWorkerOnce({ now, deliver });
    expect(activity().openWork).toBe(before + 1);
    release(deliveredResult);
    await running;
    expect(activity().openWork).toBe(before);

    await runWorkstreamWorkerOnce({ now: now + 1, deliver });
    expect(activity().openWork).toBe(before);
  });

  it("reuses the same idempotency key after a timeout so remote deduplication prevents duplicate writes", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const now = 50_000_000;
    const { event } = linkedEvent("timeout-dedupe", now);
    const calls: Record<string, unknown>[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (!body.idempotency_key) {
          return Response.json({
            workstream: { status: "active" },
            retryable: false,
          });
        }
        calls.push(body);
        if (calls.length === 1) {
          throw new DOMException("aborted", "AbortError");
        }
        return Response.json({ delivered: true, duplicate: true });
      });

    await runWorkstreamWorkerOnce({ now, fetchImpl: fetchMock });
    const retryAt = getWorkstreamOutboxEvent(event.id)!.next_attempt_at;
    await runWorkstreamWorkerOnce({ now: retryAt, fetchImpl: fetchMock });

    expect(calls).toHaveLength(2);
    expect(calls[0].idempotency_key).toBe(event.idempotency_key);
    expect(calls[1].idempotency_key).toBe(event.idempotency_key);
    expect(getWorkstreamOutboxEvent(event.id)?.state).toBe("delivered");
  });
});

describe("scheduled tracker storage reconciliation", () => {
  const failedReconciliation: WorkstreamStorageReconcileResult = {
    ok: false,
    retryable: true,
    category: "server",
    status: 503,
    error: "tracker reconciliation is temporarily unavailable",
  };
  const successfulReconciliation: WorkstreamStorageReconcileResult = {
    ok: true,
    summary: {
      claimed: 1,
      kept: 0,
      deleted: 1,
      retried: 0,
      failed: 0,
    },
  };

  it("runs after worker boot and every scheduled pass with no due outbox rows", async () => {
    vi.useFakeTimers();
    const reconcileStorage = vi
      .fn<() => Promise<WorkstreamStorageReconcileResult>>()
      .mockResolvedValue(successfulReconciliation);

    await startWorkstreamWorker({ reconcileStorage });
    await vi.waitFor(() => expect(reconcileStorage).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(reconcileStorage).toHaveBeenCalledTimes(2));
  });

  it("retries a transient reconciliation failure on the next worker pass", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reconcileStorage = vi
      .fn<() => Promise<WorkstreamStorageReconcileResult>>()
      .mockResolvedValueOnce(failedReconciliation)
      .mockResolvedValueOnce(successfulReconciliation);

    await startWorkstreamWorker({ reconcileStorage });
    await vi.advanceTimersByTimeAsync(0);
    expect(getWorkstreamStorageReconciliationStatus()).toMatchObject({
      state: "error",
      category: "server",
    });

    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileStorage).toHaveBeenCalledTimes(2);
    expect(getWorkstreamStorageReconciliationStatus()).toMatchObject({
      state: "ok",
    });
    expect(getWorkstreamStorageReconciliationStatus()).not.toHaveProperty(
      "category",
    );
  });

  it("deduplicates concurrent worker calls and counts only the active cleanup as background work", async () => {
    let resolveReconciliation!: (
      value: WorkstreamStorageReconcileResult,
    ) => void;
    const reconcileStorage = vi.fn(
      () =>
        new Promise<WorkstreamStorageReconcileResult>((resolve) => {
          resolveReconciliation = resolve;
        }),
    );
    const before = activity().openWork;

    const first = startWorkstreamWorker({ reconcileStorage });
    const second = startWorkstreamWorker({ reconcileStorage });
    await Promise.all([first, second]);

    expect(reconcileStorage).toHaveBeenCalledTimes(1);
    expect(activity().openWork).toBe(before + 1);
    expect(getWorkstreamStorageReconciliationStatus()).toMatchObject({
      state: "running",
    });

    resolveReconciliation(successfulReconciliation);
    await vi.waitFor(() => expect(activity().openWork).toBe(before));
    expect(getWorkstreamStorageReconciliationStatus()).toMatchObject({
      state: "ok",
    });
  });

  it("continues normal outbox delivery when reconciliation fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = Date.now();
    const { event } = linkedEvent("reconcile-isolation", now);
    const deliver = vi.fn().mockResolvedValue(deliveredResult);
    const reconcileStorage = vi
      .fn<() => Promise<WorkstreamStorageReconcileResult>>()
      .mockResolvedValue(failedReconciliation);

    const summary = await startWorkstreamWorker({
      now,
      deliver,
      reconcileStorage,
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
    expect(getWorkstreamOutboxEvent(event.id)?.state).toBe("delivered");
    await vi.waitFor(() =>
      expect(
        getWorkstreamStorageReconciliationStatus(),
      ).toMatchObject({ state: "error", category: "server" }),
    );
  });

  it("rate-limits generic warnings and never includes remote detail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reconcileStorage = vi
      .fn<() => Promise<WorkstreamStorageReconcileResult>>()
      .mockResolvedValue(failedReconciliation);

    await startWorkstreamWorker({ reconcileStorage });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(reconcileStorage).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(
      WORKSTREAM_RECONCILE_WARNING_INTERVAL_MS,
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn.mock.calls.flat().join(" ")).toBe(
      "[workstreams] tracker storage reconciliation failed " +
        "[workstreams] tracker storage reconciliation failed",
    );
  });
});

describe("claim release", () => {
  it("requires claim ownership and restores the original attempt budget", () => {
    const now = 80_000_000;
    const { event } = linkedEvent("claim-release", now);
    const claimed = claimWorkstreamEvent(event.id, now)!;
    expect(() =>
      releaseWorkstreamClaim(event.id, "wrong-token", now + 1),
    ).toThrow(/claim token/i);
    const released = releaseWorkstreamClaim(
      event.id,
      claimed.claim_token,
      now + 1,
    );
    expect(released).toMatchObject({
      state: "pending",
      attempts: 0,
      next_attempt_at: now + 1,
      claim_token: "",
    });
  });
});

describe("boot restore wiring", () => {
  it("starts the outbox worker through an idle-neutral boot route", async () => {
    const server = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../server.js", import.meta.url), "utf8"),
    );
    const proxy = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../proxy.ts", import.meta.url), "utf8"),
    );

    expect(server).toContain("/api/internal/workstreams/restore");
    expect(server).toContain(
      'p !== "/api/internal/workstreams/restore"',
    );
    expect(proxy).toContain("export async function proxy");
    expect(proxy).toContain("/api/internal/workstreams/restore");
  });
});
