import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatStatus } from "./format";
import type { UsageSnapshot, UsageWindow } from "./types";

const NOW = new Date("2026-07-25T12:00:00Z");

function snap(
  primary?: Partial<UsageWindow>,
  secondary?: Partial<UsageWindow>,
): UsageSnapshot {
  const window = (overrides: Partial<UsageWindow>): UsageWindow => ({
    usedPercent: 50,
    windowMinutes: 300,
    resetsInSeconds: 1800,
    ...overrides,
  });
  return {
    ...(primary ? { primary: window(primary) } : {}),
    ...(secondary ? { secondary: window(secondary) } : {}),
    capturedAt: NOW.getTime(),
  };
}

describe("formatStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders both windows joined with the shared separator", () => {
    const line = formatStatus(
      snap({ usedPercent: 25 }, { usedPercent: 80, windowMinutes: 10_080 }),
    );

    expect(line).toBe("5h 75% (30m) · wk 20%");
  });

  it.each([
    [300, "5h"],
    [10_080, "wk"],
    [1440, "24h"],
    [90, "2h"], // non-standard durations round to whole hours
  ])("labels a %i-minute window as %s", (windowMinutes, label) => {
    const line = formatStatus(snap({ windowMinutes }));

    expect(line.startsWith(`${label} `)).toBe(true);
  });

  it.each([
    [1800, "(30m)"],
    [3660, "(1h1m)"],
    [3600, "(1h0m)"],
    [59, "(0m)"],
  ])("formats %i seconds remaining as %s", (resetsInSeconds, countdown) => {
    const line = formatStatus(snap({ resetsInSeconds }));

    expect(line).toContain(countdown);
  });

  it("counts down from the capture time instead of the render time", () => {
    const s = snap({ resetsInSeconds: 1800 });

    vi.advanceTimersByTime(60_000);

    expect(formatStatus(s)).toContain("(29m)");
  });

  it("renders the secondary window alone when no rolling window exists", () => {
    const line = formatStatus(
      snap(undefined, { usedPercent: 10, windowMinutes: 10_080 }),
    );

    expect(line).toBe("wk 90%");
    expect(line).not.toContain("·");
  });

  it("clamps the remaining percentage into 0-100", () => {
    expect(formatStatus(snap({ usedPercent: 150 }))).toContain(" 0% ");
    expect(formatStatus(snap({ usedPercent: -10 }))).toContain(" 100% ");
  });
});
