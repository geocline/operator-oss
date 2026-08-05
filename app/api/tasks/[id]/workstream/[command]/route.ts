import { NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import {
  getWorkstreamByTask,
  setWorkstreamState,
} from "@/lib/workstreams/store";
import {
  readRemoteWorkstreamState,
  sendWorkstreamCommand,
  type WorkstreamCommand,
} from "@/lib/workstreams/client";
import { postManualWorkstreamUpdate } from "@/lib/workstreams/delivery";
import { queueWorkstreamLifecycle } from "@/lib/workstreams/worker";
import type { WorkstreamState } from "@/lib/workstreams/types";

export const dynamic = "force-dynamic";

const COMMAND_STATE: Partial<Record<WorkstreamCommand, WorkstreamState>> = {
  pause: "paused",
  resume: "active",
  disconnect: "disconnected",
};

function isCommand(value: string): value is WorkstreamCommand {
  return (
    value === "pause" ||
    value === "resume" ||
    value === "disconnect" ||
    value === "post-now"
  );
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; command: string }> },
) {
  const { id, command } = await params;
  if (!isCommand(command)) {
    return NextResponse.json({ error: "invalid command" }, { status: 400 });
  }
  if (!getTask(id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const link = getWorkstreamByTask(id);
  if (!link) {
    return NextResponse.json({ error: "not linked" }, { status: 404 });
  }
  if (link.state === "disconnected") {
    return NextResponse.json(
      {
        error:
          "disconnected workstreams require a new tracker activation",
      },
      { status: 409 },
    );
  }
  const locallyAllowed =
    (command === "pause" && link.state === "active") ||
    (command === "resume" && link.state === "paused") ||
    (command === "disconnect" &&
      (link.state === "active" || link.state === "paused")) ||
    (command === "post-now" && link.state === "paused");
  if (!locallyAllowed) {
    return NextResponse.json(
      { error: `command unavailable while ${link.state}` },
      { status: 409 },
    );
  }

  const remoteState = await readRemoteWorkstreamState(
    link.external_workstream_id,
  );
  if (!remoteState.ok) {
    return NextResponse.json(
      { error: "workstream state unavailable" },
      { status: 502 },
    );
  }
  const reconciledState =
    remoteState.state === "active"
      ? "active"
      : remoteState.state === "disconnected"
        ? "disconnected"
        : "paused";
  const reconciled =
    reconciledState === link.state
      ? link
      : setWorkstreamState(link.id, reconciledState);
  if (remoteState.state === "disconnected") {
    return NextResponse.json(
      {
        error:
          "disconnected workstreams require a new tracker activation",
        workstream: reconciled,
      },
      { status: 409 },
    );
  }
  if (remoteState.state === "activating") {
    return NextResponse.json(
      {
        error: "workstream activation is still pending",
        workstream: { ...reconciled, state: "activating" },
      },
      { status: 409 },
    );
  }

  const allowed =
    (command === "pause" && remoteState.state === "active") ||
    (command === "resume" && remoteState.state === "paused") ||
    (command === "disconnect" &&
      (remoteState.state === "active" ||
        remoteState.state === "paused")) ||
    (command === "post-now" && remoteState.state === "paused");
  if (!allowed) {
    return NextResponse.json(
      { error: `command unavailable while ${remoteState.state}` },
      { status: 409 },
    );
  }

  if (command === "post-now") {
    const delivered = await postManualWorkstreamUpdate(reconciled);
    if (!delivered) {
      return NextResponse.json(
        { error: "workstream update unavailable" },
        { status: 502 },
      );
    }
    return NextResponse.json({ workstream: reconciled, delivered: true });
  }

  const remote = await sendWorkstreamCommand(
    reconciled.external_workstream_id,
    command,
  );
  if (!remote) {
    return NextResponse.json(
      { error: "workstream control unavailable" },
      { status: 502 },
    );
  }
  const workstream = setWorkstreamState(
    reconciled.id,
    COMMAND_STATE[command]!,
  );
  if (command === "pause" || command === "resume") {
    queueWorkstreamLifecycle(
      id,
      command === "pause" ? "paused" : "resumed",
      String(workstream.updated_at),
    );
  }
  return NextResponse.json({ workstream });
}
