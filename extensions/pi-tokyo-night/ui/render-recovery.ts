export interface RenderDimensions {
  columns: number;
  rows: number;
}

export interface RenderRecoveryDependencies {
  getDimensions(): RenderDimensions;
  pause(): void;
  recover(): void;
  resume(): void;
  onError?(error: unknown): void;
}

export interface RenderRecoveryOptions {
  settleMs?: number;
}

const MAX_INVALID_DIMENSION_PROBES = 3;

/** Repaints a resumed terminal after its dimensions have stopped changing. */
export class RenderRecoveryCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private paused = false;
  private focused = true;
  private active = true;
  private disposed = false;
  private revision = 0;
  private invalidDimensionProbes = MAX_INVALID_DIMENSION_PROBES;
  private dimensions: RenderDimensions | undefined;
  private readonly settleMs: number;

  constructor(
    private readonly dependencies: RenderRecoveryDependencies,
    options: RenderRecoveryOptions = {},
  ) {
    this.settleMs = Number.isFinite(options.settleMs) && options.settleMs! > 0
      ? Math.max(1, Math.floor(options.settleMs!)) : 200;
  }

  setFocused(focused: boolean): void {
    if (this.disposed) return;
    this.focused = focused;
    this.resized();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    // Focus changes may be lost while the terminal's input listener is stopped.
    if (active) this.focused = true;
    this.resized();
  }

  resized(): void {
    if (this.disposed) return;
    const revision = ++this.revision;
    this.invalidDimensionProbes = MAX_INVALID_DIMENSION_PROBES;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.paused) {
      this.paused = true;
      try {
        this.dependencies.pause();
      } catch (error) {
        this.reportError(error);
      }
    }
    if (!this.isCurrent(revision)) return;
    let dimensions: RenderDimensions | undefined;
    try {
      dimensions = this.readDimensions();
    } catch (error) {
      this.reportError(error);
      this.resume(revision);
      return;
    }
    if (!this.isCurrent(revision)) return;
    this.dimensions = dimensions;
    this.schedule(revision);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(revision: number): void {
    this.timer = setTimeout(() => {
      if (!this.isCurrent(revision)) return;
      this.timer = undefined;
      let dimensions: RenderDimensions | undefined;
      try {
        dimensions = this.readDimensions();
      } catch (error) {
        this.reportError(error);
        this.resume(revision);
        return;
      }
      if (!this.isCurrent(revision)) return;
      if (!dimensions) {
        this.dimensions = undefined;
        // Some backends recover without emitting another resize. Probe briefly,
        // then release the cosmetic clock instead of leaving it paused forever.
        if (--this.invalidDimensionProbes > 0) this.schedule(revision);
        else this.resume(revision);
        return;
      }
      if (dimensions.columns !== this.dimensions?.columns ||
        dimensions.rows !== this.dimensions.rows) {
        this.dimensions = { ...dimensions };
        this.schedule(revision);
        return;
      }
      try {
        this.dependencies.recover();
      } catch (error) {
        this.reportError(error);
      } finally {
        this.resume(revision);
      }
    }, this.settleMs);
    this.timer.unref?.();
  }

  private readDimensions(): RenderDimensions | undefined {
    const { columns, rows } = this.dependencies.getDimensions();
    return Number.isInteger(columns) && columns > 0 && Number.isInteger(rows) && rows > 0
      ? { columns, rows } : undefined;
  }

  private reportError(error: unknown): void {
    try {
      this.dependencies.onError?.(error);
    } catch {
      // A failing error sink must not interrupt terminal recovery or cleanup.
    }
  }

  private isCurrent(revision: number): boolean {
    return !this.disposed && this.active && this.focused && this.revision === revision;
  }

  private resume(revision: number): void {
    if (!this.isCurrent(revision)) return;
    this.paused = false;
    try {
      this.dependencies.resume();
    } catch (error) {
      this.reportError(error);
    }
  }
}
