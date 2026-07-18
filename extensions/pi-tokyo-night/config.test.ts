import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { getAgentDir } = vi.hoisted(() => ({
  getAgentDir: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir }));

import { DEFAULT_CONFIG, TokyoConfigManager } from "./config";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tokyo-night-config-"));
  getAgentDir.mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("TokyoConfigManager validation", () => {
  it("keeps exported defaults immutable and stable for new managers", () => {
    const originalDefaults = { ...DEFAULT_CONFIG };

    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(() => {
      (DEFAULT_CONFIG as unknown as { rainRows: number }).rainRows = 0;
    }).toThrow();
    expect(new TokyoConfigManager().get()).toEqual(originalDefaults);
  });

  it("falls back to defaults for invalid persisted values", () => {
    fs.writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        "pi-tokyo-night": {
          panel: "yes",
          codexQuota: 1,
          rainRows: 0,
          rainTickMs: 100.5,
          maxRainDrops: 101,
        },
      }),
    );

    const manager = new TokyoConfigManager();
    manager.read();

    expect(manager.get()).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    ["rainRows", -1],
    ["rainRows", 0],
    ["rainRows", 1.5],
    ["rainRows", 11],
    ["rainTickMs", -1],
    ["rainTickMs", 0],
    ["rainTickMs", 50.5],
    ["rainTickMs", 1001],
    ["maxRainDrops", -1],
    ["maxRainDrops", 0],
    ["maxRainDrops", 5.5],
    ["maxRainDrops", 101],
    ["rainRows", Infinity],
    ["rainRows", NaN],
    ["rainTickMs", Infinity],
    ["rainTickMs", NaN],
    ["maxRainDrops", Infinity],
    ["maxRainDrops", NaN],
  ] as Array<[keyof typeof DEFAULT_CONFIG, number]>) (
    "does not allow invalid %s=%s through set()",
    (key, value) => {
      const manager = new TokyoConfigManager();
      manager.set(key, value);

      expect(manager.get()[key]).toBe(DEFAULT_CONFIG[key]);
    },
  );

  it("rejects unknown runtime keys without changing the config", () => {
    const manager = new TokyoConfigManager();
    const originalConfig = manager.get();
    const unknownKey = "unknownSetting" as keyof typeof DEFAULT_CONFIG;

    manager.set(unknownKey, 123);

    expect(manager.get()).toEqual(originalConfig);
    expect(Object.hasOwn(manager.get(), unknownKey)).toBe(false);
  });

  it("does not allow mutations of a returned snapshot to affect the manager", () => {
    const manager = new TokyoConfigManager();
    const snapshot = manager.get() as unknown as {
      rainTickMs: number;
      maxRainDrops: number;
      rainRows: number;
    };

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      snapshot.rainTickMs = 0;
    }).toThrow();
    expect(() => {
      snapshot.maxRainDrops = Infinity;
    }).toThrow();
    expect(() => {
      snapshot.rainRows = Infinity;
    }).toThrow();
    expect(manager.get()).toEqual(DEFAULT_CONFIG);
  });

  it("keeps valid values through set()", () => {
    const manager = new TokyoConfigManager();

    manager.set("rainRows", 10);
    manager.set("rainTickMs", 50);
    manager.set("maxRainDrops", 100);

    expect(manager.get()).toMatchObject({
      rainRows: 10,
      rainTickMs: 50,
      maxRainDrops: 100,
    });
  });
});

describe("TokyoConfigManager persistence", () => {
  it("creates missing parent directories and settings.json", () => {
    const agentDir = path.join(tempDir, "nested", "agent");
    getAgentDir.mockReturnValue(agentDir);
    const manager = new TokyoConfigManager();
    manager.set("panel", false);

    expect(manager.write()).toBe(true);

    const settingsPath = path.join(agentDir, "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))["pi-tokyo-night"]).toEqual({
      ...DEFAULT_CONFIG,
      panel: false,
    });
  });

  it("preserves unrelated top-level settings", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "custom", nested: { enabled: true } }),
    );
    const manager = new TokyoConfigManager();
    manager.set("codexQuota", true);

    expect(manager.write()).toBe(true);

    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "custom",
      nested: { enabled: true },
      "pi-tokyo-night": { ...DEFAULT_CONFIG, codexQuota: true },
    });
  });

  it("resets to defaults when a legal settings.json has no extension node", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    const manager = new TokyoConfigManager();
    manager.set("panel", false);
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "custom" }));

    manager.read();

    expect(manager.get()).toEqual(DEFAULT_CONFIG);
  });

  it("resets to defaults when settings.json is damaged", () => {
    fs.writeFileSync(path.join(tempDir, "settings.json"), "{not json");
    const manager = new TokyoConfigManager();
    manager.set("panel", false);

    manager.read();

    expect(manager.get()).toEqual(DEFAULT_CONFIG);
  });

  it("returns false and preserves the original file when atomic rename fails", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    const original = { theme: "custom", "pi-tokyo-night": { panel: true } };
    fs.writeFileSync(settingsPath, JSON.stringify(original));
    const manager = new TokyoConfigManager();
    manager.set("panel", false);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });

    expect(manager.write()).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(original);
  });
});
