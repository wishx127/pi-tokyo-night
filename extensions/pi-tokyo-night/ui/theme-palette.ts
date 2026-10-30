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
  | "workingText"
  | "workingTextShimmer"
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
  rainShade?(role: "rain" | "moon" | "star" | "water", intensity: number, text: string): string;
  rippleShade?(intensity: number, waterIntensity: number, text: string, waterInk?: "water" | "moon"): string;
  workingPulse(text: string, intensity: number): string;
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

const WORKING_TEXT_COLORS = {
  dark: {
    base: [169, 177, 214], // #a9b1d6
    shimmer: [210, 214, 232], // #d2d6e8
  },
  light: {
    base: [86, 95, 137], // #565f89
    shimmer: [36, 40, 59], // #24283b
  },
} as const satisfies Record<"dark" | "light", Record<"base" | "shimmer", RgbColor>>;

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

function interpolateRgb(from: RgbColor, to: RgbColor, intensity: number): RgbColor {
  const amount = Math.max(0, Math.min(1, intensity));
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
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
  const workingColors = theme.name?.includes("light")
    ? WORKING_TEXT_COLORS.light
    : WORKING_TEXT_COLORS.dark;
  const rainTokens = {
    rain: "thinkingLow", water: "syntaxFunction",
    moon: "warning", star: "accent",
  } as const;
  const rainStyles = new Map<string, string>();
  const rgbFromAnsi = (ansi: string): RgbColor | undefined => {
    const match = /\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/.exec(ansi);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  let rainBackground: RgbColor | undefined = theme.name === "tokyo-night-light" ? [225, 226, 231]
    : theme.name === "tokyo-night-dark" ? [26, 27, 38]
      : undefined;
  const lightSurface = (theme as Theme & { appearance?: string }).appearance === "light" || theme.name?.includes("light");
  const surfaceBackground = (): RgbColor => rainBackground ??= rgbFromAnsi(theme.bg?.("userMessageBg", "") ?? "") ??
    (lightSurface ? [225, 226, 231] : [26, 27, 38]);
  const surfaceRgb = (role: keyof typeof rainTokens, level: number): RgbColor | undefined => {
    const foreground = rgbFromAnsi(theme.fg(rainTokens[role], ""));
    if (!foreground) return undefined;
    return interpolateRgb(surfaceBackground(), foreground, level * (role === "water" ? lightSurface ? 1.2 : 1.5 : 1));
  };
  const surfaceLevel = (intensity: number) => Math.round((Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0) * 32) / 32;

  return {
    rainShade: (role, intensity, text) => {
      const token = rainTokens[role];
      const level = role === "water" ? surfaceLevel(intensity)
        : Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0;
      const key = `${role}:${level}`;
      let style = rainStyles.get(key);
      if (!style) {
        const color = surfaceRgb(role, level);
        if (!color) return theme.fg(token, text);
        style = fgRgb(color);
        rainStyles.set(key, style);
      }
      return `${style}${text}${RESET_FG}`;
    },
    rippleShade: (intensity, waterIntensity, text, waterInk = "water") => {
      const wave = surfaceLevel(intensity), water = surfaceLevel(waterIntensity);
      const key = `ripple:${waterInk}:${wave}:${water}`;
      let style = rainStyles.get(key);
      if (!style) {
        const base = surfaceRgb(waterInk, water);
        if (!base) return theme.fg(wave === 0 ? rainTokens[waterInk] : rainTokens.rain, text);
        const foreground = wave === 0 ? base : rgbFromAnsi(theme.fg(rainTokens.rain, ""));
        if (!foreground) return theme.fg(rainTokens.rain, text);
        style = fgRgb(interpolateRgb(base, foreground, Math.min(1, wave * 2)));
        rainStyles.set(key, style);
      }
      return `${style}${text}${RESET_FG}`;
    },
    fg: (role, text) => {
      if (role === "workingText") {
        return renderRgbForeground(workingColors.base, text);
      }
      if (role === "workingTextShimmer") {
        return renderRgbForeground(workingColors.shimmer, text);
      }

      const staticColor = STATIC_FOREGROUND_COLORS[role];
      if (staticColor) return renderRgbForeground(staticColor, text);

      const themeToken = THEME_FOREGROUND_TOKENS[role];
      if (themeToken && typeof theme.fg === "function") {
        return theme.fg(themeToken, text);
      }
      return text;
    },
    workingPulse: (text, intensity) =>
      renderRgbForeground(
        interpolateRgb(workingColors.base, workingColors.shimmer, intensity),
        text,
      ),
    bg: (role, text) =>
      renderRgbBackground(STATIC_BACKGROUND_COLORS[role], text),
    transition: renderChromeTransition,
  };
}

/** Stable chrome palette for public frame helpers without a host Theme. */
// SAFETY: the fallback palette only calls fg; the remaining Theme methods are intentionally unavailable.
export const DEFAULT_TOKYO_NIGHT_PALETTE = createTokyoNightPalette({
  fg: (_color: string, text: string) => text,
} as unknown as Theme);
