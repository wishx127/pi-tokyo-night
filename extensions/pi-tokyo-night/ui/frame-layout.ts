import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOX, FRAME_RGB, RESET, fgRgb } from "./ui-primitives";

export type FrameSegmentRole = "top" | "middle" | "bottom" | "standalone";

export interface FrameSegmentOptions {
  width: number;
  lines: readonly string[];
  frameEnabled: boolean;
  role: FrameSegmentRole;
  padUnframed?: boolean;
}

export interface FrameDockOptions {
  width: number;
  lines: readonly string[];
  frameEnabled: boolean;
  renderBottom?: () => readonly string[];
  recoverLines?: () => readonly string[];
  onBottomError?: (error: unknown) => void;
}

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

export function getFrameContentWidth(
  width: number,
  frameEnabled: boolean,
): number {
  const outputWidth = safeWidth(width);
  return frameEnabled && outputWidth >= 2
    ? outputWidth - 2
    : outputWidth;
}

export function getMainSurfaceFrameRole(
  panelVisible: boolean,
): FrameSegmentRole {
  return panelVisible ? "middle" : "top";
}

function hasTopEdge(role: FrameSegmentRole): boolean {
  return role === "top" || role === "standalone";
}

function hasBottomEdge(role: FrameSegmentRole): boolean {
  return role === "bottom" || role === "standalone";
}

function frameColor(value: string): string {
  return value.length > 0 ? `${fgRgb(FRAME_RGB)}${value}${RESET}` : "";
}

function renderEdge(width: number, edge: "top" | "bottom"): string {
  if (width === 0) return "";
  if (width === 1) return frameColor(edge === "top" ? BOX.tl : BOX.bl);
  const left = edge === "top" ? BOX.tl : BOX.bl;
  const right = edge === "top" ? BOX.tr : BOX.br;
  return frameColor(`${left}${BOX.h.repeat(width - 2)}${right}`);
}

function fitLine(line: string, width: number, pad: boolean): string {
  const clipped = truncateToWidth(line, width);
  return pad
    ? clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)))
    : clipped;
}

/**
 * Render one vertical segment of the shared Tokyo Night frame. Adjacent
 * surfaces own complementary edges so the complete dock has one top and one
 * bottom border regardless of which main surface is active.
 */
export function renderFrameSegment(options: FrameSegmentOptions): string[] {
  const outputWidth = safeWidth(options.width);
  if (!options.frameEnabled) {
    return options.lines.map((line) =>
      fitLine(line, outputWidth, options.padUnframed ?? false)
    );
  }

  const contentWidth = getFrameContentWidth(outputWidth, true);
  const body = options.lines.map((line) => {
    const content = fitLine(line, contentWidth, true);
    return outputWidth >= 2
      ? frameColor(BOX.v) + content + frameColor(BOX.v)
      : content;
  });
  const result: string[] = [];
  if (hasTopEdge(options.role)) result.push(renderEdge(outputWidth, "top"));
  result.push(...body);
  if (hasBottomEdge(options.role)) {
    result.push(renderEdge(outputWidth, "bottom"));
  }
  return result;
}

/** Join a rendered main surface to its Status-owned bottom frame segment. */
export function composeFrameDock(options: FrameDockOptions): string[] {
  let lines = [...options.lines];
  try {
    const bottom = options.renderBottom?.() ?? [];
    if (bottom.length > 0) return [...lines, ...bottom];
  } catch (error) {
    try {
      options.onBottomError?.(error);
    } catch {
      // Error reporting must not prevent the shared frame from closing.
    }
    try {
      if (options.recoverLines) lines = [...options.recoverLines()];
    } catch {
      // Preserve the original main-surface rows if recovery itself fails.
    }
  }

  return [
    ...lines,
    ...renderFrameSegment({
      width: options.width,
      lines: [],
      frameEnabled: options.frameEnabled,
      role: "bottom",
    }),
  ];
}
