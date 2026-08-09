/** Tokyo Night Extension composition root. */

import { VERSION, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext, type KeybindingsManager, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { TokyoConfigManager } from "./core/config";
import { installConsoleLogBridge } from "./core/console-bridge";
import { EXT_PREFIX, handleExtensionError, isStaleExtensionContextError } from "./core/errors";
import { evaluatePiCompatibility, isFullscreenTui, MINIMUM_PI_VERSION, requestHostRender } from "./core/pi-compat";
import { RainAnimationManager } from "./rain/rain-manager";
import { RainPanelComponent } from "./rain/rain-panel";
import { BorderlessEditor, type BorderlessEditorDependencies } from "./ui/borderless-editor";
import { SettingsUIController } from "./ui/settings-controller";
import { buildStatusLines } from "./ui/status-bar";
import { BOX, FRAME_RGB, RESET, fgRgb } from "./ui/ui-primitives";
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
};

type SessionUIResources = {
  editorFactory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) => BorderlessEditor) | null;
  editor: BorderlessEditor | null;
  rainPanel: RainPanelComponent | null;
  rainManager: RainAnimationManager | null;
  statusTui: TUI | null;
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
  lastRenderedAt: number;
  lastRequestedAt: number;
  kimiUsageStore: KimiUsageStore;
  context: ExtensionContext;
  requestStatusRender: (() => void) | undefined;
};

const RAIN_BUSY_RENDER_INTERVAL_MS = 500;
const CODEX_COUNTDOWN_REFRESH_MS = 30_000;
const KIMI_POLL_INTERVAL_MS = 60_000;

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
  _hideSideBorders: boolean,
  statusContent: string | string[],
  frameEnabled = true,
): string[] {
  const outputWidth = safeTerminalWidth(width);
  const rows = (Array.isArray(statusContent) ? statusContent : [statusContent]);
  if (!frameEnabled) {
    return rows.map((row) => {
      const content = truncateToWidth(row, outputWidth);
      return content + " ".repeat(Math.max(0, outputWidth - visibleWidth(content)));
    });
  }

  const frameHasSideBorders = outputWidth >= 2;
  const innerWidth = frameHasSideBorders ? outputWidth - 2 : outputWidth;
  const frameFg = (value: string) => `${fgRgb(FRAME_RGB)}${value}${RESET}`;
  const padded = rows.map((row) => {
    const content = truncateToWidth(row, innerWidth);
    return content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
  });
  const bottom = outputWidth >= 2
    ? frameFg(`${BOX.bl}${BOX.h.repeat(outputWidth - 2)}${BOX.br}`)
    : frameFg(outputWidth === 1 ? BOX.bl : "");
  if (!frameHasSideBorders) return [...padded, bottom];
  return [...padded.map((row) => frameFg(BOX.v) + row + frameFg(BOX.v)), bottom];
}

/** Retained as a small ordering helper for consumers of the previous API. */
export function coordinateSelectorTransition(
  sync: () => void,
  requestRender: () => void,
): void {
  sync();
  requestRender();
}

export function registerTokyoNightExtension(
  pi: ExtensionAPI,
  dependencies: { installConsoleLogBridge?: typeof installConsoleLogBridge } = {},
): void {
  const configManager = new TokyoConfigManager();
  const codexUsageStore = createCodexUsageStore();
  const consoleLogBridge = (dependencies.installConsoleLogBridge ?? installConsoleLogBridge)();
  const sessionsByIdentity = new Map<string, SessionState>();
  let activeSession: SessionState | null = null;
  let generation = 0;
  let activeModel: Model<any> | undefined;
  let modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> } | null = null;
  let requestStatusRenderCallback: (() => void) | null = null;
  let kimiPollTimer: ReturnType<typeof setInterval> | undefined;
  let kimiPollController: AbortController | undefined;
  let kimiPollGeneration = 0;
  let kimiPollSession: SessionState | null = null;
  let kimiPollModel: Model<any> | undefined;
  const compatibility = evaluatePiCompatibility(VERSION);
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
    const now = Date.now();
    const working = session.working.phaseStartedAt !== undefined;
    const recent = (value: number) => now >= value && now - value < RAIN_BUSY_RENDER_INTERVAL_MS;
    if (working && (recent(session.lastRenderedAt) || recent(session.lastRequestedAt))) return;
    session.lastRequestedAt = now;
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
  };
  const startWorking = (session: SessionState): void => {
    stopWorking(session);
    updateWorking(session);
    session.working.timer = setInterval(() => {
      if (!isCurrent(session)) { stopWorking(session); return; }
      updateWorking(session);
    }, 250);
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

  const applyPanelState = (session: SessionState): void => {
    const manager = session.resources.rainManager;
    if (!manager) return;
    if (shouldRunRainAnimation(session.mode, configManager.get().panel)) manager.start();
    else manager.stop();
    session.resources.rainPanel?.invalidate();
    session.resources.rainPanel?.requestRender(true);
  };

  const requestEditorRender = (): void => activeSession?.resources.editor?.requestRender();
  const settingsController = new SettingsUIController(configManager, {
    requestEditorRender,
    applyPanelState: () => { if (activeSession) applyPanelState(activeSession); },
    onCodexQuotaConfigChange: () => { if (activeSession) scheduleCodexRefresh(activeSession); requestStatusRenderCallback?.(); },
    onKimiQuotaConfigChange: refreshKimi,
    onIconModeConfigChange: () => requestStatusRenderCallback?.(),
  });

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
    try {
      session.ui.setWorkingMessage();
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
      requestStatusRenderCallback = null;
      stopKimiPolling();
      settingsController.reset();
    }
    if (clearUI && session.mode === "tui" && session.hasUI) teardownSessionUI(session);
    if (sessionsByIdentity.get(session.identityKey) === session) sessionsByIdentity.delete(session.identityKey);
  };

  const createSessionResources = (session: SessionState): void => {
    const borderlessDependencies: BorderlessEditorDependencies = {
      config: configManager,
      settingsController,
    };
    const renderStatusLines = (width: number, theme: Theme): string[] => {
      if (!isCurrent(session)) return [];
      void updateBranch(session);
      const outputWidth = safeTerminalWidth(width);
      const lines = buildStatusLines(
        outputWidth,
        theme,
        session.context,
        session.branch.cachedBranch,
        pi.getThinkingLevel(),
        configManager,
        codexUsageStore,
        session.kimiUsageStore,
      );
      return buildStatusWidgetLines(outputWidth, false, lines, configManager.get().editorFrame);
    };
    const editorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions): BorderlessEditor => {
      const editor = new BorderlessEditor(
        tui,
        theme,
        keybindings,
        session.ui,
        {
          ...borderlessDependencies,
          renderFullscreenStatus: (width) => renderStatusLines(width, session.ui.theme),
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
        onRendered: (renderedAt) => { if (isCurrent(session)) session.lastRenderedAt = renderedAt; },
      });
      if (isCurrent(session)) session.resources.rainPanel = panel;
      return panel;
    };
    const statusFactory = (tui: TUI, theme: Theme) => {
      session.resources.statusTui = tui;
      return {
        invalidate: () => session.requestStatusRender?.(),
        render: (width: number): string[] => {
          // Fullscreen composes status inside BorderlessEditor so the host's
          // fixed editor height cannot insert a separator row before it.
          if (isFullscreenTui(tui)) return [];
          return renderStatusLines(width, theme);
        },
        dispose: () => { if (session.resources.statusTui === tui) session.resources.statusTui = null; },
      };
    };
    const footerFactory = (tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
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
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || !ctx.isIdle()) return;
    resetWorking(session);
    session.ui.setWorkingMessage();
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
    session.working.activeTools.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() });
    updateWorking(session);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session || !isCurrent(session) || session.mode !== "tui" || !session.hasUI || session.working.phaseStartedAt === undefined) return;
    session.working.activeTools.delete(event.toolCallId);
    if (session.working.activeTools.size === 0) setWorkingPhase(session, "waiting");
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
    activeModel = event.model;
    codexUsageStore.clearSnapshot();
    scheduleCodexRefresh(session);
    refreshKimi();
  });

  pi.on("session_start", async (_event, ctx) => {
    consoleLogBridge.setInteractive(isInteractive(ctx));
    if (!compatibility.supported) {
      if (!compatibilityWarningShown) {
        compatibilityWarningShown = true;
        console.warn(`${EXT_PREFIX} Pi ${VERSION} is below the supported minimum ${MINIMUM_PI_VERSION}; interactive UI resources will not be registered.`);
      }
      return;
    }
    const identityKey = identityOf(ctx);
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
      resources: { editorFactory: null, editor: null, rainPanel: null, rainManager: null, statusTui: null, footerOwned: false, footerSubscription: null },
      statusRenderDebounceTimeout: undefined,
      codexCountdownRefreshTimeout: undefined,
      working: { phase: "waiting", phaseStartedAt: undefined, activeTools: new Map(), timer: undefined },
      lastRenderedAt: Date.now(),
      lastRequestedAt: Date.now(),
      kimiUsageStore: createKimiUsageStore(),
      context: ctx,
      requestStatusRender: undefined,
    };
    activeSession = session;
    sessionsByIdentity.set(identityKey, session);
    configManager.read();
    activeModel = ctx.model;
    modelRegistry = ctx.modelRegistry;
    codexUsageStore.clearSnapshot();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    try {
      createSessionResources(session);
      session.requestStatusRender = () => {
        if (!isCurrent(session)) return;
        if (session.statusRenderDebounceTimeout !== undefined) clearTimeout(session.statusRenderDebounceTimeout);
        session.statusRenderDebounceTimeout = setTimeout(() => {
          session.statusRenderDebounceTimeout = undefined;
          if (isCurrent(session)) requestHostRender(session.resources.statusTui);
        }, 33);
      };
      requestStatusRenderCallback = session.requestStatusRender;
      applyPanelState(session);
      refreshKimi();
    } catch (error) {
      if (!isStaleExtensionContextError(error)) handleExtensionError(error, "session UI setup");
    }
  });

  pi.registerCommand("tokyo-night", {
    description: "Open the Tokyo Night settings panel. Usage: /tokyo-night [on|off]",
    handler: async (args: string, ctx: ExtensionContext) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        configManager.set("panel", arg === "on");
        configManager.write();
        if (!isInteractive(ctx) || !activeSession) return;
        applyPanelState(activeSession);
        ctx.ui.notify(`Tokyo Night panel ${arg}`, "info");
        return;
      }
      if (!isInteractive(ctx)) {
        if (ctx.hasUI) {
          ctx.ui.notify("Tokyo Night settings panel is only available in TUI mode.", "info");
        }
        return;
      }
      if (settingsController.isActive) {
        settingsController.exit();
        if (activeSession) applyPanelState(activeSession);
      } else {
        settingsController.enter();
      }
      requestEditorRender();
    },
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const session = sessionsByIdentity.get(identityOf(ctx));
    if (!session) return;
    const wasActive = activeSession === session;
    retireSession(session, session.mode === "tui" && session.hasUI);
    if (wasActive) generation += 1;
    // Keep late shutdown errors captured until the next session_start chooses
    // the next routing mode; retiring async work can still log after shutdown.
  });

  // The compatibility check above is diagnostic only. It never selects a
  // second UI implementation and cannot affect the 0.79+ public API path.
}

export default registerTokyoNightExtension;
