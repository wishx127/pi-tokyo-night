import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderExtensionStatusLines } from "./extension-statuses";

const theme = { fg: (_color: string, text: string) => `<dim>${text}</dim>` } as any;

describe("renderExtensionStatusLines", () => {
  it("renders nothing without statuses", () => {
    expect(renderExtensionStatusLines(new Map(), 80, theme)).toEqual([]);
    expect(renderExtensionStatusLines(undefined, 80, theme)).toEqual([]);
  });

  it("sorts by key, sanitizes whitespace and joins on one line", () => {
    const statuses = new Map([
      ["sandbox", "🔒 Sandbox:\t24 domains,\n20 write paths"],
      ["mcp", "  MCP:   1 server enabled  "],
      ["lsp", "LSP\r\nInactive"],
    ]);

    expect(renderExtensionStatusLines(statuses, 120, theme)).toEqual([
      "LSP Inactive MCP: 1 server enabled 🔒 Sandbox: 24 domains, 20 write paths",
    ]);
  });

  it("keeps each status's ANSI styling", () => {
    const statuses = new Map([["cache", "\x1b[32mClaude cache\x1b[39m"]]);

    expect(renderExtensionStatusLines(statuses, 80, theme)).toEqual([
      "\x1b[32mClaude cache\x1b[39m",
    ]);
  });

  it("truncates to the width with a dim ellipsis", () => {
    const plain = { fg: (_color: string, text: string) => text } as any;
    const statuses = new Map([["a", "x".repeat(50)], ["b", "y".repeat(50)]]);

    const lines = renderExtensionStatusLines(statuses, 20, plain);

    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(20);
    expect(lines[0]).toContain("...");
    expect(lines[0]!.startsWith("x".repeat(10))).toBe(true);
  });
});
