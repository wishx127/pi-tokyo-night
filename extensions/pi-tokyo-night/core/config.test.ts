import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { getAgentDir } = vi.hoisted(() => ({
  getAgentDir: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir }));

import {
  DEFAULT_CONFIG,
  SETTINGS,
  TokyoConfigManager,
} from "./config";

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
          kimiQuota: "yes",
          iconMode: "auto",
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

  it.each(["panel", "editorFrame", "codexQuota", "kimiQuota"] as const)(
    "does not allow a non-boolean %s through set()",
    (key) => {
      const manager = new TokyoConfigManager();
      manager.set(key, 1 as unknown as boolean);

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

    manager.set("editorFrame", false);
    manager.set("rainRows", 10);
    manager.set("rainTickMs", 50);
    manager.set("maxRainDrops", 100);

    expect(manager.get()).toMatchObject({
      editorFrame: false,
      rainRows: 10,
      rainTickMs: 50,
      maxRainDrops: 100,
    });
  });

  it("defaults, validates, and persists the status icon mode", () => {
    const manager = new TokyoConfigManager();

    expect(manager.get().iconMode).toBe("nerd");
    manager.set("iconMode", "ascii");
    expect(manager.get().iconMode).toBe("ascii");

    manager.set("iconMode", "auto" as unknown as "nerd");
    expect(manager.get().iconMode).toBe("nerd");

    expect(manager.write()).toBe(true);
    const reader = new TokyoConfigManager();
    reader.read();
    expect(reader.get().iconMode).toBe("nerd");
  });

  it("updates status module visibility through immutable snapshots", () => {
    const manager = new TokyoConfigManager();
    const previous = manager.get();

    manager.setStatusModule("model", false);

    expect(manager.get()).not.toBe(previous);
    expect(manager.get().statusModules).not.toBe(previous.statusModules);
    expect(manager.get().statusModules.model).toBe(false);
    expect(Object.isFrozen(manager.get().statusModules)).toBe(true);
    expect(previous.statusModules.model).toBe(true);
  });

  it("does not expose the nested statusModules object as a scalar setting", () => {
    expect(SETTINGS.some((setting) => setting.id === "statusModules")).toBe(false);
  });

  it("loads file-based status module visibility with true defaults", () => {
    fs.writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        "pi-tokyo-night": {
          statusModules: {
            model: false,
            path: false,
            cost: false,
          },
        },
      }),
    );

    const manager = new TokyoConfigManager();
    manager.read();

    expect(manager.get().statusModules).toEqual({
      model: false,
      thinking: true,
      path: false,
      git: true,
      quota: true,
      tokens: true,
      cost: false,
      context: true,
    });
  });
});

describe("TokyoConfigManager persistence", () => {
  it("migrates legacy settings into the dedicated file without deleting the legacy key", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    const legacySettings = {
      theme: "tokyo-night-dark",
      "pi-tokyo-night": {
        panel: false,
        iconMode: "ascii",
        statusModules: { cost: false },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(legacySettings));

    const manager = new TokyoConfigManager();
    manager.read();

    const expectedConfig = {
      ...DEFAULT_CONFIG,
      panel: false,
      iconMode: "ascii",
      statusModules: {
        ...DEFAULT_CONFIG.statusModules,
        cost: false,
      },
    };
    expect(manager.get()).toEqual(expectedConfig);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(tempDir, "extensions", "pi-tokyo-night.json"),
          "utf8",
        ),
      ),
    ).toEqual(expectedConfig);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(
      legacySettings,
    );
  });

  it("keeps legacy config in memory and cleans temporary files when migration persistence fails", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    const legacySettings = {
      "pi-tokyo-night": { panel: false },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(legacySettings));
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new TokyoConfigManager();
    manager.read();

    const configDirectory = path.join(tempDir, "extensions");
    expect(manager.get()).toEqual({ ...DEFAULT_CONFIG, panel: false });
    expect(
      fs.existsSync(path.join(configDirectory, "pi-tokyo-night.json")),
    ).toBe(false);
    expect(
      fs.readdirSync(configDirectory).filter((file) => file.endsWith(".tmp")),
    ).toEqual([]);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(
      legacySettings,
    );
    expect(error).toHaveBeenCalled();
  });

  it("silently falls back to defaults when both config sources are missing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new TokyoConfigManager();
    manager.set("panel", false);

    manager.read();

    expect(error).not.toHaveBeenCalled();
    expect(manager.get()).toEqual(DEFAULT_CONFIG);
  });

  it("creates the dedicated config file without creating settings.json", () => {
    const agentDir = path.join(tempDir, "nested", "agent");
    getAgentDir.mockReturnValue(agentDir);
    const manager = new TokyoConfigManager();
    manager.set("panel", false);

    expect(manager.write()).toBe(true);

    const configPath = path.join(
      agentDir,
      "extensions",
      "pi-tokyo-night.json",
    );
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      ...DEFAULT_CONFIG,
      panel: false,
    });
    expect(fs.existsSync(path.join(agentDir, "settings.json"))).toBe(false);
  });

  it("round-trips status module changes made by Neon Studio", () => {
    const writer = new TokyoConfigManager();
    writer.setStatusModule("model", false);
    writer.setStatusModule("cost", false);
    expect(writer.write()).toBe(true);

    const reader = new TokyoConfigManager();
    reader.read();

    expect(reader.get().statusModules).toEqual({
      ...DEFAULT_CONFIG.statusModules,
      model: false,
      cost: false,
    });
  });

  it("round-trips the kimiQuota toggle through write/read", () => {
    const writer = new TokyoConfigManager();
    writer.set("kimiQuota", false);
    expect(writer.write()).toBe(true);

    const reader = new TokyoConfigManager();
    reader.read();

    expect(reader.get().kimiQuota).toBe(false);
    expect(reader.get()).toEqual({ ...DEFAULT_CONFIG, kimiQuota: false });
  });

  it("prefers the dedicated config over stale legacy settings", () => {
    const configPath = path.join(
      tempDir,
      "extensions",
      "pi-tokyo-night.json",
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ panel: false }));
    fs.writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({ "pi-tokyo-night": { panel: true } }),
    );

    const manager = new TokyoConfigManager();
    manager.read();

    expect(manager.get()).toEqual({ ...DEFAULT_CONFIG, panel: false });
  });

  it("loads partial status module visibility from the dedicated config", () => {
    const configPath = path.join(
      tempDir,
      "extensions",
      "pi-tokyo-night.json",
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ statusModules: { model: false, cost: false } }),
    );

    const manager = new TokyoConfigManager();
    manager.read();

    expect(manager.get().statusModules).toEqual({
      ...DEFAULT_CONFIG.statusModules,
      model: false,
      cost: false,
    });
  });

  it("does not replace a damaged dedicated config with stale legacy settings", () => {
    const configPath = path.join(
      tempDir,
      "extensions",
      "pi-tokyo-night.json",
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{not json");
    fs.writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({ "pi-tokyo-night": { panel: false } }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new TokyoConfigManager();
    manager.read();

    expect(manager.get()).toEqual(DEFAULT_CONFIG);
    expect(error).toHaveBeenCalled();
  });

  it("never modifies unrelated top-level settings", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    const settings = { theme: "custom", nested: { enabled: true } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const manager = new TokyoConfigManager();
    manager.set("codexQuota", true);

    expect(manager.write()).toBe(true);

    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(settings);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(tempDir, "extensions", "pi-tokyo-night.json"),
          "utf8",
        ),
      ),
    ).toEqual({ ...DEFAULT_CONFIG, codexQuota: true });
  });

  it("resets to defaults when legacy settings have no extension node", () => {
    const settingsPath = path.join(tempDir, "settings.json");
    const manager = new TokyoConfigManager();
    manager.set("panel", false);
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "custom" }));

    manager.read();

    expect(manager.get()).toEqual(DEFAULT_CONFIG);
    expect(
      fs.existsSync(
        path.join(tempDir, "extensions", "pi-tokyo-night.json"),
      ),
    ).toBe(false);
  });

  it("resets to defaults when legacy settings are damaged", () => {
    fs.writeFileSync(path.join(tempDir, "settings.json"), "{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new TokyoConfigManager();
    manager.set("panel", false);

    manager.read();

    expect(manager.get()).toEqual(DEFAULT_CONFIG);
  });

  it("retries a transient Windows rename failure", () => {
    const manager = new TokyoConfigManager();
    manager.set("panel", false);
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      const rename = vi.spyOn(fs, "renameSync")
        .mockImplementationOnce(() => {
          const error = new Error("sharing violation") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        })
        .mockImplementationOnce((from, to) => {
          fs.copyFileSync(from, to);
          fs.unlinkSync(from);
        });

      expect(manager.write()).toBe(true);
      expect(rename).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(tempDir, "extensions", "pi-tokyo-night.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ panel: false });
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("returns false and preserves the original file when atomic rename fails", () => {
    const configPath = path.join(
      tempDir,
      "extensions",
      "pi-tokyo-night.json",
    );
    const original = { ...DEFAULT_CONFIG, panel: true };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(original));
    const manager = new TokyoConfigManager();
    manager.set("panel", false);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(manager.write()).toBe(false);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(original);
  });
});
