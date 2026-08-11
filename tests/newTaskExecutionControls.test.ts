import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskModal } from "../app/orchestrator/modals";
import type { AgentsBundle, ProjectRow } from "../app/orchestrator/types";
import { CLAUDE_CAPABILITIES } from "../lib/agents/claude/capabilities";

const project: ProjectRow = {
  id: "project-1",
  name: "Operator",
  icon: "",
  sub: "",
  color: "#000000",
  context: "",
  repo_path: "/Users/geo/Claude Projects/operator",
  branch: "main",
  dev_command: "",
  setup_command: "",
  test_command: "",
  default_agent: "claude",
  run_in_repo: 0,
  port: 4300,
  deprecated: 0,
  seeded: 0,
  task_count: 0,
  last_activity: 0,
  awaiting_count: 0,
  cost_usd: 0,
};

const agents: AgentsBundle = {
  default: "claude",
  agents: [{
    id: "claude",
    label: "Claude Code",
    authenticated: true,
    capabilities: CLAUDE_CAPABILITIES,
  }],
};

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => typeof child === "string" ? child : textOf(child))
    .join("");
}

describe("NewTaskModal execution controls", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows Harness → Model → Strength before execution controls and submits the resolved model", async () => {
    const onCreate = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(NewTaskModal, {
        project,
        agents,
        tasks: [],
        onClose: vi.fn(),
        onCreate,
      }));
    });

    const workspace = renderer.root.findByProps({ "aria-label": "Workspace" });
    const access = renderer.root.findByProps({ "aria-label": "Agent access" });
    const harness = renderer.root.findByProps({ "aria-label": "Harness" });
    const model = renderer.root.findByProps({ "aria-label": "Model" });
    const strength = renderer.root.findByProps({ "aria-label": "Thinking strength" });
    expect(harness.props.value).toBe("claude");
    expect(model.props.value).toBe("fable");
    expect(strength.props.value).toBe("think");
    expect(workspace.props.value).toBe("direct");
    expect(access.props.value).toBe("bypassPermissions");
    expect(textOf(renderer.root)).toContain(
      "Runs directly in /Users/geo/Claude Projects/operator with unrestricted harness permissions.",
    );

    await act(async () => {
      renderer.root.findByProps({
        placeholder: "e.g. Add rate-limiting to auth endpoints",
      }).props.onChange({ target: { value: "Build the thing" } });
      workspace.props.onChange({ target: { value: "worktree" } });
      access.props.onChange({ target: { value: "plan" } });
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((node) =>
        textOf(node).includes("Create task"),
      )!.props.onClick();
    });

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: "Build the thing",
      agent: "claude",
      model: "fable",
      reasoning: "think",
      workspace_mode: "worktree",
      permission_mode: "plan",
    }));
  });

  // Without this the pickers always open on the harness's first model (its most
  // capable and most expensive) and auto-run, and Settings → Run defaults is
  // decoration — a task row now always stores explicit controls, so nothing
  // downstream can apply them later.
  it("opens on the app-level run defaults when they are set", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(NewTaskModal, {
        project,
        agents,
        tasks: [],
        appDefaults: {
          "default_model:claude": "sonnet",
          "default_reasoning:claude": "think_hard",
          default_permission_mode: "plan",
        },
        onClose: vi.fn(),
        onCreate: vi.fn(),
      }));
    });

    expect(renderer.root.findByProps({ "aria-label": "Model" }).props.value).toBe("sonnet");
    expect(renderer.root.findByProps({ "aria-label": "Thinking strength" }).props.value).toBe("think_hard");
    expect(renderer.root.findByProps({ "aria-label": "Agent access" }).props.value).toBe("plan");
  });

  it("ignores a default model the harness no longer offers", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(NewTaskModal, {
        project,
        agents,
        tasks: [],
        appDefaults: { "default_model:claude": "retired-model" },
        onClose: vi.fn(),
        onCreate: vi.fn(),
      }));
    });

    expect(renderer.root.findByProps({ "aria-label": "Model" }).props.value).toBe("fable");
  });
});
