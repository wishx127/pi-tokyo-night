import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { collectExtensionStatuses } from "./extension-statuses";
import { resolveIcons } from "./icons";
import { buildExtensionStatusRow } from "./status-bar";
import { createTokyoNightPalette } from "./theme-palette";

const palette = createTokyoNightPalette({
  name: "tokyo-night-dark",
  fg: (_color: string, text: string) => text,
} as any);
const icons = resolveIcons("nerd");
const ARROW = icons.transition;
const bg = (rgb: string) => `\x1b[48;2;${rgb}m`;
const fg = (rgb: string) => `\x1b[38;2;${rgb}m`;
// The main status bar's segment pairs, in the order the row cycles them.
const BAR_PAIRS = [
  { bg: "45;27;105", fg: "200;200;255" }, // model / statusModel
  { bg: "61;43;122", fg: "220;220;255" }, // thinking / statusThinking
  { bg: "77;59;138", fg: "240;240;255" }, // path / statusPath
  { bg: "93;75;154", fg: "255;255;255" }, // git / statusGit
  { bg: "101;83;162", fg: "245;240;255" }, // quota / statusLimit
  { bg: "109;91;170", fg: "255;255;200" }, // tokens / statusTokens
];
const plainText = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("collectExtensionStatuses", () => {
  it("is empty without statuses", () => {
    expect(collectExtensionStatuses(new Map())).toEqual([]);
    expect(collectExtensionStatuses(undefined)).toEqual([]);
    expect(collectExtensionStatuses(new Map([["blank", " \n\t\x1b[31m\x1b[0m"]]))).toEqual([]);
  });

  it("sorts by key and sanitizes whitespace", () => {
    const statuses = new Map([
      ["sandbox", "🔒 Sandbox:\t24 domains,\n20 write paths"],
      ["mcp", "  MCP:   1 server enabled  "],
      ["lsp", "LSP\r\nInactive"],
    ]);

    expect(collectExtensionStatuses(statuses)).toEqual([
      "LSP Inactive",
      "MCP: 1 server enabled",
      "🔒 Sandbox: 24 domains, 20 write paths",
    ]);
  });

  it("strips all foreign SGR and control sequences", () => {
    const statuses = new Map([
      ["a", "\x1b[1;41;31mwarn\x1b[0m"],
      ["b", "\x1b[38;2;1;2;3;48;2;4;5;6mtrue\x1b[49m \x1b[38:2::7:8:9mcolon\x1b[m"],
      ["c", "\x1b]8;;https://example.com\x07docs\x1b]8;;\x07 \x1b_marker\x1b\\ok\x1b[2K\x1b[3G"],
    ]);

    expect(collectExtensionStatuses(statuses)).toEqual(["warn", "true colon", "docs ok"]);
  });
});

describe("buildExtensionStatusRow", () => {
  it("renders nothing without statuses or width", () => {
    expect(buildExtensionStatusRow([], 80, palette, icons)).toEqual([]);
    expect(buildExtensionStatusRow(["MCP"], 0, palette, icons)).toEqual([]);
  });

  it("renders Powerline segments whose fg/bg pairs cycle the status bar's role pairs", () => {
    const statuses = ["s0", "s1", "s2", "s3", "s4", "s5", "s6"];
    const [row] = buildExtensionStatusRow(statuses, 120, palette, icons);

    expect(plainText(row!)).toBe(`${statuses.map((status) => ` ${status} `).join(ARROW)}${ARROW}`);
    statuses.forEach((status, index) => {
      const pair = BAR_PAIRS[index % BAR_PAIRS.length]!;
      expect(row).toContain(`${bg(pair.bg)}${fg(pair.fg)} ${status} `);
      // Arrow join: next segment's background, previous segment's background as fg.
      const next = BAR_PAIRS[(index + 1) % BAR_PAIRS.length]!;
      const join = index === statuses.length - 1 ? "\x1b[49m" : bg(next.bg);
      expect(row).toContain(`${join}${fg(pair.bg)}${ARROW}`);
    });
  });

  it("ellipsizes the last segment that fits and drops the rest", () => {
    const statuses = ["MCP: 1 server", "🔒 Sandbox: 24 domains, 20 write paths", "zz dropped"];
    const [row] = buildExtensionStatusRow(statuses, 40, palette, icons);

    expect(visibleWidth(row!)).toBe(40);
    expect(plainText(row!)).toBe(` MCP: 1 server ${ARROW} 🔒 Sandbox: 24 domai… ${ARROW}`);
    // The ellipsis stays on the segment background: no reset inside the segment.
    expect(row).toContain(`${bg(BAR_PAIRS[1]!.bg)}${fg(BAR_PAIRS[1]!.fg)} 🔒 Sandbox: 24 domai… `);
  });
});
