import { NextResponse } from "next/server";
import { getTask, listTaskNotes, addTaskNote } from "@/lib/store";
import { getWorkstreamByTask, enqueueWorkstreamEvent } from "@/lib/workstreams/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ notes: listTaskNotes(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { content?: unknown };
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return NextResponse.json({ error: "content required" }, { status: 400 });
  // Stamp the note with the task's current generation so it stays legible
  // after a /clear ("session 3" still names the era it was written in).
  const note = addTaskNote(id, task.generation, content);

  // Sync to the linked tracker card, if any, as a status_note outbox event
  // (see lib/workstreams/worker.ts). Only when the link is actively syncing —
  // paused/disconnected links never get card-facing writes. Idempotency key
  // is derived from the note id, so a retried POST never double-enqueues.
  const link = getWorkstreamByTask(id);
  if (link && link.state === "active") {
    try {
      enqueueWorkstreamEvent({
        linkId: link.id,
        idempotencyKey: `status_note:${note.id}`,
        eventType: "status_note",
        payload: {
          note: {
            id: note.id,
            content: note.content,
            created_at: note.created_at,
            generation: note.generation,
          },
          task_status: task.status,
        },
      });
    } catch {
      // Best-effort: the note itself is already persisted regardless.
    }
  }

  return NextResponse.json(note);
}
