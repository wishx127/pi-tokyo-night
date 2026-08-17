import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { format as formatConsoleArguments } from "node:util";
import { EXT_PREFIX, type ExtensionErrorSink } from "./errors";

export const TOKYO_NIGHT_LOG_FILE = "pi-tokyo-night.log";

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
      await fs.promises.appendFile(filePath, line, "utf8");
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
