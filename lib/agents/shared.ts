// Agent-agnostic building blocks shared by every driver: the project-context
// prompt, the conflict-resolution prompt, and the normalizers that turn a raw
// tool call/result into the UI's title/detail/peek shape. Nothing in here
// knows which agent is running — drivers reuse these to emit the normalized
// StreamEvent contract (see lib/agents/types.ts).

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { Project, Task, AskQuestion, AskAnswers, ToolPeek, DiffLine } from "../types";
import { listSummaries, listTaskNotes } from "../store";
import { getWorkstreamByTask } from "../workstreams/store";

// User-editable rules injected at the top of every turn's system prompt
// (all drivers). Read fresh per turn so edits apply without a restart while an
// already-running turn keeps the copy it launched with. Deliberately NOT enforced programmatically: rule 1 is a
// context-health canary - the model must obey it from instruction alone.
const SESSION_RULES_PATH = "/Users/geo/Claude Projects/site-wide/RULES.md";

export function loadSessionRules(filePath = SESSION_RULES_PATH): string {
  try {
    const text = readFileSync(filePath, "utf8").trim();
    return text ? `${text}\n\n---\n` : "";
  } catch {
    return "";
  }
}

/**
 * The directory an agent session starts in: the task's worktree (isolated
 * mode) or the project folder (direct mode), descended into the task's
 * optional starting subfolder. The subfolder is repo-relative and validated
 * at create time (app/api/tasks/route.ts); it's re-guarded here and skipped
 * if it doesn't exist on disk, so a renamed folder degrades to the workspace
 * root instead of failing the turn.
 */
export function taskCwd(task: Task, project: Project): string {
  const root = task.worktree_path || project.repo_path || process.cwd();
  const sub = (task.subdir || "").trim();
  if (!sub || isAbsolute(sub) || normalize(sub).split(/[\\/]/).includes("..")) return root;
  const dir = join(root, sub);
  return existsSync(dir) ? dir : root;
}

export function buildHarnessEnv(
  taskId: string,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> =
    process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      value !== undefined &&
      key !== "DEAL_TRACKER_LINKED_WORKSTREAM"
    ) {
      env[key] = value;
    }
  }
  if (getWorkstreamByTask(taskId)) {
    env.DEAL_TRACKER_LINKED_WORKSTREAM = "1";
  }
  return env;
}

export function buildWorkstreamRuntimeGuidance(
  hasActiveWorkstream: boolean,
): string {
  if (!hasActiveWorkstream) return "";
  return [
    `A private workstream is linked to this task.`,
    `Use \`publish_workstream_update\` for concise team-facing progress or completed deliverables.`,
    `Use \`propose_card_change\` for any change to card fields, completion, or archival - it applies to the card immediately, with no approval step.`,
    // Changed 2026-09-24 (George): local file paths are allowed on cards - handoff documents need their real locations.
    `Local file paths (for example where a handoff document lives) may be included. Never copy private URLs, identifiers, prompts, or run metadata into either tool.`,
  ].join(" ");
}

/**
 * The "home" of a task linked to a tracker card: the card id, its title, and
 * the card folder the session starts in (task.subdir, set at activation by
 * app/open/route.ts). Returns null for unlinked tasks or when the link is not
 * active. lastSynced comes from the folder's .card-project.json when present so
 * the prompt can say how fresh the local copy is.
 */
export function linkedCardHome(
  task: Task,
  project: Project,
): { id: string; title: string; folder: string; lastSynced: string } | null {
  const link = getWorkstreamByTask(task.id);
  if (!link || link.state !== "active") return null;
  const folder = taskCwd(task, project);
  let lastSynced = "";
  try {
    const meta = JSON.parse(readFileSync(join(folder, ".card-project.json"), "utf8")) as { last_synced?: string };
    if (typeof meta.last_synced === "string") lastSynced = meta.last_synced.slice(0, 10);
  } catch {
    /* no sync metadata - fine */
  }
  return { id: link.external_card_id, title: task.title, folder, lastSynced };
}

/**
 * Build the context string that is prepended to every task's session via the
 * agent's system prompt. This is the "write project context once" feature:
 * project description + conventions + the task framing + any prior-session
 * summaries from earlier generations of this task.
 */
export function buildProjectContext(project: Project, task: Task): string {
  const summaries = listSummaries(task.id);
  const ctx = project.context || [project.building, project.conventions].filter(Boolean).join("\n");
  const lines: string[] = [];
  const rules = loadSessionRules();
  if (rules) lines.push(rules);
  lines.push(`You are working inside the project "${project.name}".`);
  if (ctx) lines.push(`\nWhat we're building (project context):\n${ctx}`);
  if (project.branch) lines.push(`\nGit branch: ${project.branch}`);
  if (task.worktree_path) {
    lines.push(
      `\nWorkspace and merge workflow:\n` +
        `- Your writable isolated task workspace is \`${task.worktree_path}\`.\n` +
        `- The project's checkout and merge target is \`${project.repo_path}\`.\n` +
        `- Make all task edits in the task workspace. Operator keeps it separate so parallel tasks cannot collide.\n` +
        `- Completed edits reach the project checkout through the task's Changes tab and merge action.\n` +
        `- Do not describe the task workspace as the wrong folder, claim you are locked out because the project checkout is outside the sandbox, or recommend copying a temporary patch into the project checkout as the normal workflow.`
    );
  }
  const card = linkedCardHome(task, project);
  if (card) {
    lines.push(
      `\nLinked tracker card - this is home:\n` +
        `- Card: "${card.title}" (id ${card.id})\n` +
        `- Card folder: \`${card.folder}\` (your session starts there). It holds card.md, comments.md, emails/, and attachments/ as of the last sync` +
        (card.lastSynced ? ` (${card.lastSynced})` : "") +
        `.\n` +
        `- Anything asked about "this card", "the email", "the attachment", "the comment", or "the PDF" means THIS card. Check the card folder first, then the live card via the deal-tracker \`get_card\` tool (the folder can lag behind the tracker; comments and attachments added since the last sync exist only on the card).\n` +
        `- The rest of the project folder and the wider workspace are available for supporting knowledge. Use them AFTER the card, never instead of it, and never treat a different card's or deal's files as this card's.`
    );
  } else if (task.subdir) {
    lines.push(`\nThis task is scoped to the subfolder \`${task.subdir}\` (your session starts there). Keep your work inside it unless the task requires touching files elsewhere in the project.`);
  }
  lines.push(`\n---\nThe current task is: "${task.title}"`);
  if (task.description) lines.push(`Task details: ${task.description}`);

  if (summaries.length > 0) {
    lines.push(`\n--- Carried context from previous sessions of this task ---`);
    for (const s of summaries) {
      lines.push(`\n[Session ${s.generation} summary]\n${s.summary}`);
    }
    lines.push(`\nContinue this task from where the previous session left off.`);
  }

  // The user's own breadcrumbs (why done, where they left off, next step) —
  // the human counterpart of the summaries above. Oldest first so they read
  // as a story; the newest note is the freshest statement of intent.
  const notes = listTaskNotes(task.id);
  if (notes.length > 0) {
    lines.push(`\n--- Notes the user left on this task (oldest first) ---`);
    for (const n of [...notes].reverse()) {
      lines.push(`\n[${new Date(n.created_at).toISOString()} · session ${n.generation}]\n${n.content}`);
    }
  }

  lines.push(
    `\n---\nYou have an "orchestrator" MCP tool \`suggest_task\` that creates a task in ` +
      `THIS project. New tasks land in the user's "Suggested" tray for them to review and ` +
      `start later as their own Claude session. Use it two ways:\n` +
      `1. On request — when the user asks you to plan, break down, scope, or roadmap work, ` +
      `call \`suggest_task\` once per task you propose (set a sensible priority for each). ` +
      `Create as many as the plan needs.\n` +
      `2. Proactively — if you notice follow-up work that is out of scope for the CURRENT ` +
      `task, don't do it now; propose it with \`suggest_task\` instead.`
  );
  lines.push(
    `\nYou also have an \`expose_service\` MCP tool. When you start a long-running server ` +
      `(dev server, API, preview, Storybook, etc.) and it's listening, call ` +
      `\`expose_service(name, port)\` to register it — it appears in the project's Services ` +
      `panel and the tool RETURNS the URL the user can open (on a hosted instance that is a ` +
      `real public hostname like <name>--<instance-host>; reply with that exact URL so ` +
      `the user can verify your work live). Names are slugified to lowercase [a-z0-9-]. Prefer ` +
      `the PORT environment variable the orchestrator injected ` +
      `(${project.port ? `PORT=${project.port}` : "set per project"}) so the address is stable. ` +
      `Because the URL is proxied under that hostname, allow it in dev-server host checks when ` +
      `you scaffold or configure an app: Vite → \`server.allowedHosts: [process.env.ORCH_PUBLIC_HOST]\` ` +
      `(or \`true\`), Next dev → \`allowedDevOrigins: [process.env.ORCH_PUBLIC_HOST]\` in next.config, ` +
      `CRA/webpack-dev-server is pre-cleared via env. ORCH_PUBLIC_HOST is injected into services ` +
      `the orchestrator starts.`
  );
  return lines.join("\n");
}

/**
 * Prompt for an AI conflict-resolution turn. The task's base branch has been
 * trial-merged into its work branch (in the isolated worktree), leaving conflict
 * markers in the listed files. The agent resolves them in place. Completion
 * (commit + land into base) is handled by the app on the user's Accept, so we
 * tell it not to commit — though the flow is robust if it does anyway.
 */
export function buildConflictPrompt(baseBranch: string, conflicts: string[]): string {
  const files = conflicts.map((f) => `  - ${f}`).join("\n");
  return [
    `I merged \`${baseBranch}\` into this branch and hit merge conflicts. Please resolve every conflict.`,
    ``,
    `Conflicted files:`,
    files,
    ``,
    `For each file, remove all conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) and produce a`,
    `correct merged result that preserves the intent of BOTH sides — don't blindly pick one side.`,
    `Read the surrounding code and, where the two changes are independent, keep both. Run \`git diff\``,
    `or inspect the files as needed to understand each side.`,
    ``,
    `Do NOT run \`git commit\`, \`git merge --continue\`, or \`git add\` — just edit the files to a clean,`,
    `marker-free state. I'll review your resolution and land the merge myself.`,
  ].join("\n");
}

export function clip(s: unknown, n = 4000): string {
  // JSON.stringify(undefined) returns undefined, not a string. Tool-call
  // events can arrive with fields still missing (the Kimi wire protocol
  // streams arguments as later ToolCallPart deltas), and one clip(undefined)
  // in a describe path threw a TypeError that killed entire live turns
  // (found by the 2026-08-16 kimi-k3 admission run). Never throw here.
  const str = typeof s === "string" ? s : JSON.stringify(s, null, 2) ?? "";
  return str.length > n ? str.slice(0, n) + `\n… (${str.length - n} more chars)` : str;
}

// How a tool's eventual result should be summarized into a peek. The result
// content only arrives later (a separate tool_result event), so describeToolUse
// records the *kind* and summarizeResult turns the raw output into the peek.
export type ResultKind = "read" | "output" | "grep" | "glob";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Line diff for an Edit's old/new strings. Not full LCS: edits are localized,
// so trimming the common prefix/suffix and keeping a few unchanged lines of
// context on each side reads like a real diff hunk without the machinery.
const DIFF_CTX = 3;
export function diffLines(oldS: string, newS: string): DiffLine[] {
  const a = oldS ? oldS.split("\n") : [];
  const b = newS ? newS.split("\n") : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [
    ...a.slice(Math.max(0, pre - DIFF_CTX), pre).map((text) => ({ sign: " " as const, text })),
    ...a.slice(pre, a.length - suf).map((text) => ({ sign: "-" as const, text })),
    ...b.slice(pre, b.length - suf).map((text) => ({ sign: "+" as const, text })),
    ...a.slice(a.length - suf, a.length - suf + DIFF_CTX).map((text) => ({ sign: " " as const, text })),
  ];
}

// Cap the stored full diff so a giant Edit doesn't bloat the DB row / SSE event.
const DIFF_MAX = 400;
function capDiff(diff: DiffLine[]): DiffLine[] {
  return diff.length <= DIFF_MAX ? diff : [...diff.slice(0, DIFF_MAX), { sign: " ", text: `… (${diff.length - DIFF_MAX} more lines)` }];
}

// The always-visible peek: exact +/− counts over a capped slice of the hunk.
function diffPeek(diff: DiffLine[], label?: string): ToolPeek {
  const added = diff.filter((l) => l.sign === "+").length;
  const removed = diff.filter((l) => l.sign === "-").length;
  const MAX = 14;
  return { kind: "diff", added, removed, label, lines: diff.slice(0, MAX), truncated: Math.max(0, diff.length - MAX) };
}

// Turn a tool's raw (pre-clip) result into its peek, by kind.
export function summarizeResult(kind: ResultKind, raw: string): ToolPeek {
  const lines = raw ? raw.split("\n") : [];
  const hits = lines.filter((l) => l.trim()).length;
  switch (kind) {
    case "read":
      return { kind: "count", text: `Read ${plural(lines.length, "line")}` };
    case "grep":
      return { kind: "count", text: `Found ${plural(hits, "match")}` };
    case "glob":
      return { kind: "count", text: `Found ${plural(hits, "file")}` };
    case "output": {
      if (!raw.trim()) return { kind: "count", text: "No output" };
      const MAX = 6;
      return { kind: "lines", lines: lines.slice(0, MAX), truncated: Math.max(0, lines.length - MAX) };
    }
  }
}

// Returns a one-line title, an expandable detail of the tool input, an optional
// always-visible peek, and (for result-derived peeks) the kind to summarize the
// eventual output with. Mirrors what Claude Code reveals per tool; the names
// are the common coding-agent tool vocabulary, and the default arm renders any
// unknown tool generically — so other drivers can reuse this as-is.
export function describeToolUse(
  name: string,
  input: Record<string, unknown>
): { title: string; detail: string; peek?: ToolPeek; diff?: DiffLine[]; resultKind?: ResultKind } {
  const file = (input?.file_path || input?.path || input?.notebook_path) as string | undefined;
  const base = file ? file.split("/").slice(-1)[0] : undefined;
  switch (name) {
    case "Write": {
      const content = typeof input?.content === "string" ? input.content : "";
      const diff = diffLines("", content);
      return {
        title: `✎ Write ${base ?? "file"}`,
        detail: file ?? "",
        diff: capDiff(diff),
        peek: diffPeek(diff, `Wrote ${plural(diff.length, "line")}${base ? ` to ${base}` : ""}`),
      };
    }
    case "Edit":
    case "NotebookEdit": {
      const diff = diffLines(
        typeof input?.old_string === "string" ? input.old_string : "",
        typeof input?.new_string === "string" ? input.new_string : ""
      );
      return { title: `✎ Edit ${base ?? "file"}`, detail: file ?? "", diff: capDiff(diff), peek: diffPeek(diff) };
    }
    case "Read":
      return { title: `📖 Read ${base ?? "file"}`, detail: file ?? "", resultKind: "read" };
    case "Bash":
      return { title: `❯ ${String(input?.command ?? "").split("\n")[0].slice(0, 70)}`, detail: clip(input?.command), resultKind: "output" };
    case "Grep":
      return { title: `🔎 Grep ${String(input?.pattern ?? "")}`, detail: clip(input), resultKind: "grep" };
    case "Glob":
      return { title: `🔎 Glob ${String(input?.pattern ?? "")}`, detail: String(input?.pattern ?? ""), resultKind: "glob" };
    case "TodoWrite": {
      const todos = Array.isArray(input?.todos) ? (input.todos as Record<string, unknown>[]) : [];
      const items = todos.map((t) => ({ text: String(t?.content ?? t?.text ?? ""), status: String(t?.status ?? "pending") }));
      return { title: `☑ Updated todos`, detail: clip(input?.todos), peek: { kind: "todos", items } };
    }
    case "Task":
      return { title: `🤖 Subagent: ${String(input?.description ?? "task")}`, detail: clip(input?.prompt) };
    default:
      if (name.includes("suggest_task")) return { title: `✦ Suggested a task`, detail: clip(input) };
      if (name.includes("expose_service")) return { title: `🔌 Exposed ${String(input?.name ?? "service")} :${String(input?.port ?? "")}`, detail: clip(input) };
      return { title: `⚙ ${name}`, detail: clip(input) };
  }
}

// Format the user's ask answers into the text fed back to the agent as the
// tool result (for Claude, delivered via the PreToolUse hook's deny reason).
export function formatAnswers(questions: AskQuestion[], answers: AskAnswers): string {
  const lines = questions.map((q, i) => {
    const picked = (answers[i] ?? []).filter((s) => s && s.trim());
    return `- ${q.header || q.question}: ${picked.length ? picked.join(", ") : "(no selection)"}`;
  });
  return `The user answered your question${questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}\n\nProceed based on these choices.`;
}

// Minimal push/pull async queue. A driver's native message pump and any
// interactive hooks (asks) both push events; runTurn yields them in order
// until the queue closes. A queue is needed because hooks fire *inside* the
// native iteration (they park awaiting the user), so they can't yield from
// runTurn directly — they push here.
export function makeQueue<T>() {
  const items: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | null = null;
  let closed = false;
  return {
    push(item: T) {
      if (closed) return;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: item, done: false });
      } else items.push(item);
    },
    close() {
      closed = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: undefined as never, done: true });
      }
    },
    async *drain(): AsyncGenerator<T> {
      while (true) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (closed) return;
        const r = await new Promise<IteratorResult<T>>((res) => {
          waiting = res;
        });
        if (r.done) return;
        yield r.value;
      }
    },
  };
}

// Flatten a tool_result's content (string | block list | anything) to text.
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : typeof b === "string" ? b : "")).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}
