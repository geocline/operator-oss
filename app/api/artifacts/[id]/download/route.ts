import fs from "node:fs";
import { artifactPath, getArtifact } from "@/lib/artifacts";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const artifact = getArtifact(id);
  if (!artifact) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(artifactPath(artifact));
  } catch {
    return Response.json({ error: "artifact unavailable" }, { status: 404 });
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": artifact.content_type,
      "Content-Disposition": `attachment; filename="${artifact.filename.replace(/["\\]/g, "-")}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

