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
