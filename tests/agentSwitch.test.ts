// Switching which agent a task runs on, from the session header's agent picker.
//
// There are two paths on purpose, and the split is the whole design:
//
//   no session yet  → PATCH /api/tasks/[id] { agent }   (a plain column write)
//   session exists  → POST  /api/tasks/[id]/clear { agent }  (summarize, then
//                     continue in the same worktree on the new driver)
//
// The PATCH path must REFUSE the second case. tasks.session_id holds an opaque
// id minted by whichever driver created it, so flipping tasks.agent underneath a
// live session would hand Codex a Claude session id (or the reverse) and the
// next turn would resume against a thread its CLI has never heard of.
//
// Also pinned here: the run knobs reset on a switch (model aliases are per-CLI
// vocabularies — "opus" means nothing to codex), unknown agent ids are rejected
// rather than silently resolved to the default, and the SDK-free id map behind
// the route's validation stays in step with the driver registry.
import { describe, it, expect } from "vitest";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { isKnownAgent, knownAgentIds } from "@/lib/agents/capabilities";
import { listDrivers } from "@/lib/agents/registry";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const patch = (id: string, body: unknown) =>
  patchTask(
    new Request(`http://test/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(id),
  );

describe("switching a task's agent", () => {
  it("moves a not-started task to another agent and resets the per-CLI run knobs", async () => {
    const project = createProject({ name: "Switch" });
    const task = createTask({ project_id: project.id, title: "Move me", agent: "claude" });
    // Knobs chosen while it was a Claude task — none of them mean anything to codex.
    updateTask(task.id, {
      model: "opus",
      reasoning: "ultrathink",
      permission_mode: "acceptEdits",
      resolved_model: "claude-opus-5",
    });

    const res = await patch(task.id, { agent: "codex" });
    expect(res.status).toBe(200);

    const after = getTask(task.id)!;
    expect(after.agent).toBe("codex");
    expect(after.model).toBeNull();
    expect(after.reasoning).toBeNull();
    expect(after.permission_mode).toBeNull();
    expect(after.resolved_model).toBeNull();
  });

  it("refuses to switch a task that already has a session, and leaves the row untouched", async () => {
    const project = createProject({ name: "Started" });
    const task = createTask({ project_id: project.id, title: "Running already", agent: "claude" });
    updateTask(task.id, { started: 1, session_id: "claude-session-abc", model: "opus" });

    const res = await patch(task.id, { agent: "codex" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/hand it off/i);

    const after = getTask(task.id)!;
    expect(after.agent).toBe("claude");
    expect(after.session_id).toBe("claude-session-abc");
    expect(after.model).toBe("opus");
  });

  it("refuses on a session id alone, even when started was never set", async () => {
    // The two markers are set at different points in the turn lifecycle; either
    // one on its own means a driver-owned session exists.
    const project = createProject({ name: "SessionOnly" });
    const task = createTask({ project_id: project.id, title: "Has a thread", agent: "claude" });
    updateTask(task.id, { session_id: "thread-42" });

    expect((await patch(task.id, { agent: "codex" })).status).toBe(409);
    expect(getTask(task.id)!.agent).toBe("claude");
  });

  it("rejects an unknown agent id instead of falling back to the default driver", async () => {
    const project = createProject({ name: "Bogus" });
    const task = createTask({ project_id: project.id, title: "Typo", agent: "codex" });

    const res = await patch(task.id, { agent: "cluade" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown agent/i);
    // The forgiving getDriver() fallback would have rewritten this to "claude".
    expect(getTask(task.id)!.agent).toBe("codex");
  });

  it("rejects a non-string agent", async () => {
    const project = createProject({ name: "Shape" });
    const task = createTask({ project_id: project.id, title: "Wrong type", agent: "claude" });

    expect((await patch(task.id, { agent: 7 })).status).toBe(400);
    expect((await patch(task.id, { agent: null })).status).toBe(400);
    expect(getTask(task.id)!.agent).toBe("claude");
  });

  it("lets a started task re-send its current agent without tripping the guard", async () => {
    // The picker sends the id it rendered; a click on the already-current row
    // must not read as an illegal mid-session switch.
    const project = createProject({ name: "NoOp" });
    const task = createTask({ project_id: project.id, title: "Same agent", agent: "claude" });
    updateTask(task.id, { started: 1, session_id: "s-1", model: "opus" });

    const res = await patch(task.id, { agent: "claude" });
    expect(res.status).toBe(200);
    // A no-op switch must not clear the knobs the way a real switch does.
    expect(getTask(task.id)!.model).toBe("opus");
  });

  it("announces the switch on the global bus so other tabs re-render the agent", async () => {
    const project = createProject({ name: "Fanout" });
    const task = createTask({ project_id: project.id, title: "Broadcast", agent: "claude" });

    const seen: BusEvent[] = [];
    const unsub = subscribeGlobal((tid, ev) => { if (tid === task.id) seen.push(ev); });
    try {
      await patch(task.id, { agent: "codex" });
    } finally {
      unsub();
    }
    expect(seen.map((e) => e.type)).toContain("task_updated");
  });

  it("leaves title and description edits alone when no agent is sent", async () => {
    // The same route serves the edit modal; adding agent handling must not
    // disturb the ordinary save path.
    const project = createProject({ name: "Untouched" });
    const task = createTask({ project_id: project.id, title: "Before", agent: "codex" });

    const res = await patch(task.id, { title: "After", description: "New body" });
    expect(res.status).toBe(200);
    const after = getTask(task.id)!;
    expect(after.title).toBe("After");
    expect(after.description).toBe("New body");
    expect(after.agent).toBe("codex");
  });
});

describe("the SDK-free agent id map", () => {
  // The task route validates against lib/agents/capabilities.ts rather than the
  // registry, to keep the agent SDKs out of its module graph (see
  // tests/importGraph.test.ts). That only stays correct while the two agree.
  it("holds exactly the ids the driver registry resolves", () => {
    expect(knownAgentIds().sort()).toEqual(listDrivers().map((d) => d.id).sort());
  });

  it("is strict where getDriver is forgiving", () => {
    expect(isKnownAgent("claude")).toBe(true);
    expect(isKnownAgent("codex")).toBe(true);
    expect(isKnownAgent("gemini")).toBe(false);
    expect(isKnownAgent("")).toBe(false);
    expect(isKnownAgent(null)).toBe(false);
    expect(isKnownAgent(undefined)).toBe(false);
  });
});
