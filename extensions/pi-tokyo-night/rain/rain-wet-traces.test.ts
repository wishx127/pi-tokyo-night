import { describe, expect, it } from "vitest";
import { RainWetTraces } from "./rain-wet-traces";

describe("RainWetTraces", () => {
  it("delays a nearby pair, then raises and fades its midpoint trace", () => {
    const traces = new RainWetTraces();
    traces.record(12.8, 2, 0);
    expect(traces.get(0.8)).toEqual([]);
    traces.record(13.2, 2, 1);
    expect(traces.get(1.17)).toEqual([]);

    const rising = traces.get(1.34);
    const peak = traces.get(1.5);
    const fading = traces.get(2.5);
    expect(rising[0]).toMatchObject({ col: 13, row: 2 });
    expect(rising[0].light).toBeGreaterThan(0.055);
    expect(peak[0].light).toBeCloseTo(0.31);
    expect(fading[0].light).toBeLessThan(peak[0].light);
    expect(traces.get(3.1)).toEqual([]);
  });

  it.each([
    [12, 3, 1],
    [14, 2, 1],
    [12, 2, 3],
  ])("keeps an unmatched contact dry at column %i, row %i, time %i", (col, row, time) => {
    const traces = new RainWetTraces();
    traces.record(12, 2, 0);
    traces.record(col, row, time);
    expect(traces.get(time + 0.5)).toEqual([]);
  });

  it("consumes each pair and keeps an earlier trace visible while another rises", () => {
    const traces = new RainWetTraces();
    traces.record(12, 2, 0);
    traces.record(12, 2, 1);
    traces.record(12, 2, 1.5);
    expect(traces.get(2.5)[0].light).toBeLessThan(0.1);
    expect(traces.get(3.1)).toEqual([]);

    traces.record(12, 2, 2);
    expect(traces.get(2.1)).toHaveLength(1);
    expect(traces.get(2.5)).toEqual([{ col: 12, row: 2, light: 0.31 }]);
  });

  it("leaves a third eligible contact available for the next pair", () => {
    const traces = new RainWetTraces();
    traces.record(12, 2, 0);
    traces.record(14, 2, 0.1);
    traces.record(13, 2, 1);
    expect(traces.get(1.5)).toEqual([{ col: 13, row: 2, light: 0.31 }]);
    traces.record(14, 2, 1.5);
    expect(traces.get(2).map(trace => trace.col)).toEqual([13, 14]);
  });

  it("starts after the later contact even when one tick reports landings out of order", () => {
    const traces = new RainWetTraces();
    traces.record(12, 2, 0.02);
    traces.record(12, 2, -0.02);
    expect(traces.get(0.19)).toEqual([]);
    expect(traces.get(0.52)).toEqual([{ col: 12, row: 2, light: 0.31 }]);
  });

  it("clears pending contacts and visible traces", () => {
    const traces = new RainWetTraces();
    traces.record(12, 2, 0);
    traces.record(12, 2, 1);
    traces.record(30, 2, 1);
    expect(traces.get(1.5)).toHaveLength(1);
    traces.clear();
    traces.record(30, 2, 1.6);
    expect(traces.get(2.1)).toEqual([]);
  });
});
