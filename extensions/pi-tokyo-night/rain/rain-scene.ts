import type { TokyoNightThemePalette } from "../ui/theme-palette";
import type { RainFrameSnapshot } from "./rain-manager";
import { rainDrift, rainHorizon, rainLandingRow, rainMoonBounds, rainStarRows, rainVerticalScale } from "./rain-geometry";
import { rasterizeRainWater } from "./rain-water";

export type RainInk = "rain" | "moon" | "star" | "water";
type Cell = { glyph: string; ink: RainInk; light: number; order: number };

export const MOON = "\u{1f319}";
export const STAR = "+";
export const RAIN_DROP = "\\";

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };

/** Stable fallback phases for stars in snapshots without lifecycle metadata. */
function hash(x: number, y: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** Rasterize the scene into terminal cells; physics and the host clock stay outside. */
export function renderRainScene(
  width: number,
  rows: number,
  snapshot: RainFrameSnapshot,
  palette?: TokyoNightThemePalette,
): string[] {
  const cells: Array<Cell | undefined> = new Array(width * rows);
  const time = Number.isFinite(snapshot.time) ? snapshot.time! : 0;
  const wind = snapshot.wind ?? 0.25;
  const horizon = rainHorizon(rows);
  const starRows = rainStarRows(rows);
  const verticalScale = rainVerticalScale(rows);
  const moon = rainMoonBounds(width, rows);
  const moonWidth = moon.columns;
  const moonCol = moon.col, moonRow = moon.row, curvedMoon = moon.curved;
  const inMoon = (col: number, row: number) =>
    col >= moonCol && col < moonCol + moonWidth && row >= moonRow && row < moonRow + moon.reservedHeight;
  const put = (x: number, y: number, glyph: string, ink: RainInk, light: number, order: number) => {
    const c = Math.floor(x), r = Math.floor(y);
    if (c < 0 || r < 0 || c >= width || r >= rows || light < 0.06) return;
    const i = r * width + c;
    const previous = cells[i];
    if (previous && (previous.order > order ||
      (previous.order === order && previous.light > light))) return;
    const levels = ink === "rain" ? 8 : 32;
    cells[i] = { glyph, ink, light: Math.round(clamp(light) * levels) / levels, order };
  };

  const starReflections: Array<{ col: number; light: number }> = [];
  // The manager owns random placement and lifetimes; drawing never invents positions.
  for (const star of snapshot.stars) {
    if (!Number.isFinite(star.col) || !Number.isFinite(star.row) ||
      star.col < 0 || star.col >= width || star.row < 0 || star.row >= starRows) continue;
    if (inMoon(star.col, star.row)) continue;
    const age = Number.isFinite(star.age) ? Math.max(0, star.age!) : time;
    const period = Number.isFinite(star.period) && star.period! > 0 ? star.period!
      : 5 + 2 * hash(star.col + 17, star.row + 31);
    const offset = Number.isFinite(star.phase) ? star.phase! : hash(star.col, star.row);
    const phase = (age / period + offset) * Math.PI * 2;
    const envelope = star.age === undefined ? 1 : smooth(age / 0.7) *
      (Number.isFinite(star.life) ? smooth((star.life! - age) / 0.9) : 1);
    const light = (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(phase))) * envelope;
    put(star.col, star.row, STAR, "star", light, 31);
    starReflections.push({ col: star.col, light });
  }

  if (curvedMoon) {
    // The emoji spans two terminal columns; its continuation emits no extra space.
    for (let r = 0; r < moon.reservedHeight; r++) for (let c = 0; c < moonWidth; c++) {
      const glyph = r === 0 ? c === 0 ? MOON : "" : " ";
      put(moonCol + c, moonRow + r, glyph, "moon", glyph === " " ? 1 : 0.75, 30);
    }
  }

  for (const cell of rasterizeRainWater(width, rows, snapshot)) {
    const moonlight = curvedMoon
      ? Math.exp(-(((cell.col + 0.5 - moonCol - moonWidth / 2) / (2 + (cell.row - horizon) * 2.5)) ** 2)) : 0;
    let starlight = 0;
    for (const star of starReflections) {
      starlight = Math.max(starlight, star.light *
        Math.exp(-(((cell.col + 0.5 - star.col) / (1 + (cell.row - horizon) * 1.5)) ** 2)));
    }
    put(cell.col, cell.row, cell.glyph, moonlight > 0.28 ? "moon" : "water",
      cell.light * (1 + Math.max(moonlight * 0.5, starlight * 0.6)), 1);
  }

  for (const drop of snapshot.drops) {
    if (!Number.isFinite(drop.col) || !Number.isFinite(drop.row)) continue;
    const depth = Number.isFinite(drop.depth) ? clamp(drop.depth!, 0, 2) : 1;
    const length = (depth <= 1 ? 0.6 + depth * 0.4 : 1 + (depth - 1) * 1.4) * verticalScale;
    const drift = rainDrift(wind, depth);
    const glyph = RAIN_DROP;
    for (let s = 0; s <= length; s += 0.35) {
      const y = drop.row - s;
      if (y >= rainLandingRow(rows, depth)) continue;
      put(drop.col - drift * s, y, s > length * 0.75 ? "." : glyph,
        "rain", (0.58 + depth * 0.14) * (1 - s / (length + 0.5)), 10 + depth);
    }
  }

  return Array.from({ length: rows }, (_, r) => {
    let line = "", run = "", last: Cell | undefined;
    const flush = () => {
      if (!run) return;
      if (!last || !palette) line += run;
      else if (palette.rainShade) line += palette.rainShade(last.ink, last.light, run);
      else line += palette.fg(last.ink === "water" ? "rain" : last.ink, run);
      run = "";
    };
    for (let c = 0; c < width; c++) {
      const cell = cells[r * width + c];
      if (cell?.ink !== last?.ink || cell?.light !== last?.light) { flush(); last = cell; }
      run += cell?.glyph ?? " ";
    }
    flush();
    return line;
  });
}
