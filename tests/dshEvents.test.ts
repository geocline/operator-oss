import { describe, expect, it } from "vitest";
import { mapDshEvent, newDshState } from "@/lib/agents/dsh/events";

// Unit tests against the REAL event shapes captured live from the packaged
// dsh-jsonrpc-agent runtime (see docs/superpowers/specs/2026-08-16-litellm-dsh-driver.md).
// No real dsh install or network required.

describe("mapDshEvent", () => {
  it("maps an assembled assistant/message into one assistant StreamEvent and tracks usage without emitting it", () => {
    const state = newDshState();
    const out = mapDshEvent(
      {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 1,
          message: { role: "assistant", content: [{ type: "text", text: "Task complete." }] },
          usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 10, cacheWriteTokens: 0 },
        },
      },
      state,
    );
    expect(out).toEqual([{ type: "assistant", content: "Task complete." }]);
    expect(state.latestTokenUsage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
    });
  });

  it("emits nothing for an assistant/message with no text blocks", () => {
    const state = newDshState();
    const out = mapDshEvent(
      { type: "assistant/message", data: { message: { role: "assistant", content: [] } } },
      state,
    );
    expect(out).toEqual([]);
  });

  it("maps tool/call using dsh's own Claude-shaped tool schema", () => {
    const state = newDshState();
    const out = mapDshEvent(
      {
        type: "tool/call",
        data: {
          turn: 1,
          step: 1,
          callId: "call-1",
          name: "edit",
          arguments: JSON.stringify({ file_path: "/a/b.ts", old_string: "foo", new_string: "bar" }),
        },
      },
      state,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "tool", id: "call-1", title: expect.stringContaining("Edit") });
  });

  it("errors on a tool/call missing callId/name", () => {
    const state = newDshState();
    const out = mapDshEvent({ type: "tool/call", data: { name: "bash" } }, state);
    expect(out).toEqual([{ type: "error", content: "dsh tool/call is missing callId/name" }]);
  });

  it("maps tool/result using the ToolResultBlock shape (content[0])", () => {
    const state = newDshState();
    const out = mapDshEvent(
      {
        type: "tool/result",
        data: {
          message: {
            role: "user",
            content: [{
              type: "tool-result",
              toolCallId: "call-1",
              isError: false,
              content: [{ type: "text", text: "hi\n[exit code: 0]" }],
            }],
          },
        },
      },
      state,
    );
    expect(out).toEqual([{
      type: "tool_result",
      id: "call-1",
      content: "hi\n[exit code: 0]",
      isError: false,
      peek: { kind: "count", text: "2 line(s)" },
    }]);
  });

  it("marks an error tool/result isError even without a top-level error field", () => {
    const state = newDshState();
    const out = mapDshEvent(
      {
        type: "tool/result",
        data: {
          message: {
            content: [{ type: "tool-result", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "boom" }] }],
          },
        },
      },
      state,
    );
    expect(out[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  it("resolves turn/end completed to success with no StreamEvent", () => {
    const state = newDshState();
    const out = mapDshEvent({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }, state);
    expect(out).toEqual([]);
    expect(state.outcome).toBe("success");
  });

  it("treats max-tokens as a non-fatal success (maxTokensAsSuccess parity)", () => {
    const state = newDshState();
    const out = mapDshEvent({ type: "turn/end", data: { reason: { kind: "max-tokens" } } }, state);
    expect(out).toEqual([]);
    expect(state.outcome).toBe("success");
  });

  it("resolves turn/end aborted with no error event (abort must stay silent)", () => {
    const state = newDshState();
    const out = mapDshEvent({ type: "turn/end", data: { reason: { kind: "aborted" } } }, state);
    expect(out).toEqual([]);
    expect(state.outcome).toBe("aborted");
  });

  it("surfaces the real captured auth-failure turn/end shape as an actionable error", () => {
    const state = newDshState();
    const out = mapDshEvent(
      {
        type: "turn/end",
        data: { turn: 1, reason: { kind: "error", error: { message: "smoke test: no real key", code: "AUTH", status: 401 } } },
      },
      state,
    );
    expect(out).toEqual([{ type: "error", content: 'dsh turn failed: smoke test: no real key' }]);
    expect(state.outcome).toBe("error");
  });

  it("ignores unknown event types safely, bounded to 20 recorded diagnostics", () => {
    const state = newDshState();
    for (let i = 0; i < 25; i++) {
      expect(mapDshEvent({ type: `agent/inbox/spliced-${i}` }, state)).toEqual([]);
    }
    expect(state.unknownEvents).toHaveLength(20);
  });
});
