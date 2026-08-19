import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { format as formatConsoleArguments } from "node:util";
import { EXT_PREFIX, type ExtensionErrorSink } from "./errors";

export const TOKYO_NIGHT_LOG_FILE = "pi-tokyo-night.log";
export const TOKYO_NIGHT_LOG_MAX_BYTES = 1024 * 1024;

const TOKYO_NIGHT_LOG_RETAIN_BYTES = TOKYO_NIGHT_LOG_MAX_BYTES / 2;
const GLOBAL_BRIDGE_KEY = Symbol.for("pi-tokyo-night.console-log-bridge");

const CONSOLE_METHODS = [
  ["log", "LOG"],
  ["info", "INFO"],
  ["debug", "DEBUG"],
  ["trace", "TRACE"],
  ["warn", "WARN"],
  ["error", "ERROR"],
] as const;

type ConsoleMethodName = (typeof CONSOLE_METHODS)[number][0];
type ConsoleLevel = (typeof CONSOLE_METHODS)[number][1];
type ConsoleMethod = (...args: any[]) => void;
type ConsoleTarget = Record<ConsoleMethodName, ConsoleMethod>;
type AppendLogLine = (filePath: string, line: string) => void;

export interface ConsoleLogBridgeOptions {
  console?: ConsoleTarget;
  logFilePath?: string;
  appendLine?: AppendLogLine;
  now?: () => Date;
}

export interface TokyoNightErrorSinkOptions {
  logFilePath?: string;
  appendLine?: AppendLogLine;
  now?: () => Date;
}

export interface ConsoleLogBridge {
  /** Route console output away from the active interactive TUI. */
  setInteractive(active: boolean): void;
  /** Restore console methods owned by this bridge when it is safe to do so. */
  dispose(): void;
}

interface GlobalBridgeState {
  baseBridge: ConsoleLogBridge;
  handles: Set<symbol>;
  latestOwner: symbol | undefined;
}

let fileWriteTail = Promise.resolve();
const preparedLogDirectories = new Set<string>();
const disabledLogFiles = new Set<string>();

export function getTokyoNightLogPath(agentDir = getAgentDir()): string {
  return path.join(agentDir, TOKYO_NIGHT_LOG_FILE);
}

function resolveLogFilePath(): string {
  return getTokyoNightLogPath();
}

function truncateUtf8ToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;

  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function limitLogEntry(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
  const marker = `\n${EXT_PREFIX} log entry truncated to fit the 1 MiB limit.\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return `${truncateUtf8ToBytes(line, Math.max(0, maxBytes - markerBytes))}${marker}`;
}

async function readRecentLogTail(filePath: string): Promise<string> {
  let file: fs.promises.FileHandle | undefined;
  try {
    const stats = await fs.promises.stat(filePath);
    const bytesToRead = Math.min(stats.size, TOKYO_NIGHT_LOG_RETAIN_BYTES);
    if (bytesToRead === 0) return "";

    const tailStart = stats.size - bytesToRead;
    const boundaryProbeBytes = tailStart > 0 ? 1 : 0;
    const buffer = Buffer.allocUnsafe(bytesToRead + boundaryProbeBytes);
    file = await fs.promises.open(filePath, "r");
    const { bytesRead } = await file.read(
      buffer,
      0,
      buffer.byteLength,
      tailStart - boundaryProbeBytes,
    );
    let retainedBytes = buffer.subarray(boundaryProbeBytes, bytesRead);
    if (boundaryProbeBytes > 0 && buffer[0] !== 0x0a) {
      const firstCompleteLine = retainedBytes.indexOf(0x0a);
      retainedBytes = firstCompleteLine >= 0
        ? retainedBytes.subarray(firstCompleteLine + 1)
        : Buffer.alloc(0);
    }
    return truncateUtf8ToBytes(
      retainedBytes.toString("utf8"),
      TOKYO_NIGHT_LOG_RETAIN_BYTES,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  } finally {
    await file?.close();
  }
}

async function replaceLogFile(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, content, "utf8");
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    try {
      await fs.promises.unlink(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function appendBoundedLogLine(filePath: string, line: string): Promise<void> {
  let currentSize = 0;
  try {
    currentSize = (await fs.promises.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (currentSize + Buffer.byteLength(line, "utf8") <= TOKYO_NIGHT_LOG_MAX_BYTES) {
    await fs.promises.appendFile(filePath, line, "utf8");
    return;
  }

  let retained = await readRecentLogTail(filePath);
  if (retained && !retained.endsWith("\n")) retained += "\n";
  const trimMarker = `[${new Date().toISOString()}] WARN ${EXT_PREFIX} log limit reached; discarded oldest log entries.\n`;
  const availableEntryBytes = Math.max(
    0,
    TOKYO_NIGHT_LOG_MAX_BYTES -
      Buffer.byteLength(retained, "utf8") -
      Buffer.byteLength(trimMarker, "utf8"),
  );
  const boundedLine = limitLogEntry(line, availableEntryBytes);
  await replaceLogFile(filePath, `${retained}${trimMarker}${boundedLine}`);
}

function appendLogLine(filePath: string, line: string): void {
  if (disabledLogFiles.has(filePath)) return;

  const previous = fileWriteTail;
  fileWriteTail = previous
    .then(async () => {
      const directory = path.dirname(filePath);
      if (!preparedLogDirectories.has(directory)) {
        await fs.promises.mkdir(directory, { recursive: true });
        preparedLogDirectories.add(directory);
      }
      await appendBoundedLogLine(filePath, line);
    })
    .catch(() => {
      // Disable a failing sink for the rest of this process. Never fall back
      // to console here: that would reintroduce raw terminal output.
      disabledLogFiles.add(filePath);
    });
}

export async function flushConsoleLogWrites(): Promise<void> {
  await fileWriteTail;
}

export function createTokyoNightErrorSink(
  options: TokyoNightErrorSinkOptions = {},
): ExtensionErrorSink {
  const writeLine = options.appendLine ?? appendLogLine;
  const logFilePath = options.logFilePath ?? resolveLogFilePath();
  const now = options.now ?? (() => new Date());

  return (err, context): void => {
    try {
      writeLine(
        logFilePath,
        formatLogLine("ERROR", [`${EXT_PREFIX} ${context}:`, err], now),
      );
    } catch {
      // Error reporting must never reintroduce terminal output or break the TUI.
    }
  };
}

function formatLogLine(
  level: ConsoleLevel,
  args: any[],
  now: () => Date,
): string {
  let message: string;
  try {
    message = formatConsoleArguments(...args);
  } catch {
    message = args.map((value) => String(value)).join(" ");
  }
  return `[${now().toISOString()}] ${level} ${message}\n`;
}

/**
 * Create a console bridge for one console target.
 *
 * This injectable surface keeps the observable behavior testable while the
 * extension-level installer below provides process-wide deduplication.
 */
export function createConsoleLogBridge(
  options: ConsoleLogBridgeOptions = {},
): ConsoleLogBridge {
  const target = options.console ?? (console as unknown as ConsoleTarget);
  const originalMethods = {} as Record<ConsoleMethodName, ConsoleMethod>;
  const wrappedMethods = {} as Record<ConsoleMethodName, ConsoleMethod>;
  const writeLine = options.appendLine ?? appendLogLine;
  const logFilePath = options.logFilePath ?? resolveLogFilePath();
  const now = options.now ?? (() => new Date());
  let interactive = false;
  let disposed = false;

  const capture = (level: ConsoleLevel, args: any[]): void => {
    try {
      writeLine(logFilePath, formatLogLine(level, args, now));
    } catch {
      // A custom integration sink must not be able to break the TUI.
    }
  };

  for (const [method, level] of CONSOLE_METHODS) {
    const original = target[method];
    originalMethods[method] = original;
    const wrapped = (...args: any[]) => {
      if (interactive && !disposed) {
        capture(level, args);
        return;
      }
      Reflect.apply(original, target, args);
    };
    wrappedMethods[method] = wrapped;
    target[method] = wrapped;
  }

  return {
    setInteractive(active: boolean): void {
      if (!disposed) interactive = active;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [method] of CONSOLE_METHODS) {
        // Do not overwrite a newer wrapper installed by another extension.
        if (target[method] === wrappedMethods[method]) {
          target[method] = originalMethods[method];
        }
      }
    },
  };
}

function createGlobalHandle(
  state: GlobalBridgeState,
  owner: symbol,
  globalObject: typeof globalThis & {
    [GLOBAL_BRIDGE_KEY]?: GlobalBridgeState;
  },
): ConsoleLogBridge {
  let disposed = false;
  return {
    setInteractive(active: boolean): void {
      if (disposed || state.latestOwner !== owner) return;
      state.baseBridge.setInteractive(active);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      state.handles.delete(owner);
      if (state.latestOwner === owner) {
        state.latestOwner = undefined;
        state.baseBridge.setInteractive(false);
      }
      if (state.handles.size === 0 && globalObject[GLOBAL_BRIDGE_KEY] === state) {
        state.baseBridge.dispose();
        delete globalObject[GLOBAL_BRIDGE_KEY];
      }
    },
  };
}

/**
 * Install one process-wide bridge. Pi may recreate an extension runtime on
 * reload, so a global symbol prevents nested wrappers and stale runtimes are
 * prevented from changing the routing owned by the latest runtime.
 */
export function installConsoleLogBridge(
  options: ConsoleLogBridgeOptions = {},
): ConsoleLogBridge {
  const globalObject = globalThis as typeof globalThis & {
    [GLOBAL_BRIDGE_KEY]?: GlobalBridgeState;
  };
  const existing = globalObject[GLOBAL_BRIDGE_KEY];
  const owner = Symbol("pi-tokyo-night-console-bridge-owner");

  if (existing) {
    existing.handles.add(owner);
    existing.latestOwner = owner;
    return createGlobalHandle(existing, owner, globalObject);
  }

  const state: GlobalBridgeState = {
    baseBridge: createConsoleLogBridge(options),
    handles: new Set([owner]),
    latestOwner: owner,
  };
  globalObject[GLOBAL_BRIDGE_KEY] = state;
  return createGlobalHandle(state, owner, globalObject);
}
