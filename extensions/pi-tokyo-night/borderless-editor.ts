import {
  CustomEditor,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { type TokyoConfigManager } from "./config";
import { handleExtensionError } from "./errors";
import {
  type RainAnimationManager,
  type RainFrameSnapshot,
} from "./rain-manager";
import {
  asTUIInternals,
  getDoRender,
  setDoRender,
  type SelectorDetector,
} from "./selector-detector";
import { type SettingsUIController } from "./settings-controller";
import { BOX, CYAN, FRAME_RGB, PURPLE, RESET, fgRgb } from "./ui-primitives";

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
  const outputWidth = Math.max(0, Math.floor(width));
  const bodyRows = Math.max(0, Math.floor(rainRows));
  const frameHasSideBorders = !hideSideBorders && outputWidth >= 2;
  const innerWidth = hideSideBorders
    ? outputWidth
    : frameHasSideBorders
      ? outputWidth - 2
      : outputWidth;
  const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;
  const lines: string[] = [];

  // Top border. A one-column frame cannot contain both corners, so emit one
  // visible cell rather than allowing a negative repeat count or exceeding
  // the requested width.
  if (hideSideBorders) {
    lines.push(frameFg(BOX.h.repeat(outputWidth)));
  } else if (outputWidth >= 2) {
    lines.push(frameFg(`${BOX.tl}${BOX.h.repeat(outputWidth - 2)}${BOX.tr}`));
  } else {
    lines.push(frameFg(outputWidth === 1 ? BOX.tl : ""));
  }

  // Build lookup sets for O(1) position queries. Numeric keys avoid creating
  // a temporary `${col},${row}` string for every cell on every frame.
  const dropSet = new Set<number>();
  for (const d of snapshot.drops) {
    if (
      Number.isInteger(d.col) &&
      Number.isInteger(d.row) &&
      d.col >= 0 &&
      d.col < innerWidth &&
      d.row >= 0 &&
      d.row < bodyRows
    ) {
      dropSet.add(d.row * innerWidth + d.col);
    }
  }
  const starSet = new Set<number>();
  for (const s of snapshot.stars) {
    if (
      Number.isInteger(s.col) &&
      Number.isInteger(s.row) &&
      s.col >= 0 &&
      s.col < innerWidth &&
      s.row >= 0 &&
      s.row < bodyRows
    ) {
      starSet.add(s.row * innerWidth + s.col);
    }
  }

  // Body rows.
  const moonWidth = visibleWidth(MOON);
  for (let r = 0; r < bodyRows; r++) {
    let row = frameHasSideBorders ? frameFg(BOX.v) : "";
    let c = 0;
    while (c < innerWidth) {
      const position = r * innerWidth + c;
      if (r === MOON_ROW && c === MOON_COL && c + moonWidth <= innerWidth) {
        row += MOON_FG + MOON + RESET;
        c += moonWidth;
        continue;
      } else if (dropSet.has(position)) {
        row += CYAN + RAIN_DROP + RESET;
      } else if (starSet.has(position)) {
        row += PURPLE + STAR + RESET;
      } else {
        row += " ";
      }
      c++;
    }
    if (frameHasSideBorders) {
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

  private uiContext: ExtensionUIContext;
  private readonly dependencies: BorderlessEditorDependencies;
  private originalDoRender: (() => void) | null = null;
  private patchedDoRender: (() => void) | null = null;
  private disposed = false;
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
    // A factory replacement can construct a new editor before the old one is
    // disposed. Restore the old TUI patch first so wrappers never nest.
    BorderlessEditor.activeInstance?.dispose();
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
      this.originalDoRender = originalDoRender;
      const patchedDoRender = () => {
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
      };
      this.patchedDoRender = patchedDoRender;
      setDoRender(tui, patchedDoRender);
    }
  }

  /**
   * Restore this instance's TUI patch and release the active-instance handle.
   * Idempotent so both component disposal and session shutdown can call it.
   * The composition root still owns disposing the actual editor component;
   * this method only releases BorderlessEditor's private render hook.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    try {
      const internals = asTUIInternals(this.tuiRef);
      // Do not overwrite a newer owner if another component replaced doRender
      // after this editor was constructed.
      if (
        this.originalDoRender &&
        this.patchedDoRender &&
        internals?.doRender === this.patchedDoRender
      ) {
        setDoRender(this.tuiRef, this.originalDoRender);
      }
    } catch (err) {
      handleExtensionError(err, "BorderlessEditor dispose");
    } finally {
      if (this.dependencies.selectorDetector.editorTui === this.tuiRef) {
        this.dependencies.selectorDetector.editorTui = null;
      }
      if (BorderlessEditor.activeInstance === this) {
        BorderlessEditor.activeInstance = null;
      }
      this.originalDoRender = null;
      this.patchedDoRender = null;
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
      // The composition root owns a selector-only above-editor widget because
      // Pi may replace editorContainer entirely. Keep this component's
      // selector path borderless so overlays do not duplicate that widget.
      if (this.dependencies.selectorDetector.isSideBordersHidden()) {
        return super.render(width);
      }

      if (width < 10) return super.render(width);

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
   * Render only the rain chrome needed while a selector owns the editor area.
   * This is intentionally public: when Pi replaces BorderlessEditor rather
   * than calling render(), the composition root can call this seam and prepend
   * these full-width lines to the selector output. It does not render or own
   * the selector component.
   */
  renderSelectorOverlay(width: number): string[] {
    if (!this.dependencies.rainManager.isRunning) return [];

    const outputWidth = Math.max(0, Math.floor(width));
    try {
      const cfg = this.dependencies.config.get();
      const lines = renderRainLines({
        width: outputWidth,
        hideSideBorders: true,
        rainRows: cfg.rainRows,
        snapshot: this.dependencies.rainManager.getSnapshot(),
      });
      this.dependencies.rainManager.setRenderWidth(outputWidth);
      return lines;
    } catch (err) {
      handleExtensionError(err, "selector rain render");
      return [`${fgRgb(FRAME_RGB)}${BOX.h.repeat(outputWidth)}${RESET}`];
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

    // Editor.render() emits its own top and bottom border slots first and
    // appends autocomplete rows after the bottom border. With borderColor
    // locked to the empty function, those slots are empty strings, but their
    // positions remain part of the public output contract. Remove both slots
    // by position so autocomplete rows are retained verbatim as content.
    if (lines.length < 2) return lines;
    const bottomBorderIndex = lines.findIndex(
      (line, index) => index > 0 && line.length === 0,
    );
    const contentLines =
      bottomBorderIndex === -1
        ? lines.slice(1)
        : [
            ...lines.slice(1, bottomBorderIndex),
            ...lines.slice(bottomBorderIndex + 1),
          ];
    let isFirstContentLine = true;
    for (const line of contentLines) {
      const prefix = isFirstContentLine ? promptPrefix : contPrefix;
      const content = truncateToWidth(`${prefix}${line}`, innerWidth);
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

    const settingsLines =
      this.dependencies.settingsController.buildLines(innerWidth);
    for (const line of settingsLines) {
      const padded =
        line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      result.push(frameFg(BOX.v) + padded + frameFg(BOX.v));
    }
    return result;
  }
}
