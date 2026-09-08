import { describe, expect, it } from "vitest";
import { createProject, createTask, getTaskVisual, upsertTaskVisual } from "../lib/store";

function makeTask() {
  const project = createProject({ name: `Visual ${Date.now()} ${Math.random()}` });
  return createTask({ project_id: project.id, title: "Visual task" });
}

describe("task visuals", () => {
  it("returns undefined when a task has no visual override", () => {
    const task = makeTask();
    expect(getTaskVisual(task.id)).toBeUndefined();
  });

  it("upserts a display_name and avatar", () => {
    const task = makeTask();
    const visual = upsertTaskVisual(task.id, {
      display_name: "  Alice  ",
      avatar: { skin: "a", hair: "b" },
    });
    expect(visual.display_name).toBe("Alice");
    expect(JSON.parse(visual.avatar)).toEqual({ skin: "a", hair: "b" });

    const reread = getTaskVisual(task.id);
    expect(reread?.display_name).toBe("Alice");
  });

  it("updates only the fields provided, leaving others in place", () => {
    const task = makeTask();
    upsertTaskVisual(task.id, { display_name: "Bob", avatar: { skin: "z" } });
    const updated = upsertTaskVisual(task.id, { display_name: "Bobby" });
    expect(updated.display_name).toBe("Bobby");
    expect(JSON.parse(updated.avatar)).toEqual({ skin: "z" });
  });

  it("clears the avatar back to unset when patched with null", () => {
    const task = makeTask();
    upsertTaskVisual(task.id, { avatar: { skin: "z" } });
    const cleared = upsertTaskVisual(task.id, { avatar: null });
    expect(cleared.avatar).toBe("");
  });

  it("rejects a display_name over 24 characters", () => {
    const task = makeTask();
    expect(() =>
      upsertTaskVisual(task.id, { display_name: "a".repeat(25) }),
    ).toThrow();
  });

  it("rejects a non-object avatar", () => {
    const task = makeTask();
    expect(() =>
      upsertTaskVisual(task.id, { avatar: "not-an-object" as unknown as Record<string, unknown> }),
    ).toThrow();
    expect(() =>
      upsertTaskVisual(task.id, { avatar: ["array"] as unknown as Record<string, unknown> }),
    ).toThrow();
  });

  it("rejects an avatar that serializes over 2KB", () => {
    const task = makeTask();
    const big = { blob: "x".repeat(3000) };
    expect(() => upsertTaskVisual(task.id, { avatar: big })).toThrow();
  });

  it("fails for an unknown task id (foreign key)", () => {
    expect(() => upsertTaskVisual("does-not-exist", { display_name: "X" })).toThrow();
  });
});
