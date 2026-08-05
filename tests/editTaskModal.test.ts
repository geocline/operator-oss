import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditTaskModal } from "../app/orchestrator/modals";
import type { TaskRow } from "../app/orchestrator/types";

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
  session_id: null,
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
});
