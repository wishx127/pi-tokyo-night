import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../core/config";
import { resolveRainRuntimeProfile } from "./rain-profile";

describe("resolveRainRuntimeProfile", () => {
  it.each([
    ["idle", { tickMs: 160, maxDrops: 10 }],
    ["active", { tickMs: 130, maxDrops: 25 }],
    ["tools", { tickMs: 110, maxDrops: 35 }],
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
