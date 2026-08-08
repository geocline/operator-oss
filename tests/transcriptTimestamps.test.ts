import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  isFirstAssistantReply,
  MessageView,
} from "@/app/orchestrator/Transcript";
import type { Msg } from "@/app/orchestrator/types";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function renderMessage(message: Msg, hideWho = false): ReactTestInstance {
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(MessageView, {
      m: message,
      initial: false,
      hideWho,
      agent: "codex",
      agentLabel: "Codex",
    }));
  });
  return renderer!.root;
}

function firstHostElementIn(instance: ReactTestInstance): ReactTestInstance {
  const child = instance.children.find(
    (candidate): candidate is ReactTestInstance =>
      typeof candidate === "object" &&
      candidate !== null &&
      "type" in candidate,
  )!;
  return typeof child.type === "string" ? child : firstHostElementIn(child);
}

describe("transcript timestamps", () => {
  const createdAt = Date.parse("2026-08-08T15:30:00Z");

  it("puts the timestamp first on user prompts and the first assistant reply", () => {
    const user = renderMessage({
      id: "u1",
      role: "user",
      content: "Please review this.",
      generation: 1,
      createdAt,
      source: "chat",
    });
    const userHeader = user.findByProps({ className: "who" });
    expect(firstHostElementIn(userHeader).type).toBe("time");

    const assistant = renderMessage({
      id: "a1",
      role: "assistant",
      content: "Here is the review.",
      generation: 1,
      createdAt,
      source: "chat",
    });
    const assistantHeader = assistant.findByProps({ className: "who" });
    expect(firstHostElementIn(assistantHeader).type).toBe("time");

    const continuation = renderMessage({
      id: "a2",
      role: "assistant",
      content: "One more detail.",
      generation: 1,
      createdAt,
      source: "chat",
    }, true);
    expect(continuation.findAllByType("time")).toHaveLength(0);
  });

  it("does not timestamp tool calls, question cards, or system notices", () => {
    const tool = renderMessage({
      id: "t1",
      role: "tool",
      content: JSON.stringify({ title: "Read report.html" }),
      generation: 1,
      createdAt,
    });
    expect(tool.findAllByType("time")).toHaveLength(0);

    const system = renderMessage({
      id: "s1",
      role: "system",
      content: "A system notice",
      generation: 1,
      createdAt,
    });
    expect(system.findAllByType("time")).toHaveLength(0);
  });

  it("finds the first assistant prose even when tool calls came first", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "Question", generation: 1 },
      { id: "t1", role: "tool", content: "Read", generation: 1 },
      { id: "t2", role: "tool", content: "Search", generation: 1 },
      { id: "a1", role: "assistant", content: "First reply", generation: 1 },
      { id: "t3", role: "tool", content: "Read", generation: 1 },
      { id: "a2", role: "assistant", content: "Continuation", generation: 1 },
    ];
    expect(isFirstAssistantReply(messages, 3)).toBe(true);
    expect(isFirstAssistantReply(messages, 5)).toBe(false);
  });
});
