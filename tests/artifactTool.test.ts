import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { publishTaskArtifact } from "@/lib/artifactTool";
import { createProject, createTask } from "@/lib/store";
import { POST } from "@/app/api/internal/agent-tools/publish-artifact/route";

function fixture(label: string) {
  const repo = fs.mkdtempSync(
    path.join(process.env.ORCH_TEST_TMP!, `publish-artifact-${label}-`),
  );
  const project = createProject({ name: `Artifact ${label}`, repo_path: repo });
  const task = createTask({ project_id: project.id, title: `${label} task` });
  fs.writeFileSync(path.join(repo, "report.html"), "<h1>Report</h1>");
  return { repo, project, task };
}

describe("publish_artifact agent tool", () => {
  it("publishes a task-scoped file and returns stable artifact links", () => {
    const { project, task } = fixture("shared");

    const result = publishTaskArtifact(task, project, {
      path: "report.html",
      title: "Quarterly Report",
    });

    expect(result.status).toBe("published");
    expect(result.title).toBe("Quarterly Report");
    expect(result.url).toMatch(/\/artifacts\/[^/]+$/);
    expect(result.libraryUrl).toMatch(/\/artifacts$/);
    expect(result.text).toContain(result.url);
  });

  it("routes portable harness calls through task and project scope", async () => {
    const { project, task } = fixture("endpoint");
    const response = await POST(
      new NextRequest(
        "http://127.0.0.1:3000/api/internal/agent-tools/publish-artifact",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: project.id,
            taskId: task.id,
            path: "report.html",
            title: "Endpoint Report",
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "published",
      title: "Endpoint Report",
    });
  });

  it("keeps Claude and portable MCP schemas in lockstep", () => {
    const defs = fs.readFileSync(
      path.join(process.cwd(), "lib/agentToolDefs.mjs"),
      "utf8",
    );
    const claude = fs.readFileSync(
      path.join(process.cwd(), "lib/agents/claude/driver.ts"),
      "utf8",
    );
    const bridge = fs.readFileSync(
      path.join(process.cwd(), "scripts/orch-mcp.mjs"),
      "utf8",
    );
    expect(defs).toContain('name: "publish_artifact"');
    expect(claude).toContain("PUBLISH_ARTIFACT");
    expect(bridge).toContain("PUBLISH_ARTIFACT");
    expect(bridge).toContain('callInternal("publish-artifact"');
  });
});
