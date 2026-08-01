"use client";

import { Icon } from "@/app/icons";
import { useQuota } from "./useQuota";
import type { QuotaResponse } from "@/app/api/quota/route";

/**
 * Format milliseconds since epoch as a human-readable countdown.
 * Returns "resets in Xd Yh" or "-" if null.
 */
function formatResetCountdown(resetAt: number | null): string {
  if (resetAt === null) return "-";
  const now = Date.now();
  if (resetAt <= now) return "expired";
  const ms = resetAt - now;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h`;
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return `resets in ${mins}m`;
}

/**
 * Get the color for a usage percent bar: green (< 50%), amber (50-79%), red (>= 80%).
 */
function getGaugeColor(percent: number): string {
  if (percent < 50) return "var(--green)";
  if (percent < 80) return "var(--amber)";
  return "var(--coral)";
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
 * Render a single quota window gauge.
 */
function QuotaGauge({ label, usedPercent, resetAt }: { label: string; usedPercent: number; resetAt: number | null }) {
  return (
    <div className="quota-window">
      <div className="quota-label">{label}</div>
      <div className="quota-bar-wrapper">
        <div className="quota-bar-bg">
          <div
            className="quota-bar-fill"
            style={{
              width: `${usedPercent}%`,
              backgroundColor: getGaugeColor(usedPercent),
            }}
          />
        </div>
        <span className="quota-percent">{usedPercent}%</span>
      </div>
      <div className="quota-reset">{formatResetCountdown(resetAt)}</div>
    </div>
  );
}

/**
 * Render a single model usage row.
 */
function ModelUsageRow({
  model,
  label,
  outputTokens7d,
  outputTokens1d,
  sessions7d,
  isFable,
  maxTokens,
}: {
  model: string;
  label: string;
  outputTokens7d: number;
  outputTokens1d: number;
  sessions7d: number;
  isFable: boolean;
  maxTokens: number;
}) {
  const barPercent = maxTokens > 0 ? (outputTokens7d / maxTokens) * 100 : 0;

  return (
    <div className={`model-usage-row ${isFable ? "model-usage-fable" : ""}`}>
      <div className="model-usage-label">{label}</div>
      <div className="model-usage-bar-wrapper">
        <div className="model-usage-bar-bg">
          <div
            className="model-usage-bar-fill"
            style={{
              width: `${barPercent}%`,
              backgroundColor: isFable ? "var(--accent)" : "var(--blue)",
            }}
          />
        </div>
        <span className="model-usage-text">
          {formatTokens(outputTokens7d)} out this week - {formatTokens(outputTokens1d)} today - {sessions7d} session{sessions7d !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * Provider card showing all windows and usage, with optional model usage section.
 */
function ProviderCard({
  name,
  data,
  models,
}: {
  name: string;
  data: { windows: Array<{ label: string; usedPercent: number; resetAt: number | null }>; resetCredits?: number };
  models?: Array<{ model: string; label: string; outputTokens7d: number; outputTokens1d: number; sessions7d: number; isFable: boolean }>;
}) {
  const maxUsed = Math.max(...data.windows.map((w) => w.usedPercent), 0);
  const maxTokens = models && models.length > 0 ? Math.max(...models.map((m) => m.outputTokens7d)) : 0;

  return (
    <div className="quota-card">
      <div className="quota-card-header">
        <div>
          <div className="quota-card-title">{name}</div>
          <div className="quota-card-sub">Max usage: {maxUsed}%</div>
        </div>
        {data.resetCredits !== undefined && (
          <span className="mono quota-card-credits">{data.resetCredits} credits</span>
        )}
      </div>
      <div className="quota-windows">
        {data.windows.map((w) => (
          <QuotaGauge key={w.label} label={w.label} usedPercent={w.usedPercent} resetAt={w.resetAt} />
        ))}
      </div>

      {models && models.length > 0 && (
        <div className="model-usage-section">
          <div className="model-usage-header">Recent usage by model</div>
          <div className="model-usage-rows">
            {models.map((m) => (
              <ModelUsageRow
                key={m.model}
                model={m.model}
                label={m.label}
                outputTokens7d={m.outputTokens7d}
                outputTokens1d={m.outputTokens1d}
                sessions7d={m.sessions7d}
                isFable={m.isFable}
                maxTokens={maxTokens}
              />
            ))}
          </div>
          <div className="model-usage-footnote">
            Token usage from your local session index - Anthropic does not expose per-model quota for this account.
          </div>
        </div>
      )}
    </div>
  );
}

export interface QuotaViewProps {
  onClose: () => void;
}

/**
 * Full quota view: a card per provider showing all windows, used percent,
 * and reset countdown. Polling every 60 seconds via useQuota hook.
 */
export function QuotaView({ onClose }: QuotaViewProps) {
  const { data, error } = useQuota();

  if (!data) {
    return (
      <div className="col col-session quota">
        <div className="quota-wrap">
          <div className="quota-s" style={{ padding: 40, textAlign: "center" }}>
            Loading quota data...
          </div>
        </div>
      </div>
    );
  }

  if (data.available === false) {
    return (
      <div className="col col-session quota">
        <div className="quota-wrap">
          <div className="quota-header">
            <button className="quota-back mono" onClick={onClose}>
              - WORKSPACE
            </button>
            <div>
              <div className="quota-title">Provider Quotas</div>
              <div className="quota-sub">Real-time fuel gauge</div>
            </div>
          </div>
          <div className="quota-s" style={{ padding: 40, textAlign: "center" }}>
            Quota proxy offline (opencodex on port 10100)
          </div>
        </div>
      </div>
    );
  }

  if (!data.providers || (Object.keys(data.providers).length === 0)) {
    return (
      <div className="col col-session quota">
        <div className="quota-wrap">
          <div className="quota-header">
            <button className="quota-back mono" onClick={onClose}>
              - WORKSPACE
            </button>
            <div>
              <div className="quota-title">Provider Quotas</div>
              <div className="quota-sub">Real-time fuel gauge</div>
            </div>
          </div>
          <div className="quota-s" style={{ padding: 40, textAlign: "center" }}>
            No quota data available.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="col col-session quota">
      <div className="quota-wrap">
        <div className="quota-header">
          <button className="quota-back mono" onClick={onClose}>
            - WORKSPACE
          </button>
          <div>
            <div className="quota-title">Provider Quotas</div>
            <div className="quota-sub">Real-time fuel gauge</div>
          </div>
        </div>

        <div className="quota-cards">
          {data.providers.claude && (
            <ProviderCard
              name="Anthropic Claude"
              data={data.providers.claude}
              models={data.claudeModels?.available && data.claudeModels.models ? data.claudeModels.models : undefined}
            />
          )}
          {data.providers.codex && (
            <ProviderCard name="OpenAI (Codex)" data={data.providers.codex} />
          )}
        </div>

        {error && (
          <div className="quota-s" style={{ padding: 16, color: "var(--coral)" }}>
            Error: {error}
          </div>
        )}

        <div className="quota-meta">
          <span className="mono quota-meta-text">
            Fetched {new Date(data.fetchedAt).toLocaleTimeString()}
          </span>
        </div>
      </div>
    </div>
  );
}
