/**
 * Tokyo Night Extension
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type KeybindingsManager,
  type Theme,
  type ReadonlyFooterDataProvider,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import fs from "node:fs";
import path from "node:path";

// ── Infrastructure ──────────────────────────────────────────────────────────

/** Unified log prefix for all extension error messages. */
const EXT_PREFIX = "[pi-tokyo-night]";

/** Check whether an error is caused by a stale extension context.
 *  Pi marks contexts as stale after session switch/reload; calling methods on
 *  a stale context throws. We detect this and degrade gracefully. */
function isStaleExtensionContextError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("This extension instance is stale");
}

/** Unified error handler for extension operations. Stale context errors are
 *  silently ignored (expected during shutdown); all other errors are logged
 *  with the standard prefix. */
function handleExtensionError(err: unknown, context: string): void {
  if (isStaleExtensionContextError(err)) return;
  console.error(`${EXT_PREFIX} ${context}:`, err);
}

// ── Pi SDK Type Supplements ──────────────────────────────────────────────────

/** Internal TUI properties accessed for selector/overlay detection.
 *  These are private in the SDK type definitions but are intentionally
 *  accessed for the extension's selector detection mechanism. This interface
 *  documents exactly which internal properties we rely on, replacing
 *  blanket `any` casts with targeted, documented type escapes.
 *
 *  NOTE: We use a standalone interface (not TUI & TUIInternals) because
 *  TypeScript reduces that intersection to `never` — private members in TUI
 *  and public members with the same name in TUIInternals are brand-checked
 *  and cannot overlap. Casting through `unknown` to TUIInternals gives us
 *  access to the documented internal properties while keeping the type
 *  specific and self-documenting. */
interface TUIInternals {
  focusedComponent: unknown;
  hasOverlay(): boolean;
  doRender: () => void;
  requestRender(): void;
}

/** Cast TUI to TUIInternals for selector detection.
 *  Uses `unknown` intermediate cast to bypass private member brand-checking.
 *  Returns null if input is null. */
function asTUIInternals(tui: TUI | null): TUIInternals | null {
  return tui as unknown as TUIInternals | null;
}

// ── Selector Detection ──────────────────────────────────────────────────────

/** Check whether a selector (e.g. Pi's /settings, /model, /tree) has replaced
 *  our custom editor. Pi's showSelector() mechanism clears editorContainer,
 *  adds a selector component, and changes focus away from our editor. This is
 *  NOT an overlay — it's an in-place editor replacement. We detect it by
 *  checking whether the TUI's focusedComponent is our BorderlessEditor. Also
 *  checks overlay stack as a secondary path for actual overlays (pushOverlay). */
function isSelectorActive(tui: TUI | null): boolean {
  const internals = asTUIInternals(tui);
  if (!internals) return false;
  // If our editor is focused, we're in normal mode — no selector
  if (internals.focusedComponent === BorderlessEditor.activeInstance) return false;
  // If something else has focus (SettingsSelector, ModelSelector, etc.)
  // AND it's not an overlay (overlays have their own stack), selector is active
  // Check overlay stack — if an overlay has focus, that's different
  if (internals.hasOverlay()) return true;
  const overlayStack: unknown = Reflect.get(internals, "overlayStack");
  if (Array.isArray(overlayStack) && overlayStack.some((e: { hidden?: boolean }) => e && e.hidden !== true)) return true;
  // Something else has focus and it's not an overlay → it's a selector
  return internals.focusedComponent != null;
}

// ── Tokyo Night ANSI Colors ─────────────────────────────────────────────────
// Pre-computed ANSI escape codes for the status bar gradient.
// These are custom RGB colors not available as theme tokens.
const PURPLE = "\x1b[38;2;187;154;247m"; // #bb9af7 - prompt char
const CYAN = "\x1b[38;2;125;202;247m"; // #7dcfff - rain drops
const RESET = "\x1b[0m";
const RESET_BG = "\x1b[49m";
const RESET_FG = "\x1b[39m";

// Rounded box-drawing characters used to wrap editor + status bar
// into a single cohesive card.
const BOX = {
  tl: "╭", // top-left
  tr: "╮", // top-right
  bl: "╰", // bottom-left
  br: "╯", // bottom-right
  h: "─", // horizontal
  v: "│", // vertical
} as const;
const FRAME_RGB = [61, 53, 119]; // #3d3577 - borderMuted, subtle purple frame

const fgRgb = (rgb: number[]): string =>
  `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const bgRgb = (rgb: number[]): string =>
  `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;

// Left module gradient (deep → light purple)
// NOTE: Not `as const` — mutable number[][] needed for Module type compatibility.
const MODULE_BG: number[][] = [
  [45, 27, 105], // Deep purple   #2d1b69
  [61, 43, 122], // Medium purple #3d2b7a
  [77, 59, 138], // Lighter purple #4d3b8a
  [93, 75, 154], // Light purple  #5d4b9a
];

const MODULE_FG: number[][] = [
  [200, 200, 255],
  [220, 220, 255],
  [240, 240, 255],
  [255, 255, 255],
];

// Right module colors
const TOKENS_BG = [109, 91, 170]; // Very light purple #6d5baa
const COST_BG = [93, 93, 93]; // Gray #5d5d5d

// ── Tokyo Night User Config ────────────────────────────────────────────────
// Persisted user personalization for the Tokyo Night extension. The panel
// toggle and rain animation parameters can be changed at runtime through the
// /tokyo-night settings overlay.
interface TokyoConfig {
  /** Show the top rain/moon/stars panel. */
  panel: boolean;
  /** Height of the rain panel in rows. */
  rainRows: number;
  /** Milliseconds between rain animation frames. */
  rainTickMs: number;
  /** Maximum number of simultaneous rain drops. */
  maxRainDrops: number;
}

const DEFAULT_CONFIG: TokyoConfig = {
  panel: true,
  rainRows: 3,
  rainTickMs: 130,
  maxRainDrops: 25,
};

// ── Rain Animation Types ────────────────────────────────────────────────────

interface RainDrop {
  col: number;
  row: number;
}

// Rain animation constants
const WIND_DRIFT = 1;
const WIND_PERIOD = 2;
const MOON = "🌙";
const MOON_FG = "\x1b[38;2;255;235;170m";
const MOON_COL = 2;
const MOON_ROW = 0;
const STAR = "✦";

// ── Settings Panel Types ────────────────────────────────────────────────────

type SettingKind = "toggle" | "number";

interface SettingDescriptor {
  id: keyof TokyoConfig;
  label: string;
  description: string;
  kind: SettingKind;
  min?: number;
  max?: number;
  step?: number;
}

const SETTINGS: SettingDescriptor[] = [
  {
    id: "panel",
    label: "Top Panel",
    description: "Show the rain/moon/stars panel above the editor",
    kind: "toggle",
  },
  {
    id: "rainRows",
    label: "Rain Rows",
    description: "Height of the rain panel (1-10)",
    kind: "number",
    min: 1,
    max: 10,
    step: 1,
  },
  {
    id: "rainTickMs",
    label: "Rain Tick (ms)",
    description: "Milliseconds between rain frames (50-1000)",
    kind: "number",
    min: 50,
    max: 1000,
    step: 10,
  },
  {
    id: "maxRainDrops",
    label: "Max Rain Drops",
    description: "Maximum simultaneous drops (5-100)",
    kind: "number",
    min: 5,
    max: 100,
    step: 5,
  },
];

// ── Manager Classes ──────────────────────────────────────────────────────────

/**
 * Manages Tokyo Night user configuration. Handles reading/writing
 * settings.json and provides access to the mutable config object.
 */
class TokyoConfigManager {
  private config: TokyoConfig = { ...DEFAULT_CONFIG };

  /** Get the mutable config object. Callers may read properties directly. */
  get(): TokyoConfig {
    return this.config;
  }

  /** Set a config value by key. TypeScript's indexed access types cannot
   *  narrow `TokyoConfig[keyof TokyoConfig]` for assignment based on
   *  runtime guards (setting.kind). This method centralizes the necessary
   *  type escape, keeping external callers type-safe. */
  set(key: keyof TokyoConfig, value: boolean | number): void {
    // Cast through `unknown` to bypass TypeScript's strict index signature check.
    // Runtime safety is guaranteed: callers only invoke this with valid key/value
    // pairs (guarded by setting.kind checks in SettingsUIController).
    (this.config as unknown as Record<string, boolean | number>)[key] = value;
  }

  /** Read config from settings.json. Falls back to defaults on error. */
  read(): void {
    try {
      const settingsPath = path.join(getAgentDir(), "settings.json");
      const content = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      const saved = settings["pi-tokyo-night"];
      if (saved && typeof saved === "object") {
        this.config = {
          panel:
            typeof saved.panel === "boolean" ? saved.panel : DEFAULT_CONFIG.panel,
          rainRows:
            typeof saved.rainRows === "number"
              ? saved.rainRows
              : DEFAULT_CONFIG.rainRows,
          rainTickMs:
            typeof saved.rainTickMs === "number"
              ? saved.rainTickMs
              : DEFAULT_CONFIG.rainTickMs,
          maxRainDrops:
            typeof saved.maxRainDrops === "number"
              ? saved.maxRainDrops
              : DEFAULT_CONFIG.maxRainDrops,
        };
      }
    } catch (err) {
      handleExtensionError(err, "readTokyoConfig");
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  /** Persist current config to settings.json. */
  write(): void {
    try {
      const settingsPath = path.join(getAgentDir(), "settings.json");
      const content = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      settings["pi-tokyo-night"] = { ...this.config };
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    } catch (err) {
      handleExtensionError(err, "writeTokyoConfig");
    }
  }

  /** Reset config to defaults (does NOT persist). */
  resetToDefaults(): void {
    this.config = { ...DEFAULT_CONFIG };
  }
}

/**
 * Manages the rain animation lifecycle: setup, teardown, tick, and render.
 * Encapsulates all rain-related state (drops, stars, interval, TUI reference).
 */
class RainAnimationManager {
  private config: TokyoConfigManager;
  private interval: ReturnType<typeof setInterval> | undefined;
  private drops: RainDrop[] = [];
  private lastWidth = 80;
  private widgetTui: TUI | null = null;
  private stars: Array<{ col: number; row: number }> = [];

  constructor(config: TokyoConfigManager) {
    this.config = config;
  }

  /** Set up the rain widget above the editor and start the animation timer. */
  setup(ui: ExtensionUIContext): void {
    this.stars = [
      { col: 5, row: 1 },
      { col: 8, row: 0 },
    ];

    this.drops = [];
    this.lastWidth = 80;
    this.widgetTui = null;

    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.tick(), this.config.get().rainTickMs);

    ui.setWidget(
      "tokyo-rain",
      (tui: TUI, _theme: Theme) => {
        this.widgetTui = tui;
        return {
          invalidate() {},
          render(width: number): string[] {
            return rainManager.renderWidget(width);
          },
          // Called by Pi when the widget is replaced or removed. Stop the
          // animation timer here so toggling the panel off via the slash
          // command does not leave a dangling interval triggering renders.
          dispose() {
            rainManager.disposeWidget();
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  /** Remove the rain widget and stop the animation timer. Idempotent. */
  teardown(ui: ExtensionUIContext): void {
    // setWidget(undefined) triggers the previous component's dispose(), which
    // clears the interval. We still clear here as a safety net for cases where
    // dispose() is not invoked (e.g. process exit).
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    ui.setWidget("tokyo-rain", undefined);
    this.drops = [];
    this.widgetTui = null;
  }

  /** Request a re-render of the rain widget TUI. Handles disposed TUI gracefully. */
  requestRender(): void {
    try {
      this.widgetTui?.requestRender();
    } catch (err) {
      if (isStaleExtensionContextError(err)) return;
      console.error(`${EXT_PREFIX} rain animation render request failed:`, err);
    }
  }

  /** Animation tick: advance drops, spawn new ones, request render. */
  private tick(): void {
    const cfg = this.config.get();
    for (const drop of this.drops) {
      drop.row += 1;
      if (drop.row % WIND_PERIOD === 0) {
        drop.col += WIND_DRIFT;
      }
    }
    this.drops = this.drops.filter(
      (d) => d.row < cfg.rainRows && d.col < this.lastWidth + 4,
    );
    if (this.drops.length < cfg.maxRainDrops) {
      // Scale spawn rate with desired density. The default (maxRainDrops=25)
      // spawns 2-3 per tick; higher values spawn proportionally more so the
      // steady-state visible count scales with the setting.
      const densityRatio = cfg.maxRainDrops / 25;
      const baseSpawn = Math.random() < 0.5 ? 3 : 2;
      const spawnCount = Math.min(
        Math.ceil(baseSpawn * densityRatio),
        cfg.maxRainDrops - this.drops.length,
      );
      for (let i = 0; i < spawnCount; i++) {
        this.drops.push({
          col: Math.floor(Math.random() * this.lastWidth * 0.9) - 2,
          row: 0,
        });
      }
    }
    this.requestRender();
  }

  /** Render the rain widget content. Delegated from the widget factory's render. */
  renderWidget(width: number): string[] {
    try {
      if (width < 10) return [];
      const cfg = this.config.get();
      const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;

      // When a selector has replaced our editor, remove only the │ side
      // borders from the rain widget. The ╭─╮ top border is kept — it
      // provides visual continuity as a header decoration even when the
      // middle area shows a selector. Only the │ side borders are removed
      // because they would appear broken where the selector doesn't have them.
      const hideSideBorders = selectorDetector.isSideBordersHidden();

      // In selector mode (no │ borders), content fills the full width.
      // In normal mode (│ on both sides), content fills width - 2.
      const innerWidth = Math.max(1, hideSideBorders ? width : width - 2);
      this.lastWidth = innerWidth;
      const lines: string[] = [];

      // Top border: ╭─╮ when │ side borders connect to the corners,
      // plain ─ horizontal line without corners when │ sides are hidden
      // (selector mode — corners look broken without connecting │).
      if (hideSideBorders) {
        lines.push(frameFg(BOX.h.repeat(width)));
      } else {
        lines.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
      }

      const dropSet = new Set<string>();
      for (const drop of this.drops) {
        if (
          drop.col >= 0 &&
          drop.col < innerWidth &&
          drop.row >= 0 &&
          drop.row < cfg.rainRows
        ) {
          dropSet.add(`${drop.col},${drop.row}`);
        }
      }

      const starSet = new Set<string>();
      for (const s of this.stars) {
        if (s.col < innerWidth && s.row < cfg.rainRows) {
          starSet.add(`${s.col},${s.row}`);
        }
      }

      const RAIN_DROP = "`";

      for (let r = 0; r < cfg.rainRows; r++) {
        let row = hideSideBorders ? "" : frameFg(BOX.v);
        for (let c = 0; c < innerWidth; c++) {
          if (r === MOON_ROW && c === MOON_COL) {
            row += `${MOON_FG}${MOON}${RESET}`;
            const mw = visibleWidth(MOON);
            if (mw > 1) c += mw - 1;
            continue;
          }
          if (dropSet.has(`${c},${r}`)) {
            row += `${CYAN}${RAIN_DROP}${RESET}`;
          } else if (starSet.has(`${c},${r}`)) {
            row += `${PURPLE}${STAR}${RESET}`;
          } else {
            row += " ";
          }
        }
        if (!hideSideBorders) {
          row += frameFg(BOX.v);
        }
        lines.push(row);
      }

      return lines;
    } catch (err) {
      handleExtensionError(err, "rain widget render");
      return [];
    }
  }

  /** Dispose the rain widget: clear interval and null TUI reference. */
  private disposeWidget(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.widgetTui = null;
  }
}

/**
 * Manages the editor-embedded settings panel UI state: navigation,
 * editing, and value adjustment. Encapsulates all settings-mode state.
 */
class SettingsUIController {
  private config: TokyoConfigManager;
  private mode = false;
  private selectedIndex = 0;
  private editing = false;
  private editValue = 0;

  constructor(config: TokyoConfigManager) {
    this.config = config;
  }

  /** Whether the settings panel is currently active. */
  get isActive(): boolean {
    return this.mode;
  }

  /** Enter settings mode (open the panel). */
  enter(): void {
    this.mode = true;
    this.selectedIndex = 0;
    this.editing = false;
  }

  /** Exit settings mode (close the panel) and persist config. */
  exit(): void {
    this.mode = false;
    this.config.write();
  }

  /** Handle keyboard input while the editor is in settings mode. */
  handleInput(data: string): boolean {
    if (this.editing) {
      const setting = SETTINGS[this.selectedIndex];
      if (setting.kind !== "number") return true;

      if (matchesKey(data, "up") || data === "+" || data === "=") {
        this.adjustValue(setting, 1);
      } else if (matchesKey(data, "down") || data === "-") {
        this.adjustValue(setting, -1);
      } else if (matchesKey(data, "enter")) {
        this.config.set(setting.id, this.editValue);
        this.editing = false;
      } else if (matchesKey(data, "esc")) {
        this.editing = false;
      }
    } else {
      if (matchesKey(data, "up")) {
        this.selectedIndex =
          (this.selectedIndex - 1 + SETTINGS.length) % SETTINGS.length;
      } else if (matchesKey(data, "down")) {
        this.selectedIndex = (this.selectedIndex + 1) % SETTINGS.length;
      } else if (matchesKey(data, "enter")) {
        const setting = SETTINGS[this.selectedIndex];
        if (setting.kind === "toggle") {
          this.config.set(setting.id, !(this.config.get()[setting.id] as boolean));
        } else {
          this.editValue = this.config.get()[setting.id] as number;
          this.editing = true;
        }
      } else if (matchesKey(data, "esc")) {
        this.exit();
        const editor = BorderlessEditor.activeInstance;
        if (editor) applyPanelState(editor.getUIContext());
      }
    }
    BorderlessEditor.activeInstance?.requestRender();
    return true;
  }

  /** Build the settings panel content lines for rendering. */
  buildLines(innerWidth: number): string[] {
    const lines: string[] = [];
    lines.push(`${CYAN}  Tokyo Night Settings`);

    for (let i = 0; i < SETTINGS.length; i++) {
      const setting = SETTINGS[i];
      const selected = i === this.selectedIndex;
      const cursor = selected ? (this.editing ? "❯❯" : "❯ ") : "  ";
      let valueStr: string;
      if (this.editing && selected && setting.kind === "number") {
        valueStr = String(this.editValue);
      } else if (setting.kind === "toggle") {
        valueStr = this.config.get()[setting.id] ? "On" : "Off";
      } else {
        valueStr = String(this.config.get()[setting.id]);
      }

      let line = `${cursor}${setting.label}: ${valueStr}`;
      if (selected) {
        line += `  ${fgRgb(FRAME_RGB)}${setting.description}${RESET}`;
      }
      lines.push(truncateToWidth(line, innerWidth));
    }

    const help = this.editing
      ? "  ↑/↓ adjust value, Enter confirm, Esc cancel"
      : "  ↑/↓ navigate, Enter toggle/edit, Esc save";
    lines.push(`${fgRgb(FRAME_RGB)}${help}${RESET}`);
    return lines;
  }

  /** Reset all settings UI state (called at session shutdown). */
  reset(): void {
    this.mode = false;
    this.selectedIndex = 0;
    this.editing = false;
    this.editValue = 0;
  }

  /** Adjust a numeric setting value by direction * step, clamped to min/max. */
  private adjustValue(setting: SettingDescriptor, direction: number): void {
    const step = setting.step ?? 1;
    const min = setting.min ?? -Infinity;
    const max = setting.max ?? Infinity;
    this.editValue = Math.max(
      min,
      Math.min(max, this.editValue + direction * step),
    );
  }
}

/**
 * Detects when Pi's selector (e.g. /settings, /model, /tree) replaces our
 * custom editor. Encapsulates the selectorActive flag and the TUI references
 * used for detection. Coordinates re-render across all widgets when state changes.
 */
class SelectorDetector {
  private _active = false;
  private requestStatusRenderRef: (() => void) | null = null;
  /** The editor's own TUI — set in BorderlessEditor constructor. */
  editorTui: TUI | null = null;
  /** The root TUI — set from footer callback. Secondary detection source. */
  overlayTui: TUI | null = null;

  /** Whether a selector or overlay is currently active (side borders should be hidden). */
  get isActive(): boolean {
    return this._active;
  }

  /** Store the session-level requestStatusRender function for coordinated re-render. */
  setStatusRenderRef(ref: (() => void) | null): void {
    this.requestStatusRenderRef = ref;
  }

  /** Check selector state from TUI references after a render cycle.
   *  Returns true if the active state changed, triggering coordinated re-render. */
  check(tui: TUI | null, overlayTui: TUI | null): boolean {
    const wasActive = this._active;
    this._active = isSelectorActive(tui) || isSelectorActive(overlayTui);
    if (this._active !== wasActive) {
      this.scheduleRerender();
      return true;
    }
    return false;
  }

  /** Whether │ side borders should be hidden in the current context.
   *  Combines the cached selectorActive flag with a live isSelectorActive
   *  check on editorTui to catch selectors in the same render cycle they appear. */
  isSideBordersHidden(): boolean {
    return this._active || isSelectorActive(this.editorTui);
  }

  /** Schedule a re-render of all custom components (editor, rain, status)
   *  when selector state changes. Uses setTimeout to avoid re-render within
   *  the current render cycle. */
  private scheduleRerender(): void {
    setTimeout(() => {
      BorderlessEditor.activeInstance?.requestRender();
      this.requestStatusRenderRef?.();
      rainManager.requestRender();
    }, 0);
  }

  /** Reset all selector detection state (called at session shutdown). */
  reset(): void {
    this._active = false;
    this.requestStatusRenderRef = null;
    this.editorTui = null;
    this.overlayTui = null;
  }
}

// ── Manager Instances (module-level, referenced by each other at runtime) ────

const configManager = new TokyoConfigManager();
const selectorDetector = new SelectorDetector();
const settingsController = new SettingsUIController(configManager);
const rainManager = new RainAnimationManager(configManager);

// ── Utility Functions ────────────────────────────────────────────────────────

/** Apply the current panel enabled state by setting up or tearing down the rain widget. */
function applyPanelState(ui: ExtensionUIContext): void {
  rainManager.teardown(ui);
  if (configManager.get().panel) {
    rainManager.setup(ui);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Borderless editor wrapped in a rounded card frame together with the status
 * bar below. Uses the official Editor.borderColor API to hide the editor's
 * own top/bottom border, then draws a shared rounded shell and prefixes the
 * first content line with a glowing prompt.
 */
class BorderlessEditor extends CustomEditor {
  static activeInstance: BorderlessEditor | null = null;
  // Saved original doRender to restore during shutdown.
  static originalDoRender: (() => void) | null = null;

  private uiContext: ExtensionUIContext;
  /** Stored TUI reference for requestRender() without relying on the SDK's
   *  private `tui` field on Editor. CustomEditor inherits from Editor which
   *  declares `protected tui: TUI` — accessible from subclasses but we keep
   *  our own explicit copy for clarity and to avoid any `as any` casts. */
  private tuiRef: TUI;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    uiContext: ExtensionUIContext,
    options?: EditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    this.uiContext = uiContext;
    this.tuiRef = tui;
    BorderlessEditor.activeInstance = this;
    selectorDetector.editorTui = tui;
    // Hide the top/bottom border lines using the official API.
    this.borderColor = () => "";

    // Monkey-patch tui.doRender to detect when a selector (like /settings,
    // /model, /tree) replaces our editor. Pi's showSelector() clears
    // editorContainer, adds a selector component, and changes focus away
    // from our editor. We detect this by checking focusedComponent after
    // each render cycle, since Pi calls doRender after updating focus.
    const internals = asTUIInternals(tui);
    const originalDoRender = internals!.doRender;
    if (typeof originalDoRender === "function") {
      BorderlessEditor.originalDoRender = originalDoRender.bind(internals!);
      internals!.doRender = () => {
        try {
          originalDoRender.call(internals!);
        } finally {
          // After Pi's render cycle, check if our editor is still focused.
          // selectorDetector.check() updates the active flag and triggers
          // coordinated re-render if state changed.
          selectorDetector.check(tui, selectorDetector.overlayTui);
        }
      };
    }
  }

  getUIContext(): ExtensionUIContext {
    return this.uiContext;
  }

  requestRender(): void {
    this.tuiRef.requestRender();
  }

  handleInput(data: string): void {
    // When a selector has replaced our editor, pass input through to the
    // default handler. The selector handles its own input via focusedComponent.
    if (selectorDetector.isSideBordersHidden()) {
      super.handleInput(data);
      return;
    }
    if (settingsController.isActive) {
      settingsController.handleInput(data);
      return;
    }
    super.handleInput(data);
  }

  render(width: number): string[] {
    try {
      if (width < 10) return super.render(width);

      // When a selector has replaced our editor (e.g. /settings, /model),
      // our custom │ frame borders would appear broken where the selector
      // takes over the editor area. Falling back to super.render() gives
      // the selector a clean base and hides │ borders entirely.
      if (selectorDetector.isSideBordersHidden()) {
        return super.render(width);
      }

      // Pi copies defaultEditor.borderColor into the custom editor after
      // construction, so we must re-apply the hidden border color on every
      // render to keep the top/bottom borders invisible.
      this.borderColor = () => "";

      return settingsController.isActive
        ? this.renderSettingsMode(width)
        : this.renderEditorMode(width);
    } catch (err) {
      handleExtensionError(err, "BorderlessEditor render");
      return super.render(width);
    }
  }

  private renderEditorMode(width: number): string[] {
    const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;

    // Prompt indicator: a simple neon chevron.
    const promptPrefix = ` ${PURPLE}❯${RESET} `;
    const contPrefix = " ".repeat(visibleWidth(promptPrefix));

    // Inner width inside the rounded card frame ("│" ... "│").
    const innerWidth = Math.max(1, width - 2);
    // Render the underlying editor at a narrower width so the prompt prefix
    // fits within the card interior.
    const contentWidth = Math.max(1, innerWidth - visibleWidth(promptPrefix));
    const lines = super.render(contentWidth);
    if (lines.length < 2) return lines;

    const result: string[] = [];

    // When the rain panel is disabled, the editor is the topmost element in
    // the card and must render its own rounded top border.
    if (!configManager.get().panel) {
      result.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
    }

    // Render content lines: skip the editor's own top border (lines[0]) and
    // drop its bottom border so the status bar sits flush below.
    const contentCount = lines.length - 1;
    let isFirstContentLine = true;
    for (let i = 0; i < contentCount; i++) {
      const prefix = isFirstContentLine ? promptPrefix : contPrefix;
      const content = truncateToWidth(`${prefix}${lines[i + 1]}`, innerWidth);
      const padLen = Math.max(0, innerWidth - visibleWidth(content));
      result.push(
        frameFg(BOX.v) + content + " ".repeat(padLen) + frameFg(BOX.v),
      );
      isFirstContentLine = false;
    }
    return result;
  }

  private renderSettingsMode(width: number): string[] {
    const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;
    const innerWidth = Math.max(1, width - 2);
    const result: string[] = [];

    // The settings panel is rendered inside the editor's rounded card frame.
    if (!configManager.get().panel) {
      result.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
    }

    const settingsLines = settingsController.buildLines(innerWidth);
    for (const line of settingsLines) {
      const padded =
        line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      result.push(frameFg(BOX.v) + padded + frameFg(BOX.v));
    }
    return result;
  }
}

export default function (pi: ExtensionAPI) {
  // ── Per-Extension State (scoped inside the function) ─────────────────────
  let editorUIContext: ExtensionUIContext | null = null;
  let reapplyEditorTimeout: ReturnType<typeof setTimeout> | undefined;
  // The setWidget interception forwards calls to the original overloaded method.
  // TypeScript can't verify that a single function signature satisfies both
  // overloads of setWidget, so we use a documented minimal type escape for the
  // forwarding. This is one of the few remaining `any` usages, justified by
  // the overloaded method forwarding pattern.
  let origSetWidget: ((...args: any[]) => any) | null = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let statusRenderDebounceTimeout: ReturnType<typeof setTimeout> | undefined;

  // Stable factory so we can re-apply after resetExtensionUI() clears
  // setEditorComponent. Captures editorUIContext via closure.
  const borderlessEditorFactory = (
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options?: EditorOptions,
  ) => new BorderlessEditor(tui, theme, keybindings, editorUIContext!, options);

  // ── agent_start guard (registered once at extension level) ───────────────
  // resetExtensionUI() re-enables workingVisible, and agent_start creates a
  // loader when it is true. We keep it off by re-hiding on every agent start.
  pi.on("agent_start", async (_event, _ctx) => {
    try {
      const ui = editorUIContext ?? _ctx.ui;
      ui.setWorkingVisible(false);
    } catch (err) {
      handleExtensionError(err, "agent_start guard");
    }
  });

  // ── Async git branch detection ───────────────────────────────────────────
  const getGitBranchFallback = async (cwd: string): Promise<string> => {
    try {
      const result = await pi.exec(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, timeout: 2000 },
      );
      return result.code === 0 ? result.stdout.trim() : "";
    } catch (err) {
      handleExtensionError(err, "getGitBranch fallback");
      return "";
    }
  };

  pi.on("session_start", async (event, ctx) => {
    editorUIContext = ctx.ui;
    configManager.read();

    // Per-session branch cache (isolated from other sessions)
    let cachedBranch = "";
    let branchCacheTime = 0;
    let branchPending = false;
    const BRANCH_CACHE_TTL = 5000;

    const updateBranch = async (cwd: string) => {
      const now = Date.now();
      if (!branchPending && now - branchCacheTime > BRANCH_CACHE_TTL) {
        branchPending = true;
        branchCacheTime = now;
        try {
          // Prefer footerData.getGitBranch() (Pi's built-in, cached, robust);
          // note: getGitBranch() is synchronous in the SDK (returns string | null),
          // but we await the result for uniform handling with the async fallback.
          // fall back to manual git exec if footerData is unavailable.
          cachedBranch = footerDataRef
            ? (footerDataRef.getGitBranch() ?? "")
            : await getGitBranchFallback(cwd);
        } catch (err) {
          if (isStaleExtensionContextError(err)) {
            // Stale context is expected during shutdown — skip silently.
            return;
          }
          console.error(`${EXT_PREFIX} branch update failed:`, err);
        } finally {
          branchPending = false;
        }
      }
    };

    // ── Register custom editor (wrapping previous) ────────────────────────
    ctx.ui.setEditorComponent(borderlessEditorFactory);
    ctx.ui.setWorkingVisible(false);

    // ── Poll for resetExtensionUI() only on startup/reload ────────────────
    // Pi calls resetExtensionUI() during startup rebinding, which clears
    // the custom editor. Only "startup" and "reload" trigger this; session
    // switches (new/resume/fork) don't need the polling workaround.
    const needsReapply = event.reason === "startup" || event.reason === "reload";
    if (needsReapply) {
      const MAX_REAPPLY_MS = 2000;
      const POLL_INTERVAL_MS = 150;
      const reapplyStart = Date.now();

      function pollEditorRegistration() {
        const elapsed = Date.now() - reapplyStart;
        if (elapsed >= MAX_REAPPLY_MS) {
          reapplyEditorTimeout = undefined;
          return;
        }
        reapplyEditorTimeout = setTimeout(() => {
          try {
            const currentFactory =
              typeof ctx.ui.getEditorComponent === "function"
                ? ctx.ui.getEditorComponent()
                : undefined;
            if (currentFactory !== borderlessEditorFactory) {
              // Our factory was cleared by resetExtensionUI().
              ctx.ui.setEditorComponent(borderlessEditorFactory);
              ctx.ui.setWorkingVisible(false);
            }
          } catch (err) {
            if (isStaleExtensionContextError(err)) {
              reapplyEditorTimeout = undefined;
              return; // stop polling on stale context
            }
            console.error(`${EXT_PREFIX} editor re-apply poll failed:`, err);
          }
          pollEditorRegistration();
        }, POLL_INTERVAL_MS);
      }
      pollEditorRegistration();
    }

    // ── Intercept setWidget to drop "agents" widget ───────────────────────
    // @tintinweb/pi-subagents registers an "agents" widget that duplicates
    // agent info already in the chat area. Its 80ms timer re-registers
    // continuously, so clearing it once doesn't work. We intercept setWidget.
    origSetWidget = ctx.ui.setWidget.bind(ctx.ui);
    ctx.ui.setWidget = (key: string, ...args: unknown[]) => {
      if (key === "agents") return;
      // Forwarding to the original overloaded setWidget method.
      // Must include `key` as the first argument — `args` only contains
      // the parameters after `key` (content, options).
      return origSetWidget!.call(ctx.ui, key, ...args as any[]);
    };

    // ── Rain widget ───────────────────────────────────────────────────────
    if (configManager.get().panel) {
      rainManager.setup(ctx.ui);
    }

    // ── Status bar widget with debounce ────────────────────────────────────
    const STATUS_DEBOUNCE_MS = 33;
    let statusTui: TUI | null = null;

    const requestStatusRender = () => {
      if (statusRenderDebounceTimeout) clearTimeout(statusRenderDebounceTimeout);
      statusRenderDebounceTimeout = setTimeout(() => {
        statusRenderDebounceTimeout = undefined;
        try {
          statusTui?.requestRender();
        } catch (err) {
          if (isStaleExtensionContextError(err)) {
            statusTui = null;
          } else {
            console.error(`${EXT_PREFIX} status render request failed:`, err);
          }
        }
      }, STATUS_DEBOUNCE_MS);
    };

    // Store the requestStatusRender reference so selector state changes
    // can trigger status bar re-render.
    selectorDetector.setStatusRenderRef(requestStatusRender);

    ctx.ui.setWidget(
      "tokyo-status",
      (tui: TUI, theme: Theme) => {
        statusTui = tui;
        return {
          invalidate() {
            requestStatusRender();
          },
          render(width: number): string[] {
            try {
              const cwd = ctx.cwd;
              updateBranch(cwd);

              const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;

              // selectorDetector.isSideBordersHidden() combines the cached
              // active flag with a live check on editorTui, catching selectors
              // in the same render cycle they appear.
              const hideSideBorders = selectorDetector.isSideBordersHidden();

              // In selector mode (no │ borders), content fills full width.
              // In normal mode (│ on both sides), content fills width - 2.
              const innerWidth = Math.max(1, hideSideBorders ? width : width - 2);
              const statusLine = buildStatusLine(
                innerWidth,
                theme,
                ctx,
                cachedBranch,
                pi.getThinkingLevel(),
              );
              const statusContent = truncateToWidth(statusLine, innerWidth);
              const padLen = Math.max(
                0,
                innerWidth - visibleWidth(statusContent),
              );

              // Bottom border: ╰─╯ when │ side borders connect to corners,
              // plain ─ horizontal line without corners when │ sides are hidden
              // (selector mode — corners look broken without connecting │).
              const bottomLine = hideSideBorders
                ? frameFg(BOX.h.repeat(width))
                : frameFg(`${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}`);

              // When a selector has replaced our editor, remove only the │ side
              // borders. The bottom ─ line is kept — it provides visual
              // continuity as a footer decoration without disconnected corners.
              if (hideSideBorders) {
                const selectorBodyLine =
                  statusContent +
                  " ".repeat(padLen);
                return [selectorBodyLine, bottomLine];
              }

              const bodyLine =
                frameFg(BOX.v) +
                statusContent +
                " ".repeat(padLen) +
                frameFg(BOX.v);

              return [bodyLine, bottomLine];
            } catch (err) {
              if (isStaleExtensionContextError(err)) return [];
              console.error(`${EXT_PREFIX} status render failed:`, err);
              return [];
            }
          },
        };
      },
      { placement: "belowEditor" },
    );

    // ── Footer: participate in Footer Data Provider ───────────────────────
    // Instead of hiding the footer entirely, we register a component that
    // subscribes to footerData (git branch, extension statuses) and returns
    // an empty render. This keeps other extensions' statuses accessible via
    // footerData while our status bar widget replaces the footer visually.
    ctx.ui.setFooter(
      (tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        // The footer callback receives the root TUI. Store it as a secondary
        // source for selector detection (checking focusedComponent) alongside
        // the editor TUI.
        selectorDetector.overlayTui = tui;
        footerDataRef = footerData;
        // Hook onBranchChange to auto-trigger status bar re-render —
        // no need for our manual git branch cache refresh interval.
        const unsub = footerData.onBranchChange(() => requestStatusRender());

        return {
          dispose() {
            unsub();
            footerDataRef = null;
          },
          invalidate() {
            requestStatusRender();
          },
          render(): string[] {
            return []; // empty — our status bar widget replaces the footer visually
          },
        };
      },
    );
  });

  // Slash command: /tokyo-night — toggle the editor-embedded settings panel.
  pi.registerCommand("tokyo-night", {
    description:
      "Open the Tokyo Night settings panel. Usage: /tokyo-night [on|off]",
    handler: async (args: string, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on" || arg === "off") {
        configManager.get().panel = arg === "on";
        configManager.write();
        if (!ctx.hasUI) return;
        try {
          applyPanelState(ctx.ui);
          ctx.ui.notify(`Tokyo Night panel ${arg}`, "info");
        } catch (err) {
          handleExtensionError(err, "panel toggle");
        }
        return;
      }

      if (!ctx.hasUI) {
        console.log(`${EXT_PREFIX} Settings panel is only available in interactive mode.`);
        return;
      }

      if (settingsController.isActive) {
        settingsController.exit();
        try {
          applyPanelState(ctx.ui);
        } catch (err) {
          handleExtensionError(err, "settings save");
        }
      } else {
        settingsController.enter();
      }
      BorderlessEditor.activeInstance?.requestRender();
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // ── Cancel all timers ──────────────────────────────────────────────────
    if (reapplyEditorTimeout) {
      clearTimeout(reapplyEditorTimeout);
      reapplyEditorTimeout = undefined;
    }
    if (statusRenderDebounceTimeout) {
      clearTimeout(statusRenderDebounceTimeout);
      statusRenderDebounceTimeout = undefined;
    }
    // ── Restore doRender monkey-patch ────────────────────────────────────────
    const internals = asTUIInternals(selectorDetector.editorTui);
    if (BorderlessEditor.originalDoRender && internals) {
      try {
        internals.doRender = BorderlessEditor.originalDoRender;
      } catch (err) {
        if (isStaleExtensionContextError(err)) return;
        console.error(`${EXT_PREFIX} doRender restore failed:`, err);
      }
    }

    // ── Restore setWidget monkey-patch ─────────────────────────────────────
    if (origSetWidget && ctx.hasUI) {
      try {
        ctx.ui.setWidget = origSetWidget;
      } catch (err) {
        if (isStaleExtensionContextError(err)) return;
        console.error(`${EXT_PREFIX} setWidget restore failed:`, err);
      }
      origSetWidget = null;
    }

    // ── Reset all per-session state ────────────────────────────────────────
    editorUIContext = null;
    footerDataRef = null;
    selectorDetector.reset();
    settingsController.reset();
    BorderlessEditor.activeInstance = null;
    BorderlessEditor.originalDoRender = null;

    // ── Guard non-interactive modes ────────────────────────────────────────
    if (!ctx.hasUI) {
      rainManager.teardown(ctx.ui);
      return;
    }

    // ── Full UI teardown ───────────────────────────────────────────────────
    rainManager.teardown(ctx.ui);
    ctx.ui.setWidget("tokyo-status", undefined);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setFooter(undefined);
  });
}

function buildStatusLine(
  width: number,
  theme: Theme,
  ctx: ExtensionContext,
  branch: string,
  thinkingLevel: string,
): string {
  // Use a slightly smaller width to account for potential width miscalculations
  // with Nerd Font glyphs that may be rendered as double-width by the terminal
  // but counted as single-width by visibleWidth()
  const safeWidth = Math.max(1, width - 2);
  let input = 0,
    output = 0,
    cost = 0;
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        input += m.usage.input;
        output += m.usage.output;
        cost += m.usage.cost.total;
      }
    }
  } catch (err) {
    handleExtensionError(err, "session stats");
  }

  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  const fmtCost = (c: number) =>
    c < 0.01 ? `${c.toFixed(3)}` : `${c.toFixed(2)}`;

  const modelId = ctx.model?.id || ctx.model?.name || "pi-agent";

  const cwd = ctx.cwd;

  const totalTokens = input + output;
  let maxCtx = 128000;
  if (ctx.model?.contextWindow) maxCtx = ctx.model.contextWindow;
  const pct =
    totalTokens > 0
      ? Math.min(100, Math.round((totalTokens / maxCtx) * 100))
      : 0;

  const barColor = pct >= 50 ? "error" : pct >= 30 ? "warning" : "accent";
  const filled = Math.round((pct / 100) * 8);
  const progressBar =
    theme.fg(barColor, "█".repeat(filled)) +
    theme.fg("dim", "░".repeat(8 - filled));

  // Build left modules (model, thinking, path, branch) - purple gradient
  const leftModules = [
    { text: `\uE795 ${shortName(modelId)}`, bg: 0, fg: 0 },
    { text: `⚡ ${thinkingLevel}`, bg: 1, fg: 1 },
    { text: `\uF07B ${shortenPath(cwd)}`, bg: 2, fg: 2 },
    ...(branch ? [{ text: `\uE0A0 ${branch}`, bg: 3, fg: 3 }] : []),
  ];

  // Build right modules (tokens, cost, progress)
  const rightModules = [
    {
      text: `Σ ${fmt(totalTokens)} tokens`,
      bgColor: TOKENS_BG as number[],
      textColor: [255, 255, 200] as number[],
    },
    {
      text: `$${fmtCost(cost)}`,
      bgColor: COST_BG as number[],
      textColor: [200, 255, 200] as number[],
    },
    {
      text: `${progressBar} ${pct}%/${fmt(maxCtx)}`,
      bgColor: null as number[] | null,
      textColor: [255, 200, 200] as number[],
    },
  ];

  // Unified module type: left modules use gradient indices, right modules use explicit colors
  type Module =
    | { text: string; bg: number; fg: number }
    | { text: string; bgColor: number[] | null; textColor: number[] };

  const getModuleBg = (m: Module): number[] | null =>
    "bg" in m ? MODULE_BG[m.bg] : m.bgColor;
  const getModuleFg = (m: Module): number[] =>
    "fg" in m ? MODULE_FG[m.fg] : m.textColor;

  // Powerline transition arrow between two modules (1-char wide)
  const buildTransition = (from: Module, to: Module): string => {
    const c1 = getModuleBg(from);
    const c2 = getModuleBg(to);
    const bg = c2 === null ? RESET_BG : bgRgb(c2);
    const fg = c1 === null ? RESET_FG : fgRgb(c1);
    return `${bg}${fg}\uE0B0${RESET_BG}${RESET_FG}`;
  };

  // Build a section (array of modules) with Powerline transitions
  const buildSection = (modules: Module[]) => {
    let result = "";
    let currentWidth = 0;

    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      const bgColor = getModuleBg(m);
      const textColor = getModuleFg(m);

      const bgCode = bgColor === null ? RESET_BG : bgRgb(bgColor);
      const fgCode = fgRgb(textColor);

      // Powerline transition before module (except first)
      if (i > 0) {
        result += buildTransition(modules[i - 1], m);
        currentWidth += 1;
      }

      const moduleText = ` ${m.text} `;
      result += `${bgCode}${fgCode}${moduleText}${RESET_BG}${RESET_FG}`;
      currentWidth += visibleWidth(moduleText);
    }

    return { result, currentWidth };
  };

  const leftSection = buildSection(leftModules);
  const rightSection = buildSection(rightModules);

  // Padding uses last left module's bg color
  const lastLeftBg = getModuleBg(leftModules[leftModules.length - 1]);
  const paddingBgCode = lastLeftBg === null ? RESET_BG : bgRgb(lastLeftBg);

  // Bridge transition from padding to first right module
  const bridgeTransition = buildTransition(
    leftModules[leftModules.length - 1],
    rightModules[0],
  );

  const paddingWidth = Math.max(
    1,
    safeWidth - leftSection.currentWidth - 1 - rightSection.currentWidth,
  );
  const padding = `${paddingBgCode}${" ".repeat(paddingWidth)}${RESET_BG}`;

  return truncateToWidth(
    leftSection.result + padding + bridgeTransition + rightSection.result,
    width,
  );
}

function shortName(id: string): string {
  if (!id || id === "pi-agent") return "pi-agent";
  return id.length > 30 ? id.slice(0, 28) + ".." : id;
}

function shortenPath(p: string): string {
  if (!p) return ".";
  // Replace home directory with ~
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) {
    p = "~" + p.slice(home.length);
  }
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 4) return p;
  return "~/…/" + parts.slice(-2).join("/");
}
