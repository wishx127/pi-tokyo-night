import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { buildStatusWidgetLines } from "../extension";
import { renderRainPanelLines } from "../rain/rain-panel";
import { BorderlessEditor } from "./borderless-editor";
import { createTokyoNightPalette } from "./theme-palette";
import type { Theme } from "@earendil-works/pi-coding-agent";

const EditorProto = Object.getPrototypeOf(CustomEditor.prototype) as {
  render(width: number): string[];
};

const frameAnsi = "\x1b[38;2;61;53;119m";
const palette = createTokyoNightPalette({
  fg: (_color: string, text: string) => `${frameAnsi}${text}\x1b[39m`,
  bg: (_color: string, text: string) => text,
} as unknown as Theme);

const configShape = (panel: boolean, editorFrame: boolean) => ({
  panel,
  editorFrame,
  codexQuota: false,
  kimiQuota: true,
  iconMode: "ascii" as const,
  statusModules: {},
  rainRows: 3,
  rainTickMs: 130,
  maxRainDrops: 25,
});

function makeEditor(
  panel = false,
  editorFrame = true,
  tui: { requestRender: (...args: any[]) => void; mode?: "regular" | "fullscreen" } = { requestRender: vi.fn() },
  renderFullscreenStatus?: (width: number) => string[],
) {
  const config = { get: vi.fn(() => configShape(panel, editorFrame)) };
  const editor = new BorderlessEditor(
    tui as unknown as TUI,
    {} as EditorTheme,
    {} as KeybindingsManager,
    {
      config: config as any,
      getPalette: () => palette,
      renderFullscreenStatus,
    },
  );
  return { editor, config, tui };
}

describe("BorderlessEditor public composition", () => {
  beforeEach(() => {
    vi.spyOn(EditorProto, "render").mockImplementation((width) => [
      "",
      " ".repeat(Math.max(1, width)),
      "",
    ]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("leaves the host TUI methods untouched while rendering through the public editor API", () => {
    const requestRender = vi.fn();
    const host = new Proxy({ requestRender }, {
      set: () => { throw new Error("host mutation"); },
    });
    const { editor } = makeEditor(false, true, host);
    // The editor was constructed with a raw public TUI-like object; a redraw
    // is a direct call and never captures or replaces a host method.
    editor.requestRender();
    expect(requestRender).toHaveBeenCalledOnce();
    expect(() => host.requestRender()).not.toThrow();
  });

  it("composes Rain, Editor, and Status as one bounded, uniformly colored frame", () => {
    const { editor } = makeEditor(true, true);
    const lines = [
      ...renderRainPanelLines({
        width: 40,
        frameEnabled: true,
        rainRows: 1,
        snapshot: { drops: [], stars: [] },
        palette,
      }),
      ...editor.render(40),
      ...buildStatusWidgetLines(40, "status", true, palette),
    ];
    const output = lines.join("\n");
    const plain = lines.map((line) =>
      line.replace(/\x1b\[[0-9;]*m/g, "")
    );

    expect(output.match(/╭/g)).toHaveLength(1);
    expect(output.match(/╰/g)).toHaveLength(1);
    expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
    expect(lines.every((line) => line.startsWith(frameAnsi))).toBe(true);
    expect(
      plain.slice(1, -1).every((line) =>
        line.startsWith("│") && line.endsWith("│")
      ),
    ).toBe(true);
  });

  it("does not render an editor top border when the permanent rain panel is on", () => {
    const { editor } = makeEditor(true, true);
    const lines = editor.render(40).join("\n");
    expect(lines).not.toMatch(/╭─+╮/);
    expect(lines).toContain("❯");
  });

  it("composes fullscreen status rows inside the editor dock", () => {
    const renderFullscreenStatus = vi.fn(() => ["status row", "status bottom"]);
    const { editor } = makeEditor(
      true,
      true,
      { requestRender: vi.fn(), mode: "fullscreen" },
      renderFullscreenStatus,
    );

    const lines = editor.render(40);

    expect(renderFullscreenStatus).toHaveBeenCalledWith(40);
    expect(lines).toHaveLength(3);
    expect(lines.slice(-2)).toEqual(["status row", "status bottom"]);
  });

  it("does not compose fullscreen status rows in regular mode", () => {
    const renderFullscreenStatus = vi.fn(() => ["status row", "status bottom"]);
    const { editor } = makeEditor(
      true,
      true,
      { requestRender: vi.fn(), mode: "regular" },
      renderFullscreenStatus,
    );

    const lines = editor.render(40);

    expect(renderFullscreenStatus).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
  });

  it("keeps the shared top and side edges through the narrow regular fallback", () => {
    const { editor } = makeEditor(
      false,
      true,
      { requestRender: vi.fn(), mode: "regular" },
    );

    const lines = editor.render(8);
    const output = lines.join("\n");

    expect(output).toContain("╭");
    expect(output).toContain("╮");
    expect(output).toContain("│");
    expect(output).not.toContain("╰");
  });

  it("keeps fullscreen status visible through the narrow editor fallback", () => {
    const renderFullscreenStatus = vi.fn(() => ["status row", "status bottom"]);
    const { editor } = makeEditor(
      true,
      true,
      { requestRender: vi.fn(), mode: "fullscreen" },
      renderFullscreenStatus,
    );

    const lines = editor.render(8);

    expect(renderFullscreenStatus).toHaveBeenCalledWith(8);
    expect(lines).not.toContain("");
    expect(lines.slice(-2)).toEqual(["status row", "status bottom"]);
  });

  it("follows a runtime renderer switch without duplicating status rows", () => {
    const renderFullscreenStatus = vi.fn(() => ["status row", "status bottom"]);
    const tui = { requestRender: vi.fn(), mode: "regular" as "regular" | "fullscreen" };
    const { editor } = makeEditor(true, true, tui, renderFullscreenStatus);

    expect(editor.render(40)).toHaveLength(1);
    tui.mode = "fullscreen";
    expect(editor.render(40)).toHaveLength(3);
    tui.mode = "regular";
    expect(editor.render(40)).toHaveLength(1);
    expect(renderFullscreenStatus).toHaveBeenCalledOnce();
  });

  it("keeps fullscreen dock rows framed when status rendering fails", () => {
    const renderFullscreenStatus = vi.fn(() => {
      throw new Error("status failure");
    });
    const { editor } = makeEditor(
      true,
      true,
      { requestRender: vi.fn(), mode: "fullscreen" },
      renderFullscreenStatus,
    );

    const lines = editor.render(40);

    expect(lines).toHaveLength(4);
    expect(lines).not.toContain("");
    expect(lines.slice(0, -1).every((line) => line.includes("│"))).toBe(true);
    expect(lines.at(-1)).toContain("╰");
    expect(lines.at(-1)).toContain("╯");
  });

  it("keeps plain mode free of box chrome", () => {
    const { editor } = makeEditor(false, false);
    const lines = editor.render(40).join("\n");
    expect(lines).toContain("❯");
    expect(lines).not.toMatch(/[╭╮╰╯│─]/);
  });

  it("always delegates editor input to the public CustomEditor behavior", () => {
    const superInput = vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});
    const { editor } = makeEditor();

    editor.handleInput("x");
    editor.handleInput("down");

    expect(superInput).toHaveBeenNthCalledWith(1, "x");
    expect(superInput).toHaveBeenNthCalledWith(2, "down");
  });
});
