/**
 * Provider-agnostic usage/quota snapshot shapes shared by all provider
 * trackers (Codex, Kimi, ...). `primary` is the shortest (session) window,
 * `secondary` the longer (weekly) window, matching Codex semantics.
 */
export interface UsageWindow {
  readonly usedPercent: number;
  readonly windowMinutes: number;
  readonly resetsInSeconds: number;
}

export interface UsageSnapshot {
  readonly primary?: UsageWindow;
  readonly secondary?: UsageWindow;
  readonly capturedAt: number;
}
