import { describe, expect, it, vi } from "vitest";
import { StatusRenderCache } from "./status-render-cache";

type StatusRenderCacheKey = Parameters<StatusRenderCache["render"]>[0];

function makeKey(): StatusRenderCacheKey {
  return {
    width: 120,
    theme: {},
    config: {},
    branch: "main",
    thinkingLevel: "high",
    model: {},
    leafId: "leaf-1",
    codexUsage: undefined,
    kimiUsage: undefined,
  };
}

describe("StatusRenderCache", () => {
  it("reuses final lines for one second when status inputs stay unchanged", () => {
    let now = 0;
    const cache = new StatusRenderCache(1000, () => now);
    const key = makeKey();
    const build = vi.fn(() => ["status"]);

    const first = cache.render(key, build);
    now = 999;
    const cached = cache.render(key, build);

    expect(cached).toBe(first);
    expect(build).toHaveBeenCalledOnce();

    now = 1000;
    expect(cache.render(key, build)).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when any semantic cache-key input changes", () => {
    const changes: Array<(key: StatusRenderCacheKey) => StatusRenderCacheKey> = [
      (key) => ({ ...key, width: 80 }),
      (key) => ({ ...key, theme: {} }),
      (key) => ({ ...key, config: {} }),
      (key) => ({ ...key, branch: "feature" }),
      (key) => ({ ...key, thinkingLevel: "low" }),
      (key) => ({ ...key, model: {} }),
      (key) => ({ ...key, leafId: "leaf-2" }),
      (key) => ({ ...key, codexUsage: {} }),
      (key) => ({ ...key, kimiUsage: {} }),
    ];

    for (const change of changes) {
      const cache = new StatusRenderCache();
      const key = makeKey();
      const build = vi.fn(() => ["status"]);
      cache.render(key, build);
      cache.render(change(key), build);
      expect(build).toHaveBeenCalledTimes(2);
    }
  });

  it("rebuilds immediately after semantic input changes or explicit invalidation", () => {
    const cache = new StatusRenderCache();
    const key = makeKey();
    let builds = 0;
    const build = vi.fn(() => [String(++builds)]);

    const first = cache.render(key, build);
    expect(cache.render({ ...key, branch: "feature" }, build)).not.toBe(first);

    const beforeInvalidation = cache.render({ ...key, branch: "feature" }, build);
    cache.invalidate();
    expect(cache.render({ ...key, branch: "feature" }, build)).not.toBe(
      beforeInvalidation,
    );
    expect(build).toHaveBeenCalledTimes(3);
  });
});
