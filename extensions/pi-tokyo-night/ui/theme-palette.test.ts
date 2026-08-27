import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createTokyoNightPalette } from "./theme-palette";

function makeTheme(): Theme {
  return {
    fg: (color: string, text: string) => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
  } as unknown as Theme;
}

describe("Tokyo Night theme palette", () => {
  it("derives extension foreground roles from the active Theme", () => {
    const palette = createTokyoNightPalette(makeTheme());

    expect(palette.fg("rain", "`")).toBe(
      "<fg:thinkingLow>`</fg:thinkingLow>",
    );
    expect(palette.fg("star", "✦")).toBe(
      "<fg:accent>✦</fg:accent>",
    );
    expect(palette.fg("moon", "🌙")).toBe(
      "<fg:warning>🌙</fg:warning>",
    );
    expect(palette.fg("prompt", "❯")).toBe(
      "<fg:accent>❯</fg:accent>",
    );
    expect(palette.fg("workingCyan", "⠋")).toBe(
      "<fg:thinkingLow>⠋</fg:thinkingLow>",
    );
    expect(palette.fg("workingPurple", "⠙")).toBe(
      "<fg:thinkingMedium>⠙</fg:thinkingMedium>",
    );
    expect(palette.fg("frame", "─")).toBe(
      "\x1b[38;2;61;53;119m─\x1b[39m",
    );
    expect(palette.fg("statusModel", "model")).toBe(
      "\x1b[38;2;200;200;255mmodel\x1b[39m",
    );
  });

  it("keeps the original Tokyo Night status chrome palette", () => {
    const palette = createTokyoNightPalette(makeTheme());

    expect(palette.bg("model", "model")).toBe(
      "\x1b[48;2;45;27;105mmodel\x1b[49m",
    );
    expect(palette.bg("tokens", "tokens")).toBe(
      "\x1b[48;2;109;91;170mtokens\x1b[49m",
    );
    expect(palette.fg("statusTokens", "tokens")).toBe(
      "\x1b[38;2;255;255;200mtokens\x1b[39m",
    );
    expect(palette.transition("model", "thinking", "")).toBe(
      "\x1b[48;2;61;43;122m\x1b[38;2;45;27;105m\x1b[49m\x1b[39m",
    );
  });
});
