import {
  EXT_PREFIX,
  isStaleExtensionContextError,
} from "../core/errors";
import { TokyoConfigManager } from "../core/config";
import type { RainRuntimeProfile } from "./rain-profile";
import { rainDrift, rainHorizon, rainLandingRow, rainMoonBounds, rainStarRows, rainVerticalScale, rainWaterMarkLife, rainWind } from "./rain-geometry";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RainFrameSnapshot {
  readonly drops: readonly {
    readonly col: number;
    readonly row: number;
    readonly depth?: number;
    readonly speed?: number;
  }[];
  readonly stars: readonly RainStar[];
  readonly time?: number;
  readonly wind?: number;
  readonly splashes?: readonly RainSplash[];
  readonly waterMarks?: readonly RainWaterMark[];
}

export interface RainStar {
  readonly col: number;
  readonly row: number;
  readonly age?: number;
  readonly life?: number;
  readonly phase?: number;
  readonly period?: number;
}

export interface RainSplash {
  readonly col: number;
  readonly depth: number;
  readonly age: number;
}

export interface RainWaterMark {
  readonly col: number;
  readonly depth: number;
  readonly age: number;
}

type RainDrop = { col: number; row: number; depth: number; speed: number };

export interface RainManagerDependencies {
  /** Called once per animation tick (no arguments). */
  requestRender(): void;
  /** Share the extension's UI clock; standalone users retain interval scheduling. */
  scheduleTick?(tick: () => void, intervalMs: number): () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────

const LAYER_SPEEDS = [5, 9, 14];
const DEPTH_ORDER = [0, 1, 0, 2, 1, 0];
const MAX_RENDER_FAILURES = 3;

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
  private cancelTick: (() => void) | undefined;
  private active = false;
  private drops: RainDrop[] = [];
  private splashes: RainSplash[] = [];
  private waterMarks: RainWaterMark[] = [];
  private lastWidth = 80;
  private lastHeight: number | undefined;
  private time = 0;
  private wind = rainWind(0);
  private fallSpeed = 1;
  private speedTransition: { from: number; to: number; startedAt: number; durationMs: number } | undefined;
  private lastTickAt = 0;
  private spawnRemainder = 0;
  private dropSequence = 0;
  private stars: Array<Required<RainStar>> = [];
  private nextStarAt = 0;
  private consecutiveRenderFailures = 0;
  private profile: RainRuntimeProfile | undefined;
  private densityTransition: {
    from: number;
    to: number;
    startedAt: number;
    durationMs: number;
  } | undefined;
  private scheduledTickMs: number | undefined;
  private pendingTickMs: number | undefined;
  private revision = 0;

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
  start(profile?: RainRuntimeProfile): void {
    // Clear any previously running timer first (idempotency).
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.active = true;

    // Reset animation state only for a new animation lifecycle.
    this.drops = [];
    this.splashes = [];
    this.waterMarks = [];
    this.time = 0;
    this.wind = rainWind(0);
    this.fallSpeed = profile?.fallSpeed ?? 1;
    this.speedTransition = undefined;
    this.spawnRemainder = 0;
    this.dropSequence = 0;
    this.stars = [];
    this.seedStars();
    this.nextStarAt = 0.7 + Math.random() * 1.1;
    this.consecutiveRenderFailures = 0;
    const config = this.config.get();
    this.profile = profile;
    this.densityTransition = undefined;
    this.revision += 1;
    this.schedule(profile?.tickMs ?? config.rainTickMs);
  }

  /** Apply speed and density without resetting the visible rain frame. */
  applyProfile(profile: RainRuntimeProfile): void {
    const currentDensity = this.getDensity();
    const wasStatic = this.active && this.scheduledTickMs === 0;
    if (!wasStatic) this.fallSpeed = this.getFallSpeed(Date.now());
    const sameSpeedTarget = !wasStatic && this.profile?.fallSpeed === profile.fallSpeed &&
      this.profile?.fallSpeedTransitionMs === profile.fallSpeedTransitionMs;
    const sameDensityTarget = this.profile?.maxDrops === profile.maxDrops &&
      this.profile?.densityTransitionMs === profile.densityTransitionMs;
    this.profile = profile;
    if (profile.tickMs === 0) this.speedTransition = undefined;
    else if (!sameSpeedTarget) {
      this.speedTransition = {
        from: this.fallSpeed, to: profile.fallSpeed ?? 1,
        startedAt: Date.now(), durationMs: profile.fallSpeedTransitionMs ?? 1000,
      };
    }
    if (profile.maxDrops === 0) this.spawnRemainder = 0;
    if (!sameDensityTarget) {
      this.densityTransition = this.active && profile.densityTransitionMs && currentDensity !== profile.maxDrops
        ? {
            from: currentDensity,
            to: profile.maxDrops,
            startedAt: Date.now(),
            durationMs: profile.densityTransitionMs,
          }
        : undefined;
    }
    if (!this.active) return;
    if (profile.tickMs === 0 && this.stars.some((star) => star.age < 0.7)) {
      this.stars = this.stars.map((star) => star.age < 0.7 ? { ...star, age: 0.7 } : star);
      this.revision += 1;
    }
    if (this.scheduledTickMs === profile.tickMs) {
      this.pendingTickMs = undefined;
      return;
    }
    if (profile.tickMs === 0 || this.scheduledTickMs === 0) {
      this.cancelTick?.();
      this.cancelTick = undefined;
      this.schedule(profile.tickMs);
      return;
    }
    // Keep the current interval until its next tick. Replacing it here can
    // indefinitely postpone animation when tool events arrive quickly.
    this.pendingTickMs = profile.tickMs;
  }

  /**
   * Stop the animation timer and clear animation state. Safe to call
   * repeatedly (idempotent).
   */
  stop(): void {
    this.active = false;
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.drops = [];
    this.splashes = [];
    this.waterMarks = [];
    this.stars = [];
    this.consecutiveRenderFailures = 0;
    this.profile = undefined;
    this.densityTransition = undefined;
    this.speedTransition = undefined;
    this.scheduledTickMs = undefined;
    this.pendingTickMs = undefined;
    this.revision += 1;
  }

  /** True while the scene is active, including a static scene without a timer. */
  get isRunning(): boolean {
    return this.active;
  }

  /** Monotonic identity of the current animation frame. */
  get frameRevision(): number {
    return this.revision;
  }

  /**
   * Update the width used for spawn range and clipping.
   * Should be called by the renderer with the current inner width before or
   * after each render.
   */
  setRenderWidth(innerWidth: number, rows?: number): void {
    const width = Number.isFinite(innerWidth) ? Math.max(0, Math.floor(innerWidth)) : 0;
    const height = rows === undefined ? undefined
      : Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
    // A collapsed viewport has no coordinate space to scale into. Keep the last
    // valid simulation so expanding it doesn't pile every drop into the corner.
    if (width === 0 || height === 0) return;
    if (width === this.lastWidth && height === this.lastHeight) return;
    const oldHeight = this.lastHeight ?? this.config.get().rainRows;
    const oldWidth = this.lastWidth;
    const previousStars = this.stars;
    for (const drop of this.drops) {
      drop.col *= width / Math.max(1, this.lastWidth);
      drop.row *= rainLandingRow(height ?? this.config.get().rainRows, drop.depth) /
        Math.max(1, rainLandingRow(oldHeight, drop.depth));
    }
    this.splashes = this.splashes.map((splash) => ({
      ...splash, col: splash.col * width / Math.max(1, this.lastWidth),
    }));
    this.waterMarks = this.waterMarks.map((mark) => ({
      ...mark, col: mark.col * width / Math.max(1, this.lastWidth),
    }));
    this.lastWidth = width;
    this.lastHeight = height;
    this.stars = [];
    for (const star of previousStars) {
      const col = Math.floor(star.col * width / Math.max(1, oldWidth));
      const row = star.row;
      if (this.stars.length < this.starTarget() && this.starPositionAvailable(col, row)) {
        this.stars.push({ ...star, col, row });
      }
    }
    const target = this.starTarget();
    this.seedStars(
      !this.active || this.scheduledTickMs === 0,
      Math.max(Math.min(previousStars.length, target), Math.ceil(target * 0.6)),
    );
    this.revision += 1;
  }

  /**
   * Return a deep copy of the current animation frame.
   * The returned arrays and point objects are independent copies — external
   * code cannot mutate manager internals through the snapshot.
   */
  getSnapshot(): RainFrameSnapshot {
    return {
      drops: this.drops.map((d) => ({ ...d })),
      stars: this.stars.map((s) => ({ ...s })),
      time: this.time,
      wind: this.wind,
      splashes: this.splashes.map((splash) => ({ ...splash })),
      waterMarks: this.waterMarks.map((mark) => ({ ...mark })),
    };
  }

  // ── Private tick ─────────────────────────────────────────────────────────

  private starTarget(): number {
    return Math.max(1, Math.min(4, Math.round(this.lastWidth / 40)));
  }

  private starPositionAvailable(col: number, row: number): boolean {
    const rows = this.lastHeight ?? this.config.get().rainRows;
    if (col < 0 || col >= this.lastWidth || row < 0 || row >= rainStarRows(rows)) return false;
    const moon = rainMoonBounds(this.lastWidth, rows);
    if (col >= moon.col && col < moon.col + moon.columns && row >= moon.row && row < moon.row + moon.reservedHeight) return false;
    const gap = Math.max(3, this.lastWidth / (this.starTarget() + 1) * 0.55);
    return this.stars.every((star) => Math.hypot(col - star.col, (row - star.row) * 2) >= gap);
  }

  private spawnStar(initial = false): boolean {
    const candidates: Array<{ col: number; row: number }> = [];
    const starRows = rainStarRows(this.lastHeight ?? this.config.get().rainRows);
    for (let row = 0; row < starRows; row++) for (let col = 0; col < this.lastWidth; col++) {
      if (this.starPositionAvailable(col, row)) candidates.push({ col, row });
    }
    if (candidates.length === 0) return false;
    const point = candidates[Math.floor(Math.random() * candidates.length)];
    this.stars.push({
      ...point, age: initial ? 0.7 + Math.random() * 1.8 : 0,
      life: 6 + Math.random() * 6, phase: Math.random(), period: 5 + Math.random() * 2,
    });
    return true;
  }

  private seedStars(initial = true, target = Math.ceil(this.starTarget() * 0.6)): void {
    while (this.stars.length < target && this.spawnStar(initial)) { /* bounded by the star target */ }
  }

  private getDensity(): number {
    const transition = this.densityTransition;
    if (!transition) return this.profile?.maxDrops ?? this.config.get().maxRainDrops;
    const progress = Math.max(0, Math.min(1, (Date.now() - transition.startedAt) / transition.durationMs));
    return transition.from + (transition.to - transition.from) * progress;
  }

  private getFallSpeed(at: number): number {
    const transition = this.speedTransition;
    if (!transition) return this.fallSpeed;
    if (transition.durationMs <= 0) return transition.to;
    const elapsed = Math.max(0, at - transition.startedAt);
    return transition.to + (transition.from - transition.to) * Math.exp(-3 * elapsed / transition.durationMs);
  }

  private schedule(tickMs: number): void {
    this.scheduledTickMs = tickMs;
    this.pendingTickMs = undefined;
    this.lastTickAt = Date.now();
    if (tickMs === 0) return;
    if (this.dependencies.scheduleTick) {
      this.cancelTick = this.dependencies.scheduleTick(() => this.tick(), tickMs);
    } else {
      const interval = setInterval(() => this.tick(), tickMs);
      interval.unref?.();
      this.cancelTick = () => clearInterval(interval);
    }
  }

  private applyPendingCadence(): void {
    const pending = this.pendingTickMs;
    if (pending === undefined || pending === this.scheduledTickMs) return;
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.schedule(pending);
  }

  /** Animation tick: advance drops, spawn new ones, then notify the renderer. */
  private tick(): void {
    const cfg = this.config.get();
    const maxDrops = Math.round(this.getDensity());
    const now = Date.now();
    // A stalled terminal must not replay seconds of missed simulation.
    let remaining = Math.max(0, Math.min(
      Math.max(0.18, (this.scheduledTickMs ?? cfg.rainTickMs) / 1000),
      (now - this.lastTickAt) / 1000,
    ));
    this.lastTickAt = now;
    while (remaining > 0.000001) {
      const dt = Math.min(0.05, remaining);
      remaining -= dt;
      this.fallSpeed = this.getFallSpeed(now - remaining * 1000);
      this.time += dt;
      this.wind = rainWind(this.time);
      const rows = this.lastHeight ?? cfg.rainRows;
      const verticalScale = rainVerticalScale(rows);
      this.stars = this.stars.map((star) => ({ ...star, age: star.age + dt }))
        .filter((star) => star.age < star.life && star.row < rainStarRows(rows));
      if (this.time >= this.nextStarAt) {
        if (this.stars.length < this.starTarget()) this.spawnStar();
        this.nextStarAt = this.time + 0.7 + Math.random() * 1.1;
      }
      this.splashes = this.splashes
        .map((splash) => ({ ...splash, age: splash.age + dt }))
        .filter((splash) => splash.age < 1.4);
      this.waterMarks = this.waterMarks
        .map((mark) => ({ ...mark, age: mark.age + dt }))
        .filter((mark) => mark.age < rainWaterMarkLife(mark.depth));

      const falling: RainDrop[] = [];
      for (const drop of this.drops) {
        const oldRow = drop.row;
        const speed = drop.speed * this.fallSpeed * verticalScale;
        const vx = rainDrift(this.wind, drop.depth) * speed;
        drop.row += speed * dt;
        drop.col += vx * dt;
        const landingRow = rainLandingRow(rows, drop.depth);
        if (drop.row >= landingRow) {
          const contactCol = drop.col - vx * (drop.row - landingRow) / speed;
          if (rainHorizon(rows) < rows && oldRow < landingRow && contactCol >= 0 && contactCol < this.lastWidth) {
            const impact = {
              col: contactCol,
              depth: drop.depth,
              age: (drop.row - landingRow) / speed,
            };
            this.splashes.push(impact);
            this.waterMarks.push({ ...impact });
          }
        } else if (drop.col >= -4 && drop.col < this.lastWidth + 4) {
          falling.push(drop);
        }
      }
      this.drops = falling;
      this.splashes = this.splashes.slice(-64);
      this.waterMarks = this.waterMarks.slice(-192);

      // Births depend on elapsed time and travel distance, independently of FPS.
      if (rows > 0 && this.lastWidth > 0 && this.drops.length < maxDrops) {
        this.spawnRemainder += maxDrops * dt * 9 * this.fallSpeed * verticalScale / Math.max(1, rows);
        const spawnCount = Math.min(
          Math.floor(this.spawnRemainder),
          maxDrops - this.drops.length,
        );
        this.spawnRemainder -= spawnCount;
        for (let i = 0; i < spawnCount; i++) {
          const depth = DEPTH_ORDER[this.dropSequence++ % DEPTH_ORDER.length];
          this.drops.push({
            col: Math.random() * (this.lastWidth + 4) - 2,
            row: -Math.random() * 1.5 * verticalScale,
            depth,
            speed: LAYER_SPEEDS[depth] * (0.85 + Math.random() * 0.3),
          });
        }
      } else {
        this.spawnRemainder = 0;
      }
      }

      this.revision += 1;

      // Notify the renderer. Stale-context errors are expected during shutdown
      // and silently discarded; all other errors are logged with the extension prefix.
      try {
        this.dependencies.requestRender();
        this.consecutiveRenderFailures = 0;
      } catch (err) {
        if (isStaleExtensionContextError(err)) {
          // A stale context means this manager no longer belongs to a live
          // session. Stop the interval here as a safety net even if the host
          // does not deliver session_shutdown.
          this.stop();
          return;
        }
        this.consecutiveRenderFailures += 1;
        console.error(`${EXT_PREFIX} rain animation render request failed:`, err);
        if (this.consecutiveRenderFailures >= MAX_RENDER_FAILURES) {
          this.stop();
          return;
        }
      }
      this.applyPendingCadence();
    }
  }
