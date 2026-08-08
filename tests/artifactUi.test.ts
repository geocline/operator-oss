import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("global artifact library UI", () => {
  it("provides recent artifacts, search, copying, and task provenance", () => {
    const library = source("app/artifacts/ArtifactLibrary.tsx");
    expect(library).toContain("/api/artifacts");
    expect(library).toContain("Search artifacts");
    expect(library).toContain("Copy link");
    expect(library).toContain("project_id");
    expect(library).toContain("task_id");
    expect(library).toContain("<time");
  });

  it("adds a global Artifacts destination and a sandboxed detail preview", () => {
    const projects = source("app/orchestrator/ProjectsColumn.tsx");
    const detail = source("app/artifacts/[id]/page.tsx");
    const css = source("app/globals.css");
    expect(projects).toContain('href="/artifacts"');
    expect(detail).toContain("sandbox");
    expect(detail).toContain("/content");
    expect(detail).toContain("Download");
    expect(css).toContain(".artifact-grid");
    expect(css).toContain("@media(max-width:680px)");
  });
});
