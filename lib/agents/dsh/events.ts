// The dsh event normalizer — pure functions that turn dsh's `session.event`
// notification payloads (SessionEvent from the real `@deepseek-ai/dsh-session`
// wire vocabulary, captured live against the packaged jsonrpc-agent runtime -
// see docs/superpowers/specs/2026-08-16-litellm-dsh-driver.md for the
// handshake transcript) into the agent-agnostic StreamEvent contract
// (lib/types.ts). Kept separate from driver.ts so it can be unit-tested
// against recorded/synthetic event sequences without spawning the binary.
//
// Unlike Prime (which streams incremental deltas with no assembled final
// text), dsh's `assistant/message` event already carries the assembled
// `message.content` for the step, so the mapper reads that directly instead
// of accumulating `assistant/chunk` text-delta events - simpler and matches
// the real protocol's own description ("Assembled assistant message for one
// step (derived history uses this)").
//
// dsh's TokenUsage (packages/llm/llm/src/types.ts) has no cost field - cost is
// metered by LiteLLM, never estimated here (same convention as Prime/Kimi).
// Kimi's precedent (lib/agents/kimi-code/events.ts) is followed exactly:
// token counts are tracked but no "usage" StreamEvent is emitted (there is no
// trusted dollar figure to attach to it); the driver surfaces a "notice"
// instead once the turn settles.

import type { DiffLine, StreamEvent, ToolPeek } from "../../types";
import { clip, describeToolUse, resultText } from "../shared";

const MAX_DIAGNOSTICS = 20;

export interface DshTrackedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface DshMapState {
  outcome: "pending" | "success" | "aborted" | "error";
  latestTokenUsage: DshTrackedUsage | null;
  unknownEvents: string[];
}

export function newDshState(): DshMapState {
  return {
    outcome: "pending",
    latestTokenUsage: null,
    unknownEvents: [],
  };
}

function recordUnknown(state: DshMapState, type: string): void {
  if (state.unknownEvents.length >= MAX_DIAGNOSTICS) return;
  state.unknownEvents.push(type);
}

// One `session.event` notification's `event` field: { type, seq, time, data }.
export type DshSessionEvent = { type: string; seq?: number; time?: number; data?: unknown };

/**
 * Map one dsh `session.event` payload to zero or more StreamEvents. `state`
 * carries token-usage bookkeeping and the turn's settlement outcome across
 * the whole stream - build a fresh one per turn (newDshState()) and mutate it
 * call to call, mirroring lib/agents/prime/events.ts's mapPrimeEvent.
 */
export function mapDshEvent(event: DshSessionEvent, state: DshMapState): StreamEvent[] {
  switch (event.type) {
    case "assistant/message":
      return mapAssistantMessage(event, state);
    case "tool/call":
      return mapToolCall(event);
    case "tool/result":
      return mapToolResult(event);
    case "turn/end":
      return mapTurnEnd(event, state);
    default:
      recordUnknown(state, event.type);
      return [];
  }
}

interface TextLikeBlock {
  type?: string;
  text?: string;
}

function joinText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as TextLikeBlock[])
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

interface TokenUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function mapAssistantMessage(event: DshSessionEvent, state: DshMapState): StreamEvent[] {
  const data = event.data as { message?: { content?: unknown }; usage?: TokenUsagePayload } | undefined;
  const out: StreamEvent[] = [];
  const text = joinText(data?.message?.content);
  if (text.trim()) out.push({ type: "assistant", content: text });
  const usage = data?.usage;
  if (usage) {
    state.latestTokenUsage = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreationTokens: usage.cacheWriteTokens ?? 0,
    };
  }
  return out;
}

function mapToolCall(event: DshSessionEvent): StreamEvent[] {
  const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined;
  const callId = data?.callId;
  const name = data?.name;
  if (typeof callId !== "string" || !callId.trim() || typeof name !== "string" || !name.trim()) {
    return [{ type: "error", content: "dsh tool/call is missing callId/name" }];
  }
  let args: Record<string, unknown> = {};
  if (typeof data?.arguments === "string" && data.arguments.trim()) {
    try {
      const parsed: unknown = JSON.parse(data.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      // Malformed JSON arguments render generically below (describeToolUse
      // still gets a title from the raw tool name).
    }
  }
  const described = describedDshTool(name, args);
  const out: StreamEvent = { type: "tool", id: callId, title: described.title, detail: described.detail };
  if (described.peek) out.peek = described.peek;
  if (described.diff) out.diff = described.diff as DiffLine[];
  return [out];
}

// dsh's own tool schema already uses Claude's field vocabulary (file_path,
// old_string/new_string, content, command) - captured live from the real
// request/header tool schema - so only the NAME needs translating into the
// shared describeToolUse() vocabulary.
function describedDshTool(name: string, args: Record<string, unknown>): ReturnType<typeof describeToolUse> {
  switch (name) {
    case "read":
      return describeToolUse("Read", args);
    case "write":
      return describeToolUse("Write", args);
    case "edit":
      return describeToolUse("Edit", args);
    case "bash":
      return describeToolUse("Bash", args);
    default:
      return describeToolUse(name, args);
  }
}

interface ToolResultBlockPayload {
  type?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: unknown;
}

function mapToolResult(event: DshSessionEvent): StreamEvent[] {
  const data = event.data as {
    message?: { content?: ToolResultBlockPayload[] };
    error?: { message?: string; code?: string };
  } | undefined;
  const block = data?.message?.content?.[0];
  const toolCallId = block?.toolCallId;
  if (typeof toolCallId !== "string" || !toolCallId.trim()) {
    return [{ type: "error", content: "dsh tool/result is missing toolCallId" }];
  }
  const isError = block?.isError === true || !!data?.error;
  const content = resultText(joinText(block?.content) || block?.content);
  const peek: ToolPeek | undefined = isError
    ? undefined
    : { kind: "count", text: content.trim() ? `${content.split("\n").length} line(s)` : "No output" };
  return [{ type: "tool_result", id: toolCallId, content: clip(content, 6_000), isError, ...(peek ? { peek } : {}) }];
}

function mapTurnEnd(event: DshSessionEvent, state: DshMapState): StreamEvent[] {
  const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason;
  const kind = reason?.kind;
  if (kind === "completed" || kind === "max-tokens") {
    state.outcome = "success";
    return [];
  }
  if (kind === "aborted") {
    state.outcome = "aborted";
    return [];
  }
  state.outcome = "error";
  const message = reason?.error?.message || `dsh turn ended with reason "${kind ?? "unknown"}"`;
  return [{ type: "error", content: `dsh turn failed: ${message}` }];
}
