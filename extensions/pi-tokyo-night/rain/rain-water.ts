import type { RainFrameSnapshot, RainSplash } from "./rain-manager";
import { RAIN_CONTACT_LIFE, rainHorizon, rainLandingRow, rainMoonBounds, rainRippleLife, rainRippleTraits, rainVariation } from "./rain-geometry";

type WaterCell = { col: number; row: number; light: number; glyph: string; ink: "moon" | "ripple" };

const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

function isVisibleImpact(impact: RainSplash, width: number): boolean {
  return Number.isFinite(impact.col) && impact.col >= 0 && impact.col < width &&
    Number.isFinite(impact.depth) && Number.isFinite(impact.age) && impact.age >= 0;
}

/** Sample G's shallow character-density wave over the reflected moonlight. */
export function rasterizeRainWater(width: number, rows: number, snapshot: RainFrameSnapshot): WaterCell[] {
  const horizon = rainHorizon(rows);
  const waterRows = rows - horizon;
  if (width < 1 || waterRows < 1) return [];

  const contact = new Float64Array(width * waterRows);
  const crests = new Float64Array(contact.length);
  const interiors = new Uint8Array(contact.length);
  const tilt = new Float64Array(contact.length);
  const glyphs: Array<string | undefined> = new Array(contact.length);
  const moon = rainMoonBounds(width, rows);
  const moonCenter = moon.col + moon.columns / 2;
  const time = Number.isFinite(snapshot.time) ? snapshot.time! : 0;
  const index = (col: number, row: number) => (row - horizon) * width + col;
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
    const row = Math.floor(rainLandingRow(rows, depth));
    const cell = index(Math.floor(impact.col), row);
    const light = 1 - smooth((impact.age - 0.08) / (RAIN_CONTACT_LIFE - 0.08));
    contact[cell] = Math.max(contact[cell], light);
  }

  for (const splash of snapshot.splashes ?? []) {
    if (!isVisibleImpact(splash, width)) continue;
    const depth = clamp(splash.depth, 2);
    const life = rainRippleLife(depth, splash.seed);
    const age = splash.age;
    if (age >= life) continue;

    const seed = splash.seed ?? Math.floor(splash.col * 12345);
    const traits = rainRippleTraits(seed);
    const center = rainLandingRow(rows, depth);
    const row = Math.floor(center), col = Math.floor(splash.col);
    const travel = clamp((age - 0.12) * traits.spread / (life * 0.80));
    const radius = (0.53 + 1.16 * (1 - (1 - travel) ** 2)) * traits.size;
    const flash = smooth((age - 0.12) / 0.22);
    const fade = 1 - smooth((age - life * 0.38) / (life * 0.62));
    const envelope = 0.78 * flash * fade;
    const reach = Math.ceil(radius + 0.5);
    const waveGlyphs = [",", ":", ";", "+", "*", "-"];
    for (let y = Math.max(horizon, row - 1); y <= Math.min(rows - 1, row + 1); y++) {
      for (let x = Math.max(0, col - reach); x <= Math.min(width - 1, col + reach); x++) {
        // Keep the fading contact hollow instead of relighting it with a crest.
        if (x === col && y === row) continue;
        const salt = (y - row + 16) * 101 + x - col + 32;
        const grain = 0.55 + 0.45 * rainVariation(seed, salt);
        let coverage = 0;
        // Integrate the wave over the cell so thin crests survive a four-row grid.
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
          const dx = x + (sx + 0.5) / 3 - col - 0.5;
          const dy = (y + (sy + 0.5) / 3 - row - 0.5) * 2.2;
          const distance = Math.hypot(dx, dy) / radius;
          if (distance < 0.36 || distance > 1.18) continue;
          coverage += Math.exp(-(((distance - 0.78) / 0.24) ** 2));
        }
        const light = coverage / 9 * envelope * grain * 1.6;
        if (light < 0.055) continue;
        const glyph = waveGlyphs[Math.floor(rainVariation(seed, salt + 993) * waveGlyphs.length)];
        raise(x, y, glyph, Math.min(0.5, light));
        interiors[index(x, y)] = 1;
      }
    }

    if (!moon.curved) continue;
    const stretch = 1.8 + rainVariation(seed, 29) * 0.48;
    const thickness = 0.45 + rainVariation(seed, 53) * 0.14;
    const left = Math.max(0, col - reach);
    const right = Math.min(width - 1, col + reach);
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
      let light = glyph === "." && interiors[cell] ? 0 : reflection;
      const crest = glyphs[cell];
      if (crest !== undefined && crests[cell] > light) {
        light = crests[cell];
        ink = "ripple";
        glyph = crest;
      }
      const flash = contact[cell];
      if (flash >= 0.055) {
        glyph = "*";
        // Ripple ink reaches full cyan at half intensity.
        light = Math.max(0.055, flash * 0.5);
        ink = "ripple";
      }
      if (light >= 0.055) cells.push({ col, row, glyph, light: clamp(light), ink });
    }
  }

  return cells;
}
