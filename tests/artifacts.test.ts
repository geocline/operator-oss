import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createProject, createTask } from "@/lib/store";
import {
  artifactPath,
  getArtifact,
  listArtifacts,
  publishArtifact,
} from "@/lib/artifacts";
import { tmpDir, writeFile } from "./helpers";

describe("artifact storage", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM projects").run();
    getDb().prepare("DELETE FROM artifacts").run();
  });

  function fixture() {
    const repo = tmpDir("artifact-workspace-");
    const project = createProject({
      name: "Ardent",
      repo_path: repo,
      branch: "main",
    });
    const task = createTask({
      project_id: project.id,
      title: "Lease review",
      description: "Prepare the report",
    });
    return { repo, project, task };
  }

  it("copies a published HTML file into durable Operator storage with provenance", () => {
    const { repo, project, task } = fixture();
    writeFile(repo, "reports/lease.html", "<!doctype html><h1>Lease</h1>");

    const artifact = publishArtifact({
      project,
      task,
      sourcePath: "reports/lease.html",
      title: "Lease Analysis",
    });

    expect(artifact.title).toBe("Lease Analysis");
    expect(artifact.filename).toBe("lease.html");
    expect(artifact.content_type).toBe("text/html; charset=utf-8");
    expect(artifact.project_id).toBe(project.id);
    expect(artifact.task_id).toBe(task.id);
    expect(fs.readFileSync(artifactPath(artifact), "utf8")).toContain("<h1>Lease</h1>");

    fs.rmSync(path.join(repo, "reports/lease.html"));
    expect(fs.readFileSync(artifactPath(getArtifact(artifact.id)!), "utf8")).toContain("Lease");

    const listed = listArtifacts();
    expect(listed[0]).toMatchObject({
      id: artifact.id,
      project_name: "Ardent",
      task_title: "Lease review",
    });
  });

  it("rejects traversal and symlink escapes outside the task workspace", () => {
    const { repo, project, task } = fixture();
    const outside = tmpDir("artifact-outside-");
    writeFile(outside, "secret.html", "<h1>outside</h1>");
    fs.symlinkSync(path.join(outside, "secret.html"), path.join(repo, "escape.html"));

    expect(() =>
      publishArtifact({ project, task, sourcePath: "../secret.html" }),
    ).toThrow(/inside the current task workspace/i);
    expect(() =>
      publishArtifact({ project, task, sourcePath: "escape.html" }),
    ).toThrow(/inside the current task workspace/i);
  });
});
