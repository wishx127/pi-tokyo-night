/**
 * Tokyo Night Extension composition root.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  createCodexUsageStore,
  createKimiUsageStore,
  isCodexModel,
  fetchKimiUsage,
  isKimiModel,
  resolveKimiApiKey,
  type KimiUsageStore,
} from "./usage";
import { TokyoConfigManager } from "./config";
import { installConsoleLogBridge } from "./console-bridge";
import {
  EXT_PREFIX,
  handleExtensionError,
  isStaleExtensionContextError,
} from "./errors";
import {
  BorderlessEditor,
  type BorderlessEditorDependencies,
} from "./borderless-editor";
import {
  RainAnimationManager,
} from "./rain-manager";
import {
  SelectorDetector,
} from "./selector-detector";
import {
  SettingsUIController,
} from "./settings-controller";
import { buildStatusLines } from "./status-bar";
import {
  BOX,
  FRAME_RGB,
  RESET,
  fgRgb,
} from "./ui-primitives";

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

type WorkingTool = {
  name: string;
  startedAt: number;
};

type NativeWorkingState = {
  phase: WorkingPhase;
  phaseStartedAt: number | undefined;
  activeTools: Map<string, WorkingTool>;
  timer: ReturnType<typeof setInterval> | undefined;
};

type SessionState = {
  generation: number;
  ui: ExtensionUIContext;
  mode: TokyoNightMode;
  hasUI: boolean;
  cwd: string;
  disposed: boolean;
  editorPollTimeout: ReturnType<typeof setTimeout> | undefined;
  editorPollDelay: number;
  editorWasDetached: boolean;
  footerData: ReadonlyFooterDataProvider | null;
  branch: BranchState;
  statusRenderDebounceTimeout: ReturnType<typeof setTimeout> | undefined;
  statusTui: TUI | null;
  requestStatusRender: (() => void) | null;
  working: NativeWorkingState;
  origSetWidget: ((...args: any[]) => any) | null;
  setWidgetWrapper: ((...args: any[]) => any) | null;
  editor: BorderlessEditor | null;
  manager: object;
  identityKey: string;
  kimiUsageStore: KimiUsageStore;
  codexCountdownRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
};

/** Rain can only run while this extension owns an interactive TUI session. */
export function shouldRunRainAnimation(
  mode: TokyoNightMode,
  panelEnabled: boolean,
): boolean {
  return mode === "tui" && panelEnabled;
}

function safeTerminalWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name?: unknown }).name === "AbortError")
  );
}

/**
 * Render the status widget with its frame when enabled, or as one plain
 * content row when the editor frame is disabled. This is kept as a public,
 * observable seam because terminals can report widths of 0, 1, or 2 during
 * resize and redraw races.
 */
export function coordinateSelectorTransition(
  syncOverlay: () => void,
  requestFullRender: () => void,
): void {
  syncOverlay();
  requestFullRender();
}

export function buildStatusWidgetLines(
  width: number,
  hideSideBorders: boolean,
  statusContent: string | string[],
  frameEnabled = true,
): string[] {
  const outputWidth = safeTerminalWidth(width);
  const contentRows = Array.isArray(statusContent)
    ? statusContent
    : [statusContent];
  const rows = contentRows.length > 0 ? contentRows : [""];
  if (!frameEnabled) {
    return rows.map((row) => {
      const content = truncateToWidth(row, outputWidth);
      return content + " ".repeat(Math.max(0, outputWidth - visibleWidth(content)));
    });
  }

  const frameHasSideBorders = !hideSideBorders && outputWidth >= 2;
  const innerWidth = frameHasSideBorders ? outputWidth - 2 : outputWidth;
  const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;
  const paddedRows = rows.map((row) => {
    const content = truncateToWidth(row, innerWidth);
    return content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
  });

  const bottomLine = hideSideBorders
    ? frameFg(BOX.h.repeat(outputWidth))
    : outputWidth >= 2
      ? frameFg(`${BOX.bl}${BOX.h.repeat(outputWidth - 2)}${BOX.br}`)
      : frameFg(outputWidth === 1 ? BOX.bl : "");

  if (!frameHasSideBorders) {
    return [...paddedRows, bottomLine];
  }

  return [
    ...paddedRows.map((content) => frameFg(BOX.v) + content + frameFg(BOX.v)),
    bottomLine,
  ];
}

export function registerTokyoNightExtension(
  pi: ExtensionAPI,
  dependencies: {
    installConsoleLogBridge?: typeof installConsoleLogBridge;
  } = {},
) {
  // Every invocation gets its own composition root. Do not move these values
  // to module scope: Pi can replace an extension runtime while old callbacks
  // and asynchronous work are still unwinding.
  const configManager = new TokyoConfigManager();
  const codexUsageStore = createCodexUsageStore();
  let editorUIContext: ExtensionUIContext | null = null;
  let requestStatusRenderCallback: () => void = () => {};
  let requestStatusRenderRef: (() => void) | null = null;
  let requestRainOverlayRenderCallback: () => void = () => {};
  let refreshCodexQuotaState: () => void = () => {};
  let refreshKimiQuotaState: () => void = () => {};
  let applyCurrentPanelState: () => void = () => {};
  let panelSessionMode: TokyoNightMode = "print";
  let activeModel: Model<any> | undefined;

  // ── Kimi quota polling state ─────────────────────────────────────────────
  // Kimi exposes no quota response headers, so we actively poll the
  // /usages endpoint while a kimi-coding model is active and the toggle is on.
  // The store itself belongs to SessionState; these values only coordinate the
  // one active session's timer and invalidate stale async work.
  const KIMI_POLL_INTERVAL_MS = 60_000;
  let kimiPollTimer: ReturnType<typeof setInterval> | undefined;
  let kimiPollSession: SessionState | null = null;
  let kimiPollModel: Model<any> | undefined;
  let kimiPollGeneration = 0;
  let kimiPollInFlightGeneration: number | undefined;
  let kimiPollController: AbortController | undefined;
  let modelRegistryRef: { getApiKeyForProvider(provider: string): Promise<string | undefined> } | null = null;

  const stopKimiPolling = (): void => {
    if (kimiPollTimer !== undefined) {
      clearInterval(kimiPollTimer);
      kimiPollTimer = undefined;
    }
    kimiPollController?.abort();
    kimiPollController = undefined;
    kimiPollSession = null;
    kimiPollModel = undefined;
    kimiPollGeneration += 1;
    kimiPollInFlightGeneration = undefined;
  };

  const canPollKimiUsage = (
    session: SessionState,
    model: Model<any> | undefined,
  ): boolean =>
    activeSession === session &&
    isCurrentSession(session) &&
    session.mode === "tui" &&
    session.hasUI &&
    configManager.get().kimiQuota &&
    activeModel === model &&
    isKimiModel(model);

  const pollKimiUsage = async (
    session: SessionState,
    model: Model<any> | undefined,
    generation: number,
  ): Promise<void> => {
    if (!canPollKimiUsage(session, model) || generation !== kimiPollGeneration) {
      return;
    }
    if (kimiPollInFlightGeneration === generation) return;

    kimiPollInFlightGeneration = generation;
    const controller = new AbortController();
    kimiPollController = controller;
    const registry = modelRegistryRef;
    try {
      const apiKey = await resolveKimiApiKey((provider) =>
        registry
          ? registry.getApiKeyForProvider(provider)
          : Promise.resolve(undefined),
      );
      if (
        !apiKey ||
        controller.signal.aborted ||
        generation !== kimiPollGeneration ||
        !canPollKimiUsage(session, model)
      ) {
        return;
      }

      const result = await fetchKimiUsage(apiKey, controller.signal);
      if (
        controller.signal.aborted ||
        generation !== kimiPollGeneration ||
        !canPollKimiUsage(session, model)
      ) {
        return;
      }
      if (result.ok) {
        session.kimiUsageStore.setSnapshot(result.snapshot);
        requestStatusRenderFor(session);
      }
      // On failure keep the last successful snapshot visible while transient
      // errors recover (same behavior as the reference implementations).
    } catch (err) {
      if (!controller.signal.aborted && canPollKimiUsage(session, model)) {
        handleExtensionError(err, "kimi usage poll");
      }
    } finally {
      if (kimiPollInFlightGeneration === generation) {
        kimiPollInFlightGeneration = undefined;
      }
      if (kimiPollController === controller) {
        kimiPollController = undefined;
      }
    }
  };
  let sessionGeneration = 0;
  let activeSession: SessionState | null = null;
  let ownedEditor: BorderlessEditor | null = null;
  // Pi creates a fresh ExtensionContext for every event. SessionManager itself
  // can be reused by in-memory new/fork flows, so object identity is not a
  // session identity. Pi's session id is stable for the session and is also
  // present for ephemeral sessions; include the file when one exists so a
  // reused manager with a new session cannot hit an old state entry.
  const sessionsByIdentity = new Map<string, SessionState>();
  // This is only a fallback for Pi's in-memory fork path: that path mutates a
  // reused manager before emitting the old session's shutdown, so its old
  // stable id is no longer observable in that shutdown context. It is never
  // used as the primary cross-event identity.
  const currentSessionByManager = new WeakMap<object, SessionState>();
  const reusedManagers = new WeakSet<object>();

  const getSessionIdentity = (ctx: ExtensionContext): string => {
    const manager = ctx.sessionManager;
    const sessionId = manager.getSessionId();
    const sessionFile = manager.getSessionFile();
    return `id:${sessionId}|file:${sessionFile ?? ""}`;
  };

  const isInteractiveTui = (ctx: ExtensionContext): boolean =>
    ctx.mode === "tui" && ctx.hasUI;
  const consoleLogBridge = (
    dependencies.installConsoleLogBridge ?? installConsoleLogBridge
  )();

  const formatWorkingDuration = (milliseconds: number): string => {
    const seconds = Math.max(0, milliseconds) / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
    if (minutes < 60) return `${minutes}:${remainingSeconds}`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = (minutes % 60).toString().padStart(2, "0");
    return `${hours}:${remainingMinutes}:${remainingSeconds}`;
  };

  const formatWorkingMessage = (working: NativeWorkingState): string => {
    const activeTool = working.activeTools.values().next().value as
      | WorkingTool
      | undefined;
    if (activeTool) {
      const extraTools = working.activeTools.size > 1
        ? ` +${working.activeTools.size - 1}`
        : "";
      return `Using tools · ${activeTool.name} ${formatWorkingDuration(
        Date.now() - activeTool.startedAt,
      )}${extraTools}`;
    }

    const label = working.phase[0].toUpperCase() + working.phase.slice(1);
    const elapsed = working.phaseStartedAt === undefined
      ? "0.0s"
      : formatWorkingDuration(Date.now() - working.phaseStartedAt);
    return `${label} ${elapsed}`;
  };

  const stopWorkingTimer = (session: SessionState): void => {
    if (session.working.timer !== undefined) {
      clearInterval(session.working.timer);
      session.working.timer = undefined;
    }
  };

  const resetWorkingState = (session: SessionState): void => {
    stopWorkingTimer(session);
    session.working.phase = "waiting";
    session.working.phaseStartedAt = undefined;
    session.working.activeTools.clear();
  };

  const setWorkingPhase = (
    session: SessionState,
    phase: WorkingPhase,
    restart = false,
  ): void => {
    if (
      !restart &&
      session.working.phase === phase &&
      session.working.phaseStartedAt !== undefined
    ) {
      return;
    }
    session.working.phase = phase;
    session.working.phaseStartedAt = Date.now();
  };

  const updateWorkingMessage = (session: SessionState): void => {
    if (!isCurrentSession(session) || session.mode !== "tui" || !session.hasUI) {
      return;
    }
    try {
      session.ui.setWorkingMessage(formatWorkingMessage(session.working));
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        handleExtensionError(err, "working message update");
      }
    }
  };

  const startWorkingTimer = (session: SessionState): void => {
    stopWorkingTimer(session);
    updateWorkingMessage(session);
    session.working.timer = setInterval(() => {
      if (!isCurrentSession(session)) {
        stopWorkingTimer(session);
        return;
      }
      updateWorkingMessage(session);
    }, 250);
    session.working.timer.unref?.();
  };

  const isCurrentInteractiveSession = (
    ctx: ExtensionContext,
  ): SessionState | undefined => {
    if (!isInteractiveTui(ctx)) return undefined;
    try {
      const session = sessionsByIdentity.get(getSessionIdentity(ctx));
      return session && isCurrentSession(session) ? session : undefined;
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        handleExtensionError(err, "working session lookup");
      }
      return undefined;
    }
  };

  const isCurrentSession = (session: SessionState): boolean =>
    activeSession === session &&
    !session.disposed &&
    session.generation === sessionGeneration;

  const abortBranchRequest = (branch: BranchState): void => {
    branch.requestController?.abort();
    branch.requestController = undefined;
  };

  const clearSessionTimers = (session: SessionState): void => {
    resetWorkingState(session);
    if (session.editorPollTimeout !== undefined) {
      clearTimeout(session.editorPollTimeout);
      session.editorPollTimeout = undefined;
    }
    if (session.statusRenderDebounceTimeout !== undefined) {
      clearTimeout(session.statusRenderDebounceTimeout);
      session.statusRenderDebounceTimeout = undefined;
    }
    if (session.codexCountdownRefreshTimeout !== undefined) {
      clearTimeout(session.codexCountdownRefreshTimeout);
      session.codexCountdownRefreshTimeout = undefined;
    }
    abortBranchRequest(session.branch);
    session.branch.requestToken += 1;
    session.branch.pending = false;
    session.requestStatusRender = null;
  };

  const resetActiveComposition = (session: SessionState): void => {
    clearSessionTimers(session);
    panelSessionMode = "print";
    editorUIContext = null;
    activeModel = undefined;
    codexUsageStore.clearSnapshot();
    stopKimiPolling();
    modelRegistryRef = null;
    session.kimiUsageStore.clearSnapshot();
    requestStatusRenderCallback = () => {};
    requestStatusRenderRef = null;
    requestRainOverlayRenderCallback = () => {};
    selectorDetector.reset();
    settingsController.reset();

    const editor = session.editor;
    session.editor = null;
    if (editor && ownedEditor === editor) {
      ownedEditor = null;
      editor.dispose();
    }
  };

  const retireActiveSession = (session: SessionState): void => {
    const sharedWithCurrentSession =
      activeSession !== null &&
      activeSession !== session &&
      activeSession.ui === session.ui;
    if (!sharedWithCurrentSession && session.mode === "tui" && session.hasUI) {
      try {
        session.ui.setWidget("tokyo-rain-selector", undefined);
      } catch (err) {
        if (!isStaleExtensionContextError(err)) {
          console.error(`${EXT_PREFIX} selector rain session cleanup failed:`, err);
        }
      }
    }

    if (sessionsByIdentity.get(session.identityKey) === session) {
      sessionsByIdentity.delete(session.identityKey);
    }
    if (currentSessionByManager.get(session.manager) === session) {
      currentSessionByManager.delete(session.manager);
    }
    const wasDisposed = session.disposed;
    session.disposed = true;
    if (activeSession === session) {
      rainManager.stop();
      if (!wasDisposed) resetActiveComposition(session);
      activeSession = null;
    } else if (!wasDisposed) {
      clearSessionTimers(session);
      const editor = session.editor;
      session.editor = null;
      if (editor && ownedEditor === editor) {
        ownedEditor = null;
        editor.dispose();
      }
    }
  };

  const restoreSetWidgetPatch = (session: SessionState): void => {
    const { origSetWidget, setWidgetWrapper } = session;
    try {
      if (
        session.hasUI &&
        origSetWidget &&
        setWidgetWrapper &&
        session.ui.setWidget === setWidgetWrapper
      ) {
        session.ui.setWidget = origSetWidget as typeof session.ui.setWidget;
      }
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        console.error(`${EXT_PREFIX} setWidget restore failed:`, err);
      }
    } finally {
      // Do not retain stale methods after the session has retired, even if its
      // UI context was already invalidated by the host.
      session.origSetWidget = null;
      session.setWidgetWrapper = null;
    }
  };

  const requestStatusRenderFor = (session: SessionState): void => {
    if (!isCurrentSession(session)) return;
    session.requestStatusRender?.();
  };

  const CODEX_COUNTDOWN_REFRESH_MS = 30_000;

  const shouldRefreshCodexCountdown = (session: SessionState): boolean =>
    isCurrentSession(session) &&
    session.mode === "tui" &&
    session.hasUI &&
    configManager.get().codexQuota &&
    isCodexModel(activeModel) &&
    codexUsageStore.getSnapshot() !== undefined;

  const scheduleCodexCountdownRefresh = (session: SessionState): void => {
    if (!shouldRefreshCodexCountdown(session)) {
      if (session.codexCountdownRefreshTimeout !== undefined) {
        clearTimeout(session.codexCountdownRefreshTimeout);
        session.codexCountdownRefreshTimeout = undefined;
      }
      return;
    }
    if (session.codexCountdownRefreshTimeout !== undefined) return;

    session.codexCountdownRefreshTimeout = setTimeout(() => {
      session.codexCountdownRefreshTimeout = undefined;
      if (!shouldRefreshCodexCountdown(session)) return;
      requestStatusRenderFor(session);
      scheduleCodexCountdownRefresh(session);
    }, CODEX_COUNTDOWN_REFRESH_MS);
  };

  // These collaborators are deliberately constructed inside the extension
  // factory. Their callbacks can therefore only reach this factory's editor,
  // rain manager, settings controller, and render request functions.
  const selectorDetector = new SelectorDetector({
    getEditorFocusTarget: () => ownedEditor,
    requestEditorRender: () => {
      coordinateSelectorTransition(
        requestRainOverlayRenderCallback,
        () => ownedEditor?.tuiRef.requestRender(true),
      );
    },
    requestStatusRender: () => requestStatusRenderCallback(),
  });

  const rainManager = new RainAnimationManager(configManager, {
    requestRender: () => {
      ownedEditor?.requestRender();
      requestRainOverlayRenderCallback();
    },
  });

  const settingsController = new SettingsUIController(configManager, {
    requestEditorRender: () => ownedEditor?.requestRender(),
    applyPanelState: () => applyCurrentPanelState(),
    onCodexQuotaConfigChange: () => refreshCodexQuotaState(),
    onKimiQuotaConfigChange: () => refreshKimiQuotaState(),
    onIconModeConfigChange: () => requestStatusRenderCallback(),
  });

  const borderlessEditorDependencies: BorderlessEditorDependencies = {
    config: configManager,
    selectorDetector,
    settingsController,
    rainManager,
  };

  function applyPanelState(): void {
    if (!activeSession || activeSession.disposed) return;
    rainManager.stop();
    if (shouldRunRainAnimation(panelSessionMode, configManager.get().panel)) {
      rainManager.start();
    }
    ownedEditor?.requestRender();
    requestRainOverlayRenderCallback();
  }

  applyCurrentPanelState = applyPanelState;

  // Stable factory so we can re-apply after resetExtensionUI() clears
  // setEditorComponent. It captures this factory's editor UI context.
  const borderlessEditorFactory = (
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options?: EditorOptions,
  ) => {
    // BorderlessEditor keeps a compatibility static handle for its own
    // rendering patch. Do not let constructing this factory's editor dispose
    // an editor owned by a different extension factory instance.
    if (
      BorderlessEditor.activeInstance &&
      BorderlessEditor.activeInstance !== ownedEditor
    ) {
      BorderlessEditor.activeInstance = null;
    }
    const editor = new BorderlessEditor(
      tui,
      theme,
      keybindings,
      editorUIContext!,
      borderlessEditorDependencies,
      options,
    );
    ownedEditor = editor;
    if (activeSession) activeSession.editor = editor;
    return editor;
  };

  const getGitBranchFallback = async (
    cwd: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    try {
      const result = await pi.exec(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, timeout: 2000, signal },
      );
      return result.code === 0 ? result.stdout.trim() : null;
    } catch (err) {
      if (
        !signal.aborted &&
        !isAbortError(err) &&
        !isStaleExtensionContextError(err)
      ) {
        handleExtensionError(err, "getGitBranch fallback");
      }
      return null;
    }
  };

  const syncFooterBranch = (
    session: SessionState,
    footerData: ReadonlyFooterDataProvider,
  ): void => {
    if (!isCurrentSession(session)) return;
    abortBranchRequest(session.branch);
    session.branch.requestToken += 1;
    session.branch.pending = false;
    session.branch.cacheTime = Date.now();

    let branch = "";
    try {
      branch = footerData.getGitBranch() ?? "";
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        handleExtensionError(err, "footer git branch");
      }
      return;
    }
    if (branch !== session.branch.cachedBranch) {
      session.branch.cachedBranch = branch;
      requestStatusRenderFor(session);
    }
  };

  const updateBranch = async (
    session: SessionState,
    cwd: string,
  ): Promise<void> => {
    if (!isCurrentSession(session)) return;

    if (session.branch.cwd !== cwd) {
      session.branch.cwd = cwd;
      abortBranchRequest(session.branch);
      session.branch.cachedBranch = "";
      session.branch.cacheTime = 0;
      session.branch.pending = false;
      session.branch.requestToken += 1;
    }

    // Footer data is Pi's cached source of truth. In particular, do not start
    // a git process while the footer provider is available.
    if (session.footerData) {
      syncFooterBranch(session, session.footerData);
      return;
    }

    const now = Date.now();
    const BRANCH_CACHE_TTL = 5000;
    if (
      session.branch.pending ||
      now - session.branch.cacheTime <= BRANCH_CACHE_TTL
    ) {
      return;
    }

    abortBranchRequest(session.branch);
    session.branch.pending = true;
    session.branch.cacheTime = now;
    const requestToken = ++session.branch.requestToken;
    const generation = session.generation;
    const requestController = new AbortController();
    session.branch.requestController = requestController;
    try {
      const branch = await getGitBranchFallback(cwd, requestController.signal);
      if (
        !isCurrentSession(session) ||
        session.generation !== generation ||
        session.branch.requestToken !== requestToken ||
        session.footerData ||
        branch === null
      ) {
        return;
      }
      if (branch !== session.branch.cachedBranch) {
        session.branch.cachedBranch = branch;
        requestStatusRenderFor(session);
      }
      session.branch.cacheTime = Date.now();
    } catch (err) {
      if (!isAbortError(err) && !isStaleExtensionContextError(err)) {
        console.error(`${EXT_PREFIX} branch update failed:`, err);
      }
    } finally {
      if (
        isCurrentSession(session) &&
        session.branch.requestToken === requestToken &&
        session.branch.requestController === requestController
      ) {
        session.branch.pending = false;
        session.branch.cacheTime = Date.now();
        session.branch.requestController = undefined;
      }
    }
  };

  // ── Native working indicator state (registered once per extension instance)
  pi.on("agent_start", async (_event, ctx) => {
    const session = isCurrentInteractiveSession(ctx);
    if (!session) return;

    setWorkingPhase(session, "waiting", true);
    session.working.activeTools.clear();
    try {
      session.ui.setWorkingVisible(true);
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        handleExtensionError(err, "working visibility");
      }
    }
    startWorkingTimer(session);
  });

  pi.on("turn_start", async (_event, ctx) => {
    const session = isCurrentInteractiveSession(ctx);
    if (!session || session.working.phaseStartedAt === undefined) return;

    setWorkingPhase(session, "waiting", true);
    updateWorkingMessage(session);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const session = isCurrentInteractiveSession(ctx);
    if (!session) return;

    resetWorkingState(session);
    try {
      session.ui.setWorkingMessage();
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        handleExtensionError(err, "working message reset");
      }
    }
  });

  pi.on("message_update", async (event, ctx) => {
    const session = isCurrentInteractiveSession(ctx);
    if (!session || session.working.phaseStartedAt === undefined) return;

    let nextPhase: WorkingPhase;
    switch (event.assistantMessageEvent.type) {
      case "thinking_start":
      case "thinking_delta":
      case "toolcall_start":
      case "toolcall_delta":
        nextPhase = "thinking";
        break;
      case "text_start":
      case "text_delta":
        nextPhase = "streaming";
        break;
      default:
        return;
    }
    setWorkingPhase(session, nextPhase);
    updateWorkingMessage(session);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const session = isCurrentInteractiveSession(ctx);
    if (!session || session.working.phaseStartedAt === undefined) return;

    session.working.activeTools.set(event.toolCallId, {
      name: event.toolName,
      startedAt: Date.now(),
    });
    updateWorkingMessage(session);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const session = isCurrentInteractiveSession(ctx);
    if (!session || session.working.phaseStartedAt === undefined) return;

    session.working.activeTools.delete(event.toolCallId);
    if (session.working.activeTools.size === 0) {
      setWorkingPhase(session, "waiting");
    }
    updateWorkingMessage(session);
  });

  refreshCodexQuotaState = () => {
    const enabled = configManager.get().codexQuota && isCodexModel(activeModel);
    if (!enabled) {
      codexUsageStore.clearSnapshot();
    }
    if (activeSession) scheduleCodexCountdownRefresh(activeSession);
    requestStatusRenderRef?.();
  };

  refreshKimiQuotaState = () => {
    const session = activeSession;
    const model = activeModel;
    const enabled =
      session !== null && canPollKimiUsage(session, model);

    if (!enabled) {
      stopKimiPolling();
      // Symmetric with codex: drop the stale snapshot so re-enabling the
      // toggle (or switching back to a kimi model) doesn't briefly render
      // hours-old quota before the next fetch completes.
      session?.kimiUsageStore.clearSnapshot();
    } else if (
      kimiPollTimer === undefined ||
      kimiPollSession !== session ||
      kimiPollModel !== model
    ) {
      stopKimiPolling();
      const generation = ++kimiPollGeneration;
      kimiPollSession = session;
      kimiPollModel = model;
      void pollKimiUsage(session, model, generation); // immediate first fetch
      kimiPollTimer = setInterval(
        () => void pollKimiUsage(session, model, generation),
        KIMI_POLL_INTERVAL_MS,
      );
      kimiPollTimer.unref?.();
    }
    requestStatusRenderRef?.();
  };

  pi.on("after_provider_response", async (event, ctx) => {
    try {
      const session = sessionsByIdentity.get(getSessionIdentity(ctx));
      if (!session || !isCurrentSession(session)) return;
      if (
        configManager.get().codexQuota &&
        isCodexModel(ctx.model) &&
        codexUsageStore.captureFromHeaders(event.headers)
      ) {
        scheduleCodexCountdownRefresh(session);
        requestStatusRenderFor(session);
      }
    } catch (err) {
      handleExtensionError(err, "codex usage capture");
    }
  });

  pi.on("model_select", async (event, ctx) => {
    try {
      const session = sessionsByIdentity.get(getSessionIdentity(ctx));
      if (!session || !isCurrentSession(session)) return;
      activeModel = event.model;
      codexUsageStore.clearSnapshot();
      refreshCodexQuotaState();
      refreshKimiQuotaState();
    } catch (err) {
      handleExtensionError(err, "model_select Codex SSE force");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // Keep extension console output away from the terminal while this session
    // owns the interactive TUI. This remains process-wide across reloads so
    // late errors from a retiring runtime cannot corrupt the next frame.
    consoleLogBridge.setInteractive(isInteractiveTui(ctx));
    // Do not disable it in session_shutdown: retiring async work can log after
    // Pi invalidates its old context. The next session_start sets the mode.

    const sessionIdentity = getSessionIdentity(ctx);
    const ui = ctx.ui;
    const mode = ctx.mode;
    const hasUI = ctx.hasUI;
    const cwd = ctx.cwd;
    const model = ctx.model;

    // Session replacement can race the previous context's asynchronous work.
    // Retire only this factory's previous session before installing the new
    // generation; its old shutdown can still restore its own UI below.
    const replacedSession = activeSession;
    const sessionManager = ctx.sessionManager as unknown as object;
    const existingSession = sessionsByIdentity.get(sessionIdentity);
    if (
      replacedSession &&
      replacedSession.manager === sessionManager &&
      replacedSession.identityKey !== sessionIdentity
    ) {
      reusedManagers.add(sessionManager);
    }
    if (replacedSession) {
      retireActiveSession(replacedSession);
      if (replacedSession.ui === ui) restoreSetWidgetPatch(replacedSession);
    }
    if (existingSession && existingSession !== replacedSession) {
      retireActiveSession(existingSession);
      restoreSetWidgetPatch(existingSession);
    }

    const session: SessionState = {
      generation: ++sessionGeneration,
      ui,
      mode,
      hasUI,
      cwd,
      disposed: false,
      editorPollTimeout: undefined,
      editorPollDelay: 150,
      editorWasDetached: false,
      footerData: null,
      branch: {
        cachedBranch: "",
        cacheTime: 0,
        pending: false,
        requestToken: 0,
        requestController: undefined,
        cwd: undefined,
      },
      statusRenderDebounceTimeout: undefined,
      statusTui: null,
      requestStatusRender: null,
      working: {
        phase: "waiting",
        phaseStartedAt: undefined,
        activeTools: new Map(),
        timer: undefined,
      },
      origSetWidget: null,
      setWidgetWrapper: null,
      editor: null,
      manager: sessionManager,
      identityKey: sessionIdentity,
      kimiUsageStore: createKimiUsageStore(),
      codexCountdownRefreshTimeout: undefined,
    };
    activeSession = session;
    sessionsByIdentity.set(sessionIdentity, session);
    currentSessionByManager.set(sessionManager, session);
    panelSessionMode = mode;
    configManager.read();
    activeModel = model;
    modelRegistryRef = ctx.modelRegistry;
    codexUsageStore.clearSnapshot();
    refreshCodexQuotaState();
    refreshKimiQuotaState();

    if (mode !== "tui" || !hasUI) return;
    editorUIContext = ui;

    let selectorRainTui: TUI | null = null;
    let selectorRainRegistered = false;
    let statusWidgetRegistered = false;
    let footerRegistered = false;
    let syncSelectorRainWidget: () => void = () => {};
    let registerStatusWidget: () => void = () => {};
    let registerFooter: () => void = () => {};
    let footerSubscription: { dispose: () => void } | null = null;
    const clearFooterSubscription = (): void => {
      const subscription = footerSubscription;
      footerSubscription = null;
      subscription?.dispose();
    };

    if (mode === "tui") {
      // ── Register custom editor (wrapping previous) ──────────────────────
      ui.setEditorComponent(borderlessEditorFactory);
      ui.setWorkingVisible(true);
      ui.setWorkingMessage();
      const rootTui = ownedEditor?.tuiRef;
      rootTui?.requestRender(true);

      // Poll ownership with exponential backoff. A 150ms first check keeps
      // resetExtensionUI responsive, while stable ownership quickly drops to
      // a low-frequency safety check for the rest of the session.
      const BASE_POLL_MS = 150;
      const MAX_POLL_MS = 5000;
      const pollEditorRegistration = (): void => {
        if (!isCurrentSession(session)) return;
        session.editorPollTimeout = setTimeout(() => {
          session.editorPollTimeout = undefined;
          if (!isCurrentSession(session)) return;

          try {
            const currentFactory =
              typeof ui.getEditorComponent === "function"
                ? ui.getEditorComponent()
                : undefined;

            if (currentFactory !== borderlessEditorFactory) {
              if (!session.editorWasDetached) {
                rainManager.stop();
                if (session.editor && ownedEditor === session.editor) {
                  ownedEditor = null;
                  session.editor.dispose();
                  session.editor = null;
                }
                requestRainOverlayRenderCallback();
                session.editorWasDetached = true;
                session.editorPollDelay = BASE_POLL_MS;
              }

              if (currentFactory === undefined) {
                // Pi's resetExtensionUI() clears extension widgets, footer,
                // and the custom editor. Drop every old UI reference before
                // registering the complete composition again.
                selectorRainRegistered = false;
                selectorRainTui = null;
                statusWidgetRegistered = false;
                session.statusTui = null;
                footerRegistered = false;
                session.footerData = null;
                selectorDetector.overlayTui = null;
                clearFooterSubscription();
                if (session.statusRenderDebounceTimeout !== undefined) {
                  clearTimeout(session.statusRenderDebounceTimeout);
                  session.statusRenderDebounceTimeout = undefined;
                }
                ui.setEditorComponent(borderlessEditorFactory);
                registerStatusWidget();
                registerFooter();
                ui.setWorkingVisible(true);
                applyPanelState();
                requestRainOverlayRenderCallback();
                session.editorPollDelay = BASE_POLL_MS;
              } else {
                // Never replace another extension's editor. Keep observing it,
                // but use the backoff rather than a permanent 150ms loop.
                session.editorPollDelay = Math.min(
                  MAX_POLL_MS,
                  session.editorPollDelay * 2,
                );
              }
            } else {
              if (session.editorWasDetached) {
                session.editorWasDetached = false;
                if (session.editor) {
                  applyPanelState();
                  session.editor.requestRender();
                }
              }
              session.editorPollDelay = Math.min(
                MAX_POLL_MS,
                session.editorPollDelay * 2,
              );
            }
          } catch (err) {
            if (isStaleExtensionContextError(err)) {
              session.disposed = true;
              clearSessionTimers(session);
              if (activeSession === session) {
                rainManager.stop();
                // Keep the disposed session until session_shutdown so that
                // shutdown can still restore its UI resources.
                resetActiveComposition(session);
              }
              return;
            }
            console.error(`${EXT_PREFIX} editor ownership poll failed:`, err);
            session.editorPollDelay = Math.min(
              MAX_POLL_MS,
              session.editorPollDelay * 2,
            );
          }
          pollEditorRegistration();
        }, session.editorPollDelay);
      };
      pollEditorRegistration();
    }

    // ── Intercept setWidget to drop "agents" widget ───────────────────────
    // @tintinweb/pi-subagents registers an "agents" widget that duplicates
    // agent info already in the chat area. Its 80ms timer re-registers
    // continuously, so clearing it once doesn't work. We intercept setWidget.
    if (
      replacedSession?.ui === ui &&
      replacedSession.setWidgetWrapper === ui.setWidget &&
      replacedSession.origSetWidget
    ) {
      ui.setWidget = replacedSession.origSetWidget as typeof ui.setWidget;
      replacedSession.origSetWidget = null;
      replacedSession.setWidgetWrapper = null;
    }
    session.origSetWidget = ui.setWidget;
    const setWidgetWrapper = ((key: string, ...args: unknown[]) => {
      if (key === "agents") return;
      return session.origSetWidget!.call(ui, key, ...args as any[]);
    }) as typeof ui.setWidget;
    session.setWidgetWrapper = setWidgetWrapper;
    ui.setWidget = setWidgetWrapper;

    // The selector replaces the editor container in Pi, so the editor cannot
    // render the panel while a selector owns that area. Register the fallback
    // widget only for the active selector state.
    const selectorRainFactory = (tui: TUI) => {
      selectorRainTui = tui;
      return {
        invalidate() {},
        render(width: number): string[] {
          if (!selectorDetector.isSideBordersHidden()) return [];
          return ownedEditor?.renderSelectorOverlay(width) ?? [];
        },
        dispose() {
          if (selectorRainTui === tui) selectorRainTui = null;
        },
      };
    };
    syncSelectorRainWidget = () => {
      if (!isCurrentSession(session) || mode !== "tui") return;
      const shouldRegister =
        selectorDetector.isSideBordersHidden() && rainManager.isRunning;
      try {
        if (shouldRegister && !selectorRainRegistered) {
          ui.setWidget(
            "tokyo-rain-selector",
            selectorRainFactory,
            { placement: "aboveEditor" },
          );
          selectorRainRegistered = true;
        } else if (!shouldRegister && selectorRainRegistered) {
          ui.setWidget("tokyo-rain-selector", undefined);
          selectorRainRegistered = false;
          selectorRainTui = null;
        }
        if (shouldRegister) selectorRainTui?.requestRender();
      } catch (err) {
        if (!isStaleExtensionContextError(err)) {
          console.error(`${EXT_PREFIX} selector rain widget update failed:`, err);
        }
      }
    };
    requestRainOverlayRenderCallback = syncSelectorRainWidget;

    // ── Apply panel state (start/stop animation timer) ────────────────────
    applyPanelState();

    // ── Status bar widget with debounce ───────────────────────────────────
    const STATUS_DEBOUNCE_MS = 33;
    const requestStatusRender = () => {
      if (!isCurrentSession(session)) return;
      if (session.statusRenderDebounceTimeout) {
        clearTimeout(session.statusRenderDebounceTimeout);
      }
      session.statusRenderDebounceTimeout = setTimeout(() => {
        session.statusRenderDebounceTimeout = undefined;
        if (!isCurrentSession(session)) return;
        try {
          session.statusTui?.requestRender();
        } catch (err) {
          if (isStaleExtensionContextError(err)) {
            session.statusTui = null;
          } else {
            console.error(`${EXT_PREFIX} status render request failed:`, err);
          }
        }
      }, STATUS_DEBOUNCE_MS);
    };

    session.requestStatusRender = requestStatusRender;
    requestStatusRenderCallback = requestStatusRender;
    requestStatusRenderRef = requestStatusRender;
    selectorDetector.setStatusRenderRef(requestStatusRender);

    const statusWidgetFactory = (tui: TUI, theme: Theme) => {
      session.statusTui = tui;
      return {
        invalidate() {
          requestStatusRender();
        },
        render(width: number): string[] {
          try {
            if (!isCurrentSession(session)) return [];
            const currentCwd = ctx.cwd;
            if (session.cwd !== currentCwd) session.cwd = currentCwd;
            updateBranch(session, session.cwd);

            // selectorDetector.isSideBordersHidden() combines the cached
            // active flag with a live check on editorTui.
            const hideSideBorders = selectorDetector.isSideBordersHidden();
            const outputWidth = safeTerminalWidth(width);
            const contentWidth =
              !hideSideBorders && outputWidth >= 2
                ? outputWidth - 2
                : outputWidth;
            const statusLines = buildStatusLines(
              contentWidth,
              theme,
              ctx,
              session.branch.cachedBranch,
              pi.getThinkingLevel(),
              configManager,
              codexUsageStore,
              session.kimiUsageStore,
            );
            return buildStatusWidgetLines(
              outputWidth,
              hideSideBorders,
              statusLines,
              configManager.get().editorFrame,
            );
          } catch (err) {
            if (isStaleExtensionContextError(err)) return [];
            console.error(`${EXT_PREFIX} status render failed:`, err);
            return [];
          }
        },
      };
    };
    registerStatusWidget = () => {
      if (!isCurrentSession(session) || statusWidgetRegistered) return;
      try {
        ui.setWidget(
          "tokyo-status",
          statusWidgetFactory,
          { placement: "belowEditor" },
        );
        statusWidgetRegistered = true;
      } catch (err) {
        if (!isStaleExtensionContextError(err)) {
          console.error(`${EXT_PREFIX} status widget registration failed:`, err);
        }
      }
    };
    registerStatusWidget();

    // ── Footer: participate in Footer Data Provider ───────────────────────
    // Keep the existing footer ownership semantics: this empty component
    // preserves footerData for other extensions while our widget is visible.
    const footerFactory = (
      tui: TUI,
      _theme: Theme,
      footerData: ReadonlyFooterDataProvider,
    ) => {
      selectorDetector.overlayTui = tui;
      session.footerData = footerData;
      syncFooterBranch(session, footerData);
      const unsub = footerData.onBranchChange(() => {
        if (!isCurrentSession(session)) return;
        syncFooterBranch(session, footerData);
        requestStatusRenderFor(session);
      });
      const subscription = {
        active: true,
        dispose() {
          if (!subscription.active) return;
          subscription.active = false;
          unsub();
        },
      };
      footerSubscription = subscription;

      return {
        dispose() {
          const isCurrentFooter = footerSubscription === subscription;
          if (isCurrentFooter) footerSubscription = null;
          subscription.dispose();
          if (isCurrentFooter && session.footerData === footerData) {
            session.footerData = null;
          }
          if (isCurrentFooter && selectorDetector.overlayTui === tui) {
            selectorDetector.overlayTui = null;
          }
        },
        invalidate() {
          requestStatusRender();
        },
        render(): string[] {
          return [];
        },
      };
    };
    registerFooter = () => {
      if (!isCurrentSession(session) || footerRegistered) return;
      try {
        ui.setFooter(footerFactory);
        footerRegistered = true;
      } catch (err) {
        if (!isStaleExtensionContextError(err)) {
          console.error(`${EXT_PREFIX} footer registration failed:`, err);
        }
      }
    };
    registerFooter();
  });

  // Slash command: /tokyo-night — toggle the editor-embedded settings panel.
  pi.registerCommand("tokyo-night", {
    description:
      "Open the Tokyo Night settings panel. Usage: /tokyo-night [on|off]",
    handler: async (args: string, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on" || arg === "off") {
        configManager.set("panel", arg === "on");
        configManager.write();
        // RPC, JSON, and print commands may persist configuration, but they do
        // not own a TUI and must not invoke editor/widget operations.
        if (ctx.mode !== "tui" || !ctx.hasUI) return;
        try {
          applyPanelState();
          ctx.ui.notify(`Tokyo Night panel ${arg}`, "info");
        } catch (err) {
          handleExtensionError(err, "panel toggle");
        }
        return;
      }

      if (ctx.mode !== "tui" || !ctx.hasUI) {
        console.log(`${EXT_PREFIX} Settings panel is only available in interactive mode.`);
        return;
      }

      if (settingsController.isActive) {
        settingsController.exit();
        try {
          applyPanelState();
        } catch (err) {
          handleExtensionError(err, "settings save");
        }
      } else {
        settingsController.enter();
      }
      ownedEditor?.requestRender();
    },
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const sessionManager = ctx.sessionManager as unknown as object;
    const sessionIdentity = getSessionIdentity(ctx);
    let session = sessionsByIdentity.get(sessionIdentity);
    if (!session) {
      const managerSession = currentSessionByManager.get(sessionManager);
      if (
        managerSession &&
        activeSession === managerSession &&
        !reusedManagers.has(sessionManager)
      ) {
        // In-memory fork mutates the shared manager's id before the old
        // shutdown event. The active state is still the old session in this
        // extension runtime, so it is safe to use this one-way fallback.
        session = managerSession;
      }
    }
    if (!session) return;
    if (
      reusedManagers.has(sessionManager) &&
      session.manager === sessionManager &&
      event.reason !== "quit" &&
      event.reason !== "reload"
    ) {
      // A replacement-reason shutdown arriving after a reused-manager
      // session_start has no source session id in Pi's event shape. Treat it
      // as stale rather than allowing it to retire the current session.
      return;
    }
    if (sessionsByIdentity.get(sessionIdentity) === session) {
      sessionsByIdentity.delete(sessionIdentity);
    }

    const sharedWithCurrentSession =
      activeSession !== null &&
      activeSession !== session &&
      activeSession.ui === session.ui;
    const wasActiveSession = activeSession === session;
    retireActiveSession(session);
    if (wasActiveSession) sessionGeneration += 1;

    // Restore only this session's patch. The identity check prevents a late
    // shutdown from replacing the current session's wrapper on shared UI.
    restoreSetWidgetPatch(session);

    // ── Guard non-interactive modes ───────────────────────────────────────
    if (sharedWithCurrentSession || session.mode !== "tui" || !session.hasUI) {
      return;
    }

    // ── Full UI teardown ───────────────────────────────────────────────────
    // Preserve the existing independent teardown calls, including the
    // setWidget/editor/footer ownership semantics.
    try {
      resetWorkingState(session);
      session.ui.setWorkingMessage();
      session.ui.setWorkingVisible(true);
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        console.error(`${EXT_PREFIX} working indicator teardown failed:`, err);
      }
    }
    try {
      session.ui.setWidget("tokyo-rain-selector", undefined);
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        console.error(`${EXT_PREFIX} selector rain teardown failed:`, err);
      }
    }
    try {
      session.ui.setWidget("tokyo-status", undefined);
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        console.error(`${EXT_PREFIX} status widget teardown failed:`, err);
      }
    }
    try {
      session.ui.setEditorComponent(undefined);
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        console.error(`${EXT_PREFIX} editor teardown failed:`, err);
      }
    }
    try {
      session.ui.setFooter(undefined);
    } catch (err) {
      if (!isStaleExtensionContextError(err)) {
        console.error(`${EXT_PREFIX} footer teardown failed:`, err);
      }
    }
  });
}

export default registerTokyoNightExtension;
