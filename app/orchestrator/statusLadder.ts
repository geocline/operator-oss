// The single status-dot ladder shared by task rows (TasksColumn/TaskBoard) and
// project rows (ProjectsColumn). One dot, hard precedence: awaiting (amber,
// you're needed) beats running (blue, live) beats unviewed (green, a local
// "you haven't looked at this yet" marker) beats idle (nothing to say).
//
// Awaiting is derived the same way app/orchestrator/format.ts's isAwaiting
// does (status === "in_progress" && awaiting_input) - that stays the single
// source of truth for "is this task waiting on you"; this file mirrors the
// same two fields rather than importing the TaskRow-typed helper so it can
// take the minimal shape callers already have (a task row, a board card, or a
// project rollup) without widening to the full client type.
//
// Registry fold (batch two, Package F3): registry.ts only imports RowStatus
// as a type, so importing its contributor list here isn't a real cycle.
import { sessionStatusContributions } from "./registry";

export type RowStatus =
  | { kind: "awaiting"; label: "Needs your input" }
  | { kind: "running"; label: "Working" }
  | { kind: "unviewed"; label: "Finished while you were away" }
  | { kind: "none" };

export function rowStatus(
  task: { status: string; awaiting_input: number | boolean },
  opts: { running: boolean; unviewed: boolean },
): RowStatus {
  const awaiting = task.status === "in_progress" && !!task.awaiting_input;
  if (awaiting) return { kind: "awaiting", label: "Needs your input" };
  if (opts.running) return { kind: "running", label: "Working" };
  if (opts.unviewed) return { kind: "unviewed", label: "Finished while you were away" };
  // Registered contributors sit below every built-in, in registration order;
  // the first to return non-null wins. Empty this batch, so this is a no-op.
  for (const contribute of sessionStatusContributions()) {
    const result = contribute(task, opts);
    if (result) return result;
  }
  return { kind: "none" };
}
