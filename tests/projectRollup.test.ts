import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsColumn } from "@/app/orchestrator/ProjectsColumn";
import type { ProjectRow } from "@/app/orchestrator/types";

function project(patch: Partial<ProjectRow>): ProjectRow {
  return {
    id: "p1",
    name: "Operator",
    icon: "",
    sub: "",
    color: "#4d8cff",
    context: "",
    repo_path: "/repo",
    branch: "main",
    dev_command: "",
    setup_command: "",
    test_command: "",
    default_agent: "claude",
    run_in_repo: 0,
    port: 4300,
    deprecated: 0,
    seeded: 0,
    task_count: 3,
    last_activity: Date.now(),
    awaiting_count: 0,
    cost_usd: 0,
    ...patch,
  };
}

function findByClass(root: ReactTestInstance, cls: string): ReactTestInstance[] {
  return root.findAll((n) => typeof n.props.className === "string" && n.props.className.split(/\s+/).includes(cls));
}

async function renderColumn(projects: ProjectRow[], running: Set<string>) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      React.createElement(ProjectsColumn, {
        projects,
        deprecated: [],
        agents: [],
        selId: null,
        running,
        width: 236,
        onSelect: vi.fn(),
        onNew: vi.fn(),
        onOpenAppearance: vi.fn(),
        onReorder: vi.fn(),
        onRestore: vi.fn(),
        onCollapse: vi.fn(),
        settingsActive: false,
        onOpenSettings: vi.fn(),
      }),
    );
  });
  return renderer;
}

describe("ProjectsColumn rollup", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows a running dot for a project with a live task and no awaiting tasks", async () => {
    const renderer = await renderColumn([project({ id: "running-proj", awaiting_count: 0 })], new Set(["running-proj"]));
    expect(findByClass(renderer.root, "proj-running")).toHaveLength(1);
    expect(findByClass(renderer.root, "proj-await")).toHaveLength(0);
  });

  it("the awaiting badge wins over the running dot when both are true", async () => {
    const renderer = await renderColumn([project({ id: "both-proj", awaiting_count: 2 })], new Set(["both-proj"]));
    expect(findByClass(renderer.root, "proj-await")).toHaveLength(1);
    expect(findByClass(renderer.root, "proj-running")).toHaveLength(0);
  });

  it("renders neither dot for an idle project", async () => {
    const renderer = await renderColumn([project({ id: "idle-proj", awaiting_count: 0 })], new Set());
    expect(findByClass(renderer.root, "proj-await")).toHaveLength(0);
    expect(findByClass(renderer.root, "proj-running")).toHaveLength(0);
  });

  it("a collapsed/unselected project never hides a waiting task behind the running dot", async () => {
    // Same scenario as "awaiting wins", phrased as the spec's guarantee: a
    // project row can always be trusted to surface "needs you" over "busy".
    const renderer = await renderColumn(
      [project({ id: "watched", awaiting_count: 1 })],
      new Set(["watched"]),
    );
    expect(findByClass(renderer.root, "proj-await")).toHaveLength(1);
  });
});
