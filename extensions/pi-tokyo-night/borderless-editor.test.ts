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

function makeEditor(panel = false, editorFrame = true, tui: { requestRender: (...args: any[]) => void } = { requestRender: vi.fn() }) {
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
    { config: config as any, settingsController: settings as any },
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
