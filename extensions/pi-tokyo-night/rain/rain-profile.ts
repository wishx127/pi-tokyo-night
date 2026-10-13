import type { TokyoConfig } from "../core/config";

export type RainActivity = "idle" | "active" | "tools";

export interface RainRuntimeProfile {
  readonly tickMs: number;
  readonly maxDrops: number;
  /** Optional wall-clock duration for activity-driven density changes. */
  readonly densityTransitionMs?: number;
}

const AUTO_PROFILES: Readonly<Record<RainActivity, RainRuntimeProfile>> = Object.freeze({
  idle: Object.freeze({ tickMs: 160, maxDrops: 10, densityTransitionMs: 800 }),
  active: Object.freeze({ tickMs: 130, maxDrops: 25, densityTransitionMs: 800 }),
  tools: Object.freeze({ tickMs: 110, maxDrops: 35, densityTransitionMs: 800 }),
});

export function resolveRainRuntimeProfile(
  config: Readonly<TokyoConfig>,
  activity: RainActivity,
): RainRuntimeProfile {
  if (config.rainMode === "static") return { tickMs: 0, maxDrops: 0 };
  return config.rainMode === "auto"
    ? AUTO_PROFILES[activity]
    : { tickMs: config.rainTickMs, maxDrops: config.maxRainDrops };
}
