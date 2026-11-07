import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type StatusTheme = Pick<Theme, "fg">;

/** Collapse control whitespace so one status can never span multiple rows. */
function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Render `ctx.ui.setStatus` entries the way Pi's built-in footer does: one
 * line, sorted by key, sanitized, joined by spaces and truncated with a dim
 * ellipsis. Each status keeps its own ANSI styling. Empty maps render nothing.
 */
export function renderExtensionStatusLines(
  statuses: ReadonlyMap<string, string> | undefined,
  width: number,
  theme: StatusTheme,
): string[] {
  if (!statuses || statuses.size === 0 || width <= 0) return [];
  const line = Array.from(statuses.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeStatusText(text))
    .join(" ");
  return [truncateToWidth(line, width, theme.fg("dim", "..."))];
}
