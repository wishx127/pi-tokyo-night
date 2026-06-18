/**
 * Tokyo Night Extension
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionUIContext,
  type KeybindingsManager,
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
const MODULE_BG = [
  [45, 27, 105], // Deep purple   #2d1b69
  [61, 43, 122], // Medium purple #3d2b7a
  [77, 59, 138], // Lighter purple #4d3b8a
  [93, 75, 154], // Light purple  #5d4b9a
] as const;

const MODULE_FG = [
  [200, 200, 255],
  [220, 220, 255],
  [240, 240, 255],
  [255, 255, 255],
] as const;

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

let tokyoConfig: TokyoConfig = { ...DEFAULT_CONFIG };

// ── Rain Animation State (module-level for runtime toggling) ─────────────────
interface RainDrop {
  col: number;
  row: number;
}
let rainInterval: ReturnType<typeof setInterval> | undefined;
let rainDrops: RainDrop[] = [];
let lastRainWidth = 80;
let rainWidgetTui: TUI | null = null;

// Other rain widget constants
const WIND_DRIFT = 1;
const WIND_PERIOD = 2;
const MOON = "🌙";
const MOON_FG = "\x1b[38;2;255;235;170m";
const MOON_COL = 2;
const MOON_ROW = 0;
const STAR = "✦";

// Stars are regenerated each time the rain widget is set up.
let stars: Array<{ col: number; row: number }> = [];

/** Read Tokyo Night config from settings.json. Falls back to defaults. */
function readTokyoConfig(): TokyoConfig {
  try {
    const settingsPath = path.join(getAgentDir(), "settings.json");
    const content = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    const saved = settings["pi-tokyo-night"];
    if (saved && typeof saved === "object") {
      return {
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
    console.error("[tokyo-night] readTokyoConfig failed:", err);
  }
  return { ...DEFAULT_CONFIG };
}

/** Persist Tokyo Night config to settings.json. */
function writeTokyoConfig(config: TokyoConfig): void {
  try {
    const settingsPath = path.join(getAgentDir(), "settings.json");
    const content = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    settings["pi-tokyo-night"] = { ...config };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    console.error("[tokyo-night] writeTokyoConfig failed:", err);
  }
}

/** Apply the current panel enabled state by setting up or tearing down the rain widget. */
function applyPanelState(ui: ExtensionUIContext): void {
  teardownRainWidget(ui);
  if (tokyoConfig.panel) {
    setupRainWidget(ui);
  }
}

/** Set up the rain widget above the editor and start the animation timer. */
function setupRainWidget(ui: ExtensionUIContext): void {
  stars = [
    { col: 5, row: 1 },
    { col: 8, row: 0 },
  ];

  rainDrops = [];
  lastRainWidth = 80;
  rainWidgetTui = null;

  if (rainInterval) clearInterval(rainInterval);
  rainInterval = setInterval(() => {
    for (const drop of rainDrops) {
      drop.row += 1;
      if (drop.row % WIND_PERIOD === 0) {
        drop.col += WIND_DRIFT;
      }
    }
    rainDrops = rainDrops.filter(
      (d) => d.row < tokyoConfig.rainRows && d.col < lastRainWidth + 4,
    );
    if (rainDrops.length < tokyoConfig.maxRainDrops) {
      // Scale spawn rate with desired density. The default (maxRainDrops=25)
      // spawns 2-3 per tick; higher values spawn proportionally more so the
      // steady-state visible count scales with the setting.
      const densityRatio = tokyoConfig.maxRainDrops / 25;
      const baseSpawn = Math.random() < 0.5 ? 3 : 2;
      const spawnCount = Math.min(
        Math.ceil(baseSpawn * densityRatio),
        tokyoConfig.maxRainDrops - rainDrops.length,
      );
      for (let i = 0; i < spawnCount; i++) {
        rainDrops.push({
          col: Math.floor(Math.random() * lastRainWidth * 0.9) - 2,
          row: 0,
        });
      }
    }
    rainWidgetTui?.requestRender();
  }, tokyoConfig.rainTickMs);

  ui.setWidget(
    "tokyo-rain",
    (tui: TUI, _theme: EditorTheme) => {
      rainWidgetTui = tui;
      return {
        invalidate() {},
        render(width: number): string[] {
          try {
            if (width < 10) return [];
            const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;
            const innerWidth = Math.max(1, width - 2);
            lastRainWidth = innerWidth;
            const lines: string[] = [];

            lines.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));

            const dropSet = new Set<string>();
            for (const drop of rainDrops) {
              if (
                drop.col >= 0 &&
                drop.col < innerWidth &&
                drop.row >= 0 &&
                drop.row < tokyoConfig.rainRows
              ) {
                dropSet.add(`${drop.col},${drop.row}`);
              }
            }

            const starSet = new Set<string>();
            for (const s of stars) {
              if (s.col < innerWidth && s.row < tokyoConfig.rainRows) {
                starSet.add(`${s.col},${s.row}`);
              }
            }

            const RAIN_DROP = "`";

            for (let r = 0; r < tokyoConfig.rainRows; r++) {
              let row = frameFg(BOX.v);
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
              row += frameFg(BOX.v);
              lines.push(row);
            }
            return lines;
          } catch (err) {
            console.error("[pi-tokyo-night] rain widget render failed:", err);
            return [];
          }
        },
        // Called by Pi when the widget is replaced or removed. Stop the
        // animation timer here so toggling the panel off via the slash
        // command does not leave a dangling interval triggering renders.
        dispose() {
          if (rainInterval) {
            clearInterval(rainInterval);
            rainInterval = undefined;
          }
          rainWidgetTui = null;
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/** Remove the rain widget and stop the animation timer. Idempotent. */
function teardownRainWidget(ui: ExtensionUIContext): void {
  // setWidget(undefined) triggers the previous component's dispose(), which
  // clears the interval. We still clear here as a safety net for cases where
  // dispose() is not invoked (e.g. process exit).
  if (rainInterval) {
    clearInterval(rainInterval);
    rainInterval = undefined;
  }
  ui.setWidget("tokyo-rain", undefined);
  rainDrops = [];
  rainWidgetTui = null;
}

// ── Settings Panel ──────────────────────────────────────────────────────────

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

// ── Editor-Embedded Settings State ──────────────────────────────────────────

let settingsMode = false;
let settingsSelectedIndex = 0;
let settingsEditing = false;
let settingsEditValue = 0;

/** Handle keyboard input while the editor is in settings mode. */
function handleSettingsInput(data: string): boolean {
  if (settingsEditing) {
    const setting = SETTINGS[settingsSelectedIndex];
    if (setting.kind !== "number") return true;

    if (matchesKey(data, "up") || data === "+" || data === "=") {
      adjustSettingsValue(setting, 1);
    } else if (matchesKey(data, "down") || data === "-") {
      adjustSettingsValue(setting, -1);
    } else if (matchesKey(data, "enter")) {
      (tokyoConfig[setting.id] as number) = settingsEditValue;
      settingsEditing = false;
    } else if (matchesKey(data, "esc")) {
      settingsEditing = false;
    }
  } else {
    if (matchesKey(data, "up")) {
      settingsSelectedIndex =
        (settingsSelectedIndex - 1 + SETTINGS.length) % SETTINGS.length;
    } else if (matchesKey(data, "down")) {
      settingsSelectedIndex = (settingsSelectedIndex + 1) % SETTINGS.length;
    } else if (matchesKey(data, "enter")) {
      const setting = SETTINGS[settingsSelectedIndex];
      if (setting.kind === "toggle") {
        tokyoConfig[setting.id] = !tokyoConfig[setting.id] as any;
      } else {
        settingsEditValue = tokyoConfig[setting.id] as number;
        settingsEditing = true;
      }
    } else if (matchesKey(data, "esc")) {
      writeTokyoConfig(tokyoConfig);
      settingsMode = false;
      const editor = BorderlessEditor.activeInstance;
      if (editor) applyPanelState(editor.getUIContext());
    }
  }
  BorderlessEditor.activeInstance?.requestRender();
  return true;
}

function adjustSettingsValue(
  setting: SettingDescriptor,
  direction: number,
): void {
  const step = setting.step ?? 1;
  const min = setting.min ?? -Infinity;
  const max = setting.max ?? Infinity;
  settingsEditValue = Math.max(
    min,
    Math.min(max, settingsEditValue + direction * step),
  );
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

  private uiContext: ExtensionUIContext;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    uiContext: ExtensionUIContext,
    options?: EditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    this.uiContext = uiContext;
    BorderlessEditor.activeInstance = this;
    // Hide the top/bottom border lines using the official API.
    this.borderColor = () => "";
  }

  getUIContext(): ExtensionUIContext {
    return this.uiContext;
  }

  requestRender(): void {
    (this as any).tui?.requestRender();
  }

  handleInput(data: string): void {
    if (settingsMode) {
      handleSettingsInput(data);
      return;
    }
    super.handleInput(data);
  }

  render(width: number): string[] {
    try {
      if (width < 10) return super.render(width);

      // Pi copies defaultEditor.borderColor into the custom editor after
      // construction, so we must re-apply the hidden border color on every
      // render to keep the top/bottom borders invisible.
      this.borderColor = () => "";

      return settingsMode
        ? this.renderSettingsMode(width)
        : this.renderEditorMode(width);
    } catch (err) {
      console.error("[pi-tokyo-night] BorderlessEditor render failed:", err);
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
    if (!tokyoConfig.panel) {
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
    if (!tokyoConfig.panel) {
      result.push(frameFg(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
    }

    const settingsLines = this.buildSettingsLines(innerWidth);
    for (const line of settingsLines) {
      const padded =
        line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      result.push(frameFg(BOX.v) + padded + frameFg(BOX.v));
    }
    return result;
  }

  private buildSettingsLines(innerWidth: number): string[] {
    const lines: string[] = [];
    lines.push(`${CYAN}  Tokyo Night Settings`);

    for (let i = 0; i < SETTINGS.length; i++) {
      const setting = SETTINGS[i];
      const selected = i === settingsSelectedIndex;
      const cursor = selected ? (settingsEditing ? "❯❯" : "❯ ") : "  ";
      let valueStr: string;
      if (settingsEditing && selected && setting.kind === "number") {
        valueStr = String(settingsEditValue);
      } else if (setting.kind === "toggle") {
        valueStr = tokyoConfig[setting.id] ? "On" : "Off";
      } else {
        valueStr = String(tokyoConfig[setting.id]);
      }

      let line = `${cursor}${setting.label}: ${valueStr}`;
      if (selected) {
        line += `  ${fgRgb(FRAME_RGB)}${setting.description}${RESET}`;
      }
      lines.push(truncateToWidth(line, innerWidth));
    }

    const help = settingsEditing
      ? "  ↑/↓ adjust value, Enter confirm, Esc cancel"
      : "  ↑/↓ navigate, Enter toggle/edit, Esc save";
    lines.push(`${fgRgb(FRAME_RGB)}${help}${RESET}`);
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  // Minimal footer component that renders nothing (hides default footer)
  const HIDDEN_FOOTER = { invalidate() {}, render: () => [] as string[] };

  // Async git branch detection using pi.exec()
  const getGitBranch = async (cwd: string): Promise<string> => {
    try {
      const result = await pi.exec(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        {
          cwd,
          timeout: 2000,
        },
      );
      return result.code === 0 ? result.stdout.trim() : "";
    } catch (err) {
      console.error("[tokyo-night] getGitBranch failed:", err);
      return "";
    }
  };

  // Stable factory so we can re-apply the custom editor after Pi's startup
  // rebinding resets the UI (resetExtensionUI() clears setEditorComponent).
  // Captures the session's UI context so the editor can re-apply widgets when
  // settings change.
  let editorUIContext: ExtensionUIContext | null = null;
  const borderlessEditorFactory = (
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
  ) => new BorderlessEditor(tui, theme, keybindings, editorUIContext!);

  let reapplyEditorTimeout: ReturnType<typeof setTimeout> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    editorUIContext = ctx.ui;
    // Read Tokyo Night config (default values are used when missing)
    tokyoConfig = readTokyoConfig();
    // Per-session branch cache (isolated from other sessions)
    let cachedBranch = "";
    let branchCacheTime = 0;
    let branchPending = false;
    const BRANCH_CACHE_TTL = 5000; // 5 seconds

    const updateBranch = async (cwd: string) => {
      const now = Date.now();
      if (!branchPending && now - branchCacheTime > BRANCH_CACHE_TTL) {
        branchPending = true;
        branchCacheTime = now;
        try {
          cachedBranch = await getGitBranch(cwd);
        } finally {
          branchPending = false;
        }
      }
    };
    ctx.ui.setEditorComponent(borderlessEditorFactory);

    // Workaround: Pi calls resetExtensionUI() during startup/session rebinding,
    // which clears the custom editor set above. Re-apply once after the rebind.
    if (reapplyEditorTimeout) clearTimeout(reapplyEditorTimeout);
    reapplyEditorTimeout = setTimeout(() => {
      ctx.ui.setEditorComponent(borderlessEditorFactory);
      reapplyEditorTimeout = undefined;
    }, 200);

    // Rain widget above editor: a Tokyo night sky with a crescent moon,
    // a few fixed purple stars, and dynamic cyan raindrops that fall at a
    // slight diagonal angle. Only set up when the panel is enabled.
    if (tokyoConfig.panel) {
      setupRainWidget(ctx.ui);
    }

    // Status bar widget below editor. It completes the rounded card that the
    // BorderlessEditor starts: left/right frame sides plus a rounded bottom.
    ctx.ui.setWidget(
      "tokyo-status",
      (tui: TUI, theme: EditorTheme) => ({
        invalidate() {},
        render(width: number): string[] {
          try {
            const cwd = ctx.cwd;
            updateBranch(cwd);

            const frameFg = (s: string) => `${fgRgb(FRAME_RGB)}${s}${RESET}`;
            const innerWidth = Math.max(1, width - 2);

            const statusLine = buildStatusLine(
              width,
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

            const bodyLine =
              frameFg(BOX.v) +
              statusContent +
              " ".repeat(padLen) +
              frameFg(BOX.v);
            // Clean rounded bottom frame to close the card.
            const bottomLine = frameFg(
              `${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}`,
            );
            return [bodyLine, bottomLine];
          } catch (err) {
            console.error("[tokyo-night] render failed:", err);
            return [];
          }
        },
      }),
      { placement: "belowEditor" },
    );

    // Hide default footer (widget below editor replaces it)
    ctx.ui.setFooter(() => HIDDEN_FOOTER);
  });

  // Slash command: /tokyo-night — toggle the editor-embedded settings panel.
  // Usage: /tokyo-night [on|off] for a quick panel toggle.
  pi.registerCommand("tokyo-night", {
    description:
      "Open the Tokyo Night settings panel. Usage: /tokyo-night [on|off]",
    handler: async (args: string, ctx) => {
      const arg = args.trim().toLowerCase();

      // Quick toggle: /tokyo-night on|off (preserves existing behavior).
      if (arg === "on" || arg === "off") {
        tokyoConfig.panel = arg === "on";
        writeTokyoConfig(tokyoConfig);

        // In non-interactive modes there is no TUI to update.
        if (!ctx.hasUI) return;

        applyPanelState(ctx.ui);
        ctx.ui.notify(`Tokyo Night panel ${arg}`, "info");
        return;
      }

      // Non-interactive sessions can't show the settings UI.
      if (!ctx.hasUI) {
        console.log(
          "[tokyo-night] Settings panel is only available in interactive mode.",
        );
        return;
      }

      // Toggle settings mode inside the existing BorderlessEditor. This keeps
      // the outer rounded frame and status bar intact, renders in the command
      // area, and does not cover the top rain panel.
      settingsMode = !settingsMode;
      if (settingsMode) {
        settingsSelectedIndex = 0;
        settingsEditing = false;
      } else {
        writeTokyoConfig(tokyoConfig);
        applyPanelState(ctx.ui);
      }
      BorderlessEditor.activeInstance?.requestRender();
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Idempotent cleanup (per docs: "Register an idempotent session_shutdown
    // handler"). Safe to call multiple times across reload/fork/quit.
    if (reapplyEditorTimeout) {
      clearTimeout(reapplyEditorTimeout);
      reapplyEditorTimeout = undefined;
    }

    // Guard non-interactive modes (RPC/print) where ctx.ui is a stub.
    if (!ctx.hasUI) {
      teardownRainWidget(ctx.ui);
      return;
    }

    teardownRainWidget(ctx.ui);
    ctx.ui.setWidget("tokyo-status", undefined);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setFooter(undefined); // Restore built-in footer
  });
}

function buildStatusLine(
  width: number,
  theme: EditorTheme,
  ctx: ExtensionAPI,
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
    console.error("[tokyo-night] session stats failed:", err);
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
      bgColor: TOKENS_BG,
      textColor: [255, 255, 200] as number[],
    },
    {
      text: `$${fmtCost(cost)}`,
      bgColor: COST_BG,
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
