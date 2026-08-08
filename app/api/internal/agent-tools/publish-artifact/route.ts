import { NextResponse, type NextRequest } from "next/server";
import { getProject, getTask } from "@/lib/store";
import { publishTaskArtifact } from "@/lib/artifactTool";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    taskId?: string;
    path?: unknown;
    title?: unknown;
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
  try {
    const result = publishTaskArtifact(task, project, {
      path: typeof body.path === "string" ? body.path : "",
      title: typeof body.title === "string" ? body.title : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

