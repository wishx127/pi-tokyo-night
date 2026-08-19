/** Tokyo Night Extension composition root. */

import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ExtensionUIContext, type KeybindingsManager, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { TokyoConfigManager } from "./core/config";
import {
  createTokyoNightErrorSink,
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
import { buildStatusLines } from "./ui/status-bar";
import { StatusRenderCache } from "./ui/status-render-cache";
import { renderFrameSegment } from "./ui/frame-layout";
import { CYAN, PURPLE, RESET } from "./ui/ui-primitives";
import { createCodexUsageStore, createKimiUsageStore, fetchKimiUsage, isCodexModel, isKimiModel, resolveKimiApiKey, type KimiUsageStore } from "./usage";

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
  timer: ReturnType<typeof setInterval> | undefined;
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
  statusRenderDebounceTimeout: ReturnType<typeof setTimeout> | undefined;
  codexCountdownRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
  working: NativeWorkingState;
  rainActivity: RainActivity;
  kimiUsageStore: KimiUsageStore;
  statusRenderCache: StatusRenderCache;
  context: ExtensionContext;
  requestStatusRender: (() => void) | undefined;
};

const WORKING_MESSAGE_INTERVAL_MS = 100;
const WORKING_INDICATOR_INTERVAL_MS = 80;
const TOKYO_WORKING_FRAMES = Object.freeze([
  `${CYAN}⠋${RESET}`,
  `${PURPLE}⠙${RESET}`,
  `${CYAN}⠹${RESET}`,
  `${PURPLE}⠸${RESET}`,
  `${CYAN}⠼${RESET}`,
  `${PURPLE}⠴${RESET}`,
  `${CYAN}⠦${RESET}`,
  `${PURPLE}⠧${RESET}`,
  `${CYAN}⠇${RESET}`,
  `${PURPLE}⠏${RESET}`,
]);
const CODEX_COUNTDOWN_REFRESH_MS = 30_000;
const KIMI_POLL_INTERVAL_MS = 60_000;

export const TOKYO_NIGHT_AUTOMATIC_THEME_SETTING =
  "tokyo-night-light/tokyo-night-dark";

export interface PiThemeSettingResult {
  success: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  themeSetting: string,
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

    fs.mkdirSync(agentDir, { recursive: true });
    temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify({ ...settings, theme: themeSetting }, null, 2),
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
): string[] {
  return renderFrameSegment({
    width: safeTerminalWidth(width),
    lines: Array.isArray(statusContent) ? statusContent : [statusContent],
    frameEnabled,
    role: "bottom",
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
  } = {},
): void {
  const configManager = new TokyoConfigManager();
  const codexUsageStore = createCodexUsageStore();
  const installBridge = dependencies.installConsoleLogBridge ?? installConsoleLogBridge;
  let consoleLogBridge: ConsoleLogBridge | undefined;
  let consoleBridgeOwnerIdentity: string | undefined;
  const errorSink = dependencies.errorSink ?? createTokyoNightErrorSink();
  const sessionsByIdentity = new Map<string, SessionState>();
  let activeSession: SessionState | null = null;
  let activeNeonStudio: {
    session: SessionState;
    controller: NeonStudioController;
  } | null = null;
  let generation = 0;
  let activeModel: Model<any> | undefined;
  let modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> } | null = null;
  let kimiPollTimer: ReturnType<typeof setInterval> | undefined;
  let kimiPollController: AbortController | undefined;
  let kimiPollGeneration = 0;
  let kimiPollSession: SessionState | null = null;
  let kimiPollModel: Model<any> | undefined;
  const loadPiThemeSetting = dependencies.readPiThemeSetting ?? readPiThemeSetting;
  const savePiThemeSetting = dependencies.writePiThemeSetting ?? writePiThemeSetting;
  const compatibility = dependencies.compatibility ?? evaluatePiCompatibility(VERSION);
  let compatibilityWarningShown = false;

  const isInteractive = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.hasUI;
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
    kimiPollGeneration += 1;
  };

  const canPollKimi = (session: SessionState, model: Model<any> | undefined): boolean =>
    isCurrent(session) && session.mode === "tui" && session.hasUI &&
    configManager.get().kimiQuota && activeModel === model && isKimiModel(model);

  const requestStatusRenderFor = (session: SessionState): void => {
    if (isCurrent(session)) session.requestStatusRender?.();
  };

  const requestRainRender = (session: SessionState): void => {
    if (!isCurrent(session) || !session.resources.rainManager || !configManager.get().panel) return;
    if (session.working.timer !== undefined) return;
    session.resources.rainPanel?.requestRender();
  };

  const stopWorking = (session: SessionState): void => {
    if (session.working.timer !== undefined) clearInterval(session.working.timer);
    session.working.timer = undefined;
  };
  const resetWorking = (session: SessionState): void => {
    stopWorking(session);
    session.working.phase = "waiting";
    session.working.phaseStartedAt = undefined;
    session.working.activeTools.clear();
  };
  const formatDuration = (milliseconds: number): string => {
    const seconds = Math.max(0, milliseconds) / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  };
  const workingMessage = (working: NativeWorkingState): string => {
    const tool = working.activeTools.values().next().value as WorkingTool | undefined;
    if (tool) {
      const extra = working.activeTools.size > 1 ? ` +${working.activeTools.size - 1}` : "";
      return `Using tools · ${tool.name} ${formatDuration(Date.now() - tool.startedAt)}${extra}`;
    }
    const label = working.phase[0].toUpperCase() + working.phase.slice(1);
    const elapsed = working.phaseStartedAt === undefined ? "0.0s" : formatDuration(Date.now() - working.phaseStartedAt);
    return `${label} ${elapsed}`;
  };
  const updateWorking = (session: SessionState): void => {
    if (!isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    try { session.ui.setWorkingMessage(workingMessage(session.working)); }
    catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working message update"); }
    try {
      if (configManager.get().panel) session.resources.rainPanel?.requestRender();
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working rain render");
    }
  };
  const restoreWorkingUi = (session: SessionState): void => {
    try { session.working.setIndicator?.(); }
    catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working indicator restore"); }
    try { session.ui.setWorkingMessage(); }
    catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working message restore"); }
  };
  const startWorking = (session: SessionState): void => {
    stopWorking(session);
    try {
      session.working.setIndicator?.({
        frames: [...TOKYO_WORKING_FRAMES],
        intervalMs: WORKING_INDICATOR_INTERVAL_MS,
      });
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working indicator update");
    }
    updateWorking(session);
    session.working.timer = setInterval(() => {
      if (!isCurrent(session)) { stopWorking(session); return; }
      updateWorking(session);
    }, WORKING_MESSAGE_INTERVAL_MS);
    session.working.timer.unref?.();
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

  const pollKimi = async (session: SessionState, model: Model<any>, pollGeneration: number): Promise<void> => {
    if (!canPollKimi(session, model) || pollGeneration !== kimiPollGeneration) return;
    const controller = new AbortController();
    kimiPollController = controller;
    try {
      const key = await resolveKimiApiKey((provider) => modelRegistry?.getApiKeyForProvider(provider) ?? Promise.resolve(undefined));
      if (!key || controller.signal.aborted || !canPollKimi(session, model) || pollGeneration !== kimiPollGeneration) return;
      const result = await fetchKimiUsage(key, controller.signal);
      if (result.ok && !controller.signal.aborted && canPollKimi(session, model) && pollGeneration === kimiPollGeneration) {
        session.kimiUsageStore.setSnapshot(result.snapshot);
        requestStatusRenderFor(session);
      }
    } catch (error) {
      if (!controller.signal.aborted && canPollKimi(session, model)) handleExtensionError(error, "kimi usage poll");
    } finally {
      if (kimiPollController === controller) kimiPollController = undefined;
    }
  };
  const refreshKimi = (): void => {
    const session = activeSession;
    const model = activeModel;
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
    const manager = session.resources.rainManager;
    if (!manager || !manager.isRunning) return;
    manager.applyProfile(resolveRainRuntimeProfile(configManager.get(), activity));
  };

  const applyPanelState = (session: SessionState): void => {
    const manager = session.resources.rainManager;
    if (!manager) return;
    if (shouldRunRainAnimation(session.mode, configManager.get().panel)) {
      const profile = resolveRainRuntimeProfile(
        configManager.get(),
        session.rainActivity,
      );
      if (manager.isRunning) manager.applyProfile(profile);
      else manager.start(profile);
    } else {
      manager.stop();
    }
    session.resources.rainPanel?.invalidate();
    session.resources.rainPanel?.requestRender(true);
  };

  const clearSessionTimers = (session: SessionState): void => {
    resetWorking(session);
    abortBranch(session.branch);
    session.branch.requestToken += 1;
    if (session.statusRenderDebounceTimeout !== undefined) clearTimeout(session.statusRenderDebounceTimeout);
    session.statusRenderDebounceTimeout = undefined;
    if (session.codexCountdownRefreshTimeout !== undefined) clearTimeout(session.codexCountdownRefreshTimeout);
    session.codexCountdownRefreshTimeout = undefined;
  };

  const teardownSessionUI = (session: SessionState): void => {
    const resources = session.resources;
    resources.rainManager?.stop();
    resources.rainPanel?.dispose();
    resources.editor?.dispose();
    resources.editor = null;
    resources.rainPanel = null;
    resources.rainManager = null;
    resources.statusTui = null;
    resources.renderFullscreenStatus = null;
    if (resources.footerOwned) {
      try { session.ui.setFooter(undefined); }
      catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "footer teardown"); }
    }
    resources.footerSubscription?.dispose();
    resources.footerSubscription = null;
    resources.footerOwned = false;

    try {
      session.ui.setWidget("tokyo-rain", undefined);
      session.ui.setWidget("tokyo-status", undefined);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "widget teardown");
    }
    try {
      if (session.ui.getEditorComponent() === resources.editorFactory) session.ui.setEditorComponent(undefined);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "editor teardown");
    }
    restoreWorkingUi(session);
    try {
      session.ui.setWorkingVisible(true);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "working teardown");
    }
  };

  const retireSession = (session: SessionState, clearUI: boolean): void => {
    if (session.disposed) return;
    session.disposed = true;
    clearSessionTimers(session);
    if (activeSession === session) {
      activeSession = null;
      stopKimiPolling();
    }
    if (activeNeonStudio?.session === session) {
      const studio = activeNeonStudio;
      activeNeonStudio = null;
      try {
        studio.controller.forceClose();
      } catch (error) {
        if (!isStaleExtensionContextError(error)) {
          handleExtensionError(error, "Neon Studio teardown");
        }
      }
    }
    if (clearUI && session.mode === "tui" && session.hasUI) teardownSessionUI(session);
    if (sessionsByIdentity.get(session.identityKey) === session) sessionsByIdentity.delete(session.identityKey);
  };

  const createSessionResources = (session: SessionState): void => {
    const borderlessDependencies: BorderlessEditorDependencies = {
      config: configManager,
    };
    const renderStatusLines = (width: number, theme: Theme): string[] => {
      if (!isCurrent(session)) return [];
      const outputWidth = safeTerminalWidth(width);
      const config = configManager.get();
      const thinkingLevel = pi.getThinkingLevel();
      let leafId: string | null | undefined;
      try { leafId = session.context.sessionManager.getLeafId(); }
      catch { leafId = undefined; }
      const codexUsage = codexUsageStore.getSnapshot();
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
      }, () => {
        void updateBranch(session);
        const lines = buildStatusLines(
          outputWidth,
          theme,
          session.context,
          session.branch.cachedBranch,
          thinkingLevel,
          configManager,
          codexUsageStore,
          session.kimiUsageStore,
        );
        return buildStatusWidgetLines(outputWidth, lines, config.editorFrame);
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
      if (isCurrent(session)) session.resources.editor = editor;
      return editor;
    };
    session.resources.editorFactory = editorFactory;
    session.resources.rainManager = new RainAnimationManager(configManager, {
      requestRender: () => requestRainRender(session),
    });

    const rainFactory = (tui: TUI): RainPanelComponent => {
      const panel = new RainPanelComponent(tui, {
        config: configManager,
        rain: session.resources.rainManager!,
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
          return renderStatusLines(width, theme);
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
    if (!session || !isCurrent(session) || session.working.phaseStartedAt === undefined) return;
    setWorkingPhase(session, "waiting", true);
    updateWorking(session);
  });
  pi.on("agent_end", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI) return;
    stopWorking(session);
    try { requestRainRender(session); }
    catch (error) { if (!isStaleExtensionContextError(error)) handleExtensionError(error, "agent end rain render"); }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || !ctx.isIdle()) return;
    applyRainProfile(session, "idle");
    resetWorking(session);
    restoreWorkingUi(session);
  });
  pi.on("message_update", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || session.working.phaseStartedAt === undefined) return;
    const type = event.assistantMessageEvent.type;
    const phase: WorkingPhase | undefined = type.includes("thinking") || type.includes("toolcall") ? "thinking" : type.includes("text") ? "streaming" : undefined;
    if (phase && setWorkingPhase(session, phase)) updateWorking(session);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || session.working.phaseStartedAt === undefined) return;
    applyRainProfile(session, "tools");
    session.working.activeTools.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() });
    updateWorking(session);
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
    const previous = activeSession;
    if (previous) retireSession(previous, previous.ui === ctx.ui);
    const duplicate = sessionsByIdentity.get(identityKey);
    if (duplicate) retireSession(duplicate, duplicate.ui === ctx.ui);

    const session: SessionState = {
      generation: ++generation,
      ui: ctx.ui,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      cwd: ctx.cwd,
      identityKey,
      disposed: false,
      footerData: null,
      branch: { cachedBranch: "", cacheTime: 0, pending: false, requestToken: 0, requestController: undefined, cwd: undefined },
      resources: { editorFactory: null, editor: null, rainPanel: null, rainManager: null, statusTui: null, renderFullscreenStatus: null, footerOwned: false, footerSubscription: null },
      statusRenderDebounceTimeout: undefined,
      codexCountdownRefreshTimeout: undefined,
      working: {
        phase: "waiting",
        phaseStartedAt: undefined,
        activeTools: new Map(),
        timer: undefined,
        setIndicator: resolveWorkingIndicatorSetter(ctx.ui),
      },
      rainActivity: "idle",
      kimiUsageStore: createKimiUsageStore(),
      statusRenderCache: new StatusRenderCache(),
      context: ctx,
      requestStatusRender: undefined,
    };
    activeSession = session;
    sessionsByIdentity.set(identityKey, session);
    configManager.read(errorSink);
    activeModel = ctx.model;
    modelRegistry = ctx.modelRegistry;
    codexUsageStore.clearSnapshot();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    try {
      createSessionResources(session);
      session.requestStatusRender = () => {
        if (!isCurrent(session)) return;
        session.statusRenderCache.invalidate();
        if (session.statusRenderDebounceTimeout !== undefined) clearTimeout(session.statusRenderDebounceTimeout);
        session.statusRenderDebounceTimeout = setTimeout(() => {
          session.statusRenderDebounceTimeout = undefined;
          if (isCurrent(session)) requestHostRender(session.resources.statusTui);
        }, 33);
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
        const previousPanel = configManager.get().panel;
        configManager.set("panel", arg === "on");
        if (!configManager.write(errorSink)) {
          configManager.set("panel", previousPanel);
          if (ctx.hasUI) {
            ctx.ui.notify("Could not save Tokyo Night panel settings.", "error");
          }
          return;
        }
        if (!isInteractive(ctx) || !activeSession) return;
        applyPanelState(activeSession);
        ctx.ui.notify(`Tokyo Night panel ${arg}`, "info");
        return;
      }
      if (!isInteractive(ctx)) {
        if (ctx.hasUI) {
          ctx.ui.notify("Neon Studio is only available in TUI mode.", "info");
        }
        return;
      }
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
      const previewThemes = {
        dark: ctx.ui.getTheme(themeNameFor("dark")),
        light: ctx.ui.getTheme(themeNameFor("light")),
      };
      const previewTheme = (
        choice: NeonStudioThemeChoice,
      ): NeonStudioThemeResult => {
        if (choice === "automatic") return { success: true };
        return previewThemes[choice]
          ? { success: true }
          : {
              success: false,
              error: `Theme ${themeNameFor(choice)} is not available.`,
            };
      };
      const saveTheme = (
        choice: NeonStudioThemeChoice,
      ): NeonStudioThemeResult => {
        if (choice !== "automatic") {
          return ctx.ui.setTheme(themeNameFor(choice));
        }
        const result = savePiThemeSetting(
          TOKYO_NIGHT_AUTOMATIC_THEME_SETTING,
        );
        if (result.success) {
          try {
            ctx.ui.notify(
              "Automatic Tokyo Night saved. Restart Pi to apply the terminal theme.",
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
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
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
              if (change.kind === "config" && change.key === "kimiQuota") {
                refreshKimi();
              }
              requestStatusRenderFor(studioSession);
            },
            previewTheme,
            saveTheme,
            initialThemeChoice,
            persistedThemeChoice,
            done: () => done(undefined),
          });
          activeNeonStudio = {
            session: studioSession,
            controller: studioController,
          };
          return new NeonStudioComponent(tui, theme, studioController, {
            renderFullscreenStatus:
              studioSession.resources.renderFullscreenStatus ?? undefined,
            previewThemes,
          });
        });
      } finally {
        if (activeNeonStudio?.controller === studioController) {
          const studio = activeNeonStudio;
          activeNeonStudio = null;
          try {
            studio.controller.forceClose();
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
    try {
      const session = sessionsByIdentity.get(identityKey);
      if (!session) return;
      const wasActive = activeSession === session;
      retireSession(session, session.mode === "tui" && session.hasUI);
      if (wasActive) generation += 1;
    } finally {
      if (shouldDisposeBridge) {
        consoleLogBridge?.dispose();
        consoleLogBridge = undefined;
        consoleBridgeOwnerIdentity = undefined;
      }
    }
  });

  // The compatibility check above is diagnostic only. It never selects a
  // second UI implementation and cannot affect the 0.79+ public API path.
}

export default registerTokyoNightExtension;
