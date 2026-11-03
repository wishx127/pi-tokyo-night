import type { RainFrameSnapshot, RainSplash } from "./rain-manager";
import { RAIN_CONTACT_LIFE, rainHorizon, rainLandingRow, rainMoonBounds, rainRippleLife } from "./rain-geometry";

type WaterCell = { col: number; row: number; light: number; glyph: string; ink: "moon" | "ripple" };

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

function arcDirection(glyph: string): string {
  return glyph === "⟮" ? "(" : glyph === "⟯" ? ")" : glyph;
}

/** Draw brief contacts and compact waves over a moon reflection that bends as waves pass. */
export function rasterizeRainWater(width: number, rows: number, snapshot: RainFrameSnapshot): WaterCell[] {
  const horizon = rainHorizon(rows);
  const waterRows = rows - horizon;
  if (width < 1 || waterRows < 1) return [];

  const contact = new Float64Array(width * waterRows);
  const crests = new Float64Array(contact.length);
  const tilt = new Float64Array(contact.length);
  const glyphs: Array<string | undefined> = new Array(contact.length);
  const moon = rainMoonBounds(width, rows);
  const moonCenter = moon.col + moon.columns / 2;
  const time = Number.isFinite(snapshot.time) ? snapshot.time! : 0;
  const index = (col: number, row: number) => (row - horizon) * width + col;
  const strengthAt = (depth: number, seed: number) => 0.18 * depth + 0.64 * variation(seed, 41);
  const raise = (col: number, row: number, glyph: string, light: number) => {
    if (col < 0 || col >= width) return;
    const cell = index(col, row);
    const previous = glyphs[cell];
    if (light < crests[cell] || (light === crests[cell] && previous !== undefined && glyph >= previous)) return;
    crests[cell] = light;
    glyphs[cell] = glyph;
  };

  for (const impact of snapshot.waterMarks ?? snapshot.splashes ?? []) {
    if (!isVisibleImpact(impact, width) || impact.age >= RAIN_CONTACT_LIFE) continue;
    const depth = clamp(impact.depth, 2);
    const strength = strengthAt(depth, impact.seed ?? Math.floor(impact.col * 12345));
    const row = Math.floor(rainLandingRow(rows, depth));
    const cell = index(Math.floor(impact.col), row);
    const light = (0.76 + 0.24 * strength) * (1 - smooth((impact.age - 0.12) / (0.45 + 0.14 * strength)));
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
    const row = Math.floor(center), col = Math.floor(splash.col);
    const travel = smooth((age / life - 0.10) / (0.74 - 0.08 * strength));
    const radius = 0.38 + 1.64 * travel;
    const flash = smooth((age - 0.06) / (0.32 - 0.08 * strength));
    const fade = 1 - smooth((age - life * 0.57) / (life * 0.43));
    const envelope = flash * fade * (0.70 + 0.34 * strength);
    const glint = (0.26 + 0.08 * strength) * smooth((age - 0.06) / 0.14) *
      (1 - smooth((age - 0.35) / 0.15));
    const outer = radius >= 1.5;
    const offset = outer ? 2 : 1;
    const edge = 0.63 * envelope * smooth((radius - 0.58) / 0.30) *
      Math.exp(-(((offset - radius) / 0.69) ** 2));

    if (glint >= 0.055) raise(col, row, glint >= 0.22 ? "_" : ".", glint);
    if (edge >= 0.055) {
      raise(col - offset, row, edge < 0.22 ? "." : outer ? "(" : "⟮", edge);
      raise(col + offset, row, edge < 0.22 ? "." : outer ? ")" : "⟯", edge);
    }

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
      let light = reflection;
      let ink: WaterCell["ink"] = "moon";
      let glyph = highlight > 0.56 ? "-" : ".";
      const crest = glyphs[cell];
      if (crest !== undefined && crests[cell] > light) {
        light = crests[cell];
        ink = "ripple";
        glyph = crest;
      }
      const flash = contact[cell];
      if (flash > light || flash > 0.55) {
        if (ink !== "ripple" || glyph !== "_") glyph = flash > 0.84 ? "o" : ".";
        light = Math.max(light, flash);
        ink = "ripple";
      }
      if (light >= 0.055) cells.push({ col, row, glyph, light: clamp(light), ink });
    }
  }

  // Where two waves touch, show the outer arc and let both highlights fade independently.
  let previous: WaterCell | undefined;
  let previousDirection: string | undefined;
  for (const cell of cells) {
    const direction = arcDirection(cell.glyph);
    if (previous && direction === previousDirection && cell.row === previous.row && cell.col === previous.col + 1) {
      if (direction === "(") cell.glyph = ".";
      if (direction === ")") previous.glyph = ".";
    }
    previous = cell;
    previousDirection = direction;
  }
  return cells;
}
