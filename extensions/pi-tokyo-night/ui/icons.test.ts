import { describe, expect, it } from "vitest";
import {
  DEFAULT_ICON_MODE,
  isIconMode,
  resolveIcons,
} from "./icons";

describe("status bar icon modes", () => {
  it("uses Nerd Font glyphs by default", () => {
    expect(DEFAULT_ICON_MODE).toBe("nerd");
    expect(resolveIcons(DEFAULT_ICON_MODE)).toMatchObject({
      model: "\uE795",
      thinking: "⚡",
      path: "\uF07B",
      branch: "\uE0A0",
      transition: "\uE0B0",
      tokens: "Σ",
      gaugeFilled: "█",
      gaugeEmpty: "░",
    });
  });

  it("resolves an ASCII-only icon set", () => {
    const icons = resolveIcons("ascii");

    expect(icons).toMatchObject({
      model: "@",
      thinking: "",
      path: "~",
      branch: "*",
    });
    expect(icons.transition).toBe("\uE0B0");
    expect(icons.tokens).toBe("Σ");
    expect(icons.gaugeFilled).toBe("█");
    expect(icons.gaugeEmpty).toBe("░");
    expect(
      [icons.model, icons.thinking, icons.path, icons.branch]
        .every((value) => /^[\x00-\x7F]*$/.test(value)),
    ).toBe(true);
  });

  it("recognizes only the supported modes", () => {
    expect(isIconMode("nerd")).toBe(true);
    expect(isIconMode("ascii")).toBe(true);
    expect(isIconMode("auto")).toBe(false);
    expect(isIconMode(undefined)).toBe(false);
  });
});
