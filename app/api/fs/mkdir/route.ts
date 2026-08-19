import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// Creates one new folder inside an existing directory — the FolderPicker's
// "New folder" action, so a project (or a task's starting subfolder) can be
// placed in a folder that doesn't exist yet without leaving the app. The
// parent must already exist; the name is a single path segment.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parent = typeof body?.parent === "string" ? body.parent.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!parent || !path.isAbsolute(parent)) {
    return NextResponse.json({ error: "parent must be an absolute path" }, { status: 400 });
  }
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    return NextResponse.json({ error: "name must be a single folder name" }, { status: 400 });
  }
  try {
    const stat = await fs.stat(parent);
    if (!stat.isDirectory()) return NextResponse.json({ error: `Not a directory: ${parent}` }, { status: 400 });
  } catch {
    return NextResponse.json({ error: `Not found: ${parent}` }, { status: 404 });
  }
  const dest = path.join(parent, name);
  try {
    await fs.mkdir(dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return NextResponse.json({ error: `Already exists: ${name}` }, { status: 409 });
    return NextResponse.json({ error: `Cannot create: ${dest}` }, { status: 403 });
  }
  return NextResponse.json({ path: dest });
}
