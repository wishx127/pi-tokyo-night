/**
 * Shared rendering of usage snapshots — provider-agnostic, so the status bar
 * can display Codex and Kimi quotas through the same formatStatus().
 */

import type { UsageSnapshot } from "./types";

function windowLabel(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "wk";
  return `${Math.round(minutes / 60)}h`;
}

function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function formatRemainingPercent(usedPercent: number): string {
  return `${Math.max(0, Math.min(100, 100 - Math.round(usedPercent)))}%`;
}

export function formatStatus(snap: UsageSnapshot): string {
  const parts: string[] = [];
  if (snap.primary) {
    const p = snap.primary;
    const primary = `${windowLabel(p.windowMinutes)} ${formatRemainingPercent(p.usedPercent)}`;
    parts.push(`${primary} (${formatCountdown(p.resetsInSeconds)})`);
  }
  if (snap.secondary) {
    const s = snap.secondary;
    parts.push(`${windowLabel(s.windowMinutes)} ${formatRemainingPercent(s.usedPercent)}`);
  }
  return parts.join(" · ");
}
