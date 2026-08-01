import { OCX_PROXY_URL } from "@/lib/config";
import path from "path";
import os from "os";

/** A time window quota (e.g., "weekly" or "5h") */
interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetAt: number | null; // milliseconds since epoch, null if no reset
}

/** Per-provider quota info */
interface ProviderQuota {
  windows: QuotaWindow[];
  resetCredits?: number; // OpenAI only
}

/** Model usage entry */
export interface ModelUsage {
  model: string;
  label: string;
  outputTokens7d: number;
  outputTokens1d: number;
  sessions7d: number;
  isFable: boolean;
}

/** Claude models info */
export interface ClaudeModelsInfo {
  available: boolean;
  models: ModelUsage[];
}

/** Full quota response shape */
export interface QuotaResponse {
  available: boolean;
  fetchedAt: number;
  providers?: {
    claude?: ProviderQuota;
    codex?: ProviderQuota;
  };
  claudeModels?: ClaudeModelsInfo;
}

/** Raw response from the OCX proxy */
interface ProxyReport {
  provider: string;
  label: string;
  quota: {
    weeklyPercent: number;
    weeklyResetAt: number;
    customWindows?: Array<{ label: string; percent: number; resetAt: number }>;
    resetCredits?: number;
    updatedAt: number;
  };
}

interface ProxyResponse {
  generatedAt: number;
  reports: ProxyReport[];
}

/**
 * Normalize timestamps to milliseconds. OpenAI uses seconds for weeklyResetAt,
 * Anthropic uses milliseconds. If a timestamp is <= 10_000_000_000, assume
 * seconds and multiply by 1000.
 */
function normalizeTimestamp(ts: number): number {
  return ts <= 10_000_000_000 ? ts * 1000 : ts;
}

/**
 * Clamp a percent to 0-100.
 */
function clampPercent(p: number): number {
  return Math.max(0, Math.min(100, p));
}

/**
 * Format a token count compactly: 1234 -> "1.2k", 1234567 -> "1.2M"
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  }
  return String(n);
}

/**
 * Make a friendly label from a model name.
 * e.g., "claude-fable-5" -> "Fable 5", "claude-opus-4-6" -> "Opus 4.6"
 */
function makeLabel(model: string): string {
  if (!model || model === "unknown") return "Unknown";
  // Strip "claude-" prefix
  let name = model.replace(/^claude-/, "");
  // Title case first segment, keep the rest: "fable-5" -> "Fable 5"
  const parts = name.split("-");
  if (parts.length > 0) {
    parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }
  return parts.join(" ");
}

/**
 * Fetch recent per-model token usage from the conversations index.
 * Returns models sorted by output tokens (7d) descending, limit 6.
 */
function fetchClaudeModelsUsage(): ClaudeModelsInfo {
  try {
    // Locate the conversations database
    const conversationsPath = path.join(
      os.homedir(),
      "Claude Projects",
      "conversations-dashboard",
      "data",
      "index.db"
    );

    // Lazy require better-sqlite3
    const Database = require("better-sqlite3");
    const db = new Database(conversationsPath, { readonly: true, fileMustExist: true });

    try {
      // Calculate date cutoffs
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const sevenDaysAgoStr = sevenDaysAgo.toISOString();
      const oneDayAgoStr = oneDayAgo.toISOString();

      // Query per-model sums for the past 7 days
      const rows: Array<{
        model: string | null;
        output_tokens_7d: number;
        output_tokens_1d: number;
        sessions_7d: number;
      }> = db
        .prepare(
          `
        SELECT
          model,
          SUM(CASE WHEN modified >= ? THEN output_tokens ELSE 0 END) as output_tokens_7d,
          SUM(CASE WHEN modified >= ? THEN output_tokens ELSE 0 END) as output_tokens_1d,
          COUNT(CASE WHEN modified >= ? THEN 1 ELSE NULL END) as sessions_7d
        FROM sessions
        WHERE source = 'claude'
        GROUP BY model
        ORDER BY output_tokens_7d DESC
        LIMIT 6
      `
        )
        .all(sevenDaysAgoStr, oneDayAgoStr, sevenDaysAgoStr) as any;

      const models: ModelUsage[] = rows
        .map((row) => {
          const model = row.model || "unknown";
          return {
            model,
            label: makeLabel(model),
            outputTokens7d: row.output_tokens_7d || 0,
            outputTokens1d: row.output_tokens_1d || 0,
            sessions7d: row.sessions_7d || 0,
            isFable: /fable|mythos/i.test(model),
          };
        })
        .filter((m) => m.outputTokens7d > 0); // Only include models with usage

      db.close();

      return {
        available: true,
        models,
      };
    } catch (innerErr) {
      // Query or close failed
      try {
        db.close();
      } catch {
        // ignore
      }
      return {
        available: false,
        models: [],
      };
    }
  } catch {
    // Database not found, locked, or better-sqlite3 issue
    return {
      available: false,
      models: [],
    };
  }
}

// Module-level cache for DB queries
let claudeModelsCached: ClaudeModelsInfo | null = null;
let claudeModelsCacheTime = 0;
const CLAUDE_MODELS_CACHE_TTL = 120_000; // 120 seconds

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const fetchedAt = Date.now();

  // Fetch Claude models usage from the conversations index (with caching).
  let claudeModels: ClaudeModelsInfo | null = null;
  const now = Date.now();
  if (claudeModelsCached && now - claudeModelsCacheTime < CLAUDE_MODELS_CACHE_TTL) {
    claudeModels = claudeModelsCached;
  } else {
    claudeModels = fetchClaudeModelsUsage();
    claudeModelsCached = claudeModels;
    claudeModelsCacheTime = now;
  }

  // If proxy URL is not configured, return unavailable.
  if (!OCX_PROXY_URL) {
    return Response.json(
      { available: false, fetchedAt, claudeModels } as QuotaResponse,
      {
        status: 200,
      }
    );
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const proxyRes = await fetch(`${OCX_PROXY_URL}/api/provider-quotas`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!proxyRes.ok) {
      return Response.json(
        { available: false, fetchedAt, claudeModels } as QuotaResponse,
        {
          status: 200,
        }
      );
    }

    const data: ProxyResponse = await proxyRes.json();
    const providers: Record<string, ProviderQuota> = {};

    for (const report of data.reports) {
      const providerKey =
        report.provider === "openai" ? "codex" : report.provider === "anthropic" ? "claude" : report.provider;
      const windows: QuotaWindow[] = [];

      // Add weekly window.
      windows.push({
        label: "weekly",
        usedPercent: clampPercent(report.quota.weeklyPercent),
        resetAt: normalizeTimestamp(report.quota.weeklyResetAt),
      });

      // Add custom windows if present.
      if (report.quota.customWindows) {
        for (const cw of report.quota.customWindows) {
          windows.push({
            label: cw.label,
            usedPercent: clampPercent(cw.percent),
            resetAt: normalizeTimestamp(cw.resetAt),
          });
        }
      }

      const providerQuota: ProviderQuota = { windows };

      // Pass through resetCredits for OpenAI.
      if (report.quota.resetCredits !== undefined) {
        providerQuota.resetCredits = report.quota.resetCredits;
      }

      providers[providerKey] = providerQuota;
    }

    return Response.json(
      {
        available: true,
        fetchedAt,
        providers,
        claudeModels,
      } as QuotaResponse,
      { status: 200 }
    );
  } catch {
    // Timeout, network error, or parse error - return unavailable.
    return Response.json(
      { available: false, fetchedAt, claudeModels } as QuotaResponse,
      {
        status: 200,
      }
    );
  }
}
