import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { TokyoConfigManager } from "../core/config";
import { handleExtensionError } from "../core/errors";
import { isFullscreenTui, requestHostRender } from "../core/pi-compat";
import {
  composeFrameDock,
  getFrameContentWidth,
  getMainSurfaceFrameRole,
  renderFrameSegment,
} from "./frame-layout";
import { PURPLE, RESET } from "./ui-primitives";

const FULLSCREEN_EDITOR_MIN_ROWS = 3;

export interface BorderlessEditorDependencies {
  config: TokyoConfigManager;
  renderFullscreenStatus?: (width: number) => string[];
}

/**
 * Custom editor that owns only editor input and chrome rendering. Rain is a
 * sibling above-editor widget, so this component never inspects or modifies
 * host TUI implementation details.
 */
export class BorderlessEditor extends CustomEditor {
  private readonly dependencies: BorderlessEditorDependencies;
  private readonly tuiRef: TUI;
  private readonly emptyBorderColor = () => "";
  private disposed = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    dependencies: BorderlessEditorDependencies,
    options?: EditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    this.dependencies = dependencies;
    this.tuiRef = tui;
    this.borderColor = this.emptyBorderColor;
  }

  dispose(): void {
    this.disposed = true;
  }

  requestRender(force = false): void {
    if (!this.disposed) requestHostRender(this.tuiRef, force);
  }

  render(width: number): string[] {
    try {
      // Pi may copy the default editor appearance into a custom editor after
      // the factory returns. Re-assert the public borderColor field just
      // before rendering without locking its property descriptor.
      this.borderColor = this.emptyBorderColor;
      const config = this.dependencies.config.get();
      if (width < 10 && config.editorFrame) {
        const lines = renderFrameSegment({
          width,
          lines: this.extractEditorContentLines(super.render(width)),
          frameEnabled: true,
          role: getMainSurfaceFrameRole(config.panel),
        });
        return isFullscreenTui(this.tuiRef)
          ? this.renderFullscreenDockLines(lines, width)
          : lines;
      }
      return this.renderFullscreenDockLines(
        this.renderEditorMode(width),
        width,
      );
    } catch (error) {
      handleExtensionError(error, "BorderlessEditor render");
      const lines = super.render(width);
      return isFullscreenTui(this.tuiRef)
        ? this.fillFullscreenDockRows(this.extractEditorContentLines(lines), width)
        : lines;
    }
  }

  /**
   * Pi fullscreen reserves a minimum-height editor dock. Compose Tokyo status
   * into the same component so the host cannot pad between editor content and
   * the below-editor status widget.
   */
  private renderFullscreenDockLines(lines: string[], width: number): string[] {
    if (!isFullscreenTui(this.tuiRef)) return lines;
    return composeFrameDock({
      width,
      lines,
      frameEnabled: this.dependencies.config.get().editorFrame,
      renderBottom: () =>
        this.dependencies.renderFullscreenStatus?.(width) ?? [],
      recoverLines: () => this.fillFullscreenDockRows(lines, width),
      onBottomError: (error) => {
        handleExtensionError(error, "BorderlessEditor fullscreen status render");
      },
    });
  }

  private fillFullscreenDockRows(lines: string[], width: number): string[] {
    const missingRows = Math.max(0, FULLSCREEN_EDITOR_MIN_ROWS - lines.length);
    if (missingRows === 0) return lines;

    const outputWidth = Math.max(1, Math.floor(width));
    const frameEnabled = this.dependencies.config.get().editorFrame;
    return [
      ...lines,
      ...renderFrameSegment({
        width: outputWidth,
        lines: Array.from({ length: missingRows }, () => ""),
        frameEnabled,
        role: "middle",
        padUnframed: true,
      }),
    ];
  }

  private extractEditorContentLines(lines: string[]): string[] {
    if (lines.length < 2) return lines;
    const bottomBorderIndex = lines.findIndex(
      (line, index) => index > 0 && line.length === 0,
    );
    return bottomBorderIndex === -1
      ? lines.slice(1)
      : [
          ...lines.slice(1, bottomBorderIndex),
          ...lines.slice(bottomBorderIndex + 1),
        ];
  }

  private renderEditorMode(width: number): string[] {
    const config = this.dependencies.config.get();
    const frameEnabled = config.editorFrame;
    const promptPrefix = ` ${PURPLE}❯${RESET} `;
    const continuationPrefix = " ".repeat(visibleWidth(promptPrefix));
    const innerWidth = Math.max(
      1,
      getFrameContentWidth(width, frameEnabled),
    );
    const contentWidth = Math.max(1, innerWidth - visibleWidth(promptPrefix));
    const lines = super.render(contentWidth);
    if (lines.length < 2) return lines;

    const result: string[] = [];
    const contentLines = this.extractEditorContentLines(lines);
    let first = true;
    for (const line of contentLines) {
      const prefix = first ? promptPrefix : continuationPrefix;
      const content = truncateToWidth(`${prefix}${line}`, innerWidth);
      result.push(content);
      first = false;
    }
    return renderFrameSegment({
      width,
      lines: result,
      frameEnabled,
      role: getMainSurfaceFrameRole(config.panel),
    });
  }

}
