import { createHash } from "node:crypto";
import type { LiteLLMHarness } from "./litellm/types";

export type AdmissionHarness = LiteLLMHarness | "kimi-code";
export type AdmissionToolKind = "read" | "edit" | "command";

export interface AdmissionObservation {
  alias: string;
  expectedResolvedModel: string;
  harness: AdmissionHarness;
  harnessVersion: string;
  testRevision: string;
  testedAt: string;
  sessionId: string | null;
  identity: {
    requestedAlias: string;
    resolvedModel: string | null;
    fallbackFree: boolean;
    trustedSource: "harness" | "gateway" | "provider" | "incomplete";
  };
  basicTurn: {
    streamed: boolean;
    coherent: boolean;
  };
  toolLoop: {
    calls: Array<{
      id: string;
      kind: AdmissionToolKind;
      schemaValid: boolean;
    }>;
    results: Array<{
      id: string;
      isError: boolean;
    }>;
    malformedEvents: number;
  };
  operatorBridge: {
    toolSucceeded: boolean;
    interactiveAskClaimed: boolean;
    interactiveAskSucceeded: boolean;
  };
  repository: {
    expectedEditPresent: boolean;
    testsPassed: boolean;
    disposable: boolean;
  };
  resume: {
    sameSession: boolean;
    plantedFactRecalled: boolean;
  };
  stop: {
    interruptRequested: boolean;
    settled: boolean;
    taskBusy: boolean;
    survivingProcesses: string[];
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number | null;
    costStatus: "trusted" | "missing" | "untrusted";
  };
  providerReconciliation: {
    generationIds: string[];
    physicalModels: string[];
    providers: string[];
    providerCostUsd: number | null;
    keyUsageDeltaUsd: number | null;
    complete: boolean;
  };
  isolation: {
    taskStateIsolated: boolean;
    relayCredentialOnly: boolean;
    ambientCredentialLeak: boolean;
  };
  diagnostics?: string[];
}

export interface AdmissionGateResult {
  passed: boolean;
  detail: string;
}

export interface AdmissionArtifact {
  schema_version: 1;
  alias: string;
  resolved_model: string | null;
  harness: AdmissionHarness;
  harness_version: string;
  test_revision: string;
  tested_at: string;
  status: "passed" | "failed";
  gates: {
    identity: AdmissionGateResult;
    basic_turn: AdmissionGateResult;
    tool_loop: AdmissionGateResult;
    operator_bridge: AdmissionGateResult;
    repository_result: AdmissionGateResult;
    resume: AdmissionGateResult;
    stop: AdmissionGateResult;
    usage: AdmissionGateResult;
    isolation: AdmissionGateResult;
  };
  session_id_sha256: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number | null;
    cost_status: AdmissionObservation["usage"]["costStatus"];
  };
  provider_reconciliation: {
    generation_ids: string[];
    physical_models: string[];
    providers: string[];
    provider_cost_usd: number | null;
    key_usage_delta_usd: number | null;
    complete: boolean;
  };
  process_settlement: {
    settled: boolean;
    task_busy: boolean;
    survivor_count: number;
  };
  diagnostics: string[];
}

const UNSAFE_FIELD =
  /(?:^|_)(?:prompt|content|authorization|cookie|credential|password|passwd|secret|session|token|api_?key|private_?key)(?:$|_)/i;
const UNSAFE_VALUE = [
  /\bAuthorization\s*:\s*Bearer\s+\S+/i,
  /\bBearer\s+(?:sk-|[A-Za-z0-9_-]{16,})/i,
  /\b(?:sk|key)-[A-Za-z0-9_-]{8,}/i,
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*\S+/,
];

function sanitizeString(value: string): string {
  return UNSAFE_VALUE.some((pattern) => pattern.test(value))
    ? "[REDACTED]"
    : value;
}

export function sanitizeEvidence(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (!value || typeof value !== "object") return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_FIELD.test(key)) continue;
    clean[key] = sanitizeEvidence(nested);
  }
  return clean;
}

function gate(passed: boolean, detail: string): AdmissionGateResult {
  return { passed, detail };
}

function toolLoopGate(
  observation: AdmissionObservation["toolLoop"],
): AdmissionGateResult {
  if (observation.malformedEvents > 0) {
    return gate(false, `${observation.malformedEvents} malformed tool event(s)`);
  }
  for (const kind of ["read", "edit", "command"] as const) {
    const calls = observation.calls.filter((call) => call.kind === kind);
    if (!calls.length) return gate(false, `missing ${kind} tool call`);
    if (calls.some((call) => !call.schemaValid)) {
      return gate(false, `invalid ${kind} tool schema`);
    }
    const successfulIds = new Set(
      observation.results
        .filter((result) => !result.isError)
        .map((result) => result.id),
    );
    if (!calls.some((call) => successfulIds.has(call.id))) {
      return gate(false, `missing successful paired ${kind} tool result`);
    }
  }
  return gate(true, "read, edit, and command calls had valid paired results");
}

export function reduceAdmission(
  observation: AdmissionObservation,
): AdmissionArtifact {
  const exactIdentity =
    observation.identity.requestedAlias === observation.alias
    && observation.identity.resolvedModel === observation.expectedResolvedModel
    && observation.identity.fallbackFree
    && observation.identity.trustedSource !== "incomplete";
  const bridgePassed =
    observation.operatorBridge.toolSucceeded
    && (
      !observation.operatorBridge.interactiveAskClaimed
      || observation.operatorBridge.interactiveAskSucceeded
    );
  const usagePassed =
    Number.isFinite(observation.usage.inputTokens)
    && observation.usage.inputTokens >= 0
    && Number.isFinite(observation.usage.outputTokens)
    && observation.usage.outputTokens >= 0
    && observation.usage.costStatus === "trusted"
    && observation.usage.costUsd !== null
    && Number.isFinite(observation.usage.costUsd)
    && observation.usage.costUsd >= 0
    && observation.providerReconciliation.complete
    && observation.providerReconciliation.generationIds.length > 0
    && observation.providerReconciliation.physicalModels.length === 1
    && observation.providerReconciliation.physicalModels[0] === observation.expectedResolvedModel
    && observation.providerReconciliation.providerCostUsd !== null
    && Number.isFinite(observation.providerReconciliation.providerCostUsd)
    && observation.providerReconciliation.providerCostUsd >= 0;

  const gates: AdmissionArtifact["gates"] = {
    identity: gate(
      exactIdentity,
      exactIdentity
        ? `exact alias resolved to ${observation.identity.resolvedModel}`
        : "alias, physical model, fallback policy, or trusted attribution was ambiguous",
    ),
    basic_turn: gate(
      observation.basicTurn.streamed && observation.basicTurn.coherent,
      observation.basicTurn.streamed && observation.basicTurn.coherent
        ? "coherent result streamed through the harness"
        : "streamed coherent result was not observed",
    ),
    tool_loop: toolLoopGate(observation.toolLoop),
    operator_bridge: gate(
      bridgePassed,
      bridgePassed
        ? "scoped Operator tool succeeded"
        : "Operator tool or claimed interactive ask did not complete",
    ),
    repository_result: gate(
      observation.repository.disposable
      && observation.repository.expectedEditPresent
      && observation.repository.testsPassed,
      observation.repository.disposable
      && observation.repository.expectedEditPresent
      && observation.repository.testsPassed
        ? "disposable fixture contains the expected edit and its tests pass"
        : "fixture was not disposable, expected edit was absent, or tests failed",
    ),
    resume: gate(
      observation.resume.sameSession && observation.resume.plantedFactRecalled,
      observation.resume.sameSession && observation.resume.plantedFactRecalled
        ? "same session resumed and recalled the planted fact"
        : "same-session recall was not proven",
    ),
    stop: gate(
      observation.stop.interruptRequested
      && observation.stop.settled
      && !observation.stop.taskBusy
      && observation.stop.survivingProcesses.length === 0,
      observation.stop.interruptRequested
      && observation.stop.settled
      && !observation.stop.taskBusy
      && observation.stop.survivingProcesses.length === 0
        ? "interrupt settled with no busy task or surviving process"
        : "interrupt did not settle cleanly or a process survived",
    ),
    usage: gate(
      usagePassed,
      usagePassed
        ? "token usage and trusted metered cost are recorded"
        : "token usage or trusted metered cost is incomplete",
    ),
    isolation: gate(
      observation.isolation.taskStateIsolated
      && observation.isolation.relayCredentialOnly
      && !observation.isolation.ambientCredentialLeak,
      observation.isolation.taskStateIsolated
      && observation.isolation.relayCredentialOnly
      && !observation.isolation.ambientCredentialLeak
        ? "task state is isolated and only the loopback relay credential was exposed"
        : "task state or credential isolation was not proven",
    ),
  };
  const status = Object.values(gates).every((result) => result.passed)
    ? "passed"
    : "failed";
  const diagnostics = sanitizeEvidence(observation.diagnostics ?? []) as string[];

  return {
    schema_version: 1,
    alias: observation.alias,
    resolved_model: observation.identity.resolvedModel,
    harness: observation.harness,
    harness_version: observation.harnessVersion,
    test_revision: observation.testRevision,
    tested_at: observation.testedAt,
    status,
    gates,
    session_id_sha256: observation.sessionId
      ? createHash("sha256").update(observation.sessionId).digest("hex")
      : null,
    usage: {
      input_tokens: observation.usage.inputTokens,
      output_tokens: observation.usage.outputTokens,
      cache_read_tokens: observation.usage.cacheReadTokens,
      cache_creation_tokens: observation.usage.cacheCreationTokens,
      cost_usd: observation.usage.costUsd,
      cost_status: observation.usage.costStatus,
    },
    provider_reconciliation: {
      generation_ids: [...observation.providerReconciliation.generationIds],
      physical_models: [...observation.providerReconciliation.physicalModels],
      providers: [...observation.providerReconciliation.providers],
      provider_cost_usd: observation.providerReconciliation.providerCostUsd,
      key_usage_delta_usd: observation.providerReconciliation.keyUsageDeltaUsd,
      complete: observation.providerReconciliation.complete,
    },
    process_settlement: {
      settled: observation.stop.settled,
      task_busy: observation.stop.taskBusy,
      survivor_count: observation.stop.survivingProcesses.length,
    },
    diagnostics,
  };
}

export function approvalRecord(artifact: AdmissionArtifact) {
  if (artifact.status !== "passed") {
    throw new Error("Cannot approve a failed admission artifact");
  }
  if (!artifact.resolved_model) {
    throw new Error("Cannot approve admission without an exact resolved model");
  }
  return {
    harness: artifact.harness,
    status: artifact.status,
    harness_version: artifact.harness_version,
    test_revision: artifact.test_revision,
    tested_at: artifact.tested_at,
    requested_alias: artifact.alias,
    resolved_model: artifact.resolved_model,
  };
}
