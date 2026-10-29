import type { RainFrameSnapshot } from "./rain-manager";
import { rainHorizon, rainLandingRow, rainWaterMarkLife } from "./rain-geometry";

type WaterCell = { col: number; row: number; light: number; glyph: string };
type WaterGroup = { mass: number; moment: number; spread: number };

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

/** Merge real impacts into one surface before choosing its visible highlights. */
export function rasterizeRainWater(width: number, rows: number, snapshot: RainFrameSnapshot): WaterCell[] {
  const horizon = rainHorizon(rows);
  const waterRows = rows - horizon;
  if (width === 0 || waterRows === 0) return [];
  const field = new Float64Array(width * waterRows);
  const touches = new Set<number>();
  const raise = (col: number, row: number, light: number, touch = false) => {
    if (col < 0 || col >= width || row < horizon || row >= rows) return;
    const index = (row - horizon) * width + col;
    if (light < field[index]) return;
    if (light === field[index]) {
      if (!touch) touches.delete(index);
      return;
    }
    field[index] = light;
    if (touch) touches.add(index);
    else touches.delete(index);
  };

  const disturb = (impact: { col: number; depth: number; age: number }, fresh: boolean) => {
    if (!Number.isFinite(impact.col) || !Number.isFinite(impact.depth) || !Number.isFinite(impact.age) ||
      impact.col < 0 || impact.col >= width || impact.age < 0) return;
    const depth = Math.max(0, Math.min(2, impact.depth));
    const life = rainWaterMarkLife(depth);
    const flashLife = 0.45 + depth * 0.35;
    if (impact.age >= (fresh ? flashLife : life)) return;
    const wetness = smooth(impact.age / (0.15 + depth * 0.2)) * (1 - smooth(impact.age / life));
    const flash = fresh ? (0.34 + depth * 0.06) * Math.exp(-3 * impact.age / flashLife) : 0;
    const strength = Math.max((0.2 + depth * 0.09) * wetness, flash);
    const radius = 0.7 + (0.65 + depth * 0.55) * smooth(impact.age / 0.6) *
      (0.55 + 0.45 * Math.min(1, waterRows / 3));
    const row = Math.floor(rainLandingRow(rows, depth));
    for (let col = Math.max(0, Math.floor(impact.col - radius * 2)); col <= Math.min(width - 1, Math.ceil(impact.col + radius * 2)); col++) {
      const kernel = Math.exp(-2 * ((col + 0.5 - impact.col) / radius) ** 2);
      raise(col, row, strength * kernel, fresh && impact.age < 0.12);
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
    while (spare > 0) {
      let allocated = false;
      for (const region of allocationOrder) {
        const target = Math.min(region.active, Math.max(3, Math.floor((region.end - region.start + 1) * 0.3)));
        if (spare === 0) break;
        if (region.budget >= target) continue;
        region.budget++;
        spare--;
        allocated = true;
      }
      if (!allocated) break;
    }
    for (const region of visible) {
      const count = Math.max(1, Math.ceil(region.budget / 3));
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
        const radius = Math.max(0.5, Math.min(1.6, deviation * 1.65));
        const nearest = Math.floor(center);
        const columns = [nearest, nearest - 1, nearest + 1]
          .sort((a, b) => Math.abs(a + 0.5 - center) - Math.abs(b + 0.5 - center));
        let cells = Math.min(3, Math.floor(available / (groups.length - index)));
        for (const col of columns) {
          if (cells === 0) break;
          if (col < region.start || col > region.end || Math.abs(col + 0.5 - center) > radius || field[offset + col] < 0.06) continue;
          const point = offset + col;
          highlights.push({ col, row, light: field[point], glyph: touches.has(point) ? "." : "-" });
          cells--;
          available--;
        }
      }
    }
  }
  return highlights;
}
