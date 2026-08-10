import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { TokyoConfigManager } from "../core/config";
import { handleExtensionError } from "../core/errors";
import { requestHostRender } from "../core/pi-compat";
import {
  getFrameContentWidth,
  renderFrameSegment,
} from "../ui/frame-layout";
import { CYAN, PURPLE, RESET } from "../ui/ui-primitives";
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
  const innerWidth = getFrameContentWidth(outputWidth, options.frameEnabled);
  const lines: string[] = [];

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
    let row = "";
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
    lines.push(row);
  }
  return renderFrameSegment({
    width: outputWidth,
    lines,
    frameEnabled: options.frameEnabled,
    role: "top",
  });
}

export interface RainPanelDependencies {
  config: TokyoConfigManager;
  rain: RainAnimationManager;
}

type RainPanelCacheEntry = {
  revision: number;
  width: number;
  frameEnabled: boolean;
  rainRows: number;
  lines: string[];
};

export class RainPanelComponent implements Component {
  private disposed = false;
  private invalidated = true;
  private cache: RainPanelCacheEntry | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly dependencies: RainPanelDependencies,
  ) {}

  invalidate(): void {
    this.invalidated = true;
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.disposed) return [];

    try {
      const config = this.dependencies.config.get();
      if (!config.panel) return [];

      const outputWidth = Math.max(0, Math.floor(width));
      this.dependencies.rain.setRenderWidth(
        getFrameContentWidth(outputWidth, config.editorFrame),
      );
      const revision = this.dependencies.rain.frameRevision;
      const cached = this.cache;
      if (
        !this.invalidated &&
        cached &&
        cached.revision === revision &&
        cached.width === outputWidth &&
        cached.frameEnabled === config.editorFrame &&
        cached.rainRows === config.rainRows
      ) {
        return cached.lines;
      }

      const rendered = renderRainPanelLines({
        width: outputWidth,
        frameEnabled: config.editorFrame,
        rainRows: config.rainRows,
        snapshot: this.dependencies.rain.getSnapshot(),
      });
      const lines = rendered;
      this.cache = {
        revision,
        width: outputWidth,
        frameEnabled: config.editorFrame,
        rainRows: config.rainRows,
        lines,
      };
      this.invalidated = false;
      return lines;
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
    this.cache = undefined;
  }
}
