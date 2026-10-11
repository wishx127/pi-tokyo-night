import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { format as formatConsoleArguments } from "node:util";
import { EXT_PREFIX, type ExtensionErrorSink } from "./errors";

export const TOKYO_NIGHT_LOG_FILE = "pi-tokyo-night.log";
export const TOKYO_NIGHT_LOG_MAX_BYTES = 1024 * 1024;

const TOKYO_NIGHT_LOG_RETAIN_BYTES = TOKYO_NIGHT_LOG_MAX_BYTES / 2;
const TOKYO_NIGHT_LOG_BATCH_BYTES = 64 * 1024;
// At most 1 MiB waits in memory and at most 1 MiB is being written. The
// record limit includes both queues; oversized records are written alone.
const TOKYO_NIGHT_LOG_MAX_PENDING_BYTES = TOKYO_NIGHT_LOG_MAX_BYTES;
const TOKYO_NIGHT_LOG_MAX_ENTRIES = 2_048;
const TOKYO_NIGHT_LOG_MAX_PATHS = 128;
const GLOBAL_BRIDGE_KEY = Symbol.for("pi-tokyo-night.console-log-bridge");
const GLOBAL_WRITER_KEY = Symbol.for("pi-tokyo-night.console-log-writer");

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

interface PendingLogEntry {
  sequence: number;
  filePath: string;
  line: string;
  bytes: number;
}

interface LogFlushWaiter {
  sequence: number;
  resolve(): void;
}

interface DroppedLogEntries {
  filePath: string;
  firstSequence: number;
  count: number;
  crossFileCount?: number;
}

interface LogWriteBatch {
  entries: PendingLogEntry[];
  dropped?: DroppedLogEntries;
}

interface LogWriterState {
  pending: Map<number, PendingLogEntry>;
  pendingBytes: number;
  inFlight: LogWriteBatch | undefined;
  dropped: Map<string, DroppedLogEntries>;
  lastSequence: number;
  scheduled: ReturnType<typeof setImmediate> | undefined;
  draining: boolean;
  preparedDirectories: Set<string>;
  disabledFiles: Set<string>;
  flushWaiters: Set<LogFlushWaiter>;
}

function getLogWriterState(): LogWriterState {
  const globalObject = globalThis as typeof globalThis & {
    [GLOBAL_WRITER_KEY]?: LogWriterState;
  };
  return globalObject[GLOBAL_WRITER_KEY] ??= {
    pending: new Map(),
    pendingBytes: 0,
    inFlight: undefined,
    dropped: new Map(),
    lastSequence: 0,
    scheduled: undefined,
    draining: false,
    preparedDirectories: new Set(),
    disabledFiles: new Set(),
    flushWaiters: new Set(),
  };
}

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

function rememberRecentPath(paths: Set<string>, value: string): void {
  paths.delete(value);
  paths.add(value);
  if (paths.size > TOKYO_NIGHT_LOG_MAX_PATHS) paths.delete(paths.values().next().value!);
}

function hasRecentPath(paths: Set<string>, value: string): boolean {
  if (!paths.has(value)) return false;
  rememberRecentPath(paths, value);
  return true;
}

function appendLogLine(filePath: string, line: string): void {
  const state = getLogWriterState();
  if (hasRecentPath(state.disabledFiles, filePath)) return;
  const sequence = ++state.lastSequence;
  const boundedLine = limitLogEntry(line, TOKYO_NIGHT_LOG_MAX_PENDING_BYTES);
  const bytes = Buffer.byteLength(boundedLine, "utf8");
  const entry = { sequence, filePath, line: boundedLine, bytes };
  while (
    state.pendingBytes + bytes > TOKYO_NIGHT_LOG_MAX_PENDING_BYTES ||
    state.pending.size + (state.inFlight?.entries.length ?? 0) >= TOKYO_NIGHT_LOG_MAX_ENTRIES
  ) {
    const oldest = state.pending.values().next().value;
    if (!oldest) {
      recordDroppedLogEntry(state, entry);
      scheduleLogDrain(state);
      return;
    }
    state.pending.delete(oldest.sequence);
    state.pendingBytes -= oldest.bytes;
    recordDroppedLogEntry(state, oldest);
  }
  state.pending.set(sequence, entry);
  state.pendingBytes += bytes;
  scheduleLogDrain(state);
}

function recordDroppedLogEntry(state: LogWriterState, entry: PendingLogEntry): void {
  const dropped = state.dropped.get(entry.filePath);
  if (dropped) {
    dropped.count++;
    dropped.firstSequence = Math.min(dropped.firstSequence, entry.sequence);
  } else if (state.dropped.size >= TOKYO_NIGHT_LOG_MAX_PATHS) {
    let oldest: DroppedLogEntries | undefined;
    for (const existing of state.dropped.values()) {
      if (!oldest || existing.firstSequence < oldest.firstSequence) oldest = existing;
    }
    // Keep the total loss count without retaining every overflow file path.
    oldest!.count++;
    oldest!.crossFileCount = (oldest!.crossFileCount ?? 0) + 1;
    oldest!.firstSequence = Math.min(oldest!.firstSequence, entry.sequence);
  } else {
    state.dropped.set(entry.filePath, {
      filePath: entry.filePath,
      firstSequence: entry.sequence,
      count: 1,
    });
  }
}

function settleLogFlushWaiters(state: LogWriterState): void {
  const firstPending = state.pending.values().next().value;
  for (const waiter of state.flushWaiters) {
    if (
      (firstPending && firstPending.sequence <= waiter.sequence) ||
      (state.inFlight?.entries[0] && state.inFlight.entries[0].sequence <= waiter.sequence) ||
      (state.inFlight?.dropped && state.inFlight.dropped.firstSequence <= waiter.sequence) ||
      Array.from(state.dropped.values()).some((entry) => entry.firstSequence <= waiter.sequence)
    ) continue;
    state.flushWaiters.delete(waiter);
    waiter.resolve();
  }
}

function takeNextLogWrite(state: LogWriterState): LogWriteBatch | undefined {
  const firstPending = state.pending.values().next().value;
  let firstDropped: DroppedLogEntries | undefined;
  for (const dropped of state.dropped.values()) {
    if (!firstDropped || dropped.firstSequence < firstDropped.firstSequence) firstDropped = dropped;
  }
  if (firstDropped && (!firstPending || firstDropped.firstSequence < firstPending.sequence)) {
    state.dropped.delete(firstDropped.filePath);
    return { entries: [], dropped: firstDropped };
  }
  return firstPending ? { entries: takeLogBatch(state) } : undefined;
}

function takeLogBatch(state: LogWriterState): PendingLogEntry[] {
  const first = state.pending.values().next().value;
  if (!first) return [];
  let flushBoundary = Infinity;
  for (const waiter of state.flushWaiters) {
    if (waiter.sequence >= first.sequence) flushBoundary = Math.min(flushBoundary, waiter.sequence);
  }
  const entries: PendingLogEntry[] = [];
  let bytes = 0;
  for (const entry of state.pending.values()) {
    if (
      entry.filePath !== first.filePath ||
      entry.sequence > flushBoundary ||
      (entries.length > 0 && bytes + entry.bytes > TOKYO_NIGHT_LOG_BATCH_BYTES)
    ) break;
    entries.push(entry);
    bytes += entry.bytes;
    state.pending.delete(entry.sequence);
    state.pendingBytes -= entry.bytes;
    if (bytes >= TOKYO_NIGHT_LOG_BATCH_BYTES) break;
  }
  return entries;
}

function discardPendingLogFile(state: LogWriterState, filePath: string): void {
  let crossFileCount = 0;
  let firstSequence = Infinity;
  for (const dropped of [state.inFlight?.dropped, state.dropped.get(filePath)]) {
    if (dropped?.filePath !== filePath || !dropped.crossFileCount) continue;
    crossFileCount += dropped.crossFileCount;
    firstSequence = Math.min(firstSequence, dropped.firstSequence);
  }
  for (const entry of state.pending.values()) {
    if (entry.filePath !== filePath) continue;
    state.pending.delete(entry.sequence);
    state.pendingBytes -= entry.bytes;
  }
  state.dropped.delete(filePath);
  if (crossFileCount === 0) return;

  let recipient: DroppedLogEntries | undefined;
  for (const dropped of state.dropped.values()) {
    if (state.disabledFiles.has(dropped.filePath)) continue;
    if (!recipient || dropped.firstSequence < recipient.firstSequence) recipient = dropped;
  }
  if (!recipient && state.dropped.size < TOKYO_NIGHT_LOG_MAX_PATHS) {
    for (const entry of state.pending.values()) {
      if (state.disabledFiles.has(entry.filePath)) continue;
      recipient = { filePath: entry.filePath, firstSequence, count: 0 };
      state.dropped.set(entry.filePath, recipient);
      break;
    }
  }
  if (!recipient) return;
  // A failed anchor owns only its local losses; other files still need a notice.
  recipient.count += crossFileCount;
  recipient.crossFileCount = (recipient.crossFileCount ?? 0) + crossFileCount;
  recipient.firstSequence = Math.min(recipient.firstSequence, firstSequence);
}

async function drainLogWrites(state: LogWriterState): Promise<void> {
  while (state.pending.size > 0 || state.dropped.size > 0) {
    const batch = takeNextLogWrite(state)!;
    const filePath = batch.dropped?.filePath ?? batch.entries[0]!.filePath;
    state.inFlight = batch;
    try {
      if (hasRecentPath(state.disabledFiles, filePath)) {
        discardPendingLogFile(state, filePath);
        continue;
      }
      const directory = path.dirname(filePath);
      if (!hasRecentPath(state.preparedDirectories, directory)) {
        await fs.promises.mkdir(directory, { recursive: true });
        rememberRecentPath(state.preparedDirectories, directory);
      }
      // Ordinary batches fit below the retained half-file. A larger entry is
      // written alone so the file limiter never truncates later batch entries.
      const droppedScope = batch.dropped?.crossFileCount
        ? ` across log files (${batch.dropped.crossFileCount} from other log files)`
        : "";
      const content = batch.dropped
        ? `[${new Date().toISOString()}] WARN ${EXT_PREFIX} dropped ${batch.dropped.count} oldest pending log entries${droppedScope} due to queue limit.\n`
        : batch.entries.length === 1
          ? batch.entries[0]!.line
          : batch.entries.map((entry) => entry.line).join("");
      await appendBoundedLogLine(filePath, content);
    } catch {
      // Never fall back to console: that would reintroduce raw TUI output.
      rememberRecentPath(state.disabledFiles, filePath);
      discardPendingLogFile(state, filePath);
    } finally {
      state.inFlight = undefined;
      settleLogFlushWaiters(state);
    }
  }
}

function scheduleLogDrain(state: LogWriterState): void {
  if (state.scheduled || state.draining) return;
  state.scheduled = setImmediate(() => {
    state.scheduled = undefined;
    state.draining = true;
    void drainLogWrites(state).finally(() => {
      state.draining = false;
      settleLogFlushWaiters(state);
      if (state.pending.size > 0 || state.dropped.size > 0) scheduleLogDrain(state);
    });
  });
}

export async function flushConsoleLogWrites(): Promise<void> {
  const state = getLogWriterState();
  await new Promise<void>((resolve) => {
    state.flushWaiters.add({ sequence: state.lastSequence, resolve });
    settleLogFlushWaiters(state);
  });
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
