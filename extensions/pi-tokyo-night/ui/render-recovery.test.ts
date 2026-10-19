import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderRecoveryCoordinator } from "./render-recovery";

afterEach(() => vi.useRealTimers());

describe("RenderRecoveryCoordinator", () => {
  it("pauses cosmetic updates while unfocused and repaints once after focus settles", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => ({ columns: 80, rows: 24 }),
      pause: () => calls.push("pause"),
      recover: () => calls.push("recover"),
      resume: () => calls.push("resume"),
    });

    expect(calls).toEqual([]);
    recovery.setFocused(false);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual(["pause"]);

    recovery.setFocused(true);
    vi.advanceTimersByTime(199);
    expect(calls).toEqual(["pause"]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["pause", "recover", "resume"]);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual(["pause", "recover", "resume"]);
  });

  it("coalesces a resize round trip even when the final size matches the original", () => {
    vi.useFakeTimers();
    let dimensions = { columns: 80, rows: 24 };
    const calls: string[] = [];
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => dimensions,
      pause: () => calls.push("pause"),
      recover: () => calls.push("recover"),
      resume: () => calls.push("resume"),
    });

    recovery.resized();
    vi.advanceTimersByTime(100);
    dimensions = { columns: 42, rows: 14 };
    recovery.resized();
    vi.advanceTimersByTime(100);
    dimensions = { columns: 80, rows: 24 };
    recovery.resized();
    vi.advanceTimersByTime(199);
    expect(calls).toEqual(["pause"]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["pause", "recover", "resume"]);
  });

  it("waits for matching dimension samples when the backend changes without another event", () => {
    vi.useFakeTimers();
    const dimensions = { columns: 80, rows: 24 };
    const recover = vi.fn();
    const resume = vi.fn();
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => dimensions,
      pause() {},
      recover,
      resume,
    }, { settleMs: 50 });

    recovery.resized();
    vi.advanceTimersByTime(25);
    dimensions.columns = 42;
    vi.advanceTimersByTime(25);
    expect(recover).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(49);
    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("recovers when unavailable dimensions return silently during the bounded probe window", () => {
    vi.useFakeTimers();
    let dimensions = { columns: 0, rows: 0 };
    const recover = vi.fn();
    const resume = vi.fn();
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => dimensions,
      pause() {},
      recover,
      resume,
    });

    recovery.resized();
    vi.advanceTimersByTime(100);
    dimensions = { columns: 80, rows: 24 };
    vi.advanceTimersByTime(299);
    expect(recover).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers after a terminal restart even if focus-in happened while input was stopped", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => ({ columns: 80, rows: 24 }),
      pause: () => calls.push("pause"),
      recover: () => calls.push("recover"),
      resume: () => calls.push("resume"),
    });

    recovery.setActive(true);
    expect(calls).toEqual([]);
    recovery.setFocused(false);
    recovery.setActive(false);
    recovery.resized();
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual(["pause"]);
    recovery.setActive(true);
    vi.advanceTimersByTime(200);
    expect(calls).toEqual(["pause", "recover", "resume"]);
  });

  it("cancels pending recovery and ignores further terminal events after disposal", () => {
    vi.useFakeTimers();
    const getDimensions = vi.fn(() => ({ columns: 80, rows: 24 }));
    const pause = vi.fn();
    const recover = vi.fn();
    const resume = vi.fn();
    const recovery = new RenderRecoveryCoordinator({ getDimensions, pause, recover, resume });

    recovery.resized();
    recovery.dispose();
    recovery.setFocused(false);
    recovery.setFocused(true);
    recovery.setActive(false);
    recovery.setActive(true);
    recovery.resized();
    vi.advanceTimersByTime(1000);

    expect(getDimensions).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { columns: 0, rows: 24 },
    { columns: 80, rows: 0 },
    { columns: Number.NaN, rows: 24 },
    { columns: 80, rows: Number.POSITIVE_INFINITY },
  ])("bounds invalid dimension probes and waits for another event after exhausting them: %j", (invalidDimensions) => {
    vi.useFakeTimers();
    let dimensions = invalidDimensions;
    const recover = vi.fn();
    const resume = vi.fn();
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => dimensions,
      pause() {},
      recover,
      resume,
    });

    recovery.resized();
    vi.advanceTimersByTime(599);
    expect(recover).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resume).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    expect(recover).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    dimensions = { columns: 80, rows: 24 };
    recovery.resized();
    vi.advanceTimersByTime(200);
    expect(recover).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("resumes after repaint failure and remains usable even if error reporting throws", () => {
    vi.useFakeTimers();
    const failure = new Error("terminal write failed");
    const recover = vi.fn().mockImplementationOnce(() => { throw failure; });
    const resume = vi.fn();
    const onError = vi.fn(() => { throw new Error("reporting failed"); });
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => ({ columns: 80, rows: 24 }),
      pause() {},
      recover,
      resume,
      onError,
    });

    recovery.resized();
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(resume).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    recovery.resized();
    vi.advanceTimersByTime(200);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it.each(["pause", "getDimensions", "resume"] as const)("contains a %s callback failure without abandoning future recovery", (callback) => {
    vi.useFakeTimers();
    const failure = new Error(`${callback} failed`);
    const dependencies = {
      getDimensions: vi.fn(() => ({ columns: 80, rows: 24 })),
      pause: vi.fn(),
      recover: vi.fn(),
      resume: vi.fn(),
      onError: vi.fn(),
    };
    dependencies[callback].mockImplementationOnce(() => { throw failure; });
    const recovery = new RenderRecoveryCoordinator(dependencies);

    expect(() => recovery.resized()).not.toThrow();
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(dependencies.onError).toHaveBeenCalledWith(failure);
    expect(dependencies.resume).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    recovery.resized();
    vi.advanceTimersByTime(200);
    expect(dependencies.resume).toHaveBeenCalledTimes(2);
    expect(dependencies.recover).toHaveBeenCalled();
  });

  it("keeps a newer resize paused when repaint synchronously triggers another recovery cycle", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let recovery: RenderRecoveryCoordinator;
    const recover = vi.fn(() => { calls.push("recover"); });
    recover.mockImplementationOnce(() => {
      calls.push("recover");
      recovery.resized();
    });
    recovery = new RenderRecoveryCoordinator({
      getDimensions: () => ({ columns: 80, rows: 24 }),
      pause: () => calls.push("pause"),
      recover,
      resume: () => calls.push("resume"),
    });

    recovery.resized();
    vi.advanceTimersByTime(200);
    expect(calls).toEqual(["pause", "recover"]);
    vi.advanceTimersByTime(199);
    expect(calls).toEqual(["pause", "recover"]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["pause", "recover", "recover", "resume"]);
  });

  it("restarts the quiet period on repeated focus reports and cancels it on blur", () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    const resume = vi.fn();
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => ({ columns: 80, rows: 24 }),
      pause() {},
      recover,
      resume,
    });

    recovery.setFocused(true);
    vi.advanceTimersByTime(150);
    recovery.setFocused(true);
    vi.advanceTimersByTime(150);
    expect(recover).not.toHaveBeenCalled();
    recovery.setFocused(false);
    vi.advanceTimersByTime(1000);
    expect(recover).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    recovery.setFocused(true);
    vi.advanceTimersByTime(200);
    expect(recover).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("bounds probes if dimensions disappear during the quiet period", () => {
    vi.useFakeTimers();
    let dimensions = { columns: 80, rows: 24 };
    const recover = vi.fn();
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => dimensions,
      pause() {},
      recover,
      resume() {},
    });

    recovery.resized();
    dimensions = { columns: 0, rows: 0 };
    vi.advanceTimersByTime(1000);
    expect(recover).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    dimensions = { columns: 80, rows: 24 };
    recovery.resized();
    vi.advanceTimersByTime(200);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("requires two valid samples after dimensions disappear at a settling check", () => {
    vi.useFakeTimers();
    let dimensions = { columns: 80, rows: 24 };
    const recover = vi.fn();
    const recovery = new RenderRecoveryCoordinator({
      getDimensions: () => dimensions,
      pause() {},
      recover,
      resume() {},
    });

    recovery.resized();
    vi.advanceTimersByTime(100);
    dimensions = { columns: 0, rows: 0 };
    vi.advanceTimersByTime(200);
    dimensions = { columns: 80, rows: 24 };
    vi.advanceTimersByTime(299);
    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pause", "getDimensions", "recover"] as const)("does not continue if %s disposes the coordinator", (callback) => {
    vi.useFakeTimers();
    const dependencies = {
      getDimensions: vi.fn(() => ({ columns: 80, rows: 24 })),
      pause: vi.fn(),
      recover: vi.fn(),
      resume: vi.fn(),
    };
    const recovery = new RenderRecoveryCoordinator(dependencies);
    dependencies[callback].mockImplementationOnce(() => {
      recovery.dispose();
      return { columns: 80, rows: 24 };
    });

    recovery.resized();
    vi.advanceTimersByTime(1000);
    expect(dependencies.resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (callback !== "recover") expect(dependencies.recover).not.toHaveBeenCalled();
  });
});
