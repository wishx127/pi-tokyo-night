import type { TokyoConfig } from "../core/config";

export type RainActivity = "idle" | "waiting" | "thinking" | "streaming" | "tools";

export interface RainRuntimeProfile {
  readonly tickMs: number;
  readonly maxDrops: number;
  /** Physical fall speed, independent of the animation's sampling cadence. */
  readonly fallSpeed?: number;
  /** Optional wall-clock duration for activity-driven density changes. */
  readonly densityTransitionMs?: number;
  /** Time for physical speed to settle toward a new activity target. */
  readonly fallSpeedTransitionMs?: number;
}

const AUTO_PROFILES: Readonly<Record<RainActivity, RainRuntimeProfile>> = Object.freeze({
  idle: Object.freeze({ tickMs: 66, maxDrops: 0, fallSpeed: 0.65, densityTransitionMs: 0, fallSpeedTransitionMs: 600 }),
  waiting: Object.freeze({ tickMs: 66, maxDrops: 5, fallSpeed: 0.65, densityTransitionMs: 600, fallSpeedTransitionMs: 600 }),
  thinking: Object.freeze({ tickMs: 50, maxDrops: 12, fallSpeed: 0.85, densityTransitionMs: 600, fallSpeedTransitionMs: 600 }),
  streaming: Object.freeze({ tickMs: 50, maxDrops: 22, fallSpeed: 1, densityTransitionMs: 600, fallSpeedTransitionMs: 600 }),
  tools: Object.freeze({ tickMs: 40, maxDrops: 35, fallSpeed: 1.4, densityTransitionMs: 250, fallSpeedTransitionMs: 250 }),
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
