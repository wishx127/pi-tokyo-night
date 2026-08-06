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
  isKimiModel,
  type CodexUsageStore,
  type KimiUsageStore,
  type UsageSnapshot,
} from "./usage";
import {
  DEFAULT_STATUS_MODULES,
  type StatusModulesConfig,
  type TokyoConfigManager,
} from "./config";
import { handleExtensionError } from "./errors";
import { resolveIcons, type StatusIcons } from "./icons";
import {
  bgRgb,
  fgRgb,
  RESET_BG,
  RESET_FG,
} from "./ui-primitives";

// Left module gradient (deep → light purple)
// NOTE: Not `as const` — mutable number[][] needed for Module type compatibility.
const MODULE_BG: number[][] = [
  [45, 27, 105], // Deep purple   #2d1b69
  [61, 43, 122], // Medium purple #3d2b7a
  [77, 59, 138], // Lighter purple #4d3b8a
  [93, 75, 154], // Light purple  #5d4b9a
];

const MODULE_FG: number[][] = [
  [200, 200, 255],
  [220, 220, 255],
  [240, 240, 255],
  [255, 255, 255],
];

// Right module colors
const TOKENS_BG = [109, 91, 170]; // Very light purple #6d5baa
const COST_BG = [93, 93, 93]; // Gray #5d5d5d
const LIMIT_BG = [101, 83, 162]; // Mid purple — between branch and tokens backgrounds

type Module =
  | { text: string; bg: number; fg: number; noEndArrow?: boolean }
  | {
      text: string;
      bgColor: number[] | null;
      textColor: number[];
      noEndArrow?: boolean;
    };

// Shared "LIMIT" module for provider quota (Codex via response headers,
// Kimi via polled usages API — both render through formatStatus).
const buildLimitModule = (snap: UsageSnapshot | undefined): Module[] =>
  snap
    ? [{
        text: `LIMIT ${formatStatus(snap)}`,
        bgColor: LIMIT_BG as number[],
        textColor: [245, 240, 255] as number[],
      }]
    : [];

type SessionStats = { input: number; output: number; cost: number };

type StatsCacheEntry = {
  sessionId: string | undefined;
  leafId: string;
  stats: SessionStats;
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

// Session branches are immutable between leaf changes. Keep this cache keyed by
// manager identity so a reused module can never share stats between sessions.
const sessionStatsCache = new WeakMap<object, StatsCacheEntry>();

// Context usage can change while a leaf is streaming, so this is intentionally
// a short-lived cache rather than a leaf-only cache. It prevents animation and
// input redraws from repeatedly traversing a long session branch while keeping
// the status bar responsive to recent usage changes.
const CONTEXT_USAGE_CACHE_TTL_MS = 250;
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

function calculateSessionStats(ctx: ExtensionContext): SessionStats {
  let input = 0;
  let output = 0;
  let cost = 0;
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        input += m.usage.input;
        output += m.usage.output;
        cost += m.usage.cost.total;
      }
    }
  } catch (err) {
    handleExtensionError(err, "session stats");
  }
  return { input, output, cost };
}

function getSessionStats(ctx: ExtensionContext): SessionStats {
  const manager = ctx.sessionManager as unknown as object;
  const getLeafId = (
    ctx.sessionManager as unknown as { getLeafId?: () => string | null }
  ).getLeafId;
  if (typeof getLeafId !== "function") return calculateSessionStats(ctx);

  try {
    const leafId = getLeafId.call(ctx.sessionManager);
    if (leafId == null) return calculateSessionStats(ctx);
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
    ) {
      return cached.stats;
    }

    const stats = calculateSessionStats(ctx);
    sessionStatsCache.set(manager, { sessionId, leafId, stats });
    return stats;
  } catch (err) {
    handleExtensionError(err, "session stats cache");
    return calculateSessionStats(ctx);
  }
}

const getModuleBg = (m: Module): number[] | null =>
  "bg" in m ? MODULE_BG[m.bg] : m.bgColor;
const getModuleFg = (m: Module): number[] =>
  "fg" in m ? MODULE_FG[m.fg] : m.textColor;

// Powerline transition arrow between two modules (1-char wide)
const buildTransition = (
  from: Module,
  to: Module,
  icons: StatusIcons,
): string => {
  const c1 = getModuleBg(from);
  const c2 = getModuleBg(to);
  const bg = c2 === null ? RESET_BG : bgRgb(c2);
  const fg = c1 === null ? RESET_FG : fgRgb(c1);
  return `${bg}${fg}${icons.transition}${RESET_BG}${RESET_FG}`;
};

const getModuleText = (m: Module): string => ` ${m.text} `;
const getModuleWidth = (m: Module): number => visibleWidth(getModuleText(m));
const formatIconLabel = (icon: string, label: string): string =>
  icon ? `${icon} ${label}` : label;

const buildModule = (m: Module): string => {
  const bgColor = getModuleBg(m);
  const textColor = getModuleFg(m);
  const bgCode = bgColor === null ? RESET_BG : bgRgb(bgColor);
  const fgCode = fgRgb(textColor);

  return `${bgCode}${fgCode}${getModuleText(m)}${RESET_BG}${RESET_FG}`;
};

// Build a section (array of modules) with Powerline transitions
const buildSection = (modules: Module[], icons: StatusIcons) => {
  let result = "";
  let currentWidth = 0;

  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];

    // Powerline transition before module (except first)
    if (i > 0) {
      const transition = buildTransition(modules[i - 1], m, icons);
      result += transition;
      currentWidth += visibleWidth(transition);
    }

    result += buildModule(m);
    currentWidth += getModuleWidth(m);
  }

  return { result, currentWidth };
};

type StatusLayout = {
  oneLine: string;
  modules: Module[];
  icons: StatusIcons;
};

const END_MODULE: Module = {
  text: "",
  bgColor: null,
  textColor: [],
};

const buildEndArrow = (module: Module, icons: StatusIcons): string =>
  module.noEndArrow ? "" : buildTransition(module, END_MODULE, icons);

function buildRow(modules: Module[], icons: StatusIcons): string {
  if (modules.length === 0) return "";
  return `${buildSection(modules, icons).result}${buildEndArrow(modules[modules.length - 1], icons)}`;
}

function buildResponsiveRows(
  modules: Module[],
  width: number,
  icons: StatusIcons,
): string[] {
  if (width <= 0 || modules.length === 0) return [];

  const firstArrow = buildEndArrow(modules[0], icons);
  const firstArrowWidth = visibleWidth(firstArrow);
  if (width <= firstArrowWidth + 2) {
    return [truncateToWidth(firstArrow, width)];
  }

  const rows: string[] = [];
  let current: Module[] = [];
  let currentWidth = 0;

  const flush = () => {
    if (current.length === 0) return;
    rows.push(buildRow(current, icons));
    current = [];
    currentWidth = 0;
  };

  for (const module of modules) {
    const moduleWidth = getModuleWidth(module);
    const endArrowWidth = visibleWidth(buildEndArrow(module, icons));

    if (current.length > 0) {
      const previous = current[current.length - 1];
      const transition = buildTransition(previous, module, icons);
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
      rows.push(truncateToWidth(buildEndArrow(module, icons), width));
    }
  }

  flush();
  return rows;
}

function buildColoredFill(bgColor: number[] | null, width: number): string {
  if (width <= 0) return "";
  const bgCode = bgColor === null ? RESET_BG : bgRgb(bgColor);
  return `${bgCode}${" ".repeat(width)}${RESET_BG}`;
}

function buildWideStatusLine(
  width: number,
  leftModules: Module[],
  rightModules: Module[],
  leftSection: ReturnType<typeof buildSection>,
  rightSection: ReturnType<typeof buildSection>,
  icons: StatusIcons,
  stretchSides: boolean,
): string {
  if (leftModules.length === 0 && rightModules.length === 0) return "";

  const safeWidth = Math.max(1, width - 2);
  if (leftModules.length === 0) {
    const fillWidth = Math.max(1, safeWidth - rightSection.currentWidth);
    return `${buildColoredFill(getModuleBg(rightModules[0]), fillWidth)}${rightSection.result}`;
  }
  if (rightModules.length === 0) {
    const fillWidth = Math.max(1, safeWidth - leftSection.currentWidth);
    return `${leftSection.result}${buildColoredFill(
      getModuleBg(leftModules[leftModules.length - 1]),
      fillWidth,
    )}`;
  }

  const bridgeTransition = buildTransition(
    leftModules[leftModules.length - 1],
    rightModules[0],
    icons,
  );
  const paddingWidth = Math.max(
    1,
    safeWidth - leftSection.currentWidth - visibleWidth(bridgeTransition) - rightSection.currentWidth,
  );
  if (!stretchSides) {
    return `${leftSection.result}${buildColoredFill(
      getModuleBg(leftModules[leftModules.length - 1]),
      paddingWidth,
    )}${bridgeTransition}${rightSection.result}`;
  }

  const leftFillWidth = Math.ceil(paddingWidth / 2);
  const rightFillWidth = paddingWidth - leftFillWidth;
  return `${leftSection.result}${buildColoredFill(
    getModuleBg(leftModules[leftModules.length - 1]),
    leftFillWidth,
  )}${bridgeTransition}${buildColoredFill(
    getModuleBg(rightModules[0]),
    rightFillWidth,
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
): StatusLayout {
  // Use a slightly smaller width to account for potential width miscalculations
  // with Nerd Font glyphs that may be rendered as double-width by the terminal
  // but counted as single-width by visibleWidth()
  const icons = resolveIcons(config.get().iconMode);
  const statusModules: StatusModulesConfig = {
    ...DEFAULT_STATUS_MODULES,
    ...(config.get().statusModules ?? {}),
  };
  const stretchSides = Object.values(statusModules).some((visible) => !visible);
  const { input, output, cost } = getSessionStats(ctx);

  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  const fmtCost = (c: number) =>
    c < 0.01 ? `${c.toFixed(3)}` : `${c.toFixed(2)}`;

  const modelId = ctx.model?.id || ctx.model?.name || "pi-agent";

  const cwd = ctx.cwd;

  const totalTokens = input + output;
  let maxCtx = 128000;
  if (ctx.model?.contextWindow) maxCtx = ctx.model.contextWindow;
  let pct =
    totalTokens > 0
      ? Math.min(100, Math.round((totalTokens / maxCtx) * 100))
      : 0;

  const getContextUsage = (
    ctx as unknown as { getContextUsage?: ContextUsageGetter }
  ).getContextUsage;
  if (typeof getContextUsage === "function") {
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
            : 0;
      } else {
        pct = 0;
      }
    } catch (err) {
      handleExtensionError(err, "context usage");
      pct = 0;
    }
  }

  const barColor = pct >= 50 ? "error" : pct >= 30 ? "warning" : "accent";
  const filled = Math.round((pct / 100) * 8);
  const progressBar =
    theme.fg(barColor, icons.gaugeFilled.repeat(filled)) +
    theme.fg("dim", icons.gaugeEmpty.repeat(8 - filled));

  // Build left modules (model, thinking, path, branch) - purple gradient
  const leftModules: Module[] = [];
  if (statusModules.model) {
    leftModules.push({
      text: formatIconLabel(icons.model, shortName(modelId)),
      bg: 0,
      fg: 0,
    });
  }
  if (statusModules.thinking) {
    leftModules.push({
      text: formatIconLabel(icons.thinking, thinkingLevel),
      bg: 1,
      fg: 1,
    });
  }
  if (statusModules.path) {
    leftModules.push({
      text: formatIconLabel(icons.path, shortenPath(cwd)),
      bg: 2,
      fg: 2,
    });
  }
  if (statusModules.git && branch) {
    leftModules.push({
      text: formatIconLabel(icons.branch, branch),
      bg: 3,
      fg: 3,
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
    config.get().kimiQuota && isKimiModel(ctx.model)
      ? kimiUsageStore?.getSnapshot()
      : undefined,
  );

  // Build right modules (provider usage, tokens, cost, progress)
  const rightModules: Module[] = [
    ...(statusModules.quota ? [...codexModule, ...kimiModule] : []),
    ...(statusModules.tokens
      ? [{
          text: `${icons.tokens} ${fmt(totalTokens)} tokens`,
          bgColor: TOKENS_BG as number[],
          textColor: [255, 255, 200] as number[],
        }]
      : []),
    ...(statusModules.cost
      ? [{
          text: `$${fmtCost(cost)}`,
          bgColor: COST_BG as number[],
          textColor: [200, 255, 200] as number[],
        }]
      : []),
    ...(statusModules.context
      ? [{
          text: `${progressBar} ${pct}%/${fmt(maxCtx)}`,
          bgColor: null as number[] | null,
          textColor: [255, 200, 200] as number[],
          noEndArrow: true,
        }]
      : []),
  ];

  const leftSection = buildSection(leftModules, icons);
  const rightSection = buildSection(rightModules, icons);

  return {
    oneLine: buildWideStatusLine(
      width,
      leftModules,
      rightModules,
      leftSection,
      rightSection,
      icons,
      stretchSides,
    ),
    modules: [...leftModules, ...rightModules],
    icons,
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
  );

  if (visibleWidth(layout.oneLine) <= renderWidth) {
    return [layout.oneLine];
  }

  return buildResponsiveRows(layout.modules, renderWidth, layout.icons);
}

export function shortName(id: string): string {
  if (!id || id === "pi-agent") return "pi-agent";
  return id.length > 30 ? id.slice(0, 28) + ".." : id;
}

export function shortenPath(p: string): string {
  if (!p) return ".";
  // Replace home directory with ~
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) {
    p = "~" + p.slice(home.length);
  }
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 4) return p;
  return "~/…/" + parts.slice(-2).join("/");
}
