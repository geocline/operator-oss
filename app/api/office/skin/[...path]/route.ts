import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { OFFICE_SKIN_DIR } from "@/lib/config";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "not found" }, { status: 404 });

/** Serve a read-only PNG from the extracted LimeZu pack (ORCH_OFFICE_SKIN_DIR).
 * Never proxies anything else: only .png, and only paths that resolve inside
 * the configured dir (path.resolve + a prefix check rejects any `..` escape,
 * including encoded/absolute segments Next has already decoded for us).
 * Auth: Next.js Proxy. */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const root = OFFICE_SKIN_DIR;
  if (!root) return NOT_FOUND();

  const { path: segments } = await params;
  if (!segments || segments.length === 0) return NOT_FOUND();
  if (segments.some((s) => s === "" || s === "." || s === "..")) return NOT_FOUND();

  const rel = segments.join("/");
  if (!rel.toLowerCase().endsWith(".png")) return NOT_FOUND();

  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  const withSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (abs !== rootResolved && !abs.startsWith(withSep)) return NOT_FOUND();

  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return NOT_FOUND();
  }

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
