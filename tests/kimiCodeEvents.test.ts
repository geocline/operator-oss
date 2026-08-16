import { describe, expect, it } from "vitest";
import {
  mapKimiCodeEvent,
  newKimiCodeState,
} from "@/lib/agents/kimi-code/events";
import type { StreamEvent as KimiStreamEvent } from "@moonshot-ai/kimi-agent-sdk";

function map(event: KimiStreamEvent) {
  const state = newKimiCodeState();
  return { out: mapKimiCodeEvent(event, state), state };
}

describe("Kimi Code SDK event normalization", () => {
  it("maps text and keeps thinking out of the assistant transcript", () => {
    expect(map({
      type: "ContentPart",
      payload: { type: "text", text: "done" },
    }).out).toEqual([{ type: "assistant", content: "done" }]);
    const thinking = map({
      type: "ContentPart",
      payload: { type: "think", think: "private chain" },
    });
    expect(thinking.out).toEqual([]);
    expect(thinking.state.thinkingParts).toBe(1);
  });

  it("pairs valid tool calls and results", () => {
    const state = newKimiCodeState();
    const call = mapKimiCodeEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "call-1",
        function: {
          name: "ReadFile",
          arguments: '{"path":"fixture.txt"}',
        },
      },
    }, state);
    const result = mapKimiCodeEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "call-1",
        return_value: {
          is_error: false,
          output: "seed",
          message: "read",
          display: [{ type: "brief", text: "read fixture" }],
        },
      },
    }, state);

    expect(call[0]).toMatchObject({
      type: "tool",
      id: "call-1",
      title: "📖 Read fixture.txt",
      detail: "fixture.txt",
    });
    expect(result[0]).toMatchObject({
      type: "tool_result",
      id: "call-1",
      content: "seed",
      isError: false,
    });
    expect(state.malformedEvents).toEqual([]);
  });

  it.each([
    ["WriteFile", '{"path":"created.txt","content":"new\\n"}', /Write created\.txt/],
    [
      "StrReplaceFile",
      '{"path":"result.txt","edit":{"old":"PENDING","new":"DONE"}}',
      /Edit result\.txt/,
    ],
    ["Shell", '{"command":"npm test"}', /npm test/],
  ])("normalizes the official Wire CLI %s tool", (name, args, title) => {
    const state = newKimiCodeState();
    const out = mapKimiCodeEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: `call-${name}`,
        function: { name, arguments: args },
      },
    }, state);

    expect(out[0]).toMatchObject({
      type: "tool",
      title: expect.stringMatching(title),
    });
  });

  it.each([
    ["Shell", "{}"],
    ["SetTodoList", "{}"],
    ["Agent", "{}"],
  ])("never throws when %s arrives with an empty argument object", (name, args) => {
    // A clip(undefined) TypeError on argument-less describe paths killed
    // whole live turns on 2026-08-16 (kimi-k3 and deepseek-v4-pro admission
    // runs: "Cannot read properties of undefined (reading 'length')") - the
    // mapper must degrade, not crash.
    const state = newKimiCodeState();
    const out = mapKimiCodeEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: `call-empty-${name}`,
        function: { name, arguments: args },
      },
    }, state);
    expect(out[0]).toMatchObject({ type: "tool" });
  });

  it("defers a ToolCall with streamed arguments and flushes it with the accumulated JSON", () => {
    // The Wire CLI may emit ToolCall with no argument bytes and stream the
    // JSON via ToolCallPart deltas (parts carry no id - one call streams at a
    // time). The tool event must carry the real arguments, not an empty
    // object with a blank title.
    const state = newKimiCodeState();
    const call = mapKimiCodeEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "call-stream",
        function: { name: "Shell", arguments: "" },
      },
    }, state);
    expect(call).toEqual([]);
    expect(mapKimiCodeEvent({
      type: "ToolCallPart",
      payload: { arguments_part: '{"command":"npm' },
    }, state)).toEqual([]);
    expect(mapKimiCodeEvent({
      type: "ToolCallPart",
      payload: { arguments_part: ' test"}' },
    }, state)).toEqual([]);
    const result = mapKimiCodeEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "call-stream",
        return_value: { is_error: false, output: "ok", message: "ran", display: [] },
      },
    }, state);
    expect(result[0]).toMatchObject({
      type: "tool",
      id: "call-stream",
      title: expect.stringMatching(/npm test/),
    });
    expect(result[1]).toMatchObject({
      type: "tool_result",
      id: "call-stream",
      isError: false,
    });
    expect(state.malformedEvents).toEqual([]);
    expect(state.pendingCall).toBeNull();
  });

  it("fails closed on malformed arguments, duplicate calls, and orphan results", () => {
    const state = newKimiCodeState();
    mapKimiCodeEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "dup",
        function: { name: "Bash", arguments: "{" },
      },
    }, state);
    mapKimiCodeEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "dup",
        function: { name: "Bash", arguments: "{}" },
      },
    }, state);
    const orphan = mapKimiCodeEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "missing",
        return_value: {
          is_error: true,
          output: "bad",
          message: "bad",
          display: [],
        },
      },
    }, state);

    expect(state.malformedEvents).toEqual([
      expect.stringMatching(/arguments/i),
      expect.stringMatching(/duplicate/i),
      expect.stringMatching(/orphan/i),
    ]);
    expect(orphan).toContainEqual({
      type: "error",
      content: expect.stringMatching(/orphan/i),
    });
  });

  it("retains cumulative SDK token diagnostics without inventing a zero-dollar usage record", () => {
    expect(map({
      type: "StatusUpdate",
      payload: {
        token_usage: {
          input_other: 100,
          output: 20,
          input_cache_read: 30,
          input_cache_creation: 4,
        },
      },
    }).out).toEqual([]);
  });

  it("surfaces questions, approvals, interruptions, subagents, compaction, and parse errors", () => {
    expect(map({
      type: "QuestionRequest",
      payload: {
        id: "request-1",
        tool_call_id: "ask-1",
        questions: [{
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Continue" }],
        }],
      },
    } as KimiStreamEvent).out).toEqual([{
      type: "ask",
      id: "ask-1",
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Continue" }],
      }],
    }]);
    expect(map({
      type: "ApprovalRequest",
      payload: {
        id: "approval-1",
        tool_call_id: "tool-1",
        sender: "agent",
        action: "Bash",
        description: "run command",
      },
    } as KimiStreamEvent).out).toEqual([{
      type: "notice",
      content: expect.stringMatching(/approval.*Bash/i),
    }]);
    expect(map({ type: "StepInterrupted", payload: {} }).out).toEqual([]);
    expect(map({
      type: "SubagentEvent",
      payload: {
        parent_tool_call_id: "parent-1",
        event: { type: "StepBegin", payload: { n: 2 } },
      },
    }).out).toEqual([{
      type: "notice",
      content: expect.stringMatching(/subagent/i),
    }]);
    expect(map({ type: "CompactionBegin", payload: {} }).out).toEqual([{
      type: "notice",
      content: expect.stringMatching(/compact/i),
    }]);
    expect(map({
      type: "ParseError",
      payload: { code: "BAD", message: "invalid event" },
    }).out).toEqual([{
      type: "error",
      content: expect.stringMatching(/invalid event/i),
    }]);
  });
});
