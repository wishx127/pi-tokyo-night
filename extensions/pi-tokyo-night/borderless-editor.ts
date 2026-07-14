import {
  CustomEditor,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  type TokyoConfigManager,
} from "./config";
import {
  handleExtensionError,
} from "./errors";
import {
  type RainAnimationManager,
  type RainFrameSnapshot,
} from "./rain-manager";
import {
  getDoRender,
  setDoRender,
  type SelectorDetector,
} from "./selector-detector";
import {
  type SettingsUIController,
} from "./settings-controller";
import {
  BOX,
  CYAN,
  FRAME_RGB,
  PURPLE,
  RESET,
  fgRgb,
} from "./ui-primitives";

// ── Rain visual constants ─────────────────────────────────────────────────────

export const MOON = "🌙";
export const MOON_FG = "\x1b[38;2;255;235;170m";
export const MOON_COL = 2;
export const MOON_ROW = 0;
export const STAR = "✦";
export const RAIN_DROP = "`";

// ── renderRainLines ───────────────────────────────────────────────────────────

/**
 * Pure function: renders the rain panel lines (top border + body rows).
 *
 * This is the primary unit-test seam — no class state required.
 *
 * @param opts.width           Total terminal width including frame borders.
 * @param opts.hideSideBorders When true (selector active), omit │ borders and
 *                             render a plain horizontal line as the top border.
 * @param opts.rainRows        Number of rain body rows (from config).
 * @param opts.snapshot        Current animation frame from RainAnimationManager.
 * @returns Array of ANSI-coloured strings; length = 1 + rainRows.
 */
export function renderRainLines(opts: {
  width: number;
  hideSideBorders: boolean;
  rainRows: number;
  snapshot: RainFrameSnapshot;
}): string[] {
  const { width, hideSideBorders, rainRows, snapshot } = opts;
  const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;

  const innerWidth = Math.max(1, hideSideBorders ? width : width - 2);
  const lines: string[] = [];

  // Top border.
  if (hideSideBorders) {
    lines.push(frameFg(BOX.h.repeat(width)));
  } else {
    lines.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
  }

  // Build lookup sets for O(1) position queries.
  const dropSet = new Set<string>();
  for (const d of snapshot.drops) {
    if (d.col >= 0 && d.col < innerWidth && d.row >= 0 && d.row < rainRows) {
      dropSet.add(`${d.col},${d.row}`);
    }
  }
  const starSet = new Set<string>();
  for (const s of snapshot.stars) {
    if (s.col >= 0 && s.col < innerWidth && s.row >= 0 && s.row < rainRows) {
      starSet.add(`${s.col},${s.row}`);
    }
  }

  // Body rows.
  for (let r = 0; r < rainRows; r++) {
    let row = hideSideBorders ? "" : frameFg(BOX.v);
    let c = 0;
    while (c < innerWidth) {
      if (r === MOON_ROW && c === MOON_COL) {
        row += MOON_FG + MOON + RESET;
        const mw = visibleWidth(MOON);
        if (mw > 1) {
          c += mw - 1;
        }
        c++;
        continue;
      } else if (dropSet.has(`${c},${r}`)) {
        row += CYAN + RAIN_DROP + RESET;
      } else if (starSet.has(`${c},${r}`)) {
        row += PURPLE + STAR + RESET;
      } else {
        row += " ";
      }
      c++;
    }
    if (!hideSideBorders) {
      row += frameFg(BOX.v);
    }
    lines.push(row);
  }

  return lines;
}

// ── BorderlessEditorDependencies ──────────────────────────────────────────────

export interface BorderlessEditorDependencies {
  config: TokyoConfigManager;
  selectorDetector: SelectorDetector;
  settingsController: SettingsUIController;
  /** Rain animation state manager — used to read isRunning and getSnapshot(). */
  rainManager: RainAnimationManager;
}

/**
 * Borderless editor wrapped in a rounded card frame together with the status
 * bar below. Uses the official Editor.borderColor API to hide the editor's
 * own top/bottom border, then draws a shared rounded shell and prefixes the
 * first content line with a glowing prompt.
 */
export class BorderlessEditor extends CustomEditor {
  static activeInstance: BorderlessEditor | null = null;
  // Saved original doRender to restore during shutdown.
  static originalDoRender: (() => void) | null = null;

  private uiContext: ExtensionUIContext;
  private readonly dependencies: BorderlessEditorDependencies;
  /** Stored TUI reference for requestRender() without relying on the SDK's
   *  private `tui` field on Editor. CustomEditor inherits from Editor which
   *  declares `protected tui: TUI` — accessible from subclasses but we keep
   *  our own explicit copy for clarity and to avoid any `as any` casts. */
  public tuiRef: TUI;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    uiContext: ExtensionUIContext,
    dependencies: BorderlessEditorDependencies,
    options?: EditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    this.uiContext = uiContext;
    this.dependencies = dependencies;
    this.tuiRef = tui;
    BorderlessEditor.activeInstance = this;
    dependencies.selectorDetector.editorTui = tui;
    // Hide the top/bottom border lines using the official API.
    // Use Object.defineProperty to make borderColor immutable — the getter
    // always returns the empty-border function, and the setter is a no-op.
    // This prevents Pi's setCustomEditorComponent from overwriting it with
    // defaultEditor.borderColor, which would make the custom editor look like
    // the default editor and break BorderlessEditor's assumption that
    // super.render() produces invisible border lines.
    const emptyBorderColor = () => "";
    this.borderColor = emptyBorderColor;
    Object.defineProperty(this, "borderColor", {
      get() {
        return emptyBorderColor;
      },
      set() {
        /* no-op: silently ignore external overwrites */
      },
      configurable: false,
    });

    // Monkey-patch tui.doRender to detect when a selector (like /settings,
    // /model, /tree) replaces our editor. Pi's showSelector() clears
    // editorContainer, adds a selector component, and changes focus away
    // from our editor. We detect this by checking focusedComponent after
    // each render cycle, since Pi calls doRender after updating focus.
    const originalDoRender = getDoRender(tui);
    if (originalDoRender) {
      BorderlessEditor.originalDoRender = originalDoRender;
      setDoRender(tui, () => {
        try {
          originalDoRender();
        } finally {
          // After Pi's render cycle, check if our editor is still focused.
          // selectorDetector.check() updates the active flag and triggers
          // coordinated re-render if state changed.
          dependencies.selectorDetector.check(
            tui,
            dependencies.selectorDetector.overlayTui,
          );
        }
      });
    }
  }

  getUIContext(): ExtensionUIContext {
    return this.uiContext;
  }

  requestRender(): void {
    this.tuiRef.requestRender();
  }

  handleInput(data: string): void {
    // When a selector has replaced our editor, pass input through to the
    // default handler. The selector handles its own input via focusedComponent.
    if (this.dependencies.selectorDetector.isSideBordersHidden()) {
      super.handleInput(data);
      return;
    }
    if (this.dependencies.settingsController.isActive) {
      this.dependencies.settingsController.handleInput(data);
      return;
    }
    super.handleInput(data);
  }

  render(width: number): string[] {
    try {
      if (width < 10) return super.render(width);

      // When a selector has replaced our editor (e.g. /settings, /model),
      // our custom │ frame borders would appear broken where the selector
      // takes over the editor area. Falling back to super.render() gives
      // the selector a clean base and hides │ borders entirely.
      if (this.dependencies.selectorDetector.isSideBordersHidden()) {
        return super.render(width);
      }

      // borderColor is locked to the empty-border function via Object.defineProperty
      // in the constructor — no need to re-assert on every render.

      return this.dependencies.settingsController.isActive
        ? this.renderSettingsMode(width)
        : this.renderEditorMode(width);
    } catch (err) {
      handleExtensionError(err, "BorderlessEditor render");
      return super.render(width);
    }
  }

  /**
   * Prepend either rain panel lines (when rain is running) or a plain top
   * border (when rain is inactive or fails) to `result`.
   *
   * Extracted from `renderEditorMode` and `renderSettingsMode` to remove
   * the near-identical duplicated block. Behavior is byte-for-byte identical
   * to what each caller previously did inline.
   *
   * @param result    The output array being built by the caller — lines are pushed in-place.
   * @param width     Total terminal width including frame borders.
   * @param innerWidth Width inside the frame borders (= width - 2, pre-computed by caller).
   */
  private prependTopBorderOrRain(
    result: string[],
    width: number,
    innerWidth: number,
  ): void {
    const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;

    if (this.dependencies.rainManager.isRunning) {
      try {
        const cfg = this.dependencies.config.get();
        const snapshot = this.dependencies.rainManager.getSnapshot();
        const rainLines = renderRainLines({
          width,
          hideSideBorders: false,
          rainRows: cfg.rainRows,
          snapshot,
        });
        for (const l of rainLines) {
          result.push(l);
        }
        this.dependencies.rainManager.setRenderWidth(innerWidth);
      } catch (err) {
        handleExtensionError(err, "rain render");
        result.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
      }
    } else {
      result.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
    }
  }

  private renderEditorMode(width: number): string[] {
    const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;

    // Prompt indicator: a simple neon chevron.
    const promptPrefix = ` ${PURPLE}❯${RESET} `;
    const contPrefix = " ".repeat(visibleWidth(promptPrefix));

    // Inner width inside the rounded card frame ("│" ... "│").
    const innerWidth = Math.max(1, width - 2);
    // Render the underlying editor at a narrower width so the prompt prefix
    // fits within the card interior.
    const contentWidth = Math.max(1, innerWidth - visibleWidth(promptPrefix));
    const lines = super.render(contentWidth);
    if (lines.length < 2) return lines;

    const result: string[] = [];

    // Rain panel: when the manager is actively running, rain owns the single
    // top rounded border. The editor must NOT draw its own top border in that
    // case to avoid a duplicate ╭─╮. When rain is not running, the editor is
    // the topmost element and must render its own top border.
    this.prependTopBorderOrRain(result, width, innerWidth);

    // Render content lines: skip the editor's own top border (lines[0]) and
    // drop its bottom border so the status bar sits flush below.
    const contentCount = lines.length - 1;
    let isFirstContentLine = true;
    for (let i = 0; i < contentCount; i++) {
      const prefix = isFirstContentLine ? promptPrefix : contPrefix;
      const content = truncateToWidth(`${prefix}${lines[i + 1]}`, innerWidth);
      const padLen = Math.max(0, innerWidth - visibleWidth(content));
      result.push(
        frameFg(BOX.v) + content + " ".repeat(padLen) + frameFg(BOX.v),
      );
      isFirstContentLine = false;
    }
    return result;
  }

  private renderSettingsMode(width: number): string[] {
    const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;
    const innerWidth = Math.max(1, width - 2);
    const result: string[] = [];

    // Rain panel: when manager is actively running, rain owns the top border.
    // When rain is not running, settings is topmost and draws its own border.
    this.prependTopBorderOrRain(result, width, innerWidth);

    const settingsLines = this.dependencies.settingsController.buildLines(innerWidth);
    for (const line of settingsLines) {
      const padded =
        line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      result.push(frameFg(BOX.v) + padded + frameFg(BOX.v));
    }
    return result;
  }
}
