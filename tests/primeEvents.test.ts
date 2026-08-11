// Table tests for lib/agents/prime/events.ts — the stateful Prime -> Operator
// StreamEvent normalizer. Exercises the mapper directly against recorded/
// constructed PrimeRpcEvent sequences; no CLI is spawned (see
// tests/primeRpc.test.ts for the process-lifecycle side).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { newPrimeState, mapPrimeEvent, type PrimeMapState } from "../lib/agents/prime/events";
import type { PrimeRpcEvent } from "../lib/agents/prime/rpc";
import type { StreamEvent } from "../lib/types";
import { APPROVED_PRIME_MODEL } from "../lib/agents/prime/policy";

function loadFixture(name: string): PrimeRpcEvent[] {
  const file = path.join(__dirname, "fixtures", "prime", name);
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PrimeRpcEvent);
}

function run(events: PrimeRpcEvent[], requestedModel = APPROVED_PRIME_MODEL): { out: StreamEvent[]; state: PrimeMapState } {
  const state = newPrimeState(requestedModel);
  const out: StreamEvent[] = [];
  for (const ev of events) out.push(...mapPrimeEvent(ev, state));
  return { out, state };
}

const VALID_MESSAGE_END = (overrides: Record<string, unknown> = {}) => ({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "stop",
    responseId: "gen-1",
    content: [{ type: "text", text: "final text" }],
    usage: { input: 120, output: 45, cacheRead: 10, cacheWrite: 0, cost: { total: 0.0042 } },
    provider: "operator-litellm",
    model: APPROVED_PRIME_MODEL,
    resolvedModel: "kimi-k3-0905-preview",
    ...overrides,
  },
});

describe("mapPrimeEvent", () => {
  it("rejects a physical identity that differs from the model recorded by admission", () => {
    const state = newPrimeState("operator.kimi-k3", "moonshotai/kimi-k3");
    const out = [
      ...mapPrimeEvent(
        VALID_MESSAGE_END({ resolvedModel: "moonshotai/other-model" }) as PrimeRpcEvent,
        state,
      ),
      ...mapPrimeEvent({ type: "agent_end" }, state),
    ];
    expect(out.some((event) => event.type === "error")).toBe(true);
    expect(out.some((event) => event.type === "done")).toBe(false);
  });
  it("1. agent_start emits a session event with the opaque session id", () => {
    const { out } = run([{ type: "agent_start", sessionFile: "/tmp/fake-prime/session.jsonl" }]);
    expect(out).toEqual([{ type: "session", sessionId: "/tmp/fake-prime/session.jsonl" }]);
  });

  it("2. a valid message_end emits a model event with the resolved identity", () => {
    const { out } = run([VALID_MESSAGE_END() as PrimeRpcEvent]);
    expect(out).toContainEqual({ type: "model", model: "kimi-k3-0905-preview" });
  });

  it("3/4. message_update deltas accumulate and flush as one assistant emission at message_end", () => {
    const events: PrimeRpcEvent[] = [
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", delta: { type: "text", text: "Hello " } },
      { type: "message_update", delta: { type: "text", text: "world" } },
      VALID_MESSAGE_END({ content: [{ type: "text", text: "Hello world" }] }) as PrimeRpcEvent,
    ];
    const { out } = run(events);
    const assistantEvents = out.filter((e) => e.type === "assistant");
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0]).toEqual({ type: "assistant", content: "Hello world" });
  });

  it("falls back to message.content when no deltas arrived (tool-only turn)", () => {
    const events: PrimeRpcEvent[] = [
      { type: "message_start", message: { role: "assistant" } },
      VALID_MESSAGE_END({ content: [{ type: "text", text: "no deltas, direct content" }] }) as PrimeRpcEvent,
    ];
    const { out } = run(events);
    expect(out).toContainEqual({ type: "assistant", content: "no deltas, direct content" });
  });

  it("4. tool_execution_start/end pair by toolCallId into tool / tool_result", () => {
    const events: PrimeRpcEvent[] = [
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "ipython", args: { code: "print(2+2)" } },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "ipython", isError: false, result: "4" },
    ];
    const { out } = run(events);
    expect(out[0]).toMatchObject({ type: "tool", id: "call-1", title: expect.stringContaining("ipython") });
    expect(out[1]).toMatchObject({ type: "tool_result", id: "call-1", isError: false, content: "4" });
  });

  it("5. a tool error (isError: true) surfaces as a tool_result error", () => {
    const events: PrimeRpcEvent[] = [
      { type: "tool_execution_start", toolCallId: "call-2", toolName: "ipython", args: { code: "1/0" } },
      { type: "tool_execution_end", toolCallId: "call-2", toolName: "ipython", isError: true, result: "ZeroDivisionError" },
    ];
    const { out } = run(events);
    const result = out.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ type: "tool_result", id: "call-2", isError: true, content: "ZeroDivisionError" });
  });

  it("6. usage from message_end usage fields maps to a usage event with trusted cost", () => {
    const { out } = run([VALID_MESSAGE_END() as PrimeRpcEvent]);
    expect(out).toContainEqual({
      type: "usage",
      usage: { cost_usd: 0.0042, input_tokens: 120, output_tokens: 45, cache_read_tokens: 10, cache_creation_tokens: 0 },
    });
  });

  it("6b. a missing cost field is reported as 0, never estimated", () => {
    const { out } = run([VALID_MESSAGE_END({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }) as PrimeRpcEvent]);
    const usage = out.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ type: "usage", usage: { cost_usd: 0 } });
  });

  it("7. stopReason 'aborted' produces no success done and no assistant/usage emission", () => {
    const events: PrimeRpcEvent[] = [
      { type: "agent_start", sessionFile: "/tmp/fake-prime/session.jsonl" },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", delta: { type: "text", text: "partial" } },
      { type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } },
      { type: "agent_end" },
    ];
    const { out, state } = run(events);
    expect(out.some((e) => e.type === "done")).toBe(false);
    expect(out.some((e) => e.type === "assistant")).toBe(false);
    expect(out.some((e) => e.type === "usage")).toBe(false);
    expect(state.outcome).toBe("aborted");
  });

  it("7b. stopReason 'error' produces an error event and no success done", () => {
    const events: PrimeRpcEvent[] = [
      { type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } },
      { type: "agent_end" },
    ];
    const { out } = run(events);
    expect(out.some((e) => e.type === "error")).toBe(true);
    expect(out.some((e) => e.type === "done")).toBe(false);
  });

  it("8. agent_end after a successful validated turn emits done with the session id", () => {
    const events = loadFixture("events-normalized-success.jsonl");
    const { out } = run(events);
    expect(out).toContainEqual({ type: "done", sessionId: "/tmp/fake-prime/normalized-session.jsonl" });
    // Exactly one assistant row for the whole turn.
    expect(out.filter((e) => e.type === "assistant")).toHaveLength(1);
  });

  describe("9. model identity policy", () => {
    it("rejects a missing resolvedModel when the provider is not operator-litellm", () => {
      const base = (VALID_MESSAGE_END({}) as { message: Record<string, unknown> }).message;
      const { out } = run([
        { type: "message_end", message: { ...base, resolvedModel: undefined, provider: "llama-router" } } as PrimeRpcEvent,
        { type: "agent_end" },
      ]);
      expect(out.some((e) => e.type === "error")).toBe(true);
      expect(out.some((e) => e.type === "done")).toBe(false);
    });

    it("accepts a message_end without resolvedModel when alias and provider are clean", () => {
      // prime-agent 0.7.1 cannot observe the physical model through the
      // credential-preserving relay; the alias→physical binding is pinned
      // fallback-free in the LiteLLM config and reconciled out-of-band.
      const { out } = run([VALID_MESSAGE_END({ resolvedModel: undefined }) as PrimeRpcEvent, { type: "agent_end" }]);
      expect(out.some((e) => e.type === "error")).toBe(false);
      expect(out.some((e) => e.type === "done")).toBe(true);
      expect(out.find((e) => e.type === "model")).toMatchObject({ model: "operator.kimi-k3" });
    });

    it("rejects a fallback-suffixed alias and a non-approved provider", () => {
      const fallbackAlias = run([
        { ...(VALID_MESSAGE_END({ resolvedModel: undefined }) as { message: Record<string, unknown> }), message: { ...(VALID_MESSAGE_END({}) as { message: Record<string, unknown> }).message, resolvedModel: undefined, model: "operator.kimi-k3:fallback" }, type: "message_end" } as PrimeRpcEvent,
        { type: "agent_end" },
      ]);
      expect(fallbackAlias.out.some((e) => e.type === "error")).toBe(true);
      expect(fallbackAlias.out.some((e) => e.type === "done")).toBe(false);

      const badProvider = run([
        { ...(VALID_MESSAGE_END({}) as { message: Record<string, unknown> }), message: { ...(VALID_MESSAGE_END({}) as { message: Record<string, unknown> }).message, resolvedModel: undefined, provider: "openai" }, type: "message_end" } as PrimeRpcEvent,
        { type: "agent_end" },
      ]);
      expect(badProvider.out.some((e) => e.type === "error")).toBe(true);
      expect(badProvider.out.some((e) => e.type === "done")).toBe(false);
    });

    it("accepts an OpenAI identity when the exact alias was admitted for Prime", () => {
      const { out } = run([VALID_MESSAGE_END({ resolvedModel: "gpt-4.1-mini" }) as PrimeRpcEvent, { type: "agent_end" }]);
      expect(out.some((e) => e.type === "error")).toBe(false);
      expect(out.some((e) => e.type === "done")).toBe(true);
    });

    it("accepts an Anthropic identity when the exact alias was admitted for Prime", () => {
      const { out } = run([VALID_MESSAGE_END({ resolvedModel: "claude-3-5-sonnet" }) as PrimeRpcEvent, { type: "agent_end" }]);
      expect(out.some((e) => e.type === "error")).toBe(false);
      expect(out.some((e) => e.type === "done")).toBe(true);
    });

    it("rejects a fallback-suffixed identity", () => {
      const { out } = run([VALID_MESSAGE_END({ resolvedModel: "kimi-k3-0905-preview:fallback" }) as PrimeRpcEvent, { type: "agent_end" }]);
      expect(out.some((e) => e.type === "error")).toBe(true);
      expect(out.some((e) => e.type === "done")).toBe(false);
    });

    it("rejects a mismatched requested alias", () => {
      const { out } = run([VALID_MESSAGE_END({ model: "some.other.alias" }) as PrimeRpcEvent, { type: "agent_end" }]);
      expect(out.some((e) => e.type === "error")).toBe(true);
      expect(out.some((e) => e.type === "done")).toBe(false);
    });

    it("accepts a clean Kimi identity and allows a subsequent successful done", () => {
      const { out } = run([VALID_MESSAGE_END() as PrimeRpcEvent, { type: "agent_end" }]);
      expect(out.some((e) => e.type === "error")).toBe(false);
      expect(out).toContainEqual({ type: "done", sessionId: null });
    });

    it("still reports usage for a policy-failed turn (the run still cost money)", () => {
      const { out } = run([VALID_MESSAGE_END({ resolvedModel: "gpt-4o" }) as PrimeRpcEvent]);
      expect(out.some((e) => e.type === "usage")).toBe(true);
    });
  });

  describe("10. unknown/malformed events", () => {
    it("ignores an unrecognized event type but records it in bounded diagnostics", () => {
      const { out, state } = run([{ type: "heartbeat", ts: 123 }]);
      expect(out).toEqual([]);
      expect(state.unknownEvents).toEqual(["heartbeat"]);
    });

    it("caps the diagnostics list instead of growing unbounded", () => {
      const events: PrimeRpcEvent[] = Array.from({ length: 50 }, (_, i) => ({ type: `weird_event_${i}` }));
      const { state } = run(events);
      expect(state.unknownEvents.length).toBeLessThanOrEqual(20);
    });

    it("a message_end without a message field produces an error, not a crash", () => {
      const { out } = run([{ type: "message_end" }]);
      expect(out).toEqual([{ type: "error", content: expect.stringContaining("message_end") }]);
    });

    it("an agent_start without a sessionFile is quietly skipped (real 0.7.1 shape; the driver probes get_state)", () => {
      const { out } = run([{ type: "agent_start" }]);
      expect(out).toEqual([]);
    });

    it("non-assistant message_ends (the echoed user prompt) produce no output", () => {
      const { out } = run([
        { type: "message_start", message: { role: "user" } },
        { type: "message_end", message: { role: "user", content: [{ type: "text", text: "the prompt" }] } },
      ]);
      expect(out).toEqual([]);
    });

    it("a tool_execution_end with no matching start still pairs by toolCallId", () => {
      const { out } = run([{ type: "tool_execution_end", toolCallId: "orphan", toolName: "ipython", isError: false, result: "ok" }]);
      expect(out).toEqual([{ type: "tool_result", id: "orphan", content: "ok", isError: false, peek: expect.anything() }]);
    });
  });
});
