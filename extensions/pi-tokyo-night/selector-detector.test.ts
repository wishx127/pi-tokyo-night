import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import {
  getDoRender,
  isSelectorActive,
  setDoRender,
  SelectorDetector,
  type SelectorDetectorCallbacks,
  type TUIInternals,
} from "./selector-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal TUIInternals-compatible stub and cast it as TUI. */
function makeTUI(
  focusedComponent: unknown,
  hasOverlay = false,
): TUI {
  const internals: TUIInternals = {
    focusedComponent,
    hasOverlay: () => hasOverlay,
    doRender: vi.fn(),
    requestRender: vi.fn(),
  };
  return internals as unknown as TUI;
}

/** Build a fresh callbacks stub without requestRainRender. */
function makeCallbacks(editorTarget: unknown): SelectorDetectorCallbacks {
  return {
    getEditorFocusTarget: vi.fn(() => editorTarget),
    requestEditorRender: vi.fn(),
    requestStatusRender: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SelectorDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Selector-active transition requests editor + status render,
  // and there is NO rain render callback on the interface.
  // -------------------------------------------------------------------------
  it("selector-active transition calls requestEditorRender and requestStatusRender only", () => {
    const editorTarget = { __editor: true };
    const callbacks = makeCallbacks(editorTarget);

    // Structural check: the interface no longer has requestRainRender
    expect("requestRainRender" in callbacks).toBe(false);

    const detector = new SelectorDetector(callbacks);

    // focusedComponent differs from editorTarget → isSelectorActive returns true
    const selectorTui = makeTUI({ __selector: true });

    // State was inactive; check() transitions to active
    const changed = detector.check(selectorTui, null);
    expect(changed).toBe(true);
    expect(detector.isActive).toBe(true);

    // No renders yet — scheduled via setTimeout(fn, 0)
    expect(callbacks.requestEditorRender).not.toHaveBeenCalled();
    expect(callbacks.requestStatusRender).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(callbacks.requestEditorRender).toHaveBeenCalledOnce();
    expect(callbacks.requestStatusRender).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Selector close restores side borders.
  // -------------------------------------------------------------------------
  it("selector close transitions to inactive, restores side borders, and triggers renders", () => {
    const editorTarget = { __editor: true };
    const callbacks = makeCallbacks(editorTarget);
    const detector = new SelectorDetector(callbacks);

    // Start with selector active
    const selectorTui = makeTUI({ __selector: true });
    detector.check(selectorTui, null);
    vi.runAllTimers(); // flush first transition
    vi.clearAllMocks();

    // Now close: focusedComponent === editorTarget → isSelectorActive returns false
    const editorTui = makeTUI(editorTarget);
    const changed = detector.check(editorTui, null);

    expect(changed).toBe(true);
    expect(detector.isActive).toBe(false);
    expect(detector.isSideBordersHidden()).toBe(false);

    // Renders scheduled but not yet fired
    expect(callbacks.requestEditorRender).not.toHaveBeenCalled();
    expect(callbacks.requestStatusRender).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(callbacks.requestEditorRender).toHaveBeenCalledOnce();
    expect(callbacks.requestStatusRender).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Scenario 3: No state change → no rerender scheduled.
  // -------------------------------------------------------------------------
  it("no state change on second check does not schedule additional renders", () => {
    const editorTarget = { __editor: true };
    const callbacks = makeCallbacks(editorTarget);
    const detector = new SelectorDetector(callbacks);

    // Both checks use editorTui (inactive state); first check also finds no
    // prior state transition because we start inactive.
    const editorTui = makeTUI(editorTarget);

    // First check: inactive → inactive, no change
    const changed1 = detector.check(editorTui, null);
    expect(changed1).toBe(false);

    vi.runAllTimers(); // should flush nothing meaningful

    expect(callbacks.requestEditorRender).not.toHaveBeenCalled();
    expect(callbacks.requestStatusRender).not.toHaveBeenCalled();

    // Second consecutive check: still inactive → inactive
    const changed2 = detector.check(editorTui, null);
    expect(changed2).toBe(false);

    vi.runAllTimers();

    // Still not called after second check + timer flush
    expect(callbacks.requestEditorRender).not.toHaveBeenCalled();
    expect(callbacks.requestStatusRender).not.toHaveBeenCalled();
  });

  it("reset cancels a pending coordinated rerender", () => {
    const editorTarget = { __editor: true };
    const callbacks = makeCallbacks(editorTarget);
    const detector = new SelectorDetector(callbacks);

    detector.check(makeTUI({ __selector: true }), null);
    detector.reset();
    vi.runAllTimers();

    expect(callbacks.requestEditorRender).not.toHaveBeenCalled();
    expect(callbacks.requestStatusRender).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: setStatusRenderRef override is used when set.
  // -------------------------------------------------------------------------
  it("setStatusRenderRef override replaces callbacks.requestStatusRender on transition", () => {
    const editorTarget = { __editor: true };
    const callbacks = makeCallbacks(editorTarget);
    const detector = new SelectorDetector(callbacks);

    const customStatusRender = vi.fn();
    detector.setStatusRenderRef(customStatusRender);

    const selectorTui = makeTUI({ __selector: true });
    detector.check(selectorTui, null);

    vi.runAllTimers();

    // The ref override should be called instead of the callback
    expect(customStatusRender).toHaveBeenCalledOnce();
    expect(callbacks.requestStatusRender).not.toHaveBeenCalled();

    // Editor render is still called via the normal callback
    expect(callbacks.requestEditorRender).toHaveBeenCalledOnce();
  });

  it("fails open when private TUI capabilities are unavailable", () => {
    const editorTarget = { __editor: true };
    const callbacks = makeCallbacks(editorTarget);
    const detector = new SelectorDetector(callbacks);
    const unsupportedTui = {} as TUI;

    expect(() => isSelectorActive(unsupportedTui, editorTarget)).not.toThrow();
    expect(isSelectorActive(unsupportedTui, editorTarget)).toBe(false);
    expect(detector.check(unsupportedTui, null)).toBe(false);
    expect(detector.isSideBordersHidden()).toBe(false);
  });

  it("fails open when a private overlay probe throws", () => {
    const tui = {
      focusedComponent: { __selector: true },
      hasOverlay: () => {
        throw new Error("unsupported overlay probe");
      },
      doRender: vi.fn(),
      requestRender: vi.fn(),
    } as unknown as TUI;

    expect(() => isSelectorActive(tui, { __editor: true })).not.toThrow();
    expect(isSelectorActive(tui, { __editor: true })).toBe(false);
  });

  it("fails open when private render access throws", () => {
    const tui = {
      get doRender(): never {
        throw new Error("unsupported render probe");
      },
      set doRender(_value: () => void) {
        throw new Error("unsupported render patch");
      },
    } as unknown as TUI;

    expect(() => getDoRender(tui)).not.toThrow();
    expect(getDoRender(tui)).toBeNull();
    expect(() => setDoRender(tui, vi.fn())).not.toThrow();
    expect(setDoRender(tui, vi.fn())).toBe(false);
  });

  it("fails open when capability detection itself throws", () => {
    const tui = {} as Record<string, unknown>;
    Object.defineProperty(tui, "focusedComponent", { value: { __selector: true } });
    Object.defineProperty(tui, "hasOverlay", {
      get() {
        throw new Error("unsupported capability getter");
      },
    });

    expect(() => isSelectorActive(tui as unknown as TUI, { __editor: true })).not.toThrow();
    expect(isSelectorActive(tui as unknown as TUI, { __editor: true })).toBe(false);
  });
});
