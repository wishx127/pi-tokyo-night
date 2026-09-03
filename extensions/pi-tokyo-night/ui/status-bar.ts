import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  formatStatus,
  isCodexModel,
  isKimiUsageOriginAllowed,
  type CodexUsageStore,
  type KimiUsageStore,
  type UsageSnapshot,
} from "../usage";
import {
  DEFAULT_STATUS_MODULES,
  type StatusModulesConfig,
  type TokyoConfigManager,
} from "../core/config";
import { handleExtensionError } from "../core/errors";
import { resolveIcons, type StatusIcons } from "./icons";
import {
  createTokyoNightPalette,
  type TokyoNightBackgroundRole,
  type TokyoNightForegroundRole,
  type TokyoNightThemePalette,
} from "./theme-palette";
import { RESET_BG } from "./ui-primitives";

type Module = {
  text: string;
  bg: TokyoNightBackgroundRole | null;
  fg: TokyoNightForegroundRole;
  noEndArrow?: boolean;
};

/** Mirror Pi's native footer thresholds so large usage switches from k to M. */
function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function buildDetailedTokenUsage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cacheHitRate: number | undefined,
  icons: StatusIcons,
): string {
  const parts: string[] = [];
  if (input) parts.push(`↑${formatTokenCount(input)}`);
  if (output) parts.push(`↓${formatTokenCount(output)}`);
  if (cacheRead) parts.push(`R${formatTokenCount(cacheRead)}`);
  if (cacheWrite) parts.push(`W${formatTokenCount(cacheWrite)}`);
  if (parts.length === 0) return `${icons.tokens} 0 tokens`;
  if (cacheHitRate !== undefined) {
    parts.push(`CH${cacheHitRate.toFixed(1)}%`);
  }
  return parts.join(" ");
}

// Shared "LIMIT" module for provider quota (Codex via response headers,
// Kimi via polled usages API — both render through formatStatus).
const buildLimitModule = (snap: UsageSnapshot | undefined): Module[] =>
  snap
    ? [{
        text: `LIMIT ${formatStatus(snap)}`,
        bg: "quota",
        fg: "statusLimit",
      }]
    : [];

export type LiveSessionUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

type SessionStats = LiveSessionUsage;

type CacheUsage = Pick<
  AssistantMessage["usage"],
  "input" | "cacheRead" | "cacheWrite"
>;

type SessionUsageSummary = {
  stats: SessionStats;
  cacheHitRate: number | undefined;
};

type StatsCacheEntry = {
  sessionId: string | undefined;
  leafId: string;
  summary: SessionUsageSummary;
};

type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

type ContextUsageGetter = () => ContextUsage | undefined;

type ContextUsageCacheEntry = {
  sessionId: string | undefined;
  leafId: string | null | undefined;
  model: ExtensionContext["model"];
  capturedAt: number;
  usage: ContextUsage | undefined;
};

// Session entries are append-only between leaf changes. Keep this cache keyed
// by manager identity so a reused module can never share stats between sessions.
const sessionStatsCache = new WeakMap<object, StatsCacheEntry>();

// Context usage can change while a leaf is streaming, so this is intentionally
// time-bounded rather than leaf-only. A one-second sample keeps the status
// responsive without traversing a long session branch on animation frames.
const CONTEXT_USAGE_CACHE_TTL_MS = 1000;
const contextUsageCache = new WeakMap<object, ContextUsageCacheEntry>();

function getContextUsageIdentity(ctx: ExtensionContext): {
  manager: object;
  sessionId: string | undefined;
  leafId: string | null | undefined;
  model: ExtensionContext["model"];
} {
  const manager = ctx.sessionManager as unknown as {
    getLeafId?: () => string | null;
    getSessionId?: () => string;
  };
  let sessionId: string | undefined;
  let leafId: string | null | undefined;
  try {
    sessionId = typeof manager.getSessionId === "function"
      ? manager.getSessionId()
      : undefined;
    leafId = typeof manager.getLeafId === "function"
      ? manager.getLeafId()
      : undefined;
  } catch {
    // Cache by manager and TTL when a host-provided identity method is absent
    // or temporarily unavailable; rendering must remain best-effort.
  }
  return {
    manager: ctx.sessionManager as unknown as object,
    sessionId,
    leafId,
    model: ctx.model,
  };
}

function getCachedContextUsage(
  ctx: ExtensionContext,
  getContextUsage: ContextUsageGetter,
): ContextUsage | undefined {
  const identity = getContextUsageIdentity(ctx);
  const now = Date.now();
  const cached = contextUsageCache.get(identity.manager);
  if (
    cached &&
    cached.sessionId === identity.sessionId &&
    cached.leafId === identity.leafId &&
    cached.model === identity.model &&
    now >= cached.capturedAt &&
    now - cached.capturedAt < CONTEXT_USAGE_CACHE_TTL_MS
  ) {
    return cached.usage;
  }

  const usage = getContextUsage.call(ctx);
  contextUsageCache.set(identity.manager, {
    sessionId: identity.sessionId,
    leafId: identity.leafId,
    model: identity.model,
    capturedAt: Date.now(),
    usage,
  });
  return usage;
}

function cacheUsage(value: unknown): CacheUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Partial<CacheUsage>;
  if (
    typeof usage.input !== "number" || !Number.isFinite(usage.input) ||
    typeof usage.cacheRead !== "number" || !Number.isFinite(usage.cacheRead) ||
    typeof usage.cacheWrite !== "number" || !Number.isFinite(usage.cacheWrite)
  ) return undefined;
  return {
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

function sessionUsage(value: unknown): SessionStats | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown };
  };
  if (
    typeof usage.input !== "number" || !Number.isFinite(usage.input) ||
    typeof usage.output !== "number" || !Number.isFinite(usage.output)
  ) return undefined;
  const optionalCount = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : 0;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: optionalCount(usage.cacheRead),
    cacheWrite: optionalCount(usage.cacheWrite),
    cost: optionalCount(usage.cost?.total),
  };
}

function calculateSessionSummary(ctx: ExtensionContext): SessionUsageSummary {
  const stats: SessionStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  let cacheReported = false;
  let latestAssistantCacheValid = false;
  let latestRate: number | undefined;
  try {
    const manager = ctx.sessionManager as unknown as {
      getEntries?: () => unknown[];
    };
    if (typeof manager.getEntries !== "function") {
      return { stats, cacheHitRate: undefined };
    }
    const entries = manager.getEntries();
    for (const candidate of entries) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const entry = candidate as {
        type?: unknown;
        message?: { role?: unknown; usage?: unknown };
        usage?: unknown;
      };
      const assistant =
        entry.type === "message" && entry.message?.role === "assistant";
      const rawUsage = entry.type === "message" &&
          (assistant || entry.message?.role === "toolResult")
        ? entry.message?.usage
        : (entry.type === "compaction" || entry.type === "branch_summary")
          ? entry.usage
          : undefined;
      if (rawUsage === undefined) continue;

      const totalsUsage = sessionUsage(rawUsage);
      if (totalsUsage) {
        stats.input += totalsUsage.input;
        stats.output += totalsUsage.output;
        stats.cacheRead += totalsUsage.cacheRead;
        stats.cacheWrite += totalsUsage.cacheWrite;
        stats.cost += totalsUsage.cost;
      }
      const nativeCacheUsage = cacheUsage(rawUsage);
      if (assistant) {
        latestAssistantCacheValid = nativeCacheUsage !== undefined;
        if (!nativeCacheUsage) {
          latestRate = undefined;
          continue;
        }
        const promptTokens = nativeCacheUsage.input +
          nativeCacheUsage.cacheRead +
          nativeCacheUsage.cacheWrite;
        latestRate = promptTokens > 0
          ? (nativeCacheUsage.cacheRead / promptTokens) * 100
          : undefined;
      } else if (!nativeCacheUsage) {
        continue;
      }
      if (nativeCacheUsage.cacheRead > 0 || nativeCacheUsage.cacheWrite > 0) {
        cacheReported = true;
      }
    }
  } catch (error) {
    handleExtensionError(error, "session usage summary");
    return { stats, cacheHitRate: undefined };
  }
  return {
    stats,
    cacheHitRate: latestAssistantCacheValid && cacheReported
      ? latestRate
      : undefined,
  };
}

function getSessionSummary(ctx: ExtensionContext): SessionUsageSummary {
  const manager = ctx.sessionManager as unknown as object;
  const getLeafId = (
    ctx.sessionManager as unknown as { getLeafId?: () => string | null }
  ).getLeafId;
  if (typeof getLeafId !== "function") return calculateSessionSummary(ctx);

  try {
    const leafId = getLeafId.call(ctx.sessionManager);
    if (leafId == null) return calculateSessionSummary(ctx);
    const getSessionId = (
      ctx.sessionManager as unknown as { getSessionId?: () => string }
    ).getSessionId;
    const sessionId = typeof getSessionId === "function"
      ? getSessionId.call(ctx.sessionManager)
      : undefined;
    const cached = sessionStatsCache.get(manager);
    if (
      cached &&
      cached.leafId === leafId &&
      cached.sessionId === sessionId
    ) return cached.summary;

    const summary = calculateSessionSummary(ctx);
    sessionStatsCache.set(manager, { sessionId, leafId, summary });
    return summary;
  } catch (error) {
    handleExtensionError(error, "session usage summary cache");
    return calculateSessionSummary(ctx);
  }
}

/** Mirror Pi's native Footer calculation for the latest Assistant request. */
export function getLatestCacheHitRate(
  ctx: ExtensionContext,
): number | undefined {
  return getSessionSummary(ctx).cacheHitRate;
}

export function invalidateSessionStats(ctx: ExtensionContext): void {
  sessionStatsCache.delete(ctx.sessionManager as unknown as object);
}

export function getSessionStats(ctx: ExtensionContext): LiveSessionUsage {
  return getSessionSummary(ctx).stats;
}

function getActiveBranchAssistantTokens(ctx: ExtensionContext): number {
  let tokens = 0;
  try {
    for (const candidate of ctx.sessionManager.getBranch()) {
      if (
        candidate.type === "message" &&
        candidate.message.role === "assistant"
      ) {
        const usage = sessionUsage(candidate.message.usage);
        if (usage) tokens += usage.input + usage.output;
      }
    }
  } catch (error) {
    handleExtensionError(error, "context fallback usage");
  }
  return tokens;
}

const getModuleBg = (m: Module): TokyoNightBackgroundRole | null => m.bg;

// Powerline transition arrow between two modules (1-char wide)
const buildTransition = (
  from: Module,
  to: Module,
  icons: StatusIcons,
  palette: TokyoNightThemePalette,
): string => palette.transition(from.bg, to.bg, icons.transition);

const getModuleText = (m: Module): string => ` ${m.text} `;
const getModuleWidth = (m: Module): number => visibleWidth(getModuleText(m));
const formatIconLabel = (icon: string, label: string): string =>
  icon ? `${icon} ${label}` : label;

const buildModule = (m: Module, palette: TokyoNightThemePalette): string => {
  const text = palette.fg(m.fg, getModuleText(m));
  return m.bg === null ? `${RESET_BG}${text}` : palette.bg(m.bg, text);
};

// Build a section (array of modules) with Powerline transitions
const buildSection = (
  modules: Module[],
  icons: StatusIcons,
  palette: TokyoNightThemePalette,
) => {
  let result = "";
  let currentWidth = 0;

  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];

    // Powerline transition before module (except first)
    if (i > 0) {
      const transition = buildTransition(modules[i - 1], m, icons, palette);
      result += transition;
      currentWidth += visibleWidth(transition);
    }

    result += buildModule(m, palette);
    currentWidth += getModuleWidth(m);
  }

  return { result, currentWidth };
};

type StatusLayout = {
  oneLine: string;
  modules: Module[];
  icons: StatusIcons;
  palette: TokyoNightThemePalette;
};

const END_MODULE: Module = {
  text: "",
  bg: null,
  fg: "statusContext",
};

const buildEndArrow = (
  module: Module,
  icons: StatusIcons,
  palette: TokyoNightThemePalette,
): string =>
  module.noEndArrow ? "" : buildTransition(module, END_MODULE, icons, palette);

function buildRow(
  modules: Module[],
  icons: StatusIcons,
  palette: TokyoNightThemePalette,
): string {
  if (modules.length === 0) return "";
  return `${buildSection(modules, icons, palette).result}${buildEndArrow(modules[modules.length - 1], icons, palette)}`;
}

function buildResponsiveRows(
  modules: Module[],
  width: number,
  icons: StatusIcons,
  palette: TokyoNightThemePalette,
): string[] {
  if (width <= 0 || modules.length === 0) return [];

  const firstArrow = buildEndArrow(modules[0], icons, palette);
  const firstArrowWidth = visibleWidth(firstArrow);
  if (width <= firstArrowWidth + 2) {
    return [truncateToWidth(firstArrow, width)];
  }

  const rows: string[] = [];
  let current: Module[] = [];
  let currentWidth = 0;

  const flush = () => {
    if (current.length === 0) return;
    rows.push(buildRow(current, icons, palette));
    current = [];
    currentWidth = 0;
  };

  for (const module of modules) {
    const moduleWidth = getModuleWidth(module);
    const endArrowWidth = visibleWidth(buildEndArrow(module, icons, palette));

    if (current.length > 0) {
      const previous = current[current.length - 1];
      const transition = buildTransition(previous, module, icons, palette);
      const candidateWidth =
        currentWidth + visibleWidth(transition) + moduleWidth + endArrowWidth;

      if (candidateWidth <= width) {
        current.push(module);
        currentWidth += visibleWidth(transition) + moduleWidth;
        continue;
      }

      // The next complete module does not fit. Keep the current row intact
      // and try the module on a fresh row instead of truncating the row early.
      flush();
    }

    if (moduleWidth + endArrowWidth <= width) {
      current = [module];
      currentWidth = moduleWidth;
      continue;
    }

    // A module that cannot fit on an empty row may be truncated by its own
    // measured text width. The end arrow is always reserved separately.
    const textWidth = Math.max(0, width - endArrowWidth - 2);
    if (textWidth > 0) {
      const truncatedModule: Module = {
        ...module,
        text: truncateToWidth(module.text, textWidth),
      };
      current = [truncatedModule];
      currentWidth = getModuleWidth(truncatedModule);
      flush();
    } else {
      rows.push(truncateToWidth(buildEndArrow(module, icons, palette), width));
    }
  }

  flush();
  return rows;
}

function buildColoredFill(
  bgColor: TokyoNightBackgroundRole | null,
  width: number,
  palette: TokyoNightThemePalette,
): string {
  if (width <= 0) return "";
  const fill = " ".repeat(width);
  return bgColor === null ? `${RESET_BG}${fill}${RESET_BG}` : palette.bg(bgColor, fill);
}

function buildWideStatusLine(
  width: number,
  leftModules: Module[],
  rightModules: Module[],
  leftSection: ReturnType<typeof buildSection>,
  rightSection: ReturnType<typeof buildSection>,
  icons: StatusIcons,
  palette: TokyoNightThemePalette,
  stretchSides: boolean,
): string {
  if (leftModules.length === 0 && rightModules.length === 0) return "";

  const safeWidth = Math.max(1, width - 2);
  if (leftModules.length === 0) {
    const fillWidth = Math.max(1, safeWidth - rightSection.currentWidth);
    return `${buildColoredFill(getModuleBg(rightModules[0]), fillWidth, palette)}${rightSection.result}`;
  }
  if (rightModules.length === 0) {
    const fillWidth = Math.max(1, safeWidth - leftSection.currentWidth);
    return `${leftSection.result}${buildColoredFill(
      getModuleBg(leftModules[leftModules.length - 1]),
      fillWidth,
      palette,
    )}`;
  }

  const bridgeTransition = buildTransition(
    leftModules[leftModules.length - 1],
    rightModules[0],
    icons,
    palette,
  );
  const paddingWidth = Math.max(
    1,
    safeWidth - leftSection.currentWidth - visibleWidth(bridgeTransition) - rightSection.currentWidth,
  );
  if (!stretchSides) {
    return `${leftSection.result}${buildColoredFill(
      getModuleBg(leftModules[leftModules.length - 1]),
      paddingWidth,
      palette,
    )}${bridgeTransition}${rightSection.result}`;
  }

  const leftFillWidth = Math.ceil(paddingWidth / 2);
  const rightFillWidth = paddingWidth - leftFillWidth;
  return `${leftSection.result}${buildColoredFill(
    getModuleBg(leftModules[leftModules.length - 1]),
    leftFillWidth,
    palette,
  )}${bridgeTransition}${buildColoredFill(
    getModuleBg(rightModules[0]),
    rightFillWidth,
    palette,
  )}${rightSection.result}`;
}

function buildStatusLayout(
  width: number,
  theme: Theme,
  ctx: ExtensionContext,
  branch: string,
  thinkingLevel: string,
  config: TokyoConfigManager,
  codexUsageStore?: Pick<CodexUsageStore, "getSnapshot">,
  kimiUsageStore?: Pick<KimiUsageStore, "getSnapshot">,
  liveUsage?: LiveSessionUsage,
): StatusLayout {
  // Use a slightly smaller width to account for potential width miscalculations
  // with Nerd Font glyphs that may be rendered as double-width by the terminal
  // but counted as single-width by visibleWidth()
  const icons = resolveIcons(config.get().iconMode);
  const palette = createTokyoNightPalette(theme);
  const statusModules: StatusModulesConfig = {
    ...DEFAULT_STATUS_MODULES,
    ...(config.get().statusModules ?? {}),
  };
  const stretchSides = Object.values(statusModules).some((visible) => !visible);
  const getContextUsage = (
    ctx as unknown as { getContextUsage?: ContextUsageGetter }
  ).getContextUsage;
  const needsSessionStats = statusModules.tokens || statusModules.cost;
  const sessionStats: LiveSessionUsage = needsSessionStats
    ? getSessionStats(ctx)
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const cacheHitRate = statusModules.tokens
    ? getLatestCacheHitRate(ctx)
    : undefined;
  const input = sessionStats.input + (liveUsage?.input ?? 0);
  const output = sessionStats.output + (liveUsage?.output ?? 0);
  const cacheRead = sessionStats.cacheRead + (liveUsage?.cacheRead ?? 0);
  const cacheWrite = sessionStats.cacheWrite + (liveUsage?.cacheWrite ?? 0);
  const cost = sessionStats.cost + (liveUsage?.cost ?? 0);

  const fmtCost = (c: number) =>
    c < 0.01 ? `${c.toFixed(3)}` : `${c.toFixed(2)}`;

  const modelId = ctx.model?.id || ctx.model?.name || "pi-agent";

  const cwd = ctx.cwd;

  let maxCtx = 128000;
  if (ctx.model?.contextWindow) maxCtx = ctx.model.contextWindow;
  let pct: number | null = 0;

  if (statusModules.context && typeof getContextUsage === "function") {
    try {
      const usage = getCachedContextUsage(ctx, getContextUsage);
      if (usage) {
        if (Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) {
          maxCtx = usage.contextWindow;
        }
        pct = usage.tokens != null && Number.isFinite(usage.tokens)
          ? Math.min(100, Math.max(0, Math.round((usage.tokens / maxCtx) * 100)))
          : usage.percent != null && Number.isFinite(usage.percent)
            ? Math.min(100, Math.max(0, Math.round(usage.percent)))
            : null;
      }
    } catch (err) {
      handleExtensionError(err, "context usage");
    }
  } else if (statusModules.context) {
    const contextTokens = getActiveBranchAssistantTokens(ctx) +
      (liveUsage?.input ?? 0) +
      (liveUsage?.output ?? 0);
    pct = contextTokens > 0
      ? Math.min(100, Math.round((contextTokens / maxCtx) * 100))
      : 0;
  }

  const measuredPct = pct ?? 0;
  const barColor = measuredPct > 90
    ? "error"
    : measuredPct > 70
      ? "warning"
      : "accent";
  const filled = Math.round((measuredPct / 100) * 8);
  const progressBar =
    theme.fg(barColor, icons.gaugeFilled.repeat(filled)) +
    theme.fg("dim", icons.gaugeEmpty.repeat(8 - filled));
  const contextUsageLabel = pct === null ? "?" : `${pct}%`;

  // Build left modules (model, thinking, path, branch) from themed surfaces.
  const leftModules: Module[] = [];
  if (statusModules.model) {
    leftModules.push({
      text: formatIconLabel(icons.model, shortName(modelId)),
      bg: "model",
      fg: "statusModel",
    });
  }
  if (statusModules.thinking) {
    leftModules.push({
      text: formatIconLabel(icons.thinking, thinkingLevel),
      bg: "thinking",
      fg: "statusThinking",
    });
  }
  if (statusModules.path) {
    leftModules.push({
      text: formatIconLabel(icons.path, shortenPath(cwd)),
      bg: "path",
      fg: "statusPath",
    });
  }
  if (statusModules.git && branch) {
    leftModules.push({
      text: formatIconLabel(icons.branch, branch),
      bg: "git",
      fg: "statusGit",
    });
  }

  // Provider quota usage: Codex via response headers (only when directly
  // connected to official Codex/GPT), Kimi via polled usages API — both
  // render through the shared LIMIT module.
  const codexModule = buildLimitModule(
    config.get().codexQuota && isCodexModel(ctx.model)
      ? codexUsageStore?.getSnapshot()
      : undefined,
  );
  const kimiModule = buildLimitModule(
    config.get().kimiQuota && isKimiUsageOriginAllowed(ctx.model)
      ? kimiUsageStore?.getSnapshot()
      : undefined,
  );

  // Build right modules (provider usage, tokens, cost, progress)
  const rightModules: Module[] = [
    ...(statusModules.quota ? [...codexModule, ...kimiModule] : []),
    ...(statusModules.tokens
      ? [{
          text: buildDetailedTokenUsage(
            input,
            output,
            cacheRead,
            cacheWrite,
            cacheHitRate,
            icons,
          ),
          bg: "tokens" as const,
          fg: "statusTokens" as const,
        }]
      : []),
    ...(statusModules.cost
      ? [{
          text: `$${fmtCost(cost)}`,
          bg: "cost" as const,
          fg: "statusCost" as const,
        }]
      : []),
    ...(statusModules.context
      ? [{
          text: `${progressBar} ${contextUsageLabel}/${formatTokenCount(maxCtx)}`,
          bg: null,
          fg: "statusContext" as const,
          noEndArrow: true,
        }]
      : []),
  ];

  const leftSection = buildSection(leftModules, icons, palette);
  const rightSection = buildSection(rightModules, icons, palette);

  return {
    oneLine: buildWideStatusLine(
      width,
      leftModules,
      rightModules,
      leftSection,
      rightSection,
      icons,
      palette,
      stretchSides,
    ),
    modules: [...leftModules, ...rightModules],
    icons,
    palette,
  };
}

export function buildStatusLine(
  width: number,
  theme: Theme,
  ctx: ExtensionContext,
  branch: string,
  thinkingLevel: string,
  config: TokyoConfigManager,
  codexUsageStore?: Pick<CodexUsageStore, "getSnapshot">,
  kimiUsageStore?: Pick<KimiUsageStore, "getSnapshot">,
  liveUsage?: LiveSessionUsage,
): string {
  const layout = buildStatusLayout(
    width,
    theme,
    ctx,
    branch,
    thinkingLevel,
    config,
    codexUsageStore,
    kimiUsageStore,
    liveUsage,
  );
  return truncateToWidth(layout.oneLine, width);
}

export function buildStatusLines(
  width: number,
  theme: Theme,
  ctx: ExtensionContext,
  branch: string,
  thinkingLevel: string,
  config: TokyoConfigManager,
  codexUsageStore?: Pick<CodexUsageStore, "getSnapshot">,
  kimiUsageStore?: Pick<KimiUsageStore, "getSnapshot">,
  liveUsage?: LiveSessionUsage,
): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];

  const renderWidth = Math.floor(width);
  const layout = buildStatusLayout(
    renderWidth,
    theme,
    ctx,
    branch,
    thinkingLevel,
    config,
    codexUsageStore,
    kimiUsageStore,
    liveUsage,
  );

  if (visibleWidth(layout.oneLine) <= renderWidth) {
    return [layout.oneLine];
  }

  return buildResponsiveRows(
    layout.modules,
    renderWidth,
    layout.icons,
    layout.palette,
  );
}

export function shortName(id: string): string {
  if (!id || id === "pi-agent") return "pi-agent";
  return id.length > 30 ? id.slice(0, 28) + ".." : id;
}

export function shortenPath(p: string): string {
  if (!p) return ".";
  // Replace home directory with ~ only at a complete path boundary.
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let normalized = p.replace(/\\/g, "/");
  const homePath = home.replace(/\\/g, "/");
  const normalizedHome = homePath === "/"
    ? homePath
    : homePath.replace(/\/+$/, "");
  const windowsStyle = /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//");
  const comparedPath = windowsStyle ? normalized.toLowerCase() : normalized;
  const comparedHome = windowsStyle
    ? normalizedHome.toLowerCase()
    : normalizedHome;
  const insideHome = comparedHome === "/"
    ? comparedPath.startsWith("/")
    : comparedHome.length > 0 &&
      (
        comparedPath === comparedHome ||
        comparedPath.startsWith(`${comparedHome}/`)
      );
  if (insideHome) {
    if (normalizedHome === "/") {
      normalized = normalized === "/" ? "~" : `~${normalized}`;
    } else {
      normalized = `~${normalized.slice(normalizedHome.length)}`;
    }
  }
  const unc = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (unc) {
    const root = `//${unc[1]}/${unc[2]}`;
    const segments = (unc[3] ?? "").split("/").filter(Boolean);
    if (segments.length <= 3) {
      return segments.length > 0 ? `${root}/${segments.join("/")}` : root;
    }
    return `${root}/…/${segments.slice(-2).join("/")}`;
  }

  const parts = normalized.split("/");
  if (parts.length <= 4) return normalized;
  const windowsDrive = normalized.match(/^[A-Za-z]:\//)?.[0];
  const prefix = normalized.startsWith("~/")
    ? "~/"
    : windowsDrive ?? (normalized.startsWith("/") ? "/" : "");
  return `${prefix}…/${parts.slice(-2).join("/")}`;
}
