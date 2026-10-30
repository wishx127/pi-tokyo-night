import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RainAnimationManager } from "./rain-manager";
import { TokyoConfigManager, DEFAULT_CONFIG } from "../core/config";
import { resolveRainRuntimeProfile } from "./rain-profile";

// ---------------------------------------------------------------------------
// Minimal fake config that doesn't touch the filesystem.
// We use a real TokyoConfigManager but bypass read() by mutating .set().
// ---------------------------------------------------------------------------
function makeConfig(overrides?: Partial<typeof DEFAULT_CONFIG>): TokyoConfigManager {
  const mgr = new TokyoConfigManager();
  // TokyoConfigManager.get() returns the mutable config directly, so we can
  // patch individual properties through .set() without touching disk.
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      mgr.set(k as keyof typeof DEFAULT_CONFIG, v as boolean | number);
    }
  }
  return mgr;
}

// Hold cadence fixed here so density transitions are tested independently of activity speed.
function densityProfile(config: TokyoConfigManager, activity: Parameters<typeof resolveRainRuntimeProfile>[1]) {
  const profile = resolveRainRuntimeProfile(config.get(), activity);
  return config.get().rainMode === "auto" ? { ...profile, tickMs: 130, fallSpeed: 1 } : profile;
}

describe("RainAnimationManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("randomizes star positions across scene starts instead of restoring fixed coordinates", () => {
    let seed = 12345;
    vi.spyOn(Math, "random").mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    });
    const manager = new RainAnimationManager(makeConfig(), { requestRender: vi.fn() });
    manager.start();
    const first = manager.getSnapshot().stars.map(({ col, row }) => ({ col, row }));
    manager.stop();
    manager.start();
    expect(manager.getSnapshot().stars.map(({ col, row }) => ({ col, row }))).not.toEqual(first);
    manager.stop();
  });

  it("introduces and retires separated stars while the scene runs", () => {
    let seed = 6791;
    vi.spyOn(Math, "random").mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    });
    const manager = new RainAnimationManager(makeConfig({ rainRows: 10 }), { requestRender: vi.fn() });
    manager.start({ tickMs: 50, maxDrops: 0 });
    manager.setRenderWidth(100, 10);
    const initial = manager.getSnapshot().stars;
    const positions = new Set(initial.map((star) => `${star.col}:${star.row}`));
    vi.advanceTimersByTime(3000);
    expect(manager.getSnapshot().stars.some((star) => !positions.has(`${star.col}:${star.row}`))).toBe(true);
    vi.advanceTimersByTime(15000);
    const stars = manager.getSnapshot().stars;
    expect(stars.length).toBeGreaterThan(0);
    expect(stars.every((star) => star.age! < star.life!)).toBe(true);
    expect(stars.every((star) => !initial.some((old) => old.phase === star.phase))).toBe(true);
    for (let i = 0; i < stars.length; i++) for (let j = i + 1; j < stars.length; j++) {
      expect(Math.hypot(stars[i].col - stars[j].col, (stars[i].row - stars[j].row) * 2)).toBeGreaterThan(6);
    }
    manager.stop();
  });

  it.each([[1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 2], [7, 3], [8, 3], [9, 3], [10, 4]])(
    "keeps new and replacement stars in a %i-row scene's top %i sky rows", (rainRows, starRows) => {
      vi.spyOn(Math, "random").mockReturnValue(0.99);
      const manager = new RainAnimationManager(makeConfig({ rainRows }), { requestRender: vi.fn() });
      manager.start({ tickMs: 50, maxDrops: 0 });
      manager.setRenderWidth(100, rainRows);
      for (let sample = 0; sample < 4; sample++) {
        const stars = manager.getSnapshot().stars;
        expect(stars.length).toBeGreaterThan(0);
        expect(stars.every((star) => star.row >= 0 && star.row < starRows)).toBe(true);
        vi.advanceTimersByTime(5000);
      }
      manager.stop();
    },
  );

  it.each([{ random: 0.01, retire: false }, { random: 0.99, retire: true }])(
    "recycles only out-of-range stars when rows change (%j)", ({ random, retire }) => {
      vi.spyOn(Math, "random").mockReturnValue(random);
      const manager = new RainAnimationManager(makeConfig({ rainRows: 10 }), { requestRender: vi.fn() });
      manager.start({ tickMs: 50, maxDrops: 0 });
      manager.setRenderWidth(100, 10);
      vi.advanceTimersByTime(5000);
      const before = manager.getSnapshot();
      expect(before.stars).toHaveLength(3);
      expect(before.stars.every((star) => star.row >= 2)).toBe(retire);
      manager.setRenderWidth(100, 4);
      const compact = manager.getSnapshot();
      expect(compact.stars).toHaveLength(before.stars.length);
      expect(compact.stars.every((star) => star.row < 2)).toBe(true);
      if (retire) expect(compact.stars.every((star) => star.age === 0)).toBe(true);
      else expect(compact.stars).toEqual(before.stars);
      expect(compact.time).toBe(before.time);
      manager.setRenderWidth(100, 10);
      expect(manager.getSnapshot().stars).toEqual(compact.stars);
      vi.advanceTimersByTime(50);
      expect(manager.getSnapshot().time).toBeGreaterThan(before.time!);
      manager.stop();
    },
  );

  it("moves rain through sub-cell positions at different depths", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const manager = new RainAnimationManager(
      makeConfig({ rainTickMs: 50, rainRows: 10, maxRainDrops: 40 }),
      { requestRender: vi.fn() },
    );
    manager.start();
    vi.advanceTimersByTime(400);
    const first = manager.getSnapshot();
    expect(new Set(first.drops.map((drop) => drop.depth)).size).toBe(3);
    expect(first.drops.some((drop) => !Number.isInteger(drop.row))).toBe(true);
    vi.advanceTimersByTime(50);
    const next = manager.getSnapshot();
    expect(next.time).toBeCloseTo(0.45);
    expect(next.drops.some((drop) => drop.row > 0 && drop.row < 1)).toBe(true);
    manager.stop();
  });

  it.each([2, 3, 4, 5])("keeps rain landing and ripples alive in a %i-row scene", (rainRows) => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const manager = new RainAnimationManager(
      makeConfig({ rainRows, rainTickMs: 50, maxRainDrops: 25 }),
      { requestRender: vi.fn() },
    );
    manager.start();
    manager.setRenderWidth(60, rainRows);
    vi.advanceTimersByTime(2000);
    const frame = manager.getSnapshot();
    expect(frame.drops.length).toBeGreaterThan(0);
    expect(frame.splashes!.length).toBeGreaterThan(0);
    expect(frame.splashes!.some((splash) => splash.depth === 2)).toBe(true);
    expect(frame.stars.every((star) => star.row < rainRows - 1)).toBe(true);
    manager.stop();
  });

  it("scales vertical motion with the visible sky instead of rushing through a compact scene", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const create = (rainRows: number) => new RainAnimationManager(
      makeConfig({ rainRows, rainTickMs: 50, maxRainDrops: 40 }), { requestRender: vi.fn() },
    );
    const compact = create(4), full = create(8);
    compact.start();
    full.start();
    vi.advanceTimersByTime(100);
    const compactRow = compact.getSnapshot().drops[0].row;
    const fullRow = full.getSnapshot().drops[0].row;
    vi.advanceTimersByTime(50);
    const compactTravel = compact.getSnapshot().drops[0].row - compactRow;
    const fullTravel = full.getSnapshot().drops[0].row - fullRow;
    expect(compactTravel).toBeGreaterThan(0);
    expect(compactTravel).toBeCloseTo(fullTravel * 0.6);
    compact.stop();
    full.stop();
  });

  it("preserves the scene across a temporarily collapsed terminal", () => {
    const manager = new RainAnimationManager(makeConfig({ rainTickMs: 50 }), { requestRender: vi.fn() });
    manager.start();
    manager.setRenderWidth(80, 8);
    vi.advanceTimersByTime(400);
    const before = manager.getSnapshot();
    expect(before.drops.length).toBeGreaterThan(0);
    manager.setRenderWidth(0, 0);
    manager.setRenderWidth(80, 8);
    expect(manager.getSnapshot()).toEqual(before);
    manager.stop();
  });

  it("preserves rain progress toward the water when switching to a compact height", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const manager = new RainAnimationManager(makeConfig({ rainTickMs: 50 }), { requestRender: vi.fn() });
    manager.start();
    manager.setRenderWidth(80, 8);
    vi.advanceTimersByTime(400);
    const before = manager.getSnapshot();
    expect(before.drops.some((drop) => drop.depth === 0 && drop.row > 0)).toBe(true);
    manager.setRenderWidth(80, 4);
    const compact = manager.getSnapshot();
    expect(compact.time).toBe(before.time);
    expect(compact.drops).toHaveLength(before.drops.length);
    for (let index = 0; index < before.drops.length; index++) {
      if (before.drops[index].depth === 0) {
        expect(compact.drops[index].row).toBeCloseTo(before.drops[index].row * 0.6);
      }
    }
    manager.stop();
  });

  it.each([50, 200, 1000])("keeps simulated time independent of a normal %ims manual cadence", (rainTickMs) => {
    const manager = new RainAnimationManager(makeConfig({ rainTickMs }), { requestRender: vi.fn() });
    manager.start();
    vi.advanceTimersByTime(2000);
    expect(manager.getSnapshot().time).toBeCloseTo(2);
    manager.stop();
  });

  it("changes physical rain speed smoothly with activity independently of FPS", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const slow = new RainAnimationManager(makeConfig({ rainRows: 10, rainTickMs: 50 }), { requestRender: vi.fn() });
    const fast = new RainAnimationManager(makeConfig({ rainRows: 10, rainTickMs: 50 }), { requestRender: vi.fn() });
    slow.start();
    fast.start();
    vi.advanceTimersByTime(400);
    slow.applyProfile({ tickMs: 50, maxDrops: 25, fallSpeed: 0.65 });
    fast.applyProfile({ tickMs: 50, maxDrops: 25, fallSpeed: 1.25 });
    expect(slow.getSnapshot()).toEqual(fast.getSnapshot());
    vi.advanceTimersByTime(400);
    expect(slow.getSnapshot().drops[0].row).toBeLessThan(fast.getSnapshot().drops[0].row);
    slow.stop();
    fast.stop();
  });

  it.each([4, 10])("creates ripples for about half of actual impacts in a %i-row scene", (rainRows) => {
    let seed = 12345;
    vi.spyOn(Math, "random").mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    });
    const manager = new RainAnimationManager(
      makeConfig({ rainRows, rainTickMs: 50, maxRainDrops: 35 }),
      { requestRender: vi.fn() },
    );
    const impacts = new Set<number>(), ripples = new Set<number>();
    manager.start();
    manager.setRenderWidth(60, rainRows);
    for (let tick = 0; tick < 400; tick++) {
      vi.advanceTimersByTime(50);
      const frame = manager.getSnapshot();
      for (const mark of frame.waterMarks!) impacts.add(mark.seed!);
      for (const splash of frame.splashes!) {
        ripples.add(splash.seed!);
        expect(frame.waterMarks).toContainEqual(splash);
      }
    }
    expect(impacts.size).toBeGreaterThan(100);
    expect(ripples.size / impacts.size).toBeGreaterThan(0.4);
    expect(ripples.size / impacts.size).toBeLessThan(0.6);
    manager.stop();
  });

  it("creates water marks only at rain impacts and lets them outlive the ripples", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const manager = new RainAnimationManager(
      makeConfig({ rainRows: 4, rainTickMs: 50, maxRainDrops: 25 }),
      { requestRender: vi.fn() },
    );
    manager.start();
    manager.setRenderWidth(60, 4);
    expect(manager.getSnapshot().waterMarks).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(manager.getSnapshot().drops.length).toBeGreaterThan(0);
    expect(manager.getSnapshot().waterMarks).toEqual([]);
    for (let tick = 0; tick < 80 && !manager.getSnapshot().splashes!.length; tick++) {
      vi.advanceTimersByTime(50);
    }
    const impact = manager.getSnapshot();
    expect(impact.splashes!.length).toBeGreaterThan(0);
    expect(impact.waterMarks).toEqual(expect.arrayContaining([...impact.splashes!]));
    const first = impact.waterMarks![0];
    expect(first.seed).toEqual(expect.any(Number));
    expect(first.seed).toBeGreaterThanOrEqual(0);
    expect(first.seed).toBeLessThan(2 ** 32);
    manager.applyProfile({ tickMs: 50, maxDrops: 0 });
    vi.advanceTimersByTime(1900);
    const after = manager.getSnapshot();
    expect(after.waterMarks!.some((mark) => mark.col === first.col && mark.depth === first.depth)).toBe(true);
    expect(after.waterMarks!.find((mark) => mark.col === first.col && mark.depth === first.depth)!.seed).toBe(first.seed);
    expect(after.splashes!.some((splash) => splash.col === first.col && splash.depth === first.depth)).toBe(false);
    vi.advanceTimersByTime(8000);
    expect(manager.getSnapshot().waterMarks).toEqual([]);
    manager.stop();
  });

  it("retains a real near wet trace through its delayed fade under maximum manual rain", () => {
    let random = 12345;
    vi.spyOn(Math, "random").mockImplementation(() => {
      random = (Math.imul(random, 1664525) + 1013904223) | 0;
      return (random >>> 0) / 4294967296;
    });
    const manager = new RainAnimationManager(
      makeConfig({ rainRows: 5, rainTickMs: 50, maxRainDrops: 100 }),
      { requestRender: vi.fn() },
    );
    manager.start();
    manager.setRenderWidth(100, 5);
    for (let tick = 0; tick < 80 && !manager.getSnapshot().splashes!.some((splash) => splash.depth === 2); tick++) {
      vi.advanceTimersByTime(50);
    }
    const first = manager.getSnapshot().splashes!.find((splash) => splash.depth === 2)!;
    expect(first).toBeDefined();
    const tracked = () => manager.getSnapshot().waterMarks!.find((mark) =>
      mark.seed === first.seed && mark.col === first.col && mark.depth === first.depth);
    vi.advanceTimersByTime(1500);
    expect(manager.getSnapshot().splashes!.some((splash) =>
      splash.seed === first.seed && splash.col === first.col && splash.depth === first.depth)).toBe(true);
    vi.advanceTimersByTime(3500);
    expect(tracked()).toBeDefined();
    expect(tracked()!.age).toBeGreaterThanOrEqual(5);
    expect(tracked()!.age).toBeLessThan(8.44);
    expect(manager.getSnapshot().drops.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(3300);
    expect(tracked()).toBeDefined();
    expect(tracked()!.age).toBeGreaterThanOrEqual(8.3);
    vi.advanceTimersByTime(150);
    expect(tracked()).toBeUndefined();
    manager.stop();
  });

  it("uses the actual contact point to accept impacts at the viewport edges", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.7);
    const manager = new RainAnimationManager(
      makeConfig({ rainRows: 4, rainTickMs: 50, maxRainDrops: 100 }),
      { requestRender: vi.fn() },
    );
    manager.start();
    manager.setRenderWidth(10, 4);
    vi.advanceTimersByTime(650);
    // This drop touches at 9.864569, then crosses column 10 before the tick ends.
    expect(manager.getSnapshot().waterMarks!.some((mark) => Math.abs(mark.col - 9.864569) < 0.00001)).toBe(true);
    vi.advanceTimersByTime(400);
    expect(manager.getSnapshot().waterMarks!.every((mark) => mark.col >= 0 && mark.col < 10)).toBe(true);
    expect(manager.getSnapshot().splashes!.every((splash) => splash.col >= 0 && splash.col < 10)).toBe(true);
    manager.stop();
  });

  it("ramps physical tool rain faster than its gentle return without resetting drops", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const create = () => new RainAnimationManager(
      makeConfig({ rainRows: 10 }), { requestRender: vi.fn() },
    );
    const fast = create(), slow = create();
    for (const manager of [fast, slow]) {
      manager.start({ tickMs: 50, maxDrops: 25, fallSpeed: 0.65 });
      manager.setRenderWidth(100, 10);
    }
    vi.advanceTimersByTime(500);
    const before = fast.getSnapshot();
    expect(before.drops[0].depth).toBe(0);
    fast.applyProfile({ tickMs: 50, maxDrops: 25, fallSpeed: 1.4, fallSpeedTransitionMs: 250 });
    slow.applyProfile({ tickMs: 50, maxDrops: 25, fallSpeed: 1.4, fallSpeedTransitionMs: 1000 });
    expect(fast.getSnapshot()).toEqual(before);
    vi.advanceTimersByTime(250);
    const toolTravel = fast.getSnapshot().drops[0].row - before.drops[0].row;
    const slowTravel = slow.getSnapshot().drops[0].row - before.drops[0].row;
    expect(toolTravel).toBeGreaterThan(slowTravel * 1.15);
    const peak = fast.getSnapshot();
    fast.applyProfile({ tickMs: 50, maxDrops: 25, fallSpeed: 0.65, fallSpeedTransitionMs: 600 });
    expect(fast.getSnapshot()).toEqual(peak);
    vi.advanceTimersByTime(100);
    const early = fast.getSnapshot();
    const averageSpeed = (early.drops[0].row - peak.drops[0].row) / (peak.drops[0].speed! * 0.1);
    expect(averageSpeed).toBeGreaterThan(0.9);
    expect(averageSpeed).toBeLessThan(1.4);
    fast.stop();
    slow.stop();
  });

  it("starts a speed change at its event time rather than the preceding tick", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const create = () => new RainAnimationManager(makeConfig({ rainRows: 10 }), { requestRender: vi.fn() });
    const rain = create(), control = create();
    for (const manager of [rain, control]) {
      manager.start({ tickMs: 66, maxDrops: 25, fallSpeed: 0.65 });
      manager.setRenderWidth(100, 10);
    }
    vi.advanceTimersByTime(527);
    rain.applyProfile({ tickMs: 66, maxDrops: 25, fallSpeed: 1.4, fallSpeedTransitionMs: 250 });
    vi.advanceTimersByTime(1);
    const changed = rain.getSnapshot().drops[0];
    const unchanged = control.getSnapshot().drops[0];
    expect(changed.depth).toBe(0);
    expect(changed.row).toBeGreaterThan(unchanged.row);
    expect(changed.row - unchanged.row).toBeLessThan(0.005);
    const before = changed.row, controlBefore = unchanged.row;
    for (let update = 0; update < 5; update++) {
      vi.advanceTimersByTime(10);
      rain.applyProfile({ tickMs: 66, maxDrops: 25, fallSpeed: 1.4, fallSpeedTransitionMs: 250 });
    }
    vi.advanceTimersByTime(16);
    expect(rain.getSnapshot().drops[0].row - before).toBeGreaterThan(
      (control.getSnapshot().drops[0].row - controlBefore) * 1.25,
    );
    rain.stop();
    control.stop();
  });

  it.each(["tools", "manual"])("freezes physical speed through short and long static pauses before returning to %s", (mode) => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const resume = mode === "tools" ? { tickMs: 50, maxDrops: 25, fallSpeed: 1.4 }
      : { tickMs: 50, maxDrops: 25 };
    const travel = (pauseMs: number) => {
      const manager = new RainAnimationManager(makeConfig({ rainRows: 10 }), { requestRender: vi.fn() });
      manager.start({ tickMs: 50, maxDrops: 25, fallSpeed: 1.4 });
      manager.setRenderWidth(100, 10);
      vi.advanceTimersByTime(500);
      manager.applyProfile({ tickMs: 0, maxDrops: 0 });
      const frozen = manager.getSnapshot();
      vi.advanceTimersByTime(pauseMs / 2);
      manager.applyProfile({ tickMs: 0, maxDrops: 0 });
      vi.advanceTimersByTime(pauseMs / 2);
      expect(manager.getSnapshot()).toEqual(frozen);
      manager.applyProfile(resume);
      vi.advanceTimersByTime(50);
      const delta = manager.getSnapshot().drops[0].row - frozen.drops[0].row;
      manager.stop();
      return delta;
    };
    const immediate = travel(0);
    expect(travel(2000)).toBeCloseTo(immediate, 8);
    expect(travel(10000)).toBeCloseTo(immediate, 8);
  });

  it("keeps impact history bounded and snapshots isolated during sustained rain", () => {
    const manager = new RainAnimationManager(
      makeConfig({ rainRows: 8, rainTickMs: 50, maxRainDrops: 100 }),
      { requestRender: vi.fn() },
    );
    manager.start();
    vi.advanceTimersByTime(5000);
    const frame = manager.getSnapshot();
    expect(frame.splashes!.length).toBeGreaterThan(0);
    expect(frame.splashes!.length).toBeLessThanOrEqual(256);
    expect(frame.splashes!.every((splash) => splash.age >= 0 && splash.age < 1.84)).toBe(true);
    expect(frame.waterMarks!.length).toBeGreaterThan(0);
    expect(frame.waterMarks!.length).toBeLessThanOrEqual(1024);
    expect(frame.waterMarks!.every((mark) => mark.age >= 0 && mark.age < 8.44)).toBe(true);
    (frame.splashes![0] as { col: number }).col = -999;
    (frame.waterMarks![0] as { col: number }).col = -999;
    expect(manager.getSnapshot().splashes!.every((splash) => splash.col >= 0)).toBe(true);
    expect(manager.getSnapshot().waterMarks!.every((mark) => mark.col >= 0)).toBe(true);
    manager.stop();
    expect(manager.getSnapshot().splashes).toEqual([]);
    expect(manager.getSnapshot().waterMarks).toEqual([]);
  });

  it("preserves wet traces through static mode, resizing and a collapsed viewport", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const manager = new RainAnimationManager(
      makeConfig({ rainRows: 10, rainTickMs: 50, maxRainDrops: 25 }),
      { requestRender: vi.fn() },
    );
    manager.start();
    manager.setRenderWidth(100, 10);
    vi.advanceTimersByTime(1500);
    const before = manager.getSnapshot();
    expect(before.waterMarks!.length).toBeGreaterThan(0);
    manager.applyProfile({ tickMs: 0, maxDrops: 0 });
    vi.advanceTimersByTime(2000);
    expect(manager.getSnapshot().waterMarks).toEqual(before.waterMarks);
    manager.setRenderWidth(50, 4);
    const compact = manager.getSnapshot();
    expect(compact.waterMarks).toHaveLength(before.waterMarks!.length);
    compact.waterMarks!.forEach((mark, index) => {
      expect(mark.col).toBeCloseTo(before.waterMarks![index].col / 2);
      expect(mark.age).toBe(before.waterMarks![index].age);
      expect(mark.depth).toBe(before.waterMarks![index].depth);
    });
    manager.setRenderWidth(0, 0);
    manager.setRenderWidth(50, 4);
    expect(manager.getSnapshot()).toEqual(compact);
    manager.applyProfile({ tickMs: 50, maxDrops: 0 });
    vi.advanceTimersByTime(50);
    expect(manager.getSnapshot().waterMarks![0].age).toBeCloseTo(compact.waterMarks![0].age + 0.05);
    manager.start({ tickMs: 0, maxDrops: 0 });
    expect(manager.getSnapshot().waterMarks).toEqual([]);
    manager.stop();
  });

  // ── 1. start() creates ONE timer using the current rainTickMs ──────────────

  it("gradually starts tool rain without restarting for repeated activity", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const config = makeConfig({ rainRows: 1 });
    const render = vi.fn();
    const manager = new RainAnimationManager(config, { requestRender: render });
    manager.start(densityProfile(config, "idle"));
    vi.advanceTimersByTime(130);
    expect(manager.getSnapshot().drops).toEqual([]);

    const before = manager.getSnapshot();
    const busy = densityProfile(config, "tools");
    manager.applyProfile(busy);
    expect(manager.getSnapshot()).toEqual(before);
    const counts: number[] = [];
    for (let frame = 0; frame < 7; frame++) {
      manager.applyProfile(busy);
      vi.advanceTimersByTime(130);
      counts.push(manager.getSnapshot().drops.length);
    }

    expect(counts[0]).toBeLessThan(35);
    expect(counts.at(-1)).toBe(35);
    expect(counts.every((count, i) => i === 0 || count >= counts[i - 1])).toBe(true);
    expect(render).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(1);
    manager.stop();
  });

  it("keeps a static scene without timers and can resume manual animation", () => {
    const config = makeConfig({ rainTickMs: 130 });
    config.set("rainMode", "static");
    expect(config.get().rainMode).toBe("static");
    const render = vi.fn();
    const manager = new RainAnimationManager(config, { requestRender: render });
    manager.start(resolveRainRuntimeProfile(config.get(), "idle"));
    expect(manager.getSnapshot().stars.length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(render).not.toHaveBeenCalled();
    config.set("rainMode", "manual");
    manager.applyProfile(resolveRainRuntimeProfile(config.get(), "idle"));
    vi.advanceTimersByTime(130);
    expect(render).toHaveBeenCalledOnce();
    config.set("rainMode", "static");
    manager.applyProfile(resolveRainRuntimeProfile(config.get(), "idle"));
    const snapshot = manager.getSnapshot();
    vi.advanceTimersByTime(5000);
    expect(manager.getSnapshot()).toEqual(snapshot);
    expect(vi.getTimerCount()).toBe(0);
    manager.stop();
  });

  it("reverses an unfinished density change from the currently visible rain level", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const config = makeConfig({ rainRows: 1 });
    const manager = new RainAnimationManager(config, { requestRender: vi.fn() });
    manager.start(densityProfile(config, "thinking"));
    vi.advanceTimersByTime(1300);
    manager.applyProfile(densityProfile(config, "tools"));
    vi.advanceTimersByTime(130);
    const before = manager.getSnapshot();
    expect(before.drops.length).toBeGreaterThan(5);
    expect(before.drops.length).toBeLessThan(35);

    manager.applyProfile(densityProfile(config, "waiting"));
    expect(manager.getSnapshot()).toEqual(before);
    const counts: number[] = [];
    for (let frame = 0; frame < 14; frame++) {
      vi.advanceTimersByTime(130);
      counts.push(manager.getSnapshot().drops.length);
    }
    expect(counts[0]).toBeGreaterThan(counts.at(-1)!);
    expect(counts.at(-1)).toBeLessThanOrEqual(5);
    manager.stop();
  });

  it("reaches the density target after a wall-clock pause without advancing missed rain steps", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const config = makeConfig({ rainRows: 10 });
    const manager = new RainAnimationManager(config, { requestRender: vi.fn() });
    manager.start(densityProfile(config, "thinking"));
    vi.advanceTimersByTime(130);
    const revision = manager.frameRevision;
    const before = manager.getSnapshot();
    manager.applyProfile(densityProfile(config, "tools"));

    vi.setSystemTime(Date.now() + 5000);
    vi.advanceTimersByTime(130);
    const drops = manager.getSnapshot().drops;
    expect(drops.length).toBeGreaterThan(before.drops.length);
    expect(drops.length).toBeLessThanOrEqual(35);
    expect(drops[0].row - before.drops[0].row).toBeLessThanOrEqual(before.drops[0].speed! * 0.18 + 0.001);
    expect(manager.frameRevision).toBe(revision + 1);
    manager.stop();
  });

  it("applies manual density immediately and freezes an unfinished transition in static mode", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const config = makeConfig({ rainRows: 1 });
    const manager = new RainAnimationManager(config, { requestRender: vi.fn() });
    manager.start(densityProfile(config, "idle"));
    manager.applyProfile(densityProfile(config, "tools"));
    vi.advanceTimersByTime(130);

    config.set("rainMode", "manual");
    config.set("maxRainDrops", 50);
    manager.applyProfile(densityProfile(config, "idle"));
    // Manual density uses the configured target as new drops enter the scene.
    vi.advanceTimersByTime(520);
    expect(manager.getSnapshot().drops.length).toBeGreaterThan(35);
    expect(manager.getSnapshot().drops.length).toBeLessThanOrEqual(50);

    config.set("rainMode", "auto");
    manager.applyProfile(densityProfile(config, "idle"));
    vi.advanceTimersByTime(130);
    config.set("rainMode", "static");
    manager.applyProfile(densityProfile(config, "idle"));
    const frozen = manager.getSnapshot();
    vi.advanceTimersByTime(5000);
    expect(manager.getSnapshot()).toEqual(frozen);
    expect(vi.getTimerCount()).toBe(0);

    config.set("rainMode", "manual");
    config.set("rainTickMs", 50);
    config.set("maxRainDrops", 5);
    manager.applyProfile(densityProfile(config, "idle"));
    vi.advanceTimersByTime(1600);
    expect(manager.getSnapshot().drops.length).toBeLessThanOrEqual(5);
    expect(vi.getTimerCount()).toBe(1);
    manager.stop();
  });

  it("start() creates a timer using rainTickMs and triggers one tick per interval", () => {
    const config = makeConfig({ rainTickMs: 130 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    expect(mgr.isRunning).toBe(true);

    // Advance exactly one tick — callback should fire once.
    vi.advanceTimersByTime(130);
    expect(requestRender).toHaveBeenCalledTimes(1);

    // Advance another tick — total should be 2.
    vi.advanceTimersByTime(130);
    expect(requestRender).toHaveBeenCalledTimes(2);

    mgr.stop();
  });

  // ── 2. One tick advances state AND calls no-arg render callback exactly once ─

  it("one tick advances animation state and calls requestRender exactly once", () => {
    // Use a deterministic Math.random so spawn is predictable.
    vi.spyOn(Math, "random").mockReturnValue(0.4); // < 0.5 → baseSpawn=3

    const config = makeConfig({ rainTickMs: 200, maxRainDrops: 25, rainRows: 3 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    const snapshotBefore = mgr.getSnapshot();

    vi.advanceTimersByTime(200);

    expect(requestRender).toHaveBeenCalledTimes(1);

    // After one tick, drops should have been spawned (started from []).
    const snapshotAfter = mgr.getSnapshot();
    expect(snapshotAfter.drops.length).toBeGreaterThan(snapshotBefore.drops.length);

    mgr.stop();
  });

  it("applies a new runtime profile without clearing or stalling the visible rain", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const config = makeConfig({ rainTickMs: 100, rainRows: 10 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start({ tickMs: 100, maxDrops: 25 });
    vi.advanceTimersByTime(100);
    const before = mgr.getSnapshot();
    expect(before.drops.length).toBeGreaterThan(0);

    mgr.applyProfile({ tickMs: 200, maxDrops: 10 });

    expect(mgr.getSnapshot()).toEqual(before);
    requestRender.mockClear();
    // The already scheduled tick is allowed to complete, so changing speed
    // cannot postpone animation indefinitely.
    vi.advanceTimersByTime(100);
    expect(requestRender).toHaveBeenCalledOnce();
    requestRender.mockClear();
    vi.advanceTimersByTime(199);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestRender).toHaveBeenCalledOnce();
    mgr.stop();
  });

  it("cancels a pending cadence when the latest profile returns to the scheduled speed", () => {
    const config = makeConfig({ rainRows: 10 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start({ tickMs: 130, maxDrops: 25 });
    mgr.applyProfile({ tickMs: 110, maxDrops: 35 });
    mgr.applyProfile({ tickMs: 130, maxDrops: 25 });
    vi.advanceTimersByTime(130);
    requestRender.mockClear();

    vi.advanceTimersByTime(129);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestRender).toHaveBeenCalledOnce();
    mgr.stop();
  });

  it("keeps advancing when profiles toggle faster than either cadence", () => {
    const config = makeConfig({ rainRows: 10 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start({ tickMs: 130, maxDrops: 25 });
    for (let elapsed = 0; elapsed < 1_000; elapsed += 100) {
      vi.advanceTimersByTime(100);
      mgr.applyProfile(elapsed % 200 === 0
        ? { tickMs: 110, maxDrops: 35 }
        : { tickMs: 130, maxDrops: 25 });
    }

    expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(vi.getTimerCount()).toBe(1);
    mgr.stop();
  });

  it("does not replace the timer when only density changes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const config = makeConfig({ rainRows: 20 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start({ tickMs: 100, maxDrops: 25 });
    vi.advanceTimersByTime(100);
    const before = mgr.getSnapshot();
    mgr.applyProfile({ tickMs: 100, maxDrops: 10 });

    expect(mgr.getSnapshot()).toEqual(before);
    requestRender.mockClear();
    vi.advanceTimersByTime(100);
    expect(requestRender).toHaveBeenCalledOnce();
    mgr.stop();
  });

  // ── 3. stop() prevents further callback invocations ───────────────────────

  it("stop() halts the timer — subsequent advances do not call requestRender", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    vi.advanceTimersByTime(100); // one tick
    expect(requestRender).toHaveBeenCalledTimes(1);

    mgr.stop();
    expect(mgr.isRunning).toBe(false);

    vi.advanceTimersByTime(500); // several more intervals
    expect(requestRender).toHaveBeenCalledTimes(1); // still just 1
  });

  // ── 4. Repeated start() does not produce multiple timers ──────────────────

  it("calling start() twice does not create multiple timers", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    mgr.start(); // second call must not add a second interval

    vi.advanceTimersByTime(100); // one interval period
    expect(requestRender).toHaveBeenCalledTimes(1); // exactly once, not twice

    mgr.stop();
  });

  // ── 5. Changing rainTickMs then stop()+start() uses the new interval ───────

  it("stop()+start() after mutating rainTickMs picks up the new interval", () => {
    const config = makeConfig({ rainTickMs: 200 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    vi.advanceTimersByTime(200);
    expect(requestRender).toHaveBeenCalledTimes(1);

    mgr.stop();

    // Change the tick interval.
    config.set("rainTickMs", 500);

    mgr.start();

    // Old interval (200 ms) must NOT fire.
    vi.advanceTimersByTime(200);
    expect(requestRender).toHaveBeenCalledTimes(1); // still 1

    // New interval (500 ms) fires.
    vi.advanceTimersByTime(300); // total 500 ms since last start()
    expect(requestRender).toHaveBeenCalledTimes(2);

    mgr.stop();
  });

  // ── 6. setRenderWidth affects spawn range and clipping ────────────────────

  it("setRenderWidth(newWidth) removes a real drop beyond newWidth+4 on the next tick", () => {
    // Start at the manager's initial width (80), then place real drops near
    // the far edge before shrinking the render width.
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const config = makeConfig({
      rainTickMs: 100,
      rainRows: 10,
      maxRainDrops: 2,
    });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    vi.advanceTimersByTime(100);

    const beforeResize = mgr.getSnapshot();
    const farDrop = beforeResize.drops[0];
    expect(farDrop).toBeDefined();
    expect(farDrop.col).toBeGreaterThan(5 + 4);

    mgr.setRenderWidth(5);
    vi.advanceTimersByTime(100);

    const afterResize = mgr.getSnapshot();
    // The original row-0 drop would be at (farDrop.col, 1) if it survived;
    // its col is beyond the real clipping boundary and must be gone.
    expect(afterResize.drops).not.toContainEqual({
      col: farDrop.col,
      row: farDrop.row + 1,
    });
    for (const drop of afterResize.drops) {
      expect(drop.col).toBeLessThan(5 + 4);
    }

    mgr.stop();
  });

  it.each([4, 10])("keeps every surviving drop moving downwind to the right throughout a %i-row scene", (rainRows) => {
    let seed = 12345;
    vi.spyOn(Math, "random").mockImplementation(() => {
      seed = Math.imul(seed, 1664525) + 1013904223 | 0;
      return (seed >>> 0) / 4294967296;
    });
    const manager = new RainAnimationManager(
      makeConfig({ rainRows, rainTickMs: 50, maxRainDrops: 25 }), { requestRender: vi.fn() },
    );
    manager.start();
    manager.setRenderWidth(100, rainRows);
    let previous = manager.getSnapshot();
    const strengths = new Set<number>();
    let compared = 0;
    for (let tick = 0; tick < 400; tick++) {
      vi.advanceTimersByTime(50);
      const frame = manager.getSnapshot();
      expect(frame.wind).toBeGreaterThanOrEqual(0.2);
      strengths.add(Math.round(frame.wind! * 100));
      for (const drop of previous.drops) {
        const next = frame.drops.find((point) => point.depth === drop.depth && point.speed === drop.speed);
        if (!next) continue;
        expect(next.col).toBeGreaterThan(drop.col);
        expect(next.row).toBeGreaterThan(drop.row);
        compared++;
      }
      previous = frame;
    }
    expect(compared).toBeGreaterThan(100);
    expect(strengths.size).toBeGreaterThan(10);
    manager.stop();
  });

  it("advances drops continuously with a shared wind instead of jumping on alternating rows", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);

    const config = makeConfig({
      rainTickMs: 100,
      rainRows: 10,
      maxRainDrops: 1,
    });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    vi.advanceTimersByTime(100);
    const first = mgr.getSnapshot().drops[0];
    expect(first).toBeDefined();

    vi.advanceTimersByTime(100);
    const second = mgr.getSnapshot().drops[0];
    expect(second.row - first.row).toBeCloseTo(first.speed! * 0.1);
    expect(second.col).toBeGreaterThan(first.col);

    vi.advanceTimersByTime(100);
    const third = mgr.getSnapshot().drops[0];
    expect(third.row - second.row).toBeCloseTo(first.speed! * 0.1);
    expect(third.col).toBeGreaterThan(second.col);

    mgr.stop();
  });

  it("setRenderWidth limits spawn col range to the new width", () => {
    // We'll use a concrete random value that would place drops beyond a small width
    // if lastWidth were still 80, but within bounds for the new width.
    // col = floor(random * lastWidth * 0.9) - 2
    // With lastWidth=10 and random=0.5: floor(0.5 * 10 * 0.9) - 2 = floor(4.5) - 2 = 2
    // With lastWidth=80 and random=0.5: floor(0.5 * 80 * 0.9) - 2 = floor(36) - 2 = 34
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const config = makeConfig({
      rainTickMs: 100,
      rainRows: 10,
      maxRainDrops: 25,
    });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    // start() resets lastWidth to 80; call setRenderWidth AFTER start().
    mgr.start();
    mgr.setRenderWidth(10);

    // Advance one tick to spawn drops.
    vi.advanceTimersByTime(100);

    const snapshot = mgr.getSnapshot();
    // With lastWidth=10: spawn col = floor(0.5*10*0.9)-2 = 2.
    // All spawned drops should be well within the 10+4=14 clip boundary.
    for (const drop of snapshot.drops) {
      expect(drop.col).toBeLessThan(14);
    }

    mgr.stop();
  });

  // ── 7a. Stale-context error from callback is swallowed ────────────────────

  it("stale extension context error thrown by requestRender is silently ignored", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const consoleErrorSpy = vi.spyOn(console, "error");

    const staleError = new Error("This extension instance is stale");
    const requestRender = vi.fn().mockImplementation(() => {
      throw staleError;
    });
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();

    // Must not throw, must stop the stale timer, and must not call console.error.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(mgr.isRunning).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // ── 7b. Non-stale error is logged via console.error ───────────────────────

  it("non-stale render failures stop retries after a bounded number of attempts", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const consoleErrorSpy = vi.spyOn(console, "error");

    const genericError = new Error("Something went wrong");
    const requestRender = vi.fn().mockImplementation(() => {
      throw genericError;
    });
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(requestRender).toHaveBeenCalledTimes(3);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(3);
    expect(mgr.isRunning).toBe(false);
    // First arg must include the EXT_PREFIX.
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("[pi-tokyo-night]");
  });

  it("resets the failure streak after a successful render request", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const consoleErrorSpy = vi.spyOn(console, "error");
    const requestRender = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("temporary failure 1");
      })
      .mockImplementationOnce(() => {
        throw new Error("temporary failure 2");
      });
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    vi.advanceTimersByTime(400);

    expect(requestRender).toHaveBeenCalledTimes(4);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    expect(mgr.isRunning).toBe(true);
    mgr.stop();
  });

  it("can render again after restarting following repeated failures", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const requestRender = vi.fn().mockImplementation(() => {
      throw new Error("persistent failure");
    });
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    vi.advanceTimersByTime(300);
    expect(mgr.isRunning).toBe(false);

    requestRender.mockImplementation(() => undefined);
    mgr.start();
    vi.advanceTimersByTime(100);

    expect(requestRender).toHaveBeenCalledTimes(4);
    expect(mgr.isRunning).toBe(true);
    mgr.stop();
  });

  // ── 8. Mutating the snapshot does not affect manager internal state ────────

  it("mutating a snapshot object does not affect subsequent snapshots", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);

    const config = makeConfig({ rainTickMs: 100, rainRows: 5, maxRainDrops: 25 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    vi.advanceTimersByTime(100); // spawn some drops

    const snap1 = mgr.getSnapshot();
    const dropsBefore = snap1.drops.length;

    // Mutate the returned snapshot (TypeScript readonly only guards compile-time).
    (snap1 as unknown as { drops: Array<{ col: number; row: number }> }).drops.push({
      col: 999,
      row: 999,
    });
    if (snap1.drops.length > 0) {
      (snap1.drops[0] as { col: number; row: number }).col = -9999;
    }

    // Manager internals must be unaffected.
    const snap2 = mgr.getSnapshot();
    expect(snap2.drops.length).toBe(dropsBefore);
    for (const d of snap2.drops) {
      expect(d.col).not.toBe(-9999);
    }

    mgr.stop();
  });

  it("advances the public frame revision when animation state changes", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const mgr = new RainAnimationManager(config, { requestRender: vi.fn() });
    const initialRevision = mgr.frameRevision;

    mgr.start();
    const startedRevision = mgr.frameRevision;
    vi.advanceTimersByTime(100);

    expect(startedRevision).toBeGreaterThan(initialRevision);
    expect(mgr.frameRevision).toBeGreaterThan(startedRevision);
    mgr.stop();
  });

  // ── Additional: isRunning reflects timer state ────────────────────────────

  it("isRunning is false before start and true after start, false after stop", () => {
    const config = makeConfig();
    const mgr = new RainAnimationManager(config, { requestRender: vi.fn() });

    expect(mgr.isRunning).toBe(false);
    mgr.start();
    expect(mgr.isRunning).toBe(true);
    mgr.stop();
    expect(mgr.isRunning).toBe(false);
  });

  // Extension-level session_shutdown is intentionally not mocked here: the
  // composition root owns module-scoped state and the SDK session callback
  // shape would make such a test implementation-coupled. The manager's public
  // stop() contract is covered above and below instead.

  it("stop() before the first tick prevents any later requestRender", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();
    mgr.stop();
    vi.advanceTimersByTime(500);

    expect(requestRender).not.toHaveBeenCalled();
    expect(mgr.isRunning).toBe(false);
  });

  // ── Additional: stop() is safe to call repeatedly ─────────────────────────

  it("stop() is idempotent — multiple calls do not throw", () => {
    const config = makeConfig();
    const mgr = new RainAnimationManager(config, { requestRender: vi.fn() });

    mgr.start();
    expect(() => {
      mgr.stop();
      mgr.stop();
      mgr.stop();
    }).not.toThrow();
    expect(mgr.isRunning).toBe(false);
  });

  it("starts stars beyond their fade-in so the first frame already has visible stars", () => {
    const config = makeConfig();
    const mgr = new RainAnimationManager(config, { requestRender: vi.fn() });

    mgr.start();
    const snap = mgr.getSnapshot();
    expect(snap.stars.length).toBeGreaterThan(0);
    expect(snap.stars.every((star) => star.age! >= 0.7 && star.age! < star.life!)).toBe(true);
    expect(snap.stars.every((star) => star.period! >= 5 && star.period! <= 7)).toBe(true);
    mgr.stop();
  });

  // ── Slice 3 scenario 4: maxRainDrops live read per tick ───────────────────
  // After start(), mutating config.maxRainDrops to a larger value allows
  // subsequent ticks to exceed the old cap — proves tick() reads live.

  it("mutating maxRainDrops while running allows drop count to exceed the original cap", () => {
    // Force Math.random to always be < 0.5 (baseSpawn = 3 branch).
    vi.spyOn(Math, "random").mockReturnValue(0.3);

    const oldCap = 5;
    const newCap = 50;

    const config = makeConfig({
      rainTickMs: 100,
      maxRainDrops: oldCap,
      rainRows: 20,
    });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();

    // Advance enough ticks to saturate the OLD cap.
    // With baseSpawn=3, densityRatio=5/25=0.2, spawnCount=ceil(3*0.2)=1 per tick.
    // 5 ticks should fully fill oldCap=5 drops at row 0-4, then start filtering.
    // Let's run 20 ticks to be sure we're capped.
    vi.advanceTimersByTime(2000); // 20 ticks

    const snapAtOldCap = mgr.getSnapshot();
    // At old cap, count should not exceed oldCap.
    expect(snapAtOldCap.drops.length).toBeLessThanOrEqual(oldCap);

    // Now raise the cap live — tick() reads cfg.maxRainDrops each tick.
    config.set("maxRainDrops", newCap);

    // Advance many more ticks so the drop pool grows beyond oldCap.
    vi.advanceTimersByTime(3000); // 30 more ticks

    const snapAfterRaise = mgr.getSnapshot();
    // With newCap=50 and spawning per tick, drop count should now exceed oldCap.
    expect(snapAfterRaise.drops.length).toBeGreaterThan(oldCap);

    mgr.stop();
  });

  // ── Slice 3 scenario 5: rainTickMs NOT replaced before apply ─────────────
  // Mutating config.rainTickMs alone (without stop()+start()) does NOT change
  // the live interval — the interval captured at start() remains in effect.

  it("mutating rainTickMs alone (no stop/start) does NOT change the live interval", () => {
    const originalMs = 200;
    const newMs = 1000;

    const config = makeConfig({ rainTickMs: originalMs });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();

    // Mutate the tick interval in config WITHOUT restarting.
    config.set("rainTickMs", newMs);

    // Advancing by the OLD interval should still fire ticks.
    vi.advanceTimersByTime(originalMs);
    expect(requestRender).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(originalMs);
    expect(requestRender).toHaveBeenCalledTimes(2);

    // Advancing only the DELTA to reach the new interval from the last old-tick
    // boundary should NOT add an extra tick (the timer is still on the old cadence).
    // After 2 * originalMs elapsed, advancing by (newMs - 2*originalMs) should
    // NOT fire a third tick because the old 200 ms timer would have fired twice
    // already and a third tick is only at 3*200=600ms, not at newMs=1000ms.
    vi.advanceTimersByTime(newMs - 2 * originalMs); // advance to reach 1000ms mark
    // At 1000ms from start: oldMs fires at 200, 400, 600, 800, 1000 → 5 ticks total.
    // The point is: advancing by newMs worth of time from start fires MULTIPLE ticks
    // at the OLD cadence (every 200ms), NOT just one tick at newMs (1000ms).
    // The interval in effect is still the OLD one.
    const callsAt1000ms = requestRender.mock.calls.length;
    // 1000 / 200 = 5 ticks — much more than the 1 tick you'd see if the interval
    // had switched to newMs=1000 (which would fire only once at 1000ms).
    expect(callsAt1000ms).toBe(5);

    mgr.stop();
  });
});
