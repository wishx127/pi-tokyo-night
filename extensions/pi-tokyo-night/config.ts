import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { handleExtensionError } from "./errors";

// ── Tokyo Night User Config ────────────────────────────────────────────────
// Persisted user personalization for the Tokyo Night extension. The panel
// toggle and rain animation parameters can be changed at runtime through the
// /tokyo-night settings overlay.
export interface TokyoConfig {
  /** Show the top rain/moon/stars panel. */
  panel: boolean;
  /** Show Codex limit in the status bar (requires Pi transport=sse). */
  codexQuota: boolean;
  /** Height of the rain panel in rows. */
  rainRows: number;
  /** Milliseconds between rain animation frames. */
  rainTickMs: number;
  /** Maximum number of simultaneous rain drops. */
  maxRainDrops: number;
}

export const DEFAULT_CONFIG: TokyoConfig = {
  panel: true,
  codexQuota: false,
  rainRows: 3,
  rainTickMs: 130,
  maxRainDrops: 25,
};

// ── Settings Panel Types ───────────────────────────────────────────────────

export type SettingKind = "toggle" | "number";

export interface SettingDescriptor {
  id: keyof TokyoConfig;
  label: string;
  description: string;
  kind: SettingKind;
  min?: number;
  max?: number;
  step?: number;
}

export const SETTINGS: SettingDescriptor[] = [
  {
    id: "panel",
    label: "Top Panel",
    description: "Show the rain/moon/stars panel above the editor",
    kind: "toggle",
  },
  {
    id: "codexQuota",
    label: "Codex Limit",
    description: "Show Codex limit in status bar (requires Pi transport=sse)",
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

/**
 * Manages Tokyo Night user configuration. Handles reading/writing
 * settings.json and provides access to the mutable config object.
 */
export class TokyoConfigManager {
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
          codexQuota:
            typeof saved.codexQuota === "boolean"
              ? saved.codexQuota
              : DEFAULT_CONFIG.codexQuota,
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
