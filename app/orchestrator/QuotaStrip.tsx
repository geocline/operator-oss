"use client";

import { useQuota } from "./useQuota";

/**
 * Get the color for a usage percent: green (<50%), amber (50-79%), coral (>=80%).
 */
function getGaugeColor(percent: number): string {
  if (percent < 50) return "var(--green)";
  if (percent < 80) return "var(--amber)";
  return "var(--coral)";
}

/**
 * Calculate the max used percent across all windows for a provider.
 */
function maxPercent(windows: Array<{ usedPercent: number }>): number {
  return Math.max(...windows.map((w) => w.usedPercent), 0);
}

/**
 * Compact header indicator: two tiny segments (C and X) showing max usage per provider.
 * Mounted in the topbar, always visible. Clicking opens the quota view.
 */
export interface QuotaStripProps {
  onOpenQuota: () => void;
}

export function QuotaStrip({ onOpenQuota }: QuotaStripProps) {
  const { data } = useQuota();

  // Render nothing if data is not available.
  if (!data || data.available === false || !data.providers) {
    return null;
  }

  const claudeMax = data.providers.claude ? maxPercent(data.providers.claude.windows) : null;
  const codexMax = data.providers.codex ? maxPercent(data.providers.codex.windows) : null;

  // Render nothing if we have no provider data.
  if (claudeMax === null && codexMax === null) {
    return null;
  }

  // Build tooltip text.
  const tooltipParts: string[] = [];
  if (claudeMax !== null) tooltipParts.push(`Claude ${claudeMax}% used (weekly)`);
  if (codexMax !== null) tooltipParts.push(`Codex ${codexMax}% used`);
  const tooltip = tooltipParts.join(" - ");

  return (
    <button
      className="quota-strip"
      title={tooltip}
      aria-label="Provider quotas"
      onClick={onOpenQuota}
    >
      {claudeMax !== null && (
        <div className="quota-strip-seg">
          <div
            className="quota-strip-fill"
            style={{
              backgroundColor: getGaugeColor(claudeMax),
              width: `${claudeMax}%`,
            }}
          />
          <span className="quota-strip-label">C</span>
        </div>
      )}
      {codexMax !== null && (
        <div className="quota-strip-seg">
          <div
            className="quota-strip-fill"
            style={{
              backgroundColor: getGaugeColor(codexMax),
              width: `${codexMax}%`,
            }}
          />
          <span className="quota-strip-label">X</span>
        </div>
      )}
    </button>
  );
}
