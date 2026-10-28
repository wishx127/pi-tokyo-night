import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { UsageHistory } from "../analytics/usage-history";
import { TokyoConfigManager } from "../core/config";
import { NeonStudioComponent } from "./neon-studio";
import {
  NeonStudioController,
  type NeonStudioThemeChoice,
  type NeonStudioThemeResult,
} from "./neon-studio-controller";

const { getAgentDir } = vi.hoisted(() => ({ getAgentDir: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  getAgentDir,
}));

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;]*m/g, "");

function observeUsageRecords(records: UsageHistory["records"]) {
  let reads = 0;
  return {
    records: new Proxy(records, {
      get(target, property, receiver) {
        if (
          property === Symbol.iterator ||
          (typeof property === "string" && /^\d+$/.test(property))
        ) reads++;
        return Reflect.get(target, property, receiver);
      },
    }),
    get reads() { return reads; },
    reset() { reads = 0; },
  };
}

function makeStudio(options: {
  mode?: "regular" | "fullscreen";
  renderFullscreenStatus?: (width: number) => string[];
  previewThemes?: Partial<Record<"dark" | "light", Theme>>;
  initialThemeChoice?: NeonStudioThemeChoice;
  persistedThemeChoice?: NeonStudioThemeChoice;
  getTheme?: () => Theme;
  getAutomaticTheme?: () => Theme | undefined;
  loadUsageHistory?: (signal: AbortSignal) => Promise<UsageHistory | null>;
  studioTheme?: Theme;
} = {}) {
  const config = new TokyoConfigManager();
  const write = vi.spyOn(config, "write").mockResolvedValue(true);
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
  const studioTheme = options.studioTheme ?? theme;
  const studio = new NeonStudioComponent(tui, studioTheme, controller, {
    renderFullscreenStatus: options.renderFullscreenStatus,
    previewThemes: options.previewThemes ?? { dark: studioTheme, light: studioTheme },
    getTheme: options.getTheme,
    getAutomaticTheme: options.getAutomaticTheme,
    loadUsageHistory: options.loadUsageHistory,
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

function makePersistingStudio() {
  const config = new TokyoConfigManager();
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const done = vi.fn();
  const notify = vi.fn();
  const errorSink = vi.fn();
  const onConfigChange = vi.fn();
  const saveTheme = vi.fn((): NeonStudioThemeResult => ({ success: true }));
  const restoreTheme = vi.fn((): NeonStudioThemeResult => ({ success: true }));
  const controller = new NeonStudioController({
    config, done, notify, errorSink, onConfigChange,
    previewTheme: () => ({ success: true }),
    saveTheme, restoreTheme,
    initialThemeChoice: "dark",
    persistedThemeChoice: "dark",
  });
  const studio = new NeonStudioComponent(tui, theme, controller);
  return { config, controller, done, notify, errorSink, onConfigChange, saveTheme, restoreTheme, studio, tui };
}

describe("Neon Studio asynchronous persistence", () => {
  let agentDirectory: string;
  beforeEach(() => {
    agentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tokyo-night-studio-"));
    getAgentDir.mockReturnValue(agentDirectory);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(agentDirectory, { recursive: true, force: true });
  });

  it("upgrades a pending close to force-close without another save or a theme commit", async () => {
    let releaseSave!: () => void;
    const released = new Promise<void>((resolve) => { releaseSave = resolve; });
    let observeSave!: () => void;
    const started = new Promise<void>((resolve) => { observeSave = resolve; });
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementationOnce(async (from, to) => {
      observeSave();
      await released;
      await rename(from, to);
    });
    const { config, controller, done, saveTheme, restoreTheme } = makePersistingStudio();
    controller.changeSetting("appearance", 0);
    controller.changeSetting("appearance", 1);
    const close = controller.saveAndClose();
    await started;
    try {
      expect(done).not.toHaveBeenCalled();
      expect(saveTheme).not.toHaveBeenCalled();
      expect(controller.changeSetting("rain", 0)).toBe(false);
      expect(controller.saveAndClose()).toBe(close);
      expect(controller.pendingClose).toBe(close);
      const forced = controller.forceClose();
      releaseSave();
      await forced;
      await close;
      expect(done).toHaveBeenCalledOnce();
      expect(saveTheme).not.toHaveBeenCalled();
      expect(restoreTheme).toHaveBeenCalledOnce();
      expect(config.get().panel).toBe(false);
      expect(JSON.parse(fs.readFileSync(
        path.join(agentDirectory, "extensions", "pi-tokyo-night.json"), "utf8",
      ))).toMatchObject({ panel: false });
      await controller.forceClose();
      await expect(controller.saveAndClose()).resolves.toBe(true);
      expect(done).toHaveBeenCalledOnce();
      expect(fs.promises.rename).toHaveBeenCalledOnce();
    } finally {
      releaseSave();
      await close;
      await config.read();
    }
  });

  it("keeps Studio open after a failed save and lets the user retry", async () => {
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("rename failed"));
    const { controller, done, notify, errorSink, studio, tui } = makePersistingStudio();
    studio.handleInput("\x1b");
    await expect(controller.saveAndClose()).resolves.toBe(false);
    expect(done).not.toHaveBeenCalled();
    expect(errorSink).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "Could not save Tokyo Night settings. Neon Studio remains open.", "error",
    );
    expect(tui.requestRender).toHaveBeenCalledOnce();
    expect(controller.changeSetting("appearance", 1)).toBe(true);

    studio.handleInput("\x1b");
    await expect(controller.saveAndClose()).resolves.toBe(true);
    expect(done).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(
      path.join(agentDirectory, "extensions", "pi-tokyo-night.json"), "utf8",
    ))).toMatchObject({ panel: false });
  });

  it("force-closes when a failed save notification queues shutdown before close completion", async () => {
    const rename = vi.spyOn(fs.promises, "rename")
      .mockRejectedValueOnce(new Error("rename failed"));
    const { config, controller, done, notify, saveTheme, restoreTheme } = makePersistingStudio();
    const openingConfig = config.get();
    controller.changeSetting("appearance", 1);
    let forced: Promise<void> | undefined;
    notify.mockImplementationOnce(() => {
      queueMicrotask(() => { forced = controller.forceClose(); });
    });

    await expect(controller.saveAndClose()).resolves.toBe(false);
    expect(forced).toBeDefined();
    await forced;

    expect(done).toHaveBeenCalledOnce();
    expect(config.get()).toEqual(openingConfig);
    expect(rename).toHaveBeenCalledOnce();
    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(saveTheme).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(agentDirectory, "extensions"))).toEqual([]);
    await controller.forceClose();
    await expect(controller.saveAndClose()).resolves.toBe(false);
    expect(done).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledOnce();
  });

  it("does not redraw a disposed Studio when its pending save fails", async () => {
    let releaseSave!: () => void;
    const released = new Promise<void>((resolve) => { releaseSave = resolve; });
    let observeSave!: () => void;
    const started = new Promise<void>((resolve) => { observeSave = resolve; });
    vi.spyOn(fs.promises, "rename").mockImplementationOnce(async () => {
      observeSave();
      await released;
      throw new Error("rename failed");
    });
    const { controller, done, studio, tui } = makePersistingStudio();
    studio.handleInput("\x1b");
    const close = controller.saveAndClose();
    await started;
    studio.dispose();
    releaseSave();
    await expect(close).resolves.toBe(false);
    studio.handleInput("\t");

    expect(done).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });
});

describe("NeonStudioComponent", () => {
  it("force-closes after a failed save and reapplies changed runtime settings from the opening snapshot", async () => {
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

    write.mockResolvedValue(false);

    await controller.forceClose();

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

  it("delegates force-close rollback even when the selected choice did not change", async () => {
    const { controller, restoreTheme } = makeStudio({
      initialThemeChoice: "automatic",
      persistedThemeChoice: "automatic",
    });

    await controller.forceClose();

    expect(restoreTheme).toHaveBeenCalledOnce();
  });

  it("force-closes during shutdown without saving the theme when config persistence fails", async () => {
    const { controller, done, notify, restoreTheme, saveTheme, studio, write } = makeStudio();
    studio.handleInput("\r");
    write.mockResolvedValue(false);
    saveTheme.mockImplementation(() => {
      throw new Error("theme save failed");
    });
    notify.mockImplementation(() => {
      throw new Error("stale notify");
    });

    await expect(controller.forceClose()).resolves.toBeUndefined();

    expect(saveTheme).not.toHaveBeenCalled();
    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });

  it("restores the opening Theme instead of committing a preview when force-closed", async () => {
    const { controller, done, restoreTheme, saveTheme, studio } = makeStudio();
    studio.handleInput("\r");

    await controller.forceClose();

    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(saveTheme).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("restores a temporary opening Theme even when the preview matches the persisted choice", async () => {
    const { controller, restoreTheme, saveTheme, studio } = makeStudio({
      initialThemeChoice: "light",
      persistedThemeChoice: "dark",
    });
    studio.handleInput("\r");
    studio.handleInput("\r");

    await controller.forceClose();

    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(saveTheme).not.toHaveBeenCalled();
  });

  it("stays open and restores the opening Theme when configuration persistence fails", async () => {
    const { done, errorSink, notify, restoreTheme, studio, tui, write } = makeStudio();
    studio.handleInput("\r");
    vi.mocked(tui.requestRender).mockClear();
    write.mockImplementationOnce(async (sink) => {
      expect(sink).toBe(errorSink);
      sink!(new Error("rename failed"), "writeTokyoConfig");
      return false;
    });

    studio.handleInput("\x1b");
    await new Promise<void>((resolve) => setImmediate(resolve));

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

  it("renders every Studio section and the active Appearance settings", () => {
    const { studio } = makeStudio();

    const lines = studio.render(80);
    const output = lines.join("\n");

    expect(output).toContain("Neon Studio");
    expect(output).toContain("Appearance");
    expect(output).toContain("Status");
    expect(output).toContain("Usage");
    expect(output).toContain("Rain");
    expect(output).not.toContain("Dashboard");
    expect(output).toContain("Theme");
    expect(output).toContain("Top Panel");
    expect(output).toContain("Interface Frame");
    expect(output).toContain("Status Icons");
    expect(output).toContain(
      "Detect current terminal colors now; restart Pi to keep Automatic",
    );
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("uses Usage for historical trends and switches between natural-day ranges", async () => {
    const now = Date.now();
    const loadUsageHistory = vi.fn(async (): Promise<UsageHistory> => ({
      records: [
        { timestamp: now, provider: "openai", model: "gpt", tokens: 120 },
        { timestamp: now - 6 * 24 * 60 * 60 * 1000, provider: "anthropic", model: "claude", tokens: 60 },
      ],
    }));
    const { studio } = makeStudio({ loadUsageHistory });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    expect(studio.render(80).join("\n")).toContain("[Usage]");
    expect(studio.render(80).join("\n")).toContain("Loading historical usage");

    await vi.waitFor(() => expect(loadUsageHistory).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(studio.render(80).join("\n")).toContain("openai/gpt");
    });

    expect(studio.render(80).join("\n")).toContain("3 Days");
    studio.handleInput("\x1b[C");
    expect(studio.render(80).join("\n")).toContain("7 Days");
  });

  it("reuses historical records across rendering and legend interactions", async () => {
    const now = new Date(2026, 2, 10, 12);
    const observed = observeUsageRecords([
      { timestamp: now.getTime(), provider: "openai", model: "gpt", tokens: 100 },
      { timestamp: now.getTime(), provider: "anthropic", model: "claude", tokens: 50 },
    ]);
    let activeTheme = theme;
    const loadUsageHistory = vi.fn(async () => ({
      collectedAt: now.getTime(),
      records: observed.records,
    }));
    const { studio } = makeStudio({
      getTheme: () => activeTheme,
      loadUsageHistory,
    });
    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await Promise.resolve();

    const initial = studio.render(100);
    expect(initial.join("\n")).toContain("Total tokens  150");
    expect(observed.reads).toBeGreaterThan(0);
    observed.reset();

    expect(studio.render(100)).toEqual(initial);
    expect(studio.render(36).every((line) => visibleWidth(line) <= 36)).toBe(true);
    studio.invalidate();
    expect(studio.render(100)).toEqual(initial);
    studio.handleInput("\x1b[B");
    expect(studio.render(100).join("\n")).toContain("▸ ● anthropic/claude");
    studio.handleInput("\r");
    const hidden = studio.render(100).join("\n");
    expect(hidden).toContain("▸ ○ anthropic/claude");
    expect(hidden).toContain("Total tokens  150");
    expect(hidden).toContain("100 ┤");
    studio.handleInput(" ");
    expect(studio.render(100).join("\n")).toContain("▸ ● anthropic/claude");
    studio.handleInput("\x1b[A");
    expect(studio.render(100).join("\n")).toContain("▸ ● openai/gpt");

    activeTheme = { fg: (_role: string, text: string) => text.toUpperCase() } as Theme;
    expect(studio.render(100).join("\n")).toContain("TOTAL TOKENS  150");
    activeTheme = theme;
    for (let index = 0; index < 4; index++) studio.handleInput("\t");
    expect(studio.render(100)).toEqual(initial);
    expect(loadUsageHistory).toHaveBeenCalledOnce();
    expect(observed.reads).toBe(0);
    studio.dispose();
  });

  it("recomputes history when switching ranges and keeps only the latest summary", async () => {
    const now = new Date(2026, 2, 10, 12);
    const observed = observeUsageRecords([
      { timestamp: now.getTime(), provider: "openai", model: "gpt", tokens: 100 },
      { timestamp: new Date(2026, 2, 4, 12).getTime(), provider: "openai", model: "gpt", tokens: 20 },
      { timestamp: new Date(2026, 1, 20, 12).getTime(), provider: "openai", model: "gpt", tokens: 30 },
      { timestamp: new Date(2026, 0, 1, 12).getTime(), provider: "openai", model: "gpt", tokens: 40 },
    ]);
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({ collectedAt: now.getTime(), records: observed.records }),
    });
    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await Promise.resolve();

    for (const [index, { label, total }] of [
      { label: "3 Days", total: 100 },
      { label: "7 Days", total: 120 },
      { label: "30 Days", total: 150 },
      { label: "All", total: 190 },
      { label: "3 Days", total: 100 },
    ].entries()) {
      if (index > 0) studio.handleInput("\x1b[C");
      const output = studio.render(100);
      expect(output.join("\n")).toContain(`[${label}]`);
      expect(output.join("\n")).toContain(`Total tokens  ${total}`);
      expect(observed.reads).toBeGreaterThan(0);
      observed.reset();
      expect(studio.render(100)).toEqual(output);
      expect(observed.reads).toBe(0);
    }
    studio.dispose();
  });

  it.each([undefined, NaN, Infinity, -Infinity])(
    "refreshes the current-day fallback across midnight for collectedAt=%s",
    async (collectedAt) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(2026, 2, 10, 12));
        const observed = observeUsageRecords([
          { timestamp: new Date(2026, 2, 8, 12).getTime(), provider: "openai", model: "gpt", tokens: 120 },
          { timestamp: new Date(2026, 2, 10, 12).getTime(), provider: "openai", model: "gpt", tokens: 60 },
        ]);
        const { studio } = makeStudio({
          loadUsageHistory: async () => ({ collectedAt, records: observed.records }),
        });
        for (let index = 0; index < 2; index++) studio.handleInput("\t");
        await Promise.resolve();

        const initial = studio.render(100);
        expect(initial.join("\n")).toContain("Total tokens  180");
        expect(initial.join("\n")).toContain("Mar 8");
        expect(initial.join("\n")).toContain("Mar 10");
        expect(observed.reads).toBeGreaterThan(0);
        observed.reset();
        vi.setSystemTime(new Date(2026, 2, 10, 23, 59));
        expect(studio.render(100)).toEqual(initial);
        expect(observed.reads).toBe(0);

        vi.setSystemTime(new Date(2026, 2, 11, 0, 1));
        const nextDay = studio.render(100);
        expect(nextDay.join("\n")).toContain("Total tokens  60");
        expect(nextDay.join("\n")).toContain("Mar 9");
        expect(nextDay.join("\n")).toContain("Mar 11");
        expect(observed.reads).toBeGreaterThan(0);
        observed.reset();
        expect(studio.render(100)).toEqual(nextDay);
        expect(observed.reads).toBe(0);
        studio.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([new Date(2026, 2, 10, 12).getTime(), 0])(
    "keeps the scan-day summary across midnight for collectedAt=%s",
    async (collectedAt) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(2026, 2, 10, 23, 59));
        const observed = observeUsageRecords([
          { timestamp: collectedAt, provider: "openai", model: "gpt", tokens: 80 },
        ]);
        const { studio } = makeStudio({
          loadUsageHistory: async () => ({ collectedAt, records: observed.records }),
        });
        for (let index = 0; index < 2; index++) studio.handleInput("\t");
        await Promise.resolve();

        const initial = studio.render(100);
        expect(initial.join("\n")).toContain("Total tokens  80");
        expect(initial.join("\n")).toContain(new Date(collectedAt).toLocaleDateString("en-US", {
          month: "short", day: "numeric",
        }));
        expect(observed.reads).toBeGreaterThan(0);
        observed.reset();
        vi.setSystemTime(new Date(2026, 2, 11, 0, 1));
        expect(studio.render(100)).toEqual(initial);
        expect(observed.reads).toBe(0);
        studio.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reuses empty history while keeping the empty dashboard and input behavior", async () => {
    const observed = observeUsageRecords([]);
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({ collectedAt: Date.now(), records: observed.records }),
    });
    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await Promise.resolve();
    const initial = studio.render(100);
    expect(initial.join("\n")).toContain("No usage data for this period");
    expect(observed.reads).toBeGreaterThan(0);
    observed.reset();

    studio.invalidate();
    studio.handleInput("\x1b[B");
    studio.handleInput("\r");
    expect(studio.render(100)).toEqual(initial);
    expect(observed.reads).toBe(0);
    studio.dispose();
  });

  it("keeps provider limit settings in Status instead of Usage", async () => {
    const loadUsageHistory = vi.fn(async (): Promise<UsageHistory> => ({
      records: [{
        timestamp: Date.now(),
        provider: "openai",
        model: "gpt",
        tokens: 10,
      }],
    }));
    const { config, studio } = makeStudio({ loadUsageHistory });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(80).join("\n")).toContain("openai/gpt");
    });

    studio.handleInput("\r");
    const output = studio.render(80).join("\n");

    expect(output).not.toContain("Codex Limit");
    expect(output).not.toContain("Kimi Limit");
    expect(config.get().codexQuota).toBe(false);
    expect(config.get().kimiQuota).toBe(true);
  });

  it("labels Escape as exit and closes Usage", async () => {
    const { done, studio } = makeStudio({
      loadUsageHistory: async () => new Promise(() => {}),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    const output = studio.render(80).join("\n");
    expect(output).toContain("Esc exit");
    expect(output).not.toContain("Esc save");

    studio.handleInput("\x1b");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toHaveBeenCalledOnce();
  });

  it("renders readable Y-axis ticks and dashboard labels", async () => {
    const now = Date.now();
    const studioTheme = {
      fg: vi.fn((_role: string, text: string) => text),
    } as unknown as Theme;
    const { studio } = makeStudio({
      studioTheme,
      loadUsageHistory: async () => ({
        records: [
          { timestamp: now, provider: "openai", model: "gpt", tokens: 160 },
          { timestamp: now, provider: "anthropic", model: "claude", tokens: 40 },
        ],
      }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(100).join("\n")).toContain("openai/gpt");
    });

    const output = studio.render(100).join("\n");
    expect(output).toContain("160 ┤");
    expect(output).toContain("80 ┤");
    expect(output).toContain("0 ┤");
    expect(output).not.toContain("╌");
    expect(output).toContain("Total tokens  200");
    expect(output).toContain("Calculation: input + output + cache write");
    expect(output).not.toContain("fresh ·");
    expect(output).toContain("Model distribution");
    expect(output).not.toContain("TOKEN PULSE");
    expect(output).not.toContain("MODEL SERIES");
    expect(output).not.toContain("TOTAL TOKENS");
    expect(output).not.toContain("MODEL DISTRIBUTION");
    expect(output).not.toContain("● Total");
    expect(output).toContain("▸ ● openai/gpt");

    const modelVisualRoles = new Set(
      vi.mocked(studioTheme.fg).mock.calls
        .map(([role]) => role)
        .filter((role) => ["thinkingLow", "thinkingMedium", "success", "warning"].includes(role)),
    );
    expect(modelVisualRoles.size).toBeGreaterThan(0);
  });

  it("shows Top 5 model series, three date ticks, and filters lines without changing Y scale", async () => {
    const now = new Date(2026, 2, 10, 12);
    const records = [100, 90, 80, 70, 60, 50].map((tokens, index) => ({
      timestamp: now.getTime(),
      provider: "openai",
      model: `model-${index + 1}`,
      tokens,
    }));
    const studioTheme = {
      fg: vi.fn((_role: string, text: string) => text),
    } as unknown as Theme;
    const { studio } = makeStudio({
      studioTheme,
      loadUsageHistory: async () => ({ collectedAt: now.getTime(), records }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(100).join("\n")).toContain("openai/model-1");
    });
    studio.handleInput("\x1b[C");

    let output = studio.render(100).join("\n");
    expect(output).toContain("openai/model-5");
    expect(output).not.toContain("openai/model-6");
    expect(output).not.toContain("Other");
    expect(output).toContain(new Date(2026, 2, 4).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    expect(output).toContain(new Date(2026, 2, 7).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    expect(output).toContain(new Date(2026, 2, 10).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    const seriesColors = new Set(
      vi.mocked(studioTheme.fg).mock.calls
        .map(([role]) => role)
        .filter((role) => ["thinkingLow", "syntaxFunction", "success", "warning", "thinkingXhigh"].includes(role)),
    );
    expect(seriesColors).toEqual(new Set([
      "thinkingLow",
      "syntaxFunction",
      "success",
      "warning",
      "thinkingXhigh",
    ]));

    const compactOutput = studio.render(26).join("\n");
    expect(compactOutput).toContain(new Date(2026, 2, 4).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    expect(compactOutput).toContain(new Date(2026, 2, 10).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    expect(compactOutput).not.toContain(new Date(2026, 2, 7).toLocaleDateString("en-US", { month: "short", day: "numeric" }));

    const narrowOutput = studio.render(20).join("\n");
    expect(narrowOutput).toContain(new Date(2026, 2, 4).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    expect(narrowOutput).toContain(new Date(2026, 2, 10).toLocaleDateString("en-US", { month: "short", day: "numeric" }));

    studio.handleInput("\r");
    output = studio.render(100).join("\n");
    expect(output).toContain("○ openai/model-1");
    expect(output).toContain("100 ┤");

    studio.handleInput("\x1b[B");
    studio.handleInput("\r");
    output = studio.render(100).join("\n");
    expect(output).toContain("○ openai/model-2");
    expect(output).toContain("100 ┤");

    studio.handleInput("a");
    studio.handleInput("\x1b[97u");
    output = studio.render(100).join("\n");
    expect(output).toContain("100 ┤");
    expect(output).toContain("○ openai/model-1");
    expect(output).toContain("○ openai/model-2");
    expect(output).not.toContain("a all");
  });

  it("resets hidden Top 5 series when the time range changes", async () => {
    const now = Date.now();
    const records = [100, 90, 80, 70, 60, 50].map((tokens, index) => ({
      timestamp: now,
      provider: "openai",
      model: `model-${index + 1}`,
      tokens,
    }));
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({ collectedAt: now, records }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(100).join("\n")).toContain("openai/model-1");
    });
    studio.handleInput("\r");
    expect(studio.render(100).join("\n")).toContain("○ openai/model-1");

    studio.handleInput("\x1b[C");

    const output = studio.render(100).join("\n");
    expect(output).toContain("● openai/model-1");
    expect(output).not.toContain("Other");
  });

  it("offers All without a Total chart series", async () => {
    const now = new Date(2026, 2, 10, 12);
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({
        collectedAt: now.getTime(),
        records: [
          { timestamp: new Date(2025, 0, 1, 8).getTime(), provider: "openai", model: "old-model", tokens: 40 },
          { timestamp: now.getTime(), provider: "openai", model: "new-model", tokens: 60 },
        ],
      }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(100).join("\n")).toContain("new-model");
    });
    for (let index = 0; index < 3; index++) studio.handleInput("\x1b[C");

    const output = studio.render(100).join("\n");
    expect(output).toContain("[All]");
    expect(output).not.toContain("[All Conversations]");
    expect(output).toContain("old-model");
    expect(output).not.toContain("● Total");
    expect(output).not.toContain("○ Total");
  });

  it("shows a single All Conversations date label when history is only one day", async () => {
    const now = new Date(2026, 2, 10, 12);
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({
        collectedAt: now.getTime(),
        records: [{ timestamp: now.getTime(), provider: "openai", model: "gpt", tokens: 60 }],
      }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(100).join("\n")).toContain("gpt");
    });
    for (let index = 0; index < 3; index++) studio.handleInput("\x1b[C");

    const label = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const output = studio.render(100).join("\n");
    expect(output.split(label).length - 1).toBe(1);
  });

  it("uses the history scan time as its natural-day boundary", async () => {
    const collectedAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({
        collectedAt,
        records: [{
          timestamp: collectedAt,
          provider: "openai",
          model: "gpt",
          tokens: 120,
        }],
      }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(80).join("\n")).toContain("openai/gpt");
    });
  });

  it("cancels a pending history scan when leaving Usage", () => {
    let scanSignal: AbortSignal | undefined;
    const { studio } = makeStudio({
      loadUsageHistory: (signal) => {
        scanSignal = signal;
        return new Promise(() => {});
      },
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    expect(scanSignal?.aborted).toBe(false);

    studio.handleInput("\t");

    expect(scanSignal?.aborted).toBe(true);
  });

  it("shows an explicit empty state when the selected Usage period has no usage", async () => {
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({ records: [] }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(80).join("\n")).not.toContain("Loading historical usage");
    });

    expect(studio.render(80).join("\n")).toContain("No usage data for this period");
  });

  it("keeps the loaded Usage chart within the terminal width", async () => {
    const now = Date.now();
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({
        records: [
          { timestamp: now, provider: "openai", model: "gpt", tokens: 120 },
          { timestamp: now - 24 * 60 * 60 * 1000, provider: "anthropic", model: "claude", tokens: 40 },
        ],
      }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(80).join("\n")).toContain("openai/gpt");
    });

    for (const width of [0, 1, 2, 5, 20, 80]) {
      expect(studio.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("keeps a compact chart axis visible on an extremely narrow terminal", async () => {
    const { studio } = makeStudio({
      loadUsageHistory: async () => ({
        records: [{
          timestamp: Date.now(),
          provider: "openai",
          model: "gpt",
          tokens: 120,
        }],
      }),
    });

    for (let index = 0; index < 2; index++) studio.handleInput("\t");
    await vi.waitFor(() => {
      expect(studio.render(80).join("\n")).toContain("openai/gpt");
    });

    const lines = studio.render(5);
    expect(lines.join("\n")).toContain("┤");
    expect(lines.every((line) => visibleWidth(line) <= 5)).toBe(true);
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

  it("does not save a theme when the selection was not changed", async () => {
    const { done, saveTheme, studio } = makeStudio();

    studio.handleInput("\x1b");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(saveTheme).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("restores the opening Theme when its close-time save fails", async () => {
    const { done, notify, restoreTheme, saveTheme, studio, tui } = makeStudio();
    saveTheme.mockReturnValue({ success: false, error: "theme save failed" });

    studio.handleInput("\r");
    vi.mocked(tui.requestRender).mockClear();
    studio.handleInput("\x1b");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(done).not.toHaveBeenCalled();
    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("theme save failed", "error");
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });

  it("previews Dark locally and commits it only when Escape saves", async () => {
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
    await new Promise<void>((resolve) => setImmediate(resolve));

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

  it("cycles Auto, Manual, and Static rain in both directions", () => {
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
    studio.handleInput("\r");
    expect(config.get().rainMode).toBe("static");
    expect(studio.render(80).join("\n")).toContain("Rain Mode: Static");
    expect(studio.render(80).join("\n")).not.toContain("Rain Tick (ms)");
    studio.handleInput("\r");
    expect(config.get().rainMode).toBe("auto");
    studio.handleInput("\x1b[D");
    expect(config.get().rainMode).toBe("static");
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

    expect(config.get().rainTickMs).toBe(60);
    expect(studio.render(80).join("\n")).toContain("Rain Tick (ms): 60");
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

    expect(config.get().rainRows).toBe(9);
    expect(studio.render(80).join("\n")).toContain("Rain Rows: 9");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "rainRows",
    });
  });

  it("previews Kimi Limit changes from the Status section", () => {
    const { config, onConfigChange, studio } = makeStudio();

    studio.handleInput("\t");
    for (let index = 0; index < 9; index++) studio.handleInput("\x1b[B");
    studio.handleInput("\r");

    expect(config.get().kimiQuota).toBe(false);
    expect(studio.render(80).join("\n")).toContain("Kimi Limit: Off");
    expect(onConfigChange).toHaveBeenCalledWith({
      kind: "config",
      key: "kimiQuota",
    });
  });

  it("previews Codex Limit changes from the Status section", () => {
    const { config, onConfigChange, studio } = makeStudio();

    studio.handleInput("\t");
    for (let index = 0; index < 8; index++) studio.handleInput("\x1b[B");
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
    expect(output).toContain("Codex Limit");
    expect(output).toContain("Kimi Limit");
    expect(output).toContain("Tokens");
    expect(output).toContain("Cost");
    expect(output).toContain("Context");
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });
});
