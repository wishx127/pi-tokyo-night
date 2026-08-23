// ANSI resets and RGB encoders are kept below the ThemePalette boundary:
// dynamic accents can use the active Theme while Tokyo Night chrome can keep
// its stable original RGB palette.
export const RESET_BG = "\x1b[49m";
export const RESET_FG = "\x1b[39m";

export const fgRgb = (rgb: readonly number[]): string =>
  `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
export const bgRgb = (rgb: readonly number[]): string =>
  `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;

// Rounded box-drawing characters used by the shared frame composer to wrap
// Rain, the active main surface, and Status into one cohesive card.
export const BOX = {
  tl: "╭", // top-left
  tr: "╮", // top-right
  bl: "╰", // bottom-left
  br: "╯", // bottom-right
  h: "─", // horizontal
  v: "│", // vertical
} as const;
