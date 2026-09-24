import type { ToolData } from "@/lib/types";
import type { Msg } from "./types";

// Transcript noise control: the agent's machinery (tool calls, plus the
// in-between narration like "Fixing and rerunning") folds into one "worked"
// row per stretch, so a finished turn reads as: your message, one row, the
// answer. Nothing is dropped - each row opens on its own to show every step.
//
// A turn is everything from one user message to the next. Finished turn: the
// LAST assistant message is the answer and stays visible; every tool call and
// every earlier assistant chunk folds. Live turn (the last turn while the task
// is running): nothing is the answer yet, so everything foldable sits in one
// live "Working" row that shows only its latest step. Anything else - system
// notices, ask cards, the user's own messages - always renders inline and
// splits the fold, so order stays true.

export interface WorkItem { m: Msg; index: number }
export type TranscriptItem =
  | { kind: "msg"; m: Msg; index: number; hideWho: boolean }
  | { kind: "work"; id: string; items: WorkItem[]; live: boolean; steps: number; failed: number; startedAt?: number; endedAt?: number };

function toolData(m: Msg): ToolData | null {
  if (m.role !== "tool") return null;
  try { return JSON.parse(m.content) as ToolData; } catch { return { title: m.content }; }
}

export function groupTranscript(messages: Msg[], live: boolean): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  // Turn boundaries: each user message starts a new turn (the stretch before
  // the first user message, if any, is its own turn).
  const starts: number[] = [0];
  messages.forEach((m, i) => { if (m.role === "user" && i > 0) starts.push(i); });
  starts.forEach((start, t) => {
    const end = t + 1 < starts.length ? starts[t + 1] : messages.length;
    const liveTurn = live && t === starts.length - 1;
    let finalIdx = -1;
    if (!liveTurn) {
      for (let i = end - 1; i >= start; i -= 1) if (messages[i].role === "assistant") { finalIdx = i; break; }
    }
    const tools = new Map<number, ToolData | null>();
    const foldable = (i: number) => {
      const m = messages[i];
      if (m.role === "assistant") return i !== finalIdx;
      if (m.role !== "tool") return false;
      const d = toolData(m);
      tools.set(i, d);
      return !d?.ask; // ask cards are a conversation with you, never folded
    };
    let seenAssistant = false;
    const pushMsg = (i: number) => {
      const m = messages[i];
      const hideWho = m.role === "assistant" && seenAssistant;
      if (m.role === "assistant") seenAssistant = true;
      out.push({ kind: "msg", m, index: i, hideWho });
    };
    let i = start;
    while (i < end) {
      if (!foldable(i)) { pushMsg(i); i += 1; continue; }
      let j = i;
      while (j < end && foldable(j)) j += 1;
      const items: WorkItem[] = [];
      for (let k = i; k < j; k += 1) items.push({ m: messages[k], index: k });
      const toolItems = items.filter((it) => it.m.role === "tool");
      const runLive = liveTurn && j === end;
      // A stretch folds when it's live (the one "Working" row), or when it has
      // real machinery in it and folding saves space. A lone tool call is
      // already a single line, and prose with no tools is conversation.
      if (runLive || (toolItems.length > 0 && items.length > 1)) {
        const after = finalIdx >= j ? messages[finalIdx] : undefined;
        out.push({
          kind: "work",
          id: `work-${items[0].m.id}`,
          items,
          live: runLive,
          steps: toolItems.length,
          failed: toolItems.filter((it) => tools.get(it.index)?.isError).length,
          startedAt: items[0].m.createdAt,
          endedAt: after?.createdAt ?? items[items.length - 1].m.createdAt,
        });
      } else {
        for (let k = i; k < j; k += 1) pushMsg(k);
      }
      i = j;
    }
  });
  return out;
}

// "4m 12s" style, for the finished row's "Worked for ..." label.
export function workDuration(startMs?: number, endMs?: number): string | null {
  if (!startMs || !endMs || endMs < startMs) return null;
  const s = Math.round((endMs - startMs) / 1000);
  if (s < 1) return null;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function workLabel(g: Extract<TranscriptItem, { kind: "work" }>): string {
  const steps = g.steps ? `${g.steps} step${g.steps === 1 ? "" : "s"}` : "";
  if (g.live) return ["Working", steps].filter(Boolean).join(" · ");
  const dur = workDuration(g.startedAt, g.endedAt);
  return [dur ? `Worked for ${dur}` : "Worked", steps].filter(Boolean).join(" · ");
}
