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

export const DEFAULT_CONFIG: Readonly<TokyoConfig> = Object.freeze({
  panel: true,
  codexQuota: false,
  rainRows: 3,
  rainTickMs: 130,
  maxRainDrops: 25,
});

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

function freezeConfig(config: TokyoConfig): Readonly<TokyoConfig> {
  return Object.freeze(config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "ENOENT"
  );
}

function isValidSettingValue(key: keyof TokyoConfig, value: unknown): boolean {
  const setting = SETTINGS.find((candidate) => candidate.id === key);
  if (!setting) return false;

  if (setting.kind === "toggle") return typeof value === "boolean";
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= setting.min! &&
    value <= setting.max!
  );
}

function validatedValue<K extends keyof TokyoConfig>(
  key: K,
  value: unknown,
): TokyoConfig[K] {
  return isValidSettingValue(key, value)
    ? (value as TokyoConfig[K])
    : DEFAULT_CONFIG[key];
}

/**
 * Manages Tokyo Night user configuration. Handles reading/writing
 * settings.json and provides access to an immutable config snapshot.
 */
export class TokyoConfigManager {
  private config: Readonly<TokyoConfig> = freezeConfig({ ...DEFAULT_CONFIG });

  /** Get the immutable config snapshot. Callers may read properties directly. */
  get(): Readonly<TokyoConfig> {
    return this.config;
  }

  /** Set a config value by key. TypeScript's indexed access types cannot
   *  narrow `TokyoConfig[keyof TokyoConfig]` for assignment based on
   *  runtime guards (setting.kind). This method centralizes the necessary
   *  type escape, keeping external callers type-safe. */
  set(key: keyof TokyoConfig, value: boolean | number): void {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) return;

    // Invalid runtime values are reset rather than allowed into the live config.
    const safeValue = validatedValue(key, value);
    this.config = freezeConfig({
      ...this.config,
      [key]: safeValue,
    });
  }

  /** Read config from settings.json. Falls back to defaults on error. */
  read(): void {
    try {
      const settingsPath = path.join(getAgentDir(), "settings.json");
      const content = fs.readFileSync(settingsPath, "utf-8");
      const settings: unknown = JSON.parse(content);
      if (!isRecord(settings)) {
        throw new Error("settings.json must contain an object");
      }

      const nextConfig = { ...DEFAULT_CONFIG };
      const saved = settings["pi-tokyo-night"];
      if (isRecord(saved)) {
        nextConfig.panel = validatedValue("panel", saved.panel);
        nextConfig.codexQuota = validatedValue("codexQuota", saved.codexQuota);
        nextConfig.rainRows = validatedValue("rainRows", saved.rainRows);
        nextConfig.rainTickMs = validatedValue("rainTickMs", saved.rainTickMs);
        nextConfig.maxRainDrops = validatedValue("maxRainDrops", saved.maxRainDrops);
      }
      this.config = freezeConfig(nextConfig);
    } catch (err) {
      handleExtensionError(err, "readTokyoConfig");
      this.config = freezeConfig({ ...DEFAULT_CONFIG });
    }
  }

  /** Persist current config to settings.json. */
  write(): boolean {
    let temporaryPath: string | undefined;
    try {
      const agentDir = getAgentDir();
      const settingsPath = path.join(agentDir, "settings.json");
      fs.mkdirSync(agentDir, { recursive: true });

      let settings: Record<string, unknown> = {};
      try {
        const content = fs.readFileSync(settingsPath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        if (!isRecord(parsed)) {
          throw new Error("settings.json must contain an object");
        }
        settings = parsed;
      } catch (err) {
        if (!isMissingFileError(err)) throw err;
      }

      settings["pi-tokyo-night"] = { ...this.config };
      temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`;
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify(settings, null, 2),
        "utf-8",
      );
      fs.renameSync(temporaryPath, settingsPath);
      temporaryPath = undefined;
      return true;
    } catch (err) {
      if (temporaryPath) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch {
          // Best-effort cleanup must not mask the persistence error.
        }
      }
      handleExtensionError(err, "writeTokyoConfig");
      return false;
    }
  }

  /** Reset config to defaults (does NOT persist). */
  resetToDefaults(): void {
    this.config = freezeConfig({ ...DEFAULT_CONFIG });
  }
}
