import { describe, expect, it } from "vitest";
import type { TokyoNightThemePalette } from "./theme-palette";
import { renderWorkingText } from "./working-shimmer";

const palette = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  workingPulse: (text: string, intensity: number) =>
    `<pulse:${intensity.toFixed(2)}>${text}</pulse>`,
} as TokyoNightThemePalette;

describe("renderWorkingText", () => {
  it("sweeps a three-column highlight from right to left while thinking", () => {
    expect(renderWorkingText("Thinking", "reverse", 2_800, palette)).toBe(
      "<workingText>Thi</workingText><workingTextShimmer>nki</workingTextShimmer><workingText>ng</workingText>",
    );
  });

  it("positions the highlight by terminal columns without splitting wide text", () => {
    expect(renderWorkingText("A界B", "reverse", 2_400, palette)).toBe(
      "<workingText>A</workingText><workingTextShimmer>界B</workingTextShimmer>",
    );
  });

  it("sweeps quickly from left to right while waiting for a response", () => {
    expect(renderWorkingText("Waiting", "forward", 600, palette)).toBe(
      "<workingText>W</workingText><workingTextShimmer>ait</workingTextShimmer><workingText>ing</workingText>",
    );
  });

  it("pulses the full tool label", () => {
    expect(renderWorkingText("Using tools · read", "pulse", 500, palette)).toBe(
      "<pulse:1.00>Using tools · read</pulse>",
    );
    expect(renderWorkingText("Using tools · read", "pulse", 1_500, palette)).toBe(
      "<pulse:0.00>Using tools · read</pulse>",
    );
    expect(renderWorkingText("Using tools · read", "pulse", 100, palette)).toBe(
      "<pulse:0.63>Using tools · read</pulse>",
    );
  });
});
