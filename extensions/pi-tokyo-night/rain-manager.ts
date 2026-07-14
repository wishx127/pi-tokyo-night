import {
  EXT_PREFIX,
  isStaleExtensionContextError,
} from "./errors";
import { TokyoConfigManager } from "./config";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RainFrameSnapshot {
  readonly drops: readonly { readonly col: number; readonly row: number }[];
  readonly stars: readonly { readonly col: number; readonly row: number }[];
}

export interface RainManagerDependencies {
  /** Called once per animation tick (no arguments). */
  requestRender(): void;
}

// ── Constants ─────────────────────────────────────────────────────────────

const WIND_DRIFT = 1;
const WIND_PERIOD = 2;

const INITIAL_STARS: ReadonlyArray<{ readonly col: number; readonly row: number }> = [
  { col: 5, row: 1 },
  { col: 8, row: 0 },
];

// ── RainAnimationManager ───────────────────────────────────────────────────

/**
 * Pure animation-state manager for the rain/moon/stars animation.
 *
 * Responsibilities:
 *  - Raindrop positions, movement, and wind logic
 *  - Star positions
 *  - Last valid render width
 *  - Spawn, clip, and density calculation
 *  - Timer start, stop, restart, and idempotency guard
 *  - Config read at runtime (rainTickMs, rainRows, maxRainDrops)
 *  - Calling a no-arg requestRender callback every tick
 *  - Stale extension context error handling
 *
 * Does NOT own: rendering, TUI/UI/Theme imports, widget registration.
 */
export class RainAnimationManager {
  private config: TokyoConfigManager;
  private dependencies: RainManagerDependencies;
  private interval: ReturnType<typeof setInterval> | undefined;
  private drops: Array<{ col: number; row: number }> = [];
  private lastWidth = 80;
  private stars: Array<{ col: number; row: number }> = [];

  constructor(
    config: TokyoConfigManager,
    dependencies: RainManagerDependencies,
  ) {
    this.config = config;
    this.dependencies = dependencies;
  }

  // ── Public lifecycle API ─────────────────────────────────────────────────

  /**
   * Start the animation timer.
   *
   * Idempotent: clears any existing interval first so repeated calls never
   * create multiple timers. Reads rainTickMs at call time.
   */
  start(): void {
    // Clear any previously running timer first (idempotency).
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    // Reset animation state.
    this.drops = [];
    this.lastWidth = 80;
    this.stars = INITIAL_STARS.map((s) => ({ ...s }));

    // Start the interval using the current config value.
    this.interval = setInterval(() => this.tick(), this.config.get().rainTickMs);
  }

  /**
   * Stop the animation timer and clear animation state. Safe to call
   * repeatedly (idempotent).
   */
  stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.drops = [];
  }

  /** True iff a timer is currently active. */
  get isRunning(): boolean {
    return this.interval !== undefined;
  }

  /**
   * Update the width used for spawn range and clipping.
   * Should be called by the renderer with the current inner width before or
   * after each render.
   */
  setRenderWidth(innerWidth: number): void {
    this.lastWidth = innerWidth;
  }

  /**
   * Return a deep copy of the current animation frame.
   * The returned arrays and point objects are independent copies — external
   * code cannot mutate manager internals through the snapshot.
   */
  getSnapshot(): RainFrameSnapshot {
    return {
      drops: this.drops.map((d) => ({ col: d.col, row: d.row })),
      stars: this.stars.map((s) => ({ col: s.col, row: s.row })),
    };
  }

  // ── Private tick ─────────────────────────────────────────────────────────

  /** Animation tick: advance drops, spawn new ones, then notify the renderer. */
  private tick(): void {
    const cfg = this.config.get();

    // Advance existing drops.
    for (const drop of this.drops) {
      drop.row += 1;
      if (drop.row % WIND_PERIOD === 0) {
        drop.col += WIND_DRIFT;
      }
    }

    // Remove drops that are out of bounds.
    this.drops = this.drops.filter(
      (d) => d.row < cfg.rainRows && d.col < this.lastWidth + 4,
    );

    // Spawn new drops if below the desired density.
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

    // Notify the renderer. Stale-context errors are expected during shutdown
    // and silently discarded; all other errors are logged with the extension prefix.
    try {
      this.dependencies.requestRender();
    } catch (err) {
      if (isStaleExtensionContextError(err)) return;
      console.error(`${EXT_PREFIX} rain animation render request failed:`, err);
    }
  }
}
