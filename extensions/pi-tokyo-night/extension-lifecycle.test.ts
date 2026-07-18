import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStatusWidgetLines,
  default as extension,
  shouldRunRainAnimation,
} from "./extension";
import { SettingsUIController } from "./settings-controller";
import { TokyoConfigManager } from "./config";

type Mode = "tui" | "rpc" | "json" | "print";

type Fixture = ReturnType<typeof makeFixture>;

const theme = {
  fg: (_color: string, text: string) => text,
} as any;

function makeFixture(mode: Mode = "tui") {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const widgets = new Map<string, any>();
  let editorFactory: any;
  let footerFactory: any;
  const setWidget = vi.fn((key: string, content: unknown) => {
    if (content === undefined) widgets.delete(key);
    else widgets.set(key, content);
  });
  const setEditorComponent = vi.fn((factory: unknown) => {
    editorFactory = factory;
  });
  const setFooter = vi.fn((factory: unknown) => {
    footerFactory = factory;
  });
  const ui = {
    setWidget,
    setEditorComponent,
    getEditorComponent: vi.fn(() => editorFactory),
    setFooter,
    setWorkingVisible: vi.fn(),
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
  } as any;
  const ctx = {
    ui,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/workspace/project",
    model: undefined,
    sessionManager: {
      getBranch: () => [],
      getLeafId: () => "leaf-1",
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/session-1.jsonl",
    },
    getContextUsage: () => undefined,
  } as any;
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: vi.fn((_name: string, command: unknown) => {
      registeredCommand = command as any;
    }),
    getThinkingLevel: () => "high",
    exec: vi.fn(async () => ({ code: 0, stdout: "main\n", stderr: "" })),
  } as any;
  let registeredCommand: any;

  extension(pi);

  return {
    pi,
    ctx,
    ui,
    setWidget,
    setEditorComponent,
    setFooter,
    widgets,
    get editorFactory() {
      return editorFactory;
    },
    get footerFactory() {
      return footerFactory;
    },
    command: () => registeredCommand,
    async emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(...args);
      }
    },
  };
}

async function shutdown(fixture: Fixture): Promise<void> {
  await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
}

beforeEach(() => {
  vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(() => {});
  vi.spyOn(TokyoConfigManager.prototype, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Tokyo Night status widget narrow widths", () => {
  it.each([0, 1, 2])("renders safely at width %i", (width) => {
    expect(() => buildStatusWidgetLines(width, false, "status")).not.toThrow();
    expect(() => buildStatusWidgetLines(width, true, "status")).not.toThrow();
  });
});

describe("Tokyo Night animation lifecycle gate", () => {
  it("never permits rain animation outside the interactive TUI", () => {
    expect(shouldRunRainAnimation("rpc", true)).toBe(false);
    expect(shouldRunRainAnimation("json", true)).toBe(false);
    expect(shouldRunRainAnimation("print", true)).toBe(false);
  });

  it("permits rain only when the TUI session enables the panel", () => {
    expect(shouldRunRainAnimation("tui", true)).toBe(true);
    expect(shouldRunRainAnimation("tui", false)).toBe(false);
  });
});

describe("Tokyo Night slash command modes", () => {
  it("enters the settings panel only for a TUI command", async () => {
    const enter = vi.spyOn(SettingsUIController.prototype, "enter");
    for (const mode of ["rpc", "json", "print"] as const) {
      const fixture = makeFixture(mode);
      await fixture.command().handler("", fixture.ctx);
    }
    expect(enter).not.toHaveBeenCalled();

    const tui = makeFixture("tui");
    await tui.command().handler("", tui.ctx);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it.each(["rpc", "json", "print"] as const)(
    "persists on/off in %s without TUI operations",
    async (mode) => {
      const fixture = makeFixture(mode);
      const set = vi.spyOn(TokyoConfigManager.prototype, "set");
      await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

      expect(fixture.setWidget).not.toHaveBeenCalled();
      expect(fixture.setEditorComponent).not.toHaveBeenCalled();
      expect(fixture.setFooter).not.toHaveBeenCalled();

      await fixture.command().handler("on", fixture.ctx);

      expect(set).toHaveBeenCalledWith("panel", true);
      expect(TokyoConfigManager.prototype.write).toHaveBeenCalled();
      expect(fixture.ui.notify).not.toHaveBeenCalled();
      await shutdown(fixture);
      expect(fixture.setWidget).not.toHaveBeenCalled();
      expect(fixture.setEditorComponent).not.toHaveBeenCalled();
      expect(fixture.setFooter).not.toHaveBeenCalled();
    },
  );

  it("does not register TUI resources when a tui context has no UI", async () => {
    const fixture = makeFixture("tui");
    fixture.ctx.hasUI = false;

    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    expect(fixture.setWidget).not.toHaveBeenCalled();
    expect(fixture.setEditorComponent).not.toHaveBeenCalled();
    expect(fixture.setFooter).not.toHaveBeenCalled();
  });
});

describe("Tokyo Night git branch lifecycle", () => {
  it("cleans up when shutdown receives a different context for the same session manager", async () => {
    const fixture = makeFixture("tui");
    const startCtx = { ...fixture.ctx };
    const shutdownCtx = { ...fixture.ctx };

    await fixture.emit("session_start", { reason: "startup" }, startCtx);
    expect(fixture.widgets.has("tokyo-status")).toBe(true);

    await fixture.emit("session_shutdown", { reason: "quit" }, shutdownCtx);

    expect(fixture.widgets.has("tokyo-status")).toBe(false);
    expect(fixture.widgets.has("tokyo-rain-selector")).toBe(false);
    expect(fixture.editorFactory).toBeUndefined();
    expect(fixture.footerFactory).toBeUndefined();
  });

  it("matches fresh event contexts by the stable session id and file", async () => {
    const fixture = makeFixture("tui");
    const startCtx = {
      ...fixture.ctx,
      sessionManager: {
        ...fixture.ctx.sessionManager,
        getSessionId: () => "session-same",
        getSessionFile: () => "/sessions/session-same.jsonl",
      },
    };
    const shutdownCtx = {
      ...fixture.ctx,
      sessionManager: {
        ...fixture.ctx.sessionManager,
        getSessionId: () => "session-same",
        getSessionFile: () => "/sessions/session-same.jsonl",
      },
    };

    await fixture.emit("session_start", { reason: "startup" }, startCtx);
    expect(fixture.widgets.has("tokyo-status")).toBe(true);

    await fixture.emit("session_shutdown", { reason: "quit" }, shutdownCtx);

    expect(fixture.widgets.has("tokyo-status")).toBe(false);
    expect(fixture.editorFactory).toBeUndefined();
    expect(fixture.footerFactory).toBeUndefined();
  });

  it("does not let a late shutdown for a prior stable id retire the replacement", async () => {
    const fixture = makeFixture("tui");
    const firstManager = {
      ...fixture.ctx.sessionManager,
      getSessionId: () => "session-first",
      getSessionFile: () => "/sessions/session-first.jsonl",
    };
    const secondManager = {
      ...fixture.ctx.sessionManager,
      getSessionId: () => "session-second",
      getSessionFile: () => "/sessions/session-second.jsonl",
    };
    const firstStartCtx = { ...fixture.ctx, sessionManager: firstManager };
    const firstShutdownCtx = { ...fixture.ctx, sessionManager: firstManager };
    const secondStartCtx = { ...fixture.ctx, sessionManager: secondManager };
    const secondShutdownCtx = { ...fixture.ctx, sessionManager: secondManager };

    await fixture.emit("session_start", { reason: "startup" }, firstStartCtx);
    await fixture.emit("session_start", { reason: "new" }, secondStartCtx);
    const replacementWidget = fixture.widgets.get("tokyo-status");

    await fixture.emit("session_shutdown", { reason: "new" }, firstShutdownCtx);

    expect(fixture.widgets.get("tokyo-status")).toBe(replacementWidget);
    await fixture.emit("session_shutdown", { reason: "quit" }, secondShutdownCtx);
    expect(fixture.widgets.has("tokyo-status")).toBe(false);
  });

  it("cleans an ephemeral fork when Pi reuses the manager before shutdown", async () => {
    const fixture = makeFixture("tui");
    const manager = {
      sessionId: "session-before-fork",
      getSessionId() {
        return this.sessionId;
      },
      getSessionFile: () => undefined,
      getBranch: () => [],
      getLeafId: () => "leaf-1",
    } as any;
    const startCtx = { ...fixture.ctx, sessionManager: manager };
    const shutdownCtx = { ...fixture.ctx, sessionManager: manager };

    await fixture.emit("session_start", { reason: "startup" }, startCtx);
    manager.sessionId = "session-after-fork";
    await fixture.emit("session_shutdown", { reason: "fork" }, shutdownCtx);

    expect(fixture.widgets.has("tokyo-status")).toBe(false);
    expect(fixture.editorFactory).toBeUndefined();
    expect(fixture.footerFactory).toBeUndefined();
  });

  it("keeps reused managers separated by the stable id observed in each event context", async () => {
    const fixture = makeFixture("tui");
    const manager = {
      getSessionId: vi.fn(() => "session-first"),
      getSessionFile: vi.fn(() => undefined),
      getBranch: () => [],
      getLeafId: () => "leaf-1",
    } as any;
    const contextForId = (id: string) => {
      const context = { ...fixture.ctx } as any;
      Object.defineProperty(context, "sessionManager", {
        get: () => {
          manager.getSessionId.mockReturnValue(id);
          return manager;
        },
      });
      return context;
    };

    const firstStartCtx = contextForId("session-first");
    const secondStartCtx = contextForId("session-second");
    const firstShutdownCtx = contextForId("session-first");
    const secondShutdownCtx = contextForId("session-second");

    await fixture.emit("session_start", { reason: "startup" }, firstStartCtx);
    await fixture.emit("session_start", { reason: "new" }, secondStartCtx);
    const replacementWidget = fixture.widgets.get("tokyo-status");

    await fixture.emit("session_shutdown", { reason: "new" }, firstShutdownCtx);
    expect(fixture.widgets.get("tokyo-status")).toBe(replacementWidget);

    await fixture.emit("session_shutdown", { reason: "quit" }, secondShutdownCtx);
    expect(fixture.widgets.has("tokyo-status")).toBe(false);
  });

  it("requests a status render when fallback discovers a changed branch", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const requestRender = vi.fn();
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender },
      theme,
    );

    status.render(80);
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(40);
    expect(requestRender).toHaveBeenCalledTimes(1);
    await shutdown(fixture);
  });

  it("does not start fallback when footer data is available", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const footer = {
      getGitBranch: vi.fn(() => "footer-branch"),
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 0,
      onBranchChange: vi.fn(() => () => {}),
    } as any;
    fixture.footerFactory(
      { requestRender: vi.fn() },
      theme,
      footer,
    );
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender: vi.fn() },
      theme,
    );

    status.render(120);

    expect(fixture.pi.exec).not.toHaveBeenCalled();
    expect(status.render(120).join("\n")).toContain("footer-branch");
    await shutdown(fixture);
  });

  it("aborts and drops a fallback result when the working directory changes", async () => {
    vi.useFakeTimers();
    let resolveOld!: (result: unknown) => void;
    let resolveNew!: (result: unknown) => void;
    let oldSignal: AbortSignal | undefined;
    const oldResult = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const newResult = new Promise((resolve) => {
      resolveNew = resolve;
    });
    const fixture = makeFixture("tui");
    fixture.pi.exec
      .mockImplementationOnce(
        (_command: string, _args: string[], options: any) => {
          oldSignal = options.signal;
          return oldResult;
        },
      )
      .mockImplementationOnce(() => newResult);
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const requestRender = vi.fn();
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender },
      theme,
    );
    status.render(120);
    fixture.ctx.cwd = "/workspace/changed";
    status.render(120);

    expect(oldSignal).toBeDefined();
    expect(oldSignal?.aborted).toBe(true);

    resolveOld({ code: 0, stdout: "old-branch\n", stderr: "" });
    await Promise.resolve();
    await Promise.resolve();
    expect(status.render(120).join("\n")).not.toContain("old-branch");
    vi.advanceTimersByTime(40);
    expect(requestRender).not.toHaveBeenCalled();

    resolveNew({ code: 0, stdout: "new-branch\n", stderr: "" });
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(40);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(status.render(120).join("\n")).toContain("new-branch");
    await shutdown(fixture);
  });

  it("drops a fallback result from a previous session", async () => {
    let resolveExec!: (result: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveExec = resolve;
    });
    const fixture = makeFixture("tui");
    fixture.pi.exec.mockReturnValue(pending);
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const oldStatus = fixture.widgets.get("tokyo-status")(
      { requestRender: vi.fn() },
      theme,
    );
    oldStatus.render(120);

    const nextCtx = { ...fixture.ctx, cwd: "/workspace/next" };
    await fixture.emit("session_start", { reason: "new" }, nextCtx);
    resolveExec({ code: 0, stdout: "old-branch\n", stderr: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(oldStatus.render(120).join("\n")).not.toContain("old-branch");
    await fixture.emit("session_shutdown", { reason: "quit" }, nextCtx);
  });

  it("does not tear down the replacement session when the old shutdown arrives late", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    const firstManager = fixture.ctx.sessionManager;
    const secondManager = {
      ...firstManager,
      getSessionId: () => "session-2",
    };
    const firstStartCtx = { ...fixture.ctx, sessionManager: firstManager };
    const firstShutdownCtx = { ...firstStartCtx };
    const secondStartCtx = {
      ...fixture.ctx,
      cwd: "/workspace/next",
      sessionManager: secondManager,
    };
    const secondShutdownCtx = { ...secondStartCtx };

    await fixture.emit("session_start", { reason: "first" }, firstStartCtx);
    await fixture.emit("session_start", { reason: "second" }, secondStartCtx);
    const secondStatusWidget = fixture.widgets.get("tokyo-status");
    const secondEditorFactory = fixture.editorFactory;
    const secondFooterFactory = fixture.footerFactory;
    const timersWithReplacement = vi.getTimerCount();

    await fixture.emit("session_shutdown", { reason: "replaced" }, firstShutdownCtx);
    await fixture.emit("session_shutdown", { reason: "replaced-again" }, firstShutdownCtx);

    fixture.ui.setWidget("agents", ["should-stay-hidden"]);
    expect(fixture.widgets.has("agents")).toBe(false);
    expect(fixture.widgets.get("tokyo-status")).toBe(secondStatusWidget);
    expect(fixture.editorFactory).toBe(secondEditorFactory);
    expect(fixture.footerFactory).toBe(secondFooterFactory);
    expect(vi.getTimerCount()).toBe(timersWithReplacement);

    await fixture.emit("session_shutdown", { reason: "quit" }, secondShutdownCtx);
    expect(fixture.widgets.has("tokyo-status")).toBe(false);
    expect(fixture.editorFactory).toBeUndefined();
    expect(fixture.footerFactory).toBeUndefined();
  });
});

describe("Tokyo Night Codex countdown refresh", () => {
  const codexModel = {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5-codex",
  } as any;
  const headers = {
    "x-codex-primary-used-percent": "10",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-after-seconds": "180",
  };

  it("starts a low-frequency refresh, renders it, and clears it on model change", async () => {
    vi.useFakeTimers();
    vi.mocked(TokyoConfigManager.prototype.read).mockImplementation(
      function (this: TokyoConfigManager) {
        this.set("codexQuota", true);
      },
    );
    const fixture = makeFixture("tui");
    fixture.ctx.model = codexModel;
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const requestRender = vi.fn();
    fixture.widgets.get("tokyo-status")({ requestRender }, theme);
    await fixture.emit(
      "after_provider_response",
      { status: 200, headers },
      fixture.ctx,
    );

    await vi.advanceTimersByTimeAsync(34);
    requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(requestRender).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_034);
    expect(requestRender).toHaveBeenCalledTimes(1);

    await fixture.emit(
      "model_select",
      { model: { provider: "anthropic", api: "anthropic-messages", id: "claude" } },
      fixture.ctx,
    );
    await vi.advanceTimersByTimeAsync(34);
    requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestRender).not.toHaveBeenCalled();

    await shutdown(fixture);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rpc", "json", "print"] as const)(
    "does not schedule a countdown outside the interactive TUI (%s)",
    async (mode) => {
      vi.useFakeTimers();
      vi.mocked(TokyoConfigManager.prototype.read).mockImplementation(
        function (this: TokyoConfigManager) {
          this.set("codexQuota", true);
        },
      );
      const fixture = makeFixture(mode);
      fixture.ctx.model = codexModel;
      await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
      await fixture.emit(
        "after_provider_response",
        { status: 200, headers },
        fixture.ctx,
      );

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      await shutdown(fixture);
    },
  );
});

describe("Tokyo Night extension instance isolation", () => {
  it("stops only its own animation and ownership timers", async () => {
    vi.useFakeTimers();
    const first = makeFixture("tui");
    const second = makeFixture("tui");
    await first.emit("session_start", { reason: "startup" }, first.ctx);
    await second.emit("session_start", { reason: "startup" }, second.ctx);
    const timersWithBothInstances = vi.getTimerCount();

    await shutdown(first);
    expect(vi.getTimerCount()).toBeLessThan(timersWithBothInstances);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await shutdown(second);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Tokyo Night editor ownership polling", () => {
  it("backs off after stable ownership and clears the timer on shutdown", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    await vi.advanceTimersByTimeAsync(1500);
    expect(fixture.ui.getEditorComponent).toHaveBeenCalledTimes(3);

    await shutdown(fixture);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off after ordinary ownership poll errors", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const pollTimes: number[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.ui.getEditorComponent.mockImplementation(() => {
      pollTimes.push(Date.now());
      throw new Error("temporary ownership poll failure");
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(pollTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(149);
    expect(pollTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(150);
    expect(pollTimes).toHaveLength(2);
    expect(pollTimes[1] - pollTimes[0]).toBeGreaterThan(150);

    error.mockRestore();
    await shutdown(fixture);
    expect(vi.getTimerCount()).toBe(0);
  });
});
