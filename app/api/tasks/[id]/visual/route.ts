import { NextResponse } from "next/server";
import { getTask, upsertTaskVisual } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    display_name?: unknown;
    avatar?: unknown;
  };

  const patch: { display_name?: string; avatar?: Record<string, unknown> | null } = {};
  if (body.display_name !== undefined) {
    if (typeof body.display_name !== "string") {
      return NextResponse.json({ error: "display_name must be a string" }, { status: 400 });
    }
    patch.display_name = body.display_name;
  }
  if (body.avatar !== undefined) {
    if (body.avatar !== null && (typeof body.avatar !== "object" || Array.isArray(body.avatar))) {
      return NextResponse.json({ error: "avatar must be an object or null" }, { status: 400 });
    }
    patch.avatar = body.avatar as Record<string, unknown> | null;
  }

  try {
    const visual = upsertTaskVisual(id, patch);
    return NextResponse.json({
      display_name: visual.display_name,
      avatar: visual.avatar ? (JSON.parse(visual.avatar) as Record<string, unknown>) : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid visual" },
      { status: 400 },
    );
  }
}
