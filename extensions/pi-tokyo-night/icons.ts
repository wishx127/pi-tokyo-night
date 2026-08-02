export type IconMode = "nerd" | "ascii";

export const DEFAULT_ICON_MODE: IconMode = "nerd";

export interface StatusIcons {
  readonly model: string;
  readonly thinking: string;
  readonly path: string;
  readonly branch: string;
  readonly transition: string;
  readonly tokens: string;
  readonly gaugeFilled: string;
  readonly gaugeEmpty: string;
}

const NERD_ICONS: StatusIcons = Object.freeze({
  model: "\uE795",
  thinking: "⚡",
  path: "\uF07B",
  branch: "\uE0A0",
  transition: "\uE0B0",
  tokens: "Σ",
  gaugeFilled: "█",
  gaugeEmpty: "░",
});

const ASCII_ICONS: StatusIcons = Object.freeze({
  model: "@",
  thinking: "",
  path: "~",
  branch: "*",
  transition: "\uE0B0",
  tokens: "Σ",
  gaugeFilled: "█",
  gaugeEmpty: "░",
});

export function isIconMode(value: unknown): value is IconMode {
  return value === "nerd" || value === "ascii";
}

export function resolveIcons(mode: IconMode): StatusIcons {
  return mode === "ascii" ? ASCII_ICONS : NERD_ICONS;
}
