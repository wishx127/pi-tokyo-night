import type { RainFrameSnapshot } from "./rain-manager";
import { rainHorizon, rainLandingRow, rainRippleLife, rainWaterMarkLife } from "./rain-geometry";

type WaterCell = { col: number; row: number; light: number; glyph: string };
type WaterGroup = { mass: number; moment: number; spread: number };

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const variation = (seed: number, salt: number) => {
  let value = (seed + Math.imul(salt, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 4294967296;
};

/** Merge real impacts into one surface before outlining its visible wet bands. */
export function rasterizeRainWater(width: number, rows: number, snapshot: RainFrameSnapshot): WaterCell[] {
  const horizon = rainHorizon(rows);
  const waterRows = rows - horizon;
  if (width === 0 || waterRows === 0) return [];
  const field = new Float64Array(width * waterRows);
  const sheen = new Float64Array(field.length).fill(-1);
  const touches = new Set<number>();
  const raise = (col: number, row: number, light: number, touch = false, reflection = -1) => {
    if (col < 0 || col >= width || row < horizon || row >= rows) return;
    const index = (row - horizon) * width + col;
    if (light < field[index]) return;
    if (light === field[index]) {
      if (!touch) touches.delete(index);
      sheen[index] = Math.min(sheen[index], reflection);
      return;
    }
    field[index] = light;
    sheen[index] = reflection;
    if (touch) touches.add(index);
    else touches.delete(index);
  };

  const disturb = (impact: { col: number; depth: number; age: number; seed?: number }, fresh: boolean) => {
    if (!Number.isFinite(impact.col) || !Number.isFinite(impact.depth) || !Number.isFinite(impact.age) ||
      impact.col < 0 || impact.col >= width || impact.age < 0) return;
    const depth = Math.max(0, Math.min(2, impact.depth));
    const life = rainWaterMarkLife(depth);
    const flashLife = 0.45 + depth * 0.35;
    if (impact.age >= (fresh ? flashLife : life)) return;
    const hold = rainRippleLife(depth);
    const fadeAge = Math.max(0, impact.age - hold);
    const wetness = smooth(impact.age / (0.15 + depth * 0.2)) * (1 - smooth(fadeAge / (life - hold)));
    const flash = fresh ? (0.34 + depth * 0.06) * Math.exp(-3 * impact.age / flashLife) : 0;
    const strength = Math.max((0.3 + depth * 0.15) * wetness, flash);
    const radius = 0.7 + (0.95 + depth * 0.85) * smooth(impact.age / 0.6) *
      (0.55 + 0.45 * Math.min(1, waterRows / 3));
    const seed = Number.isFinite(impact.seed) ? impact.seed! >>> 0 : undefined;
    const breadth = seed === undefined ? 1 : 0.72 + variation(seed, 1) * 0.64;
    const skew = seed === undefined ? 0 : (variation(seed, 2) - 0.5) * 0.56;
    const phase = seed === undefined ? 0 : variation(seed, 3) * Math.PI * 2;
    const reach = radius * breadth * (1 + Math.abs(skew));
    const row = Math.floor(rainLandingRow(rows, depth));
    for (let col = Math.max(0, Math.floor(impact.col - reach * 2)); col <= Math.min(width - 1, Math.ceil(impact.col + reach * 2)); col++) {
      const dx = col + 0.5 - impact.col;
      const position = dx / (radius * breadth * (1 + (dx < 0 ? skew : -skew)));
      const reflection = seed === undefined ? -1 : 0.5 + 0.5 * Math.cos(position * 2.8 + phase);
      const texture = seed === undefined ? 1 : 0.78 + 0.22 * Math.cos(position * 3 + phase);
      const kernel = Math.exp(-2 * position ** 2) * texture;
      raise(col, row, strength * kernel, fresh && impact.age < 0.12, reflection);
    }
    if (fresh && impact.age < 0.18) {
      raise(Math.floor(impact.col), row, (0.3 + depth * 0.08) * (1 - impact.age / 0.18), true);
    }
  };
  for (const mark of snapshot.waterMarks ?? []) disturb(mark, false);
  for (const splash of snapshot.splashes ?? []) disturb(splash, true);

  const highlights: WaterCell[] = [];
  for (let row = horizon; row < rows; row++) {
    const offset = (row - horizon) * width;
    const regions: Array<{ start: number; end: number; mass: number; active: number; budget: number }> = [];
    for (let col = 0; col < width; col++) {
      const light = field[offset + col];
      if (light < 0.06) continue;
      const previous = regions.at(-1);
      if (previous && col === previous.end + 1) {
        previous.end = col;
        previous.mass += light;
        previous.active++;
      } else regions.push({ start: col, end: col, mass: light, active: 1, budget: 1 });
    }
    if (regions.length === 0) continue;
    const budget = Math.max(1, Math.floor(width * 0.3));
    // Keep separated wet regions separate; never average across a dry stretch.
    const visible = regions.length <= budget ? regions : Array.from({ length: budget }, (_, index) =>
      regions[budget === 1 ? Math.floor(regions.length / 2) : Math.round(index * (regions.length - 1) / (budget - 1))]);
    const allocationOrder = [...visible].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    let spare = budget - visible.length;
    // Complete broad bands before extending faint contacts into more short fragments.
    for (const region of allocationOrder) {
      const target = Math.min(region.active, Math.max(7, Math.floor((region.end - region.start + 1) * 0.3)));
      const extra = Math.min(spare, target - region.budget);
      region.budget += extra;
      spare -= extra;
    }
    for (const region of visible) {
      const count = Math.max(1, Math.ceil(region.budget / 7));
      const quota = region.mass / count;
      const bins = Array.from({ length: count }, (): WaterGroup => ({ mass: 0, moment: 0, spread: 0 }));
      let bin = 0, remaining = quota;
      // Equal-energy groups move continuously as neighboring impulses brighten or fade.
      for (let col = region.start; col <= region.end; col++) {
        let mass = field[offset + col] >= 0.06 ? field[offset + col] : 0;
        while (mass > 1e-9 && bin < count) {
          const part = bin === count - 1 ? mass : Math.min(mass, remaining);
          const x = col + 0.5;
          bins[bin].mass += part;
          bins[bin].moment += part * x;
          bins[bin].spread += part * x * x;
          mass -= part;
          remaining -= part;
          if (remaining < 1e-9) { bin++; remaining = quota; }
        }
      }
      const groups: Array<{ energy: WaterGroup; center: number }> = [];
      for (const candidate of bins) {
        if (candidate.mass < 1e-9) continue;
        const center = candidate.moment / candidate.mass;
        const previous = groups.at(-1);
        if (previous && center - previous.center < 4) {
          previous.energy.mass += candidate.mass;
          previous.energy.moment += candidate.moment;
          previous.energy.spread += candidate.spread;
          previous.center = previous.energy.moment / previous.energy.mass;
        } else groups.push({ energy: { ...candidate }, center });
      }
      let available = region.budget;
      for (let index = 0; index < groups.length; index++) {
        const { energy, center } = groups[index];
        const mean = energy.moment / energy.mass;
        const deviation = Math.sqrt(Math.max(0, energy.spread / energy.mass - mean * mean));
        const radius = Math.max(0.5, Math.min(2.4, deviation * 2.2));
        const nearest = Math.floor(center);
        const cells = Math.min(5, Math.floor(available / (groups.length - index)));
        const columns = Array.from({ length: 5 }, (_, step) => nearest + step - 2)
          .filter((col) => col >= region.start && col <= region.end &&
            Math.abs(col + 0.5 - center) <= radius && field[offset + col] >= 0.06)
          .sort((a, b) => Math.abs(a + 0.5 - center) - Math.abs(b + 0.5 - center))
          .slice(0, cells).sort((a, b) => a - b);
        for (const col of columns) {
          const point = offset + col;
          const glyph = touches.has(point) ? "."
            : sheen[point] >= 0 ? sheen[point] > 0.72 ? "-"
              : sheen[point] < 0.35 && columns.length >= 3 && col === columns.at(-1) ? "." : "~"
              : Math.abs(col + 0.5 - center) <= 0.75 ? "-" : "~";
          highlights.push({ col, row, light: field[point], glyph });
          available--;
        }
      }
    }
  }
  return highlights;
}
