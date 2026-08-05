import { NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import {
  getWorkstreamByTask,
  setWorkstreamState,
} from "@/lib/workstreams/store";
import { readRemoteWorkstreamState } from "@/lib/workstreams/client";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getTask(id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const link = getWorkstreamByTask(id);
  if (!link || link.state === "disconnected") {
    return NextResponse.json({ workstream: link ?? null });
  }
  const remote = await readRemoteWorkstreamState(
    link.external_workstream_id,
  );
  if (!remote.ok) {
    return NextResponse.json({ workstream: link });
  }
  const localState =
    remote.state === "active"
      ? "active"
      : remote.state === "disconnected"
        ? "disconnected"
        : "paused";
  const reconciled =
    localState === link.state
      ? link
      : setWorkstreamState(link.id, localState);
  return NextResponse.json({
    workstream:
      remote.state === "activating"
        ? { ...reconciled, state: "activating" }
        : reconciled,
  });
}
