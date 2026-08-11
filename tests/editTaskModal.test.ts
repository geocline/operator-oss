import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditTaskModal } from "../app/orchestrator/modals";
import type { AgentsBundle, TaskRow } from "../app/orchestrator/types";
import { CLAUDE_CAPABILITIES } from "../lib/agents/claude/capabilities";

const task: TaskRow = {
  id: "task-1",
  project_id: "project-1",
  title: "Original title",
  description: "Original description",
  priority: "med",
  status: "not_started",
  suggested: 0,
  agent: "claude",
  model: null,
  resolved_model: null,
  reasoning: null,
  permission_mode: null,
  workspace_mode: "direct",
  launch_config_required: 0,
  launch_config_confirmed_at: 0,
  session_id: null,
  worktree_path: "",
  pr_url: "",
  generation: 1,
  started: 0,
  running: 0,
  awaiting_input: 0,
  updated_at: 1,
  cost_usd: 0,
  total_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  depends_on: [],
  context_tokens: 0,
  context_pct: 0,
  note_count: 0,
};

const agents: AgentsBundle = {
  default: "claude",
  agents: [
    {
      id: "claude",
      label: "Claude Code",
      authenticated: true,
      capabilities: CLAUDE_CAPABILITIES,
    },
    {
      id: "codex",
      label: "Codex",
      authenticated: true,
      capabilities: {
        ...CLAUDE_CAPABILITIES,
        models: [
          {
            value: "gpt-test",
            label: "GPT Test",
            sub: "test model",
            contextWindow: 200_000,
          },
        ],
      },
    },
  ],
};

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => typeof child === "string" ? child : textOf(child))
    .join("");
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.findAllByType("button").find((node) =>
    textOf(node).includes(label),
  )!;
}

describe("EditTaskModal save feedback", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves edits after a failed save and closes after a successful retry", async () => {
    let rejectSave!: (cause: Error) => void;
    const onSave = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    }));
    const onClose = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(React.createElement(EditTaskModal, {
        task,
        tasks: [task],
        onClose,
        onSave,
        onDelete: vi.fn(),
      }));
    });

    const title = renderer.root.findByProps({
      placeholder: "e.g. Add rate-limiting to auth endpoints",
    });
    const description = renderer.root.findByProps({
      placeholder: "Describe the feature or task. This is the body of the prompt the agent starts with.",
    });

    await act(async () => {
      title.props.onChange({ target: { value: "Updated title" } });
      description.props.onChange({ target: { value: "Updated description" } });
    });
    await act(async () => {
      button(renderer, "Save changes").props.onClick();
      await Promise.resolve();
    });

    expect(textOf(button(renderer, "Saving…"))).toContain("Saving…");
    expect(button(renderer, "Saving…").props.disabled).toBe(true);

    await act(async () => {
      rejectSave(new Error("The save request timed out. Try again."));
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      placeholder: "e.g. Add rate-limiting to auth endpoints",
    }).props.value).toBe("Updated title");
    expect(renderer.root.findByProps({
      placeholder: "Describe the feature or task. This is the body of the prompt the agent starts with.",
    }).props.value).toBe("Updated description");
    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toContain(
      "The save request timed out. Try again.",
    );
    expect(button(renderer, "Save changes").props.disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    onSave.mockImplementationOnce(async () => {});
    await act(async () => {
      button(renderer, "Save changes").props.onClick();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("suggests and explicitly confirms Harness, Model, and Thinking strength", async () => {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    let renderer!: ReactTestRenderer;
    const suggestedTask: TaskRow = {
      ...task,
      suggested: 1,
      launch_config_required: 1,
    };

    await act(async () => {
      renderer = create(React.createElement(EditTaskModal, {
        task: suggestedTask,
        tasks: [suggestedTask],
        agents,
        appDefaults: {},
        onClose,
        onSave,
        onDelete: vi.fn(),
      }));
    });

    expect(renderer.root.findByProps({ "aria-label": "Harness" }).props.value).toBe(
      "claude",
    );
    expect(renderer.root.findByProps({ "aria-label": "Model" }).props.value).toBe(
      "fable",
    );
    expect(
      renderer.root.findByProps({ "aria-label": "Thinking strength" }).props
        .value,
    ).toBe("think");

    await act(async () => {
      button(renderer, "Confirm setup").props.onClick();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledWith(
      suggestedTask.id,
      expect.objectContaining({
        agent: "claude",
        model: "fable",
        reasoning: "think",
        confirm_launch_config: true,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows independent Workspace and Agent access controls before start", async () => {
    const onSave = vi.fn(async () => {});
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(React.createElement(EditTaskModal, {
        task,
        tasks: [task],
        agents,
        projectRepoPath: "/Users/geo/code/operator",
        onClose: vi.fn(),
        onSave,
        onDelete: vi.fn(),
      }));
    });

    const workspace = renderer.root.findByProps({ "aria-label": "Workspace" });
    const access = renderer.root.findByProps({ "aria-label": "Agent access" });
    expect(workspace.props.value).toBe("direct");
    expect(access.props.value).toBe("bypassPermissions");
    expect(textOf(renderer.root)).toContain(
      "Runs directly in /Users/geo/code/operator with unrestricted harness permissions.",
    );

    await act(async () => {
      workspace.props.onChange({ target: { value: "worktree" } });
      access.props.onChange({ target: { value: "plan" } });
    });
    await act(async () => {
      button(renderer, "Save changes").props.onClick();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        workspace_mode: "worktree",
        permission_mode: "plan",
      }),
    );
  });

  it("locks Workspace after start but keeps Agent access editable", async () => {
    const onSave = vi.fn(async () => {});
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(EditTaskModal, {
        task: { ...task, started: 1 },
        tasks: [{ ...task, started: 1 }],
        agents,
        projectRepoPath: "/Users/geo/code/operator",
        onClose: vi.fn(),
        onSave,
        onDelete: vi.fn(),
      }));
    });

    expect(renderer.root.findByProps({ "aria-label": "Workspace" }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ "aria-label": "Agent access" }).props.disabled).not.toBe(true);
    await act(async () => {
      button(renderer, "Save changes").props.onClick();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith(
      task.id,
      expect.not.objectContaining({ workspace_mode: expect.anything() }),
    );
  });
});
