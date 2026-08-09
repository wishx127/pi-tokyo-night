import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomEditor, type ExtensionUIContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { BorderlessEditor, shouldRenderEditorTopBorder } from "./borderless-editor";

const EditorProto = Object.getPrototypeOf(CustomEditor.prototype) as {
  render(width: number): string[];
};

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
  const settings = {
    isActive: false,
    handleInput: vi.fn(),
    buildLines: vi.fn(() => ["settings"]),
  };
  const config = { get: vi.fn(() => configShape(panel, editorFrame)) };
  const editor = new BorderlessEditor(
    tui as unknown as TUI,
    {} as EditorTheme,
    {} as KeybindingsManager,
    {} as ExtensionUIContext,
    { config: config as any, settingsController: settings as any, renderFullscreenStatus } as any,
  );
  return { editor, config, settings, tui };
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

  it("uses the approved top-border rule", () => {
    expect(shouldRenderEditorTopBorder({ panel: false, editorFrame: true })).toBe(true);
    expect(shouldRenderEditorTopBorder({ panel: true, editorFrame: true })).toBe(false);
    expect(shouldRenderEditorTopBorder({ panel: false, editorFrame: false })).toBe(false);
  });

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

    expect(lines).toHaveLength(3);
    expect(lines).not.toContain("");
    expect(lines.every((line) => line.includes("│"))).toBe(true);
  });

  it("keeps fullscreen status attached while settings mode is active", () => {
    const renderFullscreenStatus = vi.fn(() => ["status row", "status bottom"]);
    const { editor, settings } = makeEditor(
      true,
      true,
      { requestRender: vi.fn(), mode: "fullscreen" },
      renderFullscreenStatus,
    );
    settings.isActive = true;

    const lines = editor.render(40);

    expect(lines).toHaveLength(3);
    expect(lines).not.toContain("");
    expect(lines.slice(-2)).toEqual(["status row", "status bottom"]);
  });

  it("keeps plain mode free of box chrome", () => {
    const { editor } = makeEditor(false, false);
    const lines = editor.render(40).join("\n");
    expect(lines).toContain("❯");
    expect(lines).not.toMatch(/[╭╮╰╯│─]/);
  });

  it("routes input to settings only while settings mode is active", () => {
    const superInput = vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});
    const { editor, settings } = makeEditor();
    editor.handleInput("x");
    expect(settings.handleInput).not.toHaveBeenCalled();
    settings.isActive = true;
    editor.handleInput("down");
    expect(settings.handleInput).toHaveBeenCalledWith("down");
    expect(superInput).toHaveBeenCalledWith("x");
  });
});
