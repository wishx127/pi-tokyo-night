import { describe, expect, it, vi } from "vitest";
import { detectTerminalTheme } from "./terminal-theme";

describe("detectTerminalTheme", () => {
  it("prefers the terminal color-scheme protocol", async () => {
    const target = {
      queryTerminalColorScheme: vi.fn(async () => "light" as const),
      queryTerminalBackgroundColor: vi.fn(async () => ({ r: 0, g: 0, b: 0 })),
    };

    await expect(detectTerminalTheme(target, { timeoutMs: 100 })).resolves.toEqual({
      scheme: "light",
      source: "terminal-scheme",
    });
    expect(target.queryTerminalColorScheme).toHaveBeenCalledWith({ timeoutMs: 100 });
    expect(target.queryTerminalBackgroundColor).not.toHaveBeenCalled();
  });

  it("falls back to OSC 11 terminal background luminance", async () => {
    const target = {
      queryTerminalColorScheme: vi.fn(async () => undefined),
      queryTerminalBackgroundColor: vi.fn(async () => ({
        r: 232,
        g: 233,
        b: 239,
      })),
    };

    await expect(detectTerminalTheme(target, { timeoutMs: 80 })).resolves.toEqual({
      scheme: "light",
      source: "terminal-background",
    });
    expect(target.queryTerminalBackgroundColor).toHaveBeenCalledWith({ timeoutMs: 80 });
  });

  it.each([
    ["0;15", "light"],
    ["15;0", "dark"],
    ["0;16", "dark"],
    ["0;231", "light"],
    ["0;232", "dark"],
    ["0;255", "light"],
  ] as const)("uses COLORFGBG=%s when terminal queries are unavailable", async (value, scheme) => {
    const target = {
      queryTerminalColorScheme: vi.fn(async () => undefined),
      queryTerminalBackgroundColor: vi.fn(async () => undefined),
    };

    await expect(detectTerminalTheme(target, {
      timeoutMs: 50,
      env: { COLORFGBG: value },
    })).resolves.toEqual({
      scheme,
      source: "COLORFGBG",
    });
  });

  it("defaults to dark when terminal detection fails without an environment hint", async () => {
    const target = {
      queryTerminalColorScheme: vi.fn(async () => {
        throw new Error("scheme query failed");
      }),
      queryTerminalBackgroundColor: vi.fn(async () => {
        throw new Error("background query failed");
      }),
    };

    await expect(detectTerminalTheme(target, {
      timeoutMs: 50,
      env: {},
    })).resolves.toEqual({
      scheme: "dark",
      source: "fallback",
    });
  });
});
