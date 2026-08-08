import { describe, expect, it } from "vitest";
import { buildProjectContext } from "@/lib/agents/shared";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";

describe("isolated task workspace guidance", () => {
  it("tells agents which checkout is writable and how changes reach the project", () => {
    const project = createProject({
      name: "Recipes",
      repo_path: "/projects/recipe-pwa",
    });
    const task = createTask({
      project_id: project.id,
      title: "Repair imports",
      description: "",
    });
    updateTask(task.id, {
      worktree_path: "/worktrees/recipe-import",
      work_branch: "orch/recipe-import",
    });

    const context = buildProjectContext(project, getTask(task.id)!);

    expect(context).toContain("isolated task workspace");
    expect(context).toContain("/worktrees/recipe-import");
    expect(context).toContain("/projects/recipe-pwa");
    expect(context).toContain("Changes tab");
    expect(context).toContain("Do not describe the task workspace as the wrong folder");
  });

  it("does not claim direct-repo tasks are isolated", () => {
    const project = createProject({
      name: "Greenfield",
      repo_path: "/projects/greenfield",
    });
    const task = createTask({
      project_id: project.id,
      title: "Start",
      description: "",
    });

    const context = buildProjectContext(project, task);

    expect(context).not.toContain("isolated task workspace");
    expect(context).not.toContain("Changes tab");
  });
});
