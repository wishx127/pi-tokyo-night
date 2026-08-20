import { describe, expect, it } from "vitest";
import {
  SMOKE_SCENARIOS,
  assertNoFatalOutput,
  assertOrderedCheckpoints,
  assertSmokeExit,
  assertOutputWithinLimit,
  createAgentSettings,
  createFixtureManifest,
  createScenarioCheckpoints,
  createScenarioConfig,
} from "./pi-tui-smoke.mjs";

describe("Pi TUI smoke contract", () => {
  it("treats a timeout as a failure", () => {
    const error = Object.assign(new Error("spawn timed out"), {
      code: "ETIMEDOUT",
    });

    expect(() => assertSmokeExit({ error }, "dark-wide")).toThrow(
      "dark-wide timed out",
    );
  });

  it("requires a clean process exit", () => {
    expect(() =>
      assertSmokeExit({ status: 1, signal: null }, "light-wide"),
    ).toThrow("light-wide exited with code 1");
    expect(() =>
      assertSmokeExit({ status: null, signal: "SIGTERM" }, "ascii-narrow"),
    ).toThrow("ascii-narrow exited with signal SIGTERM");
    expect(() =>
      assertSmokeExit({ status: 0, signal: null }, "dark-wide"),
    ).not.toThrow();
  });

  it("requires positive checkpoints in order", () => {
    expect(() =>
      assertOrderedCheckpoints("first frame ... Neon Studio", [
        "first frame",
        "Neon Studio",
      ]),
    ).not.toThrow();
    expect(() =>
      assertOrderedCheckpoints("Neon Studio ... first frame", [
        "first frame",
        "Neon Studio",
      ]),
    ).toThrow('missing ordered checkpoint "Neon Studio"');
  });

  it("rejects fatal PTY output and extension log entries", () => {
    expect(() =>
      assertNoFatalOutput(
        "render completed",
        "[2026-01-01T00:00:00.000Z] INFO startup complete",
      ),
    ).not.toThrow();
    expect(() =>
      assertNoFatalOutput("UnhandledPromiseRejection: render failed", ""),
    ).toThrow("fatal output");
    expect(() =>
      assertNoFatalOutput(
        "render completed",
        "[2026-01-01T00:00:00.000Z] ERROR [pi-tokyo-night] rain render: failed",
      ),
    ).toThrow("extension log contains an error");
    expect(() =>
      assertNoFatalOutput(
        "render completed",
        "[2026-01-01T00:00:00.000Z] ERROR host render failed",
      ),
    ).toThrow("extension log contains an error");
  });

  it("cannot accept a scenario after its output limit is exceeded", () => {
    expect(() => assertOutputWithinLimit(false, "dark-wide")).not.toThrow();
    expect(() => assertOutputWithinLimit(true, "dark-wide")).toThrow(
      "dark-wide exceeded the output limit",
    );
  });

  it("installs the packed artifact with one exact Pi version", () => {
    expect(createFixtureManifest("file:///tmp/pi-tokyo-night.tgz", "0.80.5")).toEqual({
      private: true,
      dependencies: {
        "@earendil-works/pi-ai": "0.80.5",
        "@earendil-works/pi-coding-agent": "0.80.5",
        "@earendil-works/pi-tui": "0.80.5",
        "@wishx127/pi-tokyo-night": "file:///tmp/pi-tokyo-night.tgz",
      },
    });
  });

  it("loads resources from the installed package manifest", () => {
    expect(
      createAgentSettings(
        { theme: "tokyo-night-light" },
        "/tmp/fixture/node_modules/@wishx127/pi-tokyo-night",
      ),
    ).toEqual({
      theme: "tokyo-night-light",
      packages: ["/tmp/fixture/node_modules/@wishx127/pi-tokyo-night"],
    });
  });

  it("creates isolated scenario configuration", () => {
    expect(createScenarioConfig({ iconMode: "ascii" })).toMatchObject({
      panel: true,
      editorFrame: true,
      codexQuota: false,
      kimiQuota: false,
      iconMode: "ascii",
    });
  });

  it("checks the rendered ASCII status before entering settings", () => {
    expect(
      createScenarioCheckpoints({
        theme: "tokyo-night-dark",
        iconMode: "ascii",
      }),
    ).toEqual([
      "🌙",
      " @ ",
      "Neon Studio",
      "Theme: Tokyo Night Dark",
      "Status Icons: ASCII",
    ]);
  });

  it("covers dark, light, ASCII, and a narrow terminal", () => {
    expect(SMOKE_SCENARIOS).toEqual([
      {
        name: "dark-wide",
        theme: "tokyo-night-dark",
        iconMode: "nerd",
        columns: 100,
        rows: 30,
      },
      {
        name: "light-wide",
        theme: "tokyo-night-light",
        iconMode: "nerd",
        columns: 100,
        rows: 30,
      },
      {
        name: "ascii-narrow",
        theme: "tokyo-night-dark",
        iconMode: "ascii",
        columns: 40,
        rows: 24,
      },
    ]);
  });
});
