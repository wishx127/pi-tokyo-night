import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./extension";
import * as piTui from "@earendil-works/pi-tui";
import { Loader, type TUI } from "@earendil-works/pi-tui";
import { TokyoConfigManager } from "./core/config";

const stripAnsi = (text: string): string =>
  text.replace(/\u001b\[[0-9;]*m/g, "").replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /, "");

function makeFixture(mode: "tui" | "rpc" | "json" | "print" = "tui") {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const ui = {
    setWidget: vi.fn(), setEditorComponent: vi.fn(), getEditorComponent: vi.fn(), setFooter: vi.fn(),
    setWorkingVisible: vi.fn(), setWorkingMessage: vi.fn(), setWorkingIndicator: vi.fn(),
    notify: vi.fn(), select: vi.fn(), confirm: vi.fn(), input: vi.fn(), onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(), setHiddenThinkingLabel: vi.fn(),
  } as any;
  const ctx = {
    ui, mode, hasUI: mode === "tui", cwd: "/workspace/project", model: undefined,
    modelRegistry: { getApiKeyForProvider: vi.fn(async () => undefined) },
    sessionManager: { getBranch: () => [], getLeafId: () => "leaf", getSessionId: () => "session", getSessionFile: () => "/session" },
    isIdle: vi.fn(() => true),
  } as any;
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: vi.fn(), getThinkingLevel: () => "high", exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  } as any;
  extension(pi);
  return {
    ui, ctx,
    async emit(event: string, ...args: any[]) { for (const handler of handlers.get(event) ?? []) await handler(...args); },
  };
}

function mountHost(fixture: ReturnType<typeof makeFixture>, withLoader = true) {
  let onInput: ((data: string) => void) | undefined;
  let onResize: (() => void) | undefined;
  const terminal = {
    columns: 120, rows: 40, write: vi.fn(), hideCursor() {}, showCursor() {}, stop() {},
    start(input: (data: string) => void, resize: () => void) { onInput = input; onResize = resize; },
  };
  const runtime = piTui as unknown as { TuiMainScreen?: new (terminal: any) => TUI; TUI?: new (terminal: any) => TUI };
  const RuntimeTui = runtime.TuiMainScreen ?? runtime.TUI;
  if (!RuntimeTui) throw new Error("Pi TUI constructor unavailable");
  const tui = new RuntimeTui(terminal);
  const loader = withLoader ? new Loader(tui, (text) => text, (text) => text) : undefined;
  let renders = 0;
  const history = Array.from({ length: 1000 }, () => "unchanged history");
  tui.addChild({ render: () => { renders++; return history; }, invalidate() {} });
  if (loader) tui.addChild(loader);
  else tui.addChild({ render: () => ["", ""], invalidate() {} });
  const aboveEditor = new piTui.Container();
  aboveEditor.addChild(new piTui.Spacer(1));
  const editorContainer = new piTui.Container();
  const belowEditor = new piTui.Container();
  tui.addChild(aboveEditor);
  tui.addChild(editorContainer);
  tui.addChild(belowEditor);
  const widgets = new Map<string, any>();
  let editor: any;
  let editorFactory: any;
  fixture.ui.theme = { name: "tokyo-night-dark", fg: (_color: string, text: string) => text };
  fixture.ui.setEditorComponent.mockImplementation((factory: any) => {
    editorContainer.clear();
    editorFactory = factory;
    editor = factory?.(tui, { borderColor: () => "" }, piTui.getKeybindings());
    if (editor) { editorContainer.addChild(editor); tui.setFocus(editor); }
  });
  fixture.ui.getEditorComponent.mockImplementation(() => editorFactory);
  fixture.ui.setWidget.mockImplementation((key: string, factory: any, options: any) => {
    const previous = widgets.get(key);
    if (previous) { aboveEditor.removeChild(previous); belowEditor.removeChild(previous); }
    if (typeof factory === "function") {
      const component = factory(tui, fixture.ui.theme);
      widgets.set(key, component);
      (options?.placement === "belowEditor" ? belowEditor : aboveEditor).addChild(component);
    }
  });
  fixture.ui.setWorkingIndicator.mockImplementation((options: any) => loader?.setIndicator(options));
  fixture.ui.setWorkingMessage.mockImplementation((message: string) => loader?.setMessage(message ?? "Working"));
  return {
    terminal, tui, widgets,
    get editor() { return editor; },
    get renders() { return renders; },
    reset() { renders = 0; },
    input(data: string) { onInput?.(data); },
    resize(rows: number) { terminal.rows = rows; onResize?.(); },
    stop() { loader?.stop(); tui.stop(); },
  };
}

beforeEach(() => { vi.spyOn(TokyoConfigManager.prototype, "read").mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("working indicator compatibility regression", () => {
  it("skips idle host frames when a short terminal hides every animated rain row", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    const host = mountHost(fixture, false);
    host.terminal.rows = 8;
    try {
      await fixture.emit("session_start", {}, fixture.ctx);
      host.editor.setText(Array.from({ length: 8 }, (_, index) => `input ${index}`).join("\n"));
      host.tui.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.widgets.get("tokyo-rain").render(120)).toHaveLength(1);
      host.reset();

      await vi.advanceTimersByTimeAsync(1000);

      expect(host.renders).toBe(0);
    } finally {
      await fixture.emit("session_shutdown", {}, fixture.ctx);
      host.stop();
    }
  });

  it("resumes visible rain after the host handles a terminal resize", async () => {
    vi.useFakeTimers();
    vi.mocked(TokyoConfigManager.prototype.read).mockImplementation(async function (this: TokyoConfigManager) {
      this.set("rainMode", "manual");
      this.set("rainTickMs", 50);
    });
    const fixture = makeFixture();
    const host = mountHost(fixture, false);
    host.terminal.rows = 8;
    try {
      await fixture.emit("session_start", {}, fixture.ctx);
      host.editor.setText(Array.from({ length: 8 }, (_, index) => `input ${index}`).join("\n"));
      host.tui.start();
      await vi.advanceTimersByTimeAsync(1000);
      host.reset();
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.renders).toBe(0);

      host.resize(40);
      await vi.advanceTimersByTimeAsync(20);
      expect(host.renders).toBeGreaterThan(0);
      expect(host.widgets.get("tokyo-rain").render(120).length).toBeGreaterThan(1);
      host.reset();
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.renders).toBeGreaterThan(0);
    } finally {
      await fixture.emit("session_shutdown", {}, fixture.ctx);
      host.stop();
    }
  });

  it("resumes visible rain when native editor input frees its row budget", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    const host = mountHost(fixture, false);
    host.terminal.rows = 12;
    try {
      await fixture.emit("session_start", {}, fixture.ctx);
      host.editor.setText(Array.from({ length: 8 }, (_, index) => `input ${index}`).join("\n"));
      host.tui.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.widgets.get("tokyo-rain").render(120)).toHaveLength(1);
      host.reset();
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.renders).toBe(0);

      for (let line = 0; line < 7; line++) {
        host.input("\u0015");
        host.input("\u007f");
      }
      await vi.advanceTimersByTimeAsync(20);
      expect(host.editor.getText()).not.toContain("\n");
      expect(host.renders).toBeGreaterThan(0);
      expect(host.widgets.get("tokyo-rain").render(120).length).toBeGreaterThan(1);
      host.reset();
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.renders).toBeGreaterThan(0);
    } finally {
      await fixture.emit("session_shutdown", {}, fixture.ctx);
      host.stop();
    }
  });

  it("keeps working messages refreshing while every rain body row is hidden", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    const host = mountHost(fixture);
    host.terminal.rows = 8;
    try {
      await fixture.emit("session_start", {}, fixture.ctx);
      host.editor.setText(Array.from({ length: 8 }, (_, index) => `input ${index}`).join("\n"));
      host.tui.start();
      await fixture.emit("agent_start", {}, fixture.ctx);
      await vi.advanceTimersByTimeAsync(260);
      expect(host.widgets.get("tokyo-rain").render(120)).toHaveLength(1);
      host.reset();
      fixture.ui.setWorkingMessage.mockClear();

      await vi.advanceTimersByTimeAsync(1000);

      expect(host.renders).toBeGreaterThan(0);
      expect(host.renders).toBeLessThanOrEqual(11);
      expect(fixture.ui.setWorkingMessage).toHaveBeenCalled();
      expect(stripAnsi(fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0])).toContain("Waiting");
    } finally {
      await fixture.emit("session_shutdown", {}, fixture.ctx);
      host.stop();
    }
  });

  it("skips unchanged visible rain frames and resumes when a new drop column appears", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.4);
    vi.mocked(TokyoConfigManager.prototype.read).mockImplementation(async function (this: TokyoConfigManager) {
      this.set("rainMode", "manual");
      this.set("rainTickMs", 50);
      this.set("rainRows", 1);
    });
    const fixture = makeFixture();
    const host = mountHost(fixture, false);
    try {
      await fixture.emit("session_start", {}, fixture.ctx);
      host.tui.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(host.widgets.get("tokyo-rain").render(120)).toHaveLength(2);
      host.reset();

      await vi.advanceTimersByTimeAsync(1000);

      // Slower compact drops and changing wind can alter several visible cells,
      // but unchanged frames should still skip at least half of the 20 ticks.
      expect(host.renders).toBeLessThanOrEqual(10);
      const previousRenders = host.renders;
      random.mockReturnValue(0.6);
      await vi.advanceTimersByTimeAsync(500);
      expect(host.renders).toBeGreaterThan(previousRenders);
    } finally {
      await fixture.emit("session_shutdown", {}, fixture.ctx);
      host.stop();
    }
  });

  it.each([
    ["auto", 50, 21, 0, true],
    ["auto", 50, 21, 37, true],
    ["auto", 50, 21, 73, true],
    ["manual", 50, 21, 37, true],
    ["auto", 50, 21, 37, false],
  ] as const)("limits real host redraws in %s mode with %ims rain (limit %i, phase %ims, loader %s)", async (rainMode, rainTickMs, limit, phaseMs, withLoader) => {
    vi.useFakeTimers();
    vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(async function (this: TokyoConfigManager) {
      this.set("rainMode", rainMode);
      this.set("rainTickMs", rainTickMs);
    });
    const fixture = makeFixture();
    const host = mountHost(fixture, withLoader);
    await fixture.emit("session_start", {}, fixture.ctx);
    await vi.advanceTimersByTimeAsync(phaseMs);
    await fixture.emit("agent_start", {}, fixture.ctx);
    await fixture.emit("message_update", { assistantMessageEvent: { type: "text_delta" } }, fixture.ctx);
    // Measure sustained rain after drops can reach the initially empty water.
    await vi.advanceTimersByTimeAsync(1500);
    host.reset();
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.renders).toBeGreaterThanOrEqual(limit - 2);
    expect(host.renders).toBeLessThanOrEqual(limit);
    await fixture.emit("session_shutdown", {}, fixture.ctx);
    host.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["auto", 50, 50, true],
    ["auto", 50, 50, false],
    ["manual", 50, 50, true],
  ] as const)("avoids delayed duplicate frames with real timers: %s, tick %ims, budget %ims, loader %s", async (rainMode, rainTickMs, frameMs, withLoader) => {
    vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(async function (this: TokyoConfigManager) {
      this.set("rainMode", rainMode);
      this.set("rainTickMs", rainTickMs);
    });
    const fixture = makeFixture();
    const host = mountHost(fixture, withLoader);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      await fixture.emit("session_start", {}, fixture.ctx);
      await sleep(37);
      await fixture.emit("agent_start", {}, fixture.ctx);
      await sleep(350);
      host.reset();
      const start = performance.now();
      await sleep(1100);
      const elapsed = performance.now() - start;
      expect(host.renders).toBeGreaterThan(0);
      expect(host.renders).toBeLessThanOrEqual(Math.ceil(elapsed / frameMs) + 2);
    } finally {
      await fixture.emit("session_shutdown", {}, fixture.ctx);
      host.stop();
    }
  });

  it("ignores working events outside the interactive TUI", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const fixture = makeFixture(mode);
      await fixture.emit("session_start", {}, fixture.ctx);
      await fixture.emit("agent_start", {}, fixture.ctx);
      await fixture.emit("message_update", { assistantMessageEvent: { type: "thinking_delta" } }, fixture.ctx);
      await fixture.emit("agent_end", {}, fixture.ctx);
      await fixture.emit("agent_settled", {}, fixture.ctx);
      expect(fixture.ui.setWorkingMessage).not.toHaveBeenCalled();
      expect(fixture.ui.setWorkingIndicator).not.toHaveBeenCalled();
      expect(fixture.ui.setWorkingVisible).not.toHaveBeenCalled();
    }
  });

  it("keeps every spinner frame neutral while following the active theme", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    fixture.ui.theme = {
      name: "tokyo-night-dark",
      fg: vi.fn((color: string, text: string) => `<dark:${color}>${text}</dark:${color}>`),
    };

    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    expect(fixture.ui.setWorkingIndicator).toHaveBeenCalledOnce();
    expect(fixture.ui.setWorkingIndicator).toHaveBeenCalledWith({ frames: [""] });
    expect(fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("\x1b[38;2;169;177;214m⠋\x1b[39m");

    fixture.ui.setWorkingIndicator.mockClear();
    fixture.ui.theme = {
      name: "tokyo-night-light",
      fg: vi.fn((color: string, text: string) => `<light:${color}>${text}</light:${color}>`),
    };
    await vi.advanceTimersByTimeAsync(132);

    expect(fixture.ui.setWorkingIndicator).toHaveBeenCalledOnce();
    expect(fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("\x1b[38;2;86;95;137m⠙\x1b[39m");
    await fixture.emit("session_shutdown", {}, fixture.ctx);
  });

  it("reconfigures working chrome when a stable Theme proxy changes its target", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    let selected: "dark" | "light" = "dark";
    const themes = {
      dark: {
        name: "tokyo-night-dark",
        fg: (color: string, text: string) => `<dark:${color}>${text}</dark:${color}>`,
      },
      light: {
        name: "tokyo-night-light",
        fg: (color: string, text: string) => `<light:${color}>${text}</light:${color}>`,
      },
    };
    fixture.ui.theme = new Proxy({}, {
      get: (_target, property) => themes[selected][property as keyof typeof themes.dark],
    });

    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingIndicator.mockClear();

    selected = "light";
    await vi.advanceTimersByTimeAsync(132);

    expect(fixture.ui.setWorkingIndicator).toHaveBeenCalledOnce();
    expect(fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain("\x1b[38;2;86;95;137m⠙\x1b[39m");
    await fixture.emit("session_shutdown", {}, fixture.ctx);
  });

  it("keeps one timer per active session and clears it on replacement", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    const timerCount = vi.getTimerCount();
    expect(timerCount).toBe(1);
    const replacement = { ...fixture.ctx, sessionManager: { ...fixture.ctx.sessionManager, getSessionId: () => "replacement", getSessionFile: () => "/replacement" } };
    await fixture.emit("session_start", {}, replacement);
    expect(vi.getTimerCount()).toBe(timerCount);
    await fixture.emit("session_shutdown", { reason: "quit" }, replacement);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses updates between low-level runs and clears only after settling", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();

    await fixture.emit("agent_end", {}, fixture.ctx);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.ui.setWorkingMessage).not.toHaveBeenCalled();

    await fixture.emit("agent_start", {}, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("Waiting"));
    fixture.ui.setWorkingMessage.mockClear();
    await fixture.emit("agent_end", {}, fixture.ctx);
    await fixture.emit("agent_settled", {}, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledOnce();
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(fixture.ui.setWorkingIndicator).toHaveBeenLastCalledWith();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("coalesces repeated phase messages", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingIndicator.mockClear();
    fixture.ui.setWorkingMessage.mockClear();
    const event = { assistantMessageEvent: { type: "thinking_delta" } };
    await fixture.emit("message_update", event, fixture.ctx);
    await fixture.emit("message_update", event, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledOnce();
    expect(fixture.ui.setWorkingIndicator).not.toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("publishes working text on its 100ms clock while rain uses a faster cadence", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);

    expect(fixture.ui.setWorkingIndicator).toHaveBeenCalledOnce();
    const options = fixture.ui.setWorkingIndicator.mock.calls[0][0] as {
      frames: string[];
      intervalMs: number;
    };
    expect(options.frames).toEqual([""]);

    fixture.ui.setWorkingIndicator.mockClear();
    fixture.ui.setWorkingMessage.mockClear();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fixture.ui.setWorkingIndicator).not.toHaveBeenCalled();
    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledTimes(9);
    expect(
      fixture.ui.setWorkingMessage.mock.calls.map(
        ([message]: [string]) => stripAnsi(message),
      ),
    ).toEqual([
      "Waiting 0.1s",
      "Waiting 0.2s",
      "Waiting 0.3s",
      "Waiting 0.4s",
      "Waiting 0.5s",
      "Waiting 0.6s",
      "Waiting 0.7s",
      "Waiting 0.8s",
      "Waiting 0.9s",
    ]);

    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("animates complete waiting and thinking messages including the timer", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    fixture.ui.theme = {
      name: "tokyo-night-dark",
      fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
    };

    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();
    await vi.advanceTimersByTimeAsync(950);

    const waitingMessage = fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0] as string;
    expect(stripAnsi(waitingMessage)).toBe("Waiting 0.9s");
    expect(waitingMessage).toContain("\x1b[38;2;210;214;232m 0.\x1b[39m");

    await fixture.emit("message_update", {
      assistantMessageEvent: { type: "thinking_delta" },
    }, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();
    await vi.advanceTimersByTimeAsync(2_900);

    const thinkingMessage = fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0] as string;
    expect(stripAnsi(thinkingMessage)).toBe("Thinking 2.8s");
    expect(thinkingMessage).toContain("\x1b[38;2;210;214;232m 2.\x1b[39m");
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("pulses the complete tool message including timer and concurrency count", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    fixture.ui.theme = {
      name: "tokyo-night-dark",
      fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
    };

    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    await fixture.emit("tool_execution_start", {
      toolCallId: "tool-1",
      toolName: "read",
    }, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();
    await vi.advanceTimersByTimeAsync(550);

    expect(fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0]).toContain(
      "\x1b[38;2;210;214;232mUsing tools · read 0.5s\x1b[39m",
    );

    await fixture.emit("tool_execution_start", {
      toolCallId: "tool-2",
      toolName: "bash",
    }, fixture.ctx);
    await vi.advanceTimersByTimeAsync(110);
    const concurrentMessage = fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0] as string;
    expect(stripAnsi(concurrentMessage)).toBe(
      "Using tools · read 0.6s +1",
    );

    await vi.advanceTimersByTimeAsync(59_540);
    const minuteMessage = fixture.ui.setWorkingMessage.mock.calls.at(-1)?.[0] as string;
    expect(stripAnsi(minuteMessage)).toBe(
      "Using tools · read 1:00 +1",
    );
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("keeps elapsed time on the shared cadence when the host lacks indicator customization", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    delete fixture.ui.setWorkingIndicator;
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();

    await vi.advanceTimersByTimeAsync(500);

    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledTimes(4);
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });
});
