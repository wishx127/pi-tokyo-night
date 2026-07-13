import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  EXT_PREFIX,
  handleExtensionError,
  isStaleExtensionContextError,
} from "./errors";
import { TokyoConfigManager } from "./config";
import { BOX, CYAN, FRAME_RGB, PURPLE, RESET, fgRgb } from "./ui-primitives";

interface RainDrop {
  col: number;
  row: number;
}

const WIND_DRIFT = 1;
const WIND_PERIOD = 2;
const MOON = "🌙";
const MOON_FG = "\x1b[38;2;255;235;170m";
const MOON_COL = 2;
const MOON_ROW = 0;
const STAR = "✦";

export interface RainManagerDependencies {
  isSideBordersHidden(): boolean;
}

export class RainAnimationManager {
  private config: TokyoConfigManager;
  private dependencies: RainManagerDependencies;
  private interval: ReturnType<typeof setInterval> | undefined;
  private drops: RainDrop[] = [];
  private lastWidth = 80;
  private widgetTui: TUI | null = null;
  private stars: Array<{ col: number; row: number }> = [];

  constructor(
    config: TokyoConfigManager,
    dependencies: RainManagerDependencies,
  ) {
    this.config = config;
    this.dependencies = dependencies;
  }

  /** Set up the rain widget above the editor and start the animation timer. */
  setup(ui: ExtensionUIContext): void {
    this.stars = [
      { col: 5, row: 1 },
      { col: 8, row: 0 },
    ];

    this.drops = [];
    this.lastWidth = 80;
    this.widgetTui = null;

    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.tick(), this.config.get().rainTickMs);

    ui.setWidget(
      "tokyo-rain",
      (tui: TUI, _theme: Theme) => {
        this.widgetTui = tui;
        return {
          invalidate() {},
          render: (width: number): string[] => this.renderWidget(width),
          // Called by Pi when the widget is replaced or removed. Stop the
          // animation timer here so toggling the panel off via the slash
          // command does not leave a dangling interval triggering renders.
          dispose: (): void => this.disposeWidget(),
        };
      },
      { placement: "aboveEditor" },
    );
  }

  /** Remove the rain widget and stop the animation timer. Idempotent. */
  teardown(ui: ExtensionUIContext): void {
    // setWidget(undefined) triggers the previous component's dispose(), which
    // clears the interval. We still clear here as a safety net for cases where
    // dispose() is not invoked (e.g. process exit).
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    ui.setWidget("tokyo-rain", undefined);
    this.drops = [];
    this.widgetTui = null;
  }

  /** Request a re-render of the rain widget TUI. Handles disposed TUI gracefully. */
  requestRender(): void {
    try {
      this.widgetTui?.requestRender();
    } catch (err) {
      if (isStaleExtensionContextError(err)) return;
      console.error(`${EXT_PREFIX} rain animation render request failed:`, err);
    }
  }

  /** Animation tick: advance drops, spawn new ones, request render. */
  private tick(): void {
    const cfg = this.config.get();
    for (const drop of this.drops) {
      drop.row += 1;
      if (drop.row % WIND_PERIOD === 0) {
        drop.col += WIND_DRIFT;
      }
    }
    this.drops = this.drops.filter(
      (d) => d.row < cfg.rainRows && d.col < this.lastWidth + 4,
    );
    if (this.drops.length < cfg.maxRainDrops) {
      // Scale spawn rate with desired density. The default (maxRainDrops=25)
      // spawns 2-3 per tick; higher values spawn proportionally more so the
      // steady-state visible count scales with the setting.
      const densityRatio = cfg.maxRainDrops / 25;
      const baseSpawn = Math.random() < 0.5 ? 3 : 2;
      const spawnCount = Math.min(
        Math.ceil(baseSpawn * densityRatio),
        cfg.maxRainDrops - this.drops.length,
      );
      for (let i = 0; i < spawnCount; i++) {
        this.drops.push({
          col: Math.floor(Math.random() * this.lastWidth * 0.9) - 2,
          row: 0,
        });
      }
    }
    this.requestRender();
  }

  /** Render the rain widget content. Delegated from the widget factory's render. */
  renderWidget(width: number): string[] {
    try {
      if (width < 10) return [];
      const cfg = this.config.get();
      const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;

      // When a selector has replaced our editor, remove only the │ side
      // borders from the rain widget. The ╭─╮ top border is kept — it
      // provides visual continuity as a header decoration even when the
      // middle area shows a selector. Only the │ side borders are removed
      // because they would appear broken where the selector doesn't have them.
      const hideSideBorders = this.dependencies.isSideBordersHidden();

      // In selector mode (no │ borders), content fills the full width.
      // In normal mode (│ on both sides), content fills width - 2.
      const innerWidth = Math.max(1, hideSideBorders ? width : width - 2);
      this.lastWidth = innerWidth;
      const lines: string[] = [];

      // Top border: ╭─╮ when │ side borders connect to the corners,
      // plain ─ horizontal line without corners when │ sides are hidden
      // (selector mode — corners look broken without connecting │).
      if (hideSideBorders) {
        lines.push(frameFg(BOX.h.repeat(width)));
      } else {
        lines.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
      }

      const dropSet = new Set<string>();
      for (const drop of this.drops) {
        if (
          drop.col >= 0 &&
          drop.col < innerWidth &&
          drop.row >= 0 &&
          drop.row < cfg.rainRows
        ) {
          dropSet.add(`${drop.col},${drop.row}`);
        }
      }

      const starSet = new Set<string>();
      for (const s of this.stars) {
        if (s.col < innerWidth && s.row < cfg.rainRows) {
          starSet.add(`${s.col},${s.row}`);
        }
      }

      const RAIN_DROP = "`";

      for (let r = 0; r < cfg.rainRows; r++) {
        let row = hideSideBorders ? "" : frameFg(BOX.v);
        for (let c = 0; c < innerWidth; c++) {
          if (r === MOON_ROW && c === MOON_COL) {
            row += `${MOON_FG}${MOON}${RESET}`;
            const mw = visibleWidth(MOON);
            if (mw > 1) c += mw - 1;
            continue;
          }
          if (dropSet.has(`${c},${r}`)) {
            row += `${CYAN}${RAIN_DROP}${RESET}`;
          } else if (starSet.has(`${c},${r}`)) {
            row += `${PURPLE}${STAR}${RESET}`;
          } else {
            row += " ";
          }
        }
        if (!hideSideBorders) {
          row += frameFg(BOX.v);
        }
        lines.push(row);
      }

      return lines;
    } catch (err) {
      handleExtensionError(err, "rain widget render");
      return [];
    }
  }

  /** Dispose the rain widget: clear interval and null TUI reference. */
  private disposeWidget(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.widgetTui = null;
  }
}
