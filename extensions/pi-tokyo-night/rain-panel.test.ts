import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RainPanelComponent, renderRainPanelLines } from "./rain-panel";
import type { RainFrameSnapshot } from "./rain-manager";

const snapshot: RainFrameSnapshot = {
  drops: [{ col: 3, row: 1 }],
  stars: [{ col: 5, row: 1 }],
};

function makeConfig(panel: boolean, editorFrame = true) {
  return {
    get: vi.fn(() => ({
      panel,
      editorFrame,
      rainRows: 3,
      rainTickMs: 130,
      maxRainDrops: 25,
      codexQuota: false,
      kimiQuota: true,
      iconMode: "ascii",
      statusModules: {},
    })),
  };
}

describe("RainPanelComponent", () => {
  it("is a permanent above-editor component whose visibility follows panel config", () => {
    const config = makeConfig(false);
    const rain = {
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    const tui = { requestRender: vi.fn() };
    const renderedAt = vi.fn();
    const panel = new RainPanelComponent(tui as any, {
      config: config as any,
      rain: rain as any,
      onRendered: renderedAt,
    });

    expect(panel.render(40)).toEqual([]);
    expect(renderedAt).not.toHaveBeenCalled();

    config.get.mockReturnValue({
      ...config.get.mock.results[0]!.value,
      panel: true,
    });
    const lines = panel.render(40);
    expect(lines.length).toBe(4);
    expect(lines.join("\n")).toContain("🌙");
    expect(visibleWidth(lines[0])).toBe(40);
    expect(rain.setRenderWidth).toHaveBeenCalledWith(38);
    expect(renderedAt).toHaveBeenCalledOnce();
  });

  it("does not add box chrome when editorFrame is disabled", () => {
    const lines = renderRainPanelLines({
      width: 20,
      frameEnabled: false,
      rainRows: 2,
      snapshot,
    });
    expect(lines.slice(1).join("\n")).not.toMatch(/[╭╮╰╯│─]/);
  });
});
