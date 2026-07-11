import type { Model } from "@earendil-works/pi-ai";

export interface CodexWindow {
  readonly usedPercent: number;
  readonly windowMinutes: number;
  readonly resetsInSeconds: number;
}

export interface CodexUsageSnapshot {
  readonly primary?: CodexWindow;
  readonly secondary?: CodexWindow;
  readonly capturedAt: number;
}

export function isCodexModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  return model.api === "openai-codex-responses" || model.provider === "openai-codex";
}

function parseNumber(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parsePrimaryWindow(headers: Record<string, string>): CodexWindow | undefined {
  const used = parseNumber(headers["x-codex-primary-used-percent"]);
  const win = parseNumber(headers["x-codex-primary-window-minutes"]);
  const reset = parseNumber(headers["x-codex-primary-reset-after-seconds"]);

  if (used == null || win == null || reset == null) return undefined;
  return { usedPercent: used, windowMinutes: win, resetsInSeconds: reset };
}

function parseSecondaryWindow(headers: Record<string, string>): CodexWindow | undefined {
  const used = parseNumber(headers["x-codex-secondary-used-percent"]);
  const win = parseNumber(headers["x-codex-secondary-window-minutes"]);
  const reset = parseNumber(headers["x-codex-secondary-reset-after-seconds"]);

  if (used == null || win == null || reset == null) return undefined;
  return { usedPercent: used, windowMinutes: win, resetsInSeconds: reset };
}

export function parseHeaders(
  headers: Record<string, string>,
): CodexUsageSnapshot | undefined {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const primary = parsePrimaryWindow(lower);
  const secondary = parseSecondaryWindow(lower);
  if (!primary && !secondary) return undefined;
  return { primary, secondary, capturedAt: Date.now() };
}

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

export function formatStatus(snap: CodexUsageSnapshot): string {
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

let snapshot: CodexUsageSnapshot | undefined;

export function captureFromHeaders(headers: Record<string, string>): boolean {
  const parsed = parseHeaders(headers);
  if (!parsed) return false;
  snapshot = parsed;
  return true;
}

export function getSnapshot(): CodexUsageSnapshot | undefined {
  return snapshot;
}

export function clearSnapshot(): void {
  snapshot = undefined;
}
