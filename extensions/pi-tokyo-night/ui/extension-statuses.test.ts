import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  formatExtensionStatusText,
  renderExtensionStatusLines,
} from "./extension-statuses";
import { createTokyoNightPalette } from "./theme-palette";

const darkPalette = createTokyoNightPalette({
  name: "tokyo-night-dark",
  fg: (_color: string, text: string) => text,
} as any);
const lightPalette = createTokyoNightPalette({
  name: "tokyo-night-light",
  fg: (_color: string, text: string) => text,
} as any);
const DARK5 = "\x1b[38;2;115;122;162m";
const DAY_DARK5 = "\x1b[38;2;104;112;154m";
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatExtensionStatusText", () => {
  it("is empty without statuses", () => {
    expect(formatExtensionStatusText(new Map())).toBe("");
    expect(formatExtensionStatusText(undefined)).toBe("");
    expect(formatExtensionStatusText(new Map([["blank", " \n\t"]]))).toBe("");
  });

  it("sorts by key, sanitizes whitespace and joins with spaces", () => {
    const statuses = new Map([
      ["sandbox", "🔒 Sandbox:\t24 domains,\n20 write paths"],
      ["mcp", "  MCP:   1 server enabled  "],
      ["lsp", "LSP\r\nInactive"],
    ]);

    expect(formatExtensionStatusText(statuses)).toBe(
      "LSP Inactive MCP: 1 server enabled 🔒 Sandbox: 24 domains, 20 write paths",
    );
  });

  it("strips foreign ANSI, OSC hyperlinks and APC markers", () => {
    const statuses = new Map([
      ["cache", "\x1b[32mClaude\x1b[39m \x1b[1;38;2;1;2;3mcache\x1b[0m"],
      ["link", "\x1b]8;;https://example.com\x07docs\x1b]8;;\x07 \x1b_marker\x1b\\ok"],
    ]);

    expect(formatExtensionStatusText(statuses)).toBe("Claude cache docs ok");
  });
});

describe("renderExtensionStatusLines", () => {
  it("renders nothing for empty text", () => {
    expect(renderExtensionStatusLines("", 80, darkPalette)).toEqual([]);
    expect(renderExtensionStatusLines("MCP", 0, darkPalette)).toEqual([]);
  });

  it("colors the row with the Tokyo Night statusExtensions role per variant", () => {
    expect(renderExtensionStatusLines("MCP: 1 server", 80, darkPalette)).toEqual([
      `${DARK5}MCP: 1 server\x1b[39m`,
    ]);
    expect(renderExtensionStatusLines("MCP: 1 server", 80, lightPalette)[0])
      .toContain(DAY_DARK5);
  });

  it("truncates to the width with a themed ellipsis", () => {
    const lines = renderExtensionStatusLines(`${"x".repeat(50)} ${"y".repeat(50)}`, 20, darkPalette);

    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(20);
    expect(stripAnsi(lines[0]!)).toBe(`${"x".repeat(17)}...`);
    expect(lines[0]).toContain(`${DARK5}...`);
  });
});
