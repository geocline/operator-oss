import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { DB_DIR } from "./config";
import { getDb } from "./db";
import type {
  Artifact,
  ArtifactListItem,
  Project,
  Task,
} from "./types";

export const ARTIFACTS_DIR = path.join(DB_DIR, "artifacts");
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".xls", "application/vnd.ms-excel"],
  [".doc", "application/msword"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".svg", "image/svg+xml"],
  [".zip", "application/zip"],
]);

export interface PublishArtifactInput {
  project: Project;
  task: Task;
  sourcePath: string;
  title?: string;
}

export interface ArtifactQuery {
  query?: string;
  contentType?: string;
  limit?: number;
  before?: number;
}

function displayTitle(raw: string | undefined, filename: string): string {
  const fallback = path.basename(filename, path.extname(filename))
    .replace(/[-_]+/g, " ")
    .trim();
  const title = (raw ?? "").trim() || fallback || filename;
  return title.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240);
}

function safeFilename(raw: string): string {
  const ext = path.extname(raw).toLowerCase();
  const stem = path
    .basename(raw, path.extname(raw))
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "artifact";
  return `${stem}${ext}`;
}

function workspaceFor(task: Task, project: Project): string {
  return (task.worktree_path || project.repo_path).trim();
}

function resolveSource(input: PublishArtifactInput): {
  resolved: string;
  filename: string;
  contentType: string;
  size: number;
} {
  const workspace = workspaceFor(input.task, input.project);
  if (!workspace) throw new Error("The current task has no configured workspace.");
  let workspaceReal: string;
  let resolved: string;
  try {
    workspaceReal = fs.realpathSync(workspace);
    resolved = fs.realpathSync(
      path.isAbsolute(input.sourcePath)
        ? input.sourcePath
        : path.resolve(workspaceReal, input.sourcePath),
    );
  } catch {
    throw new Error("The artifact is unavailable or not inside the current task workspace.");
  }
  const relative = path.relative(workspaceReal, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("The artifact must be a file inside the current task workspace.");
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("The artifact must be a regular file.");
  if (stat.size <= 0) throw new Error("The artifact cannot be empty.");
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`The artifact exceeds the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB limit.`);
  }
  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_BY_EXT.get(ext);
  if (!contentType) throw new Error(`Unsupported artifact type "${ext || "(none)"}".`);
  return {
    resolved,
    filename: safeFilename(path.basename(resolved)),
    contentType,
    size: stat.size,
  };
}

export function publishArtifact(input: PublishArtifactInput): Artifact {
  const source = resolveSource(input);
  const id = nanoid();
  const extension = path.extname(source.filename).toLowerCase();
  const storageName = `document${extension}`;
  const dir = path.join(ARTIFACTS_DIR, id);
  const destination = path.join(dir, storageName);
  const createdAt = Date.now();

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.copyFileSync(source.resolved, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    const bytes = fs.readFileSync(destination);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    getDb()
      .prepare(
        `INSERT INTO artifacts
          (id, project_id, task_id, generation, title, filename, content_type,
           byte_size, sha256, storage_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.project.id,
        input.task.id,
        input.task.generation,
        displayTitle(input.title, source.filename),
        source.filename,
        source.contentType,
        source.size,
        sha256,
        storageName,
        createdAt,
      );
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return getArtifact(id)!;
}

export function getArtifact(id: string): Artifact | undefined {
  return getDb()
    .prepare("SELECT * FROM artifacts WHERE id = ?")
    .get(id) as Artifact | undefined;
}

export function artifactPath(artifact: Artifact): string {
  if (!/^[A-Za-z0-9_-]+$/.test(artifact.id)) throw new Error("Invalid artifact id.");
  if (!/^document\.[A-Za-z0-9]+$/.test(artifact.storage_name)) {
    throw new Error("Invalid artifact storage name.");
  }
  return path.join(ARTIFACTS_DIR, artifact.id, artifact.storage_name);
}

export function listArtifacts(input: ArtifactQuery = {}): ArtifactListItem[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  const query = (input.query ?? "").trim();
  if (query) {
    clauses.push(
      "(a.title LIKE ? ESCAPE '\\' OR a.filename LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\')",
    );
    const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(like, like, like, like);
  }
  if (input.contentType) {
    clauses.push("a.content_type LIKE ?");
    args.push(`${input.contentType}%`);
  }
  if (input.before && Number.isFinite(input.before)) {
    clauses.push("a.created_at < ?");
    args.push(input.before);
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  args.push(limit);
  return getDb()
    .prepare(
      `SELECT a.*, p.name AS project_name, p.color AS project_color,
              t.title AS task_title
       FROM artifacts a
       JOIN projects p ON p.id = a.project_id
       JOIN tasks t ON t.id = a.task_id
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(...args) as ArtifactListItem[];
}

export function removeArtifactFilesForTask(taskId: string): void {
  const rows = getDb()
    .prepare("SELECT * FROM artifacts WHERE task_id = ?")
    .all(taskId) as Artifact[];
  for (const row of rows) {
    try {
      fs.rmSync(path.dirname(artifactPath(row)), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; metadata cascade remains authoritative.
    }
  }
}

