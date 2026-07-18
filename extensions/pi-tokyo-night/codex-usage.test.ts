import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexUsageStore,
  formatStatus,
} from "./codex-usage";

describe("Codex usage store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps snapshots isolated and counts down from capture time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));

    const first = createCodexUsageStore();
    const second = createCodexUsageStore();
    const headers = {
      "x-codex-primary-used-percent": "10",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-after-seconds": "180",
    };

    expect(first.captureFromHeaders(headers)).toBe(true);
    expect(second.getSnapshot()).toBeUndefined();
    expect(formatStatus(first.getSnapshot()!)).toContain("(3m)");

    vi.advanceTimersByTime(61_000);
    expect(formatStatus(first.getSnapshot()!)).toContain("(1m)");

    second.captureFromHeaders({
      ...headers,
      "x-codex-primary-reset-after-seconds": "120",
    });
    first.clearSnapshot();
    expect(first.getSnapshot()).toBeUndefined();
    expect(formatStatus(second.getSnapshot()!)).toContain("(2m)");

    vi.advanceTimersByTime(121_000);
    expect(formatStatus(second.getSnapshot()!)).toContain("(0m)");
  });
});
