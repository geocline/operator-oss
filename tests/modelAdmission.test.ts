import { describe, expect, it } from "vitest";
import {
  approvalRecord,
  reduceAdmission,
  sanitizeEvidence,
  type AdmissionObservation,
} from "@/lib/agents/admission";
import {
  clearLiveAdmissionCandidateForTest,
  modelForHarness,
  replaceLiteLLMCatalog,
  setLiveAdmissionCandidateForTest,
} from "@/lib/agents/litellm/catalog";
import {
  executeAdmission,
  type AdmissionPairing,
  type AdmissionTransport,
} from "@/lib/agents/admission-runner";
import type { StreamEvent } from "@/lib/types";

function passingObservation(
  overrides: Partial<AdmissionObservation> = {},
): AdmissionObservation {
  return {
    alias: "operator.kimi-k3",
    expectedResolvedModel: "moonshotai/kimi-k3-20260715",
    harness: "claude",
    harnessVersion: "2.1.198",
    testRevision: "abc1234",
    testedAt: "2026-08-13T21:00:00.000Z",
    sessionId: "private-session-id",
    identity: {
      requestedAlias: "operator.kimi-k3",
      resolvedModel: "moonshotai/kimi-k3-20260715",
      fallbackFree: true,
      trustedSource: "provider",
    },
    basicTurn: { streamed: true, coherent: true },
    toolLoop: {
      calls: [
        { id: "read-1", kind: "read", schemaValid: true },
        { id: "edit-1", kind: "edit", schemaValid: true },
        { id: "command-1", kind: "command", schemaValid: true },
      ],
      results: [
        { id: "read-1", isError: false },
        { id: "edit-1", isError: false },
        { id: "command-1", isError: false },
      ],
      malformedEvents: 0,
    },
    operatorBridge: {
      toolSucceeded: true,
      interactiveAskClaimed: true,
      interactiveAskSucceeded: true,
    },
    repository: {
      expectedEditPresent: true,
      testsPassed: true,
      disposable: true,
    },
    resume: {
      sameSession: true,
      plantedFactRecalled: true,
    },
    stop: {
      interruptRequested: true,
      settled: true,
      taskBusy: false,
      survivingProcesses: [],
    },
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      costUsd: 0.001,
      costStatus: "trusted",
    },
    providerReconciliation: {
      generationIds: ["gen-12345678-Test"],
      physicalModels: ["moonshotai/kimi-k3-20260715"],
      providers: ["Test Provider"],
      providerCostUsd: 0.001,
      keyUsageDeltaUsd: 0.001,
      complete: true,
    },
    isolation: {
      taskStateIsolated: true,
      relayCredentialOnly: true,
      ambientCredentialLeak: false,
    },
    diagnostics: ["safe diagnostic"],
    ...overrides,
  };
}

describe("harness-neutral model admission evidence", () => {
  it("passes only when every required gate has affirmative evidence", () => {
    const artifact = reduceAdmission(passingObservation());

    expect(artifact.status).toBe("passed");
    expect(Object.values(artifact.gates).every((gate) => gate.passed)).toBe(true);
    expect(artifact.session_id_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.provider_reconciliation).toEqual({
      generation_ids: ["gen-12345678-Test"],
      physical_models: ["moonshotai/kimi-k3-20260715"],
      providers: ["Test Provider"],
      provider_cost_usd: 0.001,
      key_usage_delta_usd: 0.001,
      complete: true,
    });
    expect(JSON.stringify(artifact)).not.toContain("private-session-id");
  });

  it.each([
    ["identity ambiguity", { identity: { requestedAlias: "operator.kimi-k3", resolvedModel: null, fallbackFree: true, trustedSource: "incomplete" } }],
    ["malformed tool event", { toolLoop: { ...passingObservation().toolLoop, malformedEvents: 1 } }],
    ["incomplete repository result", { repository: { expectedEditPresent: true, testsPassed: false, disposable: true } }],
    ["surviving process", { stop: { interruptRequested: true, settled: true, taskBusy: false, survivingProcesses: ["pid:42"] } }],
    ["missing trusted cost", { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, costStatus: "missing" } }],
    ["missing exact provider reconciliation", {
      providerReconciliation: {
        ...passingObservation().providerReconciliation,
        complete: false,
      },
    }],
    ["credential leak", { isolation: { taskStateIsolated: true, relayCredentialOnly: false, ambientCredentialLeak: true } }],
  ])("fails closed on %s", (_name, override) => {
    const artifact = reduceAdmission(
      passingObservation(override as Partial<AdmissionObservation>),
    );

    expect(artifact.status).toBe("failed");
    expect(Object.values(artifact.gates).some((gate) => !gate.passed)).toBe(true);
  });

  it("treats a noisy shared-key delta as diagnostic when exact generations reconcile", () => {
    const observation = passingObservation();
    observation.providerReconciliation.keyUsageDeltaUsd = 0.25;

    const artifact = reduceAdmission(observation);

    expect(artifact.gates.usage).toMatchObject({ passed: true });
    expect(artifact.provider_reconciliation).toMatchObject({
      provider_cost_usd: 0.001,
      key_usage_delta_usd: 0.25,
      complete: true,
    });
  });

  it("requires paired successful read, edit, and command tool results", () => {
    const observation = passingObservation();
    observation.toolLoop.results = observation.toolLoop.results.filter(
      (result) => result.id !== "edit-1",
    );

    const artifact = reduceAdmission(observation);

    expect(artifact.status).toBe("failed");
    expect(artifact.gates.tool_loop).toMatchObject({
      passed: false,
      detail: expect.stringContaining("edit"),
    });
  });

  it("recursively removes secret-shaped fields and values", () => {
    const sanitized = sanitizeEvidence({
      prompt: "private repository content",
      nested: {
        ANTHROPIC_AUTH_TOKEN: "relay-secret",
        note: "Authorization: Bearer sk-or-secretvalue",
        safe: "operator.kimi-k3",
      },
      values: ["OPENAI_API_KEY=sk-secretvalue", "safe"],
    });

    expect(sanitized).toEqual({
      nested: {
        note: "[REDACTED]",
        safe: "operator.kimi-k3",
      },
      values: ["[REDACTED]", "safe"],
    });
  });

  it("prints approval metadata only for a passing sanitized artifact", () => {
    const artifact = reduceAdmission(passingObservation());

    expect(approvalRecord(artifact)).toEqual({
      harness: "claude",
      status: "passed",
      harness_version: "2.1.198",
      test_revision: "abc1234",
      tested_at: "2026-08-13T21:00:00.000Z",
      requested_alias: "operator.kimi-k3",
      resolved_model: "moonshotai/kimi-k3-20260715",
    });
    expect(() =>
      approvalRecord(
        reduceAdmission(
          passingObservation({
            basicTurn: { streamed: false, coherent: true },
          }),
        ),
      ),
    ).toThrow(/failed admission/i);
  });
});

describe("opt-in admission runner", () => {
  const pairing: AdmissionPairing = {
    alias: "operator.kimi-k3",
    expectedResolvedModel: "moonshotai/kimi-k3-20260715",
    harness: "claude",
    harnessVersion: "2.1.198",
    testRevision: "abc1234",
    requiresInteractiveAsk: true,
  };

  function fakeTransport(
    overrides: Partial<AdmissionTransport> = {},
  ): AdmissionTransport {
    const fresh: StreamEvent[] = [
      { type: "session", sessionId: "private-session-id" },
      { type: "model", model: "operator.kimi-k3" },
      { type: "tool", id: "r1", title: "Read fixture.txt", detail: "" },
      { type: "tool_result", id: "r1", content: "seed", isError: false },
      { type: "tool", id: "e1", title: "Edit result.txt", detail: "" },
      { type: "tool_result", id: "e1", content: "ok", isError: false },
      { type: "tool", id: "c1", title: "Run npm test", detail: "" },
      { type: "tool_result", id: "c1", content: "pass", isError: false },
      { type: "suggested", title: "Admission bridge proof" },
      {
        type: "ask",
        id: "ask-1",
        questions: [{
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Continue" }],
        }],
      },
      { type: "ask_answered", id: "ask-1", answers: [["Continue"]] },
      { type: "assistant", content: "ADMISSION_OK" },
      {
        type: "usage",
        usage: {
          cost_usd: 0,
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      },
      { type: "done", sessionId: "private-session-id" },
    ];
    return {
      async runFresh() {
        return fresh;
      },
      async runResume() {
        return [
          { type: "assistant", content: "PLANTED_FACT_7391" },
          { type: "done", sessionId: "private-session-id" },
        ];
      },
      async runStop(onEvent) {
        onEvent({ type: "tool", id: "stop-1", title: "Run sleep", detail: "" });
        return {
          events: [],
          interruptRequested: true,
          settled: true,
          taskBusy: false,
          survivingProcesses: [],
        };
      },
      async verifyRepository() {
        return {
          expectedEditPresent: true,
          testsPassed: true,
          disposable: true,
        };
      },
      async reconcileIdentityAndCost() {
        return {
          identity: {
            requestedAlias: pairing.alias,
            resolvedModel: pairing.expectedResolvedModel,
            fallbackFree: true,
            trustedSource: "provider",
          },
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.001,
            costStatus: "trusted",
          },
          providerReconciliation: passingObservation().providerReconciliation,
          diagnostics: ["provider reconciliation succeeded"],
        };
      },
      async verifyIsolation() {
        return {
          taskStateIsolated: true,
          relayCredentialOnly: true,
          ambientCredentialLeak: false,
        };
      },
      ...overrides,
    };
  }

  it("refuses to spend unless the explicit pairing opt-in is set", async () => {
    await expect(
      executeAdmission({
        pairing,
        transport: fakeTransport(),
        optIn: false,
      }),
    ).rejects.toThrow(/explicit opt-in/i);
  });

  it("reduces a deterministic fake transport into passing sanitized evidence", async () => {
    const artifact = await executeAdmission({
      pairing,
      transport: fakeTransport(),
      optIn: true,
    });

    expect(artifact.status).toBe("passed");
    expect(artifact.alias).toBe(pairing.alias);
    expect(artifact.gates.tool_loop.passed).toBe(true);
    expect(artifact.gates.operator_bridge.passed).toBe(true);
    expect(artifact.diagnostics).toContain(
      "fresh event counts: ask=1, ask_answered=1, assistant=1, done=1, model=1, session=1, suggested=1, tool=3, tool_result=3, usage=1",
    );
    expect(JSON.stringify(artifact)).not.toContain("private-session-id");
  });

  it("fails closed when the harness emits a malformed or unpaired tool result", async () => {
    const transport = fakeTransport({
      async runFresh() {
        return [
          { type: "session", sessionId: "private-session-id" },
          { type: "tool_result", id: "orphan", content: "bad", isError: false },
          { type: "assistant", content: "ADMISSION_OK" },
          { type: "done", sessionId: "private-session-id" },
        ];
      },
    });

    const artifact = await executeAdmission({
      pairing,
      transport,
      optIn: true,
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.gates.tool_loop).toMatchObject({
      passed: false,
      detail: expect.stringMatching(/malformed|missing/i),
    });
  });

  it("fails closed on a duplicate result for the same tool call", async () => {
    const transport = fakeTransport({
      async runFresh() {
        const base = await fakeTransport().runFresh();
        const first = base.find(
          (event): event is Extract<StreamEvent, { type: "tool_result" }> =>
            event.type === "tool_result",
        )!;
        return [...base, { ...first }];
      },
    });

    const artifact = await executeAdmission({
      pairing,
      transport,
      optIn: true,
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.gates.tool_loop).toMatchObject({
      passed: false,
      detail: expect.stringMatching(/malformed/i),
    });
  });

  it("fails the stop gate when the stop stream emits any error", async () => {
    const transport = fakeTransport({
      async runStop(onEvent) {
        onEvent({
          type: "error",
          content: "Kimi Code process settlement evidence is missing",
        });
        return {
          events: [],
          interruptRequested: true,
          settled: true,
          taskBusy: false,
          survivingProcesses: [],
        };
      },
    });

    const artifact = await executeAdmission({
      pairing,
      transport,
      optIn: true,
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.gates.stop).toMatchObject({
      passed: false,
      detail: expect.stringMatching(/settle|process/i),
    });
  });

  it("recognizes the glyph-prefixed tool titles emitted by Operator's Claude normalizer", async () => {
    const transport = fakeTransport({
      async runFresh() {
        return [
          { type: "session", sessionId: "private-session-id" },
          { type: "tool", id: "r1", title: "📖 Read fixture.txt", detail: "" },
          { type: "tool_result", id: "r1", content: "seed", isError: false },
          { type: "tool", id: "e1", title: "✎ Edit result.txt", detail: "" },
          { type: "tool_result", id: "e1", content: "ok", isError: false },
          { type: "tool", id: "c1", title: "❯ npm test", detail: "" },
          { type: "tool_result", id: "c1", content: "pass", isError: false },
          { type: "suggested", title: "Admission bridge proof" },
          {
            type: "ask",
            id: "ask-1",
            questions: [{
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Continue" }],
            }],
          },
          { type: "ask_answered", id: "ask-1", answers: [["Continue"]] },
          { type: "assistant", content: "ADMISSION_OK" },
          { type: "done", sessionId: "private-session-id" },
        ];
      },
    });

    const artifact = await executeAdmission({
      pairing,
      transport,
      optIn: true,
    });

    expect(artifact.gates.tool_loop.passed).toBe(true);
  });

  it("allows valid paired Operator bridge tools in addition to required coding tools", async () => {
    const transport = fakeTransport({
      async runFresh() {
        return [
          { type: "session", sessionId: "private-session-id" },
          { type: "tool", id: "r1", title: "📖 Read fixture.txt", detail: "" },
          { type: "tool_result", id: "r1", content: "seed", isError: false },
          { type: "tool", id: "e1", title: "✎ Edit result.txt", detail: "" },
          { type: "tool_result", id: "e1", content: "ok", isError: false },
          { type: "tool", id: "c1", title: "❯ npm test", detail: "" },
          { type: "tool_result", id: "c1", content: "pass", isError: false },
          { type: "tool", id: "bridge-1", title: "✦ Suggested a task", detail: "" },
          { type: "tool_result", id: "bridge-1", content: "created", isError: false },
          { type: "suggested", title: "Admission bridge proof" },
          {
            type: "ask",
            id: "ask-1",
            questions: [{
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Continue" }],
            }],
          },
          { type: "ask_answered", id: "ask-1", answers: [["Continue"]] },
          { type: "assistant", content: "ADMISSION_OK" },
          { type: "done", sessionId: "private-session-id" },
        ];
      },
    });

    const artifact = await executeAdmission({
      pairing,
      transport,
      optIn: true,
    });

    expect(artifact.gates.tool_loop.passed).toBe(true);
  });

  it("classifies Prime ipython calls by their read, edit, and command payloads", async () => {
    const transport = fakeTransport({
      async runFresh() {
        const events = await fakeTransport().runFresh();
        return events.map((event) => {
          if (event.type !== "tool") return event;
          if (event.id === "r1") {
            return {
              ...event,
              title: "⚙ ipython",
              detail: 'Path("fixture.txt").read_text()',
            };
          }
          if (event.id === "e1") {
            return {
              ...event,
              title: "⚙ ipython",
              detail: 'Path("result.txt").write_text("PLANTED_FACT_7391\\n")',
            };
          }
          if (event.id === "c1") {
            return {
              ...event,
              title: "⚙ ipython",
              detail: 'subprocess.run(["npm", "test"], check=True)',
            };
          }
          return event;
        });
      },
    });

    const artifact = await executeAdmission({
      pairing,
      transport,
      optIn: true,
    });

    expect(artifact.gates.tool_loop).toMatchObject({ passed: true });
  });

  it("accepts Prime's paired suggest_task extension call as Operator bridge proof", async () => {
    const transport = fakeTransport({
      async runFresh() {
        const events = await fakeTransport().runFresh();
        return [
          ...events.filter((event) => event.type !== "suggested"),
          {
            type: "tool" as const,
            id: "prime-bridge",
            title: "⚙ suggest_task",
            detail: "",
          },
          {
            type: "tool_result" as const,
            id: "prime-bridge",
            content: "created",
            isError: false,
          },
        ];
      },
    });

    const artifact = await executeAdmission({
      pairing,
      transport,
      optIn: true,
    });

    expect(artifact.gates.operator_bridge).toMatchObject({ passed: true });
  });

  it("fails when a harness that claims interactive asks never completes one", async () => {
    const artifact = await executeAdmission({
      pairing,
      transport: fakeTransport({
        async runFresh() {
          return [
            { type: "session", sessionId: "private-session-id" },
            { type: "tool", id: "r1", title: "Read fixture.txt", detail: "" },
            { type: "tool_result", id: "r1", content: "seed", isError: false },
            { type: "tool", id: "e1", title: "Edit result.txt", detail: "" },
            { type: "tool_result", id: "e1", content: "ok", isError: false },
            { type: "tool", id: "c1", title: "Run npm test", detail: "" },
            { type: "tool_result", id: "c1", content: "pass", isError: false },
            { type: "suggested", title: "Admission bridge proof" },
            { type: "assistant", content: "ADMISSION_OK" },
            { type: "done", sessionId: "private-session-id" },
          ];
        },
      }),
      optIn: true,
    });

    expect(artifact.gates.operator_bridge.passed).toBe(false);
  });

  it("never mutates catalog metadata as part of running admission", async () => {
    let metadataWrites = 0;
    const artifact = await executeAdmission({
      pairing,
      transport: fakeTransport(),
      optIn: true,
      onMetadataWrite: () => {
        metadataWrites += 1;
      },
    });

    expect(artifact.status).toBe("passed");
    expect(metadataWrites).toBe(0);
  });
});

describe("live admission candidate bootstrap", () => {
  it("is unavailable without explicit test-mode live opt-in and never changes catalog metadata", () => {
    replaceLiteLLMCatalog({
      models: [{
        value: "operator.kimi-k3",
        label: "Kimi K3",
        description: "",
        kind: "coding",
        harnesses: ["codex"],
        admissions: [{
          harness: "codex",
          status: "passed",
          harnessVersion: "fixture",
          testRevision: "fixture",
          testedAt: "2026-08-13T00:00:00.000Z",
          requestedAlias: "operator.kimi-k3",
          resolvedModel: "moonshotai/kimi-k3-20260715",
        }],
        contextWindow: 1_048_576,
        reasoningOptions: ["high"],
        sortOrder: 1,
      }],
      errors: [],
      refreshedAt: "2026-08-13T00:00:00.000Z",
      stale: false,
    });
    const before = process.env.MODEL_ADMISSION_LIVE;
    delete process.env.MODEL_ADMISSION_LIVE;
    expect(() =>
      setLiveAdmissionCandidateForTest("operator.kimi-k3", "kimi-code"),
    ).toThrow(/live opt-in/i);

    process.env.MODEL_ADMISSION_LIVE = "1";
    setLiveAdmissionCandidateForTest("operator.kimi-k3", "kimi-code");
    expect(modelForHarness("operator.kimi-k3", "kimi-code")).toMatchObject({
      value: "operator.kimi-k3",
      harnesses: ["codex"],
    });
    clearLiveAdmissionCandidateForTest();
    expect(modelForHarness("operator.kimi-k3", "kimi-code")).toBeNull();
    if (before === undefined) delete process.env.MODEL_ADMISSION_LIVE;
    else process.env.MODEL_ADMISSION_LIVE = before;
  });
});
