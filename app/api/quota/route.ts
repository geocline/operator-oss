import { OCX_PROXY_URL } from "@/lib/config";

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

/** Full quota response shape */
export interface QuotaResponse {
  available: boolean;
  fetchedAt: number;
  providers?: {
    claude?: ProviderQuota;
    codex?: ProviderQuota;
  };
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

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const fetchedAt = Date.now();

  // If proxy URL is not configured, return unavailable.
  if (!OCX_PROXY_URL) {
    return Response.json({ available: false, fetchedAt } as QuotaResponse, {
      status: 200,
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const proxyRes = await fetch(`${OCX_PROXY_URL}/api/provider-quotas`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!proxyRes.ok) {
      return Response.json({ available: false, fetchedAt } as QuotaResponse, {
        status: 200,
      });
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
      } as QuotaResponse,
      { status: 200 }
    );
  } catch {
    // Timeout, network error, or parse error - return unavailable.
    return Response.json({ available: false, fetchedAt } as QuotaResponse, {
      status: 200,
    });
  }
}
