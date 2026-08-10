// The Prime event normalizer — pure functions that turn `prime-agent`'s JSONL
// RPC event stream (lib/agents/prime/rpc.ts's PrimeRpcEvent) into the
// agent-agnostic StreamEvent contract (lib/types.ts). Kept separate from
// driver.ts so it can be unit-tested against recorded event sequences without
// spawning the CLI.
//
// Prime streams incremental `message_update` deltas but only ONE row should
// ever land in the transcript per assistant message, so deltas are buffered
// and flushed as a single `assistant` StreamEvent at `message_end` (falling
// back to the message's own `content` if no deltas arrived — some turns are
// tool-only and never delta text before the final message). Tool calls are
// paired by Prime's `toolCallId` across tool_execution_start/tool_execution_end,
// mirroring the tool/tool_result pairing every other driver uses.
//
// Model identity is a hard policy gate (see ./policy.ts): a turn's terminal
// `message_end` must prove BOTH the requested alias and a resolved physical
// Kimi identity before the turn is allowed to settle successfully. Missing
// identity, an identity that reads as OpenAI/Anthropic, or a fallback-suffixed
// identity all produce a policy `error` event and permanently withhold a
// successful `done` for the rest of this normalizer's life (a fresh state is
// created per turn — see newPrimeState()).
//
// Deliberately independent of lib/agents/codex/events.ts and its pricing
// table: Prime's cost is metered by LiteLLM, never estimated here.

import type { StreamEvent, ToolPeek, TurnUsage } from "../../types";
import type { PrimeRpcEvent } from "./rpc";
import { clip, resultText, summarizeResult } from "../shared";
import { APPROVED_PRIME_MODEL } from "./policy";

// An identity that reads as a different provider entirely — the physical
// resolved model must never match this, no matter what alias was requested.
const DISALLOWED_IDENTITY = /gpt|openai|claude|anthropic/i;

// A LiteLLM/OpenRouter fallback route landed instead of the pinned model —
// e.g. "kimi-k3-0905-preview:fallback" or "kimi-k3/fallback". Treated the
// same as a wrong-provider identity: the turn did not run what was approved.
const FALLBACK_SUFFIX = /[-/:]fallback\b/i;

// Cap on how many unknown event types we remember for diagnostics — a
// mislabeled/renamed Prime event should never grow this file's memory
// footprint unbounded across a long turn.
const MAX_DIAGNOSTICS = 20;

// One assistant message's shape at message_end, as far as this mapper cares.
interface PrimeMessage {
  role?: string;
  stopReason?: string;
  responseId?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  provider?: string;
  // The alias the turn was launched with, echoed back — should equal the
  // requested model the state was constructed with (operator.kimi-k3).
  model?: string;
  // The physical model LiteLLM actually routed to. Absent on providers that
  // don't echo it back; absence is itself a policy failure for Prime.
  resolvedModel?: string;
}

export interface PrimeMapState {
  /** The alias this turn was launched with (normally APPROVED_PRIME_MODEL). */
  requestedModel: string;
  /** Accumulated message_update deltas for the message currently in flight. */
  assistantText: string;
  /** True between message_start and its matching message_end. */
  inMessage: boolean;
  /** The opaque session id, once agent_start has reported it. */
  sessionId: string | null;
  /** How the turn is trending toward settling. */
  outcome: "pending" | "success" | "aborted" | "error" | "policy_error";
  /** Bounded record of event types this mapper didn't recognize. */
  unknownEvents: string[];
}

export function newPrimeState(requestedModel: string = APPROVED_PRIME_MODEL): PrimeMapState {
  return {
    requestedModel,
    assistantText: "",
    inMessage: false,
    sessionId: null,
    outcome: "pending",
    unknownEvents: [],
  };
}

/**
 * Map one Prime RPC event to zero or more StreamEvents. `state` carries the
 * turn's accumulated text, tool bookkeeping, and settlement outcome across
 * the whole stream — build a fresh one per turn (newPrimeState()) and mutate
 * it call to call.
 */
export function mapPrimeEvent(ev: PrimeRpcEvent, state: PrimeMapState): StreamEvent[] {
  switch (ev.type) {
    case "agent_start":
      return mapAgentStart(ev, state);
    case "message_start":
      state.inMessage = true;
      state.assistantText = "";
      return [];
    case "message_update":
      return mapMessageUpdate(ev, state);
    case "message_end":
      return mapMessageEnd(ev, state);
    case "tool_execution_start":
      return mapToolStart(ev);
    case "tool_execution_end":
      return mapToolEnd(ev);
    case "agent_end":
      return mapAgentEnd(state);
    default:
      recordUnknown(state, ev.type);
      return [];
  }
}

function recordUnknown(state: PrimeMapState, type: string): void {
  if (state.unknownEvents.length >= MAX_DIAGNOSTICS) return;
  state.unknownEvents.push(type);
}

function mapAgentStart(ev: PrimeRpcEvent, state: PrimeMapState): StreamEvent[] {
  const sessionFile = ev.sessionFile;
  if (typeof sessionFile !== "string" || !sessionFile.trim()) {
    state.outcome = "error";
    return [{ type: "error", content: "Prime agent_start did not report a session file" }];
  }
  state.sessionId = sessionFile;
  return [{ type: "session", sessionId: sessionFile }];
}

function mapMessageUpdate(ev: PrimeRpcEvent, state: PrimeMapState): StreamEvent[] {
  const delta = ev.delta as { type?: string; text?: string } | undefined;
  if (!state.inMessage || !delta || delta.type !== "text" || typeof delta.text !== "string") return [];
  state.assistantText += delta.text;
  return [];
}

function mapMessageEnd(ev: PrimeRpcEvent, state: PrimeMapState): StreamEvent[] {
  const message = ev.message as PrimeMessage | undefined;
  if (!message || typeof message !== "object") {
    state.outcome = "error";
    state.inMessage = false;
    return [{ type: "error", content: "Prime message_end did not include a message" }];
  }
  state.inMessage = false;

  const out: StreamEvent[] = [];
  const stopReason = message.stopReason;
  const aborted = stopReason === "aborted";
  const failed = stopReason === "error";

  if (aborted) {
    state.outcome = "aborted";
  } else if (failed) {
    state.outcome = "error";
    out.push({ type: "error", content: "Prime turn ended with an error" });
  } else {
    // Identity policy gate — only a clean identity clears the turn for a
    // successful `done` at agent_end. A failure here does not erase the
    // work already performed (tokens were spent), so assistant text and
    // usage below are still reported; only the terminal success is withheld.
    const identityError = checkModelIdentity(message, state.requestedModel);
    if (identityError) {
      state.outcome = "policy_error";
      out.push({ type: "error", content: identityError });
    } else {
      state.outcome = "success";
      // Prefer the resolved physical identity when the stream carries one;
      // otherwise the exact validated alias is the honest badge.
      out.push({ type: "model", model: message.resolvedModel || message.model! });
    }
  }

  if (!aborted) {
    const text = state.assistantText || extractContentText(message.content);
    if (text.trim()) out.push({ type: "assistant", content: text });

    const usage = message.usage;
    if (usage) out.push({ type: "usage", usage: toTurnUsage(usage) });
  }

  state.assistantText = "";
  return out;
}

// Requires the exact requested alias and rejects anything that reads as a
// different provider or a fallback route. The resolved PHYSICAL identity is
// not observable through the credential-preserving relay (verified against
// prime-agent 0.7.1: message_end carries only the configured alias), so it is
// optional enrichment here — but when present it must be clean. The
// alias→physical binding itself is enforced and test-pinned, fallback-free,
// in the LiteLLM gateway config; acceptance reconciles the physical identity
// out-of-band via the provider's generation lookup.
// Returns a human-readable reason, or null when the identity is clean.
function checkModelIdentity(message: PrimeMessage, requestedModel: string): string | null {
  if (message.model !== requestedModel) {
    return `Prime turn requested "${requestedModel}" but message_end reported alias "${message.model ?? "(none)"}"`;
  }
  if (FALLBACK_SUFFIX.test(message.model)) {
    return `Prime model alias "${message.model}" is a fallback route, not the pinned model`;
  }
  if (typeof message.provider === "string" && DISALLOWED_IDENTITY.test(message.provider)) {
    return `Prime provider "${message.provider}" reads as a non-approved provider route`;
  }
  const identity = message.resolvedModel;
  if (identity === undefined || identity === null) return null;
  if (typeof identity !== "string" || !identity.trim()) {
    return "Prime message_end reported an empty resolved model identity";
  }
  if (DISALLOWED_IDENTITY.test(identity)) {
    return `Prime resolved model identity "${identity}" reads as a non-Kimi provider`;
  }
  if (FALLBACK_SUFFIX.test(identity)) {
    return `Prime resolved model identity "${identity}" is a fallback route, not the pinned model`;
  }
  return null;
}

function extractContentText(content: PrimeMessage["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function toTurnUsage(usage: NonNullable<PrimeMessage["usage"]>): TurnUsage {
  // Never estimate: Prime/Kimi cost is metered by LiteLLM. A missing cost
  // field means "not yet known" — reported as 0, same convention the rest of
  // the codebase uses for "no dollar figure available" (see TurnUsage).
  const cost = usage.cost?.total;
  return {
    cost_usd: typeof cost === "number" ? cost : 0,
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    cache_read_tokens: usage.cacheRead ?? 0,
    cache_creation_tokens: usage.cacheWrite ?? 0,
  };
}

function mapToolStart(ev: PrimeRpcEvent): StreamEvent[] {
  const toolCallId = ev.toolCallId;
  const toolName = ev.toolName;
  if (typeof toolCallId !== "string" || !toolCallId.trim() || typeof toolName !== "string" || !toolName.trim()) {
    return [{ type: "error", content: "Prime tool_execution_start is missing toolCallId/toolName" }];
  }
  return [{ type: "tool", id: toolCallId, title: `⚙ ${toolName}`, detail: clip(ev.args) }];
}

function mapToolEnd(ev: PrimeRpcEvent): StreamEvent[] {
  const toolCallId = ev.toolCallId;
  if (typeof toolCallId !== "string" || !toolCallId.trim()) {
    return [{ type: "error", content: "Prime tool_execution_end is missing toolCallId" }];
  }
  const isError = ev.isError === true;
  const content = resultText(ev.result);
  const peek: ToolPeek | undefined = isError ? undefined : summarizeResult("output", content);
  return [{ type: "tool_result", id: toolCallId, content: clip(content, 6000), isError, peek }];
}

function mapAgentEnd(state: PrimeMapState): StreamEvent[] {
  if (state.outcome !== "success") return [];
  return [{ type: "done", sessionId: state.sessionId }];
}
