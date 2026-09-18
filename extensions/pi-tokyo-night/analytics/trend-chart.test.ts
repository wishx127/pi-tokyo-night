import { describe, expect, it } from "vitest";
import { renderDottedTrendChart } from "./trend-chart";

describe("renderDottedTrendChart", () => {
  it("returns a visible multi-series chart with maximum, midpoint, and zero Y-axis ticks", () => {
    const chart = renderDottedTrendChart([
      { id: "total", values: [0, 40, 10, 80, 50] },
    ], 12, 4);

    expect(chart.yMax).toBe(80);
    expect(chart.yMid).toBe(40);
    expect(chart.rows.map((row) => row.value)).toEqual([80, undefined, 40, 0]);
    expect(chart.rows.map((row) => row.axis)).toEqual(["┤", "│", "┤", "┤"]);
    expect(chart.rows.every((row) => row.plot.length <= 12)).toBe(true);
    expect(chart.rows.map((row) => row.plot).join("")).not.toBe(" ".repeat(48));
    expect(chart.rows.flatMap((row) => row.runs).some((run) => run.seriesId === "total")).toBe(true);
  });

  it("keeps a model's X geometry unchanged when another model is hidden", () => {
    const modelA = renderDottedTrendChart([
      { id: "model-a", values: [30] },
    ], 12, 4);
    const modelAB = renderDottedTrendChart([
      { id: "model-a", values: [30] },
      { id: "model-b", values: [20] },
    ], 12, 4);

    expect(modelAB.rows[0]?.plot).toBe(modelA.rows[0]?.plot);
  });

  it("keeps a hidden model in the Y scale without rendering its line", () => {
    const chart = renderDottedTrendChart([
      { id: "model-a", values: [30] },
      { id: "model-b", values: [100], hidden: true },
    ], 12, 4);
    const seriesIds = new Set(
      chart.rows.flatMap((row) => row.runs.map((run) => run.seriesId)),
    );

    expect(chart.yMax).toBe(100);
    expect(seriesIds).toContain("model-a");
    expect(seriesIds).not.toContain("model-b");
  });

  it("uses the highest visible model series for the scale and assigns it a colored run", () => {
    const chart = renderDottedTrendChart([
      { id: "model-a", values: [0, 50, 0] },
      { id: "model-b", values: [0, 100, 0] },
    ], 12, 4);

    expect(chart.yMax).toBe(100);
    expect(chart.rows.flatMap((row) => row.runs).some((run) => run.seriesId === "model-a")).toBe(true);
    expect(chart.rows.flatMap((row) => row.runs).some((run) => run.seriesId === "model-b")).toBe(true);
  });

  it("uses a deterministic last-drawn owner when dots share a Braille cell", () => {
    const chart = renderDottedTrendChart([
      { id: "model-a", values: [60] },
      { id: "model-b", values: [70] },
    ], 12, 4);
    const seriesIds = new Set(
      chart.rows.flatMap((row) => row.runs.map((run) => run.seriesId)),
    );

    expect(seriesIds).not.toContain("model-a");
    expect(seriesIds).toContain("model-b");
  });

  it("keeps leading and trailing zero buckets blank instead of drawing a baseline", () => {
    const chart = renderDottedTrendChart([
      { id: "model", values: [0, 0, 50, 100, 0] },
    ], 12, 4);

    expect(chart.rows.every((row) => row.plot[0] === " ")).toBe(true);
    expect(chart.rows.every((row) => row.plot.at(-1) === " ")).toBe(true);
  });
});
