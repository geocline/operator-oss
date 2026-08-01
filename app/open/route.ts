import { NextResponse } from "next/server";
import { findProjectByRepoPath, findSessionRef, createProject, getTask } from "@/lib/store";
import { existsSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/**
 * Deep-link entry point for Geo's other dashboards (Conversations Dashboard,
 * Ardent deal tracker). Plain top-level navigation, so callers on other
 * origins need no CORS setup:
 *
 *   /open?session=<agent-session-id>          -> the task that ran it
 *   /open?path=<abs repo dir>&name=<label>    -> project by folder (created if missing)
 *
 * Both params together: session wins when known, path is the fallback. The
 * client already honors ?project= / ?task= on boot (persist.ts readUrlSel),
 * so this route only resolves ids and redirects.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session")?.trim();
  const repoPath = url.searchParams.get("path")?.trim();
  const name = url.searchParams.get("name")?.trim();

  const home = (to: string) => NextResponse.redirect(new URL(to, url.origin), 307);

  // 1) A session operator itself ran: jump straight to its task.
  if (session) {
    const ref = findSessionRef(session);
    if (ref && getTask(ref.task_id)) return home(`/?project=${ref.project_id}&task=${ref.task_id}`);
  }

  // 2) Folder-based: find the project by repo_path, create it if missing.
  if (repoPath && path.isAbsolute(repoPath)) {
    const existing = findProjectByRepoPath(repoPath);
    if (existing) return home(`/?project=${existing.id}`);
    // Only create for folders that actually exist - a typo'd deep link should
    // not spawn a broken project row.
    if (existsSync(repoPath)) {
      const project = createProject({ name: name || path.basename(repoPath), repo_path: repoPath });
      return home(`/?project=${project.id}`);
    }
  }

  return home("/");
}
