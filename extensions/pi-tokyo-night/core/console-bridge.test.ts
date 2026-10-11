import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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

  it("batches a console burst while preserving every entry in order", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-batch-"));
    const logPath = path.join(tempRoot, "agent", "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const append = vi.spyOn(fs.promises, "appendFile");
    const inspect = vi.spyOn(fs.promises, "stat");

    try {
      bridge.setInteractive(true);
      for (let index = 0; index < 1_000; index++) target.info(`burst-${index}`);
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect(content.match(/INFO burst-\d+/g)).toEqual(
        Array.from({ length: 1_000 }, (_, index) => `INFO burst-${index}`),
      );
      expect(append.mock.calls.length).toBeLessThanOrEqual(3);
      expect(inspect.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      bridge.dispose();
      append.mockRestore();
      inspect.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("flushes its call-time records without waiting for later writes", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-flush-"));
    const logPath = path.join(tempRoot, "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const laterStarted = deferred();
    const releaseLater = deferred();
    const originalAppend = fs.promises.appendFile;
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] === logPath && String(args[1]).includes("before-flush")) {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else if (args[0] === logPath) {
        laterStarted.resolve();
        await releaseLater.promise;
      }
      return Reflect.apply(originalAppend, fs.promises, args);
    });

    try {
      bridge.setInteractive(true);
      target.info("before-flush");
      await firstStarted.promise;
      const earlyFlush = flushConsoleLogWrites();
      target.info("after-flush");
      releaseFirst.resolve();
      await laterStarted.promise;

      expect(await Promise.race([
        earlyFlush.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
      ])).toBe(true);
      expect(await readFile(logPath, "utf8")).toContain("before-flush");
      releaseLater.resolve();
      await flushConsoleLogWrites();
      expect(await readFile(logPath, "utf8")).toContain("after-flush");
    } finally {
      releaseFirst.resolve();
      releaseLater.resolve();
      await flushConsoleLogWrites();
      bridge.dispose();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps later records outside a flush barrier before the scheduled batch starts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-scheduled-flush-"));
    const logPath = path.join(tempRoot, "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const releaseLater = deferred();
    let laterStarted = false;
    const originalAppend = fs.promises.appendFile;
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] === logPath && String(args[1]).includes("after-scheduled-flush")) {
        laterStarted = true;
        await releaseLater.promise;
      }
      return Reflect.apply(originalAppend, fs.promises, args);
    });

    try {
      bridge.setInteractive(true);
      target.info("before-scheduled-flush");
      const earlyFlush = flushConsoleLogWrites();
      target.info("after-scheduled-flush");
      await vi.waitFor(() => expect(laterStarted).toBe(true));
      expect(await Promise.race([
        earlyFlush.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
      ])).toBe(true);
      expect(await readFile(logPath, "utf8")).toContain("before-scheduled-flush");
      releaseLater.resolve();
      await flushConsoleLogWrites();
    } finally {
      releaseLater.resolve();
      await flushConsoleLogWrites();
      bridge.dispose();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("shares the writer with an error sink loaded by a replacement module", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-reload-log-"));
    const logPath = path.join(tempRoot, "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const started = deferred();
    const release = deferred();
    const originalAppend = fs.promises.appendFile;
    const originalMkdir = fs.promises.mkdir;
    const originalStat = fs.promises.stat;
    await writeFile(logPath, "", "utf8");
    const metadata = await stat(logPath);
    const prepare = vi.spyOn(fs.promises, "mkdir").mockImplementation(async (...args) => {
      if (args[0] === tempRoot) return undefined;
      return Reflect.apply(originalMkdir, fs.promises, args);
    });
    const inspect = vi.spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
      if (args[0] === logPath) return metadata;
      return Reflect.apply(originalStat, fs.promises, args);
    });
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] === logPath && String(args[1]).includes("old-module")) {
        started.resolve();
        await release.promise;
      }
      return Reflect.apply(originalAppend, fs.promises, args);
    });

    try {
      bridge.setInteractive(true);
      target.info("old-module");
      await started.promise;
      vi.resetModules();
      const replacement = await import("./console-bridge");
      const sink = replacement.createTokyoNightErrorSink({ logFilePath: logPath });
      sink("replacement-module", "reload");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(append).toHaveBeenCalledTimes(1);

      release.resolve();
      await replacement.flushConsoleLogWrites();
      const content = await readFile(logPath, "utf8");
      expect(content).toContain("old-module");
      expect(content).toContain("replacement-module");
      expect(content.indexOf("old-module")).toBeLessThan(content.indexOf("replacement-module"));
    } finally {
      release.resolve();
      await flushConsoleLogWrites();
      bridge.dispose();
      append.mockRestore();
      inspect.mockRestore();
      prepare.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("drops the oldest pending entries at the count limit and reports the exact total", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-count-"));
    const logPath = path.join(tempRoot, "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });

    try {
      bridge.setInteractive(true);
      for (let index = 0; index < 3_000; index++) target.info(`bounded-${index}`);
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect(content.includes("dropped 952 oldest pending log entries due to queue limit")).toBe(true);
      expect(content.match(/INFO bounded-\d+/g)).toEqual(
        Array.from({ length: 2_048 }, (_, index) => `INFO bounded-${index + 952}`),
      );
      target.info("after-overload");
      await flushConsoleLogWrites();
      expect(await readFile(logPath, "utf8")).toContain("after-overload");
    } finally {
      bridge.dispose();
      await flushConsoleLogWrites();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("bounds pending bytes during an in-flight write and keeps the newest large entries", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-pending-bytes-"));
    const logPath = path.join(tempRoot, "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const started = deferred();
    const release = deferred();
    const originalAppend = fs.promises.appendFile;
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] === logPath && String(args[1]).includes("in-flight-entry")) {
        started.resolve();
        await release.promise;
      }
      return Reflect.apply(originalAppend, fs.promises, args);
    });

    try {
      bridge.setInteractive(true);
      target.info("in-flight-entry", "a".repeat(512 * 1024));
      await started.promise;
      for (const name of ["queued-oldest", "queued-middle", "queued-newest"]) {
        target.info(name, "雨".repeat(130 * 1024));
      }
      expect(append).toHaveBeenCalledTimes(1);
      release.resolve();
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect(content.includes("dropped 1 oldest pending log entries due to queue limit")).toBe(true);
      expect(content.includes("queued-oldest")).toBe(false);
      expect(content.includes("queued-middle")).toBe(true);
      expect(content.includes("queued-newest")).toBe(true);
      expect(content.includes("�")).toBe(false);
      expect((await stat(logPath)).size).toBeLessThanOrEqual(TOKYO_NIGHT_LOG_MAX_BYTES);
    } finally {
      release.resolve();
      await flushConsoleLogWrites();
      bridge.dispose();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves new drop counts during a notice write and flushes dropped call-time records", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-drop-flush-"));
    const logPath = path.join(tempRoot, "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const releaseFirstNotice = deferred();
    const releaseSecondNotice = deferred();
    const releaseLaterEntries = deferred();
    let noticeWrites = 0;
    let laterEntriesStarted = false;
    const originalAppend = fs.promises.appendFile;
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] === logPath && String(args[1]).includes("due to queue limit")) {
        noticeWrites++;
        await (noticeWrites === 1 ? releaseFirstNotice.promise : releaseSecondNotice.promise);
      } else if (args[0] === logPath && String(args[1]).includes("new-burst-")) {
        laterEntriesStarted = true;
        await releaseLaterEntries.promise;
      }
      return Reflect.apply(originalAppend, fs.promises, args);
    });

    try {
      bridge.setInteractive(true);
      for (let index = 0; index < 3_000; index++) target.info(`old-burst-${index}`);
      await vi.waitFor(() => expect(noticeWrites).toBe(1));
      const earlyFlush = flushConsoleLogWrites();
      for (let index = 0; index < 3_000; index++) target.info(`new-burst-${index}`);
      releaseFirstNotice.resolve();
      await vi.waitFor(() => expect(noticeWrites).toBe(2));

      expect(await Promise.race([
        earlyFlush.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
      ])).toBe(false);
      releaseSecondNotice.resolve();
      await vi.waitFor(() => expect(laterEntriesStarted).toBe(true));
      expect(await Promise.race([
        earlyFlush.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
      ])).toBe(true);

      releaseLaterEntries.resolve();
      await flushConsoleLogWrites();
      const content = await readFile(logPath, "utf8");
      expect(content.match(/dropped \d+ oldest pending log entries/g)).toEqual([
        "dropped 952 oldest pending log entries",
        "dropped 3000 oldest pending log entries",
      ]);
      expect(content).not.toContain("old-burst-");
      expect(content.match(/INFO new-burst-\d+/g)).toHaveLength(2_048);
    } finally {
      releaseFirstNotice.resolve();
      releaseSecondNotice.resolve();
      releaseLaterEntries.resolve();
      await flushConsoleLogWrites();
      bridge.dispose();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("counts in-flight records against the entry limit", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-active-count-"));
    const logPath = path.join(tempRoot, "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const started = deferred();
    const release = deferred();
    const originalAppend = fs.promises.appendFile;
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] === logPath && String(args[1]).includes("active-record")) {
        started.resolve();
        await release.promise;
      }
      return Reflect.apply(originalAppend, fs.promises, args);
    });

    try {
      bridge.setInteractive(true);
      target.info("active-record");
      await started.promise;
      for (let index = 0; index < 3_000; index++) target.info(`waiting-${index}`);
      release.resolve();
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect(content.includes("dropped 953 oldest pending log entries due to queue limit")).toBe(true);
      expect(content).toContain("active-record");
      expect(content.match(/INFO waiting-\d+/g)).toEqual(
        Array.from({ length: 2_047 }, (_, index) => `INFO waiting-${index + 953}`),
      );
    } finally {
      release.resolve();
      await flushConsoleLogWrites();
      bridge.dispose();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("bounds an oversized entry before its write and preserves subsequent batched entries", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-active-utf8-"));
    const logPath = path.join(tempRoot, "pi-tokyo-night.log");
    const target = makeConsole();
    const bridge = createConsoleLogBridge({ console: target, logFilePath: logPath });
    const release = deferred();
    let activeBytes = 0;
    const originalAppend = fs.promises.appendFile;
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] === logPath && String(args[1]).includes("oversized-active")) {
        activeBytes = Buffer.byteLength(String(args[1]), "utf8");
        await release.promise;
      }
      return Reflect.apply(originalAppend, fs.promises, args);
    });

    try {
      bridge.setInteractive(true);
      target.error("oversized-active", "雨".repeat(400 * 1024));
      await vi.waitFor(() => expect(activeBytes).toBeGreaterThan(0));
      expect(activeBytes).toBeLessThanOrEqual(TOKYO_NIGHT_LOG_MAX_BYTES);
      for (let index = 0; index < 5; index++) target.info(`after-large-${index}`);
      release.resolve();
      await flushConsoleLogWrites();

      const content = await readFile(logPath, "utf8");
      expect(content.match(/INFO after-large-\d+/g)).toEqual(
        Array.from({ length: 5 }, (_, index) => `INFO after-large-${index}`),
      );
      expect(content.includes("log entry truncated")).toBe(true);
      expect(content.includes("�")).toBe(false);
      expect(content.includes("due to queue limit")).toBe(false);
      expect((await stat(logPath)).size).toBeLessThanOrEqual(TOKYO_NIGHT_LOG_MAX_BYTES);
    } finally {
      release.resolve();
      await flushConsoleLogWrites();
      bridge.dispose();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("disables a failed file and keeps other default console and error sinks ordered", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-failed-queue-"));
    const failedPath = path.join(tempRoot, "failed.log");
    const healthyPath = path.join(tempRoot, "healthy.log");
    const firstTarget = makeConsole();
    const secondTarget = makeConsole();
    const originalFirstError = firstTarget.error;
    const originalSecondError = secondTarget.error;
    const firstBridge = createConsoleLogBridge({ console: firstTarget, logFilePath: healthyPath });
    const secondBridge = createConsoleLogBridge({ console: secondTarget, logFilePath: healthyPath });
    const failed = createTokyoNightErrorSink({ logFilePath: failedPath });
    const healthy = createTokyoNightErrorSink({ logFilePath: healthyPath });
    const originalAppend = fs.promises.appendFile;
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] === failedPath) throw new Error("disk unavailable");
      return Reflect.apply(originalAppend, fs.promises, args);
    });

    try {
      firstBridge.setInteractive(true);
      secondBridge.setInteractive(true);
      for (let index = 0; index < 5; index++) failed(`failed-${index}`, "queued");
      firstTarget.info("healthy-first");
      for (let index = 5; index < 10; index++) failed(`failed-${index}`, "queued");
      healthy("healthy-middle", "direct");
      secondTarget.info("healthy-last");
      await flushConsoleLogWrites();
      failed("after-disable", "queued");
      await flushConsoleLogWrites();

      const content = await readFile(healthyPath, "utf8");
      expect(content.match(/healthy-(first|middle|last)/g)).toEqual([
        "healthy-first", "healthy-middle", "healthy-last",
      ]);
      expect(append.mock.calls.filter((args) => args[0] === failedPath)).toHaveLength(1);
      expect(originalFirstError).not.toHaveBeenCalled();
      expect(originalSecondError).not.toHaveBeenCalled();
    } finally {
      await flushConsoleLogWrites();
      firstBridge.dispose();
      secondBridge.dispose();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("bounds notices across many log files while reporting every discarded entry", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-many-log-files-"));
    const append = vi.spyOn(fs.promises, "appendFile");
    try {
      for (let index = 0; index < 3_000; index++) {
        const sink = createTokyoNightErrorSink({ logFilePath: path.join(tempRoot, `${index}.log`) });
        sink(`many-files-${index}`, "bounded");
      }
      await flushConsoleLogWrites();

      const notices = append.mock.calls
        .map((args) => String(args[1]))
        .filter((content) => content.includes("due to queue limit"));
      expect(notices).toHaveLength(128);
      expect(notices.reduce((total, content) =>
        total + Number(/dropped (\d+) oldest pending log entries/.exec(content)?.[1] ?? 0), 0,
      )).toBe(952);
      expect(notices.filter((content) => content.includes("across log files"))).toHaveLength(1);
      expect(notices.find((content) => content.includes("across log files")))
        .toContain("dropped 825 oldest pending log entries across log files (824 from other log files)");
      expect(notices.filter((content) => !content.includes("across log files"))
        .every((content) => content.includes("dropped 1 oldest pending log entries"))).toBe(true);
      expect(append.mock.calls.filter((args) => String(args[1]).includes("ERROR"))).toHaveLength(2_048);
    } finally {
      await flushConsoleLogWrites();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it.each(["in-flight", "queued"] as const)(
    "preserves cross-file drop counts when the failed anchor owns the %s notice",
    async (noticeLocation) => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-drop-anchor-"));
      const heldPath = path.join(tempRoot, "held.log");
      const failedPath = path.join(tempRoot, "0.log");
      const heldStarted = deferred();
      const releaseHeld = deferred();
      const noticeStarted = deferred();
      const releaseNotice = deferred();
      const outputs: string[] = [];
      const inspect = vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 0 } as fs.Stats);
      const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
        const content = String(args[1]);
        if (args[0] === heldPath) {
          heldStarted.resolve();
          await releaseHeld.promise;
        }
        if (args[0] === failedPath && content.includes("due to queue limit")) {
          noticeStarted.resolve();
          await releaseNotice.promise;
          throw Object.assign(new Error("anchor unavailable"), { code: "EIO" });
        }
        outputs.push(content);
      });
      try {
        if (noticeLocation === "in-flight") {
          createTokyoNightErrorSink({ logFilePath: heldPath })("held", "bounded");
          await heldStarted.promise;
          for (let index = 0; index < 5_000; index++) {
            createTokyoNightErrorSink({ logFilePath: path.join(tempRoot, `${index}.log`) })("tiny", "bounded");
          }
          releaseHeld.resolve();
          await noticeStarted.promise;
        } else {
          const failed = createTokyoNightErrorSink({ logFilePath: failedPath });
          for (let index = 0; index < 3_000; index++) failed("old", "bounded");
          await noticeStarted.promise;
          for (let index = 1; index <= 5_000; index++) {
            createTokyoNightErrorSink({ logFilePath: path.join(tempRoot, `${index}.log`) })("tiny", "bounded");
          }
        }
        releaseNotice.resolve();
        await flushConsoleLogWrites();

        const notices = outputs.filter((content) => content.includes("due to queue limit"));
        const reportedDrops = notices.reduce((total, content) =>
          total + Number(/dropped (\d+) oldest pending log entries/.exec(content)?.[1] ?? 0), 0,
        );
        expect(reportedDrops).toBe(2_952);
        expect(notices.length).toBeLessThanOrEqual(128);
        expect(append.mock.calls.filter((args) => args[0] === failedPath)).toHaveLength(1);
      } finally {
        releaseHeld.resolve();
        releaseNotice.resolve();
        await flushConsoleLogWrites();
        append.mockRestore();
        inspect.mockRestore();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("moves cross-file drops to a pending healthy file while preserving an earlier flush boundary", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-drop-recipient-"));
    const heldPath = path.join(tempRoot, "held.log");
    const failedPaths = new Set(Array.from({ length: 128 }, (_, index) => path.join(tempRoot, `${index}.log`)));
    const heldStarted = deferred();
    const releaseHeld = deferred();
    const noticeStarted = deferred();
    const releaseNotice = deferred();
    const laterStarted = deferred();
    const releaseLater = deferred();
    const outputs: string[] = [];
    const inspect = vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 0 } as fs.Stats);
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      const filePath = String(args[0]);
      const content = String(args[1]);
      if (filePath === heldPath) {
        heldStarted.resolve();
        await releaseHeld.promise;
      } else if (failedPaths.has(filePath)) {
        throw Object.assign(new Error("anchor unavailable"), { code: "EIO" });
      } else if (content.includes("due to queue limit")) {
        noticeStarted.resolve();
        await releaseNotice.promise;
      } else if (content.includes("newer-entry")) {
        laterStarted.resolve();
        await releaseLater.promise;
      }
      outputs.push(content);
    });
    try {
      createTokyoNightErrorSink({ logFilePath: heldPath })("held", "bounded");
      await heldStarted.promise;
      for (const filePath of failedPaths) createTokyoNightErrorSink({ logFilePath: filePath })("old", "bounded");
      const earlyFlush = flushConsoleLogWrites();
      for (let index = 128; index < 5_128; index++) {
        createTokyoNightErrorSink({ logFilePath: path.join(tempRoot, `${index}.log`) })("newer-entry", "bounded");
      }
      releaseHeld.resolve();
      await noticeStarted.promise;

      expect(await Promise.race([
        earlyFlush.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
      ])).toBe(false);
      releaseNotice.resolve();
      await laterStarted.promise;
      expect(await Promise.race([
        earlyFlush.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
      ])).toBe(true);
      releaseLater.resolve();
      await flushConsoleLogWrites();

      const notices = outputs.filter((content) => content.includes("due to queue limit"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("dropped 2953 oldest pending log entries across log files (2953 from other log files)");
      expect(append.mock.calls.filter((args) => failedPaths.has(String(args[0])))).toHaveLength(128);
    } finally {
      releaseHeld.resolve();
      releaseNotice.resolve();
      releaseLater.resolve();
      await flushConsoleLogWrites();
      append.mockRestore();
      inspect.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries a failed file after enough newer failed paths replace its metadata", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-failed-paths-"));
    const firstPath = path.join(tempRoot, "first.log");
    let firstAttempts = 0;
    const originalAppend = fs.promises.appendFile;
    const append = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args) => {
      if (args[0] !== firstPath || ++firstAttempts === 1) throw new Error("temporary failure");
      return Reflect.apply(originalAppend, fs.promises, args);
    });
    try {
      const first = createTokyoNightErrorSink({ logFilePath: firstPath });
      first("initial-failure", "bounded");
      await flushConsoleLogWrites();
      for (let index = 0; index < 128; index++) {
        const sink = createTokyoNightErrorSink({ logFilePath: path.join(tempRoot, `${index}.log`) });
        sink("newer-failure", "bounded");
      }
      await flushConsoleLogWrites();
      first("retry-after-eviction", "bounded");
      await flushConsoleLogWrites();

      expect(firstAttempts).toBe(2);
      expect(await readFile(firstPath, "utf8")).toContain("retry-after-eviction");
      const recentPath = path.join(tempRoot, "127.log");
      createTokyoNightErrorSink({ logFilePath: recentPath })("still-disabled", "bounded");
      await flushConsoleLogWrites();
      expect(append.mock.calls.filter((args) => args[0] === recentPath)).toHaveLength(1);
    } finally {
      await flushConsoleLogWrites();
      append.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("recreates an old log directory after its prepared metadata is replaced", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-tokyo-night-log-directories-"));
    const firstDirectory = path.join(tempRoot, "0");
    const firstPath = path.join(firstDirectory, "log.txt");
    const prepare = vi.spyOn(fs.promises, "mkdir");
    try {
      for (let index = 0; index < 130; index++) {
        const sink = createTokyoNightErrorSink({ logFilePath: path.join(tempRoot, `${index}`, "log.txt") });
        sink("directory-entry", "bounded");
      }
      await flushConsoleLogWrites();
      await rm(firstDirectory, { recursive: true, force: true });
      createTokyoNightErrorSink({ logFilePath: firstPath })("recreated-directory", "bounded");
      await flushConsoleLogWrites();

      expect(prepare.mock.calls.filter((args) => args[0] === firstDirectory)).toHaveLength(2);
      expect(await readFile(firstPath, "utf8")).toContain("recreated-directory");
    } finally {
      await flushConsoleLogWrites();
      prepare.mockRestore();
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
      await flushConsoleLogWrites();
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
    vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(async () => {});
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
