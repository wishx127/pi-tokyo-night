import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TokyoNightThemePalette } from "./theme-palette";

// CSI (colors, cursor) and OSC/APC (hyperlinks, markers) sequences. Kept local
// because older supported pi-tui releases do not export a strip helper.
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** Drop foreign styling and control whitespace so one status stays one themed row. */
function sanitizeStatusText(text: string): string {
  return text
    .replace(TERMINAL_SEQUENCE, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Join `ctx.ui.setStatus` entries the way Pi's built-in footer does: sorted by
 * key, sanitized and space-joined. Returns "" when there is nothing to show, so
 * the result doubles as a render-cache key.
 */
export function formatExtensionStatusText(
  statuses: ReadonlyMap<string, string> | undefined,
): string {
  if (!statuses || statuses.size === 0) return "";
  return Array.from(statuses.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeStatusText(text))
    .filter((text) => text.length > 0)
    .join(" ");
}

/** Render the joined status text as one Tokyo Night status row, or nothing. */
export function renderExtensionStatusLines(
  text: string,
  width: number,
  palette: TokyoNightThemePalette,
): string[] {
  if (text.length === 0 || width <= 0) return [];
  return [truncateToWidth(
    palette.fg("statusExtensions", text),
    width,
    palette.fg("statusExtensions", "..."),
  )];
}
