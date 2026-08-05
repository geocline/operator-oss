import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const source = readFileSync(
  path.join(ROOT, "app/orchestrator/SessionView.tsx"),
  "utf8",
);
const types = readFileSync(
  path.join(ROOT, "app/orchestrator/types.ts"),
  "utf8",
);

describe("Operator linked-task controls", () => {
  it("loads the private workstream state for the current task", () => {
    expect(types).toContain("export interface WorkstreamLinkT");
    expect(source).toContain("WorkstreamTaskControls");
    expect(source).toContain("`/api/tasks/${taskId}/workstream`");
  });

  it("offers only the server-enforced workstream commands", () => {
    expect(source).toContain('"pause"');
    expect(source).toContain('"resume"');
    expect(source).toContain('"disconnect"');
    expect(source).toContain('"post-now"');
    expect(source).toContain("Post update now");
    expect(source).toContain(
      "`/api/tasks/${taskId}/workstream/${next}`",
    );
    expect(source).toMatch(
      /workstream\.state === "active" &&\s*action\("pause", "Pause updates"\)/,
    );
    expect(source).toMatch(
      /workstream\.state === "paused" &&\s*action\("resume", "Resume updates"\)/,
    );
    expect(source).toMatch(
      /workstream\.state === "paused" &&\s*action\("post-now", "Post update now"\)/,
    );
    expect(source).not.toContain(
      '? action("pause", "Pause updates")',
    );
  });

  it("shows workstream pause separately from task status", () => {
    expect(source).toContain("Updates paused");
    expect(source).toContain("Disconnected");
    expect(source).not.toContain('onSetStatus("on_hold")');
  });

  it("periodically refreshes remote workstream state", () => {
    expect(source).toContain("setInterval(refresh, 15_000)");
    expect(types).toContain('"activating"');
  });
});
