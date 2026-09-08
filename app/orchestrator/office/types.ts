// Local mirror of the office view's server contract (tasks/todo.md
// "Operator API" section). Kept in this directory (not app/orchestrator/types.ts,
// which this agent must not touch) since it's specific to the office view and
// other agents are landing the backend routes in parallel.

import type { Recipe } from "./portraitArt";

export interface OfficeProjectRef {
  id: string;
  name: string;
}

export interface OfficeTask {
  id: string;
  project_id: string;
  title: string;
  status: string; // "not_started" | "in_progress" | "on_hold" (done/cancelled excluded server-side)
  running: number; // 0 | 1
  awaiting_input: number; // 0 | 1
  started: number; // 0 | 1
  agent: string | null;
  priority: string | null;
  updated_at: number;
  turn_started_at: number | null;
  display_name: string; // '' when unset
  avatar: Recipe | null;
  latest_note: { content: string; created_at: number } | null;
  card_url: string | null;
}

export interface OfficePayload {
  projects: OfficeProjectRef[];
  tasks: OfficeTask[];
}

export interface TaskNoteRow {
  id: string;
  task_id: string;
  generation: number;
  content: string;
  created_at: number;
}

export type RoomId = "reception" | "bullpen" | "breakroom" | "warehouse";

export const ROOM_LABEL: Record<RoomId, string> = {
  reception: "Reception",
  bullpen: "Bullpen",
  breakroom: "Break Room",
  warehouse: "The Warehouse",
};

/** Room placement rules (tasks/todo.md "Decisions"): rooms map to existing
 * task fields, no new statuses. done/cancelled never reach this view (the
 * server excludes them from GET /api/office). */
export function roomFor(t: OfficeTask): RoomId {
  if (t.status === "on_hold") return "warehouse";
  if (t.status === "not_started") return "reception";
  if (t.running) return "bullpen";
  return "breakroom"; // in_progress and not running: waiting on Geo / idle after a turn
}
