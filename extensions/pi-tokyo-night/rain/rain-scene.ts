import type { TokyoNightThemePalette } from "../ui/theme-palette";
import type { RainFrameSnapshot } from "./rain-manager";
import { rainDrift, rainHorizon, rainLandingRow, rainMoonBounds, rainRippleLife, rainStarRows, rainVerticalScale } from "./rain-geometry";
import { rasterizeRainWater } from "./rain-water";

export type RainInk = "rain" | "moon" | "star" | "water" | "ripple";
type WaterInk = "water" | "moon";
type Cell = { glyph: string; ink: RainInk; light: number; order: number; underlay?: { ink: WaterInk; light: number } };

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
  const wetLight = new Float64Array(width * rows);
  const wetMoon = new Set<number>();
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
  const put = (x: number, y: number, glyph: string, ink: RainInk, light: number, order: number, underlay?: Cell["underlay"]) => {
    const c = Math.floor(x), r = Math.floor(y);
    if (c < 0 || r < 0 || c >= width || r >= rows || light < 0.06) return;
    const i = r * width + c;
    const previous = cells[i];
    if (previous && (previous.order > order ||
      (previous.order === order && previous.light > light))) return;
    const levels = ink === "rain" ? 8 : 32;
    cells[i] = { glyph, ink, light: Math.round(clamp(light) * levels) / levels, order,
      underlay: underlay && { ink: underlay.ink, light: Math.round(clamp(underlay.light) * 32) / 32 } };
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
    const light = cell.light * (1 + Math.max(moonlight * 0.5, starlight * 0.6));
    wetLight[cell.row * width + cell.col] = light;
    if (moonlight > 0.28) wetMoon.add(cell.row * width + cell.col);
    put(cell.col, cell.row, cell.glyph, moonlight > 0.28 ? "moon" : "water", light, 1);
  }

  for (const drop of snapshot.drops) {
    if (!Number.isFinite(drop.col) || !Number.isFinite(drop.row)) continue;
    const depth = Number.isFinite(drop.depth) ? clamp(drop.depth!, 0, 2) : 1;
    if (drop.row >= rainLandingRow(rows, depth)) continue;
    const length = (0.4 + Math.max(0, depth - 1) * 0.55) * verticalScale;
    const drift = rainDrift(wind, depth);
    put(drop.col, drop.row, RAIN_DROP, "rain", 0.58 + depth * 0.14, 10 + depth);
    if (depth > 1 && Math.floor(drop.row - length) < Math.floor(drop.row)) {
      put(drop.col - drift * length, drop.row - length, ".", "rain", 0.18 + depth * 0.1, 10 + depth);
    }
  }

  const ripples = new Map<number, { glyph: string; light: number }>();
  const putRipple = (x: number, y: number, glyph: string, light: number) => {
    const col = Math.floor(x), row = Math.floor(y);
    if (col < 0 || col >= width || row < 0 || row >= rows || light < 0.06) return;
    const index = row * width + col;
    const previous = ripples.get(index);
    if (previous && (previous.light > light || (previous.light === light && previous.glyph <= glyph))) return;
    ripples.set(index, { glyph, light });
  };
  if (horizon < rows) for (const splash of snapshot.splashes ?? []) {
    if (!Number.isFinite(splash.col) || !Number.isFinite(splash.age) ||
      !Number.isFinite(splash.depth) || splash.col < 0 || splash.col >= width || splash.age < 0) continue;
    const depth = clamp(splash.depth, 0, 2);
    const y = rainLandingRow(rows, depth);
    if (depth < 0.5) {
      if (splash.age < 0.22) putRipple(splash.col, y, ".", 0.3 * (1 - splash.age / 0.22));
      continue;
    }
    const life = rainRippleLife(depth);
    if (splash.age >= life) continue;
    const visualAge = splash.age / 1.6;
    const radius = visualAge * (3.5 + depth * 1.6) * Math.min(1, (rows - horizon) / 3);
    const light = (0.5 + depth * 0.15) * (1 - splash.age / life);
    const contactDistance = Math.hypot(
      Math.floor(splash.col) + 0.5 - splash.col,
      (Math.floor(y) + 0.5 - y) * 3.2,
    );
    if (radius < contactDistance - 0.45) putRipple(splash.col, y, ".", light);
    if (visualAge < 0.14) {
      const drift = rainDrift(wind, depth) * visualAge * 4;
      putRipple(splash.col + drift, y - 1, ".", light);
    }
    for (let r = horizon; r < rows; r++) {
      for (let c = Math.max(0, Math.floor(splash.col - radius - 1)); c <= Math.min(width - 1, splash.col + radius + 1); c++) {
        const dx = c + 0.5 - splash.col, dy = (r + 0.5 - y) * 3.2;
        if (Math.abs(Math.hypot(dx, dy) - radius) > 0.45) continue;
        const glyph = splash.age > life * 0.65 ? "."
          : Math.abs(dy) > Math.abs(dx) * 0.45 ? "-" : dx < 0 ? "(" : ")";
        putRipple(c, r, glyph, light);
      }
    }
  }
  for (const [index, ripple] of ripples) {
    put(index % width, Math.floor(index / width), ripple.glyph, "ripple", ripple.light, 20,
      { ink: wetMoon.has(index) ? "moon" : "water", light: wetLight[index] });
  }

  return Array.from({ length: rows }, (_, r) => {
    let line = "", run = "", last: Cell | undefined;
    const flush = () => {
      if (!run) return;
      if (!last || !palette) line += run;
      else if (last.ink === "ripple") {
        const baseLight = last.underlay?.light ?? 0;
        line += palette.rippleShade?.(last.light, baseLight, run, last.underlay?.ink ?? "water") ??
          palette.rainShade?.("water", Math.max(last.light, baseLight), run) ?? palette.fg("rain", run);
      }
      else if (palette.rainShade) line += palette.rainShade(last.ink, last.light, run);
      else line += palette.fg(last.ink === "water" ? "rain" : last.ink, run);
      run = "";
    };
    for (let c = 0; c < width; c++) {
      const cell = cells[r * width + c];
      if (cell?.ink !== last?.ink || cell?.light !== last?.light ||
        cell?.underlay?.ink !== last?.underlay?.ink || cell?.underlay?.light !== last?.underlay?.light) { flush(); last = cell; }
      run += cell?.glyph ?? " ";
    }
    flush();
    return line;
  });
}
