import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export type DashboardRange = 3 | 7 | 30 | "all";

export interface UsageRecord {
  timestamp: number;
  provider: string;
  model: string;
  tokens: number;
}

export interface UsageHistory {
  records: readonly UsageRecord[];
  /** Local wall-clock time at which the session history was scanned. */
  collectedAt?: number;
}

export interface DailyUsage {
  dayStart: number;
  tokens: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  tokens: number;
  /** Token usage per selected natural-day bucket. */
  dailyTokens: number[];
}

export interface UsageDashboardSummary {
  totalTokens: number;
  daily: readonly DailyUsage[];
  models: readonly ModelUsage[];
}

export interface ReadUsageHistoryOptions {
  sessionsDirectory?: string;
  now?: Date;
  signal?: AbortSignal;
  /** Defaults to an extension-owned metadata cache; null disables caching. */
  cachePath?: string | null;
}

type ParsedUsageRecord = {
  record: UsageRecord;
  key?: string;
};

type CachedUsageRecord = {
  timestamp: number;
  provider: string;
  model: string;
  tokens: number;
  key?: string;
};

type CachedFileState = {
  size: number;
  mtimeMs: number;
  records: CachedUsageRecord[];
};

const USAGE_HISTORY_CACHE_VERSION = 1;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400] as const;

export function getUsageHistoryCachePath(agentDir = getAgentDir()): string {
  return join(agentDir, "extensions", "pi-tokyo-night-usage-history-cache.json");
}

function startOfDay(value: Date): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayStartOffset(today: Date, offset: number): number {
  const date = new Date(today);
  date.setDate(date.getDate() + offset);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Summarize directly attributable assistant-message usage by local calendar day. */
export function summarizeUsageHistory(
  history: UsageHistory,
  range: DashboardRange,
  now = new Date(),
): UsageDashboardSummary {
  const windowEnd = dayStartOffset(now, 1);
  const firstTimestamp = range === "all"
    ? history.records.reduce<number | undefined>((earliest, record) => {
      if (
        !Number.isFinite(record.timestamp) ||
        !Number.isFinite(record.tokens) ||
        record.tokens <= 0 ||
        record.timestamp >= windowEnd
      ) {
        return earliest;
      }
      return earliest === undefined || record.timestamp < earliest
        ? record.timestamp
        : earliest;
    }, undefined)
    : undefined;
  const windowStart = range === "all"
    ? firstTimestamp === undefined
      ? startOfDay(now)
      : startOfDay(new Date(firstTimestamp))
    : dayStartOffset(now, 1 - range);
  const daily: DailyUsage[] = [];
  for (const day = new Date(windowStart); day.getTime() < windowEnd; day.setDate(day.getDate() + 1)) {
    day.setHours(0, 0, 0, 0);
    daily.push({ dayStart: day.getTime(), tokens: 0 });
  }
  const dailyIndex = new Map(daily.map((day, index) => [day.dayStart, index]));
  const models = new Map<string, ModelUsage>();

  for (const record of history.records) {
    if (
      !Number.isFinite(record.timestamp) ||
      !Number.isFinite(record.tokens) ||
      record.tokens <= 0 ||
      record.timestamp < windowStart ||
      record.timestamp >= windowEnd
    ) {
      continue;
    }

    const dayIndex = dailyIndex.get(startOfDay(new Date(record.timestamp)));
    if (dayIndex === undefined) continue;
    daily[dayIndex]!.tokens += record.tokens;

    const key = `${record.provider}\u0000${record.model}`;
    const existing = models.get(key);
    if (existing) {
      existing.tokens += record.tokens;
      existing.dailyTokens[dayIndex]! += record.tokens;
    } else {
      const dailyTokens = new Array<number>(daily.length).fill(0);
      dailyTokens[dayIndex] = record.tokens;
      models.set(key, {
        provider: record.provider,
        model: record.model,
        tokens: record.tokens,
        dailyTokens,
      });
    }
  }

  const modelDistribution = Array.from(models.values()).sort((left, right) =>
    right.tokens - left.tokens ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model)
  );

  return {
    totalTokens: daily.reduce((total, day) => total + day.tokens, 0),
    daily,
    models: modelDistribution,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseModelIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && !/[\u0000-\u001F\u007F-\u009F]/.test(normalized)
    ? normalized
    : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAssistantUsageEntry(line: string): ParsedUsageRecord | undefined {
  // Skip the large tool-result and user-content lines that dominate session
  // histories before parsing JSON. The shape check below rejects false matches.
  if (!line.includes('"role"') || !line.includes('"assistant"')) return undefined;

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
    return undefined;
  }

  const message = entry.message;
  if (message.role !== "assistant" || !isRecord(message.usage)) {
    return undefined;
  }
  const provider = parseModelIdentity(message.provider);
  const model = parseModelIdentity(message.model);
  if (!provider || !model) return undefined;

  const input = finiteNonNegative(message.usage.input) ?? 0;
  const output = finiteNonNegative(message.usage.output) ?? 0;
  const cacheWrite = finiteNonNegative(message.usage.cacheWrite) ?? 0;
  const tokens = input + output + cacheWrite;
  const timestamp = parseTimestamp(message.timestamp) ?? parseTimestamp(entry.timestamp);
  if (tokens <= 0 || timestamp === undefined) return undefined;

  const record = {
    timestamp,
    provider,
    model,
    tokens,
  };
  const id = typeof entry.id === "string" ? entry.id : "";
  return {
    record,
    ...(id ? { key: `id:${id}` } : {}),
  };
}

const MAX_NON_ASSISTANT_PREFIX_CHARS = 64 * 1024;
// Normal Pi entries put `role` first. If a differently ordered message object
// has not exposed that role yet, keep buffering: it may be a valid large
// assistant response rather than an ignorable tool result.
const DIRECT_MESSAGE_ROLE_PATTERN =
  /"message"\s*:\s*\{\s*"role"\s*:\s*"([^"\\]*)"/;
const MESSAGE_OBJECT_PATTERN = /"message"\s*:\s*\{/;

function shouldDiscardLargeLine(line: string): boolean {
  const directRole = DIRECT_MESSAGE_ROLE_PATTERN.exec(line)?.[1];
  if (directRole !== undefined) return directRole !== "assistant";
  return !MESSAGE_OBJECT_PATTERN.test(line);
}

function appendUsageRecord(
  line: string,
  records: ParsedUsageRecord[],
): void {
  const parsed = parseAssistantUsageEntry(line);
  if (parsed) records.push(parsed);
}

async function collectSessionFiles(
  directory: string,
  files: string[],
  signal?: AbortSignal,
  required = false,
): Promise<void> {
  if (signal?.aborted) return;
  try {
    const entries = await readdir(directory, {
      encoding: "utf8",
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (signal?.aborted) return;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectSessionFiles(entryPath, files, signal);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  } catch (error) {
    if (required) throw error;
    // Skip unreadable nested directories and continue with the rest of history.
  }
}

async function readSessionFile(
  filePath: string,
  records: ParsedUsageRecord[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;

  let stream: ReturnType<typeof createReadStream> | undefined;
  const abortStream = (): void => {
    stream?.destroy();
  };
  signal?.addEventListener("abort", abortStream, { once: true });
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
    if (signal?.aborted) {
      stream.destroy();
      return false;
    }
    let line = "";
    let discardLine = false;
    const appendChunk = (chunk: string): void => {
      if (discardLine) return;
      line += chunk;
      if (
        line.length >= MAX_NON_ASSISTANT_PREFIX_CHARS &&
        shouldDiscardLargeLine(line)
      ) {
        line = "";
        discardLine = true;
      }
    };
    const finishLine = (): void => {
      if (!discardLine) {
        appendUsageRecord(line, records);
      }
      line = "";
      discardLine = false;
    };

    for await (const chunk of stream) {
      if (signal?.aborted) {
        stream.destroy();
        return false;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let offset = 0;
      for (;;) {
        const newline = text.indexOf("\n", offset);
        if (newline === -1) {
          appendChunk(text.slice(offset));
          break;
        }
        appendChunk(text.slice(offset, newline));
        finishLine();
        offset = newline + 1;
      }
    }
    if (line.length > 0 && !signal?.aborted) finishLine();
  } catch {
    // A concurrently deleted or malformed session must not prevent the
    // remaining local history from rendering.
  } finally {
    signal?.removeEventListener("abort", abortStream);
    stream?.destroy();
  }
  return !signal?.aborted;
}

function isCachedUsageRecord(value: unknown): value is CachedUsageRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<CachedUsageRecord>;
  return (
    typeof record.timestamp === "number" && Number.isFinite(record.timestamp) &&
    typeof record.provider === "string" &&
    typeof record.model === "string" &&
    typeof record.tokens === "number" && Number.isFinite(record.tokens) &&
    (record.key === undefined || typeof record.key === "string")
  );
}

async function loadUsageHistoryCache(cachePath: string): Promise<Map<string, CachedFileState>> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    return new Map();
  }
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    (payload as { version?: unknown }).version !== USAGE_HISTORY_CACHE_VERSION
  ) {
    return new Map();
  }
  const files = (payload as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return new Map();
  }

  const cache = new Map<string, CachedFileState>();
  for (const [filePath, value] of Object.entries(files as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Partial<CachedFileState>;
    if (
      typeof entry.size !== "number" || !Number.isFinite(entry.size) ||
      typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs) ||
      !Array.isArray(entry.records) || !entry.records.every(isCachedUsageRecord)
    ) {
      continue;
    }
    cache.set(filePath, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      records: entry.records,
    });
  }
  return cache;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function renameCacheFile(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      const code = typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
      if (
        process.platform !== "win32" ||
        delay === undefined ||
        (code !== "EBUSY" && code !== "EACCES" && code !== "EPERM")
      ) {
        throw error;
      }
      await wait(delay);
    }
  }
}

async function saveUsageHistoryCache(
  cachePath: string,
  states: Map<string, CachedFileState>,
): Promise<void> {
  const files: Record<string, CachedFileState> = {};
  for (const [filePath, state] of states) files[filePath] = state;

  await mkdir(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify({ version: USAGE_HISTORY_CACHE_VERSION, files }),
      "utf8",
    );
    await renameCacheFile(temporaryPath, cachePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function cacheRecords(records: readonly ParsedUsageRecord[]): CachedUsageRecord[] {
  return records.map(({ record, key }) => ({ ...record, ...(key ? { key } : {}) }));
}

function cachedRecords(records: readonly CachedUsageRecord[]): ParsedUsageRecord[] {
  return records.map(({ timestamp, provider, model, tokens, key }) => ({
    record: { timestamp, provider, model, tokens },
    ...(key ? { key } : {}),
  }));
}

function cacheFingerprint(metadata: { size: number; mtimeMs: number }): {
  size: number;
  mtimeMs: number;
} {
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  };
}

function dedupeUsageRecords(records: readonly ParsedUsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  const result: UsageRecord[] = [];
  for (const entry of records) {
    if (entry.key !== undefined) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
    }
    result.push(entry.record);
  }
  return result;
}

/** Read directly attributable assistant usage from every local Pi session. */
export async function readUsageHistory(
  options: ReadUsageHistoryOptions = {},
): Promise<UsageHistory | null> {
  const now = options.now ?? new Date();
  const sessionsDirectory = options.sessionsDirectory ?? join(getAgentDir(), "sessions");
  const cachePath = options.cachePath === undefined
    ? options.sessionsDirectory === undefined
      ? getUsageHistoryCachePath()
      : null
    : options.cachePath;
  const files: string[] = [];
  await collectSessionFiles(sessionsDirectory, files, options.signal, true);
  if (options.signal?.aborted) return null;

  const previous = cachePath ? await loadUsageHistoryCache(cachePath) : new Map();
  if (options.signal?.aborted) return null;

  files.sort();
  const current = new Map<string, CachedFileState>();
  const uncachedRecords: ParsedUsageRecord[] = [];
  const scannedFiles = new Set<string>();
  let dirty = false;

  for (const filePath of files) {
    if (options.signal?.aborted) return null;
    let before: { size: number; mtimeMs: number };
    try {
      before = cacheFingerprint(await stat(filePath));
    } catch {
      dirty = true;
      continue;
    }
    scannedFiles.add(filePath);

    const cached = previous.get(filePath);
    if (cached && cached.size === before.size && cached.mtimeMs === before.mtimeMs) {
      current.set(filePath, cached);
      continue;
    }

    dirty = true;
    const parsed: ParsedUsageRecord[] = [];
    const completed = await readSessionFile(filePath, parsed, options.signal);
    if (!completed || options.signal?.aborted) return null;

    try {
      const after = cacheFingerprint(await stat(filePath));
      if (after.size === before.size && after.mtimeMs === before.mtimeMs) {
        current.set(filePath, {
          ...before,
          records: cacheRecords(parsed),
        });
        continue;
      }
    } catch {
      // A live append or deletion remains usable for this view, but is not cached.
    }
    uncachedRecords.push(...parsed);
  }

  for (const filePath of previous.keys()) {
    if (!scannedFiles.has(filePath)) dirty = true;
  }

  if (cachePath && dirty && !options.signal?.aborted) {
    await saveUsageHistoryCache(cachePath, current).catch(() => {
      // Cache failures only make a later Dashboard open slower.
    });
    if (options.signal?.aborted) return null;
  }

  const parsedRecords = [
    ...Array.from(current.values()).flatMap((state) => cachedRecords(state.records)),
    ...uncachedRecords,
  ];
  return {
    records: dedupeUsageRecords(parsedRecords),
    collectedAt: now.getTime(),
  };
}
