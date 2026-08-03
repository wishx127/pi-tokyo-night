import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { default as extension } from "./extension";
import { TokyoConfigManager } from "./config";

type Mode = "tui" | "rpc" | "json" | "print";

type TuiFixture = {
  focusedComponent: unknown;
  hasOverlay: any;
  doRender: any;
  requestRender: any;
  setOverlay(value: boolean): void;
};

type UI = ReturnType<typeof makeUI>;

type Fixture = ReturnType<typeof makeFixture>;

const theme = {
  fg: (_color: string, text: string) => text,
} as any;

function makeTui(): TuiFixture {
  let overlay = false;
  return {
    focusedComponent: undefined,
    hasOverlay: vi.fn(() => overlay),
    doRender: vi.fn(),
    requestRender: vi.fn(),
    setOverlay(value: boolean) {
      overlay = value;
    },
  };
}

function makeUI() {
  const widgets = new Map<string, unknown>();
  let editorFactory: unknown;
  let footerFactory: unknown;
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
    setWorkingMessage: vi.fn(),
    setWorkingIndicator: vi.fn(),
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
  } as any;

  return {
    ui,
    widgets,
    setWidget,
    setEditorComponent,
    setFooter,
    get editorFactory() {
      return editorFactory;
    },
    get footerFactory() {
      return footerFactory;
    },
  };
}

function makeContext(ui: UI, mode: Mode, sessionId: string) {
  return {
    ui: ui.ui,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/workspace/project",
    model: undefined,
    modelRegistry: undefined,
    sessionManager: {
      getBranch: () => [],
      getLeafId: () => "leaf-1",
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
    },
    getContextUsage: () => undefined,
  } as any;
}

function makeFixture(mode: Mode = "tui") {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const ui = makeUI();
  const ctx = makeContext(ui, mode, "session-1");
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: vi.fn(),
    getThinkingLevel: () => "high",
    exec: vi.fn(async () => ({ code: 0, stdout: "main\n", stderr: "" })),
  } as any;

  extension(pi);

  return {
    pi,
    ui,
    ctx,
    makeContext: (nextUI = ui, nextMode = mode, sessionId = "session-1") =>
      makeContext(nextUI, nextMode, sessionId),
    async emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(...args);
      }
    },
  };
}

async function shutdown(fixture: Fixture, ctx = fixture.ctx): Promise<void> {
  await fixture.emit("session_shutdown", { reason: "quit" }, ctx);
}

const thinkingUpdate = {
  type: "message_update",
  message: { role: "assistant" },
  assistantMessageEvent: {
    type: "thinking_delta",
    contentIndex: 0,
    delta: "reasoning",
    partial: { role: "assistant" },
  },
};

const toolStart = {
  type: "tool_execution_start",
  toolCallId: "tool-1",
  toolName: "bash",
  args: {},
};

const toolEnd = {
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName: "bash",
  result: {},
  isError: false,
};

beforeEach(() => {
  vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(
    function (this: TokyoConfigManager) {
      this.set("kimiQuota", false);
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WorkingIndicator session replacement", () => {
  it("ignores every late old-session indicator event", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    const oldUI = fixture.ui;
    const oldCtx = fixture.ctx;
    const replacementUI = makeUI();
    const replacementCtx = fixture.makeContext(replacementUI, "tui", "session-2");

    await fixture.emit("session_start", { reason: "startup" }, oldCtx);
    await fixture.emit("agent_start", { type: "agent_start" }, oldCtx);
    await fixture.emit("session_start", { reason: "replace" }, replacementCtx);

    oldUI.ui.setWorkingMessage.mockClear();
    oldUI.ui.setWorkingVisible.mockClear();
    replacementUI.ui.setWorkingMessage.mockClear();
    replacementUI.ui.setWorkingVisible.mockClear();
    const timersAfterReplacement = vi.getTimerCount();

    await fixture.emit("agent_start", { type: "agent_start" }, oldCtx);
    await fixture.emit("message_update", thinkingUpdate, oldCtx);
    await fixture.emit("tool_execution_start", toolStart, oldCtx);
    await fixture.emit("tool_execution_end", toolEnd, oldCtx);

    expect(oldUI.ui.setWorkingMessage).not.toHaveBeenCalled();
    expect(oldUI.ui.setWorkingVisible).not.toHaveBeenCalled();
    expect(replacementUI.ui.setWorkingMessage).not.toHaveBeenCalled();
    expect(replacementUI.ui.setWorkingVisible).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersAfterReplacement);

    await shutdown(fixture, replacementCtx);
  });

  it("stops the old working timer when a session is replaced", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    const oldUI = fixture.ui;
    const oldCtx = fixture.ctx;
    const replacementUI = makeUI();
    const replacementCtx = fixture.makeContext(replacementUI, "tui", "session-2");

    await fixture.emit("session_start", { reason: "startup" }, oldCtx);
    await fixture.emit("agent_start", { type: "agent_start" }, oldCtx);
    const timersWhileOldWorking = vi.getTimerCount();

    await fixture.emit("session_start", { reason: "replace" }, replacementCtx);
    oldUI.ui.setWorkingMessage.mockClear();

    expect(vi.getTimerCount()).toBe(timersWhileOldWorking - 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(oldUI.ui.setWorkingMessage).not.toHaveBeenCalled();

    await shutdown(fixture, replacementCtx);
  });
});

describe("WorkingIndicator non-interactive guards", () => {
  it.each([
    ["rpc", true],
    ["json", false],
    ["print", false],
    ["tui", false],
  ] as const)("performs no UI operation for %s (hasUI=%s)", async (mode, hasUI) => {
    vi.useFakeTimers();
    const fixture = makeFixture(mode);
    fixture.ctx.hasUI = hasUI;

    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    await fixture.emit("turn_start", { type: "turn_start" }, fixture.ctx);
    await fixture.emit("message_update", thinkingUpdate, fixture.ctx);
    await fixture.emit("tool_execution_start", toolStart, fixture.ctx);
    await fixture.emit("tool_execution_end", toolEnd, fixture.ctx);
    await fixture.emit("agent_end", { type: "agent_end", messages: [] }, fixture.ctx);

    expect(fixture.ui.ui.setWorkingVisible).not.toHaveBeenCalled();
    expect(fixture.ui.ui.setWorkingMessage).not.toHaveBeenCalled();
    expect(fixture.ui.ui.setWorkingIndicator).not.toHaveBeenCalled();
    expect(fixture.ui.setWidget).not.toHaveBeenCalled();
    expect(fixture.ui.setEditorComponent).not.toHaveBeenCalled();
    expect(fixture.ui.setFooter).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await shutdown(fixture);
  });
});

describe("WorkingIndicator state reset", () => {
  it("times the current Thinking phase independently from the agent start", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    await vi.advanceTimersByTimeAsync(1200);

    await fixture.emit("message_update", thinkingUpdate, fixture.ctx);
    fixture.ui.ui.setWorkingMessage.mockClear();
    await vi.advanceTimersByTimeAsync(2300);

    expect(fixture.ui.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      "Thinking 2.3s",
    );
    await shutdown(fixture);
  });

  it("clears phase and tools and creates exactly one new timer per agent start", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    await fixture.emit("message_update", thinkingUpdate, fixture.ctx);
    await fixture.emit("tool_execution_start", toolStart, fixture.ctx);
    expect(fixture.ui.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Using tools · bash"),
    );
    const timersWhileWorking = vi.getTimerCount();

    await fixture.emit("agent_end", { type: "agent_end", messages: [] }, fixture.ctx);
    expect(vi.getTimerCount()).toBe(timersWhileWorking - 1);

    fixture.ui.ui.setWorkingMessage.mockClear();
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    expect(fixture.ui.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Waiting /),
    );
    expect(fixture.ui.ui.setWorkingMessage).not.toHaveBeenLastCalledWith(
      expect.stringContaining("bash"),
    );
    expect(fixture.ui.ui.setWorkingMessage).not.toHaveBeenLastCalledWith(
      expect.stringContaining("Thinking"),
    );
    expect(vi.getTimerCount()).toBe(timersWhileWorking);

    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.ui.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Waiting /),
    );

    await shutdown(fixture);
  });

  it("preserves working state through resetExtensionUI-style cleanup", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);
    const editorTui = makeTui();
    (fixture.ui.editorFactory as any)(editorTui, {}, {});
    await fixture.emit("agent_start", { type: "agent_start" }, fixture.ctx);
    fixture.ui.ui.setWorkingMessage.mockClear();
    fixture.ui.ui.setWorkingVisible.mockClear();

    // Pi's resetExtensionUI clears extension-owned widgets and component
    // registrations, rather than shutting down the active session.
    fixture.ui.widgets.clear();
    fixture.ui.ui.setEditorComponent(undefined);
    fixture.ui.ui.setFooter(undefined);

    expect(fixture.ui.widgets.size).toBe(0);
    expect(fixture.ui.editorFactory).toBeUndefined();
    expect(fixture.ui.footerFactory).toBeUndefined();

    await vi.advanceTimersByTimeAsync(150);
    expect(fixture.ui.editorFactory).toBeDefined();
    expect(fixture.ui.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);

    const messagesBeforeTick = fixture.ui.ui.setWorkingMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.ui.ui.setWorkingMessage.mock.calls.length).toBeGreaterThan(
      messagesBeforeTick,
    );
    expect(fixture.ui.ui.setWorkingMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Waiting /),
    );

    await shutdown(fixture);
  });
});

describe("WorkingIndicator root/footer TUI integration", () => {
  it("detects root-only selectors and overlays with an independent footer TUI", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture("tui");
    await fixture.emit("session_start", { reason: "startup" }, fixture.ctx);

    const editorTui = makeTui();
    const rootTui = makeTui();
    const editor = (fixture.ui.editorFactory as any)(editorTui, {}, {});
    const footerData = {
      getGitBranch: vi.fn(() => "main"),
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 0,
      onBranchChange: vi.fn(() => () => {}),
    } as any;
    (fixture.ui.footerFactory as any)(rootTui, theme, footerData);
    expect(rootTui).not.toBe(editorTui);

    editorTui.focusedComponent = editor;
    rootTui.focusedComponent = { selector: true };
    editorTui.doRender();
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.ui.widgets.has("tokyo-rain-selector")).toBe(true);
    const overlayFactory = fixture.ui.widgets.get("tokyo-rain-selector") as any;
    const overlay = overlayFactory(rootTui, theme);
    expect(overlay.render(40).length).toBeGreaterThan(0);

    // A root-only overlay is also enough to keep the selector rain active.
    rootTui.focusedComponent = undefined;
    rootTui.setOverlay(true);
    editorTui.doRender();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.ui.widgets.has("tokyo-rain-selector")).toBe(true);

    rootTui.setOverlay(false);
    editorTui.doRender();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.ui.setWidget).toHaveBeenLastCalledWith(
      "tokyo-rain-selector",
      undefined,
    );
    expect(fixture.ui.widgets.has("tokyo-rain-selector")).toBe(false);

    await shutdown(fixture);
  });
});
