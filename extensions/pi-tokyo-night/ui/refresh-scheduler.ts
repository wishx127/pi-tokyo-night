type AnimationTask = { intervalMs: number; dueAt: number; update(): void };

/** One clock for extension UI updates. Host input and model rendering stay independent. */
export class RefreshScheduler {
  private readonly tasks = new Set<AnimationTask>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirtyAt: number | undefined;
  private lastRenderAt = Date.now();
  private lastStreamAt: number | undefined;
  private frameIntervalMs = 100;
  private updating = false;
  private disposed = false;

  constructor(private readonly publish: (requestHostRender: boolean) => void) {}

  setFrameInterval(intervalMs: number): void {
    this.frameIntervalMs = intervalMs;
    if (this.dirtyAt !== undefined) {
      this.dirtyAt = Math.max(Date.now(), this.lastRenderAt + intervalMs);
    }
    this.schedule();
  }

  repeat(intervalMs: number, update: () => void): () => void {
    if (this.disposed) return () => {};
    const task = { intervalMs, dueAt: Date.now() + intervalMs, update };
    this.tasks.add(task);
    this.schedule();
    return () => {
      this.tasks.delete(task);
      this.schedule();
    };
  }

  requestRender(): void {
    if (this.disposed) return;
    this.dirtyAt ??= Math.max(Date.now(), this.lastRenderAt + this.frameIntervalMs);
    this.schedule();
  }

  /** Publish a phase change immediately through the same animation outlet. */
  flushNow(): void {
    if (this.disposed) return;
    this.lastStreamAt = undefined;
    this.dirtyAt = Date.now();
    this.update(Date.now());
  }

  /** Called after a stream event updates state, before Pi renders that event. */
  hostWillRender(streaming = true): void {
    if (this.disposed) return;
    const now = Date.now();
    this.lastStreamAt = streaming ? now : undefined;
    this.update(now, true);
  }

  dispose(): void {
    this.disposed = true;
    this.tasks.clear();
    this.dirtyAt = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private update(now: number, hostWillRender = false): void {
    this.updating = true;
    try {
      for (const task of [...this.tasks]) {
        if (!this.tasks.has(task) || task.dueAt > now) continue;
        // Skip expired frames after a pause instead of replaying a backlog.
        task.dueAt += (Math.floor((now - task.dueAt) / task.intervalMs) + 1) * task.intervalMs;
        task.update();
      }
      if (hostWillRender) {
        this.dirtyAt = undefined;
        this.lastRenderAt = now;
        this.publish(false);
      } else if (this.dirtyAt !== undefined && this.dirtyAt <= now) {
        this.dirtyAt = undefined;
        this.lastRenderAt = now;
        this.publish(true);
      }
    } finally {
      this.updating = false;
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.updating || this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    let dueAt = this.dirtyAt ?? Infinity;
    for (const task of this.tasks) dueAt = Math.min(dueAt, task.dueAt);
    if (!Number.isFinite(dueAt)) return;
    if (this.lastStreamAt !== undefined) {
      dueAt = Math.max(dueAt, this.lastStreamAt + this.frameIntervalMs);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.update(Date.now());
    }, Math.max(0, dueAt - Date.now()));
    this.timer.unref?.();
  }
}
