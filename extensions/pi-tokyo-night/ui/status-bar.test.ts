import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildStatusLine, buildStatusLines } from "./status-bar";
import { createKimiUsageStore } from "../usage";
import type { UsageSnapshot } from "../usage";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function makeStatusTheme(
  name: "tokyo-night-dark" | "tokyo-night-light",
): Theme {
  const dark = name === "tokyo-night-dark";
  return new Theme(
    {
      accent: dark ? "#bb9af7" : "#6636ba",
      borderMuted: dark ? "#3d3577" : "#b4aed6",
      error: dark ? "#f7768e" : "#c11f3d",
      warning: dark ? "#e0af68" : "#885e16",
      dim: "#697096",
      thinkingLow: dark ? "#7dcfff" : "#0979a5",
      thinkingXhigh: dark ? "#f7768e" : "#c11f3d",
      text: dark ? "#c0caf5" : "#24283b",
      success: dark ? "#9ece6a" : "#1c784d",
      muted: "#565f89",
    } as any,
    {
      selectedBg: dark ? "#292e42" : "#d8dae6",
      userMessageBg: dark ? "#1f2335" : "#e9eaf3",
      customMessageBg: dark ? "#26253c" : "#e7e2ee",
      toolPendingBg: dark ? "#24283b" : "#e2e5ee",
      toolSuccessBg: dark ? "#28303b" : "#e2eee8",
      toolErrorBg: dark ? "#3b2528" : "#eee2e4",
    } as any,
    "truecolor",
    { name },
  );
}

const config = {
  get: () => ({ codexQuota: false }),
} as any;

const allStatusModules = {
  model: true,
  thinking: true,
  path: true,
  git: true,
  quota: true,
  tokens: true,
  cost: true,
  context: true,
};

function makeStatusConfig(
  overrides: Partial<typeof allStatusModules> = {},
): any {
  return {
    get: () => ({
      codexQuota: false,
      kimiQuota: false,
      iconMode: "nerd",
      statusModules: { ...allStatusModules, ...overrides },
    }),
  };
}

function makeAssistant(input: number, output: number): unknown {
  return {
    type: "message",
    id: `${input}-${output}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      usage: { input, output, cost: { total: 1.25 } },
    } as AssistantMessage,
  };
}

function makeContext(
  branch: unknown[],
  getContextUsage?: () => unknown,
  sessionManagerOverride?: unknown,
): ExtensionContext {
  const sessionManager = sessionManagerOverride ?? {
    getBranch: () => branch,
    getLeafId: () => "leaf-1",
    getSessionId: () => "session-1",
  };
  return {
    sessionManager,
    getContextUsage,
    model: { id: "test-model", contextWindow: 1000 },
    cwd: "/workspace/project",
  } as unknown as ExtensionContext;
}

describe("buildStatusLine", () => {
  it("keeps status module chrome independent from the active theme", () => {
    const themed = {
      fg: vi.fn((color: string, text: string) => `\x1b[38;5;1m${text}\x1b[39m`),
      bg: vi.fn((color: string, text: string) => `\x1b[48;5;2m${text}\x1b[49m`),
    } as unknown as Theme;

    const line = buildStatusLine(
      500,
      themed,
      makeContext([]),
      "main",
      "high",
      makeStatusConfig(),
    );

    expect(line).toContain("\x1b[48;2;45;27;105m");
    expect(line).toContain("\x1b[48;2;109;91;170m");
    expect(themed.bg).not.toHaveBeenCalled();
  });

  it.each([
    [
      "tokyo-night-dark",
      {
        accent: "\x1b[38;2;187;154;247m",
        dim: "\x1b[38;2;105;112;150m",
      },
    ],
    [
      "tokyo-night-light",
      {
        accent: "\x1b[38;2;102;54;186m",
        dim: "\x1b[38;2;105;112;150m",
      },
    ],
  ] as const)(
    "renders the %s status palette",
    (name, expected) => {
      const lines = buildStatusLines(
        500,
        makeStatusTheme(name),
        makeContext([]),
        "main",
        "high",
        makeStatusConfig(),
      );

      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(500);
      expect(lines[0]).toContain(expected.accent);
      expect(lines[0]).toContain(expected.dim);
    },
  );

  it("keeps status chrome ANSI colors identical in dark and light themes", () => {
    const dark = buildStatusLine(
      500,
      makeStatusTheme("tokyo-night-dark"),
      makeContext([]),
      "main",
      "high",
      makeStatusConfig(),
    );
    const light = buildStatusLine(
      500,
      makeStatusTheme("tokyo-night-light"),
      makeContext([]),
      "main",
      "high",
      makeStatusConfig(),
    );
    const chromeCodes = [
      "\x1b[48;2;45;27;105m",
      "\x1b[48;2;61;43;122m",
      "\x1b[48;2;77;59;138m",
      "\x1b[48;2;93;75;154m",
      "\x1b[48;2;109;91;170m",
      "\x1b[48;2;93;93;93m",
      "\x1b[38;2;200;200;255m",
      "\x1b[38;2;220;220;255m",
      "\x1b[38;2;240;240;255m",
      "\x1b[38;2;255;255;255m",
      "\x1b[38;2;255;255;200m",
      "\x1b[38;2;200;255;200m",
      "\x1b[38;2;255;200;200m",
    ];
    const count = (value: string, code: string) =>
      value.split(code).length - 1;

    for (const code of chromeCodes) {
      expect(dark, code).toContain(code);
      expect(light, code).toContain(code);
      expect(count(light, code), code).toBe(count(dark, code));
    }
  });

  it("hides file-configured modules and repacks the visible modules", () => {
    const line = buildStatusLines(
      60,
      theme,
      makeContext([]),
      "main",
      "high",
      makeStatusConfig({ thinking: false, path: false, git: false }),
    );
    const plain = line[0].replace(/\u001b\[[0-9;]*m/g, "");

    expect(line).toHaveLength(1);
    expect(plain).toContain("test-model");
    expect(plain).toContain("Σ 0 tokens");
    expect(plain).toContain("$0.000");
    expect(plain).toContain("0%/1.0k");
    expect(plain).not.toContain("high");
    expect(plain).not.toContain("/workspace/project");
    expect(plain).not.toContain("main");
  });

  it("moves the end arrow to the last visible module when context is hidden", () => {
    const lines = buildStatusLines(
      75,
      theme,
      makeContext([]),
      "main",
      "high",
      makeStatusConfig({ context: false }),
    );
    const plainLines = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));

    expect(plainLines.at(-1)).toContain("$0.000");
    expect(plainLines.at(-1)).toMatch(/\uE0B0$/);
    expect(plainLines.join("\n")).not.toContain("0%/1.0k");
  });

  it("keeps wide rows filled when only one side remains", () => {
    const leftOnly = buildStatusLines(
      100,
      theme,
      makeContext([]),
      "main",
      "high",
      makeStatusConfig({
        thinking: false,
        path: false,
        git: false,
        quota: false,
        tokens: false,
        cost: false,
        context: false,
      }),
    );
    const rightOnly = buildStatusLines(
      100,
      theme,
      makeContext([]),
      "main",
      "high",
      makeStatusConfig({
        model: false,
        thinking: false,
        path: false,
        git: false,
        quota: false,
        cost: false,
        context: false,
      }),
    );
    const allHidden = buildStatusLines(
      100,
      theme,
      makeContext([]),
      "main",
      "high",
      makeStatusConfig({
        model: false,
        thinking: false,
        path: false,
        git: false,
        quota: false,
        tokens: false,
        cost: false,
        context: false,
      }),
    );

    expect(leftOnly).toHaveLength(1);
    expect(rightOnly).toHaveLength(1);
    expect(visibleWidth(leftOnly[0])).toBe(98);
    expect(visibleWidth(rightOnly[0])).toBe(98);
    expect(allHidden).toEqual([""]);
  });

  it("packs complete modules into the first row before wrapping", () => {
    const lines = buildStatusLines(
      75,
      theme,
      makeContext([]),
      "main",
      "high",
      config,
    );
    const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");
    const plainLines = lines.map(stripAnsi);

    expect(lines).toHaveLength(2);
    expect(plainLines[0]).toContain("tokens");
    expect(plainLines[0]).toContain("main");
    expect(plainLines[1]).toContain("$0.000");
    expect(lines.every((line) => visibleWidth(line) <= 75)).toBe(true);
    expect(plainLines.slice(0, -1).every((line) => line.endsWith("\uE0B0"))).toBe(true);
    expect(plainLines.at(-1)).toContain("0%/1.0k");
    expect(plainLines.at(-1)).not.toMatch(/\uE0B0$/);
  });

  it("truncates an oversized module while preserving its end arrow", () => {
    const lines = buildStatusLines(
      12,
      theme,
      makeContext([]),
      "main",
      "high",
      config,
    );
    const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");
    const plainLines = lines.map(stripAnsi);

    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(plainLines.slice(0, -1).every((line) => line.endsWith("\uE0B0"))).toBe(true);
    expect(plainLines.at(-1)).not.toMatch(/\uE0B0$/);
  });

  it.each([1, 2, 3])("avoids duplicate empty rows at impossible width %i", (width) => {
    const lines = buildStatusLines(width, theme, makeContext([]), "main", "high", config);
    const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");

    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
    expect(stripAnsi(lines[0])).toMatch(/\uE0B0$/);
  });

  it("returns no content rows when the available width is zero", () => {
    const lines = buildStatusLines(0, theme, makeContext([]), "main", "high", config);

    expect(lines).toEqual([]);
  });

  it("renders Nerd and ASCII status bar icon variants", () => {
    const ctx = makeContext([]);
    const nerdConfig = {
      get: () => ({ codexQuota: false, kimiQuota: false, iconMode: "nerd" }),
    } as any;
    const asciiConfig = {
      get: () => ({ codexQuota: false, kimiQuota: false, iconMode: "ascii" }),
    } as any;
    const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");
    const nerd = stripAnsi(buildStatusLine(500, theme, ctx, "main", "high", nerdConfig));
    const ascii = stripAnsi(buildStatusLine(500, theme, ctx, "main", "high", asciiConfig));
    const asciiRows = buildStatusLines(75, theme, ctx, "main", "high", asciiConfig)
      .map(stripAnsi);

    expect(nerd).toContain("\uE795");
    expect(nerd).toContain("\uF07B");
    expect(nerd).toContain("\uE0A0");
    expect(nerd).toContain("\uE0B0");
    expect(ascii).toContain("test-model");
    expect(ascii).toContain("~ /workspace/project");
    expect(ascii).toContain("* main");
    expect(ascii).toContain("Σ 0 tokens");
    expect(ascii).toContain("\uE0B0");
    expect(ascii).toContain("@ test-model");
    expect(ascii).toContain("\uE0B0 high \uE0B0");
    expect(ascii).not.toContain("\uE0B0  high");
    expect(ascii).not.toContain("! high");
    expect(ascii).not.toContain("\uE795");
    expect(ascii).not.toContain("\uF07B");
    expect(ascii).not.toContain("\uE0A0");
    expect(asciiRows.slice(0, -1).every((line) => line.endsWith("\uE0B0"))).toBe(true);
    expect(asciiRows.at(-1)).not.toMatch(/\uE0B0$/);

  });

  it("keeps cumulative tokens separate from current context usage", () => {
    const ctx = makeContext(
      [makeAssistant(1000, 500)],
      () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    );

    const line = buildStatusLine(500, theme, ctx, "", "high", config);

    expect(line).toContain("Σ 1.5k tokens");
    expect(line).toContain("10%/1.0k");
    expect(line).not.toContain("100%/1.0k");
  });

  it("falls back to cumulative usage when the context API is unavailable", () => {
    const ctx = makeContext([makeAssistant(1000, 0)]);

    const line = buildStatusLine(500, theme, ctx, "", "high", config);

    expect(line).toContain("100%/1.0k");
  });

  it("caches context usage briefly and refreshes after the cache window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let tokens = 100;
      const getContextUsage = vi.fn(() => ({
        tokens,
        contextWindow: 1000,
        percent: tokens / 10,
      }));
      const ctx = makeContext([], getContextUsage);

      const first = buildStatusLine(500, theme, ctx, "", "high", config);
      const second = buildStatusLine(500, theme, ctx, "", "high", config);

      expect(first).toContain("10%/1.0k");
      expect(second).toContain("10%/1.0k");
      expect(getContextUsage).toHaveBeenCalledTimes(1);

      tokens = 200;
      vi.setSystemTime(999);
      expect(buildStatusLine(500, theme, ctx, "", "high", config)).toContain(
        "10%/1.0k",
      );
      expect(getContextUsage).toHaveBeenCalledTimes(1);

      vi.setSystemTime(1000);
      const refreshed = buildStatusLine(500, theme, ctx, "", "high", config);
      expect(getContextUsage).toHaveBeenCalledTimes(2);
      expect(refreshed).toContain("20%/1.0k");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes context usage when the active leaf changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let leaf = "leaf-a";
      let tokens = 100;
      const getContextUsage = vi.fn(() => ({
        tokens,
        contextWindow: 1000,
        percent: tokens / 10,
      }));
      const ctx = makeContext([], getContextUsage, {
        getBranch: () => [],
        getLeafId: () => leaf,
        getSessionId: () => "session-a",
      });

      expect(buildStatusLine(500, theme, ctx, "", "high", config)).toContain(
        "10%/1.0k",
      );
      tokens = 200;
      leaf = "leaf-b";

      expect(buildStatusLine(500, theme, ctx, "", "high", config)).toContain(
        "20%/1.0k",
      );
      expect(getContextUsage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes context usage when the model changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let tokens = 100;
      const getContextUsage = vi.fn(() => ({
        tokens,
        contextWindow: 1000,
        percent: tokens / 10,
      }));
      const ctx = makeContext([], getContextUsage);

      expect(buildStatusLine(500, theme, ctx, "", "high", config)).toContain(
        "10%/1.0k",
      );
      tokens = 200;
      ctx.model = {
        id: "other-model",
        provider: "other-provider",
        api: "other-api",
        contextWindow: 1000,
      } as any;

      expect(buildStatusLine(500, theme, ctx, "", "high", config)).toContain(
        "20%/1.0k",
      );
      expect(getContextUsage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses stats for one leaf, invalidates on leaf changes, and isolates sessions", () => {
    const getBranch = vi.fn(() => [makeAssistant(10, 20)]);
    let leaf = "leaf-a";
    const manager = {
      getBranch,
      getLeafId: () => leaf,
      getSessionId: () => "session-a",
    };
    const ctx = makeContext([], undefined, manager);

    buildStatusLine(500, theme, ctx, "", "high", config);
    buildStatusLine(500, theme, ctx, "", "high", config);
    expect(getBranch).toHaveBeenCalledTimes(1);

    leaf = "leaf-b";
    getBranch.mockReturnValue([makeAssistant(200, 0)]);
    const changedLine = buildStatusLine(500, theme, ctx, "", "high", config);
    expect(getBranch).toHaveBeenCalledTimes(2);
    expect(changedLine).toContain("Σ 200 tokens");

    const otherBranch = vi.fn(() => [makeAssistant(3, 4)]);
    const otherCtx = makeContext([], undefined, {
      getBranch: otherBranch,
      getLeafId: () => "leaf-a",
      getSessionId: () => "session-a",
    });
    buildStatusLine(500, theme, otherCtx, "", "high", config);
    expect(otherBranch).toHaveBeenCalledTimes(1);
  });
});

describe("buildStatusLine provider quota modules", () => {
  const quotaSnapshot: UsageSnapshot = {
    primary: { usedPercent: 25, windowMinutes: 300, resetsInSeconds: 1800 },
    capturedAt: Date.now(),
  };

  const quotaConfig = (flags: { codexQuota?: boolean; kimiQuota?: boolean }) => ({
    get: () => ({ codexQuota: false, kimiQuota: false, ...flags }),
  }) as any;

  const ctxWithModel = (provider: string): ExtensionContext => ({
    ...makeContext([]),
    model: { id: "quota-model", provider, contextWindow: 1000 },
  } as unknown as ExtensionContext);

  it("renders the Codex limit module from the injected store", () => {
    const line = buildStatusLine(
      500,
      theme,
      ctxWithModel("openai-codex"),
      "",
      "high",
      quotaConfig({ codexQuota: true }),
      { getSnapshot: () => quotaSnapshot },
    );

    expect(line).toContain("LIMIT 5h 75%");
  });

  it("hides the Codex module without a snapshot or with the toggle off", () => {
    const noSnapshot = buildStatusLine(
      500,
      theme,
      ctxWithModel("openai-codex"),
      "",
      "high",
      quotaConfig({ codexQuota: true }),
      { getSnapshot: () => undefined },
    );
    const toggleOff = buildStatusLine(
      500,
      theme,
      ctxWithModel("openai-codex"),
      "",
      "high",
      quotaConfig({}),
      { getSnapshot: () => quotaSnapshot },
    );

    expect(noSnapshot).not.toContain("LIMIT");
    expect(toggleOff).not.toContain("LIMIT");
  });

  it("renders the Kimi limit module from the session store snapshot", () => {
    const kimiStore = createKimiUsageStore();
    kimiStore.setSnapshot(quotaSnapshot);

    const line = buildStatusLine(
      500,
      theme,
      ctxWithModel("kimi-coding"),
      "",
      "high",
      quotaConfig({ kimiQuota: true }),
      undefined,
      kimiStore,
    );

    expect(line).toContain("LIMIT 5h 75%");
  });

  it("hides the Kimi module when the model switches away or the snapshot is absent", () => {
    const kimiStore = createKimiUsageStore();
    kimiStore.setSnapshot(quotaSnapshot);

    const otherProvider = buildStatusLine(
      500,
      theme,
      ctxWithModel("openai-codex"),
      "",
      "high",
      quotaConfig({ kimiQuota: true }),
      undefined,
      kimiStore,
    );
    const noStore = buildStatusLine(
      500,
      theme,
      ctxWithModel("kimi-coding"),
      "",
      "high",
      quotaConfig({ kimiQuota: true }),
      undefined,
    );

    expect(otherProvider).not.toContain("LIMIT");
    expect(noStore).not.toContain("LIMIT");
  });
});

