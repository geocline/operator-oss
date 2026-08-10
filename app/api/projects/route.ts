import { NextResponse } from "next/server";
import { listProjects, createProject } from "@/lib/store";
import { track } from "@/lib/analytics";
import { PROJECTS_DIR } from "@/lib/config";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listProjects());
}

// A project with no working dir gets one under PROJECTS_DIR, named after the
// project (collision-suffixed like lib/github.ts clone destinations), and the
// folder is created NOW - previously an empty repo_path left a project that
// could not run tasks until someone found the Context editor, and a typed
// path was never checked or created until the first turn.
function defaultRepoPath(name: string): string {
  const base = name.replace(/[\/\\:]+/g, "-").trim() || "project";
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  let dest = path.join(/* turbopackIgnore: true */ PROJECTS_DIR, base);
  for (let i = 2; fs.existsSync(/* turbopackIgnore: true */ dest); i++)
    dest = path.join(/* turbopackIgnore: true */ PROJECTS_DIR, `${base}-${i}`);
  fs.mkdirSync(dest, { recursive: true });
  return dest;
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const name = body.name.trim();
  const repoPath: string = typeof body.repo_path === "string" && body.repo_path.trim() ? body.repo_path.trim() : defaultRepoPath(name);
  const project = createProject({
    name,
    icon: body.icon,
    sub: body.sub,
    color: body.color,
    context: body.context,
    repo_path: repoPath,
    branch: body.branch,
    run_in_repo: body.run_in_repo === undefined ? undefined : body.run_in_repo ? 1 : 0,
  });
  track("project_created", { project_id: project.id, has_repo: !!project.repo_path });
  return NextResponse.json(project, { status: 201 });
}
