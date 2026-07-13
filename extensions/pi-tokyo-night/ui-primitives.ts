// ── Tokyo Night ANSI Colors ─────────────────────────────────────────────────
// Pre-computed ANSI escape codes for the status bar gradient.
// These are custom RGB colors not available as theme tokens.
export const PURPLE = "\x1b[38;2;187;154;247m"; // #bb9af7 - prompt char
export const CYAN = "\x1b[38;2;125;202;247m"; // #7dcfff - rain drops
export const RESET = "\x1b[0m";
export const RESET_BG = "\x1b[49m";
export const RESET_FG = "\x1b[39m";

// Rounded box-drawing characters used to wrap editor + status bar
// into a single cohesive card.
export const BOX = {
  tl: "╭", // top-left
  tr: "╮", // top-right
  bl: "╰", // bottom-left
  br: "╯", // bottom-right
  h: "─", // horizontal
  v: "│", // vertical
} as const;
export const FRAME_RGB: number[] = [61, 53, 119]; // #3d3577 - borderMuted, subtle purple frame

export const fgRgb = (rgb: number[]): string =>
  `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
export const bgRgb = (rgb: number[]): string =>
  `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
