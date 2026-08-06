import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import {
  createConsoleLogBridge,
  flushConsoleLogWrites,
  getTokyoNightLogPath,
  installConsoleLogBridge,
  type ConsoleLogBridge,
} from "./console-bridge";
import { TokyoConfigManager } from "./config";
import { registerTokyoNightExtension } from "./extension";

type ConsoleSpy = ReturnType<typeof vi.fn> & ((...args: any[]) => void);

type FakeConsole = {
  log: ConsoleSpy;
  info: ConsoleSpy;
  debug: ConsoleSpy;
  trace: ConsoleSpy;
  warn: ConsoleSpy;
  error: ConsoleSpy;
};

function makeConsole(): FakeConsole {
  return {
    log: vi.fn() as ConsoleSpy,
    info: vi.fn() as ConsoleSpy,
    debug: vi.fn() as ConsoleSpy,
    trace: vi.fn() as ConsoleSpy,
    warn: vi.fn() as ConsoleSpy,
    error: vi.fn() as ConsoleSpy,
  };
}

function makeTerminal() {
  const writes: string[] = [];
  return {
    writes,
    start: vi.fn(),
    stop: vi.fn(),
    drainInput: vi.fn(async () => {}),
    write: (data: string) => writes.push(data),
    columns: 80,
    rows: 20,
    kittyProtocolActive: false,
    moveBy: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    clearLine: vi.fn(),
    clearFromCursor: vi.fn(),
    clearScreen: vi.fn(),
    setTitle: vi.fn(),
    setProgress: vi.fn(),
  };
}

async function waitForTuiRender(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Tokyo Night TUI console bridge", () => {
  it("uses the agent directory directly for its log file", () => {
    expect(getTokyoNightLogPath("/home/test/.pi/agent")).toBe(
      path.join("/home/test/.pi/agent", "pi-tokyo-night.log"),
    );
  });

  it("captures warnings and errors in interactive mode without forwarding them", () => {
    const target = makeConsole();
    const originalLog = target.log;
    const originalInfo = target.info;
    const originalDebug = target.debug;
    const originalTrace = target.trace;
    const originalWarn = target.warn;
    const originalError = target.error;
    const appendLine = vi.fn();
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: "/home/test/.pi/agent/pi-tokyo-night.log",
      appendLine,
      now: () => new Date("2026-04-01T12:34:56.000Z"),
    });

    bridge.setInteractive(true);
    target.log("log message");
    target.info("info message");
    target.debug("debug message");
    target.trace("trace message");
    target.warn("warning", new Error("boom"));
    target.error("failure", { code: 7 });

    expect(originalLog).not.toHaveBeenCalled();
    expect(originalInfo).not.toHaveBeenCalled();
    expect(originalDebug).not.toHaveBeenCalled();
    expect(originalTrace).not.toHaveBeenCalled();
    expect(originalWarn).not.toHaveBeenCalled();
    expect(originalError).not.toHaveBeenCalled();
    expect(appendLine).toHaveBeenCalledTimes(6);
    expect(appendLine).toHaveBeenNthCalledWith(
      1,
      "/home/test/.pi/agent/pi-tokyo-night.log",
      expect.stringContaining("[2026-04-01T12:34:56.000Z] LOG log message"),
    );
    expect(appendLine).toHaveBeenNthCalledWith(
      2,
      "/home/test/.pi/agent/pi-tokyo-night.log",
      expect.stringContaining("[2026-04-01T12:34:56.000Z] INFO info message"),
    );
    expect(appendLine).toHaveBeenNthCalledWith(
      3,
      "/home/test/.pi/agent/pi-tokyo-night.log",
      expect.stringContaining("[2026-04-01T12:34:56.000Z] DEBUG debug message"),
    );
    expect(appendLine).toHaveBeenNthCalledWith(
      4,
      "/home/test/.pi/agent/pi-tokyo-night.log",
      expect.stringContaining("[2026-04-01T12:34:56.000Z] TRACE trace message"),
    );
    expect(appendLine).toHaveBeenNthCalledWith(
      5,
      "/home/test/.pi/agent/pi-tokyo-night.log",
      expect.stringContaining("[2026-04-01T12:34:56.000Z] WARN warning Error: boom"),
    );
    expect(appendLine).toHaveBeenNthCalledWith(
      6,
      "/home/test/.pi/agent/pi-tokyo-night.log",
      expect.stringContaining("[2026-04-01T12:34:56.000Z] ERROR failure { code: 7 }"),
    );

    bridge.dispose();
  });

  it("forwards console output again after leaving interactive mode", () => {
    const target = makeConsole();
    const originalWarn = target.warn;
    const originalError = target.error;
    const appendLine = vi.fn();
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: "/home/test/.pi/agent/pi-tokyo-night.log",
      appendLine,
    });

    bridge.setInteractive(true);
    target.warn("captured");
    bridge.setInteractive(false);
    target.warn("forwarded");
    target.error("forwarded error");

    expect(originalWarn).toHaveBeenCalledWith("forwarded");
    expect(originalError).toHaveBeenCalledWith("forwarded error");
    expect(appendLine).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it("creates the log directory and preserves asynchronous write order", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-"));
    const logPath = path.join(tempRoot, "agent", "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: logPath,
      now: () => new Date("2026-04-01T12:34:56.000Z"),
    });

    try {
      bridge.setInteractive(true);
      target.info("first");
      target.debug("second");
      target.error("third");
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect(content).toContain("[2026-04-01T12:34:56.000Z] INFO first");
      expect(content).toContain("[2026-04-01T12:34:56.000Z] DEBUG second");
      expect(content).toContain("[2026-04-01T12:34:56.000Z] ERROR third");
      expect(content.indexOf("INFO first")).toBeLessThan(content.indexOf("DEBUG second"));
      expect(content.indexOf("DEBUG second")).toBeLessThan(content.indexOf("ERROR third"));
    } finally {
      bridge.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the real TUI redraw free of intercepted console payloads", async () => {
    const terminal = makeTerminal();
    const target = makeConsole();
    const rawError = vi.fn((...args: unknown[]) => {
      terminal.write(args.map(String).join(" "));
    });
    target.error = rawError as ConsoleSpy;
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: path.join(os.tmpdir(), "pi-tokyo-night-tui-test.log"),
      appendLine: vi.fn(),
    });
    const tui = new TuiMainScreen(terminal as any, false);
    const component = {
      render: vi.fn(() => ["rain", "input"]),
      invalidate: vi.fn(),
    };
    tui.addChild(component);

    try {
      bridge.setInteractive(true);
      tui.start();
      await waitForTuiRender();
      const redrawsBeforeError = tui.fullRedraws;

      target.error("synthetic TUI failure");
      tui.requestRender(true);
      await waitForTuiRender();

      expect(rawError).not.toHaveBeenCalled();
      expect(terminal.writes.join("\n")).not.toContain("synthetic TUI failure");
      expect(component.render).toHaveBeenCalled();
      expect(tui.fullRedraws).toBeGreaterThan(redrawsBeforeError);
    } finally {
      tui.stop();
      bridge.dispose();
    }
  });

  it("does not write a failed log sink back to the terminal", () => {
    const target = makeConsole();
    const originalError = target.error;
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: "/home/test/.pi/agent/pi-tokyo-night.log",
      appendLine: () => {
        throw new Error("disk full");
      },
    });

    bridge.setInteractive(true);
    target.error("must stay off the TUI");

    expect(originalError).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("does not overwrite a newer console patch during disposal", () => {
    const target = makeConsole();
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: "/home/test/.pi/agent/pi-tokyo-night.log",
    });
    const newerError = vi.fn();
    target.error = newerError as ConsoleSpy;

    bridge.dispose();

    expect(target.error).toBe(newerError);
  });

  it("deduplicates process-wide installation and releases it on dispose", () => {
    const target = makeConsole();
    const firstAppend = vi.fn();
    const secondAppend = vi.fn();
    const first = installConsoleLogBridge({
      console: target,
      logFilePath: "/home/test/.pi/agent/first.log",
      appendLine: firstAppend,
    });
    const second = installConsoleLogBridge({
      console: target,
      logFilePath: "/home/test/.pi/agent/second.log",
      appendLine: secondAppend,
    });

    expect(second).not.toBe(first);
    second.setInteractive(true);
    target.warn("one wrapper");
    expect(firstAppend).toHaveBeenCalledTimes(1);
    expect(secondAppend).not.toHaveBeenCalled();

    // A stale runtime must not deactivate the current global wrapper.
    first.setInteractive(false);
    target.warn("still current");
    expect(firstAppend).toHaveBeenCalledTimes(2);

    // A stale runtime must not tear down the current global wrapper.
    first.dispose();
    second.setInteractive(true);
    target.warn("still one wrapper");
    expect(firstAppend).toHaveBeenCalledTimes(3);

    second.dispose();

    const replacementAppend = vi.fn();
    const replacement = installConsoleLogBridge({
      console: target,
      logFilePath: "/home/test/.pi/agent/replacement.log",
      appendLine: replacementAppend,
    });
    replacement.setInteractive(true);
    target.warn("replacement wrapper");
    expect(replacementAppend).toHaveBeenCalledTimes(1);
    replacement.dispose();
  });
});

type SessionMode = "tui" | "rpc" | "json" | "print";
type IntegrationFixture = ReturnType<typeof makeIntegrationFixture>;

function makeIntegrationFixture(mode: SessionMode, bridge: ConsoleLogBridge) {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const ui = {
    setWidget: vi.fn(),
    setEditorComponent: vi.fn(),
    getEditorComponent: vi.fn(() => undefined),
    setFooter: vi.fn(),
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
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/workspace/project",
    model: undefined,
    modelRegistry: {
      getApiKeyForProvider: vi.fn(async () => undefined),
    },
    sessionManager: {
      getBranch: () => [],
      getLeafId: () => "leaf-1",
      getSessionId: () => `session-${mode}`,
      getSessionFile: () => `/sessions/session-${mode}.jsonl`,
    },
    getContextUsage: () => undefined,
  } as any;
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: vi.fn(),
    getThinkingLevel: () => "high",
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  } as any;

  registerTokyoNightExtension(pi, {
    installConsoleLogBridge: () => bridge,
  });

  return {
    ctx,
    async emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(...args);
      }
    },
  };
}

async function shutdownIntegrationFixture(fixture: IntegrationFixture): Promise<void> {
  await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
}

describe("Tokyo Night console bridge session integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["tui", "rpc", "json", "print"] as const)(
    "sets the bridge mode correctly for %s sessions",
    async (mode) => {
      const bridge = { setInteractive: vi.fn(), dispose: vi.fn() } as any;
      const fixture = makeIntegrationFixture(mode, bridge);

      await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

      expect(bridge.setInteractive).toHaveBeenCalledWith(mode === "tui");
      await shutdownIntegrationFixture(fixture);
    },
  );

  it("keeps late shutdown errors captured until the next non-TUI session", async () => {
    const target = {
      log: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any;
    const originalError = target.error;
    const appendLine = vi.fn();
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: "/tmp/pi-tokyo-night-integration.log",
      appendLine,
    });
    const tui = makeIntegrationFixture("tui", bridge);

    await tui.emit("session_start", { reason: "startup" }, tui.ctx);
    target.error("during session");
    await shutdownIntegrationFixture(tui);
    target.error("after shutdown, before replacement");

    expect(appendLine).toHaveBeenCalledTimes(2);
    expect(originalError).not.toHaveBeenCalled();

    const print = makeIntegrationFixture("print", bridge);
    await print.emit("session_start", { reason: "print" }, print.ctx);
    target.error("print output");

    expect(originalError).toHaveBeenCalledWith("print output");
    bridge.dispose();
  });
});
