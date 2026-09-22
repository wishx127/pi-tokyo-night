import { visibleWidth } from "@earendil-works/pi-tui";
import type { TokyoNightThemePalette } from "./theme-palette";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function renderWorkingText(
  text: string,
  animation: "forward" | "reverse" | "pulse",
  elapsedMs: number,
  palette: TokyoNightThemePalette,
): string {
  if (animation === "pulse") {
    const intensity = (
      Math.sin((elapsedMs / 1000) * Math.PI) + 1
    ) / 2;
    return palette.workingPulse(text, Math.round(intensity * 8) / 8);
  }

  const messageWidth = visibleWidth(text);
  const cycleLength = messageWidth + 20;
  const cyclePosition = Math.floor(
    elapsedMs / (animation === "forward" ? 50 : 200),
  ) % cycleLength;
  const glimmerIndex = animation === "forward"
    ? cyclePosition - 10
    : messageWidth + 10 - cyclePosition;
  const shimmerStart = glimmerIndex - 1;
  const shimmerEnd = glimmerIndex + 1;

  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return palette.fg("workingText", text);
  }

  let column = 0;
  let before = "";
  let shimmer = "";
  let after = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const width = visibleWidth(segment);
    if (column + width <= Math.max(0, shimmerStart)) before += segment;
    else if (column > shimmerEnd) after += segment;
    else shimmer += segment;
    column += width;
  }

  return [
    before && palette.fg("workingText", before),
    shimmer && palette.fg("workingTextShimmer", shimmer),
    after && palette.fg("workingText", after),
  ].filter(Boolean).join("");
}
