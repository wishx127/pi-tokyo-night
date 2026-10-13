import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshScheduler } from "./refresh-scheduler";

afterEach(() => vi.useRealTimers());

describe("RefreshScheduler", () => {
  it("keeps the rain's average cadence when host stream frames arrive every 100ms", () => {
    vi.useFakeTimers();
    const scheduler = new RefreshScheduler(() => {});
    let rainFrames = 0;
    scheduler.repeat(130, () => { rainFrames++; scheduler.requestRender(); });
    scheduler.hostWillRender();
    for (let chunk = 0; chunk < 10; chunk++) {
      vi.advanceTimersByTime(100);
      scheduler.hostWillRender();
    }
    expect(rainFrames).toBe(7);
    scheduler.dispose();
  });

  it("publishes animation state on the existing host frame without a later redraw", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const scheduler = new RefreshScheduler(publish);
    scheduler.repeat(100, () => scheduler.requestRender());
    scheduler.requestRender();
    vi.advanceTimersByTime(37);
    scheduler.hostWillRender();
    expect(publish).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(99);
    expect(publish).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenLastCalledWith(true);
    scheduler.dispose();
  });

  it("honors a manual 50ms cadence without replaying missed frames", () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduler = new RefreshScheduler(render);
    scheduler.setFrameInterval(50);
    scheduler.repeat(50, () => scheduler.requestRender());
    vi.advanceTimersByTime(1000);
    expect(render).toHaveBeenCalledTimes(20);
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(50);
    expect(render).toHaveBeenCalledTimes(21);
    scheduler.dispose();
  });

  it("uses streaming host frames and resumes animation within one frame interval of a pause", () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduler = new RefreshScheduler((requestHost) => { if (requestHost) render(); });
    let phase = 0;
    scheduler.repeat(100, () => { phase++; scheduler.requestRender(); });
    for (let chunk = 0; chunk < 50; chunk++) {
      scheduler.requestRender();
      scheduler.hostWillRender();
      vi.advanceTimersByTime(20);
    }
    expect(phase).toBe(9);
    expect(render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(phase).toBe(10);
    expect(render).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("publishes a phase immediately without postponing the rain clock", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const scheduler = new RefreshScheduler(publish);
    let rainFrames = 0;
    scheduler.repeat(130, () => { rainFrames++; scheduler.requestRender(); });
    vi.advanceTimersByTime(37);
    scheduler.requestRender();
    scheduler.flushNow();
    expect(publish).toHaveBeenCalledExactlyOnceWith(true);
    vi.advanceTimersByTime(93);
    expect(rainFrames).toBe(1);
    expect(publish).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("combines due animation and status updates into one host frame", () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduler = new RefreshScheduler(render);
    let working = 0;
    let rain = 0;
    scheduler.repeat(100, () => { working++; scheduler.requestRender(); });
    scheduler.repeat(100, () => { rain++; scheduler.requestRender(); });
    scheduler.requestRender();
    vi.advanceTimersByTime(100);
    expect([working, rain, render.mock.calls.length]).toEqual([1, 1, 1]);
    scheduler.dispose();
    vi.advanceTimersByTime(1000);
    expect(render).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
