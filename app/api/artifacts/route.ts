import { NextResponse } from "next/server";
import { listArtifacts } from "@/lib/artifacts";
import type { ArtifactListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

function publicItem(row: ArtifactListItem) {
  return {
    id: row.id,
    project_id: row.project_id,
    task_id: row.task_id,
    generation: row.generation,
    title: row.title,
    filename: row.filename,
    content_type: row.content_type,
    byte_size: row.byte_size,
    created_at: row.created_at,
    project_name: row.project_name,
    project_color: row.project_color,
    task_title: row.task_title,
    url: `/artifacts/${row.id}`,
    content_url: `/api/artifacts/${row.id}/content`,
    download_url: `/api/artifacts/${row.id}/download`,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") || "50");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(100, Math.trunc(rawLimit)))
    : 50;
  const rawBefore = Number(url.searchParams.get("before") || "0");
  const rows = listArtifacts({
    query: url.searchParams.get("q") || undefined,
    contentType: url.searchParams.get("type") || undefined,
    limit,
    before: rawBefore > 0 && Number.isFinite(rawBefore) ? rawBefore : undefined,
  });
  return NextResponse.json({
    artifacts: rows.map(publicItem),
    next_before: rows.length === limit ? rows.at(-1)?.created_at ?? null : null,
  });
}

