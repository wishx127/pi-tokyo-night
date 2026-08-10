interface StatusRenderCacheKey {
  width: number;
  theme: object;
  config: object;
  branch: string;
  thinkingLevel: string;
  model: unknown;
  leafId: string | null | undefined;
  codexUsage: unknown;
  kimiUsage: unknown;
}

type StatusRenderCacheEntry = {
  key: StatusRenderCacheKey;
  capturedAt: number;
  lines: string[];
};

function keysEqual(
  left: StatusRenderCacheKey,
  right: StatusRenderCacheKey,
): boolean {
  return left.width === right.width &&
    left.theme === right.theme &&
    left.config === right.config &&
    left.branch === right.branch &&
    left.thinkingLevel === right.thinkingLevel &&
    left.model === right.model &&
    left.leafId === right.leafId &&
    left.codexUsage === right.codexUsage &&
    left.kimiUsage === right.kimiUsage;
}

/** Single-entry cache for the fully rendered status frame segment of one live session. */
export class StatusRenderCache {
  private entry: StatusRenderCacheEntry | undefined;

  constructor(
    private readonly maxAgeMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  render(key: StatusRenderCacheKey, build: () => string[]): string[] {
    const now = this.now();
    const cached = this.entry;
    if (
      cached &&
      keysEqual(cached.key, key) &&
      now >= cached.capturedAt &&
      now - cached.capturedAt < this.maxAgeMs
    ) {
      return cached.lines;
    }

    const lines = build();
    this.entry = { key, capturedAt: now, lines };
    return lines;
  }

  invalidate(): void {
    this.entry = undefined;
  }
}
