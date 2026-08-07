import { NextResponse } from "next/server";
import { deleteTaskNote } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; noteId: string }> }) {
  const { id, noteId } = await params;
  if (!deleteTaskNote(id, noteId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
