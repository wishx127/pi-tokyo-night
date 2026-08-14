import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension, {
  buildStatusWidgetLines,
  readPiThemeSetting,
  shouldRunRainAnimation,
  TOKYO_NIGHT_AUTOMATIC_THEME_SETTING,
  type PiThemeSettingResult,
  writePiThemeSetting,
} from "./extension";
import { TokyoConfigManager } from "./core/config";

const theme = { name: "existing-theme", fg: (_color: string, text: string) => text } as any;
const tokyoDarkTheme = { name: "tokyo-night-dark", fg: theme.fg } as any;
const tokyoLightTheme = { name: "tokyo-night-light", fg: theme.fg } as any;

type Mode = "tui" | "rpc" | "json" | "print";

function makeFixture(
  mode: Mode = "tui",
  sessionId = "session-1",
  initialThemeSetting = TOKYO_NIGHT_AUTOMATIC_THEME_SETTING,
) {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const widgets = new Map<string, any>();
  let editorFactory: any;
  let footerFactory: any;
  let customComponent: any;
  let customTuiMode: "regular" | "fullscreen" = "regular";
  const ui = {
    setWidget: vi.fn((key: string, content: unknown) => {
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, content);
    }),
    setEditorComponent: vi.fn((factory: unknown) => { editorFactory = factory; }),
    getEditorComponent: vi.fn(() => editorFactory),
    setFooter: vi.fn((factory: unknown) => { footerFactory = factory; }),
    setWorkingVisible: vi.fn(),
    setWorkingMessage: vi.fn(),
    theme,
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    getTheme: vi.fn((name: string) =>
      name === "tokyo-night-dark"
        ? tokyoDarkTheme
        : name === "tokyo-night-light"
          ? tokyoLightTheme
          : name === "existing-theme"
            ? theme
            : undefined),
    setTheme: vi.fn(() => ({ success: true })),
    custom: vi.fn((factory: (...args: any[]) => unknown) =>
      new Promise((resolve, reject) => {
        const done = (value: unknown) => resolve(value);
        Promise.resolve(
          factory(
            { requestRender: vi.fn(), mode: customTuiMode },
            theme,
            {},
            done,
          ),
        ).then((component) => {
          customComponent = component;
        }, reject);
      })),
  } as any;
  const ctx = {
    ui,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/workspace/project",
    model: undefined,
    modelRegistry: { getApiKeyForProvider: vi.fn(async () => undefined) },
    sessionManager: {
      getBranch: () => [],
      getLeafId: () => "leaf-1",
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
    },
    getContextUsage: () => undefined,
    isIdle: vi.fn(() => true),
  } as any;
  let command: any;
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: vi.fn((_name: string, value: unknown) => { command = value; }),
    getThinkingLevel: () => "high",
    exec: vi.fn(async () => ({ code: 0, stdout: "main\n", stderr: "" })),
  } as any;
  let themeSetting = initialThemeSetting;
  const readPiThemeSetting = vi.fn(() => themeSetting);
  const writePiThemeSetting = vi.fn(
    (nextThemeSetting: string): PiThemeSettingResult => {
      themeSetting = nextThemeSetting;
      return { success: true };
    },
  );
  extension(pi, {
    readPiThemeSetting,
    writePiThemeSetting,
  });
  return {
    ui, ctx, pi, widgets, readPiThemeSetting, writePiThemeSetting,
    get editorFactory() { return editorFactory; },
    get footerFactory() { return footerFactory; },
    get customComponent() { return customComponent; },
    setCustomTuiMode(mode: "regular" | "fullscreen") { customTuiMode = mode; },
    command,
    async emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(() => {});
  vi.spyOn(TokyoConfigManager.prototype, "write").mockReturnValue(true);
});

describe("Pi theme settings persistence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tokyo-night-theme-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads and updates only the global theme setting", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    const original = {
      theme: "tokyo-night-dark",
      defaultProvider: "openai",
      nested: { keep: true },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original), "utf-8");

    expect(readPiThemeSetting(tempDir)).toBe("tokyo-night-dark");
    expect(
      writePiThemeSetting(TOKYO_NIGHT_AUTOMATIC_THEME_SETTING, tempDir),
    ).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({
      ...original,
      theme: TOKYO_NIGHT_AUTOMATIC_THEME_SETTING,
    });
  });

  it("creates settings.json when it does not exist", () => {
    const agentDir = path.join(tempDir, "nested", "agent");

    expect(
      writePiThemeSetting(TOKYO_NIGHT_AUTOMATIC_THEME_SETTING, agentDir),
    ).toEqual({ success: true });
    expect(JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"),
    )).toEqual({ theme: TOKYO_NIGHT_AUTOMATIC_THEME_SETTING });
  });

  it("does not overwrite malformed settings.json", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    const malformed = "{ not-json";
    fs.writeFileSync(settingsPath, malformed, "utf-8");

    const result = writePiThemeSetting(
      TOKYO_NIGHT_AUTOMATIC_THEME_SETTING,
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(malformed);
  });

  it("returns no configured theme for missing or malformed settings", () => {
    expect(readPiThemeSetting(tempDir)).toBeUndefined();
    fs.writeFileSync(path.join(tempDir, "settings.json"), "[]", "utf-8");
    expect(readPiThemeSetting(tempDir)).toBeUndefined();
  });
});

describe("public layout and lifecycle contract", () => {
  it("keeps narrow status output bounded without selector-specific state", () => {
    for (const width of [0, 1, 2, 9]) {
      expect(() => buildStatusWidgetLines(width, "status")).not.toThrow();
    }
  });

  it("renders Status as the shared frame bottom segment", () => {
    const lines = buildStatusWidgetLines(20, "status", true);
    const output = lines.join("\n");

    expect(output).not.toContain("╭");
    expect(output).toContain("╰");
    expect(lines.at(-1)).toContain("╯");
  });

  it("registers rain permanently above the editor and keeps it through selector replacement", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    expect(fixture.widgets.has("tokyo-rain")).toBe(true);
    expect(fixture.ui.setWidget).toHaveBeenCalledWith("tokyo-rain", expect.any(Function), { placement: "aboveEditor" });
    const tui = { requestRender: vi.fn() };
    const rain = fixture.widgets.get("tokyo-rain")(tui);
    expect(rain.render(40).length).toBeGreaterThan(0);
    // A selector replaces the editor container, not the above-editor widget.
    expect(fixture.widgets.has("tokyo-rain")).toBe(true);
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("hides the separate status widget in fullscreen mode", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const statusFactory = fixture.widgets.get("tokyo-status");
    const tui = { requestRender: vi.fn(), mode: "regular" as "regular" | "fullscreen" };
    const status = statusFactory(tui, theme);

    expect(status.render(40).length).toBeGreaterThan(0);
    tui.mode = "fullscreen";
    expect(status.render(40)).toEqual([]);
    tui.mode = "regular";
    expect(status.render(40).length).toBeGreaterThan(0);
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("composes Rain, Neon Studio, and Status into one regular-mode frame", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const rain = fixture.widgets.get("tokyo-rain")({ requestRender: vi.fn() });
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender: vi.fn(), mode: "regular" },
      theme,
    );
    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());

    const layout = [
      ...rain.render(40),
      ...fixture.customComponent.render(40),
      ...status.render(40),
    ].join("\n");

    expect(layout.match(/╭/g)).toHaveLength(1);
    expect(layout.match(/╰/g)).toHaveLength(1);
    fixture.customComponent.handleInput("\x1b");
    await studio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("reuses fully rendered status lines while semantic inputs stay unchanged", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const renderTheme = { fg: vi.fn((_color: string, text: string) => text) } as any;
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender: vi.fn(), mode: "regular" },
      renderTheme,
    );

    const first = status.render(120);
    const themeCalls = renderTheme.fg.mock.calls.length;
    const cached = status.render(120);

    expect(cached).toBe(first);
    expect(renderTheme.fg).toHaveBeenCalledTimes(themeCalls);

    await vi.advanceTimersByTimeAsync(1000);
    expect(status.render(120)).not.toBe(first);
    expect(renderTheme.fg.mock.calls.length).toBeGreaterThan(themeCalls);
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("refreshes cached status data when the active model changes", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender: vi.fn(), mode: "regular" },
      theme,
    );
    expect(status.render(500).join("\n")).toContain("pi-agent");

    const model = {
      id: "next-model",
      provider: "test-provider",
      api: "test-api",
      contextWindow: 1000,
    } as any;
    const nextContext = { ...fixture.ctx, model };
    await fixture.emit("model_select", { model }, nextContext);

    expect(status.render(500).join("\n")).toContain("next-model");
    await fixture.emit("session_shutdown", { reason: "quit" }, nextContext);
  });

  it("refreshes cached status data when the thinking level changes", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender: vi.fn(), mode: "regular" },
      theme,
    );
    expect(status.render(500).join("\n")).toContain("high");

    fixture.pi.getThinkingLevel = () => "low";
    await fixture.emit("thinking_level_select", { level: "low" }, fixture.ctx);

    expect(status.render(500).join("\n")).toContain("low");
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("keeps status visible while Neon Studio replaces the fullscreen editor", async () => {
    const fixture = makeFixture();
    fixture.setCustomTuiMode("fullscreen");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await Promise.resolve();
    const rain = fixture.widgets.get("tokyo-rain")({ requestRender: vi.fn() });
    const lines = [
      ...rain.render(80),
      ...fixture.customComponent.render(80),
    ];
    const output = lines.join("\n");

    expect(output).toContain("pi-agent");
    expect(output.match(/╭/g)).toHaveLength(1);
    expect(output.match(/╰/g)).toHaveLength(1);
    fixture.customComponent.handleInput("\x1b");
    await studio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("keeps fullscreen local Theme switches off the Status and Git hot path", async () => {
    const fixture = makeFixture();
    fixture.setCustomTuiMode("fullscreen");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());
    fixture.customComponent.render(80);
    await Promise.resolve();
    await Promise.resolve();
    fixture.customComponent.render(80);
    await Promise.resolve();
    fixture.pi.exec.mockClear();
    fixture.ui.setTheme.mockClear();
    fixture.ctx.cwd = "/workspace/changed";

    fixture.customComponent.handleInput("\r");
    fixture.customComponent.render(80);
    await Promise.resolve();

    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    expect(fixture.pi.exec).not.toHaveBeenCalled();
    fixture.customComponent.handleInput("\x1b");
    await studio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("keeps the fullscreen editor/status dock free of empty separator rows", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const tui = {
      requestRender: vi.fn(),
      mode: "fullscreen" as const,
      terminal: { rows: 24, columns: 80 },
    };
    const editor = fixture.editorFactory(tui, { borderColor: (value: string) => value } as any, {} as any);

    const lines = editor.render(40);

    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines).not.toContain("");
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("requests rain redraw through a dynamic host proxy without mutation or recursion", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const regular = { requestRender: vi.fn() };
    const fullscreen = { requestRender: vi.fn() };
    let current = regular;
    const proxy = new Proxy({} as any, {
      get: (_target, property) => (...args: unknown[]) => Reflect.apply(current[property as "requestRender"], current, args),
      set: () => { throw new Error("host method mutation"); },
    });
    const rain = fixture.widgets.get("tokyo-rain")(proxy);
    rain.render(40);
    current = fullscreen;
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    await vi.advanceTimersByTimeAsync(540);
    expect(() => rain.requestRender()).not.toThrow();
    expect(fullscreen.requestRender).toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("auto rain follows Pi activity without clearing the visible frame", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const rainTui = { requestRender: vi.fn() };
    const rain = fixture.widgets.get("tokyo-rain")(rainTui);
    rain.render(80);

    await vi.advanceTimersByTimeAsync(160);
    const idleFrame = rain.render(80).join("\n");
    expect(idleFrame).toContain("`");

    await fixture.emit("agent_start", {}, fixture.ctx);
    const activeFrame = rain.render(80).join("\n");
    expect(activeFrame).toBe(idleFrame);
    await vi.advanceTimersByTimeAsync(159);
    expect(rain.render(80).join("\n")).toBe(activeFrame);
    await vi.advanceTimersByTimeAsync(1);
    const activeTickFrame = rain.render(80).join("\n");
    expect(activeTickFrame).not.toBe(activeFrame);

    await fixture.emit(
      "tool_execution_start",
      { toolCallId: "tool", toolName: "read", args: {} },
      fixture.ctx,
    );
    await vi.advanceTimersByTimeAsync(129);
    expect(rain.render(80).join("\n")).toBe(activeTickFrame);
    await vi.advanceTimersByTimeAsync(1);
    expect(rain.render(80).join("\n")).not.toBe(activeTickFrame);

    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("lets working heartbeat renders carry rain frames without extra rain requests", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const tui = { requestRender: vi.fn() };
    const rain = fixture.widgets.get("tokyo-rain")(tui);
    rain.render(40);
    tui.requestRender.mockClear();

    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    tui.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tui.requestRender).toHaveBeenCalledTimes(10);

    await fixture.emit("agent_end", { type: "agent_end" }, fixture.ctx);
    expect(tui.requestRender).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(130);
    expect(tui.requestRender).toHaveBeenCalledTimes(12);

    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("keeps rain refreshes alive when working UI updates fail", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const tui = { requestRender: vi.fn() };
    fixture.widgets.get("tokyo-rain")(tui).render(40);
    fixture.ui.setWorkingIndicator.mockImplementation(() => {
      throw new Error("This extension instance is stale");
    });
    fixture.ui.setWorkingMessage.mockImplementation(() => {
      throw new Error("This extension ctx is stale");
    });
    tui.requestRender.mockClear();

    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    expect(tui.requestRender).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(tui.requestRender).toHaveBeenCalledTimes(2);

    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("does not patch setWidget and lets another extension register agents", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    fixture.ui.setWidget("agents", ["other extension"]);
    expect(fixture.widgets.get("agents")).toEqual(["other extension"]);
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("cleans only an editor factory it still owns", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const replacement = vi.fn();
    fixture.ui.setEditorComponent(replacement);
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    expect(fixture.ui.getEditorComponent()).toBe(replacement);
  });

  it("restores the built-in footer while it still owns the footer slot", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const footerData = {
      getGitBranch: () => "main",
      onBranchChange: () => () => {},
    } as any;
    fixture.footerFactory({ requestRender: vi.fn() }, theme, footerData);
    fixture.ui.setFooter.mockClear();

    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);

    expect(fixture.ui.setFooter).toHaveBeenCalledWith(undefined);
  });

  it("does not clear a footer after its component has disposed", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const footerData = {
      getGitBranch: () => "main",
      onBranchChange: () => () => {},
    } as any;
    const footer = fixture.footerFactory({ requestRender: vi.fn() }, theme, footerData);
    footer.dispose();
    fixture.ui.setFooter.mockClear();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    expect(fixture.ui.setFooter).not.toHaveBeenCalledWith(undefined);
  });

  it("does not open a second Studio while the first one is active", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const firstStudio = fixture.command.handler("", fixture.ctx);
    await Promise.resolve();
    const firstComponent = fixture.customComponent;
    const secondStudio = fixture.command.handler("", fixture.ctx);
    await Promise.resolve();

    expect(fixture.ui.custom).toHaveBeenCalledOnce();
    expect(fixture.ui.notify).toHaveBeenCalledWith(
      "Neon Studio is already open.",
      "info",
    );
    firstComponent.handleInput("\x1b");
    await firstStudio;
    await secondStudio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("saves and closes an open Studio during session shutdown", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const write = vi.mocked(TokyoConfigManager.prototype.write);
    write.mockClear();

    const studio = fixture.command.handler("", fixture.ctx);
    await Promise.resolve();
    expect(fixture.customComponent).toBeDefined();

    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);

    expect(write).toHaveBeenCalledOnce();
    await studio;
  });

  it("stops Kimi polling when Studio previews Kimi Limit off", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/pi-tokyo-night-test");
    vi.stubEnv("HOME", "/nonexistent/pi-tokyo-night-test");
    const fixture = makeFixture();
    fixture.ctx.model = {
      id: "kimi-for-coding",
      provider: "kimi-coding",
      api: "anthropic-messages",
      contextWindow: 128000,
    };
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(2);

    const studio = fixture.command.handler("", fixture.ctx);
    await Promise.resolve();
    fixture.customComponent.handleInput("\t");
    fixture.customComponent.handleInput("\t");
    fixture.customComponent.handleInput("\x1b[B");
    fixture.customComponent.handleInput("\r");
    await vi.advanceTimersByTimeAsync(33);

    expect(vi.getTimerCount()).toBe(1);
    fixture.customComponent.handleInput("\x1b");
    await studio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the rain animation with the previewed tick interval", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const rainTui = { requestRender: vi.fn() };
    fixture.widgets.get("tokyo-rain")(rainTui).render(80);

    const studio = fixture.command.handler("", fixture.ctx);
    await Promise.resolve();
    fixture.customComponent.handleInput("\t");
    fixture.customComponent.handleInput("\t");
    fixture.customComponent.handleInput("\t");
    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\x1b[B");
    fixture.customComponent.handleInput("\x1b[B");
    fixture.customComponent.handleInput("\x1b[C");
    rainTui.requestRender.mockClear();

    await vi.advanceTimersByTimeAsync(160);
    expect(rainTui.requestRender).toHaveBeenCalledOnce();
    rainTui.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(139);
    expect(rainTui.requestRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rainTui.requestRender).toHaveBeenCalledOnce();

    fixture.customComponent.handleInput("\x1b");
    await studio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the rain animation when Studio previews Top Panel off", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    expect(vi.getTimerCount()).toBe(1);

    const studio = fixture.command.handler("", fixture.ctx);
    await Promise.resolve();
    fixture.customComponent.handleInput("\x1b[B");
    fixture.customComponent.handleInput("\r");
    await vi.advanceTimersByTimeAsync(33);

    expect(vi.getTimerCount()).toBe(0);
    fixture.customComponent.handleInput("\x1b");
    await studio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("redraws the status widget when Studio previews a module change", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const statusTui = { requestRender: vi.fn(), mode: "regular" as const };
    const status = fixture.widgets.get("tokyo-status")(statusTui, theme);
    expect(status.render(500).join("\n")).toContain("pi-agent");

    const studio = fixture.command.handler("", fixture.ctx);
    await Promise.resolve();
    expect(fixture.customComponent).toBeDefined();
    statusTui.requestRender.mockClear();

    fixture.customComponent.handleInput("\t");
    fixture.customComponent.handleInput("\r");
    await vi.advanceTimersByTimeAsync(33);

    expect(statusTui.requestRender).toHaveBeenCalledOnce();
    expect(status.render(500).join("\n")).not.toContain("pi-agent");
    fixture.customComponent.handleInput("\x1b");
    await studio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cycles the three cached theme states without global changes during preview", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());
    expect(fixture.ui.getTheme).toHaveBeenCalledWith("tokyo-night-dark");
    expect(fixture.ui.getTheme).toHaveBeenCalledWith("tokyo-night-light");
    fixture.ui.getTheme.mockClear();

    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\r");

    expect(fixture.ui.getTheme).not.toHaveBeenCalled();
    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    expect(fixture.writePiThemeSetting).not.toHaveBeenCalled();
    expect(fixture.customComponent.render(80).join("\n")).toContain(
      "Theme: Automatic",
    );

    fixture.customComponent.handleInput("\x1b");
    await studio;
    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    expect(fixture.writePiThemeSetting).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Restart Pi"),
      "info",
    );
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("supports local preview when the current Pi Theme is anonymous", async () => {
    const fixture = makeFixture();
    fixture.ui.theme = { fg: theme.fg };
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());
    fixture.customComponent.handleInput("\r");

    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("cannot be safely restored"),
      "error",
    );
    expect(fixture.customComponent.render(80).join("\n")).toContain(
      "Theme: Tokyo Night Dark",
    );

    fixture.customComponent.handleInput("\x1b");
    await studio;
    expect(fixture.ui.setTheme).toHaveBeenCalledOnce();
    expect(fixture.ui.setTheme).toHaveBeenCalledWith("tokyo-night-dark");
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("shows a temporary active theme without persisting it on close", async () => {
    const fixture = makeFixture("tui", "session-1", "tokyo-night-dark");
    fixture.ui.theme = tokyoLightTheme;
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());

    expect(fixture.customComponent.render(80).join("\n")).toContain(
      "Theme: Tokyo Night Light",
    );
    fixture.customComponent.handleInput("\x1b");
    await studio;

    expect(fixture.writePiThemeSetting).not.toHaveBeenCalled();
    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("persists a temporary active theme after the user explicitly selects it", async () => {
    const fixture = makeFixture("tui", "session-1", "tokyo-night-dark");
    fixture.ui.theme = tokyoLightTheme;
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());

    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\x1b");
    await studio;

    expect(fixture.ui.setTheme).toHaveBeenCalledOnce();
    expect(fixture.ui.setTheme).toHaveBeenCalledWith("tokyo-night-light");
    expect(fixture.writePiThemeSetting).not.toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("shows Automatic when the saved theme is the Tokyo Night pair", async () => {
    const fixture = makeFixture(
      "tui",
      "session-1",
      TOKYO_NIGHT_AUTOMATIC_THEME_SETTING,
    );
    fixture.ui.theme = tokyoLightTheme;
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());

    expect(fixture.customComponent.render(80).join("\n")).toContain(
      "Theme: Automatic",
    );
    fixture.customComponent.handleInput("\x1b");
    await studio;

    expect(fixture.writePiThemeSetting).not.toHaveBeenCalled();
    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("opens on the saved three-state theme without rewriting it", async () => {
    const fixture = makeFixture("tui", "session-1", "tokyo-night-light");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());

    expect(fixture.readPiThemeSetting).toHaveBeenCalledOnce();
    expect(fixture.customComponent.render(80).join("\n")).toContain(
      "Theme: Tokyo Night Light",
    );
    fixture.customComponent.handleInput("\x1b");
    await studio;

    expect(fixture.writePiThemeSetting).not.toHaveBeenCalled();
    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("does not persist a fallback when the saved theme is unrelated", async () => {
    const fixture = makeFixture("tui", "session-1", "other-theme");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());
    expect(fixture.customComponent.render(80).join("\n")).toContain(
      "Theme: Automatic",
    );

    fixture.customComponent.handleInput("\x1b");
    await studio;

    expect(fixture.writePiThemeSetting).not.toHaveBeenCalled();
    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("persists Automatic through the project-owned settings writer", async () => {
    const fixture = makeFixture("tui", "session-1", "tokyo-night-dark");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());
    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\r");

    expect(fixture.customComponent.render(80).join("\n")).toContain(
      "Theme: Automatic",
    );
    fixture.customComponent.handleInput("\x1b");
    await studio;

    expect(fixture.writePiThemeSetting).toHaveBeenCalledWith(
      TOKYO_NIGHT_AUTOMATIC_THEME_SETTING,
    );
    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    expect(fixture.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Restart Pi"),
      "info",
    );
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("keeps Studio open when the Automatic settings write fails", async () => {
    const fixture = makeFixture("tui", "session-1", "tokyo-night-dark");
    fixture.writePiThemeSetting.mockReturnValueOnce({
      success: false,
      error: "settings write failed",
    });
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());
    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\r");
    fixture.customComponent.handleInput("\x1b");

    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    expect(fixture.ui.notify).toHaveBeenCalledWith(
      "settings write failed",
      "error",
    );

    fixture.customComponent.handleInput("\x1b");
    await studio;
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("persists the locally previewed Theme only when Studio closes", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());
    fixture.customComponent.handleInput("\r");

    expect(fixture.ui.getTheme).toHaveBeenCalledWith("tokyo-night-dark");
    expect(fixture.ui.setTheme).not.toHaveBeenCalled();
    expect(fixture.customComponent.render(80).join("\n")).toContain(
      "Theme: Tokyo Night Dark",
    );

    fixture.customComponent.handleInput("\x1b");
    await studio;

    expect(fixture.ui.setTheme).toHaveBeenCalledOnce();
    expect(fixture.ui.setTheme).toHaveBeenCalledWith("tokyo-night-dark");
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("opens Neon Studio without an overlay and saves it with Escape", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const studio = fixture.command.handler("", fixture.ctx);
    await vi.waitFor(() => expect(fixture.customComponent).toBeDefined());

    expect(fixture.ui.custom).toHaveBeenCalledOnce();
    expect(fixture.ui.custom.mock.calls[0]).toHaveLength(1);
    fixture.customComponent.handleInput("\x1b");
    await studio;

    expect(vi.mocked(TokyoConfigManager.prototype.write)).toHaveBeenCalledOnce();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("does not write protocol-breaking text outside TUI mode", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    for (const mode of ["rpc", "json", "print"] as const) {
      const fixture = makeFixture(mode);
      await fixture.command.handler("", fixture.ctx);
      if (mode === "rpc") {
        expect(fixture.ui.notify).toHaveBeenCalledWith(
          "Neon Studio is only available in TUI mode.",
          "info",
        );
      } else {
        expect(fixture.ui.notify).not.toHaveBeenCalled();
      }
    }

    expect(log).not.toHaveBeenCalled();
  });

  it("does not perform TUI work in non-interactive modes", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const fixture = makeFixture(mode);
      await fixture.emit("session_start", { reason: "start" }, fixture.ctx);
      expect(fixture.ui.setWidget).not.toHaveBeenCalled();
      expect(fixture.ui.setEditorComponent).not.toHaveBeenCalled();
      expect(fixture.ui.setFooter).not.toHaveBeenCalled();
      await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    }
  });

  it("keeps working state through agent end and resets only after the agent settles", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "start" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("Waiting"));
    const workingMessageCalls = fixture.ui.setWorkingMessage.mock.calls.length;

    await fixture.emit("agent_end", { type: "agent_end" }, fixture.ctx);

    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledTimes(workingMessageCalls);
    await fixture.emit("agent_settled", { type: "agent_settled" }, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not clear a new run started by an earlier settled handler", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "start" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    await fixture.emit("agent_end", { type: "agent_end" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();
    fixture.ctx.isIdle.mockReturnValue(false);

    await fixture.emit("agent_settled", { type: "agent_settled" }, fixture.ctx);

    expect(fixture.ui.setWorkingMessage).not.toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("does not let a late old shutdown clear replacement resources", async () => {
    const fixture = makeFixture("tui", "first");
    const firstCtx = fixture.ctx;
    await fixture.emit("session_start", { reason: "start" }, firstCtx);
    const secondCtx = { ...fixture.ctx, sessionManager: { ...fixture.ctx.sessionManager, getSessionId: () => "second", getSessionFile: () => "/sessions/second.jsonl" } };
    await fixture.emit("session_start", { reason: "replace" }, secondCtx);
    const currentWidget = fixture.widgets.get("tokyo-status");
    await fixture.emit("session_shutdown", { reason: "replace" }, firstCtx);
    expect(fixture.widgets.get("tokyo-status")).toBe(currentWidget);
    await fixture.emit("session_shutdown", { reason: "quit" }, secondCtx);
  });

  it("exposes the single animation gate", () => {
    expect(shouldRunRainAnimation("tui", true)).toBe(true);
    expect(shouldRunRainAnimation("tui", false)).toBe(false);
    expect(shouldRunRainAnimation("rpc", true)).toBe(false);
  });
});
