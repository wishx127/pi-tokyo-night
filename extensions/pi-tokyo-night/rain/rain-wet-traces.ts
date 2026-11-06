export interface RainWetTrace {
  readonly col: number;
  readonly row: number;
  readonly light: number;
}

type TimedCell = { col: number; row: number; time: number };

const CONTACT_WINDOW = 3;
const TRACE_DELAY = 0.18;
const TRACE_RISE = 0.32;
const TRACE_LIFE = 1.85;
const MAX_HISTORY = 1024;

function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** Turn each pair of nearby landings into a delayed, fading water trace. */
export class RainWetTraces {
  private pending: TimedCell[] = [];
  private traces: TimedCell[] = [];

  record(col: number, row: number, time: number): void {
    if (!Number.isFinite(col) || !Number.isFinite(row) || !Number.isFinite(time) || col < 0 || row < 0) return;
    col = Math.floor(col);
    row = Math.floor(row);
    this.pending = this.pending.filter(hit => time - hit.time < CONTACT_WINDOW);
    this.traces = this.traces.filter(trace => time - trace.time < TRACE_LIFE);

    const match = this.pending.findIndex(hit =>
      hit.row === row && Math.abs(hit.col - col) <= 1 && Math.abs(time - hit.time) < CONTACT_WINDOW);
    if (match < 0) {
      this.pending.push({ col, row, time });
      if (this.pending.length > MAX_HISTORY) this.pending.shift();
      return;
    }
    const [first] = this.pending.splice(match, 1);
    this.traces.push({
      col: Math.round((first.col + col) / 2),
      row,
      time: Math.max(first.time, time) + TRACE_DELAY,
    });
    if (this.traces.length > MAX_HISTORY) this.traces.shift();
  }

  get(time: number): readonly RainWetTrace[] {
    const cells = new Map<string, RainWetTrace>();
    for (const trace of this.traces) {
      const age = time - trace.time;
      if (age <= 0 || age >= TRACE_LIFE) continue;
      const light = 0.31 * smooth(age / TRACE_RISE) *
        (1 - smooth((age - TRACE_RISE) / (TRACE_LIFE - TRACE_RISE)));
      if (light < 0.055) continue;
      const { col, row } = trace;
      const key = col + ":" + row;
      if ((cells.get(key)?.light ?? 0) < light) cells.set(key, { col, row, light });
    }
    return [...cells.values()];
  }

  clear(): void {
    this.pending = [];
    this.traces = [];
  }
}
