import {
  reduceAdmission,
  type AdmissionArtifact,
  type AdmissionHarness,
  type AdmissionObservation,
  type AdmissionToolKind,
} from "./admission";
import type { StreamEvent } from "../types";

export interface AdmissionPairing {
  alias: string;
  expectedResolvedModel: string;
  harness: AdmissionHarness;
  harnessVersion: string;
  testRevision: string;
  /**
   * Whether the harness declares the Operator tool bridge
   * (AgentCapabilities.supportsMcpTools). False waives the operator_bridge
   * gate with an explicit waiver detail in the artifact; it never fabricates
   * bridge evidence.
   */
  requiresOperatorBridge: boolean;
  requiresInteractiveAsk: boolean;
}

type IdentityAndUsage = Pick<
  AdmissionObservation,
  "identity" | "usage" | "providerReconciliation"
> & {
  diagnostics?: string[];
};

export interface AdmissionStopResult {
  events: StreamEvent[];
  interruptRequested: boolean;
  settled: boolean;
  taskBusy: boolean;
  survivingProcesses: string[];
}

export interface AdmissionTransport {
  runFresh(): Promise<StreamEvent[]>;
  runResume(): Promise<StreamEvent[]>;
  runStop(onEvent: (event: StreamEvent) => void): Promise<AdmissionStopResult>;
  verifyRepository(): Promise<AdmissionObservation["repository"]>;
  reconcileIdentityAndCost(): Promise<IdentityAndUsage>;
  verifyIsolation(): Promise<AdmissionObservation["isolation"]>;
}

export interface ExecuteAdmissionOptions {
  pairing: AdmissionPairing;
  transport: AdmissionTransport;
  optIn: boolean;
  /**
   * Deliberately never invoked. It exists only as a contract-test tripwire:
   * running admission produces evidence, never catalog/gateway mutations.
   */
  onMetadataWrite?: () => void;
}

function sessionFrom(events: StreamEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "done" && event.sessionId) return event.sessionId;
    if (event.type === "session") return event.sessionId;
  }
  return null;
}

function isCoherent(events: StreamEvent[]): boolean {
  return events.some(
    (event) => event.type === "assistant" && event.content.trim().length > 0,
  ) && !events.some((event) => event.type === "error");
}

function classifyTool(
  title: string,
  detail: string,
): AdmissionToolKind | null {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "");
  if (/^ipython\b/.test(normalized)) {
    if (
      /(?:\.read_text\s*\(|\.read_bytes\s*\(|\bopen\s*\([^)]*,\s*["']r)/i.test(detail)
    ) {
      return "read";
    }
    if (
      /(?:\.write_text\s*\(|\.write_bytes\s*\(|\bopen\s*\([^)]*,\s*["'][wa])/i.test(detail)
    ) {
      return "edit";
    }
    return "command";
  }
  if (/^(read|search|find|list|glob|grep)\b/.test(normalized)) return "read";
  if (/^(edit|write|create|patch)\b/.test(normalized)) return "edit";
  if (/^(run|bash|command|execute|npm|pnpm|yarn|bun|python|ipython|pytest|git)\b/.test(normalized)) {
    return "command";
  }
  return null;
}

function toolEvidence(events: StreamEvent[]): AdmissionObservation["toolLoop"] {
  const calls: AdmissionObservation["toolLoop"]["calls"] = [];
  const results: AdmissionObservation["toolLoop"]["results"] = [];
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  let malformedEvents = 0;

  for (const event of events) {
    if (event.type === "tool") {
      const kind = classifyTool(event.title, event.detail);
      const schemaValid =
        typeof event.id === "string"
        && event.id.length > 0
        && typeof event.title === "string"
        && event.title.length > 0;
      if (!schemaValid || callIds.has(event.id)) malformedEvents += 1;
      callIds.add(event.id);
      if (kind) calls.push({ id: event.id, kind, schemaValid: true });
    } else if (event.type === "tool_result") {
      if (!callIds.has(event.id)) malformedEvents += 1;
      if (resultIds.has(event.id)) malformedEvents += 1;
      resultIds.add(event.id);
      results.push({ id: event.id, isError: event.isError });
    }
  }

  for (const id of callIds) {
    if (!results.some((result) => result.id === id)) malformedEvents += 1;
  }
  return { calls, results, malformedEvents };
}

function bridgeEvidence(
  events: StreamEvent[],
  requiresOperatorBridge: boolean,
  requiresInteractiveAsk: boolean,
): AdmissionObservation["operatorBridge"] {
  const asks = new Set(
    events.filter((event) => event.type === "ask").map((event) => event.id),
  );
  const answered = new Set(
    events
      .filter((event) => event.type === "ask_answered")
      .map((event) => event.id),
  );
  return {
    required: requiresOperatorBridge,
    toolSucceeded:
      events.some((event) => event.type === "suggested")
      || events.some(
        (event) =>
          event.type === "tool"
          && /(?:^|\b)(?:suggest_task|expose_service|publish_artifact|publish_workstream_update|propose_card_change)(?:\b|$)/i.test(event.title)
          && events.some(
            (result) =>
              result.type === "tool_result"
              && result.id === event.id
              && !result.isError,
          ),
      )
      || events.some(
        (event) =>
          event.type === "notice"
          && /service|artifact|workstream|card/i.test(event.content),
      ),
    interactiveAskClaimed: requiresInteractiveAsk,
    interactiveAskSucceeded:
      !requiresInteractiveAsk
      || (asks.size > 0 && [...asks].every((id) => answered.has(id))),
  };
}

/**
 * Surface the actual error text a run emitted: gate details alone ("stop run
 * emitted an error event") proved undiagnosable after the fact on Aug 13 -
 * the transcript lives in a throwaway test DB that is gone by the time anyone
 * reads the artifact. Contents pass through reduceAdmission's sanitizer, so a
 * secret-bearing message is redacted rather than recorded.
 */
function errorContentDiagnostics(
  label: string,
  events: StreamEvent[],
): string[] {
  return events
    .filter((event): event is Extract<StreamEvent, { type: "error" }> => event.type === "error")
    .slice(0, 5)
    .map((event, index) => `${label} error[${index}]: ${event.content.slice(0, 500)}`);
}

function eventCountDiagnostic(
  label: string,
  events: StreamEvent[],
): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  const summary = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  return `${label} event counts: ${summary || "(none)"}`;
}

export async function executeAdmission(
  options: ExecuteAdmissionOptions,
): Promise<AdmissionArtifact> {
  if (!options.optIn) {
    throw new Error("Live model admission requires explicit opt-in");
  }

  const fresh = await options.transport.runFresh();
  const resume = await options.transport.runResume();
  const stopEvents: StreamEvent[] = [];
  const stop = await options.transport.runStop((event) => {
    stopEvents.push(event);
  });
  const repository = await options.transport.verifyRepository();
  const reconciled = await options.transport.reconcileIdentityAndCost();
  const isolation = await options.transport.verifyIsolation();
  const freshSession = sessionFrom(fresh);
  const resumedSession = sessionFrom(resume);
  const allStopEvents = [...stopEvents, ...stop.events];
  const stopEmittedError = allStopEvents.some(
    (event) => event.type === "error",
  );

  return reduceAdmission({
    alias: options.pairing.alias,
    expectedResolvedModel: options.pairing.expectedResolvedModel,
    harness: options.pairing.harness,
    harnessVersion: options.pairing.harnessVersion,
    testRevision: options.pairing.testRevision,
    testedAt: new Date().toISOString(),
    sessionId: freshSession,
    identity: reconciled.identity,
    basicTurn: {
      streamed: fresh.some(
        (event) => event.type === "assistant" || event.type === "tool",
      ),
      coherent: isCoherent(fresh),
    },
    toolLoop: toolEvidence(fresh),
    operatorBridge: bridgeEvidence(
      fresh,
      options.pairing.requiresOperatorBridge,
      options.pairing.requiresInteractiveAsk,
    ),
    repository,
    resume: {
      sameSession:
        freshSession !== null
        && resumedSession !== null
        && resumedSession === freshSession,
      // Join the assistant stream before searching: harnesses that emit raw
      // streaming text parts (Kimi Code) can split the fact across chunk
      // boundaries, which made this gate flap run to run on 2026-08-16.
      plantedFactRecalled: resume
        .filter((event) => event.type === "assistant")
        .map((event) => event.content)
        .join("")
        .includes("PLANTED_FACT_7391"),
    },
    stop: {
      interruptRequested: stop.interruptRequested,
      settled: stop.settled && !stopEmittedError,
      taskBusy: stop.taskBusy,
      survivingProcesses: stop.survivingProcesses,
    },
    usage: reconciled.usage,
    providerReconciliation: reconciled.providerReconciliation,
    isolation,
    diagnostics: [
      ...(reconciled.diagnostics ?? []),
      eventCountDiagnostic("fresh", fresh),
      eventCountDiagnostic("resume", resume),
      eventCountDiagnostic("stop", allStopEvents),
      ...errorContentDiagnostics("fresh", fresh),
      ...errorContentDiagnostics("resume", resume),
      ...errorContentDiagnostics("stop", allStopEvents),
      ...(allStopEvents.some((event) => event.type === "error")
        ? ["stop run emitted an error event"]
        : []),
    ],
  });
}
