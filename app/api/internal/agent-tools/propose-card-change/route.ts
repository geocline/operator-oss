import { NextResponse, type NextRequest } from "next/server";
import { getProject, getTask } from "@/lib/store";
import {
  proposeCardChange,
  type CardChangeKind,
} from "@/lib/agentTools";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    taskId?: string;
    kind?: unknown;
    value?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const project = body.projectId ? getProject(body.projectId) : undefined;
  if (!project) {
    return NextResponse.json({ error: "unknown project" }, { status: 404 });
  }
  const task = body.taskId ? getTask(body.taskId) : undefined;
  if (!task) {
    return NextResponse.json({ error: "unknown task" }, { status: 404 });
  }
  if (task.project_id !== project.id) {
    return NextResponse.json(
      { error: "task does not belong to project" },
      { status: 409 },
    );
  }

  const result = await proposeCardChange(task, project, {
    kind: body.kind as CardChangeKind,
    value:
      body.value &&
      typeof body.value === "object" &&
      !Array.isArray(body.value)
        ? (body.value as Record<string, unknown>)
        : (body.value as Record<string, unknown>),
  });
  return NextResponse.json({
    ok: result.status !== "rejected",
    ...result,
  });
}
