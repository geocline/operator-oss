import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, listMessages, addMessage, addSummary, clearPendingMessages } from "@/lib/store";
import { getDriver } from "@/lib/agents/registry";
import { summarizeTranscript } from "@/lib/agents/oneshots";
import { hasTurn, abortTurn } from "@/lib/abort";
import { publish, publishGlobal } from "@/lib/events";
import { buildClippedTranscript } from "@/lib/transcript";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

  // Optional handoff: `{ agent }` in the body switches the task to another
  // driver across this clear boundary. The generation bump below already
  // resets the session id and re-issues title+description+summaries on the
  // next send, so the new driver resumes with full context in the SAME
  // worktree/branch - no task duplication. Body is optional and may be empty
  // (the plain /clear path sends none).
  //
  // `{ useLastAssistant: true }` seeds the next generation with the outgoing
  // session's final assistant message instead of an auto-summary - the /handoff
  // flow, where that message IS a purpose-written handoff document and
  // re-summarizing it would only lose detail. `{ model }` carries a same-driver
  // model choice across the boundary (e.g. hand Sonnet's work to Opus), applied
  // with the generation bump so the fresh session's first turn runs on it.
  let handoffAgent: string | null = null;
  let handoffModel: string | null | undefined;
  let useLastAssistant = false;
  try {
    const body = await req.json();
    if (body && typeof body.agent === "string" && body.agent && body.agent !== task.agent) {
      // Only accept ids the registry actually knows; unknown ids would fall
      // back to the default driver and silently mislabel the task.
      if (getDriver(body.agent).id !== body.agent)
        return NextResponse.json({ error: `unknown agent "${body.agent}"` }, { status: 400 });
      handoffAgent = body.agent;
    }
    if (body && (typeof body.model === "string" || body.model === null)) handoffModel = body.model;
    if (body && body.useLastAssistant === true) useLastAssistant = true;
  } catch {
    // no/invalid JSON body - plain clear
  }

  const gen = task.generation;

  // Stop any turn still streaming before we end this generation. /clear starts a
  // fresh context, so the running turn's work belongs to the OLD generation and
  // must not bleed into the new one. Aborting trips the runner's unwind; the
  // generation bump below — combined with the runner's generation-guarded settle
  // (lib/runner.ts) — stops that turn's finally from resurrecting the session id
  // this route nulls. We don't block on the turn fully settling: whichever order
  // the abort's finally and this write land in, the guard keeps session_id null.
  if (hasTurn(id)) abortTurn(id);

  // Build a transcript from the current generation's messages, clipping each
  // message and capping the total so an oversized session (a giant paste, or a
  // conversation that hit the context limit) can still be summarized —
  // otherwise summarizeTranscript would itself fail "prompt is too long" and
  // the handoff summary would be lost.
  const transcript = buildClippedTranscript(
    listMessages(id).filter(
      (m) => m.generation === gen && (m.role === "user" || m.role === "assistant" || m.role === "tool")
    )
  );

  let summary = "(empty session — nothing to summarize)";
  // /handoff path: the session's last assistant message is a purpose-written
  // handoff document — carry it verbatim. Fall back to the auto-summary if the
  // turn produced no assistant text (e.g. it errored out mid-write).
  const lastAssistant = useLastAssistant
    ? listMessages(id).filter((m) => m.generation === gen && m.role === "assistant" && m.content.trim()).at(-1)
    : undefined;
  if (lastAssistant) {
    summary = lastAssistant.content;
  } else if (transcript.trim()) {
    try {
      summary = await summarizeTranscript(task, transcript, project);
    } catch (err) {
      summary = `(summary failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  addSummary(id, gen, summary);
  // Record the boundary + summary in the message log for continuity in the UI.
  addMessage(id, gen, "session_break", summary);

  // Fresh generation: new context window, session reset. started=0 so the next
  // send re-issues title+description, and buildProjectContext now includes the summary.
  const next = updateTask(id, {
    generation: gen + 1,
    session_id: null,
    started: 0,
    running: 0,
    awaiting_input: 0,
    turn_started_at: null,
    status: "in_progress",
    // On handoff, switch drivers and drop driver-specific knobs (model alias,
    // reasoning preset, permission mode are not portable across CLIs; null =
    // the new driver's defaults). resolved_model clears so the badge doesn't
    // show the old driver's model against the new agent.
    ...(handoffAgent
      ? { agent: handoffAgent, model: null, resolved_model: null, reasoning: null, permission_mode: null }
      : handoffModel !== undefined
        ? { model: handoffModel, resolved_model: null }
        : {}),
  });

  // Discard any follow-ups queued against the OLD generation. They were lined up
  // behind the context the user just cleared, so auto-draining them into the
  // fresh session would replay stale intent. (The aborted turn's finally also
  // clears the queue on its own path; doing it here too covers the no-turn case
  // and any residual rows, and is idempotent.)
  for (const p of clearPendingMessages(id)) publish(id, { type: "dequeued", msgId: p.id });

  // The row just settled (running/awaiting reset, status in_progress) outside
  // any turn, and the `dequeued` publishes above are transcript detail the
  // coarse /api/events filter drops — announce the settle so every other tab's
  // spinners and "needs you" badges recount.
  publishGlobal(id, { type: "task_updated" });

  return NextResponse.json({ task: next, summary, generation: gen + 1 });
}
