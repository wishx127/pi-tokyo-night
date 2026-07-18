/**
 * Slice 2: rain visual rendering migrated into BorderlessEditor.
 *
 * Primary seam: the pure exported renderRainLines() function — no editor
 * construction needed for the rain-rendering unit tests.
 *
 * Composition seam: We spy on Editor.prototype.render (the grandparent class
 * render that CustomEditor inherits) so super.render() inside BorderlessEditor
 * returns controlled fake lines rather than requiring a real TUI. We obtain the
 * prototype via Object.getPrototypeOf(CustomEditor.prototype).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CustomEditor, type ExtensionUIContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  renderRainLines,
  BorderlessEditor,
  type BorderlessEditorDependencies,
  MOON,
  MOON_FG,
  MOON_COL,
  MOON_ROW,
  STAR,
  RAIN_DROP,
} from "./borderless-editor";
import type { RainAnimationManager, RainFrameSnapshot } from "./rain-manager";
import { CYAN, PURPLE, RESET } from "./ui-primitives";

// Editor.prototype — where render() actually lives (one level above CustomEditor).
const EditorProto = Object.getPrototypeOf(CustomEditor.prototype) as {
  render: (width: number) => string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(
  drops: Array<{ col: number; row: number }> = [],
  stars: Array<{ col: number; row: number }> = [],
): RainFrameSnapshot {
  return { drops, stars };
}

function stripAnsi(s: string): string {
  // Remove all CSI (ESC[...) escape sequences.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[^m]*m/g, "");
}

// ── Fake super.render() lines: a minimal bordered editor body (2 lines min) ──

function makeFakeEditorLines(width: number): string[] {
  // Simulate the current Editor.render(contentWidth) contract: top border,
  // editor content, bottom border. BorderlessEditor must remove both border
  // slots while retaining any autocomplete rows after them.
  return [
    "", // lines[0]: editor top border (borderColor is locked to empty)
    " ".repeat(Math.max(1, width)), // lines[1]: one content line
    "", // lines[2]: editor bottom border
  ];
}

// ── 1. renderRainLines — top border ──────────────────────────────────────────

describe("renderRainLines", () => {
  it("returns (1 + rainRows) lines: one top border + rainRows body rows", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 3,
      snapshot: makeSnapshot(),
    });
    // 1 top border + 3 body rows
    expect(lines).toHaveLength(1 + 3);
  });

  it("top border (hideSideBorders=false) starts with ╭ and ends with ╮", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 2,
      snapshot: makeSnapshot(),
    });
    const top = stripAnsi(lines[0]);
    expect(top).toMatch(/^╭─+╮$/);
  });

  it("top border (hideSideBorders=false) has visible width === input width", () => {
    const width = 25;
    const lines = renderRainLines({
      width,
      hideSideBorders: false,
      rainRows: 2,
      snapshot: makeSnapshot(),
    });
    expect(visibleWidth(lines[0])).toBe(width);
  });

  it("top border (hideSideBorders=true) is a full-width horizontal line ─", () => {
    const width = 15;
    const lines = renderRainLines({
      width,
      hideSideBorders: true,
      rainRows: 2,
      snapshot: makeSnapshot(),
    });
    const top = stripAnsi(lines[0]);
    expect(top).toMatch(/^─+$/);
    expect(visibleWidth(lines[0])).toBe(width);
  });

  // ── 2. Moon position ────────────────────────────────────────────────────────

  it("moon glyph appears at row 0, column 2 (after frame border)", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 3,
      snapshot: makeSnapshot(),
    });
    // lines[0] is the top border; lines[1] is body row r=0.
    const bodyRow0 = lines[1];
    expect(bodyRow0).toContain(MOON_FG);
    expect(bodyRow0).toContain(MOON);
  });

  it("moon does NOT appear in body rows other than row 0 (r=1+)", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 3,
      snapshot: makeSnapshot(),
    });
    // lines[2] and lines[3] correspond to r=1 and r=2
    for (let i = 2; i < lines.length; i++) {
      expect(lines[i]).not.toContain(MOON);
    }
  });

  // ── 3. Star and drop colours ────────────────────────────────────────────────

  it("a star at (col=5, row=1) is rendered with PURPLE + STAR", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 3,
      snapshot: makeSnapshot([], [{ col: 5, row: 1 }]),
    });
    // lines[2] = body row r=1
    const bodyRow1 = lines[2];
    expect(bodyRow1).toContain(PURPLE + STAR + RESET);
  });

  it("a drop at (col=5, row=1) is rendered with CYAN + RAIN_DROP", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 3,
      snapshot: makeSnapshot([{ col: 5, row: 1 }], []),
    });
    const bodyRow1 = lines[2];
    expect(bodyRow1).toContain(CYAN + RAIN_DROP + RESET);
  });

  it("a drop out of range (col >= innerWidth) is NOT rendered", () => {
    const width = 10; // innerWidth = 8 (width-2)
    const lines = renderRainLines({
      width,
      hideSideBorders: false,
      rainRows: 2,
      snapshot: makeSnapshot([{ col: 9, row: 0 }], []),
    });
    // row 0 should not contain a raindrop since col=9 >= innerWidth=8
    const bodyRow0 = lines[1];
    expect(bodyRow0).not.toContain(CYAN + RAIN_DROP + RESET);
  });

  it("a drop out of rainRows range (row >= rainRows) is NOT rendered", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 3,
      snapshot: makeSnapshot([{ col: 3, row: 3 }], []),
    });
    // row=3 is >= rainRows=3, so none of the body lines should contain it
    const allBody = lines.slice(1).join("");
    expect(allBody).not.toContain(CYAN + RAIN_DROP + RESET);
  });

  it("ignores fractional coordinates instead of colliding numeric keys", () => {
    const lines = renderRainLines({
      width: 10,
      hideSideBorders: true,
      rainRows: 3,
      snapshot: makeSnapshot([{ col: 2, row: 0.5 }], []),
    });

    expect(lines.slice(1).join("")).not.toContain(CYAN + RAIN_DROP + RESET);
  });

  // ── 4. All lines within width ────────────────────────────────────────────────

  it("every returned line has visibleWidth <= width", () => {
    const width = 30;
    const lines = renderRainLines({
      width,
      hideSideBorders: false,
      rainRows: 4,
      snapshot: makeSnapshot(
        [
          { col: 0, row: 0 },
          { col: 5, row: 2 },
          { col: 10, row: 3 },
        ],
        [
          { col: 5, row: 1 },
          { col: 8, row: 0 },
        ],
      ),
    });
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("moon at row=0 col=2 does not push any line over width (wide char handling)", () => {
    // With a narrow width, ensure the moon's extra width column is consumed.
    const width = 12;
    const lines = renderRainLines({
      width,
      hideSideBorders: false,
      rainRows: 2,
      snapshot: makeSnapshot(),
    });
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  // ── 5. Side-border body rows ─────────────────────────────────────────────────

  it("body rows (hideSideBorders=false) start and end with │", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 2,
      snapshot: makeSnapshot(),
    });
    for (let i = 1; i < lines.length; i++) {
      const bare = stripAnsi(lines[i]);
      expect(bare.startsWith("│")).toBe(true);
      expect(bare.endsWith("│")).toBe(true);
    }
  });

  it("body rows (hideSideBorders=true) do NOT start/end with │", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: true,
      rainRows: 2,
      snapshot: makeSnapshot(),
    });
    for (let i = 1; i < lines.length; i++) {
      const bare = stripAnsi(lines[i]);
      expect(bare.startsWith("│")).toBe(false);
      expect(bare.endsWith("│")).toBe(false);
    }
  });

  // ── 6. Exactly one top border line ───────────────────────────────────────────

  it("contains exactly one ╭ character in the entire output (one top border)", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 3,
      snapshot: makeSnapshot(),
    });
    const all = lines.map(stripAnsi).join("\n");
    const count = (all.match(/╭/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("rainRows=1 produces exactly 2 lines (1 top border + 1 body row)", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 1,
      snapshot: makeSnapshot(),
    });
    expect(lines).toHaveLength(2);
  });

  // ── 7. rainRows=0 edge case ──────────────────────────────────────────────────

  it("rainRows=0 with hideSideBorders=false returns exactly 1 line (just the top border ╭─╮)", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: false,
      rainRows: 0,
      snapshot: makeSnapshot(),
    });
    expect(lines).toHaveLength(1);
    const top = stripAnsi(lines[0]);
    expect(top).toMatch(/^╭─+╮$/);
  });

  it("rainRows=0 with hideSideBorders=true returns exactly 1 line (just the top border ─…─)", () => {
    const lines = renderRainLines({
      width: 20,
      hideSideBorders: true,
      rainRows: 0,
      snapshot: makeSnapshot(),
    });
    expect(lines).toHaveLength(1);
    const top = stripAnsi(lines[0]);
    expect(top).toMatch(/^─+$/);
  });
});

// ── 7. BorderlessEditor composition ──────────────────────────────────────────
//
// Seam: We spy on Editor.prototype.render (obtained via
// Object.getPrototypeOf(CustomEditor.prototype)) so that super.render()
// returns controlled stub lines. This avoids requiring a fully initialised
// TUI/editor state.

// Minimal TUI stub.
function makeTuiStub() {
  return {
    requestRender: vi.fn(),
    doRender: undefined as (() => void) | undefined,
  };
}

// Minimal SelectorDetector stub.
function makeSelectorDetector() {
  return {
    editorTui: null as unknown,
    overlayTui: null as unknown,
    isSideBordersHidden: vi.fn(() => false),
    check: vi.fn(),
    scheduleRerender: vi.fn(),
  };
}

// Minimal SettingsUIController stub.
function makeSettingsController() {
  return {
    isActive: false,
    handleInput: vi.fn(),
    buildLines: vi.fn(() => [] as string[]),
  };
}

// Minimal TokyoConfigManager stub.
function makeConfigStub() {
  return {
    get: vi.fn(() => ({
      panel: false,
      rainRows: 3,
      rainTickMs: 130,
      maxRainDrops: 25,
      codexQuota: false,
    })),
    set: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
  };
}

// Minimal RainAnimationManager stub with mutable isRunning.
function makeRainManagerStub(running: boolean) {
  let _isRunning = running;
  const stub = {
    get isRunning() {
      return _isRunning;
    },
    setRunning(v: boolean) {
      _isRunning = v;
    },
    setRenderWidth: vi.fn(),
    getSnapshot: vi.fn((): RainFrameSnapshot => makeSnapshot([], [])),
    start: vi.fn(),
    stop: vi.fn(),
  };
  return stub;
}

describe("BorderlessEditor composition", () => {
  let renderSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on Editor.prototype.render so super.render() returns fake lines.
    renderSpy = vi.spyOn(EditorProto, "render").mockImplementation(
      (width: number) => makeFakeEditorLines(width),
    );
    BorderlessEditor.activeInstance = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    BorderlessEditor.activeInstance = null;
  });

  function makeEditor(
    rainManagerStub: ReturnType<typeof makeRainManagerStub>,
    selectorDetector = makeSelectorDetector(),
    tui = makeTuiStub(),
  ) {
    const settingsController = makeSettingsController();
    const config = makeConfigStub();

    const deps: BorderlessEditorDependencies = {
      config: config as unknown as BorderlessEditorDependencies["config"],
      selectorDetector: selectorDetector as unknown as BorderlessEditorDependencies["selectorDetector"],
      settingsController: settingsController as unknown as BorderlessEditorDependencies["settingsController"],
      rainManager: rainManagerStub as unknown as RainAnimationManager,
    };

    return new BorderlessEditor(
      tui as unknown as TUI,
      {} as unknown as EditorTheme,
      {} as unknown as KeybindingsManager,
      {} as unknown as ExtensionUIContext,
      deps,
    );
  }

  /**
   * Like makeEditor but also returns the settings controller and config stubs
   * so tests can mutate them after construction.
   */
  function makeEditorWithParts(rainManagerStub: ReturnType<typeof makeRainManagerStub>) {
    const tui = makeTuiStub();
    const selectorDetector = makeSelectorDetector();
    const settingsController = makeSettingsController();
    const config = makeConfigStub();

    const deps: BorderlessEditorDependencies = {
      config: config as unknown as BorderlessEditorDependencies["config"],
      selectorDetector: selectorDetector as unknown as BorderlessEditorDependencies["selectorDetector"],
      settingsController: settingsController as unknown as BorderlessEditorDependencies["settingsController"],
      rainManager: rainManagerStub as unknown as RainAnimationManager,
    };

    const editor = new BorderlessEditor(
      tui as unknown as TUI,
      {} as unknown as EditorTheme,
      {} as unknown as KeybindingsManager,
      {} as unknown as ExtensionUIContext,
      deps,
    );

    return { editor, settingsController, config, selectorDetector };
  }

  // ── 7a. width < 10 falls back to super.render ──────────────────────────────

  it("width < 10 delegates to super.render(width)", () => {
    const rainMgr = makeRainManagerStub(false);
    const editor = makeEditor(rainMgr);

    const result = editor.render(5);
    expect(renderSpy).toHaveBeenCalledWith(5);
    expect(result).toEqual(makeFakeEditorLines(5));
  });

  it("removes both editor border slots while retaining autocomplete rows", () => {
    renderSpy.mockImplementationOnce(() => [
      "", // Editor top border
      "editor body",
      "", // Editor bottom border
      "autocomplete result",
    ]);

    const editor = makeEditor(makeRainManagerStub(false));
    const result = editor.render(40).map(stripAnsi);

    expect(result).toHaveLength(3); // card top border + body + autocomplete
    expect(result.join("\n")).toContain("editor body");
    expect(result.join("\n")).toContain("autocomplete result");
    expect(result.join("\n")).not.toMatch(/\n\s*\n/);
  });

  it("safely returns Editor output when it has fewer than two border slots", () => {
    renderSpy
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => ["only line"]);
    const editor = makeEditor(makeRainManagerStub(false));

    expect(editor.render(40)).toEqual([]);
    expect(editor.render(40)).toEqual(["only line"]);
  });

  // ── 7b. rain inactive → editor draws its own top border ────────────────────

  it("when rainManager.isRunning=false, render() includes editor's own ╭ top border", () => {
    const rainMgr = makeRainManagerStub(false);
    const editor = makeEditor(rainMgr);

    const result = editor.render(40);
    const allBare = result.map(stripAnsi).join("\n");
    // When rain is not running, the editor draws a ╭─╮ top border.
    expect(allBare).toContain("╭");
  });

  it("when rainManager.isRunning=false, render() does NOT contain rain body rows (no moon)", () => {
    const rainMgr = makeRainManagerStub(false);
    const editor = makeEditor(rainMgr);

    const result = editor.render(40);
    const all = result.join("");
    expect(all).not.toContain(MOON);
  });

  // ── 7c. rain active → rain lines first, single top border ──────────────────

  it("when rainManager.isRunning=true, first line of render() is rain top border ╭─╮", () => {
    const rainMgr = makeRainManagerStub(true);
    rainMgr.getSnapshot.mockReturnValue(makeSnapshot([{ col: 3, row: 1 }], []));

    const editor = makeEditor(rainMgr);
    const result = editor.render(40);

    expect(result.length).toBeGreaterThan(0);
    const firstBareLine = stripAnsi(result[0]);
    expect(firstBareLine).toMatch(/^╭─+╮$/);
  });

  it("when rainManager.isRunning=true, output contains exactly ONE ╭", () => {
    const rainMgr = makeRainManagerStub(true);
    rainMgr.getSnapshot.mockReturnValue(makeSnapshot([], []));

    const editor = makeEditor(rainMgr);
    const result = editor.render(40);

    const all = result.map(stripAnsi).join("\n");
    const count = (all.match(/╭/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("when rainManager.isRunning=true, rain body rows appear before editor body rows", () => {
    const rainMgr = makeRainManagerStub(true);
    // Put a drop at rain (col=3, row=2) — avoids the moon cell at (col=2, row=0)
    // and avoids the INITIAL_STARS positions so the drop glyph is unambiguous.
    rainMgr.getSnapshot.mockReturnValue(makeSnapshot([{ col: 3, row: 2 }], []));

    const editor = makeEditor(rainMgr);
    const result = editor.render(40);

    // Find the rain body line that contains the drop (unambiguously rain content).
    const rainLineIdx = result.findIndex((l) => l.includes(CYAN + RAIN_DROP + RESET));
    // Find the first editor body line: starts with │ (frame border) but is NOT
    // a rain row — rain rows also start with │, so distinguish by the fact that
    // editor body lines contain the prompt chevron PURPLE + ❯ sequence.
    const editorBodyIdx = result.findIndex((l) => l.includes(`${PURPLE}❯${RESET}`));

    // Both lines must be present in the output.
    expect(rainLineIdx).toBeGreaterThan(-1);
    expect(editorBodyIdx).toBeGreaterThan(-1);
    // Rain body content must appear before editor body content.
    expect(rainLineIdx).toBeLessThan(editorBodyIdx);
  });

  // ── 7d. setRenderWidth called when rain is active ──────────────────────────

  it("render() calls rainManager.setRenderWidth(width-2) when rain is active", () => {
    const rainMgr = makeRainManagerStub(true);
    rainMgr.getSnapshot.mockReturnValue(makeSnapshot([], []));

    const editor = makeEditor(rainMgr);
    const width = 40;
    editor.render(width);

    expect(rainMgr.setRenderWidth).toHaveBeenCalledWith(width - 2);
  });

  it("render() does NOT call rainManager.setRenderWidth when rain is inactive", () => {
    const rainMgr = makeRainManagerStub(false);

    const editor = makeEditor(rainMgr);
    editor.render(40);

    expect(rainMgr.setRenderWidth).not.toHaveBeenCalled();
  });

  // ── 7e. selector + running rain composition ────────────────────────────────

  it("selector active editor render stays borderless while the selector seam supplies rain", () => {
    const rainMgr = makeRainManagerStub(true);
    rainMgr.getSnapshot.mockReturnValue(makeSnapshot([{ col: 3, row: 1 }], []));

    const { editor, selectorDetector } = makeEditorWithParts(rainMgr);
    selectorDetector.isSideBordersHidden.mockReturnValue(true);

    const editorLines = editor.render(40);
    expect(editorLines.join("")).not.toContain(MOON);

    const rainLines = editor.renderSelectorOverlay(40);
    expect(rainLines.join("")).toContain(MOON);
    expect(rainLines.join("")).toContain(CYAN + RAIN_DROP + RESET);
  });

  it("dispose is idempotent and clears the active editor instance", () => {
    const editor = makeEditor(makeRainManagerStub(false));
    expect(BorderlessEditor.activeInstance).toBe(editor);

    expect(() => {
      editor.dispose();
      editor.dispose();
    }).not.toThrow();
    expect(BorderlessEditor.activeInstance).toBeNull();
  });

  it("dispose restores the TUI doRender patch", () => {
    const tui = makeTuiStub();
    const originalDoRender = vi.fn();
    tui.doRender = originalDoRender;
    const editor = makeEditor(
      makeRainManagerStub(false),
      makeSelectorDetector(),
      tui,
    );

    expect(tui.doRender).not.toBe(originalDoRender);
    editor.dispose();
    tui.doRender?.();

    expect(originalDoRender).toHaveBeenCalledOnce();
  });

  // ── 7f. rain render error → graceful degradation ───────────────────────────

  it("if rain rendering throws (getSnapshot throws), render() does not rethrow", () => {
    const rainMgr = makeRainManagerStub(true);
    rainMgr.getSnapshot.mockImplementation(() => {
      throw new Error("simulated rain render failure");
    });

    const editor = makeEditor(rainMgr);
    let result: string[] | undefined;
    expect(() => {
      result = editor.render(40);
    }).not.toThrow();
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).length).toBeGreaterThan(0);
  });

  // ── 7g. all lines within width ─────────────────────────────────────────────

  it("all output lines have visibleWidth <= input width when rain is active", () => {
    const rainMgr = makeRainManagerStub(true);
    rainMgr.getSnapshot.mockReturnValue(
      makeSnapshot(
        [{ col: 2, row: 0 }, { col: 5, row: 1 }],
        [{ col: 5, row: 1 }],
      ),
    );

    const editor = makeEditor(rainMgr);
    const width = 40;
    const result = editor.render(width);

    for (const line of result) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  // ── Slice 3: settings-mode scenarios ────────────────────────────────────────

  // Scenario 1: settings mode + rain active → NO duplicate top border.
  // Rain owns the single ╭ border; renderSettingsMode must not add another.
  it("settings mode + rain active: render() contains exactly ONE ╭ (no duplicate top border)", () => {
    const rainMgr = makeRainManagerStub(true);
    rainMgr.getSnapshot.mockReturnValue(makeSnapshot([], []));

    const { editor, settingsController } = makeEditorWithParts(rainMgr);
    settingsController.isActive = true;
    settingsController.buildLines.mockReturnValue(["setting line 1", "setting line 2"]);

    const result = editor.render(40);
    const all = result.map(stripAnsi).join("\n");
    const count = (all.match(/╭/g) ?? []).length;
    expect(count).toBe(1);
  });

  // Scenario 2: settings mode + rain inactive → settings draws its own top border.
  // Output must contain ╭─╮ top border and must NOT contain rain body rows (no moon).
  it("settings mode + rain inactive: render() includes top border and no rain body (no moon)", () => {
    const rainMgr = makeRainManagerStub(false);

    const { editor, settingsController } = makeEditorWithParts(rainMgr);
    settingsController.isActive = true;
    settingsController.buildLines.mockReturnValue(["setting line 1"]);

    const result = editor.render(40);
    const allBare = result.map(stripAnsi).join("\n");
    // Settings draws its own ╭─╮ top border when rain is not running.
    expect(allBare).toMatch(/╭─+╮/);
    // No rain body rows: the moon glyph must not be present.
    expect(result.join("")).not.toContain(MOON);
  });

  // Scenario 3: rainRows change reflected in settings-mode display height (live read).
  // Changing config.rainRows from 3 → 6 while in settings mode with rain active
  // changes the number of rain body lines in the render output.
  it("settings mode + rain active: changing config rainRows changes the number of rain body lines", () => {
    const rainMgr = makeRainManagerStub(true);
    rainMgr.getSnapshot.mockReturnValue(makeSnapshot([], []));

    const { editor, settingsController, config } = makeEditorWithParts(rainMgr);
    settingsController.isActive = true;
    settingsController.buildLines.mockReturnValue([]);

    // Render with initial rainRows=3 (rain part = 1 top border + 3 body lines).
    const resultA = editor.render(40);

    // Mutate config to return rainRows=6.
    config.get.mockReturnValue({
      panel: false,
      rainRows: 6,
      rainTickMs: 130,
      maxRainDrops: 25,
      codexQuota: false,
    });

    const resultB = editor.render(40);
    // With rainRows=6, rain part = 1+6=7 lines total.
    // The absolute count of lines in resultB should be greater than resultA.
    expect(resultB.length).toBeGreaterThan(resultA.length);
  });

  // Scenario 6: panel pending value vs manager running state → structure follows isRunning.
  // (a) config.panel=true but isRunning=false → settings draws OWN border, no rain.
  // (b) config.panel=false but isRunning=true → rain still owns the border, rain body present.
  it("settings mode: structure follows isRunning, not config.panel (panel=true, isRunning=false → own border, no moon)", () => {
    const rainMgr = makeRainManagerStub(false); // rain NOT running
    const { editor, settingsController, config } = makeEditorWithParts(rainMgr);

    // Pending panel value says "true" (user toggled on in settings before apply).
    config.get.mockReturnValue({
      panel: true, // pending value
      rainRows: 3,
      rainTickMs: 130,
      maxRainDrops: 25,
      codexQuota: false,
    });
    settingsController.isActive = true;
    settingsController.buildLines.mockReturnValue(["setting line"]);

    const result = editor.render(40);
    const allBare = result.map(stripAnsi).join("\n");
    // isRunning=false → settings draws own border (single ╭).
    expect(allBare).toMatch(/╭─+╮/);
    // No rain body: no moon glyph.
    expect(result.join("")).not.toContain(MOON);
  });

  it("settings mode: structure follows isRunning, not config.panel (panel=false, isRunning=true → rain owns border, rain body present)", () => {
    const rainMgr = makeRainManagerStub(true); // rain IS running
    rainMgr.getSnapshot.mockReturnValue(makeSnapshot([], []));
    const { editor, settingsController, config } = makeEditorWithParts(rainMgr);

    // Pending panel value says "false" (user toggled off in settings before apply).
    config.get.mockReturnValue({
      panel: false, // pending value
      rainRows: 3,
      rainTickMs: 130,
      maxRainDrops: 25,
      codexQuota: false,
    });
    settingsController.isActive = true;
    settingsController.buildLines.mockReturnValue(["setting line"]);

    const result = editor.render(40);
    const all = result.map(stripAnsi).join("\n");
    // isRunning=true → rain owns the single ╭ border (exactly one).
    const count = (all.match(/╭/g) ?? []).length;
    expect(count).toBe(1);
    // Rain body rows are present: moon glyph appears.
    expect(result.join("")).toContain(MOON);
  });
});
