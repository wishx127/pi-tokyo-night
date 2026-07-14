/**
 * Tokyo Night Extension composition root.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
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
  captureFromHeaders,
  clearSnapshot,
  isCodexModel,
} from "./codex-usage";
import { TokyoConfigManager } from "./config";
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
  setDoRender,
} from "./selector-detector";
import {
  SettingsUIController,
} from "./settings-controller";
import { buildStatusLine } from "./status-bar";
import {
  BOX,
  FRAME_RGB,
  RESET,
  fgRgb,
} from "./ui-primitives";

// ── Composition Root ────────────────────────────────────────────────────────

const configManager = new TokyoConfigManager();
let requestStatusRenderCallback: () => void = () => {};
let refreshCodexQuotaState: () => void = () => {};
let applyCurrentPanelState: () => void = () => {};

const selectorDetector = new SelectorDetector({
  getEditorFocusTarget: () => BorderlessEditor.activeInstance,
  requestEditorRender: () => BorderlessEditor.activeInstance?.requestRender(),
  requestStatusRender: () => requestStatusRenderCallback(),
});

const rainManager = new RainAnimationManager(configManager, {
  requestRender: () => {
    BorderlessEditor.activeInstance?.requestRender();
  },
});

const settingsController = new SettingsUIController(configManager, {
  requestEditorRender: () => BorderlessEditor.activeInstance?.requestRender(),
  applyPanelState: () => applyCurrentPanelState(),
  onCodexQuotaConfigChange: () => refreshCodexQuotaState(),
});

const borderlessEditorDependencies: BorderlessEditorDependencies = {
  config: configManager,
  selectorDetector,
  settingsController,
  rainManager,
};

function applyPanelState(): void {
  rainManager.stop();
  if (configManager.get().panel) {
    rainManager.start();
  }
  BorderlessEditor.activeInstance?.requestRender();
}

applyCurrentPanelState = () => applyPanelState();

export default function (pi: ExtensionAPI) {
  // ── Per-Extension State (scoped inside the function) ─────────────────────
  let editorUIContext: ExtensionUIContext | null = null;
  let reapplyEditorTimeout: ReturnType<typeof setTimeout> | undefined;
  // The setWidget interception forwards calls to the original overloaded method.
  // TypeScript can't verify that a single function signature satisfies both
  // overloads of setWidget, so we use a documented minimal type escape for the
  // forwarding. This is one of the few remaining `any` usages, justified by
  // the overloaded method forwarding pattern.
  let origSetWidget: ((...args: any[]) => any) | null = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let statusRenderDebounceTimeout: ReturnType<typeof setTimeout> | undefined;
  let requestStatusRenderRef: (() => void) | null = null;
  let activeModel: Model<any> | undefined;

  // Stable factory so we can re-apply after resetExtensionUI() clears
  // setEditorComponent. Captures editorUIContext via closure.
  const borderlessEditorFactory = (
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options?: EditorOptions,
  ) =>
    new BorderlessEditor(
      tui,
      theme,
      keybindings,
      editorUIContext!,
      borderlessEditorDependencies,
      options,
    );

  // ── agent_start guard (registered once at extension level) ───────────────
  // resetExtensionUI() re-enables workingVisible, and agent_start creates a
  // loader when it is true. We keep it off by re-hiding on every agent start.
  pi.on("agent_start", async (_event, _ctx) => {
    try {
      const ui = editorUIContext ?? _ctx.ui;
      ui.setWorkingVisible(false);
    } catch (err) {
      handleExtensionError(err, "agent_start guard");
    }
  });

  refreshCodexQuotaState = () => {
    const enabled = configManager.get().codexQuota && isCodexModel(activeModel);
    if (!enabled) {
      clearSnapshot();
    }
    requestStatusRenderRef?.();
  };

  pi.on("after_provider_response", async (event, ctx) => {
    try {
      if (configManager.get().codexQuota && isCodexModel(ctx.model) && captureFromHeaders(event.headers)) {
        requestStatusRenderRef?.();
      }
    } catch (err) {
      handleExtensionError(err, "codex usage capture");
    }
  });

  pi.on("model_select", async (event, _ctx) => {
    try {
      activeModel = event.model;
      clearSnapshot();
      refreshCodexQuotaState();
    } catch (err) {
      handleExtensionError(err, "model_select Codex SSE force");
    }
  });

  // ── Async git branch detection ───────────────────────────────────────────
  const getGitBranchFallback = async (cwd: string): Promise<string> => {
    try {
      const result = await pi.exec(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, timeout: 2000 },
      );
      return result.code === 0 ? result.stdout.trim() : "";
    } catch (err) {
      handleExtensionError(err, "getGitBranch fallback");
      return "";
    }
  };

  pi.on("session_start", async (event, ctx) => {
    editorUIContext = ctx.ui;
    configManager.read();
    activeModel = ctx.model;
    clearSnapshot();
    refreshCodexQuotaState();

    // Per-session branch cache (isolated from other sessions)
    let cachedBranch = "";
    let branchCacheTime = 0;
    let branchPending = false;
    const BRANCH_CACHE_TTL = 5000;

    const updateBranch = async (cwd: string) => {
      const now = Date.now();
      if (!branchPending && now - branchCacheTime > BRANCH_CACHE_TTL) {
        branchPending = true;
        branchCacheTime = now;
        try {
          // Prefer footerData.getGitBranch() (Pi's built-in, cached, robust);
          // note: getGitBranch() is synchronous in the SDK (returns string | null),
          // but we await the result for uniform handling with the async fallback.
          // fall back to manual git exec if footerData is unavailable.
          cachedBranch = footerDataRef
            ? (footerDataRef.getGitBranch() ?? "")
            : await getGitBranchFallback(cwd);
        } catch (err) {
          if (isStaleExtensionContextError(err)) {
            // Stale context is expected during shutdown — skip silently.
            return;
          }
          console.error(`${EXT_PREFIX} branch update failed:`, err);
        } finally {
          branchPending = false;
        }
      }
    };

    // ── Register custom editor (wrapping previous) ────────────────────────
    ctx.ui.setEditorComponent(borderlessEditorFactory);
    ctx.ui.setWorkingVisible(false);
    // Force a full render after editor registration to reset any accumulated
    // viewport drift from previous differential rendering cycles. Without this,
    // previousViewportTop may be stale from before the editor swap, causing
    // computeLineDiff to position rain panel lines at wrong terminal positions.
    // requestRender(true) clears previousLines/previousViewportTop and forces
    // a full redraw — it's a public API on TUI (tui.d.ts: requestRender(force?: boolean)).
    const rootTui = BorderlessEditor.activeInstance?.tuiRef;
    rootTui?.requestRender(true);

    // ── Poll for editor factory clearing on all session reasons ──────────────
    // Another extension (pi-fff in "tools-only" mode) or Pi's resetExtensionUI()
    // may call setEditorComponent(undefined), which clears our custom editor.
    // We poll to detect this and re-register. The check uses === undefined
    // so we only react to an explicit clear, not to another extension registering
    // its own factory (which we should not overwrite).
    const MAX_REAPPLY_MS = 2000;
    const POLL_INTERVAL_MS = 150;
    const reapplyStart = Date.now();

    function pollEditorRegistration() {
      const elapsed = Date.now() - reapplyStart;
      if (elapsed >= MAX_REAPPLY_MS) {
        reapplyEditorTimeout = undefined;
        return;
      }
      reapplyEditorTimeout = setTimeout(() => {
        try {
          const currentFactory =
            typeof ctx.ui.getEditorComponent === "function"
              ? ctx.ui.getEditorComponent()
              : undefined;
          if (currentFactory === undefined) {
            // Factory was explicitly cleared — re-register our editor.
            ctx.ui.setEditorComponent(borderlessEditorFactory);
            ctx.ui.setWorkingVisible(false);
            // Force full render after re-registration to reset viewport tracking.
            const reapplyTui = BorderlessEditor.activeInstance?.tuiRef;
            reapplyTui?.requestRender(true);
          }
        } catch (err) {
          if (isStaleExtensionContextError(err)) {
            reapplyEditorTimeout = undefined;
            return; // stop polling on stale context
          }
          console.error(`${EXT_PREFIX} editor re-apply poll failed:`, err);
        }
        pollEditorRegistration();
      }, POLL_INTERVAL_MS);
    }
    pollEditorRegistration();

    // ── Intercept setWidget to drop "agents" widget ───────────────────────
    // @tintinweb/pi-subagents registers an "agents" widget that duplicates
    // agent info already in the chat area. Its 80ms timer re-registers
    // continuously, so clearing it once doesn't work. We intercept setWidget.
    origSetWidget = ctx.ui.setWidget.bind(ctx.ui);
    ctx.ui.setWidget = (key: string, ...args: unknown[]) => {
      if (key === "agents") return;
      // Forwarding to the original overloaded setWidget method.
      // Must include `key` as the first argument — `args` only contains
      // the parameters after `key` (content, options).
      return origSetWidget!.call(ctx.ui, key, ...args as any[]);
    };

    // ── Apply panel state (start/stop animation timer) ────────────────────
    applyPanelState();

    // ── Status bar widget with debounce ────────────────────────────────────
    const STATUS_DEBOUNCE_MS = 33;
    let statusTui: TUI | null = null;

    const requestStatusRender = () => {
      if (statusRenderDebounceTimeout) clearTimeout(statusRenderDebounceTimeout);
      statusRenderDebounceTimeout = setTimeout(() => {
        statusRenderDebounceTimeout = undefined;
        try {
          statusTui?.requestRender();
        } catch (err) {
          if (isStaleExtensionContextError(err)) {
            statusTui = null;
          } else {
            console.error(`${EXT_PREFIX} status render request failed:`, err);
          }
        }
      }, STATUS_DEBOUNCE_MS);
    };

    requestStatusRenderCallback = requestStatusRender;

    // Store the requestStatusRender reference so selector state changes
    // can trigger status bar re-render.
    requestStatusRenderRef = requestStatusRender;
    selectorDetector.setStatusRenderRef(requestStatusRender);

    ctx.ui.setWidget(
      "tokyo-status",
      (tui: TUI, theme: Theme) => {
        statusTui = tui;
        return {
          invalidate() {
            requestStatusRender();
          },
          render(width: number): string[] {
            try {
              const cwd = ctx.cwd;
              updateBranch(cwd);

              const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;

              // selectorDetector.isSideBordersHidden() combines the cached
              // active flag with a live check on editorTui, catching selectors
              // in the same render cycle they appear.
              const hideSideBorders = selectorDetector.isSideBordersHidden();

              // In selector mode (no │ borders), content fills full width.
              // In normal mode (│ on both sides), content fills width - 2.
              const innerWidth = Math.max(1, hideSideBorders ? width : width - 2);
              const statusLine = buildStatusLine(
                innerWidth,
                theme,
                ctx,
                cachedBranch,
                pi.getThinkingLevel(),
                configManager,
              );
              const statusContent = truncateToWidth(statusLine, innerWidth);
              const padLen = Math.max(
                0,
                innerWidth - visibleWidth(statusContent),
              );

              // Bottom border: ╰─╯ when │ side borders connect to corners,
              // plain ─ horizontal line without corners when │ sides are hidden
              // (selector mode — corners look broken without connecting │).
              const bottomLine = hideSideBorders
                ? frameFg(BOX.h.repeat(width))
                : frameFg(`${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}`);

              // When a selector has replaced our editor, remove only the │ side
              // borders. The bottom ─ line is kept — it provides visual
              // continuity as a footer decoration without disconnected corners.
              if (hideSideBorders) {
                const selectorBodyLine =
                  statusContent +
                  " ".repeat(padLen);
                return [selectorBodyLine, bottomLine];
              }

              const bodyLine =
                frameFg(BOX.v) +
                statusContent +
                " ".repeat(padLen) +
                frameFg(BOX.v);

              return [bodyLine, bottomLine];
            } catch (err) {
              if (isStaleExtensionContextError(err)) return [];
              console.error(`${EXT_PREFIX} status render failed:`, err);
              return [];
            }
          },
        };
      },
      { placement: "belowEditor" },
    );

    // ── Footer: participate in Footer Data Provider ───────────────────────
    // Instead of hiding the footer entirely, we register a component that
    // subscribes to footerData (git branch, extension statuses) and returns
    // an empty render. This keeps other extensions' statuses accessible via
    // footerData while our status bar widget replaces the footer visually.
    ctx.ui.setFooter(
      (tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        // The footer callback receives the root TUI. Store it as a secondary
        // source for selector detection (checking focusedComponent) alongside
        // the editor TUI.
        selectorDetector.overlayTui = tui;
        footerDataRef = footerData;
        // Hook onBranchChange to auto-trigger status bar re-render —
        // no need for our manual git branch cache refresh interval.
        const unsub = footerData.onBranchChange(() => requestStatusRender());

        return {
          dispose() {
            unsub();
            footerDataRef = null;
          },
          invalidate() {
            requestStatusRender();
          },
          render(): string[] {
            return []; // empty — our status bar widget replaces the footer visually
          },
        };
      },
    );
  });

  // Slash command: /tokyo-night — toggle the editor-embedded settings panel.
  pi.registerCommand("tokyo-night", {
    description:
      "Open the Tokyo Night settings panel. Usage: /tokyo-night [on|off]",
    handler: async (args: string, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on" || arg === "off") {
        configManager.get().panel = arg === "on";
        configManager.write();
        if (!ctx.hasUI) return;
        try {
          applyPanelState();
          ctx.ui.notify(`Tokyo Night panel ${arg}`, "info");
        } catch (err) {
          handleExtensionError(err, "panel toggle");
        }
        return;
      }

      if (!ctx.hasUI) {
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
      BorderlessEditor.activeInstance?.requestRender();
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // ── Cancel all timers ──────────────────────────────────────────────────
    if (reapplyEditorTimeout) {
      clearTimeout(reapplyEditorTimeout);
      reapplyEditorTimeout = undefined;
    }
    if (statusRenderDebounceTimeout) {
      clearTimeout(statusRenderDebounceTimeout);
      statusRenderDebounceTimeout = undefined;
    }
    // ── Restore doRender monkey-patch ────────────────────────────────────────
    if (BorderlessEditor.originalDoRender && selectorDetector.editorTui) {
      try {
        setDoRender(
          selectorDetector.editorTui,
          BorderlessEditor.originalDoRender,
        );
      } catch (err) {
        if (isStaleExtensionContextError(err)) return;
        console.error(`${EXT_PREFIX} doRender restore failed:`, err);
      }
    }

    // ── Restore setWidget monkey-patch ─────────────────────────────────────
    if (origSetWidget && ctx.hasUI) {
      try {
        ctx.ui.setWidget = origSetWidget;
      } catch (err) {
        if (isStaleExtensionContextError(err)) return;
        console.error(`${EXT_PREFIX} setWidget restore failed:`, err);
      }
      origSetWidget = null;
    }

    // ── Reset all per-session state ────────────────────────────────────────
    rainManager.stop();
    editorUIContext = null;
    footerDataRef = null;
    requestStatusRenderRef = null;
    activeModel = undefined;
    clearSnapshot();
    refreshCodexQuotaState = () => {};
    requestStatusRenderCallback = () => {};
    selectorDetector.reset();
    settingsController.reset();
    BorderlessEditor.activeInstance = null;
    BorderlessEditor.originalDoRender = null;

    // ── Guard non-interactive modes ────────────────────────────────────────
    if (!ctx.hasUI) {
      return;
    }

    // ── Full UI teardown ───────────────────────────────────────────────────
    ctx.ui.setWidget("tokyo-status", undefined);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setFooter(undefined);
  });
}
