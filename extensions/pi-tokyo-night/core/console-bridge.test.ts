import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as PiTui from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import {
  createConsoleLogBridge,
  createTokyoNightErrorSink,
  flushConsoleLogWrites,
  getTokyoNightLogPath,
  installConsoleLogBridge,
  TOKYO_NIGHT_LOG_MAX_BYTES,
  type ConsoleLogBridge,
} from "./console-bridge";
import { TokyoConfigManager } from "./config";
import { registerTokyoNightExtension } from "../extension";

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

type RuntimeTuiConstructor = new (terminal: unknown, showHardwareCursor?: boolean) => TUI;

const tuiExports = PiTui as unknown as {
  TUI?: RuntimeTuiConstructor;
  TuiMainScreen?: RuntimeTuiConstructor;
};
const RuntimeTui = tuiExports.TuiMainScreen ?? tuiExports.TUI;

async function waitForTuiRender(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Tokyo Night TUI console bridge", () => {
  it("uses the agent directory directly for its log file", () => {
    expect(getTokyoNightLogPath("/home/test/.pi/agent")).toBe(
      path.join("/home/test/.pi/agent", "pi-tokyo-night.log"),
    );
  });

  it("writes injected errors directly to the Tokyo Night log without using console", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-error-sink-"));
    const logPath = path.join(tempRoot, "agent", "pi-tokyo-night.log");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = createTokyoNightErrorSink({
      logFilePath: logPath,
      now: () => new Date("2026-04-01T12:34:56.000Z"),
    });

    try {
      sink(new Error("rename failed"), "migrateLegacyTokyoConfig");
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect(content).toContain(
        "[2026-04-01T12:34:56.000Z] ERROR [pi-tokyo-night] migrateLegacyTokyoConfig: Error: rename failed",
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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

  it("caps the log at 1 MiB and retains recent entries after discarding the oldest half", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-cap-"));
    const logPath = path.join(tempRoot, "agent", "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const payload = "x".repeat(300 * 1024);

    try {
      bridge.setInteractive(true);
      target.info("oldest-entry", payload);
      target.info("second-entry", payload);
      target.info("third-entry", payload);
      target.info("newest-entry", payload);
      await flushConsoleLogWrites();

      const fileStats = await stat(logPath);
      const content = await readFile(logPath, "utf8");
      expect(fileStats.size).toBeLessThanOrEqual(TOKYO_NIGHT_LOG_MAX_BYTES);
      expect(content).not.toContain("oldest-entry");
      expect(content).toContain("newest-entry");
      expect(content).toContain("discarded oldest log entries");
    } finally {
      bridge.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("truncates one oversized UTF-8 entry without exceeding the cap", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-utf8-"));
    const logPath = path.join(tempRoot, "agent", "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });

    try {
      bridge.setInteractive(true);
      target.error("oversized-entry", "雨".repeat(400 * 1024));
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect((await stat(logPath)).size).toBeLessThanOrEqual(TOKYO_NIGHT_LOG_MAX_BYTES);
      expect(content).toContain("oversized-entry");
      expect(content).toContain("log entry truncated");
      expect(content).not.toContain("�");
    } finally {
      bridge.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps a complete recent line when the retained tail starts at its boundary", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-boundary-"));
    const logPath = path.join(tempRoot, "agent", "pi-tokyo-night.log");
    const retainedBytes = TOKYO_NIGHT_LOG_MAX_BYTES / 2;
    const recentHeader = "recent-boundary-entry\n";
    const retained = `${recentHeader}${"r".repeat(retainedBytes - recentHeader.length - 1)}\n`;
    const discarded = `${"d".repeat(TOKYO_NIGHT_LOG_MAX_BYTES - retainedBytes - 1)}\n`;
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${discarded}${retained}`, "utf8");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });

    try {
      bridge.setInteractive(true);
      target.info("new-entry");
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect(content).toContain("recent-boundary-entry");
      expect(content).toContain("new-entry");
      expect((await stat(logPath)).size).toBeLessThanOrEqual(TOKYO_NIGHT_LOG_MAX_BYTES);
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
    if (!RuntimeTui) throw new Error("Pi TUI runtime constructor is unavailable");
    const tui = new RuntimeTui(terminal, false);
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

function makeIntegrationFixture(
  mode: SessionMode,
  bridge: ConsoleLogBridge,
  compatibility?: { version: string; supported: boolean; minimum: "0.80.5" },
) {
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

  const installBridge = vi.fn(() => bridge);
  registerTokyoNightExtension(pi, {
    installConsoleLogBridge: installBridge,
    compatibility,
  });

  return {
    ctx,
    installBridge,
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

  it("does not patch console before a session starts", async () => {
    const bridge = { setInteractive: vi.fn(), dispose: vi.fn() } as any;
    const fixture = makeIntegrationFixture("tui", bridge);

    expect(fixture.installBridge).not.toHaveBeenCalled();

    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    expect(fixture.installBridge).toHaveBeenCalledOnce();
    await shutdownIntegrationFixture(fixture);
  });

  it.each(["tui", "rpc", "json", "print"] as const)(
    "sets the bridge mode correctly for %s sessions",
    async (mode) => {
      const bridge = { setInteractive: vi.fn(), dispose: vi.fn() } as any;
      const fixture = makeIntegrationFixture(mode, bridge);

      await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

      if (mode === "tui") {
        expect(fixture.installBridge).toHaveBeenCalledOnce();
        expect(bridge.setInteractive).toHaveBeenCalledWith(true);
      } else {
        expect(fixture.installBridge).not.toHaveBeenCalled();
        expect(bridge.setInteractive).not.toHaveBeenCalled();
      }
      await shutdownIntegrationFixture(fixture);
      expect(bridge.dispose).toHaveBeenCalledTimes(mode === "tui" ? 1 : 0);
    },
  );

  it("disposes the bridge when an unsupported session creates no UI state", async () => {
    const bridge = { setInteractive: vi.fn(), dispose: vi.fn() } as any;
    const fixture = makeIntegrationFixture(
      "tui",
      bridge,
      { version: "0.80.4", supported: false, minimum: "0.80.5" },
    );

    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await shutdownIntegrationFixture(fixture);

    expect(bridge.dispose).toHaveBeenCalledOnce();
  });

  it("does not let a late old shutdown release the current session bridge", async () => {
    const target = makeConsole();
    const originalError = target.error;
    const appendLine = vi.fn();
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: "/tmp/pi-tokyo-night-late-shutdown.log",
      appendLine,
    });
    const fixture = makeIntegrationFixture("tui", bridge);
    const firstCtx = fixture.ctx;
    const secondCtx = {
      ...fixture.ctx,
      sessionManager: {
        ...fixture.ctx.sessionManager,
        getSessionId: () => "session-tui-replacement",
        getSessionFile: () => "/sessions/session-tui-replacement.jsonl",
      },
    };

    await fixture.emit("session_start", { reason: "startup" }, firstCtx);
    await fixture.emit("session_start", { reason: "resume" }, secondCtx);
    await fixture.emit("session_shutdown", { reason: "resume" }, firstCtx);
    target.error("current session remains protected");

    expect(appendLine).toHaveBeenCalledOnce();
    expect(originalError).not.toHaveBeenCalled();

    await fixture.emit("session_shutdown", { reason: "quit" }, secondCtx);
    target.error("after current shutdown");
    expect(originalError).toHaveBeenCalledWith("after current shutdown");
  });

  it("keeps an unsupported replacement session protected from a late old shutdown", async () => {
    const target = makeConsole();
    const originalError = target.error;
    const appendLine = vi.fn();
    const bridge = createConsoleLogBridge({
      console: target,
      logFilePath: "/tmp/pi-tokyo-night-unsupported-replacement.log",
      appendLine,
    });
    const fixture = makeIntegrationFixture(
      "tui",
      bridge,
      { version: "0.80.4", supported: false, minimum: "0.80.5" },
    );
    const firstCtx = fixture.ctx;
    const secondCtx = {
      ...fixture.ctx,
      sessionManager: {
        ...fixture.ctx.sessionManager,
        getSessionId: () => "unsupported-replacement",
        getSessionFile: () => "/sessions/unsupported-replacement.jsonl",
      },
    };

    await fixture.emit("session_start", { reason: "startup" }, firstCtx);
    await fixture.emit("session_start", { reason: "resume" }, secondCtx);
    await fixture.emit("session_shutdown", { reason: "resume" }, firstCtx);
    target.error("unsupported replacement remains protected");

    expect(appendLine).toHaveBeenCalledOnce();
    expect(originalError).not.toHaveBeenCalled();

    await fixture.emit("session_shutdown", { reason: "quit" }, secondCtx);
    target.error("after unsupported replacement shutdown");
    expect(originalError).toHaveBeenCalledWith(
      "after unsupported replacement shutdown",
    );
  });

  it("restores console output when the TUI session shuts down", async () => {
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
    target.error("after shutdown");

    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(originalError).toHaveBeenCalledWith("after shutdown");
  });
});
