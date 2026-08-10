import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_MODEL,
  EXPECTED_PROVIDER,
  assertAbortEvidence,
  assertGenerationIdentity,
  assertModelIdentity,
  attributionFromGenerations,
  generationIdsFromEvents,
  parsePrimeAgentVersion,
  redactSecrets,
  resolveSessionFile,
  shouldRetryGenerationMetadata,
  stopBeforeAttribution,
  summarizeEvents,
  usageCounterSettled,
} from "./compatibility-runner.mjs";

const assistantMessage = (overrides = {}) => ({
  role: "assistant",
  provider: EXPECTED_PROVIDER,
  model: EXPECTED_MODEL,
  usage: {
    input: 120,
    output: 30,
    cacheRead: 10,
    cacheWrite: 0,
    cost: { input: 0.00036, output: 0.00045, cacheRead: 0.000003, cacheWrite: 0, total: 0.000813 },
  },
  content: [{ type: "text", text: "PRIME-KIMI-OK" }],
  stopReason: "stop",
  ...overrides,
});

test("accepts only the approved provider and Kimi K3 model", () => {
  assert.doesNotThrow(() => assertModelIdentity(assistantMessage()));
  assert.throws(
    () => assertModelIdentity(assistantMessage({ model: "openai/gpt-5" })),
    /model mismatch/,
  );
  assert.throws(
    () => assertModelIdentity(assistantMessage({ provider: "openrouter" })),
    /provider mismatch/,
  );
});

test("summarizes final assistant messages without double-counting updates", () => {
  const finalMessage = assistantMessage();
  const summary = summarizeEvents([
    { type: "message_update", message: finalMessage },
    { type: "message_end", message: finalMessage },
    { type: "agent_end", messages: [finalMessage] },
  ]);

  assert.deepEqual(summary.usage, {
    input: 120,
    output: 30,
    cacheRead: 10,
    cacheWrite: 0,
    total: 160,
    cost: 0.000813,
  });
  assert.equal(summary.modelCalls, 1);
});

test("recognizes a successful IPython tool call", () => {
  const summary = summarizeEvents([
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "ipython", args: { code: "2 + 2" } },
    {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "ipython",
      result: { content: [{ type: "text", text: "4" }] },
      isError: false,
    },
  ]);

  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.successfulIpynbCalls, 1);
  assert.equal(summary.toolErrors, 0);
});

test("rejects missing usage and tool errors", () => {
  assert.throws(
    () => summarizeEvents([{ type: "message_end", message: assistantMessage({ usage: undefined }) }]),
    /missing usage/,
  );
  assert.throws(
    () =>
      summarizeEvents([
        {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "ipython",
          result: { content: [{ type: "text", text: "failure" }] },
          isError: true,
        },
      ]),
    /tool execution failed/,
  );
});

test("redacts OpenRouter secrets recursively", () => {
  const secret = "sk-or-v1-" + "a".repeat(64);
  const redacted = redactSecrets({
    authorization: `Bearer ${secret}`,
    nested: [{ output: `prefix ${secret} suffix` }],
  });

  assert.equal(JSON.stringify(redacted).includes(secret), false);
  assert.deepEqual(redacted, {
    authorization: "Bearer [REDACTED_OPENROUTER_KEY]",
    nested: [{ output: "prefix [REDACTED_OPENROUTER_KEY] suffix" }],
  });
});

test("uses RPC get_state as startup readiness and session source", () => {
  assert.equal(
    resolveSessionFile({
      sessionFile: "/tmp/prime-session.jsonl",
      sessionId: "session-123",
      model: { provider: EXPECTED_PROVIDER, id: EXPECTED_MODEL },
    }),
    "/tmp/prime-session.jsonl",
  );
  assert.throws(() => resolveSessionFile({ sessionId: "session-123" }), /session file/);
});

test("accepts only the dated Kimi K3 deployment returned by OpenRouter", () => {
  assert.doesNotThrow(() =>
    assertGenerationIdentity({
      id: "gen-1",
      model: "moonshotai/kimi-k3-20260715",
      provider_name: "Fireworks",
    }),
  );
  assert.throws(
    () => assertGenerationIdentity({ id: "gen-2", model: "openai/gpt-5", provider_name: "OpenAI" }),
    /generation model mismatch/,
  );
  assert.throws(
    () =>
      assertGenerationIdentity({
        id: "gen-3",
        model: "moonshotai/kimi-k3-openai-fallback",
        provider_name: "Unknown",
      }),
    /generation model mismatch/,
  );
});

test("waits for the asynchronous OpenRouter key counter to reconcile", () => {
  assert.equal(usageCounterSettled(0, 0.0201909, 0.0337104), false);
  assert.equal(usageCounterSettled(0, 0.0337104, 0.0337104), true);
});

test("retries fresh generation metadata only for bounded 404s", () => {
  assert.equal(shouldRetryGenerationMetadata(404, 0), true);
  assert.equal(shouldRetryGenerationMetadata(404, 18), true);
  assert.equal(shouldRetryGenerationMetadata(404, 19), false);
  assert.equal(shouldRetryGenerationMetadata(500, 0), false);
});

test("reads Prime Agent version from stderr", () => {
  assert.equal(parsePrimeAgentVersion({ status: 0, stdout: "", stderr: "0.7.1\n" }), "0.7.1");
  assert.throws(() => parsePrimeAgentVersion({ status: 1, stdout: "", stderr: "failure" }), /version/);
});

test("requires explicit aborted or error evidence for the stop gate", () => {
  assert.doesNotThrow(() =>
    assertAbortEvidence([
      { type: "tool_execution_start", toolCallId: "tool-1", toolName: "ipython" },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "ipython",
        isError: true,
        result: { content: [{ type: "text", text: "Request was aborted" }] },
      },
      { type: "agent_end", messages: [] },
    ]),
  );
  assert.throws(
    () =>
      assertAbortEvidence([
        { type: "tool_execution_start", toolCallId: "tool-1", toolName: "ipython" },
        {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "ipython",
          isError: false,
          result: { content: [{ type: "text", text: "SLEPT" }] },
        },
        { type: "agent_end", messages: [] },
      ]),
    /abort evidence/,
  );
});

test("retains generation IDs and billable cost for failed runs", () => {
  const events = [
    {
      type: "message_end",
      message: {
        ...assistantMessage({ model: "unexpected/model", responseId: "gen-failed-1" }),
      },
    },
  ];
  assert.deepEqual(generationIdsFromEvents(events), ["gen-failed-1"]);
  assert.deepEqual(
    attributionFromGenerations([
      { id: "gen-failed-1", model: "unexpected/model", providerName: "Unknown", totalCost: 0.0123 },
    ]),
    {
      generationCost: 0.0123,
      generationIds: ["gen-failed-1"],
      upstreamProviders: ["Unknown"],
    },
  );
});

test("stops every active client before collecting failure attribution", async () => {
  const order = [];
  const attribution = await stopBeforeAttribution(
    [
      { forceStop: async () => order.push("stop-first") },
      { forceStop: async () => order.push("stop-resumed") },
    ],
    async () => {
      order.push("collect");
      return { openRouterSpendDelta: 0.0123 };
    },
  );

  assert.deepEqual(order, ["stop-first", "stop-resumed", "collect"]);
  assert.equal(attribution.openRouterSpendDelta, 0.0123);
});
