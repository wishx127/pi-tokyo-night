import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RainPanelComponent, renderRainPanelLines } from "./rain-panel";
import type { RainFrameSnapshot } from "./rain-manager";
import { RainAnimationManager } from "./rain-manager";
import { TokyoConfigManager } from "../core/config";
import { RefreshScheduler } from "../ui/refresh-scheduler";
import { createTokyoNightPalette } from "../ui/theme-palette";
type ThemeDocument = {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
};

function readTokyoTheme(name: "dark" | "light"): Theme {
  const fileName = `tokyo-night-${name}.json`;
  const filePath = fileURLToPath(
    new URL(`../../../themes/${fileName}`, import.meta.url),
  );
  const document = JSON.parse(
    readFileSync(filePath, "utf8"),
  ) as ThemeDocument;
  const vars = document.vars ?? {};
  const resolve = (value: string | number): string | number => {
    if (typeof value !== "string" || value === "" || value.startsWith("#")) {
      return value;
    }
    return resolve(vars[value]);
  };
  const colors = Object.fromEntries(
    Object.entries(document.colors).map(([key, value]) => [key, resolve(value)]),
  );
  const backgrounds = Object.fromEntries(
    [
      "selectedBg",
      "userMessageBg",
      "customMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ].map((key) => [key, colors[key]]),
  );
  return new Theme(colors as any, backgrounds as any, "truecolor", {
    name: document.name,
  });
}

const snapshot: RainFrameSnapshot = {
  drops: [{ col: 12, row: 1 }],
  stars: [{ col: 5, row: 0 }],
};

const palette = { ...createTokyoNightPalette({
  fg: (color: string, text: string) => `<fg:${color}>${text}</fg:${color}>`,
  bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
} as unknown as Theme), rippleShade: undefined };

function makeConfig(panel: boolean, editorFrame = true) {
  return {
    get: vi.fn(() => ({
      panel,
      editorFrame,
      rainRows: 3,
      rainTickMs: 130,
      maxRainDrops: 25,
      codexQuota: false,
      kimiQuota: true,
      iconMode: "ascii",
      statusModules: {},
    })),
  };
}

describe("RainPanelComponent", () => {
  it("resumes publishing animation after a layout releases a zero-row rain budget", () => {
    vi.useFakeTimers();
    const config = new TokyoConfigManager();
    config.set("rainRows", 4);
    config.set("rainTickMs", 50);
    let availableRows = 1;
    let panel: RainPanelComponent;
    const frames: string[][] = [];
    const scheduler = new RefreshScheduler((publish) => {
      if (publish) frames.push(panel.render(80));
    });
    const rain = new RainAnimationManager(config, {
      scheduleTick: (tick, ms) => scheduler.repeat(ms, tick),
      requestRender: () => { if (panel.hasVisibleChanges()) scheduler.requestRender(); },
    });
    panel = new RainPanelComponent({ terminal: { rows: 30, columns: 80 } } as any, {
      config, rain, getAvailableRows: () => availableRows,
    });
    try {
      expect(panel.render(80)).toHaveLength(1);
      rain.start();
      vi.advanceTimersByTime(1000);
      expect(frames).toHaveLength(0);
      availableRows = 5;
      vi.advanceTimersByTime(1000);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.at(-1)).toHaveLength(5);
      const previous = frames.at(-1);
      vi.advanceTimersByTime(1000);
      expect(frames.at(-1)).not.toEqual(previous);
      expect(rain.isRunning).toBe(true);
      for (const rows of [10, 1, 8, 2, 5, 3, 6, 4, 7, 9, 4]) {
        config.set("rainRows", rows);
        availableRows = rows + 1;
        const time = rain.getSnapshot().time!;
        vi.advanceTimersByTime(500);
        expect(frames.at(-1)).toHaveLength(rows + 1);
        expect(rain.getSnapshot().time).toBeGreaterThan(time);
        expect(rain.isRunning).toBe(true);
      }
    } finally {
      rain.stop();
      scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it.each([[4, 3], [10, 7]])("keeps the %i-row water plane empty before any rain has landed", (rainRows, skyRows) => {
    for (const time of [0, 1, 20]) {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        snapshot: {
          time, stars: [{ col: 45, row: 0 }], drops: [{ col: 35, row: 1, depth: 1 }],
          splashes: [], waterMarks: [],
        },
      });
      expect(lines.slice(skyRows).every((line) => line.trim() === "")).toBe(true);
    }
  });

  it("keeps a visible contact at the real landing point until the first compact ring can be drawn", () => {
    const draw = (age: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      palette: { ...palette, rainShade: (_role, _light, text) => text.replace(/\S/g, " "),
        rippleShade: (_light, _wet, text) => text },
      snapshot: { wind: 0.25, drops: [], stars: [], splashes: [{ col: 30, depth: 1, age }] },
    })[3];
    for (const age of [0, 0.05, 0.15, 0.225, 0.35, 0.45]) {
      expect(draw(age)[30]).toBe(".");
      expect(draw(age).replace(/ /g, "")).toBe(".");
    }
    expect(draw(0.5).slice(29, 31)).toBe("--");
    expect(draw(1.3).trim()).toBe("");
  });

  it.each([4, 10])("keeps the original late dotted ring alive for its slower %i-row lifetime", (rainRows) => {
    const draw = (age: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      palette: { ...palette, rainShade: (_role, _light, text) => text.replace(/\S/g, " "),
        rippleShade: (_light, _wet, text) => text },
      snapshot: { drops: [], stars: [], splashes: [{ col: 30.5, depth: 2, age }] },
    }).slice(rainRows === 4 ? 3 : 7).join("");
    expect(draw(1.45)).toContain(".");
    expect(draw(1.45)).not.toMatch(/[()_\\/:]/);
    expect(draw(1.85).trim()).toBe("");
  });

  it.each([4, 10])("spreads curved wave edges around the wet surface in %i rows", (rainRows) => {
    const draw = (age: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      snapshot: { drops: [], stars: [], splashes: [{ col: 30, depth: 2, age }] },
    }).at(-1)!;
    const early = draw(0.08), later = draw(0.85);
    expect(later).toMatch(/^[ .~():-]+$/);
    expect(later).toContain("(");
    expect(later).toContain(")");
    expect(later.slice(0, 30).trim()).not.toBe("");
    expect(later.slice(30).trim()).not.toBe("");
    expect(later.trim().length).toBeGreaterThan(early.trim().length);
    for (const age of [0, 0.05, 0.1, 0.125, 0.15, 0.175, 0.35, 0.55, 0.75]) {
      expect(draw(age).trim()).not.toBe("");
    }
    expect(draw(1.85).trim()).toBe("");
  });

  it.each([4, 10])("keeps the original single early splash point above a %i-row landing", (rainRows) => {
    for (const age of [0.025, 0.05, 0.2]) {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        snapshot: { drops: [], stars: [], splashes: [{ col: 30, depth: 2, age }] },
      });
      expect(lines[rainRows - 2].trim()).toBe(".");
    }
  });

  it.each([4, 10])("restores the original %i-row hard-ring contour at a stretched middle phase", (rainRows) => {
    const lines = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      palette: { ...palette, rainShade: (_role, _light, text) => text.replace(/\S/g, " "),
        rippleShade: (_light, _wet, text) => text },
      snapshot: { drops: [], stars: [], splashes: [{ col: 30.5, depth: 2, age: 0.88 }] },
    });
    expect(lines.at(-1)!.slice(24, 37)).toBe(rainRows === 4 ? "     ( )     " : "  (       )  ");
    if (rainRows === 10) expect(lines[8].slice(24, 37)).toBe("    -- --    ");
  });

  it.each([[4, 3], [10, 7]])("keeps the %i-row splash as small curved edges without a rigid cup", (rainRows, horizon) => {
    const lines = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      snapshot: { drops: [], stars: [], splashes: [{ col: 30, depth: 2, age: 0.3 }] },
    });
    const water = lines.slice(horizon).join("");
    expect(water).toContain("(");
    expect(water).toContain(")");
    expect(water).not.toMatch(/[\\/:]|_{3}/);
    expect(lines.slice(0, horizon).join("").replaceAll("\u{1f319}", "")).not.toMatch(/[()_\\/]/);
  });

  it.each([4, 10])("keeps the restored %i-row ripple independent of experimental seeds and redraw randomness", (rainRows) => {
    const draw = (seed?: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      palette: { ...palette, rainShade: (role, _light, text) => role === "water" ? text.replace(/\S/g, " ") : text,
        rippleShade: (_light, _wet, text) => text },
      snapshot: { drops: [], stars: [], splashes: [{ col: 30.5, depth: 2, age: 0.55, seed }] },
    }).join("\n");
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("drawing must stay deterministic"); });
    try {
      const seeds = [0, 1, 3127, 0x12345678, 0xcafebabe, 0xffffffff];
      for (const seed of seeds) expect(draw(seed)).toBe(draw());
      expect(draw(Number.NaN)).toBe(draw());
      expect(draw(Number.POSITIVE_INFINITY)).toBe(draw());
    } finally {
      random.mockRestore();
    }
  });

  it.each([
    [0xcafebabe, 32, 0.632, 0.633],
    [0, 28, 0.606, 0.607],
  ])("keeps the wave and wet-trace colors continuous late in an impact (seed %i)", (seed, col, before, after) => {
    for (const theme of ["dark", "light"] as const) {
      const draw = (age: number) => {
        const line = renderRainPanelLines({
          width: 60, frameEnabled: false, rainRows: 4,
          palette: createTokyoNightPalette(readTokyoTheme(theme)),
          snapshot: { wind: 0.25, drops: [], stars: [],
            splashes: [{ col: 30.5, depth: 2, age, seed }],
            waterMarks: [{ col: 30.5, depth: 2, age, seed }],
          },
        })[3];
        let offset = 0, color: number[] | undefined;
        for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
          const rgb = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(part);
          if (rgb) color = rgb.slice(1).map(Number);
          else if (/^\x1b\[/.test(part)) color = undefined;
          else for (const _ of part) if (offset++ === col) return color;
        }
        return undefined;
      };
      const start = draw(before), end = draw(after);
      expect(start).toBeDefined();
      expect(end).toBeDefined();
      expect(Math.max(...end!.map((value, channel) => Math.abs(value - start![channel])))).toBeLessThanOrEqual(18);
    }
  });

  it.each([[4, 3], [10, 7]])("leaves quiet wet bands after the %i-row ripple has faded", (rainRows, skyRows) => {
    for (const age of [1.2, 2.8]) {
      const water = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        snapshot: {
          drops: [], stars: [],
          splashes: [{ col: 30, depth: 2, age }],
          waterMarks: [{ col: 30, depth: 2, age }],
        },
      }).slice(skyRows).join("");
      expect(water.trim()).not.toBe("");
      expect(water).toMatch(/^[ .~-]+$/);
    }
  });

  it.each([[40, 4, 3], [100, 4, 3], [40, 10, 7], [100, 10, 7]])(
    "keeps dense wet bands separated with open water in %i by %i cells",
    (width, rainRows, skyRows) => {
      const impacts = Array.from({ length: 192 }, (_, index) => ({
        col: (index * 7.3) % width, depth: index % 3, age: 0.3 + index % 7 * 0.1,
      }));
      const lines = renderRainPanelLines({
        width, frameEnabled: false, rainRows,
        snapshot: { drops: [], stars: [], waterMarks: impacts },
      }).slice(skyRows);
      expect(lines.some((line) => line.trim().length > 0)).toBe(true);
      for (const line of lines) {
        expect(line.replace(/ /g, "").length).toBeLessThanOrEqual(Math.max(1, Math.floor(width * 0.3)));
        expect(line).not.toMatch(/[.~-]{8}/);
        expect(line).toContain(" ");
      }
    },
  );

  it.each([4, 10])("mixes waves and short strokes with more visible dots in mature %i-row water", (rainRows) => {
    const draw = (seed?: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      snapshot: { drops: [], stars: [], waterMarks: [{ col: 30.5, depth: 2, age: 1.2, seed }] },
    }).at(-1)!.trim();
    expect(draw().length).toBeGreaterThanOrEqual(5);
    const samples = [draw(), ...Array.from({ length: 32 }, (_, seed) => draw(seed))];
    const surface = samples.join("");
    expect(surface).toMatch(/^[~.-]+$/);
    for (const glyph of ["~", "-", "."]) expect(surface).toContain(glyph);
    expect((surface.match(/\./g) ?? []).length).toBeGreaterThan(surface.length * 0.1);
    expect((surface.match(/\./g) ?? []).length).toBeLessThan(surface.length * 0.25);
    for (const sample of samples) {
      expect((sample.match(/\./g) ?? []).length).toBeLessThanOrEqual(1);
      if (sample.length <= 2) expect(sample).not.toContain(".");
    }
  });

  it.each([4, 10])("varies the %i-row wet footprint from stable impact seeds without redrawing random shapes", (rainRows) => {
    const draw = (seed: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      snapshot: { drops: [], stars: [], waterMarks: [{ col: 30.5, depth: 2, age: 1.2, seed }] },
    }).at(-1)!;
    const seeds = [1, 3127, 0x12345678, 0xcafebabe];
    const samples = seeds.map(draw);
    expect(new Set(samples.map((line) => line.trim())).size).toBeGreaterThanOrEqual(3);
    for (const [index, seed] of seeds.entries()) {
      expect(draw(seed)).toBe(samples[index]);
      expect(samples[index].slice(0, 24).trim()).toBe("");
      expect(samples[index].slice(37).trim()).toBe("");
      expect(samples[index]).toMatch(/^[ .~-]+$/);
    }
  });

  it.each([4, 10])("keeps each random wet trace within five columns in %i rows", (rainRows) => {
    for (const seed of [undefined, 0, 1, 3127, 0x12345678, 0xcafebabe]) {
      for (const col of [30, 30.5]) for (const age of [0.6, 1.2, 2]) {
        const trace = renderRainPanelLines({
          width: 60, frameEnabled: false, rainRows,
          snapshot: { drops: [], stars: [], waterMarks: [{ col, depth: 2, age, seed }] },
        }).at(-1)!.trim();
        expect(trace.length).toBeGreaterThan(0);
        expect(trace.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it("keeps seeded wet textures stable across redraws, time, and overlapping impact order", () => {
    const colors = createTokyoNightPalette(readTokyoTheme("dark"));
    const impacts = [
      { col: 30.5, depth: 2, age: 1.2, seed: 1 },
      { col: 33, depth: 2, age: 0.8, seed: 3127 },
      { col: 12.5, depth: 1, age: 1.4, seed: 0 },
    ];
    const draw = (records: typeof impacts, time = 0) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 10, palette: colors,
      snapshot: { time, drops: [], stars: [], waterMarks: records, splashes: records },
    });
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("drawing must not reroll wet textures"); });
    try {
      const expected = draw(impacts);
      expect(draw(impacts)).toEqual(expected);
      expect(draw(impacts, 20)).toEqual(expected);
      expect(draw([...impacts].reverse())).toEqual(expected);
      expect(draw([...impacts, ...impacts])).toEqual(expected);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it("prioritizes complete wet bands while retaining small contacts on a busy surface", () => {
    const water = renderRainPanelLines({
      width: 80, frameEnabled: false, rainRows: 4,
      snapshot: { drops: [], stars: [], waterMarks: Array.from({ length: 8 }, (_, index) => ({
        col: 5.5 + index * 10, depth: 2, age: 1.2,
      })) },
    })[3];
    const bands = water.match(/[.~-]+/g)!;
    const complete = bands.filter((band) => band.length >= 5);
    expect(complete.length).toBeGreaterThanOrEqual(3);
    expect(complete.length).toBeLessThanOrEqual(4);
    expect(bands.filter((band) => band.length < 5).every((band) => /^[~-]+$/.test(band))).toBe(true);
    expect(water.replace(/ /g, "").length).toBeLessThanOrEqual(24);
  });

  it("keeps established wet bands steady as a distant region appears and fades", () => {
    const draw = (age?: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      snapshot: { drops: [], stars: [], waterMarks: [
        ...[10.5, 30.5, 50.5].map((col) => ({ col, depth: 2, age: 1.2 })),
        ...(age === undefined ? [] : [{ col: 40.5, depth: 2, age }]),
      ] },
    })[3].slice(25, 36);
    const established = draw();
    expect(established.trim().length).toBeGreaterThanOrEqual(5);
    for (const age of [0.1, 0.11, 1.2, 3.37, 3.38]) expect(draw(age)).toBe(established);
  });

  it("does not replace a mature wet band with a faint new contact in the same part of the surface", () => {
    const draw = (age?: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      snapshot: { drops: [], stars: [], waterMarks: [
        { col: 2.5, depth: 2, age: 1.2 }, { col: 50.5, depth: 2, age: 1.2 },
        ...(age === undefined ? [] : [{ col: 10.5, depth: 2, age }]),
      ] },
    })[3].slice(0, 6);
    const established = draw();
    expect(established.trim().length).toBeGreaterThanOrEqual(5);
    for (const age of [0.1, 0.11, 1.2, 3.37, 3.38]) expect(draw(age)).toBe(established);
  });

  it("keeps both wet bands visible when a soft edge crosses the fade threshold", () => {
    for (const time of [0.078, 0.079]) {
      const water = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows: 4,
        snapshot: { drops: [], stars: [], waterMarks: [
          { col: 4.9, depth: 2, age: 1.15 + time }, { col: 15.1, depth: 2, age: 0.75 + time },
        ] },
      })[3];
      expect(water.slice(0, 10).trim().length).toBeGreaterThanOrEqual(4);
      expect(water.slice(10, 21).trim().length).toBeGreaterThanOrEqual(4);
    }
  });

  it("varies the wet band width with the actual impact footprint", () => {
    const lengths = [30, 30.25, 30.5, 30.75].map((col) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      snapshot: { drops: [], stars: [], waterMarks: [{ col, depth: 2, age: 1.2 }] },
    })[3].trim().length);
    expect(lengths.every((length) => length >= 4 && length <= 7)).toBe(true);
    expect(new Set(lengths).size).toBeGreaterThan(1);
  });

  it.each([[33.5, 0.025, 0.030], [34.5, 0.057, 0.058], [35.5, 0.057, 0.058]])(
    "blends glints at 30.5 and %f continuously when their brightness crosses",
    (rightCol, beforeTime, afterTime) => {
      const columns = (time: number) => {
        const impacts = [
          { col: 30.5, depth: 2, age: 0.4 + time }, { col: rightCol, depth: 2, age: 1 + time },
        ];
        const line = renderRainPanelLines({
          width: 60, frameEnabled: false, rainRows: 4,
          snapshot: { drops: [], stars: [], splashes: impacts, waterMarks: impacts },
        })[3];
        return [...line].flatMap((cell, col) => cell === " " ? [] : [col + 0.5]);
      };
      const before = columns(beforeTime), after = columns(afterTime);
      const center = (values: number[]) => values.reduce((sum, col) => sum + col, 0) / values.length;
      expect(before.length).toBeGreaterThan(0);
      expect(after.length).toBeGreaterThan(0);
      expect(Math.abs(center(after) - center(before))).toBeLessThanOrEqual(1);
      expect(Math.abs(after.length - before.length)).toBeLessThanOrEqual(1);
    },
  );

  it("keeps an early reflection centered while it spreads into a wet trace", () => {
    let previousWidth = 0;
    for (const age of [0.05, 0.125, 0.25, 0.3, 0.35, 0.55, 0.8]) {
      const impact = { col: 30.5, depth: 2, age };
      const line = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows: 4,
        snapshot: { drops: [], stars: [], splashes: [impact], waterMarks: [impact] },
      })[3];
      const columns = [...line].flatMap((cell, col) => cell === " " ? [] : [col + 0.5]);
      expect(columns.length).toBeGreaterThanOrEqual(previousWidth);
      expect(Math.abs(columns.reduce((sum, col) => sum + col, 0) / columns.length - 30.5)).toBeLessThanOrEqual(0.5);
      previousWidth = columns.length;
    }
  });

  it.each([12, 14, 16, 19, 60])("keeps distant wet regions visible without filling their dry gap at width %i", (width) => {
    const line = renderRainPanelLines({
      width, frameEnabled: false, rainRows: 4,
      snapshot: { drops: [], stars: [], waterMarks: [
        { col: 1.5, depth: 2, age: 1.2 }, { col: width - 1.5, depth: 2, age: 1.2 },
      ] },
    })[3];
    expect(line.slice(0, 4).trim()).not.toBe("");
    expect(line.slice(-4).trim()).not.toBe("");
    expect(line.slice(4, -4).trim()).toBe("");
  });

  it("keeps a distant faint trace visible when a stronger impact appears elsewhere", () => {
    const line = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      snapshot: { drops: [], stars: [], waterMarks: [
        { col: 10.5, depth: 2, age: 0.55 }, { col: 50.5, depth: 0, age: 1.8 },
      ] },
    })[3];
    expect(line.slice(8, 14).trim()).not.toBe("");
    expect(line.slice(48, 54).trim()).not.toBe("");
  });

  it.each([4, 10])("merges neighboring traces while keeping distant impacts separate in %i rows", (rainRows) => {
    const draw = (columns: number[]) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      snapshot: { drops: [], stars: [], waterMarks: columns.map((col) => ({ col, depth: 2, age: 1.2 })) },
    }).at(-1)!;
    expect(draw([30.1, 30.5, 31]).match(/[.~-]+/g)).toHaveLength(1);
    expect(draw([30.1, 45.1]).match(/[.~-]+/g)).toHaveLength(2);
    expect(draw([30.1, 45.1]).slice(34, 42).trim()).toBe("");
  });

  it.each([4, 10])("merges %i-row impacts without double brightness or input-order changes", (rainRows) => {
    const draw = (impacts: Array<{ col: number; depth: number; age: number }>) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      palette: createTokyoNightPalette(readTokyoTheme("dark")),
      snapshot: { drops: [], stars: [], waterMarks: impacts, splashes: impacts },
    });
    const impacts = [
      { col: 29.7, depth: 2, age: 0.05 }, { col: 30.4, depth: 2, age: 0.35 },
      { col: 45.2, depth: 1, age: 1.2 }, { col: 12.5, depth: 0, age: 2.1 },
    ];
    expect(draw([...impacts].reverse())).toEqual(draw(impacts));
    expect(draw([...impacts, ...impacts])).toEqual(draw(impacts));
  });

  it.each([4, 10])("holds a %i-row wet trace until its ripple ends before starting the fade", (rainRows) => {
    const draw = (age: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      palette: createTokyoNightPalette(readTokyoTheme("dark")),
      snapshot: { drops: [], stars: [], waterMarks: [{ col: 30.5, depth: 2, age, seed: 1 }] },
    }).at(-1)!;
    const established = draw(0.8);
    expect(established.replace(/\x1b\[[\d;]*m/g, "").trim()).not.toBe("");
    expect(draw(1.6)).toBe(established);
    expect(draw(1.84)).toBe(established);
    expect(draw(2.8)).not.toBe(established);
    expect(draw(6.6).replace(/\x1b\[[\d;]*m/g, "").trim()).not.toBe("");
    expect(draw(8.5).trim()).toBe("");
  });

  it.each([4, 10])("gradually dims a horizontal wet trace over several visible seconds in %i rows", (rainRows) => {
    for (const theme of ["dark", "light"] as const) {
      const background = theme === "dark" ? [26, 27, 38] : [225, 226, 231];
      const draw = (age: number) => {
        const line = renderRainPanelLines({
          width: 60, frameEnabled: false, rainRows,
          palette: createTokyoNightPalette(readTokyoTheme(theme)),
          snapshot: { drops: [], stars: [], waterMarks: [{ col: 30.5, depth: 2, age, seed: 1 }] },
        }).at(-1)!;
        let visible = "", color = background, contrast = 0;
        for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
          const rgb = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(part);
          if (rgb) color = rgb.slice(1).map(Number);
          else if (/^\x1b\[/.test(part)) color = background;
          else {
            visible += part;
            if (/\S/.test(part)) contrast = Math.max(contrast,
              color.reduce((sum, channel, index) => sum + Math.abs(channel - background[index]), 0));
          }
        }
        return { visible: visible.trim(), contrast };
      };
      const stages = [1.84, 3.04, 4.24, 5.44, 6.64].map(draw);
      for (const stage of stages) expect(stage.visible).toMatch(/^[.~-]+$/);
      for (let index = 1; index < stages.length; index++) expect(stages[index].contrast).toBeLessThan(stages[index - 1].contrast);
      expect(draw(8.5).visible).toBe("");
    }
  });

  it.each([4, 10])("leaves a local fading water trace after a ripple in a %i-row scene", (rainRows) => {
    const draw = (age: number, col = 30) => {
      const levels: number[] = [];
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        palette: { ...palette, rainShade: (role, light, text) => {
          if (role === "water" && /\S/.test(text)) levels.push(light);
          return text;
        } },
        snapshot: { drops: [], stars: [], waterMarks: [{ col, depth: 2, age }] },
      });
      return { lines, peak: Math.max(0, ...levels) };
    };
    expect(draw(0).lines.at(-1)!.trim()).toBe("");
    const fresh = draw(1.2), fading = draw(2.8);
    expect(fresh.lines.at(-1)!.trim()).toMatch(/^[.~-]+$/);
    expect(fresh.peak).toBeGreaterThan(fading.peak);
    const trace = fresh.lines.at(-1)!;
    expect(trace.slice(0, 25).trim()).toBe("");
    expect(trace.slice(35).trim()).toBe("");
    expect(draw(1.2, 45).lines.at(-1)!.slice(40, 50).trim()).not.toBe("");
    expect(draw(1.2, 45).lines.at(-1)!.slice(25, 35).trim()).toBe("");
    expect(draw(8.5).lines.at(-1)!.trim()).toBe("");
  });

  it.each([4, 10])("keeps the %i-row water reflection clearly visible after the ripple ends", (rainRows) => {
    const levels: number[] = [];
    const lines = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      palette: { ...palette, rainShade: (role, light, text) => {
        if (role === "water" && /\S/.test(text)) levels.push(light);
        return text;
      } },
      snapshot: { drops: [], stars: [], waterMarks: [{ col: 30, depth: 2, age: 1.2 }] },
    });
    expect(lines.at(-1)!.trim()).not.toBe("");
    expect(Math.max(0, ...levels)).toBeGreaterThanOrEqual(0.4);
  });

  it("does not dim wet reflections while a ripple fades over them", () => {
    const draw = (age: number, ripple: boolean, drop = false) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      palette: { ...palette, rainShade: (role, light, text) => role === "water" || role === "rain"
        ? text.replace(/\S/g, String.fromCharCode(65 + Math.round(light * 20))) : text },
      snapshot: {
        drops: drop ? [{ col: 30, row: 3.1, depth: 2 }] : [], stars: [],
        waterMarks: [{ col: 30, depth: 1, age }],
        splashes: ripple ? [{ col: 30, depth: 1, age }] : [],
      },
    })[3];
    for (const age of [0.7, 0.72, 0.726, 0.73]) for (const drop of [false, true]) {
      const wet = draw(age, false), combined = draw(age, true, drop);
      for (const col of [29, 30]) {
        expect(wet[col]).not.toBe(" ");
        expect(combined.charCodeAt(col)).toBeGreaterThanOrEqual(wet.charCodeAt(col));
      }
    }
  });

  it.each(["dark", "light"] as const)("distinguishes both ripple crests from the resting water in the %s theme", (theme) => {
    const colors = (line: string) => {
      const cells: Array<number[] | undefined> = [];
      let color: number[] | undefined;
      for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
        const rgb = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(part);
        if (rgb) color = rgb.slice(1).map(Number);
        else if (/^\x1b\[/.test(part)) color = undefined;
        else for (const _ of part) cells.push(color);
      }
      return cells;
    };
    const draw = (ripple: boolean) => colors(renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      palette: createTokyoNightPalette(readTokyoTheme(theme)),
      snapshot: { drops: [], stars: [],
        waterMarks: [{ col: 30, depth: 2, age: 1.2 }],
        splashes: ripple ? [{ col: 30, depth: 2, age: 0.8 }] : [],
      },
    })[3]);
    const resting = draw(false), spreading = draw(true);
    const background = theme === "dark" ? [26, 27, 38] : [225, 226, 231];
    const distance = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0);
    for (const col of [28, 31]) {
      expect(resting[col]).toBeDefined();
      expect(spreading[col]).toBeDefined();
      expect(distance(spreading[col]!, resting[col]!)).toBeGreaterThan(50);
      expect(distance(spreading[col]!, background)).toBeGreaterThan(distance(resting[col]!, background) * 1.5);
    }
  });

  it.each(["dark", "light"] as const)("uses the rain's cyan for the tips of a fresh splash in the %s theme", (name) => {
    const theme = readTokyoTheme(name);
    const lines = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      palette: createTokyoNightPalette(theme),
      snapshot: { drops: [], stars: [], splashes: [{ col: 30, depth: 2, age: 0.15 }] },
    });
    expect(lines.join("")).toContain(theme.fg("thinkingLow", "."));
  });

  it.each([["dark", [26, 27, 38], 270], ["light", [225, 226, 231], 180]] as const)(
    "keeps resting water clearly visible and blue against the %s background", (name, background, minimumContrast) => {
      const water = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows: 4,
        palette: createTokyoNightPalette(readTokyoTheme(name)),
        snapshot: { drops: [], stars: [], waterMarks: [{ col: 30, depth: 2, age: 1.2 }] },
      })[3];
      const colors = [...water.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((match) => match.slice(1).map(Number));
      const contrast = colors.map((rgb) => rgb.reduce((sum, channel, index) => sum + Math.abs(channel - background[index]), 0));
      expect(Math.max(0, ...contrast)).toBeGreaterThanOrEqual(minimumContrast);
      const peak = colors[contrast.indexOf(Math.max(...contrast))];
      expect(peak[2] - peak[0]).toBeGreaterThanOrEqual(60);
    },
  );

  it("keeps overlapping ripple shapes independent of impact order and wet reflection brightness", () => {
    const impacts = [
      { col: 30, depth: 1, age: 0.6 }, { col: 29, depth: 2, age: 0.6 },
      { col: 30, depth: 2, age: 0.55 },
    ];
    const draw = (records: typeof impacts) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      palette: createTokyoNightPalette(readTokyoTheme("dark")),
      snapshot: { drops: [], stars: [], splashes: records, waterMarks: records },
    });
    expect(draw([...impacts].reverse())).toEqual(draw(impacts));
    expect(draw([...impacts, ...impacts])).toEqual(draw(impacts));
  });

  it.each(["bare", "water", "moon"] as const)("refreshes a static frame when only the %s ripple color changes", (base) => {
    let color = 1;
    const config = makeConfig(true, false);
    config.get.mockReturnValue({ ...config.get(), rainRows: 10 });
    const rain = { frameRevision: 1, setRenderWidth() {}, getSnapshot: () => ({
      drops: [], stars: [],
      waterMarks: [5, 30].map((col) => ({ col, depth: 2, age: 1.2 })),
      splashes: [5, 30].map((col) => ({ col, depth: 2, age: base === "bare" ? 0.8 : 0.32 })),
    }) };
    const panel = new RainPanelComponent({ requestRender() {} } as any, {
      config: config as any, rain: rain as any,
      palette: { ...createTokyoNightPalette(readTokyoTheme("dark")), rippleShade: (_wave: number, wet: number, text: string, ink = "water") => {
        const active = base === "bare" ? wet === 0 : wet > 0 && ink === base;
        return `\x1b[38;5;${active ? color : 1}m${text}\x1b[39m`;
      } },
    });
    panel.render(40);
    expect(panel.hasVisibleChanges()).toBe(false);
    color = 2;
    expect(panel.render(40).join("")).toContain("\x1b[38;5;2m");
    expect(panel.hasVisibleChanges()).toBe(false);
    color = 3;
    expect(panel.hasVisibleChanges()).toBe(true);
    expect(panel.render(40).join("")).toContain("\x1b[38;5;3m");
  });

  it("keeps an edge reflection independent of impacts on another water row", () => {
    const draw = (extra: boolean) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 10,
      snapshot: {
        drops: [], stars: [], waterMarks: [
          { col: 0.5, depth: 1, age: 2.2 },
          ...(extra ? [{ col: 59.5, depth: 0, age: 0.7 }] : []),
        ],
      },
    });
    expect(draw(false)[8].trim()).not.toBe("");
    expect(draw(true)[8]).toBe(draw(false)[8]);
  });

  it.each([[4, 3], [10, 7]])("shows the first distant contact on a %i-row water surface", (rainRows, skyRows) => {
    for (const age of [0, 0.025, 0.05, 0.1]) {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        snapshot: { drops: [], stars: [], splashes: [{ col: 30.2, depth: 0, age }] },
      });
      expect(lines[skyRows][30]).toBe(".");
      expect(lines.slice(1, skyRows).every((line) => line.trim() === "")).toBe(true);
    }
  });

  it.each([[4, 0], [10, 0], [4, 2], [10, 2]])("hands a %i-row depth-%i impact continuously to a visible wet trace", (rainRows, depth) => {
    for (const age of [0.125, 0.15, 0.175, 0.2, 0.25, 0.35, 0.5]) {
      const visible: number[] = [];
      renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        palette: { ...palette, rainShade: (role, light, text) => {
          if (role === "water" && /\S/.test(text)) visible.push(light);
          return text;
        } },
        snapshot: {
          drops: [], stars: [], splashes: [{ col: 30, depth, age }],
          waterMarks: [{ col: 30, depth, age }],
        },
      });
      expect(visible.some((light) => light > 0)).toBe(true);
    }
  });

  it("keeps a complete moon, stars, rain, and water visible in a four-row panorama", () => {
    const lines = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      palette: { ...palette, rainShade: (role, _light, text) =>
        text.replace(/\S/g, role === "water" ? "w" : role === "moon" ? "m" : role === "star" ? "s" : "r") },
      snapshot: {
        time: 1, stars: [{ col: 45, row: 0 }],
        drops: [{ col: 35, row: 1.3, depth: 1 }],
        splashes: [{ col: 30, depth: 2, age: 0.35 }],
      },
    });
    expect(lines[0]).toContain("s");
    expect(lines[1]).toContain("r");
    expect(lines[0]).toContain("m");
    expect(lines[3]).toContain("w");
  });

  it.each([[4, 1, 3], [5, 1, 4], [6, 1, 4], [7, 1, 5], [8, 1, 5], [9, 1, 6], [10, 1, 7]])(
    "keeps a %i-row panorama's moon in %i text row within %i sky rows",
    (rainRows, moonRows, skyRows) => {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        palette: { ...palette, rainShade: (role, _light, text) =>
          role === "moon" ? text.replace(/\S/g, "m") : text },
        snapshot: { time: 1, drops: [], stars: [], waterMarks: [{ col: 5, depth: 2, age: 1.2 }] },
      });
      const moon = lines.slice(0, skyRows).filter((line) => /m/.test(line));
      expect(moon).toHaveLength(moonRows);
      expect(lines.slice(moonRows, skyRows).every((line) => line.trim() === "")).toBe(true);
      expect(lines.slice(skyRows).some((line) => /m/.test(line))).toBe(true);
    },
  );

  it("keeps the double-width crescent emoji and water complete in four rows", () => {
    const lines = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      snapshot: { time: 1, drops: [], stars: [], waterMarks: [{ col: 5, depth: 2, age: 1.2 }] },
    });
    expect(lines[0]).toContain("\u{1f319}");
    expect(lines[0].split("\u{1f319}")).toHaveLength(2);
    expect(lines.slice(1, 3).every((line) => line.trim() === "")).toBe(true);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => visibleWidth(line) === 60)).toBe(true);
    expect(lines[3].trim()).not.toBe("");
  });

  it("keeps open sky below the small moon even through foreground rain and splashes", () => {
    const lines = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 4,
      snapshot: {
        wind: 0.4, stars: [],
        drops: Array.from({ length: 240 }, (_, index) => ({ col: index % 60, row: Math.floor(index / 60), depth: 2 })),
        splashes: [{ col: 5, depth: 2, age: 0.05 }],
      },
    });
    expect(lines[1].slice(4, 6)).toBe("  ");
    expect(lines[1][30]).toBe("\\");
  });

  it.each([[1, false, false], [2, false, true], [3, false, true], [3, true, false], [4, true, true], [5, true, true], [60, false, true]] as const)(
    "keeps the two-column emoji whole at width %i with framing %s", (width, frameEnabled, visible) => {
      const lines = renderRainPanelLines({
        width, frameEnabled, rainRows: 4,
        palette: createTokyoNightPalette(readTokyoTheme("dark")),
        snapshot: { time: 1, drops: [], stars: [] },
      });
      const output = lines.join("\n");
      expect(output.includes("\u{1f319}")).toBe(visible);
      expect(output.replaceAll("\u{1f319}", "")).not.toMatch(/[\ud800-\udfff]/);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    },
  );

  it.each([4, 6, 10])("keeps the moon light and free of background blocks in a %i-row scene", (rainRows) => {
    const lines = renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      palette: createTokyoNightPalette(readTokyoTheme("dark")),
      snapshot: { time: 1, drops: [], stars: [] },
    });
    expect(lines.join("")).not.toContain("\x1b[48;");
  });

  it.each([[60, 1], [60, 2], [60, 3], [1, 4], [1, 10]])(
    "hides the whole moon and its moonlight when a crescent cannot fit in %ix%i cells",
    (width, rainRows) => {
      const lines = renderRainPanelLines({
        width, frameEnabled: false, rainRows,
        palette: { ...palette, rainShade: (role, _light, text) =>
          role === "moon" ? text.replace(/\S/g, "m") : text },
        snapshot: { time: 1, drops: [], stars: [{ col: 0, row: 0 }] },
      });
      expect(lines.join("")).not.toContain("m");
      expect(lines[0][0]).toBe("+");
    },
  );

  it.each([4, 10])("keeps rain and fresh impact droplets free of opposing strokes in %i rows", (rainRows) => {
    for (const wind of [-0.8, 0, 0.25, 0.7, NaN, Infinity]) {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        snapshot: {
          wind, stars: [], drops: [
            { col: 12.9, row: 1.4, depth: 0 },
            { col: 20.9, row: 1.8, depth: 1 }, { col: 35.9, row: 2.45, depth: 2 },
          ],
          splashes: [{ col: 45, depth: 2, age: 0.05 }],
        },
      });
      expect(lines.join("\n")).toContain("\\");
      expect(lines.join("\n")).not.toContain(",");
      expect(lines.join("\n")).not.toMatch(/[\/|]/);
    }
  });

  it.each([4, 8, 10])("keeps %i-row rain particles short with one clear head and at most one soft tail", (rainRows) => {
    for (const depth of [0, 1, 2]) for (const row of [2.1, 2.45, 2.9]) {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        snapshot: { wind: 0.4, stars: [], drops: [{ col: 30.9, row, depth }] },
      }).map((line) => line.slice(25, 35));
      const particle = lines.join("").replace(/ /g, "");
      expect(particle.match(/\\/g)).toHaveLength(1);
      expect(particle).toMatch(/^[.\\]+$/);
      expect(particle.length).toBeLessThanOrEqual(depth <= 1 ? 1 : 2);
      expect(lines.filter((line) => line.trim())).toHaveLength(particle.length);
    }
  });

  it("keeps compact water reflections tied to the breathing stars when the moon is hidden", () => {
    const draw = (phase: number) => {
      const levels: number[] = [];
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows: 3,
        palette: { ...palette, rainShade: (role, light, text) => {
          if (role === "water" && /\S/.test(text)) levels.push(light);
          return text;
        } },
        snapshot: { time: 1, drops: [], stars: [{ col: 30, row: 0, period: 4, phase }],
          waterMarks: [{ col: 30, depth: 2, age: 1.2 }] },
      }).slice(2);
      return { lines, peak: Math.max(0, ...levels) };
    };
    expect(draw(0).lines).toEqual(draw(0.5).lines);
    expect(draw(0).peak).toBeGreaterThan(draw(0.5).peak);
  });

  it("shrinks impact rings to the depth of a compact water plane", () => {
    const columns = (rainRows: number) => {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        palette: { ...palette, rainShade: (role, light, text) =>
          role === "water" && light > 0 ? text.replace(/\S/g, "o") : text },
        snapshot: { time: 1, drops: [], stars: [], splashes: [{ col: 30, depth: 2, age: 0.55 }] },
      });
      return [...lines.at(-1)!].flatMap((cell, index) => cell === "o" ? [index] : []);
    };
    const compact = columns(4), full = columns(8);
    expect(compact.length).toBeGreaterThan(0);
    expect(compact.at(-1)! - compact[0]).toBeLessThan(full.at(-1)! - full[0]);
  });

  it("keeps the emoji crescent and visible stars even under foreground rain", () => {
    const lines = renderRainPanelLines({
      width: 80, frameEnabled: false, rainRows: 10,
      snapshot: {
        time: 3, wind: 0.5,
        stars: [{ col: 60, row: 0 }, { col: 45, row: 2 }],
        drops: Array.from({ length: 80 * 5 }, (_, index) => ({
          col: index % 80, row: Math.floor(index / 80), depth: 2,
        })),
      },
    });
    expect(lines.join("\n").replaceAll("\u{1f319}", "")).toMatch(/^[\x20-\x7e\n]+$/);
    expect(lines[0].slice(4, 6)).toBe("\u{1f319}");
    expect(lines[1].slice(4, 6)).toBe("  ");
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(lines[0][60]).toBe("+");
    expect(lines[2][45]).toBe("+");
  });

  it("keeps the moon compact and suspended above its water reflection", () => {
    const lines = renderRainPanelLines({
      width: 100, frameEnabled: false, rainRows: 10,
      snapshot: { time: 1, drops: [], stars: [] },
    });
    const moonRows = lines.slice(0, 7).map((line) => line.slice(2, 14).trim());
    expect(moonRows.filter(Boolean)).toHaveLength(1);
    expect(moonRows[3]).toBe("");
    expect(moonRows[4]).toBe("");
    expect(moonRows[5]).toBe("");
    expect(moonRows[6]).toBe("");
  });

  it.each([[3, 1], [4, 2], [5, 2], [6, 2], [7, 3], [8, 3], [9, 3], [10, 4]])(
    "shows stars only in the top %i-row scene's %i allowed sky rows", (rainRows, starRows) => {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        snapshot: {
          time: 1, drops: [],
          stars: Array.from({ length: rainRows }, (_, row) => ({ col: 30, row })),
        },
      });
      expect(lines.slice(0, starRows).every((line) => line[30] === "+")).toBe(true);
      expect(lines.slice(starRows).join("\n")).not.toContain("+");
    },
  );

  it("shows replacement stars immediately when a static scene shrinks", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const config = new TokyoConfigManager();
    config.set("rainRows", 10);
    const rain = new RainAnimationManager(config, { requestRender() {} });
    try {
      rain.start({ tickMs: 0, maxDrops: 0 });
      rain.setRenderWidth(100, 10);
      rain.setRenderWidth(100, 4);
      const lines = renderRainPanelLines({
        width: 100, frameEnabled: false, rainRows: 4, snapshot: rain.getSnapshot(),
      });
      expect(lines.slice(0, 2).join("\n")).toContain("+");
      expect(lines.slice(2).join("\n")).not.toContain("+");
    } finally {
      rain.stop();
      random.mockRestore();
    }
  });

  it("reveals fading replacement stars and refreshes the panel when entering static mode", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const config = new TokyoConfigManager();
    config.set("rainRows", 10);
    config.set("editorFrame", false);
    const rain = new RainAnimationManager(config, { requestRender() {} });
    const panel = new RainPanelComponent({ requestRender() {} } as any, {
      config, rain, palette: createTokyoNightPalette(readTokyoTheme("dark")),
    });
    try {
      rain.start({ tickMs: 50, maxDrops: 0 });
      rain.setRenderWidth(100, 10);
      rain.setRenderWidth(100, 4);
      config.set("rainRows", 4);
      expect(panel.render(100).join("\n")).not.toContain("+");
      rain.applyProfile({ tickMs: 0, maxDrops: 0 });
      expect(panel.hasVisibleChanges()).toBe(true);
      expect(panel.render(100).slice(0, 2).join("\n")).toContain("+");
      rain.setRenderWidth(100, 10);
      expect(renderRainPanelLines({
        width: 100, frameEnabled: false, rainRows: 10, snapshot: rain.getSnapshot(),
      }).join("\n")).toContain("+");
    } finally {
      panel.dispose();
      rain.stop();
      random.mockRestore();
    }
  });

  it("leaves the sky clear of cloud texture and keeps stars recognizable throughout their twinkle", () => {
    for (const time of [0, 3, 8, 13]) {
      const lines = renderRainPanelLines({
        width: 80, frameEnabled: false, rainRows: 8,
        snapshot: { time, drops: [], stars: [{ col: 60, row: 0 }] },
      });
      expect(lines.slice(0, 5).join("\n")).not.toMatch(/[tSX]/);
      expect(lines[0][60]).toBe("+");
    }
  });

  it("gives stars a visible smooth breath with many brightness levels", () => {
    const starPalette = createTokyoNightPalette(readTokyoTheme("dark"));
    const brightness: number[] = [];
    for (let frame = 0; frame < 25; frame++) {
      const output = renderRainPanelLines({
        width: 20, frameEnabled: false, rainRows: 2, palette: starPalette,
        snapshot: { time: frame * 0.2, drops: [], stars: [{ col: 12, row: 0 }] },
      }).join("\n");
      const color = /\x1b\[38;2;(\d+);(\d+);(\d+)m\+\x1b\[39m/.exec(output);
      expect(color).not.toBeNull();
      brightness.push(Number(color![1]) + Number(color![2]) + Number(color![3]));
    }
    expect(new Set(brightness).size).toBeGreaterThan(10);
    expect(Math.max(...brightness) - Math.min(...brightness)).toBeGreaterThan(200);
  });

  it("draws layered ASCII rain around the moon within the requested rectangle", () => {
    const lines = renderRainPanelLines({
      width: 80,
      frameEnabled: false,
      rainRows: 8,
      snapshot: {
        drops: [{ col: 35.5, row: 3.25, depth: 2, speed: 14 }],
        stars: [{ col: 60, row: 0 }],
        time: 1,
        wind: 0.4,
        splashes: [{ col: 50, depth: 2, age: 0.55 }],
        waterMarks: [{ col: 30, depth: 2, age: 1.2 }],
      },
    });
    expect(lines).toHaveLength(8);
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(lines.join("\n").replaceAll("\u{1f319}", "")).toMatch(/^[\x20-\x7e\n]+$/);
    expect(lines.slice(1, 4).join("\n")).toContain("\\");
    expect(lines.slice(5).join("")).toMatch(/[.-]/);
  });

  it("turns a landing into an impact droplet, expanding ripple and fading wet trace", () => {
    const draw = (age?: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 8,
      snapshot: {
        drops: [], stars: [], time: 1,
        splashes: age === undefined ? [] : [{ col: 30, depth: 2, age }],
        waterMarks: age === undefined ? [] : [{ col: 30, depth: 2, age }],
      },
    });
    const columns = (age: number) => [...draw(age).at(-1)!].flatMap((cell, col) => cell === " " ? [] : [col]);
    const fresh = columns(0.05), spread = columns(0.55);
    expect(draw(0.05)[6][30]).toBe(".");
    expect(draw(0.55).join("")).toContain("(");
    expect(draw(0.55).join("")).toContain(")");
    expect(spread.at(-1)! - spread[0]).toBeGreaterThan(fresh.at(-1)! - fresh[0]);
    expect(draw(2.4).at(-1)!.trim()).toMatch(/^[.~-]+$/);
    expect(draw(8.5)).toEqual(draw());
  });

  it.each([0, 1, 2, 12, 40, 100])("clips every layer to a %i-column terminal with or without a frame", (width) => {
    for (const frameEnabled of [true, false]) for (const rainRows of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const lines = renderRainPanelLines({
        width, frameEnabled, rainRows,
        snapshot: {
          time: 2, wind: -0.8, stars: [{ col: -1, row: 0 }, { col: 1000, row: 0 }],
          drops: [{ col: NaN, row: 1 }, { col: Infinity, row: 1 }, { col: 0.2, row: 1.4, depth: 2 }],
          splashes: [{ col: 0, depth: 2, age: 0.3 }, { col: Infinity, depth: 2, age: 0.1 }],
          waterMarks: [
            { col: 0, depth: 2, age: 1.2 }, { col: width - 0.1, depth: 1, age: 1.2 },
            { col: Infinity, depth: 2, age: 1 }, { col: 5, depth: NaN, age: 1 },
            { col: 5, depth: 2, age: NaN }, { col: 5, depth: 2, age: -1 },
          ],
        },
      });
      expect(lines).toHaveLength(rainRows + (frameEnabled ? 1 : 0));
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    }
  });

  it("does not request an animation frame when only the fixed top edge is visible", () => {
    const config = makeConfig(true);
    let frameRevision = 1;
    const rain = {
      get frameRevision() { return frameRevision; },
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: config as any,
      rain: rain as any,
      getAvailableRows: () => 1,
    });
    panel.render(40);
    rain.getSnapshot.mockClear();
    frameRevision += 1;

    expect(panel.hasVisibleChanges()).toBe(false);
    expect(rain.getSnapshot).not.toHaveBeenCalled();
  });

  it("skips clipped changes and compares with the last rendered frame", () => {
    let frameRevision = 1;
    let currentSnapshot: RainFrameSnapshot = { drops: [{ col: -2, row: 0 }], stars: [] };
    const rain = {
      get frameRevision() { return frameRevision; },
      getSnapshot: vi.fn(() => currentSnapshot),
      setRenderWidth: vi.fn(),
    };
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: makeConfig(true) as any,
      rain: rain as any,
    });
    const displayed = panel.render(20);
    currentSnapshot = { drops: [{ col: -1, row: 0 }], stars: [] };
    frameRevision += 1;
    expect(panel.hasVisibleChanges()).toBe(false);

    currentSnapshot = { drops: [{ col: 14, row: 0 }], stars: [] };
    frameRevision += 1;
    expect(panel.hasVisibleChanges()).toBe(true);
    expect(panel.hasVisibleChanges()).toBe(true);
    expect(panel.render(20)).not.toEqual(displayed);
    expect(panel.hasVisibleChanges()).toBe(false);
  });

  it("reuses the checked frame but draws the latest snapshot if another tick arrives", () => {
    let frameRevision = 1;
    let currentSnapshot: RainFrameSnapshot = { drops: [], stars: [] };
    const rain = {
      get frameRevision() { return frameRevision; },
      getSnapshot: vi.fn(() => currentSnapshot),
      setRenderWidth: vi.fn(),
    };
    const getAvailableRows = vi.fn(() => 4);
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: makeConfig(true) as any,
      rain: rain as any,
      getAvailableRows,
    });
    panel.render(20);
    currentSnapshot = { drops: [{ col: 0, row: 0 }], stars: [] };
    frameRevision += 1;
    rain.getSnapshot.mockClear();
    getAvailableRows.mockClear();
    rain.setRenderWidth.mockClear();
    expect(panel.hasVisibleChanges()).toBe(true);
    expect(getAvailableRows).toHaveBeenCalledWith(20);
    expect(rain.setRenderWidth).not.toHaveBeenCalled();
    expect(panel.render(20)[1].replace(/\u001b\[[0-9;]*m/g, "")).toContain("│\\");
    expect(rain.getSnapshot).toHaveBeenCalledOnce();

    currentSnapshot = { drops: [{ col: 0, row: 1 }], stars: [] };
    frameRevision += 1;
    expect(panel.hasVisibleChanges()).toBe(true);
    currentSnapshot = { drops: [{ col: 14, row: 2 }], stars: [] };
    frameRevision += 1;
    const latest = panel.render(20);
    expect(latest[1].replace(/\u001b\[[0-9;]*m/g, "")[1]).toBe(" ");
    expect(latest[3].replace(/\u001b\[[0-9;]*m/g, "")[15]).toBe("\\");
  });

  it("refreshes a checked frame when the same theme proxy changes colors without a new tick", () => {
    let color = 1;
    const themeProxy = {
      name: "same-theme",
      fg: (_role: string, text: string) => `\x1b[38;5;${color}m${text}\x1b[39m`,
    } as Theme;
    const rain = {
      frameRevision: 1,
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: makeConfig(true) as any,
      rain: rain as any,
      getTheme: () => themeProxy,
    });
    panel.render(20);
    expect(panel.hasVisibleChanges()).toBe(false);

    color = 2;
    expect(panel.render(20).join("\n")).toContain("\x1b[38;5;2m");
    color = 3;
    expect(panel.hasVisibleChanges()).toBe(true);
    expect(panel.render(20).join("\n")).toContain("\x1b[38;5;3m");
    expect(panel.hasVisibleChanges()).toBe(false);
  });

  it("requests a new layout after terminal or config changes even with zero animated rows", () => {
    const config = makeConfig(true);
    const terminal = { rows: 8, columns: 40 };
    const rain = { frameRevision: 1, getSnapshot: () => snapshot, setRenderWidth() {} };
    let availableRows = 1;
    const panel = new RainPanelComponent({ terminal, requestRender: vi.fn() } as any, {
      config: config as any, rain: rain as any,
      getAvailableRows: () => availableRows,
    });
    panel.render(40);
    expect(panel.hasVisibleChanges()).toBe(false);
    terminal.rows = 40;
    expect(panel.hasVisibleChanges()).toBe(true);
    availableRows = 4;
    expect(panel.render(40)).toHaveLength(4);
    expect(panel.hasVisibleChanges()).toBe(false);

    availableRows = 1;
    panel.render(40);
    terminal.columns = 50;
    expect(panel.hasVisibleChanges()).toBe(true);
    panel.render(50);
    config.get.mockReturnValue({ ...config.get(), rainRows: 2 });
    expect(panel.hasVisibleChanges()).toBe(true);
    panel.render(50);
    config.get.mockReturnValue({ ...config.get(), editorFrame: false });
    expect(panel.hasVisibleChanges()).toBe(true);
  });

  it("requests the first visible frame again after the panel was disabled", () => {
    const config = makeConfig(true);
    const rain = { frameRevision: 1, getSnapshot: () => snapshot, setRenderWidth() {} };
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: config as any, rain: rain as any,
    });
    expect(panel.hasVisibleChanges()).toBe(true);
    panel.render(20);
    expect(panel.hasVisibleChanges()).toBe(false);
    config.get.mockReturnValue({ ...config.get(), panel: false });
    expect(panel.render(20)).toEqual([]);
    expect(panel.hasVisibleChanges()).toBe(false);
    config.get.mockReturnValue({ ...config.get(), panel: true });
    expect(panel.hasVisibleChanges()).toBe(true);
    panel.render(20);
    panel.invalidate();
    expect(panel.hasVisibleChanges()).toBe(true);
    panel.dispose();
    expect(panel.hasVisibleChanges()).toBe(false);
  });

  it("keeps requesting a frame when comparing the animation fails", () => {
    let frameRevision = 1;
    const rain = {
      get frameRevision() { return frameRevision; },
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: makeConfig(true) as any, rain: rain as any,
    });
    panel.render(20);
    frameRevision += 1;
    rain.getSnapshot.mockImplementation(() => { throw new Error("snapshot unavailable"); });

    expect(panel.hasVisibleChanges()).toBe(true);
    expect(panel.hasVisibleChanges()).toBe(true);
  });

  it("restores the panel after a render error even if the animation did not change", () => {
    let fail = false;
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: makeConfig(true) as any,
      rain: { frameRevision: 1, getSnapshot: () => snapshot, setRenderWidth() {} } as any,
      getAvailableRows: () => {
        if (fail) throw new Error("height temporarily unavailable");
        return 1;
      },
    });
    try {
      const displayed = panel.render(20);
      fail = true;
      expect(panel.render(20)).toEqual([]);
      fail = false;
      expect(panel.hasVisibleChanges()).toBe(true);
      expect(panel.render(20)).toEqual(displayed);
      expect(panel.hasVisibleChanges()).toBe(false);
    } finally {
      report.mockRestore();
    }
  });








  it("fits the rain to its available rows and restores cached height without changing config", () => {
    const config = makeConfig(true);
    const rain = {
      frameRevision: 1,
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    let availableRows = 2;
    const getAvailableRows = vi.fn(() => availableRows);
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: config as any,
      rain: rain as any,
      getAvailableRows,
    });

    const compressed = panel.render(40);
    expect(compressed).toHaveLength(2);
    expect(compressed[0]).toContain("╭");
    expect(compressed[1]).toContain("+");
    expect(compressed[1]).not.toMatch(/[#%@]/);
    expect(panel.render(40)).toBe(compressed);
    expect(getAvailableRows).toHaveBeenCalledWith(40);
    expect(rain.getSnapshot).toHaveBeenCalledOnce();

    availableRows = 4;
    const restored = panel.render(40);
    expect(restored).toHaveLength(4);
    expect(restored).not.toBe(compressed);
    expect(rain.getSnapshot).toHaveBeenCalledTimes(2);
    availableRows = 20;
    expect(panel.render(40)).toBe(restored);
    expect(config.get().rainRows).toBe(3);
  });

  it("is a permanent above-editor component whose visibility follows panel config", () => {
    const config = makeConfig(false);
    const rain = {
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    const tui = { requestRender: vi.fn() };
    const panel = new RainPanelComponent(tui as any, {
      config: config as any,
      rain: rain as any,
    });

    expect(panel.render(40)).toEqual([]);

    config.get.mockReturnValue({
      ...config.get.mock.results[0]!.value,
      panel: true,
    });
    const lines = panel.render(40);
    expect(lines.length).toBe(4);
    expect(lines.join("\n")).toMatch(/[+#%@]/);
    expect(visibleWidth(lines[0])).toBe(40);
    expect(rain.setRenderWidth).toHaveBeenCalledWith(38, 3);
  });

  it.each([true, false])("handles a zero row budget with the frame set to %s", (editorFrame) => {
    const config = makeConfig(true, editorFrame);
    const rain = {
      frameRevision: 1,
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    let availableRows = 0;
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: config as any,
      rain: rain as any,
      getAvailableRows: () => availableRows,
    });

    const collapsed = panel.render(40);
    expect(collapsed).toHaveLength(editorFrame ? 1 : 0);
    if (editorFrame) {
      expect(collapsed[0]).toContain("╭");
      expect(collapsed[0]).toContain("╮");
      expect(visibleWidth(collapsed[0])).toBe(40);
    }
    expect(collapsed.join("\n")).not.toContain(")");
    availableRows = -1;
    expect(panel.render(40)).toBe(collapsed);

    availableRows = 2;
    const expanded = panel.render(40);
    expect(expanded).toHaveLength(2);
    expect(expanded.join("\n")).toContain("+");
    expect(expanded.join("\n")).not.toMatch(/[#%@]/);
    expect(config.get().rainRows).toBe(3);
  });

  it("owns the shared frame top edge without closing the bottom", () => {
    const lines = renderRainPanelLines({
      width: 20,
      frameEnabled: true,
      rainRows: 2,
      snapshot,
    });
    const output = lines.join("\n");

    expect(output).toContain("╭");
    expect(output).not.toContain("╰");
    expect(lines.every((line) => visibleWidth(line) === 20)).toBe(true);
  });

  it("derives rain, star, and moon colors from the active theme palette", () => {
    const lines = renderRainPanelLines({
      width: 1000,
      frameEnabled: false,
      rainRows: 10,
      snapshot: { drops: [{ col: 20, row: 1 }], stars: [{ col: 30, row: 0 }] },
      palette,
    });

    expect(lines.slice(0, 3).join("\n")).toContain("<fg:warning>\u{1f319}</fg:warning>");
    expect(lines.join("\n")).toContain("<fg:thinkingLow>\\</fg:thinkingLow>");
    expect(lines.join("\n")).toContain("<fg:accent>+</fg:accent>");
  });

  it.each([
    [
      "dark",
      {
        moon: "\x1b[38;2;224;175;104m",
        rain: "\x1b[38;2;100;162;201m\\\x1b[39m",
        star: "\x1b[38;2;187;154;247m+\x1b[39m",
      },
    ],
    [
      "light",
      {
        moon: "\x1b[38;2;136;94;22m",
        rain: "\x1b[38;2;63;147;182m\\\x1b[39m",
        star: "\x1b[38;2;102;54;186m+\x1b[39m",
      },
    ],
  ] as const)(
    "renders the %s theme's dynamic rain colors",
    (name, expected) => {
      const lines = renderRainPanelLines({
        width: 40,
        frameEnabled: true,
        rainRows: 10,
        snapshot: { drops: [{ col: 20, row: 1 }], stars: [{ col: 30, row: 0, phase: 0.25, period: 4 }] },
        palette: createTokyoNightPalette(readTokyoTheme(name)),
      });
      const output = lines.join("\n");

      expect(lines).toHaveLength(11);
      expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
      expect(lines[0]).toContain("\x1b[38;2;61;53;119m");
      expect(output).toContain(expected.moon);
      expect(output).toContain(expected.rain);
      expect(output).toContain(expected.star);
    },
  );

  it("does not add box chrome when editorFrame is disabled", () => {
    const lines = renderRainPanelLines({
      width: 20,
      frameEnabled: false,
      rainRows: 2,
      snapshot,
    });
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│─]/);
  });

  it("refreshes cached lines when the active theme changes", () => {
    const darkTheme = {
      fg: (_color: string, text: string) => `\x1b[38;5;1m${text}\x1b[39m`,
      bg: (_color: string, text: string) => `\x1b[48;5;1m${text}\x1b[49m`,
    } as unknown as Theme;
    const lightTheme = {
      fg: (_color: string, text: string) => `\x1b[38;5;2m${text}\x1b[39m`,
      bg: (_color: string, text: string) => `\x1b[48;5;2m${text}\x1b[49m`,
    } as unknown as Theme;
    let activeTheme = darkTheme;
    const themeProxy = new Proxy({} as Theme, {
      get: (_target, property) =>
        Reflect.get(activeTheme, property, activeTheme),
    });
    const config = makeConfig(true);
    let frameRevision = 1;
    const rain = {
      get frameRevision() { return frameRevision; },
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: config as any,
      rain: rain as any,
      getTheme: () => themeProxy,
    });

    const first = panel.render(40);
    expect(panel.render(40)).toBe(first);

    activeTheme = lightTheme;
    panel.invalidate();
    const changed = panel.render(40);
    expect(changed).not.toBe(first);
    expect(changed.join("\n")).toContain("\x1b[38;5;2m");
    expect(frameRevision).toBe(1);
  });

  it("reuses rendered lines until the rain frame revision changes", () => {
    const config = makeConfig(true);
    let frameRevision = 1;
    const rain = {
      get frameRevision() { return frameRevision; },
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: config as any,
      rain: rain as any,
    });

    const first = panel.render(40);
    const cached = panel.render(40);

    expect(cached).toBe(first);
    expect(rain.getSnapshot).toHaveBeenCalledOnce();

    frameRevision += 1;
    const changed = panel.render(40);
    expect(changed).not.toBe(first);
    expect(rain.getSnapshot).toHaveBeenCalledTimes(2);

    panel.invalidate();
    expect(panel.render(40)).not.toBe(changed);
    expect(rain.getSnapshot).toHaveBeenCalledTimes(3);
  });
});
