import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStatusWidgetLines,
  coordinateSelectorTransition,
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

  it("renders multiple content rows with one shared bottom border", () => {
    const lines = buildStatusWidgetLines(20, false, ["left", "right"]);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("left");
    expect(lines[1]).toContain("right");
    expect(lines[2]).toMatch(/[╰╯─]/);
  });

  it("when editorFrame=false, renders status content without any border row", () => {
    const lines = buildStatusWidgetLines(20, false, "status", false);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("status");
    expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│─]/);
  });

  it("syncs selector overlay before requesting a full render", () => {
    const events: string[] = [];

    coordinateSelectorTransition(
      () => events.push("overlay"),
      () => events.push("render"),
    );

    expect(events).toEqual(["overlay", "render"]);
  });
});

describe("Tokyo Night status branch cache", () => {
  it("does not re-read the footer branch during every status render", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const getGitBranch = vi.fn(() => "main");
    let branchChanged: (() => void) | undefined;
    const footerData = {
      getGitBranch,
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 0,
      onBranchChange: vi.fn((callback: () => void) => {
        branchChanged = callback;
        return vi.fn();
      }),
    } as any;
    (fixture.footerFactory as any)({ requestRender: vi.fn() }, theme, footerData);

    const statusFactory = fixture.widgets.get("tokyo-status") as any;
    const status = statusFactory({ requestRender: vi.fn() }, theme);
    expect(getGitBranch).toHaveBeenCalledTimes(1);

    expect(status.render(80).join("\n")).toContain("main");
    status.render(80);
    status.render(80);

    expect(getGitBranch).toHaveBeenCalledTimes(1);

    getGitBranch.mockReturnValue("feature");
    branchChanged?.();
    expect(status.render(80).join("\n")).toContain("feature");
    expect(getGitBranch).toHaveBeenCalledTimes(2);
    await shutdown(fixture);
  });
});

describe("Tokyo Night rain render scheduling", () => {
  it("throttles redundant rain redraws while the agent is working", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const tui = {
      focusedComponent: undefined as unknown,
      hasOverlay: () => false,
      doRender: vi.fn(),
      requestRender: vi.fn(),
    };
    (fixture.editorFactory as any)(tui, {}, {});
    tui.doRender();

    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    tui.requestRender.mockClear();

    await vi.advanceTimersByTimeAsync(490);
    expect(tui.requestRender).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(40);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    tui.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(tui.requestRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    await fixture.emit("agent_end", { type: "agent_end", messages: [] }, fixture.ctx);
    tui.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(130);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    await shutdown(fixture);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a completed host render as the busy throttle anchor", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const tui = {
      focusedComponent: undefined as unknown,
      hasOverlay: () => false,
      doRender: vi.fn(),
      requestRender: vi.fn(),
    };
    (fixture.editorFactory as any)(tui, {}, {});
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    tui.requestRender.mockClear();

    await vi.advanceTimersByTimeAsync(300);
    tui.doRender();
    await vi.advanceTimersByTimeAsync(400);
    expect(tui.requestRender).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    await shutdown(fixture);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Tokyo Night selector transition lifecycle", () => {
  it("registers/removes the rain overlay and forces a full root render", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const tui = {
      focusedComponent: undefined as unknown,
      hasOverlay: () => false,
      doRender: vi.fn(),
      requestRender: vi.fn(),
    };
    const editorFactory = fixture.editorFactory as any;
    const editor = editorFactory(tui, {}, {});

    tui.focusedComponent = { selector: true };
    tui.doRender();
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.setWidget).toHaveBeenCalledWith(
      "tokyo-rain-selector",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    expect(fixture.widgets.has("tokyo-rain-selector")).toBe(true);
    const overlayFactory = fixture.widgets.get("tokyo-rain-selector") as any;
    const overlay = overlayFactory(tui, theme);
    expect(overlay.render(40).length).toBeGreaterThan(0);
    expect(tui.requestRender).toHaveBeenCalledWith(true);

    fixture.setWidget.mockClear();
    tui.requestRender.mockClear();
    tui.focusedComponent = editor;
    tui.doRender();
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.setWidget).toHaveBeenCalledWith(
      "tokyo-rain-selector",
      undefined,
    );
    expect(fixture.widgets.has("tokyo-rain-selector")).toBe(false);
    expect(tui.requestRender).toHaveBeenCalledWith(true);

    await shutdown(fixture);
  });

  it("re-registers selector rain after Pi resets extension UI", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const tui = {
      focusedComponent: undefined as unknown,
      hasOverlay: () => false,
      doRender: vi.fn(),
      requestRender: vi.fn(),
    };
    const editor = (fixture.editorFactory as any)(tui, {}, {});
    tui.focusedComponent = { selector: true };
    tui.doRender();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.widgets.has("tokyo-rain-selector")).toBe(true);

    const oldStatusTui = { requestRender: vi.fn() };
    const oldStatus = (fixture.widgets.get("tokyo-status") as any)(
      oldStatusTui,
      theme,
    );
    const unsubscribeBranch = vi.fn();
    const footerData = {
      getGitBranch: vi.fn(() => "main"),
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 0,
      onBranchChange: vi.fn(() => unsubscribeBranch),
    } as any;
    const oldFooterTui = { requestRender: vi.fn() };
    const oldFooter = fixture.footerFactory(oldFooterTui, theme, footerData);

    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    await fixture.emit(
      "message_update",
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "reasoning",
          partial: { role: "assistant" },
        },
      },
      fixture.ctx,
    );
    const workingMessageBeforeReset =
      fixture.ui.setWorkingMessage.mock.lastCall?.[0];
    expect(workingMessageBeforeReset).toEqual(expect.stringContaining("Thinking"));

    // Model Pi's resetExtensionUI(): it clears widgets, footer, and the
    // custom editor without ending the active agent operation.
    fixture.widgets.clear();
    fixture.ui.setEditorComponent(undefined);
    fixture.ui.setFooter(undefined);
    await vi.advanceTimersByTimeAsync(150);

    expect(fixture.editorFactory).toBeDefined();
    expect(fixture.widgets.has("tokyo-status")).toBe(true);
    expect(fixture.widgets.has("tokyo-rain-selector")).toBe(true);
    expect(fixture.footerFactory).toBeDefined();
    expect(fixture.setWidget.mock.calls.filter(([key]) => key === "tokyo-status"))
      .toHaveLength(2);
    expect(unsubscribeBranch).toHaveBeenCalledTimes(1);
    expect(fixture.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Thinking"),
    );

    const newStatusTui = { requestRender: vi.fn() };
    const newStatus = (fixture.widgets.get("tokyo-status") as any)(
      newStatusTui,
      theme,
    );
    const newFooterTui = { requestRender: vi.fn() };
    const newFooter = fixture.footerFactory(newFooterTui, theme, footerData);
    expect(newStatus).toBeDefined();
    expect(newFooter).toBeDefined();
    oldStatusTui.requestRender.mockClear();
    newStatusTui.requestRender.mockClear();
    oldStatus.invalidate();
    oldFooter.dispose();
    await vi.advanceTimersByTimeAsync(33);
    expect(oldStatusTui.requestRender).not.toHaveBeenCalled();
    expect(newStatusTui.requestRender).toHaveBeenCalled();
    expect(editor).toBeDefined();

    await fixture.emit("agent_end", { type: "agent_end", messages: [] }, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    await shutdown(fixture);
  });

  it("removes selector rain when a session is replaced on the same UI", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    const firstCtx = {
      ...fixture.ctx,
      sessionManager: {
        ...fixture.ctx.sessionManager,
        getSessionId: () => "session-first",
        getSessionFile: () => "/sessions/session-first.jsonl",
      },
    };
    const secondCtx = {
      ...fixture.ctx,
      sessionManager: {
        ...fixture.ctx.sessionManager,
        getSessionId: () => "session-second",
        getSessionFile: () => "/sessions/session-second.jsonl",
      },
    };

    await fixture.emit("session_start", { reason: "startup" }, firstCtx);
    const tui = {
      focusedComponent: undefined as unknown,
      hasOverlay: () => false,
      doRender: vi.fn(),
      requestRender: vi.fn(),
    };
    const editor = (fixture.editorFactory as any)(tui, {}, {});
    tui.focusedComponent = { selector: true };
    tui.doRender();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.widgets.has("tokyo-rain-selector")).toBe(true);

    await fixture.emit("session_start", { reason: "replace" }, secondCtx);

    expect(fixture.widgets.has("tokyo-rain-selector")).toBe(false);
    expect(editor).toBeDefined();
    await fixture.emit("session_shutdown", { reason: "quit" }, secondCtx);
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

describe("Tokyo Night interactive lifecycle", () => {
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

  it("keeps the native working row visible for interactive sessions", async () => {
    const fixture = makeFixture("tui");

    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    expect(fixture.ui.setWorkingVisible).toHaveBeenCalledWith(true);
    await shutdown(fixture);
  });

  it("shows Waiting through the native working message when an agent starts", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Waiting"),
    );
    await shutdown(fixture);
  });

  it("shows Thinking when the assistant emits thinking output", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();

    await fixture.emit(
      "message_update",
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "reasoning",
          partial: { role: "assistant" },
        },
      },
      fixture.ctx,
    );

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Thinking"),
    );
    await shutdown(fixture);
  });

  it("shows Streaming when the assistant emits text output", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();

    await fixture.emit(
      "message_update",
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "answer",
          partial: { role: "assistant" },
        },
      },
      fixture.ctx,
    );

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Streaming"),
    );
    await shutdown(fixture);
  });

  it("shows the active tool through the native working message", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();

    await fixture.emit(
      "tool_execution_start",
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "pwd" },
      },
      fixture.ctx,
    );

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Using tools · bash"),
    );
    await shutdown(fixture);
  });

  it("refreshes the native working message with the active tool duration", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    await fixture.emit(
      "tool_execution_start",
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: {},
      },
      fixture.ctx,
    );
    fixture.ui.setWorkingMessage.mockClear();

    vi.advanceTimersByTime(1500);

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("bash 1.5s"),
    );
    await shutdown(fixture);
  });

  it("keeps the remaining parallel tool visible until all tools finish", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    await fixture.emit(
      "tool_execution_start",
      { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} },
      fixture.ctx,
    );
    await fixture.emit(
      "tool_execution_start",
      { type: "tool_execution_start", toolCallId: "tool-2", toolName: "bash", args: {} },
      fixture.ctx,
    );
    fixture.ui.setWorkingMessage.mockClear();

    await fixture.emit(
      "tool_execution_end",
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: {},
        isError: false,
      },
      fixture.ctx,
    );

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Using tools · bash"),
    );

    await fixture.emit(
      "tool_execution_end",
      {
        type: "tool_execution_end",
        toolCallId: "tool-2",
        toolName: "bash",
        result: {},
        isError: false,
      },
      fixture.ctx,
    );

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Waiting"),
    );
    await shutdown(fixture);
  });

  it("resets the native working message when the agent ends", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();

    await fixture.emit("agent_end", { type: "agent_end", messages: [] }, fixture.ctx);
    vi.advanceTimersByTime(500);

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(fixture.ui.setWorkingMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Waiting"),
    );
    await shutdown(fixture);
  });

  it("restores the native working defaults when the TUI session shuts down", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    fixture.ui.setWorkingVisible.mockClear();
    fixture.ui.setWorkingMessage.mockClear();

    await shutdown(fixture);

    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(fixture.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
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

  it("uses responsive rows for a narrow status widget", async () => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender: vi.fn() },
      theme,
    );

    expect(status.render(60)).toHaveLength(3);
    await shutdown(fixture);
  });

  it.each([0, 1, 2])("keeps actual widget rows bounded at width %i", async (width) => {
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const status = fixture.widgets.get("tokyo-status")(
      { requestRender: vi.fn() },
      theme,
    );

    expect(() => status.render(width)).not.toThrow();
    expect(status.render(width)).toHaveLength(2);
    await shutdown(fixture);
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

describe("Tokyo Night Kimi quota polling lifecycle", () => {
  it.each(["rpc", "json", "print"] as const)(
    "does not poll from a %s session",
    async (mode) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const fixture = makeFixture(mode);
      fixture.ctx.model = { id: "kimi-model", provider: "kimi-coding" };
      fixture.ctx.modelRegistry = {
        getApiKeyForProvider: vi.fn(async () => "test-key"),
      };

      await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchSpy).not.toHaveBeenCalled();
      await shutdown(fixture);
    },
  );

  it("ignores a Kimi response after the model leaves Kimi", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => pendingFetch);
    const fixture = makeFixture("tui");
    fixture.ctx.model = { id: "kimi-model", provider: "kimi-coding" };
    fixture.ctx.modelRegistry = {
      getApiKeyForProvider: vi.fn(async () => "test-key"),
    };

    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const requestSignal = fetchSpy.mock.calls[0]?.[1]?.signal;
    expect(requestSignal).toEqual(expect.any(AbortSignal));

    const statusTui = { requestRender: vi.fn() };
    const statusFactory = fixture.widgets.get("tokyo-status");
    expect(statusFactory).toEqual(expect.any(Function));
    statusFactory(statusTui, theme);

    fixture.ctx.model = { id: "other-model", provider: "openai-codex" };
    await fixture.emit(
      "model_select",
      { model: fixture.ctx.model },
      fixture.ctx,
    );
    expect(requestSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(33);
    statusTui.requestRender.mockClear();

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({
        limits: [
          {
            window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: "100",
              used: "25",
              resetTime: "2099-01-01T00:00:00Z",
            },
          },
        ],
      }),
    } as Response);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(33);

    expect(statusTui.requestRender).not.toHaveBeenCalled();
    await shutdown(fixture);
  });

  it("does not let an old session response populate its replacement store", async () => {
    vi.useFakeTimers();
    const pendingFetches: Array<(response: Response) => void> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        () => new Promise<Response>((resolve) => pendingFetches.push(resolve)),
      );
    const fixture = makeFixture("tui");
    const kimiModel = { id: "kimi-model", provider: "kimi-coding" };
    fixture.ctx.model = kimiModel;
    fixture.ctx.modelRegistry = {
      getApiKeyForProvider: vi.fn(async () => "test-key"),
    };

    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();

    const replacementCtx = {
      ...fixture.ctx,
      model: kimiModel,
      sessionManager: {
        ...fixture.ctx.sessionManager,
        getSessionId: () => "session-2",
        getSessionFile: () => "/sessions/session-2.jsonl",
      },
    };
    await fixture.emit("session_start", { reason: "replace" }, replacementCtx);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const oldSignal = fetchSpy.mock.calls[0]?.[1]?.signal;
    expect(oldSignal).toEqual(expect.any(AbortSignal));
    expect(oldSignal?.aborted).toBe(true);

    const statusFactory = fixture.widgets.get("tokyo-status");
    expect(statusFactory).toEqual(expect.any(Function));
    const status = statusFactory({ requestRender: vi.fn() }, theme);

    pendingFetches[0]?.({
      ok: true,
      status: 200,
      json: async () => ({
        limits: [
          {
            window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: "100",
              used: "25",
              resetTime: "2099-01-01T00:00:00Z",
            },
          },
        ],
      }),
    } as Response);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(status.render(500).join("\\n")).not.toContain("LIMIT");

    pendingFetches[1]?.({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);
    await Promise.resolve();
    await Promise.resolve();
    await fixture.emit("session_shutdown", { reason: "quit" }, replacementCtx);
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
