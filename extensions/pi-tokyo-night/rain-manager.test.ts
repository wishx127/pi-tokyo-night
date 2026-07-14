import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RainAnimationManager } from "./rain-manager";
import { TokyoConfigManager, DEFAULT_CONFIG } from "./config";

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

describe("RainAnimationManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── 1. start() creates ONE timer using the current rainTickMs ──────────────

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

  it("setRenderWidth(newWidth) clips drops that exceed newWidth after a tick", () => {
    // Fix random so every newly spawned drop lands near col=0 (negative formula).
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    // With random=0: col = floor(0 * lastWidth * 0.9) - 2 = -2, row: 0
    // baseSpawn: random<0.5 → 3

    const config = makeConfig({
      rainTickMs: 100,
      rainRows: 10,
      maxRainDrops: 25,
    });
    const requestRender = vi.fn();
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();

    // Set a very small width. The clip condition is col < lastWidth + 4.
    mgr.setRenderWidth(5);

    // Advance several ticks so any drops beyond width+4 are filtered.
    vi.advanceTimersByTime(1000); // 10 ticks

    const snapshot = mgr.getSnapshot();
    // All surviving drops must satisfy col < 5 + 4 = 9
    for (const drop of snapshot.drops) {
      expect(drop.col).toBeLessThan(9);
    }

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

    // Must not throw, and must not call console.error.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    mgr.stop();
  });

  // ── 7b. Non-stale error is logged via console.error ───────────────────────

  it("non-stale error from requestRender is logged via console.error", () => {
    const config = makeConfig({ rainTickMs: 100 });
    const consoleErrorSpy = vi.spyOn(console, "error");

    const genericError = new Error("Something went wrong");
    const requestRender = vi.fn().mockImplementation(() => {
      throw genericError;
    });
    const mgr = new RainAnimationManager(config, { requestRender });

    mgr.start();

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    // First arg must include the EXT_PREFIX.
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("[pi-tokyo-night]");

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

  // ── Additional: stars initial coords are preserved after start ────────────

  it("start() resets stars to initial coords [{col:5,row:1},{col:8,row:0}]", () => {
    const config = makeConfig();
    const mgr = new RainAnimationManager(config, { requestRender: vi.fn() });

    mgr.start();
    const snap = mgr.getSnapshot();
    expect(snap.stars).toEqual([
      { col: 5, row: 1 },
      { col: 8, row: 0 },
    ]);
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
