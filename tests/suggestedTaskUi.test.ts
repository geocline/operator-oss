import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskBoard } from "@/app/orchestrator/TaskBoard";
import type { AgentsBundle, TaskRow } from "@/app/orchestrator/types";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";

const agents: AgentsBundle = {
  default: "claude",
  agents: [
    {
      id: "claude",
      label: "Claude Code",
      authenticated: true,
      capabilities: CLAUDE_CAPABILITIES,
    },
  ],
};

const suggested: TaskRow = {
  id: "suggested-1",
  project_id: "project-1",
  title: "Agent follow-up",
  description: "Finish the follow-up",
  priority: "med",
  status: "not_started",
  suggested: 1,
  agent: "claude",
  model: null,
  resolved_model: null,
  reasoning: null,
  permission_mode: null,
  launch_config_required: 1,
  launch_config_confirmed_at: 0,
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
  note_count: 0,
  context_pct: 0,
};

function text(node: { children: unknown[] }): string {
  return node.children
    .map((child) =>
      typeof child === "string"
        ? child
        : child && typeof child === "object" && "children" in child
          ? text(child as { children: unknown[] })
          : "",
    )
    .join("");
}

async function renderBoard(task: TaskRow, agentBundle = agents) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      React.createElement(TaskBoard, {
        tasks: [],
        suggested: [task],
        agents: agentBundle,
        selTaskId: null,
        running: new Set<string>(),
        blockedBy: new Map<string, string[]>(),
        canDrag: true,
        onSelect: vi.fn(),
        onEditTask: vi.fn(),
        onMove: vi.fn(),
        onStartSuggestion: vi.fn(),
        onAcceptSuggestion: vi.fn(),
        onDismissSuggestion: vi.fn(),
      }),
    );
  });
  return renderer;
}

describe("suggested task launch setup UI", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Review setup instead of Start until configuration is confirmed", async () => {
    const renderer = await renderBoard(suggested);
    const labels = renderer.root
      .findAllByType("button")
      .map((button) => text(button).trim());

    expect(labels).toContain("Review setup");
    expect(labels).not.toContain("Start");
  });

  it("shows the confirmed setup summary and enables Start", async () => {
    const renderer = await renderBoard({
      ...suggested,
      model: "fable",
      reasoning: "think",
      launch_config_confirmed_at: 123,
    });
    const labels = renderer.root
      .findAllByType("button")
      .map((button) => text(button).trim());

    expect(labels).toContain("Start");
    expect(text(renderer.root)).toContain("Claude Code · Fable 5 · Think");
  });

  it("keeps Start disabled when the confirmed harness is not connected", async () => {
    const renderer = await renderBoard(
      {
        ...suggested,
        model: "fable",
        reasoning: "think",
        launch_config_confirmed_at: 123,
      },
      {
        ...agents,
        agents: agents.agents.map((agent) => ({
          ...agent,
          authenticated: false,
        })),
      },
    );
    const start = renderer.root
      .findAllByType("button")
      .find((button) => text(button).trim() === "Start");

    expect(start?.props.disabled).toBe(true);
  });

  it("returns to Review setup when a confirmed model is no longer available", async () => {
    const renderer = await renderBoard({
      ...suggested,
      model: "removed-model",
      reasoning: "think",
      launch_config_confirmed_at: 123,
    });
    const labels = renderer.root
      .findAllByType("button")
      .map((button) => text(button).trim());

    expect(labels).toContain("Review setup");
    expect(labels).not.toContain("Start");
  });
});
