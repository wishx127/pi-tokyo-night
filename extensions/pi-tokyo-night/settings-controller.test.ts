import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TokyoConfigManager } from "./config";
import { SettingsUIController } from "./settings-controller";
import { RESET } from "./ui-primitives";

function makeController(): SettingsUIController {
  return new SettingsUIController(new TokyoConfigManager(), {
    applyPanelState: vi.fn(),
    onCodexQuotaConfigChange: vi.fn(),
    requestEditorRender: vi.fn(),
  });
}

describe("SettingsUIController.buildLines", () => {
  it.each([0, 1, 2, 5])(
    "keeps every panel line within innerWidth=%i",
    (innerWidth) => {
      const controller = makeController();
      controller.enter();

      for (const line of controller.buildLines(innerWidth)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(innerWidth);
      }
    },
  );

  it("returns no output at innerWidth=0", () => {
    const controller = makeController();
    controller.enter();

    expect(controller.buildLines(0)).toEqual([
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  });

  it("closes ANSI styling on every colored line, including the title", () => {
    const controller = makeController();
    controller.enter();

    for (const line of controller.buildLines(80)) {
      if (line.includes("\x1b[")) {
        expect(line.endsWith(RESET)).toBe(true);
      }
    }

    for (const line of controller.buildLines(1)) {
      if (line.includes("\x1b[")) {
        expect(line.endsWith(RESET)).toBe(true);
      }
    }
  });
});
