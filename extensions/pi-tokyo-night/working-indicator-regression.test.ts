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
  const terminal = {
    columns: 120, rows: 40, write: vi.fn(), hideCursor() {}, showCursor() {}, stop() {},
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
  const widgets = new Map<string, any>();
  fixture.ui.theme = { name: "tokyo-night-dark", fg: (_color: string, text: string) => text };
  fixture.ui.setWidget.mockImplementation((key: string, factory: any) => {
    const previous = widgets.get(key);
    if (previous) tui.removeChild(previous);
    if (typeof factory === "function") {
      const component = factory(tui, fixture.ui.theme);
      widgets.set(key, component);
      tui.addChild(component);
    }
  });
  fixture.ui.setWorkingIndicator.mockImplementation((options: any) => loader?.setIndicator(options));
  fixture.ui.setWorkingMessage.mockImplementation((message: string) => loader?.setMessage(message ?? "Working"));
  return {
    get renders() { return renders; },
    reset() { renders = 0; },
    stop() { loader?.stop(); tui.stop(); },
  };
}

beforeEach(() => { vi.spyOn(TokyoConfigManager.prototype, "read").mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("working indicator compatibility regression", () => {
  it.each([
    ["auto", 130, 9, 0, true],
    ["auto", 130, 9, 37, true],
    ["auto", 130, 9, 73, true],
    ["manual", 50, 21, 37, true],
    ["auto", 130, 9, 37, false],
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
    await vi.advanceTimersByTimeAsync(100);
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
    ["auto", 130, 130, true],
    ["auto", 130, 130, false],
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
    await vi.advanceTimersByTimeAsync(130);

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
    await vi.advanceTimersByTimeAsync(130);

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

  it("publishes spinner and text together on the 130ms rain cadence with accurate elapsed time", async () => {
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
    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledTimes(7);
    expect(
      fixture.ui.setWorkingMessage.mock.calls.map(
        ([message]: [string]) => stripAnsi(message),
      ),
    ).toEqual([
      "Waiting 0.1s",
      "Waiting 0.2s",
      "Waiting 0.3s",
      "Waiting 0.5s",
      "Waiting 0.6s",
      "Waiting 0.7s",
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

    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledTimes(3);
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });
});
