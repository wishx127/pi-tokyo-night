import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension, { buildStatusWidgetLines, shouldRunRainAnimation } from "./extension";
import { TokyoConfigManager } from "./config";

const theme = { fg: (_color: string, text: string) => text } as any;

type Mode = "tui" | "rpc" | "json" | "print";

function makeFixture(mode: Mode = "tui", sessionId = "session-1") {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const widgets = new Map<string, any>();
  let editorFactory: any;
  let footerFactory: any;
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
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
  } as any;
  const ctx = {
    ui,
    mode,
    hasUI: mode === "tui",
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
  extension(pi);
  return {
    ui, ctx, pi, widgets,
    get editorFactory() { return editorFactory; },
    get footerFactory() { return footerFactory; },
    command,
    async emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(() => {});
  vi.spyOn(TokyoConfigManager.prototype, "write").mockReturnValue(true);
});

describe("public layout and lifecycle contract", () => {
  it("keeps narrow status output bounded without selector-specific state", () => {
    for (const width of [0, 1, 2, 9]) {
      expect(() => buildStatusWidgetLines(width, false, "status")).not.toThrow();
    }
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

  it("keeps working state session-owned and resets on agent end", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", { reason: "start" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("Waiting"));
    await fixture.emit("agent_end", { type: "agent_end" }, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
    expect(vi.getTimerCount()).toBe(0);
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
