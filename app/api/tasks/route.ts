import { NextResponse } from "next/server";
import { createTask, getProject, listAllTasksLite } from "@/lib/store";
import { track } from "@/lib/analytics";
import { getCapabilities, isKnownAgent } from "@/lib/agents/capabilities";
import { resolvedRunDefault, validateLaunchConfiguration } from "@/lib/agents/launchConfig";

export const dynamic = "force-dynamic";

// Powers the ⌘K palette's session search: every real task across all active
// projects, labeled with its project. Fetched fresh each time the palette opens.
export async function GET() {
  return NextResponse.json({ tasks: listAllTasksLite() });
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body?.project_id || !getProject(body.project_id))
    return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  if (!body?.title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
  const workspaceMode = body.workspace_mode ?? "direct";
  if (workspaceMode !== "direct" && workspaceMode !== "worktree") {
    return NextResponse.json({ error: "workspace_mode must be direct or worktree" }, { status: 400 });
  }
  const agent =
    typeof body.agent === "string"
      ? body.agent
      : getProject(body.project_id)!.default_agent;
  if (!isKnownAgent(agent)) {
    return NextResponse.json({ error: `unknown harness "${agent}"` }, { status: 400 });
  }
  // A control the caller didn't send falls back to the app-level default
  // (Settings → Run defaults) before the built-in — otherwise those settings
  // would be unreachable, since a task row now always stores explicit values.
  // resolvedRunDefault has already dropped anything this harness can't run.
  const permissionMode =
    typeof body.permission_mode === "string"
      ? body.permission_mode
      : resolvedRunDefault("default_permission_mode", agent) ?? "bypassPermissions";
  if (!getCapabilities(agent).permissionModes.some((mode) => mode.value === permissionMode)) {
    return NextResponse.json(
      { error: `permission_mode "${permissionMode}" is unsupported by this harness` },
      { status: 400 },
    );
  }
  const model = typeof body.model === "string" ? body.model : resolvedRunDefault("default_model", agent);
  const reasoning =
    typeof body.reasoning === "string" ? body.reasoning : resolvedRunDefault("default_reasoning", agent);
  // Only what the CALLER sent is validated as a pair: an app default is already
  // known-good on its own, and demanding its counterpart be set too would turn
  // one configured default into a 400 on every task creation.
  if (typeof body.model === "string" || typeof body.reasoning === "string") {
    const configError = validateLaunchConfiguration({ agent, model, reasoning });
    if (configError) {
      return NextResponse.json({ error: configError }, { status: 400 });
    }
  }
  const task = createTask({
    project_id: body.project_id,
    title: body.title.trim(),
    description: body.description ?? "",
    priority: body.priority ?? "med",
    suggested: !!body.suggested,
    // Agent is chosen at creation and fixed for the task's life (sessions can't
    // migrate between CLIs); createTask falls back to the project default.
    agent,
    model,
    reasoning,
    workspace_mode: workspaceMode,
    permission_mode: permissionMode,
  });
  // `suggested` tasks are agent proposals in the tray; a real user-created task
  // is the funnel's "first task" step. Flag which so the funnel can filter.
  track("task_created", { task_id: task.id, project_id: task.project_id, suggested: !!body.suggested });
  return NextResponse.json(task, { status: 201 });
}
