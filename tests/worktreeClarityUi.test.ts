import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("Changes workspace clarity", () => {
  it("returns both checkout paths and the project dirty preflight", () => {
    const route = source("app/api/tasks/[id]/diff/route.ts");

    expect(route).toContain("projectCheckoutDirty");
    expect(route).toContain("workspacePath: task.worktree_path");
    expect(route).toContain("projectPath: project.repo_path");
    expect(route).toContain("projectDirty");
  });

  it("labels both paths and warns before a dirty-project merge", () => {
    const component = source("app/TaskChanges.tsx");

    expect(component).toContain("Task workspace");
    expect(component).toContain("Project checkout");
    expect(component).toContain("Merge blocked");
    expect(component).toContain("data.projectDirty");
    expect(component).toContain("disabled={merging || resolving || loading || data.projectDirty}");
    expect(component).toContain("disabled={merging || prBusy || loading || data.projectDirty}");
  });

  it("enforces the dirty-project preflight in every landing endpoint", () => {
    for (const [file, mutation] of [
      ["app/api/tasks/[id]/merge/route.ts", "mergeTask({"],
      ["app/api/tasks/[id]/merge/prepare/route.ts", "prepareWorktreeMerge({"],
      ["app/api/tasks/[id]/merge/complete/route.ts", "completeWorktreeMerge({"],
    ]) {
      const route = source(file);

      expect(route).toContain("projectCheckoutDirty");
      expect(route).toContain("project checkout has uncommitted files");
      expect(route.indexOf("projectCheckoutDirty(project.repo_path)")).toBeLessThan(
        route.indexOf(mutation)
      );
    }
  });
});
