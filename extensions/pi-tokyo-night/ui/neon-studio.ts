import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  summarizeUsageHistory,
  type DashboardRange,
  type UsageDashboardSummary,
  type UsageHistory,
} from "../analytics/usage-history";
import {
  renderDottedTrendChart,
  type TrendSeries,
} from "../analytics/trend-chart";
import { isFullscreenTui } from "../core/pi-compat";
import {
  NEON_STUDIO_QUOTA_SETTINGS,
  NEON_STUDIO_STATUS_SETTINGS,
  NeonStudioController,
  type NeonStudioSection,
  type NeonStudioThemeChoice,
} from "./neon-studio-controller";
import {
  composeFrameDock,
  getFrameContentWidth,
  getMainSurfaceFrameRole,
  renderFrameSegment,
} from "./frame-layout";
import {
  createTokyoNightPalette,
  type TokyoNightThemePalette,
} from "./theme-palette";

type StudioRow = {
  label: string;
  value: string;
  description: string;
};

export interface NeonStudioComponentOptions {
  renderFullscreenStatus?: (width: number) => string[];
  previewThemes?: Partial<Record<NeonStudioThemeChoice, Theme>>;
  getTheme?: () => Theme;
  getAutomaticTheme?: () => Theme | undefined;
  loadUsageHistory?: (signal: AbortSignal) => Promise<UsageHistory | null>;
}

const DASHBOARD_RANGES: readonly DashboardRange[] = [3, 7, 30, "all"];
const DASHBOARD_MODEL_LIMIT = 5;
const DASHBOARD_EXIT_HINT = " Tab section  Esc exit";
const DASHBOARD_RANGE_EXIT_HINT = " ←/→ range  Tab section  Esc exit";
const MODEL_COLOR_ROLES = [
  "thinkingLow",
  "syntaxFunction",
  "success",
  "warning",
  "thinkingXhigh",
] as const;
type ModelColorRole = (typeof MODEL_COLOR_ROLES)[number];
type DashboardSeriesColor = "dim" | ModelColorRole;

type DashboardState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; history: UsageHistory }
  | { kind: "error"; message: string };

type DashboardSeries = TrendSeries & {
  label: string;
  total: number;
  color: DashboardSeriesColor;
};

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
  private dashboardRangeIndex = 0;
  private dashboardLegendIndex = 0;
  private readonly dashboardHiddenSeries = new Set<string>();
  private dashboardState: DashboardState = { kind: "idle" };
  private dashboardAbortController: AbortController | undefined;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly controller: NeonStudioController,
    private readonly options: NeonStudioComponentOptions = {},
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "tab")) {
      const previousSection = SECTIONS[this.sectionIndex].id;
      this.sectionIndex = (this.sectionIndex + 1) % SECTIONS.length;
      const nextSection = SECTIONS[this.sectionIndex].id;
      this.selectedIndex = 0;
      if (previousSection === "usage" && nextSection !== "usage") {
        this.cancelDashboardLoad();
      }
      if (nextSection === "usage") {
        this.ensureDashboardLoaded();
      }
      this.tui.requestRender();
      return;
    }

    const activeSection = SECTIONS[this.sectionIndex].id;
    if (activeSection === "usage") {
      if (matchesKey(data, "left") || matchesKey(data, "right")) {
        const direction = matchesKey(data, "left") ? -1 : 1;
        this.dashboardRangeIndex = (
          this.dashboardRangeIndex + direction + DASHBOARD_RANGES.length
        ) % DASHBOARD_RANGES.length;
        this.dashboardLegendIndex = 0;
        this.dashboardHiddenSeries.clear();
        this.tui.requestRender();
        return;
      }

      const summary = this.getDashboardSummary();
      const series = summary ? this.getDashboardSeries(summary) : [];
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        if (series.length > 0) {
          const direction = matchesKey(data, "up") ? -1 : 1;
          this.dashboardLegendIndex = (
            this.dashboardLegendIndex + direction + series.length
          ) % series.length;
          this.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        const selected = series[Math.min(this.dashboardLegendIndex, series.length - 1)];
        if (selected) {
          if (this.dashboardHiddenSeries.has(selected.id)) {
            this.dashboardHiddenSeries.delete(selected.id);
          } else {
            this.dashboardHiddenSeries.add(selected.id);
          }
          this.tui.requestRender();
        }
        return;
      }
      if (!matchesKey(data, "escape")) return;
      if (!this.controller.saveAndClose()) this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const rows = this.getRows(activeSection);
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
      if (this.controller.changeSetting(activeSection, this.selectedIndex, direction)) {
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
    const palette = createTokyoNightPalette(renderTheme);
    const activeSection = SECTIONS[this.sectionIndex];
    const config = this.controller.config.get();
    const contentWidth = getFrameContentWidth(outputWidth, config.editorFrame);
    const fullTabs = SECTIONS.map((section, index) =>
      index === this.sectionIndex ? `[${section.label}]` : section.label
    ).join("  ");
    const tabs = visibleWidth(fullTabs) <= contentWidth
      ? fullTabs
      : `[${activeSection.label}]`;
    const content = activeSection.id === "usage"
      ? this.getDashboardLines(renderTheme, contentWidth, tabs)
      : this.getSettingsLines(renderTheme, activeSection.id, tabs);

    return this.withFullscreenStatus(renderFrameSegment({
      width: outputWidth,
      lines: content,
      frameEnabled: config.editorFrame,
      role: getMainSurfaceFrameRole(config.panel),
      palette,
    }), outputWidth, palette);
  }

  invalidate(): void {}

  dispose(): void {
    this.cancelDashboardLoad();
    this.disposed = true;
  }

  private getSettingsLines(
    renderTheme: Theme,
    section: NeonStudioSection,
    tabs: string,
  ): string[] {
    const rows = this.getRows(section);
    return [
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
  }

  private getDashboardLines(
    renderTheme: Theme,
    contentWidth: number,
    tabs: string,
  ): string[] {
    const range = DASHBOARD_RANGES[this.dashboardRangeIndex]!;
    const rangeLabel = (value: DashboardRange): string =>
      value === "all" ? "All" : `${value} Days`;
    const rangeTabs = DASHBOARD_RANGES.map((days) =>
      days === range ? `[${rangeLabel(days)}]` : rangeLabel(days)
    ).join("  ");
    const header = [
      renderTheme.fg("accent", " Neon Studio"),
      renderTheme.fg("muted", ` ${tabs}`),
      "",
      renderTheme.fg("accent", ` ${rangeTabs}`),
      "",
    ];

    if (this.dashboardState.kind === "idle" || this.dashboardState.kind === "loading") {
      return [
        ...header,
        renderTheme.fg("dim", " Loading historical usage…"),
        "",
        renderTheme.fg("dim", DASHBOARD_EXIT_HINT),
      ];
    }
    if (this.dashboardState.kind === "error") {
      return [
        ...header,
        renderTheme.fg("error", ` ${this.dashboardState.message}`),
        "",
        renderTheme.fg("dim", DASHBOARD_EXIT_HINT),
      ];
    }

    const summary = this.getDashboardSummary();
    if (!summary || summary.totalTokens <= 0) {
      return [
        ...header,
        renderTheme.fg("dim", " No usage data for this period"),
        "",
        renderTheme.fg("dim", DASHBOARD_RANGE_EXIT_HINT),
      ];
    }

    const series = this.getDashboardSeries(summary);
    const legendIndex = Math.min(
      this.dashboardLegendIndex,
      Math.max(series.length - 1, 0),
    );
    const visibleSeries = series.filter(
      (entry) => !this.dashboardHiddenSeries.has(entry.id),
    );
    const chartMaximum = Math.max(
      0,
      ...series.flatMap((entry) => entry.values),
    );
    const yLabelWidth = Math.max(
      this.formatTokens(chartMaximum).length,
      this.formatTokens(chartMaximum / 2).length,
      1,
    );
    const labeledAxisWidth = yLabelWidth + 3;
    const showYAxisLabels = contentWidth >= labeledAxisWidth + 4;
    const axisWidth = showYAxisLabels
      ? labeledAxisWidth
      : contentWidth >= 2
        ? 1
        : 0;
    const chartWidth = Math.max(1, contentWidth - axisWidth);
    const chartSeries = series.map((entry) => ({
      id: entry.id,
      values: entry.values,
      hidden: this.dashboardHiddenSeries.has(entry.id),
    }));
    const chart = renderDottedTrendChart(chartSeries, chartWidth);
    const colorBySeries = new Map(series.map((entry) => [entry.id, entry.color]));
    const chartLines = chart.rows.map((row) => {
      const label = row.value === undefined ? "" : this.formatTokens(row.value);
      const axis = showYAxisLabels
        ? ` ${label.padStart(yLabelWidth)} ${row.axis}`
        : axisWidth === 1
          ? row.axis
          : "";
      const plot = row.runs.map((run) => run.seriesId === undefined
        ? run.text
        : renderTheme.fg(colorBySeries.get(run.seriesId) ?? "dim", run.text)
      ).join("");
      return renderTheme.fg("dim", axis) + plot;
    });
    const chartBaseline = showYAxisLabels
      ? `${" ".repeat(yLabelWidth + 2)}└${"─".repeat(chartWidth)}`
      : axisWidth === 1
        ? `└${"─".repeat(chartWidth)}`
        : "─".repeat(chartWidth);
    const chartFooter = [renderTheme.fg("dim", chartBaseline)];
    const dateTicks = this.buildChartDateTicks(
      contentWidth,
      axisWidth,
      chartWidth,
      summary.daily,
    );
    if (dateTicks) chartFooter.push(renderTheme.fg("dim", dateTicks));

    return [
      ...header,
      renderTheme.fg("accent", ` Total tokens  ${this.formatTokens(summary.totalTokens)}`),
      renderTheme.fg("dim", " Calculation: input + output + cache write"),
      "",
      ...chartLines,
      ...chartFooter,
      ...(visibleSeries.length === 0
        ? [renderTheme.fg("dim", " No series selected")]
        : []),
      "",
      renderTheme.fg("thinkingMedium", " Model distribution"),
      ...this.getDashboardLegendRows(
        renderTheme,
        contentWidth,
        series,
        legendIndex,
        summary.totalTokens,
      ),
      "",
      renderTheme.fg(
        "dim",
        " ↑/↓ select  Enter/Space toggle  ←/→ range  Tab section  Esc exit",
      ),
    ];
  }

  private getDashboardSummary(): UsageDashboardSummary | undefined {
    if (this.dashboardState.kind !== "ready") return undefined;
    const collectedAt = this.dashboardState.history.collectedAt;
    return summarizeUsageHistory(
      this.dashboardState.history,
      DASHBOARD_RANGES[this.dashboardRangeIndex]!,
      typeof collectedAt === "number" && Number.isFinite(collectedAt)
        ? new Date(collectedAt)
        : new Date(),
    );
  }

  private getDashboardSeries(summary: UsageDashboardSummary): DashboardSeries[] {
    const topModels = summary.models.slice(0, DASHBOARD_MODEL_LIMIT);
    const modelSeries = topModels.map((model, index): DashboardSeries => ({
      id: `model:${model.provider}\u0000${model.model}`,
      label: `${model.provider}/${model.model}`,
      total: model.tokens,
      values: model.dailyTokens,
      color: MODEL_COLOR_ROLES[index]!,
    }));
    return modelSeries;
  }

  private getDashboardLegendRows(
    renderTheme: Theme,
    contentWidth: number,
    series: readonly DashboardSeries[],
    selectedIndex: number,
    totalTokens: number,
  ): string[] {
    return series.map((entry, index) => {
      const hidden = this.dashboardHiddenSeries.has(entry.id);
      const cursor = index === selectedIndex
        ? renderTheme.fg("accent", "▸")
        : " ";
      const marker = hidden
        ? renderTheme.fg("dim", "○")
        : renderTheme.fg(entry.color, "●");
      const share = `${Math.round((entry.total / totalTokens) * 100)}%`;
      const value = ` ${this.formatTokens(entry.total)} ${share}`;
      const labelWidth = Math.max(1, contentWidth - visibleWidth(value) - 4);
      const label = truncateToWidth(entry.label, labelWidth);
      const text = hidden
        ? renderTheme.fg("dim", label)
        : renderTheme.fg("muted", label);
      return truncateToWidth(
        `${cursor} ${marker} ${text}${renderTheme.fg("dim", value)}`,
        Math.max(contentWidth, 0),
      );
    });
  }

  private buildChartDateTicks(
    contentWidth: number,
    axisWidth: number,
    chartWidth: number,
    days: readonly { dayStart: number }[],
  ): string | undefined {
    const first = days[0]?.dayStart;
    const last = days.at(-1)?.dayStart;
    if (first === undefined || last === undefined || chartWidth < 2) {
      return undefined;
    }

    if (first === last) {
      const label = this.formatDay(first);
      const width = visibleWidth(label);
      if (width > chartWidth) return undefined;
      const line = " ".repeat(axisWidth + Math.floor((chartWidth - width) / 2)) + label;
      return truncateToWidth(line, Math.max(contentWidth, 0));
    }

    const start = this.formatDay(first);
    const end = this.formatDay(last);
    const startWidth = visibleWidth(start);
    const endWidth = visibleWidth(end);
    if (chartWidth < startWidth + endWidth) return undefined;

    const ticks: Array<{ position: number; label: string }> = [
      { position: 0, label: start },
      { position: chartWidth - endWidth, label: end },
    ];
    const middle = this.formatDay(days[Math.floor((days.length - 1) / 2)]!.dayStart);
    const middleWidth = visibleWidth(middle);
    const middlePosition = Math.floor((chartWidth - middleWidth) / 2);
    if (
      middlePosition >= startWidth + 3 &&
      middlePosition + middleWidth + 3 <= chartWidth - endWidth
    ) {
      ticks.splice(1, 0, { position: middlePosition, label: middle });
    }

    let line = " ".repeat(axisWidth);
    let cursor = 0;
    for (const tick of ticks) {
      line += " ".repeat(Math.max(0, tick.position - cursor)) + tick.label;
      cursor = tick.position + visibleWidth(tick.label);
    }
    return truncateToWidth(line, Math.max(contentWidth, 0));
  }

  private formatDay(dayStart: number): string {
    return new Date(dayStart).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  private formatTokens(tokens: number): string {
    const rounded = Math.round(tokens);
    if (rounded < 1000) return String(rounded);
    if (rounded < 10_000) return `${(rounded / 1000).toFixed(1)}k`;
    if (rounded < 1_000_000) return `${Math.round(rounded / 1000)}k`;
    if (rounded < 10_000_000) return `${(rounded / 1_000_000).toFixed(1)}M`;
    return `${Math.round(rounded / 1_000_000)}M`;
  }

  private ensureDashboardLoaded(): void {
    if (!this.options.loadUsageHistory || this.disposed) {
      this.dashboardState = {
        kind: "error",
        message: "Historical usage is unavailable.",
      };
      return;
    }
    if (this.dashboardState.kind === "loading" || this.dashboardState.kind === "ready") {
      return;
    }

    this.cancelDashboardLoad();
    const controller = new AbortController();
    this.dashboardAbortController = controller;
    this.dashboardState = { kind: "loading" };
    void this.options.loadUsageHistory(controller.signal).then((history) => {
      if (this.disposed || controller.signal.aborted || this.dashboardAbortController !== controller) {
        return;
      }
      this.dashboardAbortController = undefined;
      this.dashboardState = history
        ? { kind: "ready", history }
        : { kind: "error", message: "Historical usage scan was cancelled." };
      this.tui.requestRender();
    }).catch(() => {
      if (this.disposed || controller.signal.aborted || this.dashboardAbortController !== controller) {
        return;
      }
      this.dashboardAbortController = undefined;
      this.dashboardState = {
        kind: "error",
        message: "Could not read historical usage.",
      };
      this.tui.requestRender();
    });
  }

  private cancelDashboardLoad(): void {
    const controller = this.dashboardAbortController;
    this.dashboardAbortController = undefined;
    controller?.abort();
    if (this.dashboardState.kind === "loading") {
      this.dashboardState = { kind: "idle" };
    }
  }

  private withFullscreenStatus(
    lines: string[],
    width: number,
    palette?: TokyoNightThemePalette,
  ): string[] {
    if (!isFullscreenTui(this.tui)) return lines;
    return composeFrameDock({
      width,
      lines,
      frameEnabled: this.controller.config.get().editorFrame,
      palette: palette ?? createTokyoNightPalette(this.getRenderTheme()),
      renderBottom: () => this.options.renderFullscreenStatus?.(width) ?? [],
    });
  }

  private getRenderTheme(): Theme {
    const choice = this.controller.themeChoice;
    const activeTheme = this.options.getTheme?.();
    if (activeTheme) return activeTheme;

    if (choice === "automatic") {
      const automaticTheme = this.options.getAutomaticTheme?.();
      if (automaticTheme) return automaticTheme;
    }
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
            ? "Detect current terminal colors now; restart Pi to keep Automatic"
            : "Preview the full interface; Esc saves the selected theme",
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
      return [
        ...NEON_STUDIO_STATUS_SETTINGS.map(({ key, label }) => ({
          label,
          value: config.statusModules[key] ? "On" : "Off",
          description: `Show ${label.toLowerCase()} in the status bar`,
        })),
        ...NEON_STUDIO_QUOTA_SETTINGS.map(({ key, label, description }) => ({
          label,
          value: config[key] ? "On" : "Off",
          description,
        })),
      ];
    }
    if (section !== "rain") return [];
    const rainRows: StudioRow[] = [
      {
        label: "Rain Mode",
        value: config.rainMode === "auto" ? "Auto" : "Manual",
        description: config.rainMode === "auto"
          ? "Follow Pi activity with automatic rain speed and density"
          : "Use the saved Rain Tick and Max Rain Drops values",
      },
      {
        label: "Rain Rows",
        value: String(config.rainRows),
        description: "Set the visible height of the rain panel",
      },
    ];
    if (config.rainMode === "manual") {
      rainRows.push(
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
      );
    }
    return rainRows;
  }
}
