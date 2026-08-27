import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { TokyoConfigManager } from "../core/config";
import { NeonStudioComponent } from "./neon-studio";
import {
  NeonStudioController,
  type NeonStudioThemeChoice,
  type NeonStudioThemeResult,
} from "./neon-studio-controller";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;]*m/g, "");

function makeStudio(options: {
  mode?: "regular" | "fullscreen";
  renderFullscreenStatus?: (width: number) => string[];
  previewThemes?: Partial<Record<"dark" | "light", Theme>>;
  initialThemeChoice?: NeonStudioThemeChoice;
  persistedThemeChoice?: NeonStudioThemeChoice;
  getTheme?: () => Theme;
  getAutomaticTheme?: () => Theme | undefined;
} = {}) {
  const config = new TokyoConfigManager();
  const write = vi.spyOn(config, "write").mockReturnValue(true);
  const tui = {
    requestRender: vi.fn(),
    mode: options.mode,
  } as unknown as TUI;
  const done = vi.fn();
  const notify = vi.fn();
  const errorSink = vi.fn();
  const onConfigChange = vi.fn();
  const previewTheme = vi.fn(
    (_choice: NeonStudioThemeChoice): NeonStudioThemeResult => ({ success: true }),
  );
  const saveTheme = vi.fn((): NeonStudioThemeResult => ({ success: true }));
  const restoreTheme = vi.fn((): NeonStudioThemeResult => ({ success: true }));
  const controller = new NeonStudioController({
    config,
    notify,
    errorSink,
    done,
    onConfigChange,
    previewTheme,
    saveTheme,
    restoreTheme,
    initialThemeChoice: options.initialThemeChoice,
    persistedThemeChoice: options.persistedThemeChoice,
  });
  const studio = new NeonStudioComponent(tui, theme, controller, {
    renderFullscreenStatus: options.renderFullscreenStatus,
    previewThemes: options.previewThemes ?? { dark: theme, light: theme },
    getTheme: options.getTheme,
    getAutomaticTheme: options.getAutomaticTheme,
  });
  return {
    config,
    write,
    done,
    notify,
    errorSink,
    onConfigChange,
    previewTheme,
    saveTheme,
    restoreTheme,
    controller,
    studio,
    tui,
  };
}

describe("NeonStudioComponent", () => {
  it("force-closes after a failed save and reapplies changed runtime settings from the opening snapshot", () => {
    const { config, controller, done, onConfigChange, write } = makeStudio();
    const openingConfig = config.get();
    const restoredEvents: Array<{ change: unknown; snapshot: unknown }> = [];
    onConfigChange.mockImplementation((change) => {
      restoredEvents.push({ change, snapshot: config.get() });
    });

    controller.changeSetting("appearance", 1);
    controller.changeSetting("status", 0);
    controller.changeSetting("rain", 0);
    controller.changeSetting("rain", 1);
    expect(config.get()).not.toEqual(openingConfig);
    onConfigChange.mockClear();
    restoredEvents.length = 0;

    write.mockReturnValue(false);

    controller.forceClose();

    expect(done).toHaveBeenCalledOnce();
    expect(config.get()).toEqual(openingConfig);
    expect(restoredEvents.map(({ change }) => change)).toEqual([
      { kind: "config", key: "panel" },
      { kind: "config", key: "rainMode" },
      { kind: "config", key: "rainRows" },
      { kind: "status", key: "model" },
    ]);
    for (const { snapshot } of restoredEvents) {
      expect(snapshot).toEqual(openingConfig);
    }
  });

  it("delegates force-close rollback even when the selected choice did not change", () => {
    const { controller, restoreTheme } = makeStudio({
      initialThemeChoice: "automatic",
      persistedThemeChoice: "automatic",
    });

    controller.forceClose();

    expect(restoreTheme).toHaveBeenCalledOnce();
  });

  it("force-closes during shutdown without saving the theme when config persistence fails", () => {
    const { controller, done, notify, restoreTheme, saveTheme, studio, write } = makeStudio();
    studio.handleInput("\r");
    write.mockReturnValue(false);
    saveTheme.mockImplementation(() => {
      throw new Error("theme save failed");
    });
    notify.mockImplementation(() => {
      throw new Error("stale notify");
    });

    expect(() => controller.forceClose()).not.toThrow();

    expect(saveTheme).not.toHaveBeenCalled();
    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });

  it("restores the opening Theme instead of committing a preview when force-closed", () => {
    const { controller, done, restoreTheme, saveTheme, studio } = makeStudio();
    studio.handleInput("\r");

    controller.forceClose();

    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(saveTheme).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("restores a temporary opening Theme even when the preview matches the persisted choice", () => {
    const { controller, restoreTheme, saveTheme, studio } = makeStudio({
      initialThemeChoice: "light",
      persistedThemeChoice: "dark",
    });
    studio.handleInput("\r");
    studio.handleInput("\r");

    controller.forceClose();

    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(saveTheme).not.toHaveBeenCalled();
  });

  it("stays open and restores the opening Theme when configuration persistence fails", () => {
    const { done, errorSink, notify, restoreTheme, studio, tui, write } = makeStudio();
    studio.handleInput("\r");
    vi.mocked(tui.requestRender).mockClear();
    write.mockImplementationOnce((sink) => {
      expect(sink).toBe(errorSink);
      sink!(new Error("rename failed"), "writeTokyoConfig");
      return false;
    });

    studio.handleInput("\x1b");

    expect(errorSink).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "Could not save Tokyo Night settings. Neon Studio remains open.",
      "error",
    );
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });

  it("renders as a middle frame segment while Rain owns the top edge", () => {
    const { studio } = makeStudio();

    const lines = studio.render(40);
    const output = lines.join("\n");

    expect(stripAnsi(lines[0])).toMatch(/^│/);
    expect(output).not.toContain("╭");
    expect(output).not.toContain("╰");
  });

  it("takes top-edge ownership when Rain is disabled without closing the card", () => {
    const { config, studio } = makeStudio();
    config.set("panel", false);

    const output = studio.render(40).join("\n");

    expect(output).toContain("╭");
    expect(output).not.toContain("╰");
  });

  it("keeps status rows visible inside the fullscreen Studio dock", () => {
    const renderFullscreenStatus = vi.fn(() => ["status row", "status bottom"]);
    const { studio } = makeStudio({
      mode: "fullscreen",
      renderFullscreenStatus,
    });

    const lines = studio.render(80);

    expect(renderFullscreenStatus).toHaveBeenCalledWith(80);
    expect(lines.slice(-2)).toEqual(["status row", "status bottom"]);
  });

  it("closes the fullscreen frame when Status rendering fails", () => {
    const { studio } = makeStudio({
      mode: "fullscreen",
      renderFullscreenStatus: () => {
        throw new Error("status render failed");
      },
    });

    const lines = studio.render(40);

    expect(lines.at(-1)).toContain("╰");
    expect(lines.at(-1)).toContain("╯");
  });

  it.each([0, 1, 2, 5, 20, 80])(
    "keeps every section within width=%i",
    (width) => {
      const { studio } = makeStudio();

      for (let section = 0; section < 4; section++) {
        expect(
          studio.render(width).every((line) => visibleWidth(line) <= width),
        ).toBe(true);
        studio.handleInput("\t");
      }
    },
  );

  it("renders the four setting sections and the active Appearance settings", () => {
    const { studio } = makeStudio();

    const lines = studio.render(80);
    const output = lines.join("\n");

    expect(output).toContain("Neon Studio");
    expect(output).toContain("Appearance");
    expect(output).toContain("Status");
    expect(output).toContain("Usage");
    expect(output).toContain("Rain");
    expect(output).toContain("Theme");
    expect(output).toContain("Top Panel");
    expect(output).toContain("Interface Frame");
    expect(output).toContain("Status Icons");
    expect(output).toContain(
      "Detect current terminal colors now; restart Pi to keep Automatic",
    );
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("follows the dynamic active Theme ahead of a cached Automatic preview", () => {
    const cachedAutomaticTheme = {
      fg: vi.fn((_color: string, text: string) => `cached:${text}`),
    } as unknown as Theme;
    let activeTheme = {
      fg: vi.fn((_color: string, text: string) => `dark:${text}`),
    } as unknown as Theme;
    const { studio } = makeStudio({
      initialThemeChoice: "automatic",
      getTheme: () => activeTheme,
      getAutomaticTheme: () => cachedAutomaticTheme,
    });

    expect(studio.render(80).join("\n")).toContain("dark: Neon Studio");
    activeTheme = {
      fg: vi.fn((_color: string, text: string) => `light:${text}`),
    } as unknown as Theme;
    expect(studio.render(80).join("\n")).toContain("light: Neon Studio");
  });

  it("starts from the configured pinned theme", () => {
    const { studio } = makeStudio({ initialThemeChoice: "light" });

    expect(studio.render(80).join("\n")).toContain("Theme: Tokyo Night Light");
  });

  it("cycles exactly Automatic, Dark, and Light", () => {
    const { previewTheme, studio } = makeStudio();

    expect(studio.render(80).join("\n")).toContain("Theme: Automatic");
    studio.handleInput("\r");
    expect(studio.render(80).join("\n")).toContain("Theme: Tokyo Night Dark");
    studio.handleInput("\r");
    expect(studio.render(80).join("\n")).toContain("Theme: Tokyo Night Light");
    studio.handleInput("\r");
    expect(studio.render(80).join("\n")).toContain("Theme: Automatic");

    expect(previewTheme.mock.calls.map(([choice]) => choice)).toEqual([
      "dark",
      "light",
      "automatic",
    ]);
    expect(studio.render(80).join("\n")).not.toContain("Keep current");
  });

  it("cycles Automatic and pinned themes in reverse with Left", () => {
    const { previewTheme, studio } = makeStudio();

    studio.handleInput("\x1b[D");
    expect(studio.render(80).join("\n")).toContain("Theme: Tokyo Night Light");
    studio.handleInput("\x1b[D");
    expect(studio.render(80).join("\n")).toContain("Theme: Tokyo Night Dark");
    studio.handleInput("\x1b[D");
    expect(studio.render(80).join("\n")).toContain("Theme: Automatic");

    expect(previewTheme.mock.calls.map(([choice]) => choice)).toEqual([
      "light",
      "dark",
      "automatic",
    ]);
  });

  it("skips an unavailable pinned theme while cycling in reverse", () => {
    const { previewTheme, studio } = makeStudio();
    previewTheme.mockImplementation((choice) => choice === "light"
      ? { success: false, error: "light unavailable" }
      : { success: true });

    studio.handleInput("\x1b[D");

    expect(previewTheme).toHaveBeenNthCalledWith(1, "light");
    expect(previewTheme).toHaveBeenNthCalledWith(2, "dark");
    expect(studio.render(80).join("\n")).toContain("Theme: Tokyo Night Dark");
  });

  it("explains that Automatic applies after restarting Pi", () => {
    const { studio } = makeStudio();

    const output = studio.render(80).join("\n");
    expect(output).toContain("Theme: Automatic");
    expect(output).toContain("Detect current terminal colors now");
    expect(output).toContain("restart Pi");
    expect(output).not.toContain("Keep current");
  });

  it("keeps Automatic selectable when restoring its full UI preview fails", () => {
    const { notify, previewTheme, studio } = makeStudio({
      initialThemeChoice: "light",
    });
    previewTheme.mockImplementation((choice) => choice === "automatic"
      ? { success: false, error: "opening theme restore failed" }
      : { success: true });

    studio.handleInput("\r");

    expect(studio.render(80).join("\n")).toContain("Theme: Automatic");
    expect(notify).toHaveBeenCalledWith("opening theme restore failed", "error");
  });

  it("keeps the current selection when theme preview throws", () => {
    const { notify, previewTheme, studio } = makeStudio();
    previewTheme.mockImplementation(() => {
      throw new Error("preview failed");
    });

    expect(() => studio.handleInput("\r")).not.toThrow();

    expect(studio.render(80).join("\n")).toContain("Theme: Automatic");
    expect(notify).toHaveBeenCalledWith("preview failed", "error");
  });

  it("does not save a theme when the selection was not changed", () => {
    const { done, saveTheme, studio } = makeStudio();

    studio.handleInput("\x1b");

    expect(saveTheme).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("restores the opening Theme when its close-time save fails", () => {
    const { done, notify, restoreTheme, saveTheme, studio, tui } = makeStudio();
    saveTheme.mockReturnValue({ success: false, error: "theme save failed" });

    studio.handleInput("\r");
    vi.mocked(tui.requestRender).mockClear();
    studio.handleInput("\x1b");

    expect(done).not.toHaveBeenCalled();
    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("theme save failed", "error");
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });

  it("previews Dark locally and commits it only when Escape saves", () => {
    const darkTheme = {
      fg: vi.fn((_color: string, text: string) => `dark:${text}`),
    } as unknown as Theme;
    const { done, previewTheme, saveTheme, studio, write } = makeStudio({
      previewThemes: { dark: darkTheme },
    });

    studio.handleInput("\r");

    expect(previewTheme).toHaveBeenLastCalledWith("dark");
    expect(studio.render(80).join("\n")).toContain("dark: Neon Studio");
    expect(studio.render(80).join("\n")).toContain("Tokyo Night Dark");
    expect(studio.render(80).join("\n")).toContain(
      "Preview the full interface; Esc saves the selected theme",
    );
    expect(write).not.toHaveBeenCalled();
    expect(saveTheme).not.toHaveBeenCalled();

    studio.handleInput("\x1b");

    expect(write).toHaveBeenCalledOnce();
    expect(saveTheme).toHaveBeenCalledWith("dark");
    expect(done).toHaveBeenCalledOnce();
  });

  it("keeps fullscreen Status outside the local Theme preview", () => {
    const darkTheme = {
      fg: vi.fn((_color: string, text: string) => text),
    } as unknown as Theme;
    const renderFullscreenStatus = vi.fn(() => ["status", "bottom"]);
    const { studio } = makeStudio({
      mode: "fullscreen",
      previewThemes: { dark: darkTheme },
      renderFullscreenStatus,
    });

    studio.handleInput("\r");
    studio.render(80);

    expect(renderFullscreenStatus).toHaveBeenLastCalledWith(80);
  });

  it("skips an unavailable Theme choice instead of trapping navigation", () => {
    const { previewTheme, studio } = makeStudio();
    previewTheme.mockImplementation((choice) => choice === "dark"
      ? { success: false, error: "dark unavailable" }
      : { success: true });

    studio.handleInput("\r");

    expect(previewTheme).toHaveBeenNthCalledWith(1, "dark");
    expect(previewTheme).toHaveBeenNthCalledWith(2, "light");
    expect(studio.render(80).join("\n")).toContain("Tokyo Night Light");
  });

  it("previews Status Icons changes immediately", () => {
    const { config, onConfigChange, studio } = makeStudio();

    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[B");
    studio.handleInput("\r");

    expect(config.get().iconMode).toBe("ascii");
    expect(studio.render(80).join("\n")).toContain("Status Icons: ASCII");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "iconMode",
    });
  });

  it("previews Interface Frame changes immediately", () => {
    const { config, onConfigChange, studio } = makeStudio();

    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[B");
    studio.handleInput("\r");

    expect(config.get().editorFrame).toBe(false);
    const output = studio.render(80).join("\n");
    expect(output).toContain("Interface Frame: Off");
    expect(output).not.toMatch(/[╭╮╰╯│]/);
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "editorFrame",
    });
  });

  it("previews Top Panel changes in memory without persisting early", () => {
    const { config, onConfigChange, studio, tui, write } = makeStudio();

    studio.handleInput("\x1b[B");
    studio.handleInput("\r");

    expect(config.get().panel).toBe(false);
    expect(studio.render(80).join("\n")).toContain("Top Panel: Off");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "panel",
    });
    expect(write).not.toHaveBeenCalled();
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
  });

  it("switches Rain Mode between Auto and Manual", () => {
    const { config, onConfigChange, studio } = makeStudio();

    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\t");
    expect(studio.render(80).join("\n")).toContain("Rain Mode: Auto");

    studio.handleInput("\r");

    expect(config.get().rainMode).toBe("manual");
    expect(studio.render(80).join("\n")).toContain("Rain Mode: Manual");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "rainMode",
    });
  });

  it("adjusts Max Rain Drops in steps of five", () => {
    const { config, onConfigChange, studio } = makeStudio();
    config.set("rainMode", "manual");

    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[C");

    expect(config.get().maxRainDrops).toBe(30);
    expect(studio.render(80).join("\n")).toContain("Max Rain Drops: 30");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "maxRainDrops",
    });
  });

  it("adjusts Rain Tick in 10ms steps", () => {
    const { config, onConfigChange, studio } = makeStudio();
    config.set("rainMode", "manual");

    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[C");

    expect(config.get().rainTickMs).toBe(140);
    expect(studio.render(80).join("\n")).toContain("Rain Tick (ms): 140");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "rainTickMs",
    });
  });

  it("adjusts Rain Rows with arrow keys and previews the value", () => {
    const { config, onConfigChange, studio } = makeStudio();

    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\x1b[B");
    studio.handleInput("\x1b[C");

    expect(config.get().rainRows).toBe(4);
    expect(studio.render(80).join("\n")).toContain("Rain Rows: 4");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "rainRows",
    });
  });

  it("previews Kimi Limit changes from the Usage section", () => {
    const { config, onConfigChange, studio } = makeStudio();

    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\x1b[B");
    studio.handleInput("\r");

    expect(config.get().kimiQuota).toBe(false);
    expect(studio.render(80).join("\n")).toContain("Kimi Limit: Off");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "kimiQuota",
    });
  });

  it("previews Codex Limit changes from the Usage section", () => {
    const { config, onConfigChange, studio } = makeStudio();

    studio.handleInput("\t");
    studio.handleInput("\t");
    studio.handleInput("\r");

    expect(config.get().codexQuota).toBe(true);
    expect(studio.render(80).join("\n")).toContain("Codex Limit: On");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "codexQuota",
    });
  });

  it("toggles a status module live without persisting early", () => {
    const { config, onConfigChange, studio, write } = makeStudio();

    studio.handleInput("\t");
    studio.handleInput("\r");

    expect(config.get().statusModules.model).toBe(false);
    expect(studio.render(80).join("\n")).toContain("Model: Off");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "status",
      key: "model",
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("switches to Status with Tab and lists every status module", () => {
    const { studio, tui } = makeStudio();

    studio.handleInput("\t");
    const output = studio.render(80).join("\n");

    expect(output).toContain("[Status]");
    expect(output).toContain("Model");
    expect(output).toContain("Thinking");
    expect(output).toContain("Path");
    expect(output).toContain("Git Branch");
    expect(output).toContain("Provider Limit");
    expect(output).toContain("Tokens");
    expect(output).toContain("Cost");
    expect(output).toContain("Context");
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });
});
