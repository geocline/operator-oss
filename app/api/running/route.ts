import { NextResponse } from "next/server";
import { listRunningTasksLite } from "@/lib/store";

export const dynamic = "force-dynamic";

// Lightweight fleet-wide "which tasks have a live turn" list. Cross-project
// turn boundaries normally arrive live on GET /api/events, but a turn_end
// published while that stream was disconnected is gone — and the client only
// refetches the selected project's rows, so a spinner on a task in a project
// it navigated away from would stick forever. On every SSE reconnect the
// client reconciles its running set against this authoritative list.
//
// `tasks` carries each running task's project id alongside its id — the
// project-scoped running rollup (ProjectsColumn's blue dot) seeds itself from
// this on boot/reconnect; `ids` is kept for the plain task-level running set.
export async function GET() {
  const tasks = listRunningTasksLite();
  return NextResponse.json({ ids: tasks.map((t) => t.id), tasks });
}
