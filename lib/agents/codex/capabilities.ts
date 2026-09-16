// Codex's capability descriptor — what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Split out of driver.ts so it can
// be read without importing @openai/codex-sdk (an async external under
// Turbopack — see lib/agents/capabilities.ts). Null model = inherit codex's
// built-in default (see DEFAULT_CODEX_MODEL in ./pricing).

import type { AgentCapabilities } from "../types";
import { codexApiKey } from "./auth";

// Context windows are what the codex CLI itself runs against (the catalog's
// `context_window`, the basis of its compaction trigger and /status gauge), not
// the API maximum: GPT-6 Astra is 1.05M via the API but codex runs it at 272k
// (max_context_window 872k is the extended tier codex may grow into). Verified
// against the live catalog (codex-cli 0.154.0, 2026-09-13).
const CTX_CODEX = 272_000;
const CTX_SPARK = 128_000;

export const CODEX_CAPABILITIES: AgentCapabilities = {
  // Mirrors the codex CLI's own model catalog (what its `/model` menu lists),
  // NOT a hand-picked subset: values are the presets' `slug`s, ordered by their
  // `priority`; hidden presets (gpt-reserve, codex-auto-review) are omitted.
  // Groups must stay contiguous: the picker opens a new section whenever
  // `group` changes (SessionView.tsx). Re-check this list when bumping
  // @openai/codex - the codex model line moves faster than Claude's, and a
  // stale entry here is a model the CLI no longer accepts (GPT-5.4, 5.4 Mini,
  // 5.3 Codex and 5.2 all left the catalog between 0.142 and 0.154; their
  // pricing rows stay in ./pricing so historical turns still price).
  models: [
    { value: "gpt-6-astra", label: "GPT-6 Astra", sub: "most capable · computer use", contextWindow: CTX_CODEX, group: "Latest" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", sub: "reliable agentic workhorse", contextWindow: CTX_CODEX, group: "Latest" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", sub: "balanced intelligence and cost", contextWindow: CTX_CODEX, group: "Latest" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", sub: "efficient high-volume work", contextWindow: CTX_CODEX, group: "Latest" },
    { value: "gpt-5.5", label: "GPT-5.5", sub: "previous frontier model", contextWindow: CTX_CODEX, group: "Previous versions" },
    { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", sub: "ultra-fast, small context", contextWindow: CTX_SPARK, group: "Previous versions" },
  ],
  // Off/Think/Think hard/Ultrathink → codex's model_reasoning_effort scale
  // (low/medium/high/xhigh — see EFFORT in ./driver.ts). Codex can't disable
  // reasoning ("minimal" 400s the turn), so "Off" is its floor, "low". The
  // GPT-5.6/6 line also accepts "max" (and "ultra" on Astra/Sol/Terra) but
  // GPT-5.5 and Spark stop at xhigh, so xhigh stays the portable ceiling; the
  // subs name the actual effort each preset sends so the picker stays honest.
  reasoningOptions: [
    { value: "off", label: "Off", sub: "low effort — codex's minimum" },
    { value: "think", label: "Think", sub: "medium effort (codex default)" },
    { value: "think_hard", label: "Think hard", sub: "high effort" },
    { value: "ultrathink", label: "Ultrathink", sub: "extra-high effort" },
  ],
  // Only the modes with a real codex analog are declared. bypassPermissions maps
  // to workspace-write + approvals-never (auto-run); plan maps to a read-only
  // sandbox. acceptEdits has no distinct codex analog (writes already auto-apply)
  // and on-request approvals can't be answered non-interactively, so neither is
  // offered — both fall back to bypassPermissions.
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "workspace write, no approvals (default)" },
    { value: "plan", label: "Plan mode", sub: "read-only, propose without editing" },
  ],
  // Interactive asks arrive via the MCP bridge's ask_user tool (the card UI and
  // /answer route are shared with Claude's AskUserQuestion flow).
  supportsAsks: true,
  // The orchestrator's suggest_task / expose_service tools reach Codex through
  // the portable stdio MCP bridge (scripts/orch-mcp.mjs), registered per turn
  // by the driver — the same tools the Claude driver mounts in-process.
  supportsMcpTools: true,
  // ChatGPT-plan auth reports tokens only — no billed dollar figure — so the
  // cost the driver emits is an estimate (tokens × published API prices for
  // the resolved model). The descriptor stays honest: reportsCostUsd=false,
  // and costIsEstimated=true has the UI show the figure with an ~.
  reportsCostUsd: false,
  costIsEstimated: true,
  supportsResume: true,
  apiKeyHint: codexApiKey.hint,
  loginStyle: "device_code",
};
