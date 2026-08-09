import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { TokyoConfigManager } from "../core/config";
import { handleExtensionError } from "../core/errors";
import { requestHostRender } from "../core/pi-compat";
import { BOX, CYAN, FRAME_RGB, PURPLE, RESET, fgRgb } from "../ui/ui-primitives";
import type { RainAnimationManager, RainFrameSnapshot } from "./rain-manager";

export const MOON = "🌙";
export const MOON_FG = "\x1b[38;2;255;235;170m";
export const MOON_COL = 2;
export const MOON_ROW = 0;
export const STAR = "✦";
export const RAIN_DROP = "`";

export interface RainPanelRenderOptions {
  width: number;
  frameEnabled: boolean;
  rainRows: number;
  snapshot: RainFrameSnapshot;
}

export function renderRainPanelLines(
  options: RainPanelRenderOptions,
): string[] {
  const outputWidth = Math.max(0, Math.floor(options.width));
  const bodyRows = Math.max(0, Math.floor(options.rainRows));
  const frameHasSideBorders = options.frameEnabled && outputWidth >= 2;
  const innerWidth = frameHasSideBorders ? outputWidth - 2 : outputWidth;
  const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;
  const lines: string[] = [];

  if (options.frameEnabled && outputWidth >= 2) {
    lines.push(frameFg(`${BOX.tl}${BOX.h.repeat(outputWidth - 2)}${BOX.tr}`));
  } else if (options.frameEnabled && outputWidth === 1) {
    lines.push(frameFg(BOX.tl));
  } else {
    lines.push(frameFg(BOX.h.repeat(outputWidth)));
  }

  const dropSet = new Set<number>();
  for (const drop of options.snapshot.drops) {
    if (
      Number.isInteger(drop.col) &&
      Number.isInteger(drop.row) &&
      drop.col >= 0 &&
      drop.col < innerWidth &&
      drop.row >= 0 &&
      drop.row < bodyRows
    ) {
      dropSet.add(drop.row * innerWidth + drop.col);
    }
  }
  const starSet = new Set<number>();
  for (const star of options.snapshot.stars) {
    if (
      Number.isInteger(star.col) &&
      Number.isInteger(star.row) &&
      star.col >= 0 &&
      star.col < innerWidth &&
      star.row >= 0 &&
      star.row < bodyRows
    ) {
      starSet.add(star.row * innerWidth + star.col);
    }
  }

  const moonWidth = visibleWidth(MOON);
  for (let rowIndex = 0; rowIndex < bodyRows; rowIndex++) {
    let row = frameHasSideBorders ? frameFg(BOX.v) : "";
    let column = 0;
    while (column < innerWidth) {
      const position = rowIndex * innerWidth + column;
      if (
        rowIndex === MOON_ROW &&
        column === MOON_COL &&
        column + moonWidth <= innerWidth
      ) {
        row += MOON_FG + MOON + RESET;
        column += moonWidth;
      } else if (dropSet.has(position)) {
        row += CYAN + RAIN_DROP + RESET;
        column += 1;
      } else if (starSet.has(position)) {
        row += PURPLE + STAR + RESET;
        column += 1;
      } else {
        row += " ";
        column += 1;
      }
    }
    if (frameHasSideBorders) row += frameFg(BOX.v);
    lines.push(truncateToWidth(row, outputWidth));
  }
  return lines;
}

export interface RainPanelDependencies {
  config: TokyoConfigManager;
  rain: RainAnimationManager;
  onRendered(renderedAt: number): void;
}

export class RainPanelComponent implements Component {
  private disposed = false;
  private invalidated = true;

  constructor(
    private readonly tui: TUI,
    private readonly dependencies: RainPanelDependencies,
  ) {}

  invalidate(): void {
    this.invalidated = true;
  }

  render(width: number): string[] {
    if (this.disposed || !this.dependencies.config.get().panel) return [];

    try {
      const config = this.dependencies.config.get();
      const outputWidth = Math.max(0, Math.floor(width));
      const frameWidth = config.editorFrame ? Math.max(0, outputWidth - 2) : outputWidth;
      this.dependencies.rain.setRenderWidth(frameWidth);
      const lines = renderRainPanelLines({
        width: outputWidth,
        frameEnabled: config.editorFrame,
        rainRows: config.rainRows,
        snapshot: this.dependencies.rain.getSnapshot(),
      });
      this.invalidated = false;
      this.dependencies.onRendered(Date.now());
      return config.editorFrame ? lines : lines.slice(1);
    } catch (error) {
      handleExtensionError(error, "rain panel render");
      return [];
    }
  }

  requestRender(force = false): void {
    if (!this.disposed) requestHostRender(this.tui, force);
  }

  dispose(): void {
    this.disposed = true;
    this.invalidated = false;
  }
}
