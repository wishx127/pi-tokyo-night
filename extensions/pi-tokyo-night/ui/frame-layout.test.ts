import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  composeFrameDock,
  getFrameContentWidth,
  getMainSurfaceFrameRole,
  renderFrameSegment,
} from "./frame-layout";

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;]*m/g, "");

describe("shared frame layout", () => {
  it("composes top, middle, and bottom surfaces into one continuous card", () => {
    const lines = [
      ...renderFrameSegment({
        width: 12,
        lines: ["rain"],
        frameEnabled: true,
        role: "top",
      }),
      ...renderFrameSegment({
        width: 12,
        lines: ["studio"],
        frameEnabled: true,
        role: "middle",
      }),
      ...renderFrameSegment({
        width: 12,
        lines: ["status"],
        frameEnabled: true,
        role: "bottom",
      }),
    ].map(stripAnsi);

    expect(lines).toEqual([
      "╭──────────╮",
      "│rain      │",
      "│studio    │",
      "│status    │",
      "╰──────────╯",
    ]);
    expect(lines.join("").match(/╭/g)).toHaveLength(1);
    expect(lines.join("").match(/╰/g)).toHaveLength(1);
  });

  it("composes a rendered Status bottom or closes the frame on failure", () => {
    const middle = renderFrameSegment({
      width: 12,
      lines: ["studio"],
      frameEnabled: true,
      role: "middle",
    });
    const bottom = renderFrameSegment({
      width: 12,
      lines: ["status"],
      frameEnabled: true,
      role: "bottom",
    });

    expect(composeFrameDock({
      width: 12,
      lines: middle,
      frameEnabled: true,
      renderBottom: () => bottom,
    }).map(stripAnsi)).toEqual([
      "│studio    │",
      "│status    │",
      "╰──────────╯",
    ]);

    const onBottomError = vi.fn();
    const recovered = composeFrameDock({
      width: 12,
      lines: middle,
      frameEnabled: true,
      renderBottom: () => {
        throw new Error("status failed");
      },
      recoverLines: () => renderFrameSegment({
        width: 12,
        lines: ["fallback"],
        frameEnabled: true,
        role: "middle",
      }),
      onBottomError,
    }).map(stripAnsi);

    expect(onBottomError).toHaveBeenCalledOnce();
    expect(recovered).toEqual([
      "│fallback  │",
      "╰──────────╯",
    ]);
  });

  it("assigns top ownership to the main surface only without Rain", () => {
    expect(getMainSurfaceFrameRole(true)).toBe("middle");
    expect(getMainSurfaceFrameRole(false)).toBe("top");
  });

  it("uses the same framed content width for every surface", () => {
    expect(getFrameContentWidth(12, true)).toBe(10);
    expect(getFrameContentWidth(12, false)).toBe(12);
    expect(getFrameContentWidth(1, true)).toBe(1);
    expect(getFrameContentWidth(0, true)).toBe(0);
  });

  it("removes all box chrome when framing is disabled", () => {
    const lines = renderFrameSegment({
      width: 8,
      lines: ["content too wide"],
      frameEnabled: false,
      role: "standalone",
    });

    expect(stripAnsi(lines[0])).toBe("conte...");
    expect(visibleWidth(lines[0])).toBe(8);
    expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│─]/);
  });

  it.each([0, 1, 2, 5, 20])(
    "keeps all segment roles bounded at width=%i",
    (width) => {
      for (const role of ["top", "middle", "bottom", "standalone"] as const) {
        const lines = renderFrameSegment({
          width,
          lines: ["wide content"],
          frameEnabled: true,
          role,
        });
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    },
  );
});
