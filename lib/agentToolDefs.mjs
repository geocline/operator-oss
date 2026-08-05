/* Shared definitions for the orchestrator's agent-facing MCP tools.
 *
 * The SAME tool names, descriptions and parameter docs feed two places that
 * expose these tools to a coding agent:
 *   - lib/agents/claude/driver.ts   the in-process SDK MCP server (createSdkMcpServer)
 *   - scripts/orch-mcp.mjs          the portable stdio MCP bridge (Codex + future CLIs)
 * Keeping the strings here means the two can never drift.
 *
 * Plain .mjs on purpose: it's imported both through Next's bundler (the Claude
 * driver, TS) AND by raw Node ESM (the bridge script, plain JS) — same shape as
 * lib/cf-access.mjs. Only literal data lives here (no zod, no SDK types) so both
 * consumers can build their own schema objects from it. Every such .mjs the
 * bridge needs must also be COPY'd into the runtime image (see Dockerfile).
 */

export const SUGGEST_TASK = {
  name: "suggest_task",
  description:
    "Create a task in this project's orchestrator — it lands in the user's Suggested tray to review and start later as its own session. " +
    "Use when the user asks you to plan/break down/roadmap work (call once per task), or to capture out-of-scope follow-ups. " +
    "To suggest ORDERED work, create the blocker tasks first, then set `blocked_by` on the dependent task using the ids returned by this tool " +
    "(titles of tasks suggested earlier this session also work). A blocked task can't be started until everything it's blocked by is done.",
  params: {
    title: "Short task title",
    description: "What the task should do — becomes the task's initial prompt",
    priority: "Task priority: hi, med (default) or lo",
    blocked_by:
      "Ids (or titles, for tasks suggested earlier this session) of tasks that must be done before this one can start.",
  },
  priorities: ["hi", "med", "lo"],
  defaultPriority: "med",
};

export const EXPOSE_SERVICE = {
  name: "expose_service",
  description:
    "Register a long-running server you just started (e.g. a dev server, API, or preview) with the orchestrator so it appears in the " +
    "project's Services panel and the user gets a working URL. Call this right after the server is up and listening. Returns the URL to " +
    "reach it. Use the PORT environment variable the orchestrator injected when one is set; otherwise pass the actual port your server bound.",
  params: {
    name: 'Short label for the service, e.g. "dev", "api", "storybook".',
    port: "The TCP port the server is listening on.",
  },
};

export const ASK_USER = {
  name: "ask_user",
  description:
    "Ask the user one or more multiple-choice questions and wait for their answer before continuing. Use this when you're blocked on a " +
    "decision only the user can make (which approach to take, a missing requirement, a destructive action to confirm). The question is " +
    "surfaced in the orchestrator UI as an interactive card; this tool blocks until the user answers, then returns their selections.",
  params: {
    questions:
      "The questions to ask. Each has a `question` (the full prompt), a short `header` label, and 2–4 `options` (each an object with a `label`).",
  },
};

export const PUBLISH_WORKSTREAM_UPDATE = {
  name: "publish_workstream_update",
  description:
    "Publish a concise, self-contained team-facing progress update for the card linked to the current task. " +
    "The current task determines the destination and the integration supplies the fixed comment identity. " +
    "Never include private paths, internal URLs, prompts, run details, or tool/person names. " +
    "Optional files must be supported deliverables inside the current task workspace.",
  params: {
    body:
      "Concise, self-contained update text that is safe for the whole deal team to read.",
    files:
      "Optional paths to supported deliverables inside the current task workspace. Paths are used only to read the files and are never posted.",
  },
};

export const PROPOSE_CARD_CHANGE = {
  name: "propose_card_change",
  description:
    "Propose an important change to the card linked to the current task for the owner's explicit review. " +
    "Use card_update for allowlisted field changes, complete_card to propose completion, or archive_card to propose archival. " +
    "The current task determines the destination; never include private implementation detail in card-facing values.",
  params: {
    kind: "The proposal kind: card_update, complete_card, or archive_card.",
    value:
      "For card_update, an object containing only supported card fields. For complete_card or archive_card, use an empty object.",
  },
  kinds: ["card_update", "complete_card", "archive_card"],
};
