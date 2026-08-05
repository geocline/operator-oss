"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { useQuota } from "./useQuota";
import { jget } from "./api";

interface QuotaAdvisorProps {
  onOpenQuota: () => void;
}

/**
 * Format milliseconds until reset as "Xd Yh", "Xh", or "Xm".
 */
function formatResetTime(resetAt: number | null): string {
  if (resetAt === null) return "";
  const now = Date.now();
  if (resetAt <= now) return "expired";
  const ms = resetAt - now;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return `${mins}m`;
}

/**
 * Quota threshold advisor banner: shows when quota usage exceeds the configured
 * threshold. Appears above the workspace, is dismissible per-session, and directs
 * users to consider switching tasks to Codex via the session header's agent
 * picker (which hands an in-flight task over across a /clear boundary).
 */
export function QuotaAdvisor({ onOpenQuota }: QuotaAdvisorProps) {
  const { data: quotaData } = useQuota();
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Fetch settings on mount
  useEffect(() => {
    jget<Record<string, string>>("/api/settings")
      .then(setSettings)
      .catch(() => {});
  }, []);

  // If dismissed, quota is unavailable, or settings not loaded, render nothing
  if (dismissed || !quotaData || quotaData.available === false || !settings) {
    return null;
  }

  // Parse settings with defaults
  const advisorEnabled = settings.quota_advisor_enabled !== "0"; // default "1"
  const threshold = Math.min(99, Math.max(1, parseInt(settings.quota_warn_threshold || "80", 10) || 80));

  if (!advisorEnabled) {
    return null;
  }

  // Check if any provider has a window at or above the threshold
  const claudeExceeded = quotaData.providers?.claude?.windows?.some(
    (w) => w.usedPercent >= threshold
  );
  const codexExceeded = quotaData.providers?.codex?.windows?.some(
    (w) => w.usedPercent >= threshold
  );

  if (!claudeExceeded && !codexExceeded) {
    return null;
  }

  // Determine max usage and reset time for each provider
  let claudeMax = 0;
  let claudeReset: number | null = null;
  if (quotaData.providers?.claude?.windows) {
    quotaData.providers.claude.windows.forEach((w) => {
      if (w.usedPercent > claudeMax) {
        claudeMax = w.usedPercent;
        claudeReset = w.resetAt;
      }
    });
  }

  let codexMax = 0;
  let codexReset: number | null = null;
  if (quotaData.providers?.codex?.windows) {
    quotaData.providers.codex.windows.forEach((w) => {
      if (w.usedPercent > codexMax) {
        codexMax = w.usedPercent;
        codexReset = w.resetAt;
      }
    });
  }

  // Build the banner message
  let message: React.ReactNode;
  if (claudeExceeded && codexExceeded) {
    const claudeResetStr = formatResetTime(claudeReset);
    const codexResetStr = formatResetTime(codexReset);
    message = (
      <>
        Claude and Codex are both at high usage.
        {claudeResetStr && <> Claude resets in {claudeResetStr}.</>}
        {codexResetStr && <> Codex resets in {codexResetStr}.</>}
        Consider pausing new tasks until quotas reset.
      </>
    );
  } else if (claudeExceeded) {
    const claudeResetStr = formatResetTime(claudeReset);
    message = (
      <>
        Claude is at {claudeMax}% of its weekly limit{claudeResetStr ? ` (resets in ${claudeResetStr})` : ""}.
        Consider switching new tasks to Codex, or hand active Claude tasks over with the agent picker in the session header.
      </>
    );
  } else {
    const codexResetStr = formatResetTime(codexReset);
    message = (
      <>
        Codex is at {codexMax}% of its limit{codexResetStr ? ` (resets in ${codexResetStr})` : ""}.
        Consider switching to Claude if available, or pausing new tasks.
      </>
    );
  }

  return (
    <div className="quota-advisor-banner" role="alert">
      <span className="qab-ic">{Icon.bolt()}</span>
      <span className="qab-msg">{message}</span>
      <span className="qab-spacer" />
      <button className="linkbtn" onClick={onOpenQuota} style={{ marginRight: 12 }}>
        {Icon.gauge()} View quotas
      </button>
      <button className="icon-btn" onClick={() => setDismissed(true)} title="Dismiss this banner">
        {Icon.x()}
      </button>
    </div>
  );
}
