import fs from "node:fs";
import { artifactPath, getArtifact } from "@/lib/artifacts";

export const dynamic = "force-dynamic";

const HTML_CSP = [
  "sandbox",
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: https:",
  "font-src data:",
  "media-src data: https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

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
  const headers = new Headers({
    "Content-Type": artifact.content_type,
    "Content-Disposition": `inline; filename="${artifact.filename.replace(/["\\]/g, "-")}"`,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  if (artifact.content_type.startsWith("text/html")) {
    headers.set("Content-Security-Policy", HTML_CSP);
  }
  return new Response(new Uint8Array(bytes), { headers });
}

