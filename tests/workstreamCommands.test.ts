import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, createTask } from "../lib/store";
import {
  activateWorkstream,
  getWorkstreamByTask,
  setWorkstreamState,
} from "../lib/workstreams/store";
import { getDb } from "../lib/db";
import { WORKSTREAM_LIFECYCLE_MESSAGES } from "../lib/workstreams/worker";

type WorkstreamGetRoute = {
  GET: (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
};

type WorkstreamCommandRoute = {
  POST: (
    request: Request,
    context: { params: Promise<{ id: string; command: string }> },
  ) => Promise<Response>;
};

async function loadRoutes(): Promise<{
  getRoute?: WorkstreamGetRoute;
  commandRoute?: WorkstreamCommandRoute;
}> {
  try {
    return {
      getRoute: (await import("../app/api/tasks/[id]/workstream/route")) as WorkstreamGetRoute,
      commandRoute: (await import(
        "../app/api/tasks/[id]/workstream/[command]/route"
      )) as WorkstreamCommandRoute,
    };
  } catch {
    return {};
  }
}

function linkedTask(label: string) {
  const project = createProject({
    name: `Workstream commands ${label} ${Date.now()} ${Math.random()}`,
  });
  const task = createTask({ project_id: project.id, title: label });
  const link = activateWorkstream({
    taskId: task.id,
    provider: "ardent",
    externalCardId: `card-${label}-${Math.random()}`,
    externalWorkstreamId: `remote-${label}-${Math.random()}`,
  });
  return { task, link };
}

function lifecycleRows(taskId: string) {
  return getDb()
    .prepare(
      `SELECT o.payload, o.state
       FROM workstream_outbox o
       JOIN workstream_links l ON l.id = o.link_id
       WHERE l.task_id = ?
       ORDER BY o.created_at, o.id`,
    )
    .all(taskId)
    .map((row) => {
      const typed = row as { payload: string; state: string };
      return { payload: JSON.parse(typed.payload), state: typed.state };
    });
}

describe("task workstream API", () => {
  beforeEach(() => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns the linked workstream without changing the task", async () => {
    const { getRoute } = await loadRoutes();
    expect(getRoute?.GET).toBeTypeOf("function");
    const { task, link } = linkedTask("get");

    const response = await getRoute!.GET(
      new Request(`http://operator.test/api/tasks/${task.id}/workstream`),
      { params: Promise.resolve({ id: task.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workstream: link });
  });

  it.each([
    ["pause", "active", "paused"],
    ["resume", "paused", "active"],
    ["disconnect", "active", "disconnected"],
  ] as const)("enforces the %s command through the bridge", async (command, initial, state) => {
    const { commandRoute } = await loadRoutes();
    expect(commandRoute?.POST).toBeTypeOf("function");
    const { task, link } = linkedTask(command);
    setWorkstreamState(link.id, initial);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ workstream: { status: initial } }),
      )
      .mockResolvedValueOnce(
        Response.json({ workstream: { status: state } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await commandRoute!.POST(
      new Request(
        `http://operator.test/api/tasks/${task.id}/workstream/${command}`,
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: task.id, command }) },
    );

    expect(response.status).toBe(200);
    expect(getWorkstreamByTask(task.id)?.state).toBe(state);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tracker.example/api/workstream-bridge/control",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workstream_id: link.external_workstream_id,
          command,
        }),
      }),
    );
    if (command === "pause" || command === "resume") {
      expect(lifecycleRows(task.id)).toContainEqual({
        payload: {
          body:
            command === "pause"
              ? WORKSTREAM_LIFECYCLE_MESSAGES.paused
              : WORKSTREAM_LIFECYCLE_MESSAGES.resumed,
          attachments: [],
        },
        state: "pending",
      });
    } else {
      expect(lifecycleRows(task.id)).toEqual([]);
    }
  });

  it("posts a fixed privacy-safe update through the bridge on post-now", async () => {
    const { commandRoute } = await loadRoutes();
    expect(commandRoute?.POST).toBeTypeOf("function");
    const { task, link } = linkedTask("post-now");
    setWorkstreamState(link.id, "paused");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ workstream: { status: "paused" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ one_shot_token: "opaque-one-shot-token" }),
      )
      .mockResolvedValueOnce(Response.json({ delivered: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await commandRoute!.POST(
      new Request(
        `http://operator.test/api/tasks/${task.id}/workstream/post-now`,
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: task.id, command: "post-now" }) },
    );

    expect(response.status).toBe(200);
    const updateCall = fetchMock.mock.calls[2];
    expect(updateCall[0]).toBe(
      "https://tracker.example/api/workstream-bridge/update",
    );
    const update = JSON.parse(
      (updateCall[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(update.workstream_id).toBe(link.external_workstream_id);
    expect(update.body).toBe("Work is in progress.");
    expect(update.one_shot_token).toBe("opaque-one-shot-token");
    expect(JSON.stringify(update)).not.toContain(link.external_card_id);
  });

  it.each(["resume", "post-now"] as const)(
    "rejects %s after disconnect without calling the bridge",
    async (command) => {
      const { commandRoute } = await loadRoutes();
      const { task, link } = linkedTask(`terminal-${command}`);
      setWorkstreamState(link.id, "disconnected");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await commandRoute!.POST(
        new Request(
          `http://operator.test/api/tasks/${task.id}/workstream/${command}`,
          { method: "POST" },
        ),
        { params: Promise.resolve({ id: task.id, command }) },
      );

      expect(response.status).toBe(409);
      expect(getWorkstreamByTask(task.id)?.state).toBe("disconnected");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("allows post-now only while paused", async () => {
    const { commandRoute } = await loadRoutes();
    const { task } = linkedTask("active-post-now");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await commandRoute!.POST(
      new Request(
        `http://operator.test/api/tasks/${task.id}/workstream/post-now`,
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: task.id, command: "post-now" }) },
    );

    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown commands without a bridge call or state change", async () => {
    const { commandRoute } = await loadRoutes();
    expect(commandRoute?.POST).toBeTypeOf("function");
    const { task } = linkedTask("invalid");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await commandRoute!.POST(
      new Request(
        `http://operator.test/api/tasks/${task.id}/workstream/delete-history`,
        { method: "POST" },
      ),
      {
        params: Promise.resolve({
          id: task.id,
          command: "delete-history",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(getWorkstreamByTask(task.id)?.state).toBe("active");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
