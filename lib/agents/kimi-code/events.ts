import type { StreamEvent as KimiStreamEvent } from "@moonshot-ai/kimi-agent-sdk";
import type { StreamEvent } from "../../types";
import {
  clip,
  describeToolUse,
  diffLines,
  resultText,
} from "../shared";

export interface KimiCodeMapState {
  calls: Map<string, string>;
  malformedEvents: string[];
  thinkingParts: number;
  interrupted: boolean;
  /**
   * A ToolCall whose arguments had not arrived yet: the Wire CLI may emit
   * ToolCall with empty arguments and stream the JSON via ToolCallPart deltas
   * (no id on parts - the protocol streams one call at a time). The tool
   * event is deferred and flushed with the accumulated arguments when its
   * ToolResult arrives, so titles/details reflect the real call instead of
   * an empty argument object.
   */
  pendingCall: { id: string; name: string; argumentsText: string } | null;
  latestTokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  } | null;
}

const MAX_DIAGNOSTICS = 20;
type KimiContentPart =
  | { type: "text"; text: string }
  | { type: "think"; think: string }
  | { type: string };
type KimiQuestionRequest = {
  tool_call_id: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multi_select?: boolean;
  }>;
};

export function newKimiCodeState(): KimiCodeMapState {
  return {
    calls: new Map(),
    malformedEvents: [],
    thinkingParts: 0,
    interrupted: false,
    pendingCall: null,
    latestTokenUsage: null,
  };
}

function toolEventFor(
  id: string,
  name: string,
  args: Record<string, unknown>,
): StreamEvent {
  const described = describedKimiTool(name, args);
  return {
    type: "tool",
    id,
    title: described.title,
    detail: described.detail,
    peek: described.peek,
    diff: described.diff,
  };
}

/** Emit the deferred tool event (if any), parsing whatever arguments arrived. */
function flushPendingCall(state: KimiCodeMapState): StreamEvent[] {
  const pending = state.pendingCall;
  if (!pending) return [];
  state.pendingCall = null;
  const args = toolArgs(pending.argumentsText, state, pending.id) ?? {};
  return [toolEventFor(pending.id, pending.name, args)];
}

function diagnostic(state: KimiCodeMapState, message: string): void {
  if (state.malformedEvents.length < MAX_DIAGNOSTICS) {
    state.malformedEvents.push(message);
  }
}

function toolArgs(
  raw: string | null | undefined,
  state: KimiCodeMapState,
  id: string,
): Record<string, unknown> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostic(state, `Tool ${id} arguments must be a JSON object`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    diagnostic(state, `Tool ${id} arguments were malformed JSON`);
    return null;
  }
}

function displayDiff(
  display: Array<Record<string, unknown>>,
): ReturnType<typeof diffLines> | undefined {
  const block = display.find((candidate) => candidate.type === "diff");
  if (
    !block
    || typeof block.old_text !== "string"
    || typeof block.new_text !== "string"
  ) {
    return undefined;
  }
  return diffLines(block.old_text, block.new_text);
}

function describedKimiTool(
  name: string,
  args: Record<string, unknown>,
): ReturnType<typeof describeToolUse> {
  switch (name) {
    case "ReadFile":
      return describeToolUse("Read", args);
    case "WriteFile":
      return describeToolUse("Write", args);
    case "Shell":
      return describeToolUse("Bash", args);
    case "StrReplaceFile": {
      const edit = Array.isArray(args.edit) ? args.edit[0] : args.edit;
      const normalizedEdit =
        edit && typeof edit === "object"
          ? edit as Record<string, unknown>
          : {};
      return describeToolUse("Edit", {
        ...args,
        old_string:
          typeof normalizedEdit.old === "string" ? normalizedEdit.old : "",
        new_string:
          typeof normalizedEdit.new === "string" ? normalizedEdit.new : "",
      });
    }
    default:
      return describeToolUse(name, args);
  }
}

export function mapKimiCodeEvent(
  event: KimiStreamEvent,
  state: KimiCodeMapState,
): StreamEvent[] {
  switch (event.type) {
    case "ContentPart":
      if ((event.payload as KimiContentPart).type === "text") {
        const part = event.payload as { type: "text"; text: string };
        return part.text.trim()
          ? [{ type: "assistant", content: part.text }]
          : [];
      }
      if ((event.payload as KimiContentPart).type === "think") state.thinkingParts += 1;
      return [];
    case "ToolCall": {
      const { id } = event.payload;
      if (!id || state.calls.has(id)) {
        const message = !id
          ? "Kimi Code emitted a tool call without an id"
          : `Kimi Code emitted duplicate tool call ${id}`;
        diagnostic(state, message);
        return [{ type: "error", content: message }];
      }
      // A new call ends any argument stream still open for the previous one.
      const flushed = flushPendingCall(state);
      const name = event.payload.function.name;
      const rawArguments = event.payload.function.arguments;
      state.calls.set(id, name);
      // No argument bytes yet: the Wire CLI streams them as ToolCallPart
      // deltas. Defer the tool event until the arguments are complete rather
      // than describing an empty argument object (which produced blank,
      // unclassifiable titles live on 2026-08-16).
      if (typeof rawArguments !== "string" || !rawArguments.trim()) {
        state.pendingCall = { id, name, argumentsText: rawArguments ?? "" };
        return flushed;
      }
      const args = toolArgs(rawArguments, state, id);
      if (!args) {
        return [...flushed, {
          type: "error",
          content: `Kimi Code tool ${id} had malformed arguments`,
        }];
      }
      return [...flushed, toolEventFor(id, name, args)];
    }
    case "ToolCallPart": {
      if (state.pendingCall) {
        state.pendingCall.argumentsText += event.payload.arguments_part ?? "";
      }
      return [];
    }
    case "ToolResult": {
      const flushed = flushPendingCall(state);
      const id = event.payload.tool_call_id;
      if (!state.calls.has(id)) {
        const message = `Kimi Code emitted orphan tool result ${id}`;
        diagnostic(state, message);
        return [...flushed, { type: "error", content: message }];
      }
      state.calls.delete(id);
      const value = event.payload.return_value;
      const display = value.display as Array<Record<string, unknown>>;
      return [...flushed, {
        type: "tool_result",
        id,
        content: clip(resultText(value.output), 6_000),
        isError: value.is_error,
        ...(displayDiff(display) ? {
          peek: {
            kind: "diff" as const,
            added: displayDiff(display)!.filter((line) => line.sign === "+").length,
            removed: displayDiff(display)!.filter((line) => line.sign === "-").length,
            lines: displayDiff(display)!.slice(0, 14),
          },
        } : {}),
      }];
    }
    case "StatusUpdate": {
      const usage = event.payload.token_usage;
      if (!usage) return [];
      state.latestTokenUsage = {
        inputTokens: usage.input_other,
        outputTokens: usage.output,
        cacheReadTokens: usage.input_cache_read,
        cacheCreationTokens: usage.input_cache_creation,
      };
      return [];
    }
    case "QuestionRequest": {
      const payload = event.payload as KimiQuestionRequest;
      return [{
        type: "ask",
        id: payload.tool_call_id,
        questions: payload.questions.map((question) => ({
          question: question.question,
          header: question.header ?? "Question",
          options: question.options,
          multiSelect: question.multi_select,
        })),
      }];
    }
    case "ApprovalRequest":
      return [{
        type: "notice",
        content: `Kimi Code requested approval for ${event.payload.action}: ${event.payload.description}`,
      }];
    case "StepInterrupted":
      state.interrupted = true;
      return [];
    case "SubagentEvent":
      return [{
        type: "notice",
        content: `Kimi Code subagent event: ${event.payload.event.type}`,
      }];
    case "CompactionBegin":
      return [{ type: "notice", content: "Kimi Code is compacting context." }];
    case "CompactionEnd":
      return [{ type: "notice", content: "Kimi Code finished compacting context." }];
    case "ParseError": {
      const message = `Kimi Code protocol error: ${event.payload.message}`;
      diagnostic(state, message);
      return [{ type: "error", content: message }];
    }
    case "TurnBegin":
    case "TurnEnd":
    case "StepBegin":
    case "SteerInput":
    case "ApprovalResponse":
    case "HookTriggered":
    case "HookResolved":
      return [];
    default:
      return [];
  }
}
