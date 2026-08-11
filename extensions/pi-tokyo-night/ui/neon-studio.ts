import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { isFullscreenTui } from "../core/pi-compat";
import {
  NEON_STUDIO_STATUS_SETTINGS,
  NeonStudioController,
  type NeonStudioSection,
  type NeonStudioThemeChoice,
} from "./neon-studio-controller";
import {
  composeFrameDock,
  getMainSurfaceFrameRole,
  renderFrameSegment,
} from "./frame-layout";

type StudioRow = {
  label: string;
  value: string;
  description: string;
};

export interface NeonStudioComponentOptions {
  renderFullscreenStatus?: (width: number) => string[];
  previewThemes?: Partial<Record<NeonStudioThemeChoice, Theme>>;
}

const SECTIONS: ReadonlyArray<{
  id: NeonStudioSection;
  label: string;
}> = [
  { id: "appearance", label: "Appearance" },
  { id: "status", label: "Status" },
  { id: "usage", label: "Usage" },
  { id: "rain", label: "Rain" },
];

/** Non-overlay settings surface hosted in Pi's standard custom UI slot. */
export class NeonStudioComponent implements Component {
  private sectionIndex = 0;
  private selectedIndex = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly controller: NeonStudioController,
    private readonly options: NeonStudioComponentOptions = {},
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "tab")) {
      this.sectionIndex = (this.sectionIndex + 1) % SECTIONS.length;
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const rows = this.getRows(SECTIONS[this.sectionIndex].id);
      if (rows.length > 0) {
        const direction = matchesKey(data, "up") ? -1 : 1;
        this.selectedIndex =
          (this.selectedIndex + direction + rows.length) % rows.length;
        this.tui.requestRender();
      }
      return;
    }
    if (
      matchesKey(data, "enter") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    ) {
      const direction = matchesKey(data, "left") ? -1 : 1;
      if (
        this.controller.changeSetting(
          SECTIONS[this.sectionIndex].id,
          this.selectedIndex,
          direction,
        )
      ) {
        this.tui.requestRender();
      }
      return;
    }
    if (!matchesKey(data, "escape")) return;
    if (!this.controller.saveAndClose()) this.tui.requestRender();
  }

  render(width: number): string[] {
    const outputWidth = Number.isFinite(width)
      ? Math.max(0, Math.floor(width))
      : 0;
    if (outputWidth === 0) return this.withFullscreenStatus([], outputWidth);

    const renderTheme = this.getRenderTheme();
    const activeSection = SECTIONS[this.sectionIndex];
    const tabs = SECTIONS.map((section, index) =>
      index === this.sectionIndex ? `[${section.label}]` : section.label
    ).join("  ");
    const rows = this.getRows(activeSection.id);
    const content = [
      renderTheme.fg("accent", " Neon Studio"),
      renderTheme.fg("muted", ` ${tabs}`),
      "",
      ...rows.map((row, index) => {
        const cursor = index === this.selectedIndex ? "❯" : " ";
        const label = `${cursor} ${row.label}:`;
        return index === this.selectedIndex
          ? renderTheme.fg("accent", `${label} ${row.value}`)
          : `${label} ${row.value}`;
      }),
      renderTheme.fg("dim", ` ${rows[this.selectedIndex]?.description ?? ""}`),
      "",
      renderTheme.fg(
        "dim",
        " ↑/↓ navigate  Tab section  Enter/←/→ change  Esc save",
      ),
    ];

    const config = this.controller.config.get();
    return this.withFullscreenStatus(renderFrameSegment({
      width: outputWidth,
      lines: content,
      frameEnabled: config.editorFrame,
      role: getMainSurfaceFrameRole(config.panel),
    }), outputWidth);
  }

  invalidate(): void {}

  private withFullscreenStatus(lines: string[], width: number): string[] {
    if (!isFullscreenTui(this.tui)) return lines;
    return composeFrameDock({
      width,
      lines,
      frameEnabled: this.controller.config.get().editorFrame,
      renderBottom: () => this.options.renderFullscreenStatus?.(width) ?? [],
    });
  }

  private getRenderTheme(): Theme {
    const choice = this.controller.themeChoice;
    return choice === "automatic"
      ? this.theme
      : this.options.previewThemes?.[choice] ?? this.theme;
  }

  private getRows(section: NeonStudioSection): StudioRow[] {
    const config = this.controller.config.get();
    if (section === "appearance") {
      const themeLabel = this.controller.themeChoice === "automatic"
        ? "Automatic"
        : this.controller.themeChoice === "dark"
          ? "Tokyo Night Dark"
          : "Tokyo Night Light";
      return [
        {
          label: "Theme",
          value: themeLabel,
          description: this.controller.themeChoice === "automatic"
            ? "Save the light/dark pair; restart Pi to apply"
            : "Preview locally; Esc applies the selected theme",
        },
        {
          label: "Top Panel",
          value: config.panel ? "On" : "Off",
          description: "Show the rain, moon, and stars above the editor",
        },
        {
          label: "Interface Frame",
          value: config.editorFrame ? "On" : "Off",
          description: "Frame Rain, the active surface, and Status as one card",
        },
        {
          label: "Status Icons",
          value: config.iconMode === "nerd" ? "Nerd" : "ASCII",
          description: "Choose the icon set used by the status bar",
        },
      ];
    }
    if (section === "status") {
      return NEON_STUDIO_STATUS_SETTINGS.map(({ key, label }) => ({
        label,
        value: config.statusModules[key] ? "On" : "Off",
        description: `Show ${label.toLowerCase()} in the status bar`,
      }));
    }
    if (section === "usage") {
      return [
        {
          label: "Codex Limit",
          value: config.codexQuota ? "On" : "Off",
          description: "Show Codex quota captured from provider response headers",
        },
        {
          label: "Kimi Limit",
          value: config.kimiQuota ? "On" : "Off",
          description: "Poll and show Kimi Code rolling and weekly quota",
        },
      ];
    }
    return [
      {
        label: "Rain Rows",
        value: String(config.rainRows),
        description: "Set the visible height of the rain panel",
      },
      {
        label: "Rain Tick (ms)",
        value: String(config.rainTickMs),
        description: "Set the interval between rain animation frames",
      },
      {
        label: "Max Rain Drops",
        value: String(config.maxRainDrops),
        description: "Limit the number of simultaneous rain drops",
      },
    ];
  }
}
