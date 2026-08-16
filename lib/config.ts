import path from "node:path";
import os from "node:os";

/**
 * Per-instance configuration, driven entirely by environment variables so an
 * instance can be relocated (fresh container, different user, different ports)
 * with zero code edits. Every value has a documented default — see README
 * "Configuration" and .env.example.
 *
 * Server-side only. The two plain-Node entrypoints (server.js, pty-server.js)
 * can't import TS, so they read the same env vars directly — keep names in sync.
 */

/** App-data dir for the SQLite database. */
export const DB_DIR = process.env.ORCH_DB_DIR || path.join(os.homedir(), ".zen-orchestrator");

/** Where per-task git worktrees are created (must be outside any project repo). */
export const WORKTREES_DIR =
  process.env.ORCH_WORKTREES_DIR || path.join(os.homedir(), ".agent-orchestrator", "worktrees");

/** Where "Clone a repository" puts cloned repos (the container home's projects/). */
export const PROJECTS_DIR = process.env.ORCH_PROJECTS_DIR || path.join(os.homedir(), "projects");

/**
 * Path to the user's logged-in `claude` binary (Max subscription). The SDK
 * auto-detects it on PATH, but Next's server may run with a trimmed PATH, so
 * we pin it.
 */
export const CLAUDE_CLI_PATH =
  process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), ".local", "bin", "claude");

/**
 * Path to the `codex` binary the Codex driver drives (via @openai/codex-sdk).
 * Empty = let the SDK auto-resolve the binary bundled with its @openai/codex
 * dependency, and let the auth helpers fall back to `codex` on PATH (the Docker
 * image installs it globally next to `claude`). Set this to pin a specific
 * binary when PATH is trimmed or a different install should be used.
 */
export const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || "";

/** Loopback LiteLLM gateway used only by the opt-in metered agent drivers. */
export const LITELLM_BASE_URL =
  (process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000/v1").replace(/\/+$/, "");

/**
 * Local gateway client credential. Provider credentials (including the
 * chargeback-specific OpenRouter key) remain inside LiteLLM and are never read
 * by Operator.
 */
export const LITELLM_API_KEY =
  process.env.LITELLM_API_KEY || "sk-litellm-local";

const configuredLiteLLMHome = process.env.LITELLM_CODEX_HOME;
if (configuredLiteLLMHome && !path.isAbsolute(configuredLiteLLMHome)) {
  throw new Error("LITELLM_CODEX_HOME must be an absolute path");
}

/** Separate Codex config/session root for metered LiteLLM-backed turns. */
export const LITELLM_CODEX_HOME =
  configuredLiteLLMHome || path.join(os.homedir(), ".operator", "litellm-codex");

const configuredLiteLLMClaudeHome = process.env.LITELLM_CLAUDE_HOME;
if (configuredLiteLLMClaudeHome && !path.isAbsolute(configuredLiteLLMClaudeHome)) {
  throw new Error("LITELLM_CLAUDE_HOME must be an absolute path");
}

/** Separate task-local Claude Code config/session root for LiteLLM-backed turns. */
export const LITELLM_CLAUDE_HOME =
  configuredLiteLLMClaudeHome || path.join(os.homedir(), ".operator", "litellm-claude");

const configuredPrimeHome = process.env.LITELLM_PRIME_HOME;
if (configuredPrimeHome && !path.isAbsolute(configuredPrimeHome)) {
  throw new Error("LITELLM_PRIME_HOME must be an absolute path");
}

/**
 * Task-local Prime Agent state root for metered LiteLLM-backed Prime turns.
 * Each task gets `<home>/<task-id>/` (config + per-generation sessions), so a
 * hard delete can retire one task's Prime state without touching any other's.
 */
export const LITELLM_PRIME_HOME =
  configuredPrimeHome || path.join(os.homedir(), ".operator", "litellm-prime");

const configuredKimiCodeHome = process.env.LITELLM_KIMI_CODE_HOME;
if (configuredKimiCodeHome && !path.isAbsolute(configuredKimiCodeHome)) {
  throw new Error("LITELLM_KIMI_CODE_HOME must be an absolute path");
}

/** Task-local Kimi Code config/session root for metered LiteLLM-backed turns. */
export const LITELLM_KIMI_CODE_HOME =
  configuredKimiCodeHome || path.join(os.homedir(), ".operator", "litellm-kimi-code");

/** Pinned Kimi Code CLI path; blank resolves `kimi` on PATH. */
export const KIMI_CODE_CLI_PATH = process.env.KIMI_CODE_CLI_PATH || "kimi";

/**
 * Models the INTERNAL one-shot jobs run on (lib/agents/oneshots.ts) — the turns
 * that run outside the main chat and that the user never picks a model for:
 * the "where you left off" recap, the /clear handoff note, and the "Refresh
 * with AI" context draft. Left unset these inherit whatever the CLI defaults to
 * (Opus, on a typical Claude login), which is far more model than any of them
 * needs — the recap is 2-4 bullets, the other two are summarize/write jobs with
 * the source material already in the prompt.
 *
 * Two tiers per agent: the recap is throwaway (cheapest model), while the
 * handoff note and the context draft are durable — they seed the next session's
 * context — so they get the mid tier. Set to an empty string to opt out and
 * inherit the CLI default again.
 */
export const CLAUDE_RECAP_MODEL = process.env.ORCH_CLAUDE_RECAP_MODEL ?? "haiku";
export const CLAUDE_ONESHOT_MODEL = process.env.ORCH_CLAUDE_ONESHOT_MODEL ?? "sonnet";
export const CODEX_RECAP_MODEL = process.env.ORCH_CODEX_RECAP_MODEL ?? "gpt-5.6-luna";
export const CODEX_ONESHOT_MODEL = process.env.ORCH_CODEX_ONESHOT_MODEL ?? "gpt-5.6-luna";

/**
 * Opt-in to billing an environment-provided agent API key (ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY). Off by default: both entrypoints
 * strip those vars at boot (lib/env-keys.mjs — server.js and pty-server.js read
 * the env name directly, as does docker/entrypoint.sh) so a key leaked in from
 * a shell profile or unit file can't silently switch turns from the connected
 * subscription login to per-token billing (issue #4). Keys saved through the
 * app's own "I have an API key" path are unaffected — they're re-applied from
 * their 0600 files at db init, after the strip.
 */
export const ALLOW_API_KEY_ENV = ["1", "true", "on"].includes(
  String(process.env.ORCH_ALLOW_API_KEY_ENV || "").toLowerCase(),
);

/**
 * Show the eval-only LiteLLM/gateway model pairings merged into the public
 * claude/codex agents (app/api/agents/route.ts merges litellm-claude's/
 * litellm-codex's vetted models into the native claude/codex model lists).
 * Those pairings exist for admission-testing machinery, not everyday routing -
 * Geo's hard subscription-only rule is that an Anthropic/OpenAI-family model
 * never reaches a LiteLLM route in normal use (see lib/agents/litellm/family.ts
 * for the harness-side enforcement of that rule). Off by default, so a fresh
 * instance never shows eval pairings; read at request time (a function, not a
 * baked-in module-load constant) so it can be toggled per test case.
 */
export function showEvalModels(): boolean {
  return ["1", "true", "on"].includes(String(process.env.ORCH_SHOW_EVAL_MODELS || "").toLowerCase());
}

/**
 * Base TCP port for per-project managed services. Each project is assigned a
 * stable port (base + slot) at creation, stored on its row, injected as PORT
 * into the dev/setup/test service env and the project's PTY shell. Override to
 * relocate the block (e.g. avoid a clash with the app/pty ports). See lib/services.ts.
 */
export const SERVICE_PORT_BASE = process.env.ORCH_SERVICE_PORT_BASE
  ? Number(process.env.ORCH_SERVICE_PORT_BASE)
  : 4300;

/**
 * Per-service log ring-buffer cap (lines). Each managed service keeps at most
 * this many captured stdout/stderr lines in memory — enough to scroll back
 * through startup + recent output without growing unbounded for a dev server
 * that's been up for days.
 */
export const SERVICE_LOG_LINES = process.env.ORCH_SERVICE_LOG_LINES
  ? Number(process.env.ORCH_SERVICE_LOG_LINES)
  : 1500;

/**
 * The origin the app answers on over loopback, for in-container server-to-server
 * calls. The stdio MCP bridge (scripts/orch-mcp.mjs, spawned by the Codex CLI)
 * POSTs the suggest_task / expose_service tool calls back to the app's internal
 * endpoints at this base. Defaults to 127.0.0.1 on the app's own PORT (server.js
 * reads the same PORT). Override only if the app is reached differently from
 * inside the box.
 */
export const INTERNAL_BASE_URL =
  process.env.ORCH_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

/** Absolute path to the stdio MCP bridge the non-Claude drivers register per turn. */
export const ORCH_MCP_SCRIPT = path.join(process.cwd(), "scripts", "orch-mcp.mjs");

/**
 * Absolute path to the Operator tool extension the Prime driver loads with
 * `--extension` per turn. Prime's extension host (jiti) loads the TS source
 * directly and virtualizes its `@sinclair/typebox` import, so the file ships
 * as-is in the runtime image (see Dockerfile).
 */
export const PRIME_OPERATOR_EXTENSION_PATH = path.join(
  process.cwd(),
  "scripts",
  "prime-operator-extension.ts",
);

/**
 * The public origin the app is served from (e.g. https://orch.example.com when
 * behind a tunnel/reverse proxy). Used by the client to build absolute
 * ws(s):// URLs. Empty = same-origin via window.location, which is correct for
 * any single-hostname deployment.
 */
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

/**
 * The base URL for the OpenCodex proxy's provider-quotas endpoint
 * (e.g. http://127.0.0.1:10100). Used to fetch real-time quota/fuel-gauge data.
 * Loopback-only on Geo's fork; the proxy serves quota.reports[] with percent-used
 * and reset-at timestamps per provider. Empty = proxy disabled (quotas unavailable).
 * Default: http://127.0.0.1:10100.
 */
export const OCX_PROXY_URL = process.env.OCX_PROXY_URL || "http://127.0.0.1:10100";
