import type { RainFrameSnapshot, RainSplash } from "./rain-manager";
import { RAIN_CONTACT_LIFE, rainHorizon, rainLandingRow, rainMoonBounds, rainRippleLife } from "./rain-geometry";

type WaterCell = { col: number; row: number; light: number; glyph: string; ink: "moon" | "ripple" | "water" };

const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

function variation(seed: number, salt: number): number {
  let value = Math.imul((seed >>> 0) ^ (salt + 0x9e3779b9), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function isVisibleImpact(impact: RainSplash, width: number): boolean {
  return Number.isFinite(impact.col) && impact.col >= 0 && impact.col < width &&
    Number.isFinite(impact.depth) && Number.isFinite(impact.age) && impact.age >= 0;
}

/** Draw brief contacts and wet traces over moonlight distorted by raindrops. */
export function rasterizeRainWater(width: number, rows: number, snapshot: RainFrameSnapshot): WaterCell[] {
  const horizon = rainHorizon(rows);
  const waterRows = rows - horizon;
  if (width < 1 || waterRows < 1) return [];

  const contact = new Float64Array(width * waterRows);
  const traces = new Float64Array(contact.length);
  const tilt = new Float64Array(contact.length);
  const moon = rainMoonBounds(width, rows);
  const moonCenter = moon.col + moon.columns / 2;
  const time = Number.isFinite(snapshot.time) ? snapshot.time! : 0;
  const index = (col: number, row: number) => (row - horizon) * width + col;
  const strengthAt = (depth: number, seed: number) => 0.18 * depth + 0.64 * variation(seed, 41);

  for (const { col, row, light } of snapshot.wetTraces ?? []) {
    if (!Number.isInteger(col) || col < 0 || col >= width ||
      !Number.isInteger(row) || row < horizon || row >= rows || !Number.isFinite(light)) continue;
    const cell = index(col, row);
    traces[cell] = Math.max(traces[cell], clamp(light));
  }

  for (const impact of snapshot.waterMarks ?? snapshot.splashes ?? []) {
    if (!isVisibleImpact(impact, width) || impact.age >= RAIN_CONTACT_LIFE) continue;
    const depth = clamp(impact.depth, 2);
    const row = Math.floor(rainLandingRow(rows, depth));
    const cell = index(Math.floor(impact.col), row);
    const light = 1 - smooth((impact.age - 0.08) / (RAIN_CONTACT_LIFE - 0.08));
    contact[cell] = Math.max(contact[cell], light);
  }

  for (const splash of snapshot.splashes ?? []) {
    if (!isVisibleImpact(splash, width)) continue;
    const depth = clamp(splash.depth, 2);
    const life = rainRippleLife(depth);
    const age = splash.age;
    if (age >= life) continue;

    const seed = splash.seed ?? Math.floor(splash.col * 12345);
    const strength = strengthAt(depth, seed);
    const center = rainLandingRow(rows, depth);
    const col = Math.floor(splash.col);
    const travel = clamp((age - 0.12) / (life * 0.80));
    const radius = 0.53 + 1.47 * (1 - (1 - travel) ** 2);
    const flash = smooth((age - 0.12) / 0.22);
    const fade = 1 - smooth((age - life * 0.38) / (life * 0.62));
    const envelope = flash * fade * (0.70 + 0.34 * strength);

    if (!moon.curved) continue;
    const stretch = 1.8 + variation(seed, 29) * 0.48;
    const thickness = 0.45 + variation(seed, 53) * 0.14;
    const left = Math.max(0, col - 2);
    const right = Math.min(width - 1, col + 2);
    for (let x = left; x <= right; x++) {
      if (Math.abs(x + 0.5 - moonCenter) >= 9) continue;
      const dx = x + 0.5 - splash.col;
      for (let y = horizon; y < rows; y++) {
        // The two sides of the wave tilt the reflected beam in opposite directions.
        const distance = Math.hypot(dx, (y + 0.52 - center) * stretch);
        if (distance <= 0.01) continue;
        const band = (distance - radius) / thickness;
        tilt[index(x, y)] += (dx / distance) * band * Math.exp(-band * band * 1.35) * envelope;
      }
    }
  }

  const cells: WaterCell[] = [];
  for (let row = horizon; row < rows; row++) {
    const depth = (row - horizon + 0.5) / waterRows;
    const beamCenter = moonCenter + Math.sin(time * 0.28 + depth) * 0.45;
    const beamWidth = 1.5 + depth * 2.5;
    for (let col = 0; col < width; col++) {
      const cell = index(col, row);
      const refraction = Math.tanh(tilt[cell] * 1.8);
      const reflectedCol = col + refraction * 1.15;
      const swell = Math.sin(reflectedCol * 0.51 - time * 0.48 + row * 1.3);
      const highlight = (0.5 + 0.5 * swell) ** 4;
      const beam = moon.curved ? Math.exp(-(((reflectedCol + 0.5 - beamCenter) / beamWidth) ** 2)) : 0;
      const reflection = beam * (0.1 + 0.48 * highlight) * (1 - 0.25 * Math.abs(refraction));
      let ink: WaterCell["ink"] = "moon";
      let glyph = highlight > 0.56 ? "-" : ".";
      let light = reflection;
      if (traces[cell] > light) {
        light = traces[cell];
        ink = "water";
        glyph = "-";
      }
      const flash = contact[cell];
      if (flash >= 0.055) {
        glyph = "·";
        // Ripple ink reaches full cyan at half intensity.
        light = Math.max(0.055, flash * 0.5);
        ink = "ripple";
      }
      if (light >= 0.055) cells.push({ col, row, glyph, light: clamp(light), ink });
    }
  }

  return cells;
}
