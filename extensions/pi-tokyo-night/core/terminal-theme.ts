import type {
  RgbColor,
  TerminalColorScheme,
} from "@earendil-works/pi-tui";

export type TerminalThemeSource =
  | "terminal-scheme"
  | "terminal-background"
  | "COLORFGBG"
  | "fallback";

export interface TerminalThemeDetection {
  readonly scheme: TerminalColorScheme;
  readonly source: TerminalThemeSource;
}

export interface TerminalThemeQueryTarget {
  queryTerminalColorScheme?: (options: {
    timeoutMs: number;
  }) => Promise<TerminalColorScheme | undefined>;
  queryTerminalBackgroundColor: (options: {
    timeoutMs: number;
  }) => Promise<RgbColor | undefined>;
}

export interface TerminalThemeDetectionOptions {
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
}

const ANSI_16_COLORS: readonly RgbColor[] = [
  { r: 0, g: 0, b: 0 },
  { r: 128, g: 0, b: 0 },
  { r: 0, g: 128, b: 0 },
  { r: 128, g: 128, b: 0 },
  { r: 0, g: 0, b: 128 },
  { r: 128, g: 0, b: 128 },
  { r: 0, g: 128, b: 128 },
  { r: 192, g: 192, b: 192 },
  { r: 128, g: 128, b: 128 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

function ansiColor(index: number): RgbColor {
  if (index < ANSI_16_COLORS.length) return ANSI_16_COLORS[index];
  if (index <= 231) {
    const value = index - 16;
    const levels = [0, 95, 135, 175, 215, 255] as const;
    return {
      r: levels[Math.floor(value / 36) % 6],
      g: levels[Math.floor(value / 6) % 6],
      b: levels[value % 6],
    };
  }
  const gray = 8 + (index - 232) * 10;
  return { r: gray, g: gray, b: gray };
}

function colorFgBgIndex(value: string): number | undefined {
  const parts = value.split(";");
  for (let index = parts.length - 1; index >= 0; index--) {
    const candidate = Number.parseInt(parts[index].trim(), 10);
    if (Number.isInteger(candidate) && candidate >= 0 && candidate <= 255) {
      return candidate;
    }
  }
  return undefined;
}

function rgbLuminance({ r, g, b }: RgbColor): number {
  const toLinear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Detect the terminal's current light/dark preference through public TUI APIs. */
export async function detectTerminalTheme(
  target: TerminalThemeQueryTarget,
  options: TerminalThemeDetectionOptions,
): Promise<TerminalThemeDetection> {
  try {
    const scheme = await target.queryTerminalColorScheme?.({
      timeoutMs: options.timeoutMs,
    });
    if (scheme) return { scheme, source: "terminal-scheme" };
  } catch {
    // Continue through the terminal background and environment fallbacks.
  }

  try {
    const background = await target.queryTerminalBackgroundColor({
      timeoutMs: options.timeoutMs,
    });
    if (background) {
      return {
        scheme: rgbLuminance(background) >= 0.5 ? "light" : "dark",
        source: "terminal-background",
      };
    }
  } catch {
    // Continue through the environment fallback.
  }

  const backgroundIndex = colorFgBgIndex(
    (options.env ?? process.env).COLORFGBG ?? "",
  );
  if (backgroundIndex !== undefined) {
    return {
      scheme: rgbLuminance(ansiColor(backgroundIndex)) >= 0.5
        ? "light"
        : "dark",
      source: "COLORFGBG",
    };
  }

  return { scheme: "dark", source: "fallback" };
}
