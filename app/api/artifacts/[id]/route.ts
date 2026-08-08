import { NextResponse } from "next/server";
import { getArtifact } from "@/lib/artifacts";
import { getProject, getTask } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const artifact = getArtifact(id);
  if (!artifact) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const project = getProject(artifact.project_id);
  const task = getTask(artifact.task_id);
  if (!project || !task) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: artifact.id,
    project_id: artifact.project_id,
    task_id: artifact.task_id,
    generation: artifact.generation,
    title: artifact.title,
    filename: artifact.filename,
    content_type: artifact.content_type,
    byte_size: artifact.byte_size,
    created_at: artifact.created_at,
    project_name: project.name,
    project_color: project.color,
    task_title: task.title,
    content_url: `/api/artifacts/${artifact.id}/content`,
    download_url: `/api/artifacts/${artifact.id}/download`,
  });
}

