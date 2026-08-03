import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { handleExtensionError } from "./errors";
import { DEFAULT_ICON_MODE, type IconMode } from "./icons";

// ── Tokyo Night User Config ────────────────────────────────────────────────
// Persisted user personalization for the Tokyo Night extension. The panel
// toggle and rain animation parameters can be changed at runtime through the
// /tokyo-night settings overlay.
export interface StatusModulesConfig {
  model: boolean;
  thinking: boolean;
  path: boolean;
  git: boolean;
  quota: boolean;
  tokens: boolean;
  cost: boolean;
  context: boolean;
}

export interface TokyoConfig {
  /** Show the top rain/moon/stars panel. */
  panel: boolean;
  /** Show the rounded frame around the input editor. */
  editorFrame: boolean;
  /** Show Pi's native "Working" indicator while the agent runs. */
  workingIndicator: boolean;
  /** Show Codex limit in the status bar (requires Pi transport=sse). */
  codexQuota: boolean;
  /** Show Kimi Code 5h/weekly quota in the status bar (polls the usages API). */
  kimiQuota: boolean;
  /** Icon set used by the status bar. */
  iconMode: IconMode;
  /** Visibility of status bar modules, configured in settings.json. */
  statusModules: Readonly<StatusModulesConfig>;
  /** Height of the rain panel in rows. */
  rainRows: number;
  /** Milliseconds between rain animation frames. */
  rainTickMs: number;
  /** Maximum number of simultaneous rain drops. */
  maxRainDrops: number;
}

export const DEFAULT_STATUS_MODULES: Readonly<StatusModulesConfig> = Object.freeze({
  model: true,
  thinking: true,
  path: true,
  git: true,
  quota: true,
  tokens: true,
  cost: true,
  context: true,
});

export const DEFAULT_CONFIG: Readonly<TokyoConfig> = Object.freeze({
  panel: true,
  editorFrame: true,
  workingIndicator: true,
  codexQuota: false,
  kimiQuota: true,
  iconMode: DEFAULT_ICON_MODE,
  statusModules: DEFAULT_STATUS_MODULES,
  rainRows: 3,
  rainTickMs: 130,
  maxRainDrops: 25,
});

// ── Settings Panel Types ───────────────────────────────────────────────────

export type SettingKind = "toggle" | "number" | "choice";

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDescriptor {
  id: keyof TokyoConfig;
  label: string;
  description: string;
  kind: SettingKind;
  options?: readonly SettingOption[];
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
    id: "editorFrame",
    label: "Input Frame",
    description: "Show the rounded frame around the input editor",
    kind: "toggle",
  },
  {
    id: "codexQuota",
    label: "Codex Limit",
    description: "Show Codex limit in status bar (requires Pi transport=sse)",
    kind: "toggle",
  },
  {
    id: "kimiQuota",
    label: "Kimi Limit",
    description: "Show Kimi Code 5h/weekly quota in status bar (polls usages API)",
    kind: "toggle",
  },
  {
    id: "iconMode",
    label: "Status Icons",
    description: "Use Nerd Font or ASCII icons in the status bar",
    kind: "choice",
    options: [
      { value: "nerd", label: "Nerd" },
      { value: "ascii", label: "ASCII" },
    ],
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
  {
    id: "workingIndicator",
    label: "Working Indicator",
    description: "Show Pi's native Working indicator while the agent runs",
    kind: "toggle",
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

const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400] as const;

function isRetryableRenameError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY";
}

function waitSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function renameConfigFile(source: string, destination: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== "win32" || delay === undefined || !isRetryableRenameError(error)) {
        throw error;
      }
      waitSync(delay);
    }
  }
}

function readStatusModules(value: unknown): Readonly<StatusModulesConfig> {
  const saved = isRecord(value) ? value : {};
  return Object.freeze({
    model: typeof saved.model === "boolean"
      ? saved.model
      : DEFAULT_STATUS_MODULES.model,
    thinking: typeof saved.thinking === "boolean"
      ? saved.thinking
      : DEFAULT_STATUS_MODULES.thinking,
    path: typeof saved.path === "boolean"
      ? saved.path
      : DEFAULT_STATUS_MODULES.path,
    git: typeof saved.git === "boolean"
      ? saved.git
      : DEFAULT_STATUS_MODULES.git,
    quota: typeof saved.quota === "boolean"
      ? saved.quota
      : DEFAULT_STATUS_MODULES.quota,
    tokens: typeof saved.tokens === "boolean"
      ? saved.tokens
      : DEFAULT_STATUS_MODULES.tokens,
    cost: typeof saved.cost === "boolean"
      ? saved.cost
      : DEFAULT_STATUS_MODULES.cost,
    context: typeof saved.context === "boolean"
      ? saved.context
      : DEFAULT_STATUS_MODULES.context,
  });
}

function isValidSettingValue(key: keyof TokyoConfig, value: unknown): boolean {
  const setting = SETTINGS.find((candidate) => candidate.id === key);
  if (!setting) return false;

  if (setting.kind === "toggle") return typeof value === "boolean";
  if (setting.kind === "choice") {
    return setting.options?.some((option) => option.value === value) ?? false;
  }
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
  set(key: keyof TokyoConfig, value: TokyoConfig[keyof TokyoConfig]): void {
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
        nextConfig.editorFrame = validatedValue(
          "editorFrame",
          saved.editorFrame,
        );
        nextConfig.workingIndicator = validatedValue(
          "workingIndicator",
          saved.workingIndicator,
        );
        nextConfig.codexQuota = validatedValue("codexQuota", saved.codexQuota);
        nextConfig.kimiQuota = validatedValue("kimiQuota", saved.kimiQuota);
        nextConfig.iconMode = validatedValue("iconMode", saved.iconMode);
        nextConfig.statusModules = readStatusModules(saved.statusModules);
        nextConfig.rainRows = validatedValue("rainRows", saved.rainRows);
        nextConfig.rainTickMs = validatedValue("rainTickMs", saved.rainTickMs);
        nextConfig.maxRainDrops = validatedValue("maxRainDrops", saved.maxRainDrops);
      }
      this.config = freezeConfig(nextConfig);
    } catch (err) {
      if (!isMissingFileError(err)) {
        handleExtensionError(err, "readTokyoConfig");
      }
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
      renameConfigFile(temporaryPath, settingsPath);
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
