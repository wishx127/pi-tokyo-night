import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  SETTINGS,
  TokyoConfigManager,
} from "./config";
import {
  SettingsUIController,
  type SettingsControllerCallbacks,
} from "./settings-controller";
import { RESET } from "./ui-primitives";

function makeController(): SettingsUIController {
  return new SettingsUIController(new TokyoConfigManager(), {
    applyPanelState: vi.fn(),
    onCodexQuotaConfigChange: vi.fn(),
    onKimiQuotaConfigChange: vi.fn(),
    onIconModeConfigChange: vi.fn(),
    onWorkingIndicatorConfigChange: vi.fn(),
    requestEditorRender: vi.fn(),
  });
}

describe("SettingsUIController quota toggle callbacks", () => {
  const DOWN = "\x1b[B";
  const ENTER = "\r";

  function makeDispatchRig() {
    const callbacks: SettingsControllerCallbacks = {
      applyPanelState: vi.fn(),
      onCodexQuotaConfigChange: vi.fn(),
      onKimiQuotaConfigChange: vi.fn(),
      onIconModeConfigChange: vi.fn(),
      onWorkingIndicatorConfigChange: vi.fn(),
      requestEditorRender: vi.fn(),
    };
    const config = new TokyoConfigManager();
    const controller = new SettingsUIController(config, callbacks);
    controller.enter(); // selectedIndex = 0 → "panel"
    return { callbacks, controller, config };
  }

  it("cycles the status icon mode and requests a status render", () => {
    const { callbacks, controller, config } = makeDispatchRig();

    controller.handleInput(DOWN); // panel → editorFrame
    controller.handleInput(DOWN); // editorFrame → codexQuota
    controller.handleInput(DOWN); // codexQuota → kimiQuota
    controller.handleInput(DOWN); // kimiQuota → iconMode
    controller.handleInput(ENTER);

    expect(config.get().iconMode).toBe("ascii");
    expect(callbacks.onIconModeConfigChange).toHaveBeenCalledTimes(1);
    expect(controller.buildLines(80).some((line) => line.includes("ASCII"))).toBe(true);
  });

  it("notifies only the codex callback when toggling codexQuota", () => {
    const { callbacks, controller } = makeDispatchRig();

    controller.handleInput(DOWN); // panel → editorFrame
    controller.handleInput(DOWN); // editorFrame → codexQuota
    controller.handleInput(ENTER);

    expect(callbacks.onCodexQuotaConfigChange).toHaveBeenCalledTimes(1);
    expect(callbacks.onKimiQuotaConfigChange).not.toHaveBeenCalled();
    expect(callbacks.requestEditorRender).toHaveBeenCalled();
  });

  it("notifies only the kimi callback when toggling kimiQuota", () => {
    const { callbacks, controller } = makeDispatchRig();

    controller.handleInput(DOWN); // panel → editorFrame
    controller.handleInput(DOWN); // editorFrame → codexQuota
    controller.handleInput(DOWN); // codexQuota → kimiQuota
    controller.handleInput(ENTER);

    expect(callbacks.onKimiQuotaConfigChange).toHaveBeenCalledTimes(1);
    expect(callbacks.onCodexQuotaConfigChange).not.toHaveBeenCalled();
  });

  it("does not fire quota callbacks for unrelated toggles", () => {
    const { callbacks, controller } = makeDispatchRig();

    controller.handleInput(ENTER); // panel toggle

    expect(callbacks.onCodexQuotaConfigChange).not.toHaveBeenCalled();
    expect(callbacks.onKimiQuotaConfigChange).not.toHaveBeenCalled();
    expect(callbacks.onWorkingIndicatorConfigChange).not.toHaveBeenCalled();
    expect(callbacks.requestEditorRender).toHaveBeenCalled();
  });

  it("notifies the working indicator callback when toggling workingIndicator", () => {
    const { callbacks, controller, config } = makeDispatchRig();

    for (let i = 0; i < SETTINGS.length - 1; i++) {
      controller.handleInput(DOWN); // navigate to the last setting
    }
    controller.handleInput(ENTER);

    expect(config.get().workingIndicator).toBe(false);
    expect(callbacks.onWorkingIndicatorConfigChange).toHaveBeenCalledTimes(1);
    expect(callbacks.onCodexQuotaConfigChange).not.toHaveBeenCalled();
    expect(callbacks.onKimiQuotaConfigChange).not.toHaveBeenCalled();
  });
});

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
