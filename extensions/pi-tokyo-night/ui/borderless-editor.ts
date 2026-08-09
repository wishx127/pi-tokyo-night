import {
  CustomEditor,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { TokyoConfigManager } from "../core/config";
import { handleExtensionError } from "../core/errors";
import { isFullscreenTui, requestHostRender } from "../core/pi-compat";
import type { SettingsUIController } from "./settings-controller";
import { BOX, FRAME_RGB, PURPLE, RESET, fgRgb } from "./ui-primitives";

const FULLSCREEN_EDITOR_MIN_ROWS = 3;

export interface BorderlessEditorDependencies {
  config: TokyoConfigManager;
  settingsController: SettingsUIController;
  renderFullscreenStatus?: (width: number) => string[];
}

export function shouldRenderEditorTopBorder(config: {
  editorFrame: boolean;
  panel: boolean;
}): boolean {
  return config.editorFrame && !config.panel;
}

/**
 * Custom editor that owns only editor input and settings rendering. Rain is a
 * sibling above-editor widget, so this component never inspects or modifies
 * host TUI implementation details.
 */
export class BorderlessEditor extends CustomEditor {
  private readonly uiContext: ExtensionUIContext;
  private readonly dependencies: BorderlessEditorDependencies;
  private readonly tuiRef: TUI;
  private readonly emptyBorderColor = () => "";
  private disposed = false;

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
    this.borderColor = this.emptyBorderColor;
  }

  dispose(): void {
    this.disposed = true;
  }

  getUIContext(): ExtensionUIContext {
    return this.uiContext;
  }

  requestRender(force = false): void {
    if (!this.disposed) requestHostRender(this.tuiRef, force);
  }

  handleInput(data: string): void {
    if (this.dependencies.settingsController.isActive) {
      this.dependencies.settingsController.handleInput(data);
      return;
    }
    super.handleInput(data);
  }

  render(width: number): string[] {
    try {
      // Pi may copy the default editor appearance into a custom editor after
      // the factory returns. Re-assert the public borderColor field just
      // before rendering without locking its property descriptor.
      this.borderColor = this.emptyBorderColor;
      const config = this.dependencies.config.get();
      if (width < 10 && config.editorFrame) {
        const lines = super.render(width);
        return isFullscreenTui(this.tuiRef)
          ? this.renderFullscreenDockLines(this.extractEditorContentLines(lines), width)
          : lines;
      }
      const lines = this.dependencies.settingsController.isActive
        ? this.renderSettingsMode(width)
        : this.renderEditorMode(width);
      return this.renderFullscreenDockLines(lines, width);
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
    try {
      return [
        ...lines,
        ...(this.dependencies.renderFullscreenStatus?.(width) ?? []),
      ];
    } catch (error) {
      handleExtensionError(error, "BorderlessEditor fullscreen status render");
      return this.fillFullscreenDockRows(lines, width);
    }
  }

  private fillFullscreenDockRows(lines: string[], width: number): string[] {
    const missingRows = Math.max(0, FULLSCREEN_EDITOR_MIN_ROWS - lines.length);
    if (missingRows === 0) return lines;

    const outputWidth = Math.max(1, Math.floor(width));
    if (!this.dependencies.config.get().editorFrame) {
      return [
        ...lines,
        ...Array.from({ length: missingRows }, () => " ".repeat(outputWidth)),
      ];
    }

    const frameFg = (value: string) => `${fgRgb(FRAME_RGB)}${value}${RESET}`;
    const filler = outputWidth >= 2
      ? frameFg(`${BOX.v}${" ".repeat(outputWidth - 2)}${BOX.v}`)
      : frameFg(BOX.v);
    return [...lines, ...Array.from({ length: missingRows }, () => filler)];
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
    const frameFg = (value: string) => `${fgRgb(FRAME_RGB)}${value}${RESET}`;
    const promptPrefix = ` ${PURPLE}❯${RESET} `;
    const continuationPrefix = " ".repeat(visibleWidth(promptPrefix));
    const innerWidth = Math.max(1, frameEnabled ? width - 2 : width);
    const contentWidth = Math.max(1, innerWidth - visibleWidth(promptPrefix));
    const lines = super.render(contentWidth);
    if (lines.length < 2) return lines;

    const result: string[] = [];
    if (shouldRenderEditorTopBorder(config)) {
      result.push(
        frameFg(`${BOX.tl}${BOX.h.repeat(Math.max(0, width - 2))}${BOX.tr}`),
      );
    }

    const contentLines = this.extractEditorContentLines(lines);
    let first = true;
    for (const line of contentLines) {
      const prefix = first ? promptPrefix : continuationPrefix;
      const content = truncateToWidth(`${prefix}${line}`, innerWidth);
      if (!frameEnabled) {
        result.push(content);
      } else {
        result.push(
          frameFg(BOX.v) +
            content +
            " ".repeat(Math.max(0, innerWidth - visibleWidth(content))) +
            frameFg(BOX.v),
        );
      }
      first = false;
    }
    return result;
  }

  private renderSettingsMode(width: number): string[] {
    const config = this.dependencies.config.get();
    const frameEnabled = config.editorFrame;
    const innerWidth = Math.max(1, frameEnabled ? width - 2 : width);
    const frameFg = (value: string) => `${fgRgb(FRAME_RGB)}${value}${RESET}`;
    const result: string[] = [];

    if (shouldRenderEditorTopBorder(config)) {
      result.push(
        frameFg(`${BOX.tl}${BOX.h.repeat(Math.max(0, width - 2))}${BOX.tr}`),
      );
    }
    for (const line of this.dependencies.settingsController.buildLines(innerWidth)) {
      const padded = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      result.push(
        frameEnabled
          ? frameFg(BOX.v) + padded + frameFg(BOX.v)
          : truncateToWidth(padded, innerWidth),
      );
    }
    return result;
  }
}
