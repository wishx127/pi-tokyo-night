import { allocateImageId, deleteKittyImage, getCapabilities, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TokyoConfigManager } from "../core/config";
import { handleExtensionError } from "../core/errors";
import { requestHostRender } from "../core/pi-compat";
import {
  getFrameContentWidth,
  renderFrameSegment,
} from "../ui/frame-layout";
import {
  createTokyoNightPalette,
  type TokyoNightThemePalette,
} from "../ui/theme-palette";
import type { RainAnimationManager, RainFrameSnapshot } from "./rain-manager";
import { MOON, STAR, RAIN_DROP, renderRainScene } from "./rain-scene";
import { rainMoonBounds } from "./rain-geometry";
import { getAmberMoonGraphic, type RainMoonGraphic } from "./rain-moon-graphic";

export { MOON, STAR, RAIN_DROP } from "./rain-scene";

export interface RainPanelRenderOptions {
  width: number;
  frameEnabled: boolean;
  rainRows: number;
  snapshot: RainFrameSnapshot;
  palette?: TokyoNightThemePalette;
  moonGraphic?: RainMoonGraphic;
}

export function renderRainPanelLines(
  options: RainPanelRenderOptions,
): string[] {
  const outputWidth = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const bodyRows = Number.isFinite(options.rainRows) ? Math.max(0, Math.floor(options.rainRows)) : 0;
  const innerWidth = getFrameContentWidth(outputWidth, options.frameEnabled);
  const moon = rainMoonBounds(innerWidth, bodyRows);
  const graphic = options.moonGraphic;
  const visibleGraphic = moon.curved && graphic && moon.col + graphic.columns <= innerWidth ? graphic : undefined;
  const lines = renderRainScene(innerWidth, bodyRows, options.snapshot, options.palette, visibleGraphic?.columns);
  const frame = renderFrameSegment({
    width: outputWidth,
    lines,
    frameEnabled: options.frameEnabled,
    role: "top",
    palette: options.palette,
  });
  if (visibleGraphic) {
    const border = options.frameEnabled ? 1 : 0;
    const col = moon.col + border;
    const row = moon.row + border;
    // Insert after width clipping so the host sees an image line without counting the image as text.
    const forward = col ? `\x1b[${col + 1}G` : "";
    const back = col ? "\x1b[1G" : "";
    frame[row] = forward + visibleGraphic.sequence + back + frame[row] + "\x1b[0m";
  }
  return frame;
}

export interface RainPanelDependencies {
  config: TokyoConfigManager;
  rain: RainAnimationManager;
  getTheme?: () => Theme;
  palette?: TokyoNightThemePalette;
  /** Total segment budget, including its top edge; framed panels always keep that edge. */
  getAvailableRows?: (width: number) => number;
}

function paletteSignature(palette: TokyoNightThemePalette | undefined): string {
  return palette ? [
    palette.fg("rain", RAIN_DROP), palette.fg("star", STAR),
    palette.fg("moon", MOON), palette.fg("frame", "│"),
    ...(["rain", "moon", "star", "water"] as const)
      .map((role) => palette.rainShade?.(role, 0.5, ".") ?? ""),
    palette.rippleShade?.(0.5, 0.12, ".", "water") ?? "",
  ].join("\0") : "";
}

type RainPanelCacheEntry = {
  theme: Theme | undefined;
  colors: string;
  revision: number;
  width: number;
  frameEnabled: boolean;
  effectiveRows: number;
  configuredRows: number;
  terminalRows: number | undefined;
  terminalColumns: number | undefined;
  moonGraphic: RainMoonGraphic | undefined;
  lines: string[];
};

export class RainPanelComponent implements Component {
  private disposed = false;
  private invalidated = true;
  private cache: RainPanelCacheEntry | undefined;
  private pendingFrame: RainPanelCacheEntry | undefined;
  private moonImageId: number | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly dependencies: RainPanelDependencies,
  ) {}

  invalidate(): void {
    this.invalidated = true;
    this.cache = undefined;
    this.pendingFrame = undefined;
  }

  private effectiveRows(width: number, configuredRows: number, frameEnabled: boolean): number {
    const topRows = frameEnabled ? 1 : 0;
    const availableRows = this.dependencies.getAvailableRows?.(width) ?? configuredRows + topRows;
    return Math.min(configuredRows, Math.max(0,
      (Number.isFinite(availableRows) ? Math.floor(availableRows) : 0) - topRows,
    ));
  }

  private getMoonGraphic(theme: Theme | undefined): RainMoonGraphic | undefined {
    const terminal = process.env.TERM_PROGRAM?.toLowerCase();
    const term = process.env.TERM ?? "";
    const nativeKitty = !process.env.TMUX && !/^(screen|tmux)/.test(term) &&
      (terminal === "kitty" || (!terminal && term === "xterm-kitty"));
    // Pi treats image rows as indivisible. Use text while an overlay can intersect the rain panel.
    if (!theme || !nativeKitty || getCapabilities().images !== "kitty" || this.tui.hasOverlay?.()) return undefined;
    return getAmberMoonGraphic(theme.name, this.moonImageId ??= allocateImageId());
  }

  /** Whether a rain tick can change the last rendered panel. */
  hasVisibleChanges(): boolean {
    if (this.disposed) return false;
    try {
      const config = this.dependencies.config.get();
      if (!config.panel) return false;
      const cached = this.cache;
      if (this.invalidated || !cached) return true;
      if (cached.frameEnabled !== config.editorFrame ||
        cached.configuredRows !== config.rainRows ||
        cached.terminalRows !== this.tui.terminal?.rows ||
        cached.terminalColumns !== this.tui.terminal?.columns) return true;
      if (cached.effectiveRows !== this.effectiveRows(cached.width, config.rainRows, config.editorFrame)) return true;
      const theme = this.dependencies.getTheme?.();
      const palette = theme ? createTokyoNightPalette(theme) : this.dependencies.palette;
      const colors = paletteSignature(palette);
      const moonGraphic = this.getMoonGraphic(theme);
      if (cached.theme !== theme || cached.colors !== colors) return true;
      if (cached.moonGraphic?.sequence !== moonGraphic?.sequence ||
        cached.moonGraphic?.columns !== moonGraphic?.columns) return true;
      if (cached.effectiveRows === 0) return false;
      const lines = renderRainPanelLines({
        width: cached.width,
        frameEnabled: cached.frameEnabled,
        rainRows: cached.effectiveRows,
        snapshot: this.dependencies.rain.getSnapshot(),
        palette,
        moonGraphic,
      });
      this.pendingFrame = {
        ...cached, revision: this.dependencies.rain.frameRevision, lines,
      };
      return lines.length !== cached.lines.length ||
        lines.some((line, index) => line !== cached.lines[index]);
    } catch {
      // Let the actual render report errors; uncertain frames must not freeze
      // the animation or stop its clock through the manager's failure guard.
      this.pendingFrame = undefined;
      return true;
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [];

    try {
      const config = this.dependencies.config.get();
      if (!config.panel) {
        this.invalidate();
        return [];
      }

      const theme = this.dependencies.getTheme?.();
      const palette = theme
        ? createTokyoNightPalette(theme)
        : this.dependencies.palette;
      const colors = paletteSignature(palette);
      const moonGraphic = this.getMoonGraphic(theme);
      const outputWidth = Math.max(0, Math.floor(width));
      const effectiveRows = this.effectiveRows(outputWidth, config.rainRows, config.editorFrame);
      this.dependencies.rain.setRenderWidth(
        getFrameContentWidth(outputWidth, config.editorFrame),
        effectiveRows,
      );
      const revision = this.dependencies.rain.frameRevision;
      const cached = this.pendingFrame ?? this.cache;
      if (
        !this.invalidated &&
        cached &&
        cached.theme === theme &&
        cached.colors === colors &&
        cached.moonGraphic?.sequence === moonGraphic?.sequence &&
        cached.moonGraphic?.columns === moonGraphic?.columns &&
        cached.revision === revision &&
        cached.width === outputWidth &&
        cached.frameEnabled === config.editorFrame &&
        cached.configuredRows === config.rainRows &&
        cached.terminalRows === this.tui.terminal?.rows &&
        cached.terminalColumns === this.tui.terminal?.columns &&
        cached.effectiveRows === effectiveRows
      ) {
        this.cache = cached;
        this.pendingFrame = undefined;
        return cached.lines;
      }

      const rendered = renderRainPanelLines({
        width: outputWidth,
        frameEnabled: config.editorFrame,
        rainRows: effectiveRows,
        snapshot: this.dependencies.rain.getSnapshot(),
        palette,
        moonGraphic,
      });
      const lines = rendered;
      this.cache = {
        theme,
        colors,
        revision,
        width: outputWidth,
        frameEnabled: config.editorFrame,
        effectiveRows,
        configuredRows: config.rainRows,
        terminalRows: this.tui.terminal?.rows,
        terminalColumns: this.tui.terminal?.columns,
        moonGraphic,
        lines,
      };
      this.invalidated = false;
      this.pendingFrame = undefined;
      return lines;
    } catch (error) {
      this.invalidate();
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
    this.pendingFrame = undefined;
    const imageId = this.moonImageId;
    this.moonImageId = undefined;
    if (imageId !== undefined) {
      try {
        this.tui.terminal?.write(deleteKittyImage(imageId));
      } catch (error) {
        handleExtensionError(error, "rain moon cleanup");
      }
    }
  }
}
