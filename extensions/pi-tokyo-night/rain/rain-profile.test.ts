import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../core/config";
import { resolveRainRuntimeProfile } from "./rain-profile";

describe("resolveRainRuntimeProfile", () => {
  it("keeps the idle sky animated without generating rain", () => {
    const profile = resolveRainRuntimeProfile({ ...DEFAULT_CONFIG, rainMode: "auto" }, "idle");
    expect(profile.maxDrops).toBe(0);
    expect(profile.tickMs).toBeGreaterThan(0);
    expect(profile.densityTransitionMs).toBe(0);
  });

  it.each([
    ["idle", { tickMs: 66, maxDrops: 0, fallSpeed: 0.65, densityTransitionMs: 0, fallSpeedTransitionMs: 600 }],
    ["waiting", { tickMs: 66, maxDrops: 5, fallSpeed: 0.65, densityTransitionMs: 600, fallSpeedTransitionMs: 600 }],
    ["thinking", { tickMs: 50, maxDrops: 12, fallSpeed: 0.85, densityTransitionMs: 600, fallSpeedTransitionMs: 600 }],
    ["streaming", { tickMs: 50, maxDrops: 22, fallSpeed: 1, densityTransitionMs: 600, fallSpeedTransitionMs: 600 }],
    ["tools", { tickMs: 40, maxDrops: 35, fallSpeed: 1.4, densityTransitionMs: 250, fallSpeedTransitionMs: 250 }],
  ] as const)("maps auto %s activity to its rain profile", (activity, expected) => {
    expect(resolveRainRuntimeProfile({
      ...DEFAULT_CONFIG,
      rainMode: "auto",
      rainTickMs: 900,
      maxRainDrops: 5,
    }, activity)).toEqual(expected);
  });

  it("uses the user's tick and density in manual mode", () => {
    expect(resolveRainRuntimeProfile({
      ...DEFAULT_CONFIG,
      rainMode: "manual",
      rainTickMs: 240,
      maxRainDrops: 40,
    }, "tools")).toEqual({ tickMs: 240, maxDrops: 40 });
  });
});
