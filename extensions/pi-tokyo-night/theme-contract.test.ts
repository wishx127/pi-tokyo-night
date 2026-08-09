import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
