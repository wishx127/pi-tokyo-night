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
  requestRainRender(): void;
}

/** Cast TUI to the private properties used by selector detection. */
export function asTUIInternals(tui: TUI | null): TUIInternals | null {
  return tui as unknown as TUIInternals | null;
}

/** Read the current TUI render function while keeping the private API access
 *  in this adapter module. The returned function is bound to its TUI so it
 *  preserves the original call context when used by the editor patch. */
export function getDoRender(tui: TUI | null): (() => void) | null {
  const internals = asTUIInternals(tui);
  if (!internals || typeof internals.doRender !== "function") return null;
  return internals.doRender.bind(internals);
}

/** Replace the TUI render function through the private API adapter. */
export function setDoRender(
  tui: TUI | null,
  doRender: (() => void) | null,
): void {
  const internals = asTUIInternals(tui);
  if (!internals || !doRender) return;
  internals.doRender = doRender;
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
}

/**
 * Tracks selector state across the editor and root TUI instances and
 * coordinates re-rendering when that state changes.
 */
export class SelectorDetector {
  private _active = false;
  private readonly callbacks: SelectorDetectorCallbacks;
  private requestStatusRenderRef: (() => void) | null = null;

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
    setTimeout(() => {
      this.callbacks.requestEditorRender();
      (this.requestStatusRenderRef ?? this.callbacks.requestStatusRender)();
      this.callbacks.requestRainRender();
    }, 0);
  }

  /** Reset all selector detection state. */
  reset(): void {
    this._active = false;
    this.requestStatusRenderRef = null;
    this.editorTui = null;
    this.overlayTui = null;
  }
}
