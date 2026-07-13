import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  SETTINGS,
  type SettingDescriptor,
  type TokyoConfigManager,
} from "./config";
import { CYAN, FRAME_RGB, RESET, fgRgb } from "./ui-primitives";

export interface SettingsControllerCallbacks {
  applyPanelState: () => void;
  onCodexQuotaConfigChange: () => void;
  requestEditorRender: () => void;
}

/**
 * Manages the editor-embedded settings panel UI state: navigation,
 * editing, and value adjustment. Encapsulates all settings-mode state.
 */
export class SettingsUIController {
  private config: TokyoConfigManager;
  private callbacks: SettingsControllerCallbacks;
  private mode = false;
  private selectedIndex = 0;
  private editing = false;
  private editValue = 0;

  constructor(
    config: TokyoConfigManager,
    callbacks: SettingsControllerCallbacks,
  ) {
    this.config = config;
    this.callbacks = callbacks;
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
          this.config.set(setting.id, !this.config.get()[setting.id]);
          if (setting.id === "codexQuota") {
            this.callbacks.onCodexQuotaConfigChange();
          }
        } else {
          this.editValue = this.config.get()[setting.id] as number;
          this.editing = true;
        }
      } else if (matchesKey(data, "esc")) {
        this.exit();
        this.callbacks.applyPanelState();
      }
    }
    this.callbacks.requestEditorRender();
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
