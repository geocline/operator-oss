import { NextResponse } from "next/server";
import {
  createProject,
  createTask,
  countExternalSessionImports,
  findExternalSessionImport,
  findOpenTaskByMarker,
  findOrCreateExternalSessionImport,
  findProjectByRepoPath,
  findProjectContaining,
  findSessionRef,
  findUnambiguousExternalSessionImport,
  findUnambiguousLegacySessionImport,
  getTask,
} from "@/lib/store";
import {
  acknowledgeWorkstreamActivation,
  exchangeWorkstreamToken,
} from "@/lib/workstreams/client";
import {
  activateWorkstream,
  getWorkstreamByExternalCard,
  setWorkstreamState,
} from "@/lib/workstreams/store";
import { queueWorkstreamLifecycle } from "@/lib/workstreams/worker";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const dynamic = "force-dynamic";

/**
 * Deep-link entry point for Geo's other dashboards (Conversations Dashboard,
 * Ardent deal tracker). Plain top-level navigation, so callers on other
 * origins need no CORS setup:
 *
 *   /open?session=<agent-session-id>          -> the task that ran it, OR (for
 *     a historical CLI/desktop session operator never saw) a NEW task seeded
 *     with that conversation's dialogue so the work continues with context
 *   /open?path=<abs repo dir>&name=<label>    -> project by folder (created if missing)
 *   /open?workstream_token=<opaque-token>     -> linked tracker task
 *
 * Both params together: operator-owned session wins, then import-by-session,
 * then plain path. The client already honors ?project= / ?task= on boot
 * (persist.ts readUrlSel), so this route only resolves ids and redirects.
 */

// The conversations-dashboard FTS index - the authority on historical CLI
// sessions (both agents). Read-only; absent or locked degrades to path flow.
const CONVERSATIONS_DB = path.join(os.homedir(), "Claude Projects", "conversations-dashboard", "data", "index.db");

type ExternalSession = { title: string; project_path: string; source: string; dialogue: string; turns: number };

/** One user/assistant turn extracted from a transcript JSONL line, best-effort. */
function turnOf(obj: Record<string, unknown>): { role: string; text: string } | null {
  // Claude Code format: {type:"user"|"assistant", message:{role, content}}
  const msg = (obj.message ?? null) as { role?: string; content?: unknown } | null;
  // Codex rollout format: {type:"response_item", payload:{type:"message", role, content}}
  const payload = (obj.payload ?? null) as { type?: string; role?: string; content?: unknown } | null;
  const role = msg?.role ?? (payload?.type === "message" ? payload.role : undefined);
  if (role !== "user" && role !== "assistant") return null;
  const content = msg?.content ?? payload?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  text = text.trim();
  // Skip tool-result noise and system-ish payloads; keep human dialogue.
  if (!text || text.startsWith("[{") || text.startsWith("<system") || text.startsWith("<local-command")) return null;
  return { role, text };
}

/**
 * Look a session id up in the conversations index and rebuild its dialogue
 * (most recent turns, clipped) for seeding a continuation task.
 */
function importExternalSession(
  sessionId: string,
  source?: string,
): ExternalSession | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const db = new Database(CONVERSATIONS_DB, { readonly: true, fileMustExist: true });
    let row: { title?: string; file_path?: string; project_path?: string; source?: string } | undefined;
    try {
      row = source
        ? db
            .prepare(
              "SELECT title, file_path, project_path, source FROM sessions WHERE session_id = ? AND source = ?",
            )
            .get(sessionId, source)
        : db
            .prepare(
              "SELECT title, file_path, project_path, source FROM sessions WHERE session_id = ?",
            )
            .get(sessionId);
    } finally {
      db.close();
    }
    if (!row?.file_path || !existsSync(row.file_path)) return null;

    const turns: { role: string; text: string }[] = [];
    for (const line of readFileSync(row.file_path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = turnOf(JSON.parse(line));
        if (t) turns.push(t);
      } catch {
        // non-JSON line - skip
      }
    }
    if (turns.length === 0) return null;

    // Keep the tail: newest turns matter most for continuation. Clip each turn
    // and cap the total so the seeded description stays a prompt, not a dump.
    const PER_TURN = 1800;
    const TOTAL = 9000;
    const kept: string[] = [];
    let used = 0;
    let included = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const clipped = t.text.length > PER_TURN ? t.text.slice(0, PER_TURN) + "\n[... clipped ...]" : t.text;
      const block = `${t.role.toUpperCase()}:\n${clipped}`;
      if (used + block.length > TOTAL && included > 0) break;
      kept.unshift(block);
      used += block.length;
      included++;
    }
    const omitted = turns.length - included;
    return {
      title: row.title || "prior conversation",
      project_path: row.project_path || "",
      source: row.source || "claude",
      turns: turns.length,
      dialogue: (omitted > 0 ? `[${omitted} earlier turns omitted - full transcript searchable at http://localhost:8772]\n\n` : "") + kept.join("\n\n"),
    };
  } catch {
    return null;
  }
}

/** PUBLIC_BASE_URL as a parsed http(s) origin, or null when unset/unusable. */
function configuredOrigin(): URL | null {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Where to send the browser back to - "the device you clicked from is the
 * device you stay on".
 *
 * `new URL(req.url).origin` is NOT the client's origin here. Behind the custom
 * server, Next rebuilds the request URL from an internal base, so it reads
 * http://localhost:3000 no matter which hostname the browser actually used -
 * and it gets the port wrong on any non-default port. That's why this route
 * used to force PUBLIC_BASE_URL unconditionally: the request origin was
 * useless, so the public origin was the only thing that worked from a phone.
 * The cost was that a laptop clicking a deep link at localhost got bounced onto
 * the tailnet hostname, which is slower and (being a separate origin over plain
 * HTTP/1.1) burns its own six-connection browser budget.
 *
 * The Host header is the honest record of how the client reached us, so prefer
 * it: loopback stays loopback (laptop), the public hostname stays public
 * (phone). Anything else falls back to PUBLIC_BASE_URL rather than trusting it,
 * since Host is caller-controlled and echoing it into a redirect would make
 * this an open redirect.
 */
function clientOrigin(req: Request, requestUrl: URL): string {
  const configured = configuredOrigin();
  const fallback = configured?.origin ?? requestUrl.origin;
  // X-Forwarded-* wins when a tunnel or reverse proxy terminates TLS in front
  // of this plain-HTTP server; each may be a comma-separated chain.
  const first = (v: string | null) => (v ?? "").split(",")[0].trim();
  const host = first(req.headers.get("x-forwarded-host")) || first(req.headers.get("host"));
  if (!host) return fallback;

  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  const isLoopback = LOOPBACK.has(hostname);
  const isConfigured = !!configured && configured.host.toLowerCase() === host.toLowerCase();
  if (!isLoopback && !isConfigured) return fallback;

  const proto =
    first(req.headers.get("x-forwarded-proto")) ||
    // A loopback client is talking to this server directly, so it's plain http;
    // the configured host keeps whatever scheme PUBLIC_BASE_URL declares.
    (isConfigured && !isLoopback ? configured.protocol.replace(":", "") : "http");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return fallback;
  }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workstreamToken = url.searchParams.get("workstream_token")?.trim();
  const session = url.searchParams.get("session")?.trim();
  const sessionSource = url.searchParams.get("source")?.trim();
  const repoPath = url.searchParams.get("path")?.trim();
  const name = url.searchParams.get("name")?.trim();

  const redirectOrigin = clientOrigin(req, url);
  const home = (to: string) =>
    NextResponse.redirect(new URL(to, redirectOrigin), 307);

  const projectFor = (dir: string, label?: string) => {
    const existing = findProjectByRepoPath(dir);
    if (existing) return existing;
    if (!existsSync(dir)) return null;
    return createProject({ name: label || path.basename(dir), repo_path: dir });
  };

  // 1) Explicit tracker activation. The token is exchanged server-to-server
  // before any other deep-link path is considered, and never enters task text.
  if (workstreamToken) {
    const remote = await exchangeWorkstreamToken(workstreamToken);
    if (!remote || !path.isAbsolute(remote.project_path)) {
      return home("/?workstream_error=unavailable");
    }

    const lane = findProjectContaining(remote.project_path);
    if (!lane) return home("/?workstream_error=unavailable");

    const linked = getWorkstreamByExternalCard("ardent", remote.card_id);
    const linkedTask = linked ? getTask(linked.task_id) : undefined;
    const task =
      linked && linkedTask
        ? linkedTask
        : createTask({
            project_id: lane.id,
            title: remote.title.slice(0, 120),
            description:
              "Work from the linked tracker card. Review its current details and attachments before starting. " +
              "Use the deal lane context for supporting knowledge and publish team-facing updates only through the linked workstream.",
          });
    const pending = activateWorkstream({
      taskId: task.id,
      provider: "ardent",
      externalCardId: remote.card_id,
      externalWorkstreamId: remote.workstream_id,
      initialState: "paused",
    });
    const acknowledged = await acknowledgeWorkstreamActivation({
      externalWorkstreamId: remote.workstream_id,
      activationAckToken: remote.activation_ack_token,
      operatorTaskId: task.id,
    });
    if (!acknowledged) {
      return home(
        `/?project=${task.project_id}&task=${task.id}&workstream_error=activation-pending`,
      );
    }
    const activated = setWorkstreamState(pending.id, "active");
    queueWorkstreamLifecycle(
      activated.task_id,
      "activation",
      remote.workstream_id,
    );
    return home(`/?project=${task.project_id}&task=${task.id}`);
  }

  // 2) A session operator itself ran: jump straight to its task.
  if (session) {
    const ref = findSessionRef(session);
    if (ref && getTask(ref.task_id)) return home(`/?project=${ref.project_id}&task=${ref.task_id}`);

    const imported = sessionSource
      ? findExternalSessionImport(sessionSource, session) ??
        findUnambiguousLegacySessionImport(session)
      : findUnambiguousExternalSessionImport(session);
    if (imported && getTask(imported.task_id)) {
      return home(`/?project=${imported.project_id}&task=${imported.task_id}`);
    }
    const ambiguousImport =
      !sessionSource && countExternalSessionImports(session) > 1;

    // 3) A historical CLI/desktop session: continue it as a new task seeded
    //    with the old dialogue (the cross-border version of Renew's summary).
    const ext = ambiguousImport
      ? null
      : importExternalSession(session, sessionSource);
    if (ext) {
      const dir = (repoPath && path.isAbsolute(repoPath) ? repoPath : "") || ext.project_path;
      const project = dir ? projectFor(dir, name) : null;
      if (project) {
        const agentLabel = ext.source === "codex" ? "Codex" : "Claude Code";
        const { task } = findOrCreateExternalSessionImport({
          source: ext.source,
          external_session_id: session,
          project_id: project.id,
          title: `Continue: ${ext.title.slice(0, 90)}`,
          description:
            `Continuation of a prior ${agentLabel} session (${session}, ${ext.turns} turns). ` +
            `You have the recent dialogue below; earlier context is searchable in the Conversations Dashboard (http://localhost:8772). ` +
            `Pick up where it left off.\n\n--- Prior dialogue (most recent, clipped) ---\n\n${ext.dialogue}`,
          agent: ext.source === "codex" ? "codex" : "claude",
        });
        return home(`/?project=${task.project_id}&task=${task.id}`);
      }
    }
  }

  // 4) Folder-based. Exact repo_path match first (a lane opens as itself);
  //    then deal-lane routing: a folder INSIDE a lane (a tracker card's
  //    workspace like Ardent/Wobbe/card-projects/TIC-Info) opens as a TASK in
  //    that lane - project = deal, task = assignment - so the session gets the
  //    lane's context and index pointers instead of an amnesiac nested
  //    project. Re-clicking the same card lands on the existing live task.
  if (repoPath && path.isAbsolute(repoPath)) {
    const exact = findProjectByRepoPath(repoPath);
    if (exact) return home(`/?project=${exact.id}`);

    const lane = findProjectContaining(repoPath);
    if (lane && existsSync(repoPath)) {
      const marker = repoPath.replace(/\/+$/, "");
      const existing = findOpenTaskByMarker(lane.id, marker);
      if (existing) return home(`/?project=${lane.id}&task=${existing.id}`);
      const task = createTask({
        project_id: lane.id,
        title: name || path.basename(marker),
        description:
          `Tracker card workspace: ${marker}\n\n` +
          `Read the card bundle there first (description, comments, attachment list) - it defines this assignment. ` +
          `Write deliverables into that folder. For deal knowledge, start from the deal's INDEX.md and the search tools ` +
          `named in the project context; open only the files you need.`,
      });
      return home(`/?project=${lane.id}&task=${task.id}`);
    }

    const project = projectFor(repoPath, name);
    if (project) return home(`/?project=${project.id}`);
  }

  return home("/");
}
