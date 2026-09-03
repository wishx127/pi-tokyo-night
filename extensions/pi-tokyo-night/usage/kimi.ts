/**
 * Kimi For Coding usage quota fetching.
 *
 * Unlike Codex (which exposes quota via response headers on every request),
 * Kimi Code provides a dedicated REST endpoint — the same one used by the
 * official Kimi CLI `/usage` command and the kimi.com/code console:
 *
 *   GET https://api.kimi.com/coding/v1/usages
 *   Authorization: Bearer <API key or OAuth access token>
 *   Accept: application/json
 *
 * Response (numeric fields arrive as strings):
 *   usage:  { limit, used, remaining, resetTime }              — weekly quota
 *   limits: [{ window: { duration, timeUnit }, detail: {...} }] — extra windows
 *             (the 300-minute entry is the 5-hour rolling window)
 *
 * The parsed result uses the shared UsageWindow/UsageSnapshot shapes so the
 * status bar can render both providers through the same formatStatus().
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import type { UsageSnapshot, UsageWindow } from "./types";

const KIMI_USAGE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_API_ORIGIN = new URL(KIMI_USAGE_BASE_URL).origin;
const FETCH_TIMEOUT_MS = 8000;
/** Treat tokens expiring within this margin as already expired. */
const EXPIRY_MARGIN_MS = 60_000;

export function isKimiModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  return model.provider === "kimi-coding";
}

function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** Limit quota polling to models served by Kimi's official API origin. */
export function isKimiUsageOriginAllowed(
  model: Model<any> | undefined,
): boolean {
  if (!model || !isKimiModel(model) || typeof model.baseUrl !== "string") {
    return false;
  }
  return httpOrigin(model.baseUrl) === KIMI_API_ORIGIN;
}

// ── Credential resolution ──────────────────────────────────────────────────

function readJsonFile(p: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // missing/unreadable/invalid file — fall through
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Resolve a Kimi Code credential, in priority order:
 *  1. Pi's ModelRegistry — handles api_key entries and refreshes expired
 *     OAuth tokens under the auth store lock, so it must come first.
 *  2. Pi's own auth store (auth.json → "kimi-coding" entry) as a fallback
 *     when the registry is unavailable. OAuth "access" tokens are only
 *     used when not expired (expires is a ms epoch, per pi-ai's OAuth
 *     credentials shape).
 *  3. The official Kimi CLI's credential store
 *     (~/.kimi/credentials/kimi-code.json — OAuth access tokens live only
 *     ~15 minutes, so used only when unexpired).
 */
export async function resolveKimiApiKey(
  lookupApiKey?: (provider: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  // 1. ModelRegistry (auto-refreshes OAuth).
  if (lookupApiKey) {
    const resolved = await lookupApiKey("kimi-coding").catch(() => undefined);
    if (resolved) return resolved;
  }

  // 2. Pi's auth store (fallback; OAuth tokens only when unexpired).
  const piAuth = readJsonFile(path.join(getAgentDir(), "auth.json"));
  const piKimi = asRecord(piAuth?.["kimi-coding"]);
  if (piKimi) {
    const apiKey = asString(piKimi.key);
    if (apiKey) return apiKey;
    const access = asString(piKimi.access);
    const expiresMs = asNumber(piKimi.expires);
    if (access && (expiresMs === undefined || expiresMs > Date.now() + EXPIRY_MARGIN_MS)) {
      return access;
    }
  }

  // 3. Kimi CLI's OAuth store (fresh tokens only).
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const kimiCreds = readJsonFile(
    path.join(home, ".kimi", "credentials", "kimi-code.json"),
  );
  const accessToken = kimiCreds ? asString(kimiCreds.access_token) : undefined;
  const expiresAtSec = kimiCreds ? asNumber(kimiCreds.expires_at) : undefined;
  if (
    accessToken &&
    expiresAtSec !== undefined &&
    expiresAtSec * 1000 > Date.now() + EXPIRY_MARGIN_MS
  ) {
    return accessToken;
  }

  return undefined;
}

// ── Usage endpoint ─────────────────────────────────────────────────────────

export type KimiUsageResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; error: string };

export interface KimiUsageStore {
  getSnapshot(): UsageSnapshot | undefined;
  setSnapshot(snapshot: UsageSnapshot): void;
  clearSnapshot(): void;
}

export function createKimiUsageStore(): KimiUsageStore {
  let snapshot: UsageSnapshot | undefined;

  return {
    getSnapshot(): UsageSnapshot | undefined {
      return snapshot;
    },
    setSnapshot(nextSnapshot: UsageSnapshot): void {
      snapshot = nextSnapshot;
    },
    clearSnapshot(): void {
      snapshot = undefined;
    },
  };
}

function timeUnitSeconds(timeUnit: string | undefined): number | undefined {
  switch (timeUnit) {
    case "TIME_UNIT_SECOND":
      return 1;
    case "TIME_UNIT_MINUTE":
      return 60;
    case "TIME_UNIT_HOUR":
      return 3600;
    case "TIME_UNIT_DAY":
      return 86_400;
    default:
      return undefined;
  }
}

function secondsUntil(resetTime: unknown): number | undefined {
  const s = asString(resetTime);
  if (!s) return undefined;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.round((ms - Date.now()) / 1000));
}

function toWindow(
  detail: Record<string, unknown>,
  windowMinutes: number,
): UsageWindow | undefined {
  const limit = asNumber(detail.limit);
  const used = asNumber(detail.used);
  const reset = secondsUntil(detail.resetTime);
  if (limit === undefined || used === undefined || limit <= 0 || reset === undefined) {
    return undefined;
  }
  return {
    usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)),
    windowMinutes,
    resetsInSeconds: reset,
  };
}

export function parseKimiUsage(payload: unknown): UsageSnapshot | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;

  // Extra rolling windows — the 300-minute entry is the 5-hour session quota.
  // Pick the shortest window as "primary" (matches Codex primary semantics).
  let primary: UsageWindow | undefined;
  let primarySeconds = Infinity;
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const item of limits) {
    const entry = asRecord(item);
    const detail = entry ? asRecord(entry.detail) : undefined;
    const window = entry ? asRecord(entry.window) : undefined;
    if (!detail || !window) continue;
    const duration = asNumber(window.duration);
    const unitSeconds = timeUnitSeconds(asString(window.timeUnit));
    if (duration === undefined || unitSeconds === undefined) continue;
    const totalSeconds = duration * unitSeconds;
    const w = toWindow(detail, Math.max(1, Math.round(totalSeconds / 60)));
    if (w && totalSeconds < primarySeconds) {
      primary = w;
      primarySeconds = totalSeconds;
    }
  }

  // Top-level usage record is the weekly quota (7 days = 10080 minutes).
  let secondary: UsageWindow | undefined;
  const usage = asRecord(root.usage);
  if (usage) {
    secondary = toWindow(usage, 10080);
  }

  if (!primary && !secondary) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    capturedAt: Date.now(),
  };
}

export async function fetchKimiUsage(
  apiKey: string,
  signal?: AbortSignal,
): Promise<KimiUsageResult> {
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    response = await fetch(`${KIMI_USAGE_BASE_URL}/usages`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: requestSignal,
    });
  } catch (err) {
    return { ok: false, error: `network: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) {
    const authHint = response.status === 401 ? " (auth failed — check kimi-coding credentials)" : "";
    return { ok: false, error: `HTTP ${response.status}${authHint}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "invalid JSON response" };
  }

  const snapshot = parseKimiUsage(payload);
  if (!snapshot) return { ok: false, error: "no usage data in response" };
  return { ok: true, snapshot };
}
