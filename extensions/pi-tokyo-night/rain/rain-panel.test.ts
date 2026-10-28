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

const palette = createTokyoNightPalette({
  fg: (color: string, text: string) => `<fg:${color}>${text}</fg:${color}>`,
  bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
} as unknown as Theme);

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
    expect(draw(4.3).lines.at(-1)!.trim()).toBe("");
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

  it("shortens foreground rain tails to leave the compact sky readable", () => {
    const draw = (rainRows: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows,
      snapshot: { time: 1, wind: 0, stars: [], drops: [{ col: 30.9, row: 2.45, depth: 2 }] },
    });
    expect(draw(8)[0][30]).toBe("\\");
    expect(draw(4)[0][30]).toBe(" ");
    expect(draw(4)[1][30]).toBe("\\");
  });

  it("keeps compact water reflections tied to the breathing stars when the moon is hidden", () => {
    const draw = (phase: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 3,
      palette: { ...palette, rainShade: (role, light, text) =>
        role === "water" && light > 0.4 ? text.replace(/\S/g, "g") : text },
      snapshot: { time: 1, drops: [], stars: [{ col: 30, row: 0, period: 4, phase }],
        waterMarks: [{ col: 30, depth: 2, age: 1.2 }] },
    }).slice(2);
    expect(draw(0)).not.toEqual(draw(0.5));
  });

  it("shrinks impact rings to the depth of a compact water plane", () => {
    const columns = (rainRows: number) => {
      const lines = renderRainPanelLines({
        width: 60, frameEnabled: false, rainRows,
        palette: { ...palette, rainShade: (role, light, text) =>
          role === "water" && light > 0.3 ? text.replace(/\S/g, "o") : text },
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
    expect(new Set(lines.join("").replace(/\s/g, "")).size).toBeGreaterThan(5);
  });

  it("turns a landing into a small droplet, expanding ring and wet trace, then clears it", () => {
    const draw = (age?: number) => renderRainPanelLines({
      width: 60, frameEnabled: false, rainRows: 8,
      snapshot: {
        drops: [], stars: [], time: 1,
        splashes: age === undefined ? [] : [{ col: 30, depth: 2, age }],
        waterMarks: age === undefined ? [] : [{ col: 30, depth: 2, age }],
      },
    });
    expect(draw(0.05)[6][30]).toBe(".");
    expect(draw(0.55).at(-1)).toContain("(");
    expect(draw(0.55).at(-1)).toContain(")");
    expect(draw(1.5).at(-1)!.trim()).toMatch(/^[.~-]+$/);
    expect(draw(4.3)).toEqual(draw());
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
