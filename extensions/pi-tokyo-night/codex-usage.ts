import type { Model } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

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

function parseWindow(
  headers: Record<string, string>,
  prefix: string,
): CodexWindow | undefined {
  const used = Number(headers[`${prefix}-used-percent`]);
  const win = Number(headers[`${prefix}-window-minutes`]);
  const reset = Number(headers[`${prefix}-resets-in-seconds`]);
  if (!Number.isFinite(used) || !Number.isFinite(win) || !Number.isFinite(reset)) {
    return undefined;
  }
  return { usedPercent: used, windowMinutes: win, resetsInSeconds: reset };
}

export function parseHeaders(
  headers: Record<string, string>,
): CodexUsageSnapshot | undefined {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const primary = parseWindow(lower, "x-codex-primary");
  const secondary = parseWindow(lower, "x-codex-secondary");
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

export function formatStatus(snap: CodexUsageSnapshot): string {
  const parts: string[] = [];
  if (snap.primary) {
    const p = snap.primary;
    parts.push(
      `${windowLabel(p.windowMinutes)} ${Math.round(p.usedPercent)}% (${formatCountdown(p.resetsInSeconds)})`,
    );
  }
  if (snap.secondary) {
    const s = snap.secondary;
    parts.push(`${windowLabel(s.windowMinutes)} ${Math.round(s.usedPercent)}%`);
  }
  return parts.join(" · ");
}

let snapshot: CodexUsageSnapshot | undefined;
let loadedFromDisk = false;
let debugHeadersLogged = false;

function cachePath(): string {
  return process.env.PI_CODEX_USAGE_CACHE
    ?? join(homedir(), ".pi", "agent", "codex-usage.json");
}

export function writeCacheFile(path: string, snap: CodexUsageSnapshot): void {
  writeFileSync(path, JSON.stringify(snap), "utf8");
}

export function readCacheFile(path: string): CodexUsageSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CodexUsageSnapshot;
    return typeof parsed?.capturedAt === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function captureFromHeaders(headers: Record<string, string>): boolean {
  if (!debugHeadersLogged) {
    debugHeadersLogged = true;
    const codex = Object.fromEntries(
      Object.entries(headers).filter(([k]) => k.toLowerCase().startsWith("x-codex-")),
    );
    console.error(`[pi-tokyo-night][codex-usage] x-codex-* headers: ${JSON.stringify(codex)}`);
  }
  const parsed = parseHeaders(headers);
  if (!parsed) return false;
  snapshot = parsed;
  loadedFromDisk = true;
  try {
    writeCacheFile(cachePath(), parsed);
  } catch {
    // persistence failure is non-fatal
  }
  return true;
}

export function getSnapshot(): CodexUsageSnapshot | undefined {
  if (!snapshot && !loadedFromDisk) {
    loadedFromDisk = true;
    snapshot = readCacheFile(cachePath());
  }
  return snapshot;
}
