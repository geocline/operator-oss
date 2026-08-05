import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, deleteTask, listMessages, getTaskUsage, getTaskContext, getTaskDeps, setTaskDeps, countAwaiting } from "@/lib/store";
import { removeWorktree } from "@/lib/git";
import { removeTaskUploads } from "@/lib/uploads";
import { abortTurn } from "@/lib/abort";
import { publishGlobal } from "@/lib/events";
import { queueManualWorkstreamCompletion } from "@/lib/workstreams/worker";
import { isKnownAgent } from "@/lib/agents/capabilities";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const usage = getTaskUsage(id);
  const ctx = getTaskContext(id);
  return NextResponse.json({
    ...task,
    cost_usd: usage.cost_usd,
    total_tokens: usage.total_tokens,
    // The cache buckets travel with the total so the usage chip can split
    // "fresh work" from re-read context instead of showing one inflated number.
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    context_tokens: ctx.context_tokens,
    context_pct: ctx.context_pct,
    depends_on: getTaskDeps(id),
    messages: listMessages(id),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as Partial<Task>;
  const previous = getTask(id);
  if (!previous) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Whitelist user-editable fields.
  const allowed: Partial<Task> = {};
  for (const k of ["title", "description", "priority", "status", "suggested", "model", "reasoning", "permission_mode"] as const) {
    if (k in body) (allowed as Record<string, unknown>)[k] = body[k];
  }
  // A manual status change is the user taking the wheel — clear the "your turn" flag.
  if ("status" in allowed) allowed.awaiting_input = 0;
  // Switching which agent a task runs on. Only legal BEFORE the task has a
  // session: once one exists, changing tasks.agent would hand the new driver a
  // session/thread id minted by the old one, so that case belongs to the
  // /clear handoff (summarize → fresh generation → same worktree) instead.
  // Validated against the SDK-free capability map rather than getDriver, whose
  // forgiving fallback would silently rewrite a typo'd id to Claude.
  if ("agent" in body) {
    const next = (body as { agent?: unknown }).agent;
    if (typeof next !== "string" || !isKnownAgent(next)) {
      return NextResponse.json({ error: `unknown agent "${String(next)}"` }, { status: 400 });
    }
    if (next !== previous.agent) {
      if (previous.started === 1 || previous.session_id) {
        return NextResponse.json(
          { error: "This task already has a session - hand it off instead so its context carries over." },
          { status: 409 },
        );
      }
      allowed.agent = next;
      // The run knobs are per-CLI vocabularies ("opus" means nothing to codex),
      // so a switch resets them to the new driver's defaults - the same reset
      // the /clear handoff performs.
      allowed.model = null;
      allowed.reasoning = null;
      allowed.permission_mode = null;
      allowed.resolved_model = null;
    }
  }
  // Cancelling means "stop working on this": kill any in-flight turn. The
  // runner's finally block settles running=0 and discards the parked queue.
  // (The worktree is kept — Cancelled ≠ Delete — so the diff stays reviewable
  // and the task can be revived by just sending another message.)
  if (allowed.status === "cancelled") abortTurn(id);
  // Dependency edges live in their own table — set them separately, with a cycle guard.
  if (Array.isArray((body as { depends_on?: unknown }).depends_on)) {
    try {
      setTaskDeps(id, (body as { depends_on: string[] }).depends_on);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "invalid dependencies" }, { status: 400 });
    }
  }
  const task = updateTask(id, allowed);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (allowed.status === "done" && previous.status !== "done") {
    queueManualWorkstreamCompletion(
      id,
      `${task.generation}:${task.updated_at}`,
    );
  }
  // A manual status change settles status + awaiting_input outside any turn, so
  // no runner publish will follow — announce it ourselves or every other tab's
  // "needs you" badges keep counting this task until their next reconnect.
  // An agent switch rides the same announcement: every other tab renders the
  // agent badge from its own task row, which would otherwise stay stale.
  if ("status" in allowed || "agent" in allowed) publishGlobal(id, { type: "task_updated" });
  return NextResponse.json({ ...task, depends_on: getTaskDeps(id) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  // Stop any in-flight turn before tearing down its worktree, so the runner
  // isn't mid-write when the directory disappears.
  abortTurn(id);
  if (task?.worktree_path) {
    const project = getProject(task.project_id);
    if (project?.repo_path) await removeWorktree(project.repo_path, task.worktree_path, task.work_branch);
  }
  removeTaskUploads(id);
  deleteTask(id);
  // Publish AFTER the hard delete, carrying the project id + its recomputed
  // awaiting count: the row is gone, so /api/events' usual re-read-the-task
  // enrichment would drop the event and freeze the project's badge in every
  // other tab until the next SSE reconnect.
  if (task) publishGlobal(id, { type: "task_deleted", projectId: task.project_id, awaiting_count: countAwaiting(task.project_id) });
  return NextResponse.json({ ok: true });
}
