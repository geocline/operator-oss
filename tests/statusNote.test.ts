import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import {
  activateWorkstream,
  setWorkstreamState,
} from "@/lib/workstreams/store";
import {
  deliverWorkstreamOutboxEvent,
  stopWorkstreamWorkerForTests,
} from "@/lib/workstreams/worker";
import { POST as notesPOST } from "@/app/api/tasks/[id]/notes/route";

function makeLinkedTask(state: "active" | "paused" | "disconnected" = "active") {
  const project = createProject({ name: `Status note ${Date.now()} ${Math.random()}` });
  const task = createTask({ project_id: project.id, title: "Linked task" });
  const link = activateWorkstream({
    taskId: task.id,
    provider: "ardent",
    externalCardId: `card-${Math.random()}`,
    externalWorkstreamId: `ws-${Math.random()}`,
  });
  if (state !== "active") setWorkstreamState(link.id, state);
  return { project, task, link };
}

async function postNote(taskId: string, content: string) {
  return notesPOST(
    new Request("http://test/notes", { method: "POST", body: JSON.stringify({ content }) }),
    { params: Promise.resolve({ id: taskId }) },
  );
}

function outboxRowForKey(idempotencyKey: string) {
  return getDb()
    .prepare("SELECT * FROM workstream_outbox WHERE idempotency_key = ?")
    .get(idempotencyKey) as { event_type: string; payload: string; link_id: string } | undefined;
}

afterEach(() => {
  stopWorkstreamWorkerForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/tasks/[id]/notes enqueues status_note", () => {
  it("enqueues a status_note event when the workstream link is active", async () => {
    const { task, link } = makeLinkedTask("active");
    const res = await postNote(task.id, "Made progress on the thing.");
    expect(res.status).toBe(200);
    const note = (await res.json()) as { id: string; content: string; created_at: number; generation: number };
    expect(note.content).toBe("Made progress on the thing.");

    const row = outboxRowForKey(`status_note:${note.id}`);
    expect(row).toBeDefined();
    expect(row?.event_type).toBe("status_note");
    expect(row?.link_id).toBe(link.id);
    const payload = JSON.parse(row!.payload) as { note: typeof note; task_status: string };
    expect(payload.note).toEqual({
      id: note.id,
      content: note.content,
      created_at: note.created_at,
      generation: note.generation,
    });
    expect(payload.task_status).toBe(getTask(task.id)?.status);
  });

  it("does not enqueue when the workstream link is paused", async () => {
    const { task } = makeLinkedTask("paused");
    const res = await postNote(task.id, "Quiet update.");
    const note = (await res.json()) as { id: string };
    expect(outboxRowForKey(`status_note:${note.id}`)).toBeUndefined();
  });

  it("does not enqueue when the workstream link is disconnected", async () => {
    const { task } = makeLinkedTask("disconnected");
    const res = await postNote(task.id, "Quiet update.");
    const note = (await res.json()) as { id: string };
    expect(outboxRowForKey(`status_note:${note.id}`)).toBeUndefined();
  });

  it("does not enqueue when there is no workstream link at all", async () => {
    const project = createProject({ name: `No link ${Date.now()} ${Math.random()}` });
    const task = createTask({ project_id: project.id, title: "Unlinked" });
    const res = await postNote(task.id, "Just a note.");
    expect(res.status).toBe(200);
    const note = (await res.json()) as { id: string };
    expect(outboxRowForKey(`status_note:${note.id}`)).toBeUndefined();
  });

  it("404s for an unknown task", async () => {
    const res = await postNote("does-not-exist", "hi");
    expect(res.status).toBe(404);
  });

  it("400s for empty content", async () => {
    const { task } = makeLinkedTask("active");
    const res = await postNote(task.id, "   ");
    expect(res.status).toBe(400);
  });
});

describe("status_note worker delivery", () => {
  it("POSTs to the tracker update route with the expected body", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { task, link } = makeLinkedTask("active");
    updateTask(task.id, { status: "in_progress" });

    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ ok: true }),
    );

    const note = { id: "note-1", content: "Working on it.", created_at: 1000, generation: 1 };
    const result = await deliverWorkstreamOutboxEvent({
      link,
      event: {
        id: "evt-1",
        link_id: link.id,
        idempotency_key: `status_note:${note.id}`,
        event_type: "status_note",
        payload: { note, task_status: "in_progress" },
        state: "delivering",
        attempts: 1,
        next_attempt_at: 0,
        claim_expires_at: 0,
        claim_token: "tok",
        last_error: "",
        delivered_at: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tracker.example/api/workstream-bridge/update",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer bridge-secret",
        }),
        body: JSON.stringify({
          workstream_id: link.external_workstream_id,
          event_type: "status_note",
          note,
          task_status: "in_progress",
        }),
      }),
    );
  });

  it("fails permanently (no retry) when the note content is invalid", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { link } = makeLinkedTask("active");
    const fetchMock = vi.fn();

    const result = await deliverWorkstreamOutboxEvent({
      link,
      event: {
        id: "evt-2",
        link_id: link.id,
        idempotency_key: "status_note:bad",
        event_type: "status_note",
        payload: { note: { id: "n", content: "", created_at: 1, generation: 1 }, task_status: "in_progress" },
        state: "delivering",
        attempts: 1,
        next_attempt_at: 0,
        claim_expires_at: 0,
        claim_token: "tok",
        last_error: "",
        delivered_at: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
