import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { createProject, createTask, getTask, getTaskDeps, setTaskDeps } from "@/lib/store";
import { SUGGEST_TASK, SUGGEST_TASK_DEPS_ENABLED } from "@/lib/agentToolDefs.mjs";
import {
  createSuggestedTask,
  proposeCardChange,
  publishWorkstreamUpdate,
  registerExposedService,
  resolveTitleRefs,
} from "@/lib/agentTools";
import { getDb } from "@/lib/db";
import {
  activateWorkstream,
  getWorkstreamByTask,
  setWorkstreamState,
} from "@/lib/workstreams/store";
import { buildWorkstreamRuntimeGuidance } from "@/lib/agents/shared";
import { POST as suggestTask } from "@/app/api/internal/agent-tools/suggest-task/route";
import { POST as exposeService } from "@/app/api/internal/agent-tools/expose-service/route";
import { POST as publishUpdate } from "@/app/api/internal/agent-tools/publish-workstream-update/route";
import { POST as proposeChange } from "@/app/api/internal/agent-tools/propose-card-change/route";
import { instanceServiceTokenOk } from "@/lib/cf-access.mjs";

function post(handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function workstreamFixture(label: string) {
  const repoPath = fs.mkdtempSync(
    path.join(process.env.ORCH_TEST_TMP!, `agent-tool-${label}-`),
  );
  const project = createProject({
    name: `Agent tool ${label} ${Date.now()} ${Math.random()}`,
    repo_path: repoPath,
  });
  const task = createTask({
    project_id: project.id,
    title: `${label} linked task`,
  });
  const link = activateWorkstream({
    taskId: task.id,
    provider: "ardent",
    externalCardId: `card-${label}-${Math.random()}`,
    externalWorkstreamId: "123e4567-e89b-42d3-a456-426614174000",
  });
  return { repoPath, project, task, link };
}

function outboxRows(linkId: string) {
  return getDb()
    .prepare(
      "SELECT event_type, payload, state, attempts FROM workstream_outbox WHERE link_id = ? ORDER BY created_at, id",
    )
    .all(linkId) as Array<{
    event_type: string;
    payload: string;
    state: string;
    attempts: number;
  }>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("agentTools shared logic", () => {
  it("createSuggestedTask creates a suggested task with the given priority", () => {
    const project = createProject({ name: "Shared" });
    const { task, text } = createSuggestedTask(project, { title: "Do X", description: "the X", priority: "hi" });
    const row = getTask(task.id)!;
    expect(row).toMatchObject({ title: "Do X", description: "the X", priority: "hi", suggested: 1, status: "not_started" });
    expect(text).toContain("Do X");
    expect(text).toContain(task.id);
  });

  // Agent-set dependencies are gated by SUGGEST_TASK_DEPS_ENABLED
  // (lib/agentToolDefs.mjs), currently off: a suggested task must never arrive
  // already blocked, because the user never chose that. These pin both halves —
  // the gate itself, and the wiring it guards, so re-enabling can't silently
  // ship broken.
  it("ignores blocked_by while agent-set dependencies are disabled", () => {
    const project = createProject({ name: "Deps" });
    const a = createSuggestedTask(project, { title: "A", description: "" }).task;
    const b = createSuggestedTask(project, { title: "B", description: "", blocked_by: [a.id] });

    expect(SUGGEST_TASK_DEPS_ENABLED).toBe(false);
    expect(getTaskDeps(b.task.id)).toEqual([]);
    // …and the confirmation text handed back to the agent doesn't claim otherwise.
    expect(b.text).not.toContain("Blocked by");
  });

  it("keeps the dependency schema off the tool the agent sees", () => {
    // Two schemas are built from this descriptor (the in-process Claude server
    // and the stdio bridge); both spread the parameter in only when enabled.
    // The param doc survives for the re-enable, but the tool description must
    // not advertise ordering the model can't actually request.
    expect(SUGGEST_TASK.description).not.toContain("blocked_by");
    expect(SUGGEST_TASK.description).not.toContain("ORDERED");
    expect(SUGGEST_TASK.params.blocked_by).toBeTruthy();
  });

  it("setTaskDeps still drops unknown/foreign ids without throwing", () => {
    // The behaviour behind the flag: this is what wires up again when it flips,
    // and what the manual picker in the task modals uses today.
    const project = createProject({ name: "Deps2" });
    const a = createSuggestedTask(project, { title: "A", description: "" }).task;
    const b = createSuggestedTask(project, { title: "B", description: "" }).task;
    const other = createProject({ name: "Deps3" });
    const foreign = createSuggestedTask(other, { title: "Foreign", description: "" }).task;

    setTaskDeps(b.id, [a.id, "ghost", foreign.id]);
    expect(getTaskDeps(b.id)).toEqual([a.id]);
  });

  it("resolveTitleRefs maps session titles to ids and passes ids through", () => {
    const map = new Map<string, string>([["First task", "id-1"]]);
    expect(resolveTitleRefs(["First task", "id-2"], map)).toEqual(["id-1", "id-2"]);
    expect(resolveTitleRefs(undefined, map)).toEqual([]);
  });

  it("registerExposedService records the port and returns a URL + text", () => {
    const project = createProject({ name: "Svc" });
    const { info, url, text } = registerExposedService(project, "dev", 4321);
    expect(info.port).toBe(4321);
    expect(url).toBeTruthy();
    expect(text).toContain("4321");
    expect(text).toContain(url);
  });
});

describe("internal agent-tool endpoints", () => {
  it("suggest-task creates a task and returns its id + text", async () => {
    const project = createProject({ name: "EP-Suggest" });
    const res = await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      title: "Endpoint task",
      description: "via HTTP",
      priority: "lo",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string; text: string };
    expect(json.ok).toBe(true);
    expect(getTask(json.id)).toMatchObject({ title: "Endpoint task", priority: "lo", suggested: 1 });
    expect(json.text).toContain("Endpoint task");
  });

  it("suggest-task drops blocked_by while agent-set dependencies are disabled", async () => {
    // The endpoint still forwards the field (so re-enabling is one flag), but
    // createSuggestedTask is the choke point — a direct POST can't chain tasks.
    const project = createProject({ name: "EP-Deps" });
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task;
    const res = await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      title: "Dependent",
      description: "",
      blocked_by: [blocker.id],
    });
    const json = (await res.json()) as { id: string };
    expect(getTaskDeps(json.id)).toEqual([]);
  });

  it("suggest-task rejects an unknown project (404) and a missing title (400)", async () => {
    const bad = await post(suggestTask, "/api/internal/agent-tools/suggest-task", { projectId: "nope", title: "x" });
    expect(bad.status).toBe(404);
    const project = createProject({ name: "EP-Bad" });
    const noTitle = await post(suggestTask, "/api/internal/agent-tools/suggest-task", { projectId: project.id, title: "  " });
    expect(noTitle.status).toBe(400);
  });

  it("expose-service registers the service and returns the URL", async () => {
    const project = createProject({ name: "EP-Svc" });
    const res = await post(exposeService, "/api/internal/agent-tools/expose-service", {
      projectId: project.id,
      name: "api",
      port: 5555,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; name: string; url: string; text: string };
    expect(json.ok).toBe(true);
    expect(json.name).toBe("api");
    expect(json.url).toContain("5555");
    expect(json.text).toContain("5555");
  });

  it("expose-service rejects a non-positive / non-integer port (400)", async () => {
    const project = createProject({ name: "EP-Port" });
    for (const port of [0, -3, 1.5, "abc"]) {
      const res = await post(exposeService, "/api/internal/agent-tools/expose-service", {
        projectId: project.id,
        name: "x",
        port,
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a task/project scope mismatch before resolving a workstream", async () => {
    const first = workstreamFixture("scope-first");
    const second = workstreamFixture("scope-second");
    const response = await post(
      publishUpdate,
      "/api/internal/agent-tools/publish-workstream-update",
      {
        projectId: second.project.id,
        taskId: first.task.id,
        body: "The review is complete.",
      },
    );
    expect(response.status).toBe(409);
    expect(outboxRows(first.link.id)).toEqual([]);
  });

  it("derives the update target from the task, delivers with a fixed payload, and deduplicates retries", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { project, task, link } = workstreamFixture("delivered");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ comment_id: "comment-visible" }));
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      body: "The revised analysis is ready for review.",
      files: [],
    };
    const first = await publishWorkstreamUpdate(task, project, input);
    const duplicate = await publishWorkstreamUpdate(task, project, input);

    expect(first.status).toBe("delivered");
    expect(duplicate.status).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(request).toMatchObject({
      workstream_id: link.external_workstream_id,
      body: input.body,
      attachments: [],
    });
    expect(request).not.toHaveProperty("card_id");
    expect(request).not.toHaveProperty("author");
    expect(request).not.toHaveProperty("agent");
    expect(request).not.toHaveProperty("session");
    expect(outboxRows(link.id)).toEqual([
      expect.objectContaining({
        event_type: "routine_update",
        state: "delivered",
        attempts: 1,
      }),
    ]);
  });

  it("queues a privacy-safe update while paused and does not call the bridge", async () => {
    const { project, task, link } = workstreamFixture("paused");
    setWorkstreamState(link.id, "paused");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishWorkstreamUpdate(task, project, {
      body: "The revised comparison is ready.",
    });

    expect(result.status).toBe("paused");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outboxRows(link.id)).toEqual([
      expect.objectContaining({
        event_type: "routine_update",
        state: "pending",
        attempts: 0,
      }),
    ]);
  });

  it("releases an immediate-delivery claim when the tracker reports pause", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { project, task, link } = workstreamFixture("pause-race");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: "workstream is paused",
            workstream: { status: "paused" },
            retryable: false,
          },
          { status: 423 },
        ),
      ),
    );

    const result = await publishWorkstreamUpdate(task, project, {
      body: "The revised comparison is ready.",
    });

    expect(result.status).toBe("paused");
    expect(getWorkstreamByTask(task.id)?.state).toBe("paused");
    expect(outboxRows(link.id)).toEqual([
      expect.objectContaining({
        state: "pending",
        attempts: 0,
      }),
    ]);
  });

  it("returns disconnected without creating an undeliverable outbox row", async () => {
    const { project, task, link } = workstreamFixture("disconnected");
    setWorkstreamState(link.id, "disconnected");

    const result = await publishWorkstreamUpdate(task, project, {
      body: "The revised comparison is ready.",
    });

    expect(result.status).toBe("disconnected");
    expect(outboxRows(link.id)).toEqual([]);
  });

  it("posts text that the removed privacy policy would have blocked", async () => {
    const { project, task, link } = workstreamFixture("privacy");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishWorkstreamUpdate(task, project, {
      body: "See /Users/example/private/report.pdf from the Codex session.",
    });

    expect(result.status).not.toBe("rejected");
    expect(outboxRows(link.id)).toHaveLength(1);
  });

  it("reports a permanent tracker policy rejection instead of retrying it", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { project, task, link } = workstreamFixture("remote-policy");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          { error: "private implementation detail", retryable: false },
          { status: 422 },
        ),
      ),
    );

    const result = await publishWorkstreamUpdate(task, project, {
      body: "The revised comparison is ready.",
    });

    expect(result.status).toBe("rejected");
    expect(result.text).not.toContain("private implementation detail");
    expect(outboxRows(link.id)).toEqual([
      expect.objectContaining({
        event_type: "routine_update",
        state: "failed",
        attempts: 1,
      }),
    ]);
  });

  it("reads supported attachments only from the task workspace and never persists their path", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { repoPath, project, task, link } = workstreamFixture("attachment");
    const deliverables = path.join(repoPath, "deliverables");
    fs.mkdirSync(deliverables);
    const attachmentPath = path.join(deliverables, "summary.html");
    fs.writeFileSync(
      attachmentPath,
      "<!doctype html><html><body>Final underwriting summary.</body></html>",
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ comment_id: "comment-with-file" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishWorkstreamUpdate(task, project, {
      body: "The final underwriting summary is attached.",
      files: ["deliverables/summary.html"],
    });

    expect(result.status).toBe("delivered");
    const request = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as {
      attachments: Array<{
        filename: string;
        content_type: string;
        content_base64: string;
      }>;
    };
    expect(request.attachments).toEqual([
      {
        filename: "summary.html",
        content_type: "text/html",
        content_base64: Buffer.from(
          fs.readFileSync(attachmentPath),
        ).toString("base64"),
      },
    ]);
    expect(outboxRows(link.id)[0].payload).not.toContain(repoPath);

    const outside = path.join(process.env.ORCH_TEST_TMP!, "outside.pdf");
    fs.writeFileSync(outside, "%PDF-1.4");
    const rejected = await publishWorkstreamUpdate(task, project, {
      body: "A second file is attached.",
      files: [outside],
    });
    expect(rejected.status).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delivers the expanded text, data, image, and archive attachment formats", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { repoPath, project, task } = workstreamFixture("expanded-files");
    const files = [
      ["notes.md", "# Notes", "text/markdown"],
      ["rows.csv", "name,value\nA,1\n", "text/csv"],
      ["data.json", '{"ok":true}', "application/json"],
      ["diagram.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "image/svg+xml"],
      ["bundle.zip", "zip-bytes", "application/zip"],
    ] as const;
    for (const [filename, content] of files) {
      fs.writeFileSync(path.join(repoPath, filename), content);
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ comment_id: "expanded-files" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishWorkstreamUpdate(task, project, {
      body: "The requested source files are attached.",
      files: files.map(([filename]) => filename),
    });

    expect(result.status).toBe("delivered");
    const request = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { attachments: Array<{ filename: string; content_type: string }> };
    expect(
      request.attachments.map(({ filename, content_type }) => [
        filename,
        content_type,
      ]),
    ).toEqual(files.map(([filename, _content, contentType]) => [filename, contentType]));
  });

  it("delivers the remaining expanded text and legacy office formats", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { repoPath, project, task } = workstreamFixture("legacy-files");
    const files = [
      ["notes.txt", "Plain notes", "text/plain"],
      ["legacy.xls", "xls-bytes", "application/vnd.ms-excel"],
      ["legacy.doc", "doc-bytes", "application/msword"],
      ["legacy.ppt", "ppt-bytes", "application/vnd.ms-powerpoint"],
    ] as const;
    for (const [filename, content] of files) {
      fs.writeFileSync(path.join(repoPath, filename), content);
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ comment_id: "legacy-files" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishWorkstreamUpdate(task, project, {
      body: "The requested legacy files are attached.",
      files: files.map(([filename]) => filename),
    });

    expect(result.status).toBe("delivered");
    const request = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { attachments: Array<{ filename: string; content_type: string }> };
    expect(
      request.attachments.map(({ filename, content_type }) => [
        filename,
        content_type,
      ]),
    ).toEqual(files.map(([filename, _content, contentType]) => [filename, contentType]));
  });

  it("queues an allowlisted proposal for owner approval and rejects unsafe or unsupported values", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { project, task, link } = workstreamFixture("proposal");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ action: { id: "review-item" } }));
    vi.stubGlobal("fetch", fetchMock);

    const accepted = await proposeCardChange(task, project, {
      kind: "card_update",
      value: {
        due_date: "2026-08-20",
        priority: true,
        description: "The final review is ready.",
      },
    });
    expect(accepted.status).toBe("delivered");
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      workstream_id: link.external_workstream_id,
      kind: "card_update",
      payload: {
        due_date: "2026-08-20",
        priority: true,
        description: "The final review is ready.",
      },
    });
    expect(body).not.toHaveProperty("card_id");
    expect(body).not.toHaveProperty("author");

    // Local paths in a proposed description are allowed since the card-facing
    // privacy policy was removed 2026-08-07.
    const withPath = await proposeCardChange(task, project, {
      kind: "card_update",
      value: { description: "Open file:///Users/example/private.txt" },
    });
    const unsupported = await proposeCardChange(task, project, {
      kind: "delete_card" as "card_update",
      value: {},
    });
    expect(withPath.status).not.toBe("rejected");
    expect(unsupported.status).toBe("rejected");
    expect(outboxRows(link.id)).toHaveLength(2);
  });

  it("routes both workstream tools through the current task context", async () => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", "https://tracker.example");
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", "bridge-secret");
    const { project, task } = workstreamFixture("route");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        Response.json({ delivered: true }),
      ),
    );

    const updateResponse = await post(
      publishUpdate,
      "/api/internal/agent-tools/publish-workstream-update",
      {
        projectId: project.id,
        taskId: task.id,
        body: "The summary is ready.",
      },
    );
    const proposalResponse = await post(
      proposeChange,
      "/api/internal/agent-tools/propose-card-change",
      {
        projectId: project.id,
        taskId: task.id,
        kind: "complete_card",
        value: {},
      },
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      status: "delivered",
    });
    expect(proposalResponse.status).toBe(200);
    expect(await proposalResponse.json()).toMatchObject({
      status: "delivered",
    });
  });
});

describe("linked-task runtime guidance", () => {
  it("adds no rule for an unlinked task and no private identity for a linked task", () => {
    expect(buildWorkstreamRuntimeGuidance(false)).toBe("");
    const guidance = buildWorkstreamRuntimeGuidance(true);
    expect(guidance).toContain("publish_workstream_update");
    expect(guidance).toContain("propose_card_change");
    expect(guidance).toMatch(/team-facing/i);
    expect(guidance).not.toMatch(
      /Geo|George|Ari|Operator|Claude|Codex|card id|workstream id|project path/i,
    );
  });
});

describe("instance service token gate", () => {
  it("accepts the exact SERVICE_TOKEN and rejects the fleet token / empties", () => {
    const prev = process.env.SERVICE_TOKEN;
    const prevFleet = process.env.ORCH_FLEET_TOKEN;
    process.env.SERVICE_TOKEN = "secret-instance";
    process.env.ORCH_FLEET_TOKEN = "fleet-wide";
    try {
      expect(instanceServiceTokenOk("secret-instance")).toBe(true);
      // The read-only fleet token must NOT open the mutating endpoints.
      expect(instanceServiceTokenOk("fleet-wide")).toBe(false);
      expect(instanceServiceTokenOk("")).toBe(false);
      expect(instanceServiceTokenOk(null)).toBe(false);
    } finally {
      process.env.SERVICE_TOKEN = prev;
      process.env.ORCH_FLEET_TOKEN = prevFleet;
    }
  });
});
