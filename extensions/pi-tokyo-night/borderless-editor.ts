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
  getDoRender,
  setDoRender,
  type SelectorDetector,
} from "./selector-detector";
import {
  type SettingsUIController,
} from "./settings-controller";
import {
  BOX,
  FRAME_RGB,
  PURPLE,
  RESET,
  fgRgb,
} from "./ui-primitives";

export interface BorderlessEditorDependencies {
  config: TokyoConfigManager;
  selectorDetector: SelectorDetector;
  settingsController: SettingsUIController;
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

    // When the rain panel is disabled, the editor is the topmost element in
    // the card and must render its own rounded top border.
    if (!this.dependencies.config.get().panel) {
      result.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
    }

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

    // The settings panel is rendered inside the editor's rounded card frame.
    if (!this.dependencies.config.get().panel) {
      result.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
    }

    const settingsLines = this.dependencies.settingsController.buildLines(innerWidth);
    for (const line of settingsLines) {
      const padded =
        line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      result.push(frameFg(BOX.v) + padded + frameFg(BOX.v));
    }
    return result;
  }
}
