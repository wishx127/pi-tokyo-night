/** Four rows keep a complete crescent above a single row of water. */
export function rainHorizon(rows: number): number {
  return rows >= 6 ? rows - Math.max(2, Math.round(rows * 0.33)) : rows >= 2 ? rows - 1 : rows;
}

/** Use the upper half of the sky above the water, rounded to whole text rows. */
export function rainStarRows(rows: number): number {
  return Math.max(0, Math.round(rainHorizon(rows) / 2));
}

/** Preserve a readable travel time and short tails in a compact sky. */
export function rainVerticalScale(rows: number): number {
  return Math.min(1, Math.max(1, rainHorizon(rows)) / 5);
}

/** Wind strength varies while the scene keeps falling toward the right. */
export function rainWind(time: number): number {
  return Math.max(0.2, 0.25 + 0.32 * Math.sin(time * 0.37) + 0.13 * Math.sin(time * 0.91));
}

/** Share a rightward slope between simulation, rain tails and impact droplets. */
export function rainDrift(wind: number, depth: number): number {
  const strength = Number.isFinite(wind) ? Math.max(0.2, Math.min(0.7, wind)) : rainWind(0);
  return strength * (0.85 + depth * 0.3);
}

/** Near drops reach farther into the water plane than distant drops. */
export function rainLandingRow(rows: number, depth: number): number {
  const horizon = rainHorizon(rows);
  return horizon === rows ? rows : horizon + depth * (rows - horizon - 0.5) / 2;
}

/** Wet traces linger after the impact ring has faded. */
export function rainWaterMarkLife(depth: number): number {
  return 3 + depth * 0.6;
}

/** Keep a smaller moon at the top, with open sky before the water plane. */
export function rainMoonBounds(width: number, rows: number) {
  const horizon = rainHorizon(rows);
  const curved = rows >= 4 && width >= 2;
  const height = curved ? 1 : 0;
  const columns = curved ? 2 : 0;
  const col = Math.max(0, Math.min(width - columns, 4));
  const reservedHeight = curved ? Math.min(horizon, height + 1) : 0;
  return { col, row: 0, columns, height, reservedHeight, curved };
}
