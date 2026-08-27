import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  bgRgb,
  fgRgb,
  RESET_BG,
  RESET_FG,
} from "./ui-primitives";

export type TokyoNightForegroundRole =
  | "rain"
  | "star"
  | "moon"
  | "prompt"
  | "workingCyan"
  | "workingPurple"
  | "frame"
  | "statusModel"
  | "statusThinking"
  | "statusPath"
  | "statusGit"
  | "statusLimit"
  | "statusTokens"
  | "statusCost"
  | "statusContext";

export type TokyoNightBackgroundRole =
  | "model"
  | "thinking"
  | "path"
  | "git"
  | "quota"
  | "tokens"
  | "cost";

export interface TokyoNightThemePalette {
  fg(role: TokyoNightForegroundRole, text: string): string;
  bg(role: TokyoNightBackgroundRole, text: string): string;
  transition(
    from: TokyoNightBackgroundRole | null,
    to: TokyoNightBackgroundRole | null,
    text: string,
  ): string;
}

type ThemeForeground = Parameters<Theme["fg"]>[0];
type RgbColor = readonly [number, number, number];

const THEME_FOREGROUND_TOKENS: Partial<
  Record<TokyoNightForegroundRole, ThemeForeground>
> = {
  rain: "thinkingLow",
  star: "accent",
  moon: "warning",
  prompt: "accent",
  workingCyan: "thinkingLow",
  workingPurple: "thinkingMedium",
};

// Tokyo Night's status bar and shared frame retain a stable visual identity.
// Foregrounds rendered directly on the terminal surface follow the active
// Theme so they remain legible across light and dark backgrounds.
const STATIC_FOREGROUND_COLORS: Partial<
  Record<TokyoNightForegroundRole, RgbColor>
> = {
  frame: [61, 53, 119], // #3d3577
  statusModel: [200, 200, 255],
  statusThinking: [220, 220, 255],
  statusPath: [240, 240, 255],
  statusGit: [255, 255, 255],
  statusLimit: [245, 240, 255],
  statusTokens: [255, 255, 200],
  statusCost: [200, 255, 200],
  statusContext: [255, 200, 200],
};

const STATIC_BACKGROUND_COLORS: Record<
  TokyoNightBackgroundRole,
  RgbColor
> = {
  model: [45, 27, 105], // #2d1b69
  thinking: [61, 43, 122], // #3d2b7a
  path: [77, 59, 138], // #4d3b8a
  git: [93, 75, 154], // #5d4b9a
  quota: [101, 83, 162], // #6553a2
  tokens: [109, 91, 170], // #6d5baa
  cost: [93, 93, 93], // #5d5d5d
};

function renderRgbForeground(color: RgbColor, text: string): string {
  return `${fgRgb(color)}${text}${RESET_FG}`;
}

function renderRgbBackground(color: RgbColor, text: string): string {
  return `${bgRgb(color)}${text}${RESET_BG}`;
}

function renderChromeTransition(
  from: TokyoNightBackgroundRole | null,
  to: TokyoNightBackgroundRole | null,
  text: string,
): string {
  const background = to === null
    ? RESET_BG
    : bgRgb(STATIC_BACKGROUND_COLORS[to]);
  const foreground = from === null
    ? RESET_FG
    : fgRgb(STATIC_BACKGROUND_COLORS[from]);
  return `${background}${foreground}${text}${RESET_BG}${RESET_FG}`;
}

/**
 * Resolve surface accents through the active Theme while keeping Tokyo Night's
 * status and frame chrome independent from generic content-surface tokens.
 */
export function createTokyoNightPalette(
  theme: Theme,
): TokyoNightThemePalette {
  return {
    fg: (role, text) => {
      const staticColor = STATIC_FOREGROUND_COLORS[role];
      if (staticColor) return renderRgbForeground(staticColor, text);

      const themeToken = THEME_FOREGROUND_TOKENS[role];
      if (themeToken && typeof theme.fg === "function") {
        return theme.fg(themeToken, text);
      }
      return text;
    },
    bg: (role, text) =>
      renderRgbBackground(STATIC_BACKGROUND_COLORS[role], text),
    transition: renderChromeTransition,
  };
}

/** Stable chrome palette for public frame helpers without a host Theme. */
export const DEFAULT_TOKYO_NIGHT_PALETTE = createTokyoNightPalette({
  fg: (_color: string, text: string) => text,
} as unknown as Theme);
