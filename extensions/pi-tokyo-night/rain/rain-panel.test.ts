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
    const panel = new RainPanelComponent(tui as any, {
      config: config as any,
      rain: rain as any,
    });

    expect(panel.render(40)).toEqual([]);

    config.get.mockReturnValue({
      ...config.get.mock.results[0]!.value,
      panel: true,
    });
    const lines = panel.render(40);
    expect(lines.length).toBe(4);
    expect(lines.join("\n")).toContain("🌙");
    expect(visibleWidth(lines[0])).toBe(40);
    expect(rain.setRenderWidth).toHaveBeenCalledWith(38);
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

  it("reuses rendered lines until the rain frame revision changes", () => {
    const config = makeConfig(true);
    let frameRevision = 1;
    const rain = {
      get frameRevision() { return frameRevision; },
      getSnapshot: vi.fn(() => snapshot),
      setRenderWidth: vi.fn(),
    };
    const panel = new RainPanelComponent({ requestRender: vi.fn() } as any, {
      config: config as any,
      rain: rain as any,
    });

    const first = panel.render(40);
    const cached = panel.render(40);

    expect(cached).toBe(first);
    expect(rain.getSnapshot).toHaveBeenCalledOnce();

    frameRevision += 1;
    const changed = panel.render(40);
    expect(changed).not.toBe(first);
    expect(rain.getSnapshot).toHaveBeenCalledTimes(2);

    panel.invalidate();
    expect(panel.render(40)).not.toBe(changed);
    expect(rain.getSnapshot).toHaveBeenCalledTimes(3);
  });
});
