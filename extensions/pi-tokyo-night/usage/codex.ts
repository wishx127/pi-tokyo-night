/**
 * Codex usage quota tracking.
 *
 * Codex exposes quota via response headers on every request
 * (x-codex-primary-* / x-codex-secondary-*), parsed here into the shared
 * UsageSnapshot shape.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { UsageSnapshot, UsageWindow } from "./types";

export function isCodexModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  return model.api === "openai-codex-responses" || model.provider === "openai-codex";
}

function parseNumber(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parsePrimaryWindow(headers: Record<string, string>): UsageWindow | undefined {
  const used = parseNumber(headers["x-codex-primary-used-percent"]);
  const win = parseNumber(headers["x-codex-primary-window-minutes"]);
  const reset = parseNumber(headers["x-codex-primary-reset-after-seconds"]);

  if (used == null || win == null || reset == null) return undefined;
  return { usedPercent: used, windowMinutes: win, resetsInSeconds: reset };
}

function parseSecondaryWindow(headers: Record<string, string>): UsageWindow | undefined {
  const used = parseNumber(headers["x-codex-secondary-used-percent"]);
  const win = parseNumber(headers["x-codex-secondary-window-minutes"]);
  const reset = parseNumber(headers["x-codex-secondary-reset-after-seconds"]);

  if (used == null || win == null || reset == null) return undefined;
  return { usedPercent: used, windowMinutes: win, resetsInSeconds: reset };
}

export function parseHeaders(
  headers: Record<string, string>,
): UsageSnapshot | undefined {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const primary = parsePrimaryWindow(lower);
  const secondary = parseSecondaryWindow(lower);
  if (!primary && !secondary) return undefined;
  return { primary, secondary, capturedAt: Date.now() };
}

let snapshot: UsageSnapshot | undefined;

export function captureCodexHeaders(headers: Record<string, string>): boolean {
  const parsed = parseHeaders(headers);
  if (!parsed) return false;
  snapshot = parsed;
  return true;
}

export function getCodexSnapshot(): UsageSnapshot | undefined {
  return snapshot;
}

export function clearCodexSnapshot(): void {
  snapshot = undefined;
}
