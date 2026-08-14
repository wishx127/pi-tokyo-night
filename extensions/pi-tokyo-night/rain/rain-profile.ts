import type { TokyoConfig } from "../core/config";

export type RainActivity = "idle" | "active" | "tools";

export interface RainRuntimeProfile {
  readonly tickMs: number;
  readonly maxDrops: number;
}

const AUTO_PROFILES: Readonly<Record<RainActivity, RainRuntimeProfile>> = Object.freeze({
  idle: Object.freeze({ tickMs: 160, maxDrops: 10 }),
  active: Object.freeze({ tickMs: 130, maxDrops: 25 }),
  tools: Object.freeze({ tickMs: 110, maxDrops: 35 }),
});

export function resolveRainRuntimeProfile(
  config: Readonly<TokyoConfig>,
  activity: RainActivity,
): RainRuntimeProfile {
  return config.rainMode === "auto"
    ? AUTO_PROFILES[activity]
    : { tickMs: config.rainTickMs, maxDrops: config.maxRainDrops };
}
