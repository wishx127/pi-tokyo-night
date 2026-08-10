import type {
  StatusModulesConfig,
  TokyoConfig,
  TokyoConfigManager,
} from "../core/config";

export type NeonStudioSection = "appearance" | "status" | "usage" | "rain";
export type NeonStudioThemeChoice = "current" | "dark" | "light";

export interface NeonStudioThemeResult {
  success: boolean;
  error?: string;
}

export type NeonStudioConfigChange =
  | {
      kind: "config";
      key: Exclude<keyof TokyoConfig, "statusModules">;
    }
  | {
      kind: "status";
      key: keyof StatusModulesConfig;
    };

export const NEON_STUDIO_STATUS_SETTINGS: ReadonlyArray<{
  key: keyof StatusModulesConfig;
  label: string;
}> = [
  { key: "model", label: "Model" },
  { key: "thinking", label: "Thinking" },
  { key: "path", label: "Path" },
  { key: "git", label: "Git Branch" },
  { key: "quota", label: "Provider Limit" },
  { key: "tokens", label: "Tokens" },
  { key: "cost", label: "Cost" },
  { key: "context", label: "Context" },
];

export interface NeonStudioControllerDependencies {
  config: TokyoConfigManager;
  notify(message: string, level: "info" | "warning" | "error"): void;
  onConfigChange(change: NeonStudioConfigChange): void;
  previewTheme(choice: NeonStudioThemeChoice): NeonStudioThemeResult;
  saveTheme(choice: NeonStudioThemeChoice): NeonStudioThemeResult;
  done(): void;
}

/** Owns Neon Studio's live configuration and close-time persistence contract. */
export class NeonStudioController {
  private closing = false;
  private selectedTheme: NeonStudioThemeChoice = "current";

  constructor(
    private readonly dependencies: NeonStudioControllerDependencies,
  ) {}

  get config(): TokyoConfigManager {
    return this.dependencies.config;
  }

  get themeChoice(): NeonStudioThemeChoice {
    return this.selectedTheme;
  }

  changeSetting(
    section: NeonStudioSection,
    selectedIndex: number,
    direction = 1,
  ): boolean {
    if (section === "appearance") {
      return this.changeAppearance(selectedIndex, direction);
    }
    if (section === "status") {
      const setting = NEON_STUDIO_STATUS_SETTINGS[selectedIndex];
      if (!setting) return false;
      this.config.setStatusModule(
        setting.key,
        !this.config.get().statusModules[setting.key],
      );
      this.dependencies.onConfigChange({
        kind: "status",
        key: setting.key,
      });
      return true;
    }
    if (section === "usage") {
      const key = selectedIndex === 0
        ? "codexQuota"
        : selectedIndex === 1
          ? "kimiQuota"
          : undefined;
      if (!key) return false;
      this.config.set(key, !this.config.get()[key]);
      this.dependencies.onConfigChange({ kind: "config", key });
      return true;
    }
    if (section === "rain") {
      return this.changeRain(selectedIndex, direction);
    }
    return false;
  }

  saveAndClose(force = false): boolean {
    if (this.closing) return false;

    this.closing = true;
    let configSaved = false;
    try {
      configSaved = this.config.write();
    } catch {
      configSaved = false;
    }
    if (!configSaved) {
      this.safeNotify(
        force
          ? "Could not save Tokyo Night settings before Neon Studio closed."
          : "Could not save Tokyo Night settings. Neon Studio remains open.",
      );
      if (!force) {
        this.closing = false;
        return false;
      }
    }

    let themeResult: NeonStudioThemeResult;
    try {
      themeResult = this.dependencies.saveTheme(this.selectedTheme);
    } catch (error) {
      themeResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!themeResult.success) {
      this.safeNotify(
        themeResult.error ??
          (force
            ? "Could not save the Tokyo Night theme before Neon Studio closed."
            : "Could not save the Tokyo Night theme. Neon Studio remains open."),
      );
      if (!force) {
        this.closing = false;
        return false;
      }
    }

    try {
      this.dependencies.done();
    } catch {
      if (!force) this.closing = false;
      return false;
    }
    return configSaved && themeResult.success;
  }

  private safeNotify(message: string): void {
    try {
      this.dependencies.notify(message, "error");
    } catch {
      // A stale UI during shutdown must not interrupt resource teardown.
    }
  }

  private changeAppearance(selectedIndex: number, direction: number): boolean {
    if (selectedIndex === 0) {
      const choices: NeonStudioThemeChoice[] = ["current", "dark", "light"];
      const currentIndex = choices.indexOf(this.selectedTheme);
      const step = direction < 0 ? -1 : 1;
      let lastError: string | undefined;
      for (let offset = 1; offset < choices.length; offset++) {
        const next = choices[
          (currentIndex + step * offset + choices.length) % choices.length
        ];
        let result: NeonStudioThemeResult;
        try {
          result = this.dependencies.previewTheme(next);
        } catch (error) {
          result = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (result.success) {
          this.selectedTheme = next;
          return true;
        }
        lastError = result.error;
      }
      this.safeNotify(
        lastError ?? "Could not preview an available Tokyo Night theme.",
      );
      return false;
    }
    if (selectedIndex === 1) {
      this.config.set("panel", !this.config.get().panel);
      this.dependencies.onConfigChange({ kind: "config", key: "panel" });
      return true;
    }
    if (selectedIndex === 2) {
      this.config.set("editorFrame", !this.config.get().editorFrame);
      this.dependencies.onConfigChange({
        kind: "config",
        key: "editorFrame",
      });
      return true;
    }
    if (selectedIndex === 3) {
      this.config.set(
        "iconMode",
        this.config.get().iconMode === "nerd" ? "ascii" : "nerd",
      );
      this.dependencies.onConfigChange({ kind: "config", key: "iconMode" });
      return true;
    }
    return false;
  }

  private changeRain(selectedIndex: number, direction: number): boolean {
    if (selectedIndex === 0) {
      const previous = this.config.get().rainRows;
      this.config.set("rainRows", Math.max(1, Math.min(10, previous + direction)));
      if (this.config.get().rainRows === previous) return false;
      this.dependencies.onConfigChange({ kind: "config", key: "rainRows" });
      return true;
    }
    if (selectedIndex === 1) {
      const previous = this.config.get().rainTickMs;
      this.config.set(
        "rainTickMs",
        Math.max(50, Math.min(1000, previous + direction * 10)),
      );
      if (this.config.get().rainTickMs === previous) return false;
      this.dependencies.onConfigChange({ kind: "config", key: "rainTickMs" });
      return true;
    }
    if (selectedIndex === 2) {
      const previous = this.config.get().maxRainDrops;
      this.config.set(
        "maxRainDrops",
        Math.max(5, Math.min(100, previous + direction * 5)),
      );
      if (this.config.get().maxRainDrops === previous) return false;
      this.dependencies.onConfigChange({
        kind: "config",
        key: "maxRainDrops",
      });
      return true;
    }
    return false;
  }
}
