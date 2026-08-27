import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createTokyoNightPalette } from "./ui/theme-palette";

type ThemeValue = string | number;
type ThemeSection = Record<string, ThemeValue>;
type ThemeDocument = {
  name?: unknown;
  vars?: ThemeSection;
  colors?: ThemeSection;
  export?: ThemeSection;
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const THEME_FILES = {
  dark: "tokyo-night-dark.json",
  light: "tokyo-night-light.json",
} as const;
const SECTION_NAMES = ["vars", "colors", "export"] as const;
const REQUIRED_COLOR_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const;

type SectionName = (typeof SECTION_NAMES)[number];

function readTheme(fileName: string): ThemeDocument {
  const filePath = fileURLToPath(new URL(`../../themes/${fileName}`, import.meta.url));
  return JSON.parse(readFileSync(filePath, "utf8")) as ThemeDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSection(
  theme: ThemeDocument,
  sectionName: SectionName,
): ThemeSection | undefined {
  const section = theme[sectionName];
  if (section === undefined) return undefined;
  expect(isRecord(section), `${sectionName} must be an object`).toBe(true);
  return section as ThemeSection;
}

function isLiteralColor(value: unknown): boolean {
  return (
    value === "" ||
    (typeof value === "string" && HEX_COLOR.test(value)) ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
  );
}

function assertResolvableColor(
  value: unknown,
  vars: ThemeSection,
  location: string,
  resolving = new Set<string>(),
): void {
  if (isLiteralColor(value)) return;

  expect(typeof value, `${location} must be a hex color, ANSI index, default color, or variable reference`).toBe("string");
  const reference = value as string;
  expect(Object.hasOwn(vars, reference), `${location} references missing variable '${reference}'`).toBe(true);
  expect(resolving.has(reference), `${location} contains a cyclic variable reference`).toBe(false);

  const nextResolving = new Set(resolving);
  nextResolving.add(reference);
  assertResolvableColor(vars[reference], vars, `${location} -> vars.${reference}`, nextResolving);
}

function readAnsiRgb(value: string, channel: "38" | "48"): string {
  const match = value.match(
    new RegExp(`\\x1b\\[${channel};2;(\\d+);(\\d+);(\\d+)m`),
  );
  expect(match, `missing RGB ${channel} ANSI code`).not.toBeNull();
  return `#${[match![1], match![2], match![3]]
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
}

function resolveHexColor(value: ThemeValue, vars: ThemeSection): string {
  if (typeof value === "string" && HEX_COLOR.test(value)) {
    return value.toLowerCase();
  }
  if (typeof value === "string" && Object.hasOwn(vars, value)) {
    return resolveHexColor(vars[value], vars);
  }
  throw new Error(`Expected a resolvable hex color, received '${String(value)}'`);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme contract", () => {
  const dark = readTheme(THEME_FILES.dark);
  const light = readTheme(THEME_FILES.light);

  it("keeps dark and light token sets aligned", () => {
    for (const sectionName of SECTION_NAMES) {
      const darkSection = getSection(dark, sectionName);
      const lightSection = getSection(light, sectionName);

      if (sectionName === "colors") {
        expect(darkSection, "dark theme must define colors").toBeDefined();
        expect(lightSection, "light theme must define colors").toBeDefined();
      }

      if (darkSection && lightSection) {
        expect(Object.keys(lightSection).sort(), `${sectionName} token keys differ`).toEqual(
          Object.keys(darkSection).sort(),
        );
      }
    }
  });

  it("defines the required Pi color tokens in both themes", () => {
    for (const [themeName, theme] of [
      ["dark", dark],
      ["light", light],
    ] as const) {
      expect(typeof theme.name, `${themeName} theme must have a name`).toBe("string");
      expect(theme.name, `${themeName} theme name must not contain '/'`).not.toContain("/");

      const colors = getSection(theme, "colors");
      expect(colors, `${themeName} theme must define colors`).toBeDefined();
      if (!colors) continue;

      for (const token of REQUIRED_COLOR_TOKENS) {
        expect(Object.hasOwn(colors, token), `${themeName}.colors is missing '${token}'`).toBe(true);
      }
    }
  });

  it("keeps the original Tokyo Night status and frame chrome stable", () => {
    const palette = createTokyoNightPalette({
      fg: () => "",
      bg: () => "",
    } as unknown as Theme);
    const foregrounds = [
      ["frame", "#3d3577"],
      ["statusModel", "#c8c8ff"],
      ["statusThinking", "#dcdcff"],
      ["statusPath", "#f0f0ff"],
      ["statusGit", "#ffffff"],
      ["statusLimit", "#f5f0ff"],
      ["statusTokens", "#ffffc8"],
      ["statusCost", "#c8ffc8"],
      ["statusContext", "#ffc8c8"],
    ] as const;
    const backgrounds = [
      ["model", "#2d1b69"],
      ["thinking", "#3d2b7a"],
      ["path", "#4d3b8a"],
      ["git", "#5d4b9a"],
      ["quota", "#6553a2"],
      ["tokens", "#6d5baa"],
      ["cost", "#5d5d5d"],
    ] as const;

    for (const [role, expected] of foregrounds) {
      expect(readAnsiRgb(palette.fg(role, "x"), "38"), role).toBe(expected);
    }
    for (const [role, expected] of backgrounds) {
      expect(readAnsiRgb(palette.bg(role, "x"), "48"), role).toBe(expected);
    }
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ] as const)("keeps %s adaptive surface colors distinguishable from the page background", (name, theme) => {
    const vars = getSection(theme, "vars") ?? {};
    const colors = getSection(theme, "colors") ?? {};
    const exported = getSection(theme, "export") ?? {};
    const background = resolveHexColor(exported.pageBg, vars);

    for (const token of ["accent", "thinkingLow", "thinkingMedium", "dim"] as const) {
      const foreground = resolveHexColor(colors[token], vars);
      expect(
        contrastRatio(foreground, background),
        `${name}.colors.${token} must have at least 3:1 contrast`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses valid color values and resolvable variable references", () => {
    const darkVars = getSection(dark, "vars") ?? {};
    const lightVars = getSection(light, "vars") ?? {};

    for (const [key, value] of Object.entries(darkVars)) {
      assertResolvableColor(value, darkVars, `dark.vars.${key}`);
    }
    for (const [key, value] of Object.entries(lightVars)) {
      assertResolvableColor(value, lightVars, `light.vars.${key}`);
    }

    for (const sectionName of ["colors", "export"] as const) {
      for (const [key, value] of Object.entries(getSection(dark, sectionName) ?? {})) {
        assertResolvableColor(value, darkVars, `dark.${sectionName}.${key}`);
      }
      for (const [key, value] of Object.entries(getSection(light, sectionName) ?? {})) {
        assertResolvableColor(value, lightVars, `light.${sectionName}.${key}`);
      }
    }
  });
});
