/** Tokyo Night Extension composition root. */

import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ExtensionUIContext, type KeybindingsManager, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { readUsageHistory } from "./analytics/usage-history";
import { TokyoConfigManager } from "./core/config";
import { detectTerminalTheme } from "./core/terminal-theme";
import { observeTerminalRecovery } from "./core/terminal-recovery";
import {
  createTokyoNightErrorSink,
  flushConsoleLogWrites,
  installConsoleLogBridge,
  type ConsoleLogBridge,
} from "./core/console-bridge";
import {
  EXT_PREFIX,
  handleExtensionError,
  isStaleExtensionContextError,
  type ExtensionErrorSink,
} from "./core/errors";
import {
  evaluatePiCompatibility,
  isFullscreenTui,
  requestHostRender,
  type PiCompatibility,
  resolveWorkingIndicatorSetter,
} from "./core/pi-compat";
import { RainAnimationManager } from "./rain/rain-manager";
import { RainPanelComponent } from "./rain/rain-panel";
import {
  resolveRainRuntimeProfile,
  type RainActivity,
} from "./rain/rain-profile";
import { BorderlessEditor, type BorderlessEditorDependencies } from "./ui/borderless-editor";
import { NeonStudioComponent } from "./ui/neon-studio";
import {
  NeonStudioController,
  type NeonStudioConfigChange,
  type NeonStudioThemeChoice,
  type NeonStudioThemeResult,
} from "./ui/neon-studio-controller";
import {
  buildStatusLines,
  getSessionStats,
  invalidateSessionStats,
  type LiveSessionUsage,
} from "./ui/status-bar";
import { StatusRenderCache } from "./ui/status-render-cache";
import { RefreshScheduler } from "./ui/refresh-scheduler";
import { RenderRecoveryCoordinator } from "./ui/render-recovery";
import {
  getFrameContentWidth,
  renderFrameSegment,
} from "./ui/frame-layout";
import {
  createTokyoNightPalette,
  type TokyoNightThemePalette,
} from "./ui/theme-palette";
import { renderWorkingText } from "./ui/working-shimmer";
import {
  createCodexUsageStore,
  createKimiUsageStore,
  fetchKimiUsage,
  isCodexModel,
  isKimiModel,
  isKimiUsageOriginAllowed,
  resolveKimiApiKey,
  type KimiUsageStore,
} from "./usage";

export type TokyoNightMode = "tui" | "rpc" | "json" | "print";

type BranchState = {
  cachedBranch: string;
  cacheTime: number;
  pending: boolean;
  requestToken: number;
  requestController: AbortController | undefined;
  cwd: string | undefined;
};

type WorkingPhase = "waiting" | "thinking" | "streaming";
type WorkingTool = { name: string; startedAt: number };
type NativeWorkingState = {
  phase: WorkingPhase;
  phaseStartedAt: number | undefined;
  activeTools: Map<string, WorkingTool>;
  stopAnimation: (() => void) | undefined;
  indicatorConfigured: boolean;
  indicatorOwned: boolean;
  indicatorThemeName: string | undefined;
  lastMessage: string | undefined;
  pending: boolean;
  setIndicator: ReturnType<typeof resolveWorkingIndicatorSetter>;
};

type SessionUIResources = {
  editorFactory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) => BorderlessEditor) | null;
  editor: BorderlessEditor | null;
  rainPanel: RainPanelComponent | null;
  rainManager: RainAnimationManager | null;
  statusTui: TUI | null;
  renderFullscreenStatus: ((width: number) => string[]) | null;
  footerOwned: boolean;
  footerSubscription: { dispose(): void } | null;
};

type SessionState = {
  generation: number;
  ui: ExtensionUIContext;
  mode: TokyoNightMode;
  hasUI: boolean;
  cwd: string;
  identityKey: string;
  disposed: boolean;
  footerData: ReadonlyFooterDataProvider | null;
  branch: BranchState;
  resources: SessionUIResources;
  refreshScheduler: RefreshScheduler | undefined;
  renderRecovery: RenderRecoveryCoordinator | undefined;
  terminalRecovery: { dispose(): void } | undefined;
  codexCountdownRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
  working: NativeWorkingState;
  rainActivity: RainActivity;
  kimiUsageStore: KimiUsageStore;
  statusRenderCache: StatusRenderCache;
  liveUsage: LiveSessionUsage | undefined;
  liveUsageBaseline: LiveSessionUsage | undefined;
  liveUsageFinalizing: boolean;
  liveUsageRevision: number;
  liveUsageReconcileTimeout: ReturnType<typeof setTimeout> | undefined;
  liveUsageReconcileAttempts: number;
  outputTpsStartedAt: number | undefined;
  outputTpsTokens: number | undefined;
  outputTps: number | undefined;
  outputTpsLast: number | undefined;
  context: ExtensionContext;
  requestStatusRender: (() => void) | undefined;
};

const WORKING_ANIMATION_INTERVAL_MS = 100;
const WORKING_INDICATOR_INTERVAL_MS = 80;
const MIN_OUTPUT_TPS_INTERVAL_MS = 100;
const MAX_OUTPUT_TPS = 10_000;
const TOKYO_WORKING_GLYPHS = Object.freeze([
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
] as const);

function renderTokyoWorkingFrame(theme: Theme | undefined, elapsedMs: number): string {
  const palette = theme ? createTokyoNightPalette(theme) : undefined;
  const glyph = TOKYO_WORKING_GLYPHS[Math.floor(elapsedMs / WORKING_INDICATOR_INTERVAL_MS) % TOKYO_WORKING_GLYPHS.length];
  return palette?.fg("workingText", glyph) ?? glyph;
}

const CODEX_COUNTDOWN_REFRESH_MS = 30_000;
const LIVE_USAGE_RECONCILE_BASE_DELAY_MS = 50;
const LIVE_USAGE_RECONCILE_MAX_DELAY_MS = 800;
const LIVE_USAGE_RECONCILE_MAX_ATTEMPTS = 20;
const AUTOMATIC_THEME_QUERY_TIMEOUT_MS = 100;
const KIMI_POLL_INTERVAL_MS = 60_000;
const KIMI_RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 900_000] as const;
const KIMI_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;

export const TOKYO_NIGHT_AUTOMATIC_THEME_SETTING =
  "tokyo-night-light/tokyo-night-dark";

export interface PiThemeSettingResult {
  success: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeLiveUsage(value: unknown): LiveSessionUsage | undefined {
  if (!isRecord(value)) return undefined;
  const cost = isRecord(value.cost) ? finiteNonNegative(value.cost.total) : undefined;
  const input = finiteNonNegative(value.input);
  const output = finiteNonNegative(value.output);
  const cacheRead = finiteNonNegative(value.cacheRead);
  const cacheWrite = finiteNonNegative(value.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    cost === undefined
  ) {
    return undefined;
  }
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    cost: cost ?? 0,
  };
}

function sameLiveUsage(
  left: LiveSessionUsage | undefined,
  right: LiveSessionUsage | undefined,
): boolean {
  return left?.input === right?.input &&
    left?.output === right?.output &&
    left?.cacheRead === right?.cacheRead &&
    left?.cacheWrite === right?.cacheWrite &&
    left?.cost === right?.cost;
}

export function readPiThemeSetting(agentDir = getAgentDir()): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"),
    );
    return isRecord(parsed) && typeof parsed.theme === "string"
      ? parsed.theme
      : undefined;
  } catch {
    return undefined;
  }
}

export function writePiThemeSetting(
  themeSetting: string | undefined,
  agentDir = getAgentDir(),
): PiThemeSettingResult {
  const settingsPath = path.join(agentDir, "settings.json");
  let temporaryPath: string | undefined;
  try {
    let settings: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(settingsPath, "utf-8"),
      );
      if (!isRecord(parsed)) {
        throw new Error("settings.json must contain an object");
      }
      settings = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const nextSettings = { ...settings };
    if (themeSetting === undefined) delete nextSettings.theme;
    else nextSettings.theme = themeSetting;

    fs.mkdirSync(agentDir, { recursive: true });
    temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(nextSettings, null, 2),
      "utf-8",
    );
    fs.renameSync(temporaryPath, settingsPath);
    temporaryPath = undefined;
    return { success: true };
  } catch (error) {
    if (temporaryPath) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup.
      }
    }
    return {
      success: false,
      error: `Could not update ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function shouldRunRainAnimation(mode: TokyoNightMode, panelEnabled: boolean): boolean {
  return mode === "tui" && panelEnabled;
}

function safeTerminalWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Render status content with stable frame ownership below the editor. */
export function buildStatusWidgetLines(
  width: number,
  statusContent: string | string[],
  frameEnabled = true,
  palette?: TokyoNightThemePalette,
): string[] {
  return renderFrameSegment({
    width: safeTerminalWidth(width),
    lines: Array.isArray(statusContent) ? statusContent : [statusContent],
    frameEnabled,
    role: "bottom",
    palette,
    padUnframed: true,
  });
}

export function registerTokyoNightExtension(
  pi: ExtensionAPI,
  dependencies: {
    installConsoleLogBridge?: typeof installConsoleLogBridge;
    readPiThemeSetting?: typeof readPiThemeSetting;
    writePiThemeSetting?: typeof writePiThemeSetting;
    errorSink?: ExtensionErrorSink;
    compatibility?: PiCompatibility;
    observeTerminalRecovery?: typeof observeTerminalRecovery;
  } = {},
): void {
  const configManager = new TokyoConfigManager();
  const codexUsageStore = createCodexUsageStore();
  const installBridge = dependencies.installConsoleLogBridge ?? installConsoleLogBridge;
  const observeRecovery = dependencies.observeTerminalRecovery ?? observeTerminalRecovery;
  let consoleLogBridge: ConsoleLogBridge | undefined;
  let consoleBridgeOwnerIdentity: string | undefined;
  let consoleBridgeOwnerRevision = 0;
  const errorSink = dependencies.errorSink ?? createTokyoNightErrorSink();
  const sessionsByIdentity = new Map<string, SessionState>();
  let activeSession: SessionState | null = null;
  let activeNeonStudio: {
    session: SessionState;
    controller: NeonStudioController;
    component: NeonStudioComponent | null;
  } | null = null;
  let generation = 0;
  let panelSaveTail: Promise<void> | undefined;
  let sessionRetirement = Promise.resolve();
  let startingSession: { identityKey: string; generation: number } | undefined;
  let activeModel: Model<any> | undefined;
  let modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> } | null = null;
  let kimiPollTimer: ReturnType<typeof setInterval> | undefined;
  let kimiPollController: AbortController | undefined;
  let kimiPollGeneration = 0;
  let kimiPollSession: SessionState | null = null;
  let kimiPollModel: Model<any> | undefined;
  let kimiPollFailures = 0;
  let kimiNextPollAt = 0;
  let kimiFailureLogged = false;
  const loadPiThemeSetting = dependencies.readPiThemeSetting ?? readPiThemeSetting;
  const savePiThemeSetting = dependencies.writePiThemeSetting ?? writePiThemeSetting;
  const compatibility = dependencies.compatibility ?? evaluatePiCompatibility(VERSION);
  let compatibilityWarningShown = false;

  const isInteractive = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.hasUI;
  const waitForPanelSaves = async (): Promise<void> => {
    while (panelSaveTail) {
      const pending = panelSaveTail;
      await pending;
      if (panelSaveTail === pending) return;
    }
  };
  const identityOf = (ctx: ExtensionContext): string =>
    `id:${ctx.sessionManager.getSessionId()}|file:${ctx.sessionManager.getSessionFile() ?? ""}`;
  const isCurrent = (session: SessionState): boolean =>
    activeSession === session && !session.disposed && session.generation === generation;

  const stopKimiPolling = (): void => {
    if (kimiPollTimer !== undefined) clearInterval(kimiPollTimer);
    kimiPollTimer = undefined;
    kimiPollController?.abort();
    kimiPollController = undefined;
    kimiPollSession = null;
    kimiPollModel = undefined;
    kimiPollFailures = 0;
    kimiNextPollAt = 0;
    kimiFailureLogged = false;
    kimiPollGeneration += 1;
  };

  const canPollKimi = (session: SessionState, model: Model<any> | undefined): boolean =>
    isCurrent(session) && session.mode === "tui" && session.hasUI &&
    configManager.get().kimiQuota && configManager.get().statusModules.quota &&
    session.context.model === model && isKimiModel(model) &&
    isKimiUsageOriginAllowed(model);

  const requestStatusRenderFor = (session: SessionState): void => {
    if (isCurrent(session)) session.requestStatusRender?.();
  };

  const resetOutputTps = (session: SessionState): void => {
    session.outputTpsStartedAt = undefined;
    session.outputTpsTokens = undefined;
    if (session.outputTps === undefined) return;
    session.outputTps = undefined;
    if (configManager.get().statusModules.tokens) requestStatusRenderFor(session);
  };

  const updateOutputTps = (session: SessionState, value: unknown, final = false, durationMs?: unknown): void => {
    // Final usage replaces provisional samples, even when its timing is unusable.
    if (final && session.outputTps !== undefined) {
      session.outputTps = undefined;
      if (configManager.get().statusModules.tokens) requestStatusRenderFor(session);
    }
    const output = isRecord(value) ? finiteNonNegative(value.output) : undefined;
    const startedAt = session.outputTpsStartedAt;
    if (output === undefined || output === 0) return;
    if (!final && output === session.outputTpsTokens) return;
    const elapsedMs = (final ? finiteNonNegative(durationMs) : undefined) ??
      (startedAt === undefined ? undefined : performance.now() - startedAt);
    if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < MIN_OUTPUT_TPS_INTERVAL_MS) return;
    const next = output * 1000 / elapsedMs;
    if (!Number.isFinite(next) || Math.round(next) >= MAX_OUTPUT_TPS) return;
    session.outputTpsTokens = output;
    if (next === session.outputTps) return;
    session.outputTps = next;
    if (configManager.get().statusModules.tokens) requestStatusRenderFor(session);
  };

  const usageIncludesLiveValue = (
    stats: LiveSessionUsage,
    baseline: LiveSessionUsage,
    live: LiveSessionUsage,
  ): boolean =>
    stats.input >= baseline.input + live.input &&
    stats.output >= baseline.output + live.output &&
    stats.cacheRead >= baseline.cacheRead + live.cacheRead &&
    stats.cacheWrite >= baseline.cacheWrite + live.cacheWrite &&
    stats.cost >= baseline.cost + live.cost;

  const clearLiveUsageReconcile = (session: SessionState): void => {
    if (session.liveUsageReconcileTimeout !== undefined) {
      clearTimeout(session.liveUsageReconcileTimeout);
    }
    session.liveUsageReconcileTimeout = undefined;
    session.liveUsageReconcileAttempts = 0;
  };

  const updateLiveUsage = (session: SessionState, value: unknown): void => {
    const modules = configManager.get().statusModules;
    // SAFETY: getContextUsage is an optional newer-host capability absent from current ExtensionContext typings.
    const getContextUsage = (
      session.context as unknown as { getContextUsage?: () => unknown }
    ).getContextUsage;
    const needsLiveUsage = modules.tokens || modules.cost ||
      (modules.context && typeof getContextUsage !== "function");
    if (!needsLiveUsage) return;

    const next = normalizeLiveUsage(value);
    if (!next) return;
    clearLiveUsageReconcile(session);
    if (!session.liveUsage) {
      session.liveUsageBaseline = getSessionStats(session.context);
    }
    session.liveUsageFinalizing = false;
    if (sameLiveUsage(session.liveUsage, next)) return;
    session.liveUsage = next;
    session.liveUsageRevision += 1;
    requestStatusRenderFor(session);
  };

  const reconcileLiveUsage = (session: SessionState): boolean => {
    const live = session.liveUsage;
    const baseline = session.liveUsageBaseline;
    if (!session.liveUsageFinalizing || !live || !baseline) return false;

    // Pi may persist the finalized message without changing the current leaf.
    // Only lifecycle events and bounded retries may re-scan; never animation renders.
    invalidateSessionStats(session.context);
    const persisted = getSessionStats(session.context);
    if (!usageIncludesLiveValue(persisted, baseline, live)) return false;

    clearLiveUsageReconcile(session);
    session.liveUsage = undefined;
    session.liveUsageBaseline = undefined;
    session.liveUsageFinalizing = false;
    session.liveUsageRevision += 1;
    requestStatusRenderFor(session);
    return true;
  };

  const scheduleLiveUsageReconcile = (session: SessionState): void => {
    if (
      session.liveUsageReconcileTimeout !== undefined ||
      session.liveUsageReconcileAttempts >= LIVE_USAGE_RECONCILE_MAX_ATTEMPTS
    ) return;

    const delay = Math.min(
      LIVE_USAGE_RECONCILE_BASE_DELAY_MS *
        2 ** Math.floor(session.liveUsageReconcileAttempts / 4),
      LIVE_USAGE_RECONCILE_MAX_DELAY_MS,
    );
    session.liveUsageReconcileTimeout = setTimeout(() => {
      session.liveUsageReconcileTimeout = undefined;
      if (!isCurrent(session) || !session.liveUsageFinalizing) {
        session.liveUsageReconcileAttempts = 0;
        return;
      }
      session.liveUsageReconcileAttempts += 1;
      if (!reconcileLiveUsage(session)) {
        scheduleLiveUsageReconcile(session);
      }
    }, delay);
    session.liveUsageReconcileTimeout.unref?.();
  };

  const finalizeLiveUsage = (session: SessionState): void => {
    invalidateSessionStats(session.context);
    if (!session.liveUsage) return;
    session.liveUsageFinalizing = true;
    if (!reconcileLiveUsage(session)) {
      scheduleLiveUsageReconcile(session);
    }
  };

  const requestRainRender = (session: SessionState): void => {
    if (!isCurrent(session) || !session.resources.rainManager || !configManager.get().panel) return;
    session.refreshScheduler?.requestRender();
  };

  const stopWorking = (session: SessionState): void => {
    session.working.stopAnimation?.();
    session.working.stopAnimation = undefined;
    session.working.pending = false;
  };
  const resetWorking = (session: SessionState): void => {
    stopWorking(session);
    session.working.phase = "waiting";
    session.working.phaseStartedAt = undefined;
    session.working.activeTools.clear();
    session.working.indicatorConfigured = false;
    session.working.indicatorOwned = false;
    session.working.indicatorThemeName = undefined;
    session.working.lastMessage = undefined;
  };
  const formatDuration = (milliseconds: number): string => {
    const quantizedMilliseconds = Math.floor(Math.max(0, milliseconds) / 100) * 100;
    const seconds = quantizedMilliseconds / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  };
  const workingMessage = (session: SessionState): string => {
    const { working } = session;
    const theme = session.ui.theme;
    const palette = theme ? createTokyoNightPalette(theme) : undefined;
    const tool = working.activeTools.values().next().value as WorkingTool | undefined;
    if (tool) {
      const elapsedMs = Date.now() - tool.startedAt;
      const extra = working.activeTools.size > 1 ? ` +${working.activeTools.size - 1}` : "";
      const message = `Using tools · ${tool.name} ${formatDuration(elapsedMs)}${extra}`;
      return palette
        ? renderWorkingText(message, "pulse", elapsedMs, palette)
        : message;
    }
    const label = working.phase[0].toUpperCase() + working.phase.slice(1);
    const elapsedMs = working.phaseStartedAt === undefined ? 0 : Date.now() - working.phaseStartedAt;
    const message = `${label} ${formatDuration(elapsedMs)}`;
    if (!palette) return message;
    const animation = working.phase === "waiting" ? "forward" : "reverse";
    return renderWorkingText(message, animation, elapsedMs, palette);
  };
  const syncWorkingIndicator = (session: SessionState): void => {
    const theme = session.ui.theme;
    const themeName = theme?.name;
    if (
      session.working.indicatorConfigured &&
      session.working.indicatorThemeName === themeName
    ) return;
    try {
      session.working.setIndicator?.({
        // A single empty frame stops Pi's independent Loader animation clock.
        frames: [""],
      });
      session.working.indicatorOwned = session.working.setIndicator !== undefined;
    } catch (error) {
      if (!isStaleExtensionContextError(error)) {
        handleExtensionError(error, "working indicator update");
      }
    } finally {
      session.working.indicatorConfigured = true;
      session.working.indicatorThemeName = themeName;
    }
  };
  const publishWorking = (session: SessionState): void => {
    if (!isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    if (!session.working.pending) return;
    session.working.pending = false;
    syncWorkingIndicator(session);
    const elapsed = Math.max(0, Date.now() - (session.working.phaseStartedAt ?? Date.now()));
    const message = session.working.indicatorOwned
      ? `${renderTokyoWorkingFrame(session.ui.theme, elapsed)} ${workingMessage(session)}`
      : workingMessage(session);
    try {
      if (session.working.lastMessage !== message) {
        session.ui.setWorkingMessage(message);
        session.working.lastMessage = message;
      }
    }
    catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working message update"); }
  };
  const updateWorking = (session: SessionState): void => {
    if (!isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    session.working.pending = true;
    session.refreshScheduler?.requestRender();
  };
  const restoreWorkingUi = (session: SessionState): void => {
    try { session.working.setIndicator?.(); }
    catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working indicator restore"); }
    try { session.ui.setWorkingMessage(); }
    catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working message restore"); }
  };
  const startWorking = (session: SessionState): void => {
    stopWorking(session);
    session.working.lastMessage = undefined;
    updateWorking(session);
    session.refreshScheduler?.flushNow();
    session.working.stopAnimation = session.refreshScheduler?.repeat(WORKING_ANIMATION_INTERVAL_MS, () => {
      if (!isCurrent(session)) { stopWorking(session); return; }
      updateWorking(session);
    });
  };
  const setWorkingPhase = (session: SessionState, phase: WorkingPhase, restart = false): boolean => {
    if (!restart && session.working.phase === phase && session.working.phaseStartedAt !== undefined) return false;
    session.working.phase = phase;
    session.working.phaseStartedAt = Date.now();
    return true;
  };

  const abortBranch = (branch: BranchState): void => {
    branch.requestController?.abort();
    branch.requestController = undefined;
  };
  const syncFooterBranch = (session: SessionState, footerData: ReadonlyFooterDataProvider): void => {
    if (!isCurrent(session)) return;
    abortBranch(session.branch);
    session.branch.pending = false;
    session.branch.cacheTime = Date.now();
    try {
      const branch = footerData.getGitBranch() ?? "";
      if (branch !== session.branch.cachedBranch) {
        session.branch.cachedBranch = branch;
        requestStatusRenderFor(session);
      }
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "footer git branch");
    }
  };
  const updateBranch = async (session: SessionState): Promise<void> => {
    if (!isCurrent(session) || session.footerData) return;
    const currentCwd = session.context.cwd;
    if (session.cwd !== currentCwd) {
      session.cwd = currentCwd;
      abortBranch(session.branch);
      session.branch.pending = false;
      session.branch.cachedBranch = "";
      session.branch.cacheTime = 0;
      session.branch.requestToken += 1;
    }
    if (session.branch.pending) return;
    const now = Date.now();
    if (now - session.branch.cacheTime < 5000) return;
    session.branch.pending = true;
    session.branch.cacheTime = now;
    const token = ++session.branch.requestToken;
    const controller = new AbortController();
    session.branch.requestController = controller;
    try {
      const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: session.cwd, timeout: 2000, signal: controller.signal,
      });
      if (!isCurrent(session) || token !== session.branch.requestToken || session.footerData || result.code !== 0) return;
      const branch = result.stdout.trim();
      if (branch !== session.branch.cachedBranch) {
        session.branch.cachedBranch = branch;
        requestStatusRenderFor(session);
      }
    } catch (error) {
      if (!isAbortError(error) && !isStaleExtensionContextError(error)) handleExtensionError(error, "git branch");
    } finally {
      if (session.branch.requestController === controller) {
        session.branch.requestController = undefined;
        session.branch.pending = false;
      }
    }
  };

  const scheduleCodexRefresh = (session: SessionState): void => {
    const enabled = isCurrent(session) && session.mode === "tui" && session.hasUI &&
      configManager.get().codexQuota && isCodexModel(activeModel) && codexUsageStore.getSnapshot() !== undefined;
    if (!enabled) {
      if (session.codexCountdownRefreshTimeout !== undefined) clearTimeout(session.codexCountdownRefreshTimeout);
      session.codexCountdownRefreshTimeout = undefined;
      return;
    }
    if (session.codexCountdownRefreshTimeout !== undefined) return;
    session.codexCountdownRefreshTimeout = setTimeout(() => {
      session.codexCountdownRefreshTimeout = undefined;
      requestStatusRenderFor(session);
      scheduleCodexRefresh(session);
    }, CODEX_COUNTDOWN_REFRESH_MS);
  };

  const expireKimiSnapshot = (session: SessionState): void => {
    const snapshot = session.kimiUsageStore.getSnapshot();
    if (!snapshot || Date.now() - snapshot.capturedAt < KIMI_SNAPSHOT_MAX_AGE_MS) return;
    session.kimiUsageStore.clearSnapshot();
    requestStatusRenderFor(session);
  };

  const recordKimiFailure = (session: SessionState, error: unknown): void => {
    const retryDelay = KIMI_RETRY_DELAYS_MS[
      Math.min(kimiPollFailures, KIMI_RETRY_DELAYS_MS.length - 1)
    ];
    kimiPollFailures += 1;
    kimiNextPollAt = Date.now() + retryDelay;
    expireKimiSnapshot(session);
    if (!kimiFailureLogged) {
      kimiFailureLogged = true;
      try {
        errorSink(error, "kimi usage poll");
      } catch {
        // Error reporting must not turn a recoverable poll failure into an
        // unhandled rejection from the detached polling task.
      }
    }
  };

  const pollKimi = async (session: SessionState, model: Model<any>, pollGeneration: number): Promise<void> => {
    if (pollGeneration !== kimiPollGeneration || kimiPollController !== undefined) return;
    if (!canPollKimi(session, model)) {
      if (isCurrent(session)) refreshKimi();
      return;
    }
    if (Date.now() < kimiNextPollAt) {
      expireKimiSnapshot(session);
      return;
    }
    const controller = new AbortController();
    kimiPollController = controller;
    try {
      const key = await resolveKimiApiKey((provider) => modelRegistry?.getApiKeyForProvider(provider) ?? Promise.resolve(undefined));
      if (controller.signal.aborted || !canPollKimi(session, model) || pollGeneration !== kimiPollGeneration) return;
      if (!key) {
        recordKimiFailure(session, new Error("Kimi credential unavailable"));
        return;
      }
      const result = await fetchKimiUsage(key, controller.signal);
      if (controller.signal.aborted || !canPollKimi(session, model) || pollGeneration !== kimiPollGeneration) return;
      if (result.ok) {
        kimiPollFailures = 0;
        kimiNextPollAt = 0;
        kimiFailureLogged = false;
        session.kimiUsageStore.setSnapshot(result.snapshot);
        requestStatusRenderFor(session);
      } else {
        recordKimiFailure(session, new Error(result.error));
      }
    } catch (error) {
      if (!controller.signal.aborted && canPollKimi(session, model) && pollGeneration === kimiPollGeneration) {
        recordKimiFailure(session, error);
      }
    } finally {
      if (kimiPollController === controller) kimiPollController = undefined;
    }
  };
  const refreshKimi = (): void => {
    const session = activeSession;
    const model = session?.context.model;
    if (!session || !canPollKimi(session, model)) {
      stopKimiPolling();
      session?.kimiUsageStore.clearSnapshot();
      return;
    }
    if (kimiPollTimer !== undefined && kimiPollSession === session && kimiPollModel === model) return;
    stopKimiPolling();
    const pollGeneration = kimiPollGeneration;
    kimiPollSession = session;
    kimiPollModel = model;
    void pollKimi(session, model!, pollGeneration);
    kimiPollTimer = setInterval(() => void pollKimi(session, model!, pollGeneration), KIMI_POLL_INTERVAL_MS);
    kimiPollTimer.unref?.();
  };

  const applyRainProfile = (
    session: SessionState,
    activity: RainActivity,
  ): void => {
    session.rainActivity = activity;
    const config = configManager.get();
    const profile = resolveRainRuntimeProfile(config, activity);
    if (config.rainMode === "auto") session.refreshScheduler?.setFrameInterval(profile.tickMs);
    const manager = session.resources.rainManager;
    if (!manager || !manager.isRunning) return;
    manager.applyProfile(profile);
  };

  const applyPanelState = (session: SessionState): void => {
    const manager = session.resources.rainManager;
    if (!manager) return;
    const config = configManager.get();
    const profile = resolveRainRuntimeProfile(config, session.rainActivity);
    session.refreshScheduler?.setFrameInterval(
      config.rainMode === "auto" ? profile.tickMs
        : config.rainMode === "manual" ? Math.min(100, config.rainTickMs) : 100,
    );
    if (shouldRunRainAnimation(session.mode, configManager.get().panel)) {
      if (manager.isRunning) manager.applyProfile(profile);
      else manager.start(profile);
    } else {
      manager.stop();
    }
    session.resources.rainPanel?.invalidate();
    session.resources.rainPanel?.requestRender(true);
  };

  const clearSessionTimers = (session: SessionState): void => {
    session.terminalRecovery?.dispose();
    session.terminalRecovery = undefined;
    session.renderRecovery?.dispose();
    session.renderRecovery = undefined;
    resetWorking(session);
    abortBranch(session.branch);
    session.branch.requestToken += 1;
    session.refreshScheduler?.dispose();
    if (session.codexCountdownRefreshTimeout !== undefined) clearTimeout(session.codexCountdownRefreshTimeout);
    session.codexCountdownRefreshTimeout = undefined;
    clearLiveUsageReconcile(session);
  };

  const teardownSessionUI = (session: SessionState, clearUI: boolean): void => {
    const resources = session.resources;
    const { rainManager, rainPanel, editor, editorFactory, footerOwned, footerSubscription } = resources;
    resources.editor = null;
    resources.editorFactory = null;
    resources.rainPanel = null;
    resources.rainManager = null;
    resources.statusTui = null;
    resources.renderFullscreenStatus = null;
    resources.footerSubscription = null;
    resources.footerOwned = false;
    session.footerData = null;
    rainManager?.stop();
    rainPanel?.dispose();
    editor?.dispose();
    try { footerSubscription?.dispose(); }
    catch (error) { handleExtensionError(error, "footer subscription teardown"); }

    const canClearUI = () => clearUI && session.mode === "tui" && session.hasUI && !activeSession;
    if (!canClearUI()) return;
    if (footerOwned) {
      try { session.ui.setFooter(undefined); }
      catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "footer teardown"); }
    }

    try {
      if (canClearUI()) session.ui.setWidget("tokyo-rain", undefined);
      if (canClearUI()) session.ui.setWidget("tokyo-status", undefined);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "widget teardown");
    }
    try {
      if (canClearUI() && session.ui.getEditorComponent() === editorFactory) session.ui.setEditorComponent(undefined);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "editor teardown");
    }
    if (canClearUI()) restoreWorkingUi(session);
    try {
      if (canClearUI()) session.ui.setWorkingVisible(true);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working teardown");
    }
  };

  const retireSession = (session: SessionState, clearUI: boolean): Promise<void> => {
    if (session.disposed) return sessionRetirement;
    session.disposed = true;
    clearSessionTimers(session);
    if (activeSession === session) {
      activeSession = null;
      stopKimiPolling();
    }
    if (sessionsByIdentity.get(session.identityKey) === session) sessionsByIdentity.delete(session.identityKey);
    teardownSessionUI(session, clearUI);
    let closing: Promise<void> | undefined;
    if (activeNeonStudio?.session === session) {
      const studio = activeNeonStudio;
      activeNeonStudio = null;
      try {
        closing = studio.controller.forceClose().catch((error) => {
          if (!isStaleExtensionContextError(error)) handleExtensionError(error, "Neon Studio teardown");
        });
      } catch (error) {
        if (!isStaleExtensionContextError(error)) {
          handleExtensionError(error, "Neon Studio teardown");
        }
      }
    }
    sessionRetirement = Promise.all([sessionRetirement, closing]).then(() => {});
    return sessionRetirement;
  };

  const attachRenderRecovery = (session: SessionState, tui: TUI): void => {
    if (session.terminalRecovery || !tui.terminal) return;
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => ({ columns: tui.terminal.columns, rows: tui.terminal.rows }),
      pause: () => session.refreshScheduler?.setPaused(true),
      resume: () => session.refreshScheduler?.setPaused(false),
      recover: () => {
        if (!isCurrent(session)) return;
        session.statusRenderCache.invalidate();
        session.resources.rainPanel?.invalidate();
        if (session.working.phaseStartedAt !== undefined) {
          session.working.pending = true;
          publishWorking(session);
        }
        requestHostRender(tui, true);
      },
      onError: (error) => {
        if (!isStaleExtensionContextError(error)) handleExtensionError(error, "screen recovery");
      },
    });
    try {
      const subscription = observeRecovery(tui, {
        onFocus: (focused) => { if (isCurrent(session)) recovery.setFocused(focused); },
        onResize: () => { if (isCurrent(session)) recovery.resized(); },
        onActive: (active) => { if (isCurrent(session)) recovery.setActive(active); },
      });
      if (!subscription) {
        recovery.dispose();
        session.refreshScheduler?.setPaused(false);
        return;
      }
      session.renderRecovery = recovery;
      session.terminalRecovery = subscription;
    } catch (error) {
      recovery.dispose();
      session.refreshScheduler?.setPaused(false);
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "screen recovery setup");
    }
  };

  const createSessionResources = (session: SessionState): void => {
    const workingLayout = new Text("", 1, 0);
    let measuredWorkingMessage: string | undefined;
    const borderlessDependencies: BorderlessEditorDependencies = {
      config: configManager,
      getPalette: () =>
        session.ui.theme ? createTokyoNightPalette(session.ui.theme) : undefined,
    };
    const renderStatusLines = (width: number, theme: Theme): string[] => {
      if (!isCurrent(session)) return [];
      const outputWidth = safeTerminalWidth(width);
      const config = configManager.get();
      const statusWidth = getFrameContentWidth(
        outputWidth,
        config.editorFrame,
      );
      const thinkingLevel = pi.getThinkingLevel();
      let leafId: string | null | undefined;
      try { leafId = session.context.sessionManager.getLeafId(); }
      catch { leafId = undefined; }
      const codexUsage = codexUsageStore.getSnapshot();
      expireKimiSnapshot(session);
      const kimiUsage = session.kimiUsageStore.getSnapshot();

      return session.statusRenderCache.render({
        width: outputWidth,
        theme: theme as object,
        config: config as object,
        branch: session.branch.cachedBranch,
        thinkingLevel,
        model: session.context.model,
        leafId,
        codexUsage,
        kimiUsage,
        liveUsageRevision: session.liveUsageRevision,
      }, () => {
        void updateBranch(session);
        const lines = buildStatusLines(
          statusWidth,
          theme,
          session.context,
          session.branch.cachedBranch,
          thinkingLevel,
          configManager,
          codexUsageStore,
          session.kimiUsageStore,
          session.liveUsageFinalizing && session.liveUsage && session.liveUsageBaseline &&
            usageIncludesLiveValue(getSessionStats(session.context), session.liveUsageBaseline, session.liveUsage)
            ? undefined : session.liveUsage,
          session.outputTps ?? session.outputTpsLast,
        );
        return buildStatusWidgetLines(
          outputWidth,
          lines,
          config.editorFrame,
          theme ? createTokyoNightPalette(theme) : undefined,
        );
      });
    };
    session.resources.renderFullscreenStatus = (width) =>
      renderStatusLines(width, session.ui.theme);
    const editorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions): BorderlessEditor => {
      const editor = new BorderlessEditor(
        tui,
        theme,
        keybindings,
        {
          ...borderlessDependencies,
          renderFullscreenStatus: (width) =>
            session.resources.renderFullscreenStatus?.(width) ?? [],
        },
        options,
      );
      if (isCurrent(session)) {
        session.resources.editor = editor;
        attachRenderRecovery(session, tui);
      }
      return editor;
    };
    session.resources.editorFactory = editorFactory;
    session.resources.rainManager = new RainAnimationManager(configManager, {
      requestRender: () => {
        if (session.resources.rainPanel?.hasVisibleChanges() !== false) {
          requestRainRender(session);
        }
      },
      scheduleTick: (tick, intervalMs) => session.refreshScheduler!.repeat(intervalMs, tick),
    });

    const rainFactory = (tui: TUI): RainPanelComponent => {
      const panel = new RainPanelComponent(tui, {
        config: configManager,
        rain: session.resources.rainManager!,
        getTheme: () => session.ui.theme,
        getAvailableRows: (width) => {
          const terminalRows = tui.terminal?.rows;
          if (!Number.isFinite(terminalRows) || terminalRows <= 0) {
            const config = configManager.get();
            return config.rainRows + (config.editorFrame ? 1 : 0);
          }
          // Only budget surfaces we own, using the currently displayed Studio
          // or editor rather than the height left over from a previous frame.
          const studio = activeNeonStudio?.session === session ? activeNeonStudio : null;
          const surface = studio ? studio.component : session.resources.editor;
          if (!surface || (!studio &&
            session.ui.getEditorComponent() !== session.resources.editorFactory)) {
            return configManager.get().editorFrame ? 1 : 0;
          }
          const editorRows = surface.render(width).length;
          const statusRows = isFullscreenTui(tui)
            ? 0 : renderStatusLines(width, session.ui.theme).length;
          const message = session.working.lastMessage === undefined
            ? undefined
            : session.working.indicatorOwned
              ? session.working.lastMessage
              : `⠋ ${session.working.lastMessage}`;
          if (message !== measuredWorkingMessage) {
            workingLayout.setText(message ?? "");
            measuredWorkingMessage = message;
          }
          const workingRows = Math.max(2, 1 + workingLayout.render(width).length);
          // One above-widget separator and one history row, plus the loader
          // (including wrapped tool names), must stay below the animated rows.
          return Math.max(0, Math.floor(terminalRows) - editorRows - statusRows - workingRows - 2);
        },
      });
      if (isCurrent(session)) session.resources.rainPanel = panel;
      return panel;
    };
    const statusFactory = (tui: TUI, theme: Theme) => {
      session.resources.statusTui = tui;
      return {
        invalidate: () => {
          session.statusRenderCache.invalidate();
          session.requestStatusRender?.();
        },
        render: (width: number): string[] => {
          // Fullscreen composes status inside BorderlessEditor so the host's
          // fixed editor height cannot insert a separator row before it.
          if (isFullscreenTui(tui)) return [];
          return renderStatusLines(width, session.ui.theme ?? theme);
        },
        dispose: () => { if (session.resources.statusTui === tui) session.resources.statusTui = null; },
      };
    };
    const footerFactory = (_tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      session.footerData = footerData;
      session.resources.footerOwned = true;
      syncFooterBranch(session, footerData);
      const unsubscribe = footerData.onBranchChange(() => syncFooterBranch(session, footerData));
      const subscription = {
        active: true,
        dispose: () => {
          if (!subscription.active) return;
          subscription.active = false;
          unsubscribe();
          if (session.resources.footerSubscription === subscription) {
            session.resources.footerSubscription = null;
            session.resources.footerOwned = false;
            session.footerData = null;
          }
        },
      };
      session.resources.footerSubscription = subscription;
      return {
        invalidate: () => session.requestStatusRender?.(),
        render: () => [],
        dispose: () => subscription.dispose(),
      };
    };

    session.ui.setEditorComponent(editorFactory);
    session.ui.setWidget("tokyo-rain", rainFactory, { placement: "aboveEditor" });
    session.ui.setWidget("tokyo-status", statusFactory, { placement: "belowEditor" });
    session.ui.setFooter(footerFactory);
    session.ui.setWorkingVisible(true);
    session.ui.setWorkingMessage();
  };

  pi.on("agent_start", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    applyRainProfile(session, "active");
    setWorkingPhase(session, "waiting", true);
    session.working.activeTools.clear();
    session.ui.setWorkingVisible(true);
    startWorking(session);
  });
  pi.on("turn_start", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session)) return;
    resetOutputTps(session);
    session.outputTpsStartedAt = performance.now();
    finalizeLiveUsage(session);
    if (session.working.phaseStartedAt === undefined) return;
    setWorkingPhase(session, "waiting", true);
    updateWorking(session);
    session.refreshScheduler?.flushNow();
  });
  pi.on("agent_end", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    stopWorking(session);
    finalizeLiveUsage(session);
    try { requestRainRender(session); }
    catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "agent end rain render"); }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || !ctx.isIdle()) return;
    applyRainProfile(session, "idle");
    finalizeLiveUsage(session);
    resetWorking(session);
    restoreWorkingUi(session);
  });
  pi.on("message_start", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || event.message.role !== "assistant") return;
    session.outputTpsStartedAt ??= performance.now();
  });
  pi.on("message_update", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    const assistantEvent = event.assistantMessageEvent;
    if ("partial" in assistantEvent) {
      updateLiveUsage(session, assistantEvent.partial.usage);
      updateOutputTps(session, assistantEvent.partial.usage);
    }
    const type = assistantEvent.type;
    const phase: WorkingPhase | undefined = type.includes("thinking") || type.includes("toolcall") ? "thinking" : type.includes("text") ? "streaming" : undefined;
    if (session.working.phaseStartedAt !== undefined && phase && setWorkingPhase(session, phase)) updateWorking(session);
    session.refreshScheduler?.hostWillRender();
  });
  pi.on("message_end", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    if (event.message.role === "assistant") {
      updateLiveUsage(session, event.message.usage);
      if (event.message.usage?.output > 0) {
        updateOutputTps(session, event.message.usage, true,
          "durationMs" in event.message ? event.message.durationMs : undefined);
      }
      if (session.outputTps !== undefined) session.outputTpsLast = session.outputTps;
      resetOutputTps(session);
      if (session.liveUsage) {
        session.liveUsageFinalizing = true;
        scheduleLiveUsageReconcile(session);
        requestStatusRenderFor(session);
      }
    }
    session.refreshScheduler?.hostWillRender(false);
  });
  pi.on("turn_end", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    finalizeLiveUsage(session);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || session.working.phaseStartedAt === undefined) return;
    applyRainProfile(session, "tools");
    session.working.activeTools.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() });
    updateWorking(session);
    session.refreshScheduler?.flushNow();
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || session.working.phaseStartedAt === undefined) return;
    session.working.activeTools.delete(event.toolCallId);
    if (session.working.activeTools.size === 0) {
      applyRainProfile(session, "active");
      setWorkingPhase(session, "waiting");
    }
    updateWorking(session);
    session.refreshScheduler?.flushNow();
  });
  pi.on("after_provider_response", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || !configManager.get().codexQuota || !isCodexModel(ctx.model)) return;
    if (codexUsageStore.captureFromHeaders(event.headers)) {
      scheduleCodexRefresh(session);
      requestStatusRenderFor(session);
    }
  });
  pi.on("model_select", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session)) return;
    session.context = ctx;
    session.outputTpsLast = undefined;
    resetOutputTps(session);
    activeModel = event.model;
    codexUsageStore.clearSnapshot();
    scheduleCodexRefresh(session);
    refreshKimi();
    requestStatusRenderFor(session);
  });
  pi.on("thinking_level_select", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session)) return;
    session.context = ctx;
    requestStatusRenderFor(session);
  });

  pi.on("session_start", async (_event, ctx) => {
    const identityKey = identityOf(ctx);
    consoleBridgeOwnerRevision += 1;
    if (isInteractive(ctx)) {
      consoleLogBridge ??= installBridge();
      consoleLogBridge.setInteractive(true);
      consoleBridgeOwnerIdentity = identityKey;
    } else {
      consoleLogBridge?.dispose();
      consoleLogBridge = undefined;
      consoleBridgeOwnerIdentity = undefined;
    }
    if (!compatibility.supported) {
      if (!compatibilityWarningShown) {
        const warning = `${EXT_PREFIX} Pi ${compatibility.version} is below the supported minimum ${compatibility.minimum}; interactive UI resources will not be registered.`;
        if (ctx.hasUI) ctx.ui.notify(warning, "warning");
        else console.warn(warning);
        compatibilityWarningShown = true;
      }
      return;
    }
    const startGeneration = ++generation;
    startingSession = { identityKey, generation: startGeneration };
    const sessionUI = ctx.ui;
    const previous = activeSession;
    if (previous) retireSession(previous, previous.ui === sessionUI);
    const duplicate = sessionsByIdentity.get(identityKey);
    if (duplicate) retireSession(duplicate, duplicate.ui === sessionUI);
    await sessionRetirement;
    await waitForPanelSaves();
    if (startGeneration !== generation) return;
    startingSession = undefined;

    const session: SessionState = {
      generation: startGeneration,
      ui: sessionUI,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      cwd: ctx.cwd,
      identityKey,
      disposed: false,
      footerData: null,
      branch: { cachedBranch: "", cacheTime: 0, pending: false, requestToken: 0, requestController: undefined, cwd: undefined },
      resources: { editorFactory: null, editor: null, rainPanel: null, rainManager: null, statusTui: null, renderFullscreenStatus: null, footerOwned: false, footerSubscription: null },
      refreshScheduler: undefined,
      renderRecovery: undefined,
      terminalRecovery: undefined,
      codexCountdownRefreshTimeout: undefined,
      working: {
        phase: "waiting",
        phaseStartedAt: undefined,
        activeTools: new Map(),
        stopAnimation: undefined,
        indicatorConfigured: false,
        indicatorOwned: false,
        indicatorThemeName: undefined,
        lastMessage: undefined,
        pending: false,
        setIndicator: resolveWorkingIndicatorSetter(sessionUI),
      },
      rainActivity: "idle",
      kimiUsageStore: createKimiUsageStore(),
      statusRenderCache: new StatusRenderCache(),
      liveUsage: undefined,
      liveUsageBaseline: undefined,
      liveUsageFinalizing: false,
      liveUsageRevision: 0,
      liveUsageReconcileTimeout: undefined,
      liveUsageReconcileAttempts: 0,
      outputTpsStartedAt: undefined,
      outputTpsTokens: undefined,
      outputTps: undefined,
      outputTpsLast: undefined,
      context: ctx,
      requestStatusRender: undefined,
    };
    activeSession = session;
    sessionsByIdentity.set(identityKey, session);
    await configManager.read(errorSink);
    if (!isCurrent(session)) return;
    activeModel = ctx.model;
    modelRegistry = ctx.modelRegistry;
    codexUsageStore.clearSnapshot();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    try {
      let renderFailures = 0;
      session.refreshScheduler = new RefreshScheduler((requestRender) => {
        if (!isCurrent(session)) return;
        try {
          publishWorking(session);
          if (!requestRender) return;
          if (session.resources.statusTui) requestHostRender(session.resources.statusTui);
          else session.resources.rainPanel?.requestRender();
          renderFailures = 0;
        } catch (error) {
          const stale = isStaleExtensionContextError(error);
          if (!stale) handleExtensionError(error, "scheduled UI render");
          if (stale || ++renderFailures >= 3) {
            stopWorking(session);
            session.resources.rainManager?.stop();
            session.refreshScheduler?.dispose();
          }
        }
      });
      createSessionResources(session);
      session.requestStatusRender = () => {
        if (!isCurrent(session)) return;
        session.statusRenderCache.invalidate();
        session.refreshScheduler?.requestRender();
      };
      applyPanelState(session);
      refreshKimi();
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "session UI setup");
    }
  });

  pi.registerCommand("tokyo-night", {
    description: "Open Neon Studio. Usage: /tokyo-night [on|off]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        const commandSession = sessionsByIdentity.get(identityOf(ctx));
        const savePanel = async () => {
          await sessionRetirement;
          await activeNeonStudio?.controller.pendingClose;
          const previousPanel = configManager.get().panel;
          configManager.set("panel", arg === "on");
          const snapshot = configManager.get();
          if (!await configManager.write(errorSink)) {
            if (configManager.get() === snapshot) configManager.set("panel", previousPanel);
            if (ctx.hasUI && (!commandSession || isCurrent(commandSession))) {
              ctx.ui.notify("Could not save Tokyo Night panel settings.", "error");
            }
            return;
          }
          if (!isInteractive(ctx) || !commandSession || !isCurrent(commandSession)) return;
          applyPanelState(commandSession);
          ctx.ui.notify(`Tokyo Night panel ${arg}`, "info");
        };
        const save = panelSaveTail ? panelSaveTail.then(savePanel, savePanel) : savePanel();
        panelSaveTail = save;
        try { await save; }
        finally { if (panelSaveTail === save) panelSaveTail = undefined; }
        return;
      }
      if (!isInteractive(ctx)) {
        if (ctx.hasUI) {
          ctx.ui.notify("Neon Studio is only available in TUI mode.", "info");
        }
        return;
      }
      if (panelSaveTail) await waitForPanelSaves();
      const studioSession = sessionsByIdentity.get(identityOf(ctx));
      if (!studioSession || !isCurrent(studioSession)) return;
      if (activeNeonStudio?.session === studioSession) {
        ctx.ui.notify("Neon Studio is already open.", "info");
        return;
      }
      const themeNameFor = (choice: "dark" | "light"): string =>
        choice === "dark" ? "tokyo-night-dark" : "tokyo-night-light";
      const configuredTheme = loadPiThemeSetting();
      const activeThemeChoice: NeonStudioThemeChoice | undefined =
        ctx.ui.theme.name === "tokyo-night-dark"
          ? "dark"
          : ctx.ui.theme.name === "tokyo-night-light"
            ? "light"
            : undefined;
      const persistedThemeChoice: NeonStudioThemeChoice | undefined =
        configuredTheme === TOKYO_NIGHT_AUTOMATIC_THEME_SETTING
          ? "automatic"
          : configuredTheme === "tokyo-night-dark"
            ? "dark"
            : configuredTheme === "tokyo-night-light"
              ? "light"
              : undefined;
      const initialThemeChoice: NeonStudioThemeChoice =
        persistedThemeChoice === "automatic"
          ? "automatic"
          : activeThemeChoice ?? persistedThemeChoice ?? "automatic";
      const openingThemeName = ctx.ui.theme.name;
      const openingTheme = openingThemeName
        ? ctx.ui.getTheme(openingThemeName)
        : undefined;
      const previewThemes = {
        dark: ctx.ui.getTheme(themeNameFor("dark")),
        light: ctx.ui.getTheme(themeNameFor("light")),
      };
      let automaticPreviewRevision = 0;
      let automaticPreviewPending = false;
      const restoreOpeningTheme = (): NeonStudioThemeResult => {
        automaticPreviewRevision += 1;
        automaticPreviewPending = false;
        return openingTheme && ctx.ui.theme.name !== openingTheme.name
          ? ctx.ui.setTheme(openingTheme)
          : { success: true };
      };
      let automaticPreviewTheme: Theme | undefined;
      let previewAutomaticTheme: (() => void) | undefined;
      const previewTheme = (
        choice: NeonStudioThemeChoice,
      ): NeonStudioThemeResult => {
        if (choice === "automatic") {
          previewAutomaticTheme?.();
          return { success: true };
        }

        automaticPreviewRevision += 1;
        automaticPreviewPending = false;
        const preview: Theme | undefined = choice === "dark"
          ? previewThemes.dark
          : previewThemes.light;
        if (!preview) {
          return {
            success: false,
            error: `Theme ${choice === "dark"
              ? themeNameFor("dark")
              : themeNameFor("light")} is not available.`,
          };
        }
        return openingTheme ? ctx.ui.setTheme(preview) : { success: true };
      };
      const saveTheme = (
        choice: NeonStudioThemeChoice,
      ): NeonStudioThemeResult => {
        if (choice !== "automatic") {
          const themeName = themeNameFor(choice);
          const persisted = savePiThemeSetting(themeName);
          if (!persisted.success) return persisted;

          const rollbackFixedSetting = (
            applyError: string,
          ): NeonStudioThemeResult => {
            try {
              const rollback = savePiThemeSetting(configuredTheme);
              return {
                success: false,
                error: rollback.success
                  ? applyError
                  : `${applyError} ${rollback.error ?? "Could not restore the previous theme setting."}`,
              };
            } catch (error) {
              return {
                success: false,
                error: `${applyError} Could not restore the previous theme setting: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          };

          let applied: NeonStudioThemeResult;
          try {
            applied = ctx.ui.setTheme(themeName);
          } catch (error) {
            return rollbackFixedSetting(
              error instanceof Error ? error.message : String(error),
            );
          }
          return applied.success
            ? applied
            : rollbackFixedSetting(
                applied.error ?? `Could not apply ${themeName}.`,
              );
        }
        if (automaticPreviewPending) {
          const restored = restoreOpeningTheme();
          if (!restored.success) return restored;
        } else if (
          openingTheme &&
          automaticPreviewTheme &&
          ctx.ui.theme.name !== automaticPreviewTheme.name
        ) {
          const applied = ctx.ui.setTheme(automaticPreviewTheme);
          if (!applied.success) return applied;
        }
        if (configuredTheme === TOKYO_NIGHT_AUTOMATIC_THEME_SETTING) {
          return { success: true };
        }
        const result = savePiThemeSetting(
          TOKYO_NIGHT_AUTOMATIC_THEME_SETTING,
        );
        if (result.success) {
          try {
            ctx.ui.notify(
              "Automatic Tokyo Night saved. Restart Pi to keep following terminal theme changes.",
              "info",
            );
          } catch (error) {
            if (!isStaleExtensionContextError(error)) {
              handleExtensionError(error, "Automatic theme notification");
            }
          }
        }
        return result;
      };

      let studioController: NeonStudioController | null = null;
      const studioComponent = { current: undefined as NeonStudioComponent | undefined };
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          previewAutomaticTheme = () => {
            const revision = ++automaticPreviewRevision;
            automaticPreviewPending = true;
            automaticPreviewTheme = undefined;
            void detectTerminalTheme(tui, {
              timeoutMs: AUTOMATIC_THEME_QUERY_TIMEOUT_MS,
            }).then(({ scheme }) => {
              if (revision !== automaticPreviewRevision) return;
              automaticPreviewPending = false;
              if (
                !isCurrent(studioSession) ||
                studioController?.themeChoice !== "automatic"
              ) return;

              const preview = previewThemes[scheme];
              if (!preview) {
                ctx.ui.notify(
                  `Theme ${themeNameFor(scheme)} is not available.`,
                  "error",
                );
                return;
              }
              automaticPreviewTheme = preview;
              if (!openingTheme || ctx.ui.theme.name === preview.name) {
                tui.requestRender();
                return;
              }
              const result = ctx.ui.setTheme(preview);
              if (!result.success) {
                ctx.ui.notify(
                  result.error ?? `Could not preview ${themeNameFor(scheme)}.`,
                  "error",
                );
              }
            }).catch((error) => {
              if (revision !== automaticPreviewRevision) return;
              automaticPreviewPending = false;
              if (!isStaleExtensionContextError(error)) {
                handleExtensionError(error, "Automatic theme preview");
              }
            });
          };
          studioController = new NeonStudioController({
            config: configManager,
            errorSink,
            notify: (message, level) => ctx.ui.notify(message, level),
            onConfigChange: (change: NeonStudioConfigChange) => {
              if (!isCurrent(studioSession)) return;
              if (
                change.kind === "config" &&
                (
                  change.key === "panel" ||
                  change.key === "rainMode" ||
                  change.key === "rainTickMs" ||
                  change.key === "maxRainDrops"
                )
              ) {
                applyPanelState(studioSession);
              }
              if (change.kind === "config" && change.key === "codexQuota") {
                scheduleCodexRefresh(studioSession);
              }
              if (
                (change.kind === "config" && change.key === "kimiQuota") ||
                (change.kind === "status" && change.key === "quota")
              ) {
                refreshKimi();
              }
              requestStatusRenderFor(studioSession);
            },
            previewTheme,
            saveTheme,
            restoreTheme: restoreOpeningTheme,
            initialThemeChoice,
            persistedThemeChoice,
            done: () => done(undefined),
          });
          activeNeonStudio = {
            session: studioSession,
            controller: studioController,
            component: null,
          };
          if (
            studioController.themeChoice === "automatic" &&
            persistedThemeChoice === "automatic"
          ) {
            previewAutomaticTheme();
          }
          studioComponent.current = new NeonStudioComponent(tui, theme, studioController, {
            renderFullscreenStatus:
              studioSession.resources.renderFullscreenStatus ?? undefined,
            previewThemes,
            getTheme: openingTheme ? () => ctx.ui.theme : undefined,
            getAutomaticTheme: () => automaticPreviewTheme,
            loadUsageHistory: (signal) => readUsageHistory({ signal }),
          });
          activeNeonStudio.component = studioComponent.current;
          return studioComponent.current;
        });
      } finally {
        studioComponent.current?.dispose();
        automaticPreviewRevision += 1;
        automaticPreviewPending = false;
        previewAutomaticTheme = undefined;
        if (activeNeonStudio?.controller === studioController) {
          const studio = activeNeonStudio;
          activeNeonStudio = null;
          try {
            await studio.controller.forceClose();
          } catch (error) {
            if (!isStaleExtensionContextError(error)) {
              handleExtensionError(error, "Neon Studio close");
            }
          }
        }
      }
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const identityKey = identityOf(ctx);
    const shouldDisposeBridge = consoleBridgeOwnerIdentity === identityKey;
    const bridgeRevision = consoleBridgeOwnerRevision;
    try {
      const session = sessionsByIdentity.get(identityKey);
      if (!session) {
        if (startingSession?.identityKey === identityKey && startingSession.generation === generation) {
          generation += 1;
          startingSession = undefined;
        }
        return;
      }
      const wasActive = activeSession === session;
      if (wasActive) generation += 1;
      await retireSession(session, session.mode === "tui" && session.hasUI);
    } finally {
      await sessionRetirement;
      await waitForPanelSaves();
      if (shouldDisposeBridge && bridgeRevision === consoleBridgeOwnerRevision) {
        consoleLogBridge?.dispose();
        consoleLogBridge = undefined;
        consoleBridgeOwnerIdentity = undefined;
      }
      await flushConsoleLogWrites();
    }
  });

  // The compatibility check above is diagnostic only. It never selects a
  // second UI implementation and cannot affect the 0.79+ public API path.
}

export default registerTokyoNightExtension;
