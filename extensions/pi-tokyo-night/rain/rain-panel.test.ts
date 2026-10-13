import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RainPanelComponent, renderRainPanelLines } from "./rain-panel";
import type { RainFrameSnapshot } from "./rain-manager";
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
  drops: [{ col: 3, row: 1 }],
  stars: [{ col: 5, row: 1 }],
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

  it("skips changes hidden by the moon and compares with the last rendered frame", () => {
    let frameRevision = 1;
    let currentSnapshot: RainFrameSnapshot = { drops: [{ col: 2, row: 0 }], stars: [] };
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
    currentSnapshot = { drops: [{ col: 3, row: 0 }], stars: [] };
    frameRevision += 1;
    expect(panel.hasVisibleChanges()).toBe(false);

    currentSnapshot = { drops: [{ col: 4, row: 0 }], stars: [] };
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
    expect(getAvailableRows).not.toHaveBeenCalled();
    expect(rain.setRenderWidth).not.toHaveBeenCalled();
    expect(panel.render(20)[1].replace(/\u001b\[[0-9;]*m/g, "")).toContain("│`");
    expect(rain.getSnapshot).toHaveBeenCalledOnce();

    currentSnapshot = { drops: [{ col: 0, row: 1 }], stars: [] };
    frameRevision += 1;
    expect(panel.hasVisibleChanges()).toBe(true);
    currentSnapshot = { drops: [{ col: 1, row: 2 }], stars: [] };
    frameRevision += 1;
    const latest = panel.render(20);
    expect(latest[1]).not.toContain("`");
    expect(latest[2]).not.toContain("`");
    expect(latest[3].replace(/\u001b\[[0-9;]*m/g, "")).toContain("│ `");
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
    expect(panel.render(20).join("\n")).toContain("\x1b[38;5;2m🌙");
    color = 3;
    expect(panel.hasVisibleChanges()).toBe(true);
    expect(panel.render(20).join("\n")).toContain("\x1b[38;5;3m🌙");
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
    expect(compressed[1]).toContain("🌙");
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
    expect(lines.join("\n")).toContain("🌙");
    expect(visibleWidth(lines[0])).toBe(40);
    expect(rain.setRenderWidth).toHaveBeenCalledWith(38);
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
    expect(collapsed.join("\n")).not.toContain("🌙");
    availableRows = -1;
    expect(panel.render(40)).toBe(collapsed);

    availableRows = 2;
    const expanded = panel.render(40);
    expect(expanded).toHaveLength(2);
    expect(expanded.join("\n")).toContain("🌙");
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
      width: 100,
      frameEnabled: false,
      rainRows: 2,
      snapshot,
      palette,
    });

    expect(lines.join("\n")).toContain("<fg:warning>🌙</fg:warning>");
    expect(lines.join("\n")).toContain("<fg:thinkingLow>`</fg:thinkingLow>");
    expect(lines.join("\n")).toContain("<fg:accent>✦</fg:accent>");
  });

  it.each([
    [
      "dark",
      {
        moon: "\x1b[38;2;224;175;104m🌙\x1b[39m",
        rain: "\x1b[38;2;125;207;255m`\x1b[39m",
        star: "\x1b[38;2;187;154;247m✦\x1b[39m",
      },
    ],
    [
      "light",
      {
        moon: "\x1b[38;2;136;94;22m🌙\x1b[39m",
        rain: "\x1b[38;2;9;121;165m`\x1b[39m",
        star: "\x1b[38;2;102;54;186m✦\x1b[39m",
      },
    ],
  ] as const)(
    "renders the %s theme's dynamic rain colors",
    (name, expected) => {
      const lines = renderRainPanelLines({
        width: 16,
        frameEnabled: true,
        rainRows: 2,
        snapshot,
        palette: createTokyoNightPalette(readTokyoTheme(name)),
      });
      const output = lines.join("\n");

      expect(lines).toHaveLength(3);
      expect(lines.every((line) => visibleWidth(line) === 16)).toBe(true);
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
