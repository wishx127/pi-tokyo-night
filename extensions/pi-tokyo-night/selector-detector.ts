import type { TUI } from "@earendil-works/pi-tui";

/** Internal TUI properties used by selector and overlay detection. */
export interface TUIInternals {
  focusedComponent: unknown;
  hasOverlay(): boolean;
  doRender: () => void;
  requestRender(): void;
}

export interface SelectorDetectorCallbacks {
  getEditorFocusTarget(): unknown;
  requestEditorRender(): void;
  requestStatusRender(): void;
}

/**
 * Cast a TUI to the small private surface used by the adapters below.
 * Individual adapters perform their own capability checks because editor
 * render patching needs fewer fields than selector detection.
 */
export function asTUIInternals(tui: TUI | null): TUIInternals | null {
  if (tui === null || (typeof tui !== "object" && typeof tui !== "function")) {
    return null;
  }
  return tui as unknown as TUIInternals;
}

function hasSelectorCapabilities(
  internals: TUIInternals,
): boolean {
  return (
    "focusedComponent" in internals &&
    typeof internals.hasOverlay === "function"
  );
}

/** Read the current TUI render function while keeping the private API access
 *  in this adapter module. The returned function is bound to its TUI so it
 *  preserves the original call context when used by the editor patch. */
export function getDoRender(tui: TUI | null): (() => void) | null {
  try {
    const internals = asTUIInternals(tui);
    if (!internals || typeof internals.doRender !== "function") return null;
    return internals.doRender.bind(internals);
  } catch {
    return null;
  }
}

/** Replace the TUI render function through the private API adapter. */
export function setDoRender(
  tui: TUI | null,
  doRender: (() => void) | null,
): boolean {
  try {
    const internals = asTUIInternals(tui);
    if (!internals || !doRender) return false;
    internals.doRender = doRender;
    return true;
  } catch {
    // A private patch is optional; preserve native rendering if it is rejected.
    return false;
  }
}

/**
 * Check whether a selector has replaced the custom editor, or an overlay is
 * active. Selectors are detected by comparing the focused component with the
 * editor focus target supplied by the composition root.
 */
export function isSelectorActive(
  tui: TUI | null,
  editorFocusTarget: unknown,
): boolean {
  const internals = asTUIInternals(tui);
  if (!internals) return false;

  try {
    if (!hasSelectorCapabilities(internals)) return false;
    if (internals.focusedComponent === editorFocusTarget) return false;
    if (internals.hasOverlay()) return true;

    const overlayStack: unknown = Reflect.get(internals, "overlayStack");
    if (
      Array.isArray(overlayStack) &&
      overlayStack.some(
        (entry: { hidden?: boolean }) => entry && entry.hidden !== true,
      )
    ) {
      return true;
    }

    return internals.focusedComponent != null;
  } catch {
    // Private TUI probes are compatibility hints, not required behavior.
    return false;
  }
}

/**
 * Tracks selector state across the editor and root TUI instances and
 * coordinates re-rendering when that state changes.
 */
export class SelectorDetector {
  private _active = false;
  private readonly callbacks: SelectorDetectorCallbacks;
  private requestStatusRenderRef: (() => void) | null = null;
  private rerenderTimeout: ReturnType<typeof setTimeout> | undefined;

  /** The editor's own TUI. */
  editorTui: TUI | null = null;
  /** The root TUI, used as a secondary detection source. */
  overlayTui: TUI | null = null;

  constructor(callbacks: SelectorDetectorCallbacks) {
    this.callbacks = callbacks;
  }

  /** Whether a selector or overlay is currently active. */
  get isActive(): boolean {
    return this._active;
  }

  /** Store the session-level status render request function. */
  setStatusRenderRef(ref: (() => void) | null): void {
    this.requestStatusRenderRef = ref;
  }

  /** Check selector state from the supplied TUI references. */
  check(tui: TUI | null, overlayTui: TUI | null): boolean {
    const wasActive = this._active;
    const editorFocusTarget = this.callbacks.getEditorFocusTarget();
    this._active =
      isSelectorActive(tui, editorFocusTarget) ||
      isSelectorActive(overlayTui, editorFocusTarget);

    if (this._active !== wasActive) {
      this.scheduleRerender();
      return true;
    }
    return false;
  }

  /** Whether side borders should be hidden in the current context. */
  isSideBordersHidden(): boolean {
    return (
      this._active ||
      isSelectorActive(
        this.editorTui,
        this.callbacks.getEditorFocusTarget(),
      )
    );
  }

  /** Schedule coordinated rendering after the current render cycle. */
  private scheduleRerender(): void {
    if (this.rerenderTimeout !== undefined) {
      clearTimeout(this.rerenderTimeout);
    }
    this.rerenderTimeout = setTimeout(() => {
      this.rerenderTimeout = undefined;
      this.callbacks.requestEditorRender();
      (this.requestStatusRenderRef ?? this.callbacks.requestStatusRender)();
    }, 0);
  }

  /** Reset all selector detection state. */
  reset(): void {
    if (this.rerenderTimeout !== undefined) {
      clearTimeout(this.rerenderTimeout);
      this.rerenderTimeout = undefined;
    }
    this._active = false;
    this.requestStatusRenderRef = null;
    this.editorTui = null;
    this.overlayTui = null;
  }
}
