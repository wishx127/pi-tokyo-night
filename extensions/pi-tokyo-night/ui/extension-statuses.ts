// CSI (including SGR colors), OSC/APC/DCS/PM strings and two-byte escapes.
// Kept local because older supported pi-tui releases do not export a strip helper.
const TERMINAL_SEQUENCE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]_P^][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Collect `ctx.ui.setStatus` entries like Pi's built-in footer: sorted by key
 * and whitespace-sanitized. Foreign styling and control sequences are removed
 * so each status renders in its status-bar segment colors. Blank statuses are
 * dropped.
 */
export function collectExtensionStatuses(
  statuses: ReadonlyMap<string, string> | undefined,
): string[] {
  if (!statuses || statuses.size === 0) return [];
  return Array.from(statuses.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => text
      .replace(TERMINAL_SEQUENCE, "")
      .replace(/[\r\n\t]/g, " ")
      .replace(/ +/g, " ")
      .trim())
    .filter((text) => text.length > 0);
}
