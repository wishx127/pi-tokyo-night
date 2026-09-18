const BRAILLE_BASE = 0x2800;
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const;

export interface TrendSeries {
  id: string;
  values: readonly number[];
  /** Keep the scale but omit this series from the plotted line. */
  hidden?: boolean;
}

export interface DottedTrendChartRun {
  /** Undefined means an empty plot cell. */
  seriesId: string | undefined;
  text: string;
}

export interface DottedTrendChartRow {
  value: number | undefined;
  axis: "┤" | "│";
  plot: string;
  runs: readonly DottedTrendChartRun[];
}

export interface DottedTrendChart {
  yMax: number;
  yMid: number;
  rows: readonly DottedTrendChartRow[];
}

function safeDimension(value: number, minimum: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : minimum;
}

function finitePositive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Render terminal-native multi-series Braille curves. Each series only draws
 * from its first to last nonzero bucket, leaving leading/trailing inactivity
 * blank. Braille cells cannot color individual dots, so the last series that
 * touches a shared cell owns that whole cell deterministically.
 */
export function renderDottedTrendChart(
  series: readonly TrendSeries[],
  width: number,
  height = 4,
): DottedTrendChart {
  const cellWidth = Number.isFinite(width) && width > 0
    ? safeDimension(width, 1)
    : 0;
  const cellHeight = safeDimension(height, 1);
  const dotWidth = cellWidth * 2;
  const dotHeight = cellHeight * 4;
  const bucketCount = Math.max(0, ...series.map((entry) => entry.values.length));
  const normalizedSeries = series.map((entry) => ({
    id: entry.id,
    hidden: entry.hidden ?? false,
    values: Array.from(
      { length: bucketCount },
      (_, index) => finitePositive(entry.values[index]),
    ),
  }));
  const yMax = Math.max(
    0,
    ...normalizedSeries.flatMap((entry) => entry.values),
  );
  const yMid = yMax / 2;
  const masks = Array.from(
    { length: cellHeight },
    () => new Array<number>(cellWidth).fill(0),
  );
  const owners = Array.from(
    { length: cellHeight },
    () => new Array<string | undefined>(cellWidth).fill(undefined),
  );

  const setDot = (x: number, y: number, seriesId: string): void => {
    if (x < 0 || y < 0 || x >= dotWidth || y >= dotHeight) return;
    const row = Math.floor(y / 4);
    const column = Math.floor(x / 2);
    masks[row]![column]! |= DOT_BITS[x % 2]![y % 4]!;
    owners[row]![column] = seriesId;
  };

  for (const entry of normalizedSeries) {
    if (entry.hidden) continue;
    const firstActiveIndex = entry.values.findIndex((value) => value > 0);
    let lastActiveIndex = -1;
    for (let index = entry.values.length - 1; index >= 0; index--) {
      if (entry.values[index]! > 0) {
        lastActiveIndex = index;
        break;
      }
    }
    if (firstActiveIndex === -1 || yMax === 0) continue;

    let previous: { x: number; y: number } | undefined;
    for (let index = firstActiveIndex; index <= lastActiveIndex; index++) {
      const x = bucketCount <= 1
        ? Math.floor((dotWidth - 1) / 2)
        : Math.round((index / (bucketCount - 1)) * (dotWidth - 1));
      const y = Math.round((1 - entry.values[index]! / yMax) * (dotHeight - 1));

      if (previous) {
        const steps = Math.max(Math.abs(x - previous.x), Math.abs(y - previous.y), 1);
        for (let step = 1; step <= steps; step++) {
          setDot(
            Math.round(previous.x + ((x - previous.x) * step) / steps),
            Math.round(previous.y + ((y - previous.y) * step) / steps),
            entry.id,
          );
        }
      } else {
        setDot(x, y, entry.id);
      }
      previous = { x, y };
    }
  }

  const midpointDot = Math.round((dotHeight - 1) / 2);
  const midpointRow = Math.floor(midpointDot / 4);
  return {
    yMax,
    yMid,
    rows: masks.map((row, rowIndex) => {
      const runs: DottedTrendChartRun[] = [];
      let activeOwner: string | undefined;
      let text = "";
      const flush = (): void => {
        if (text.length === 0) return;
        runs.push({ seriesId: activeOwner, text });
        text = "";
      };

      for (let column = 0; column < cellWidth; column++) {
        const mask = row[column]!;
        const owner = mask === 0 ? undefined : owners[rowIndex]![column];
        if (owner !== activeOwner) {
          flush();
          activeOwner = owner;
        }
        text += mask === 0 ? " " : String.fromCharCode(BRAILLE_BASE + mask);
      }
      flush();

      return {
        value: rowIndex === 0
          ? yMax
          : rowIndex === cellHeight - 1
            ? 0
            : rowIndex === midpointRow
              ? yMid
              : undefined,
        axis: rowIndex === 0 || rowIndex === cellHeight - 1 || rowIndex === midpointRow
          ? "┤"
          : "│",
        plot: row.map((mask) =>
          mask === 0 ? " " : String.fromCharCode(BRAILLE_BASE + mask)
        ).join(""),
        runs,
      };
    }),
  };
}
