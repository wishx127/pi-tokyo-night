import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./extension";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TokyoConfigManager } from "./core/config";

function makeFixture(mode: "tui" | "rpc" | "json" | "print" = "tui") {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const ui = {
    setWidget: vi.fn(), setEditorComponent: vi.fn(), getEditorComponent: vi.fn(), setFooter: vi.fn(),
    setWorkingVisible: vi.fn(), setWorkingMessage: vi.fn(), setWorkingIndicator: vi.fn(),
    notify: vi.fn(), select: vi.fn(), confirm: vi.fn(), input: vi.fn(), onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(), setHiddenThinkingLabel: vi.fn(),
  } as any;
  const ctx = {
    ui, mode, hasUI: mode === "tui", cwd: "/workspace/project", model: undefined,
    modelRegistry: { getApiKeyForProvider: vi.fn(async () => undefined) },
    sessionManager: { getBranch: () => [], getLeafId: () => "leaf", getSessionId: () => "session", getSessionFile: () => "/session" },
    isIdle: vi.fn(() => true),
  } as any;
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: vi.fn(), getThinkingLevel: () => "high", exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  } as any;
  extension(pi);
  return {
    ui, ctx,
    async emit(event: string, ...args: any[]) { for (const handler of handlers.get(event) ?? []) await handler(...args); },
  };
}

beforeEach(() => vi.spyOn(TokyoConfigManager.prototype, "read").mockImplementation(() => {}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("working indicator compatibility regression", () => {
  it("ignores working events outside the interactive TUI", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const fixture = makeFixture(mode);
      await fixture.emit("session_start", {}, fixture.ctx);
      await fixture.emit("agent_start", {}, fixture.ctx);
      await fixture.emit("message_update", { assistantMessageEvent: { type: "thinking_delta" } }, fixture.ctx);
      await fixture.emit("agent_end", {}, fixture.ctx);
      await fixture.emit("agent_settled", {}, fixture.ctx);
      expect(fixture.ui.setWorkingMessage).not.toHaveBeenCalled();
      expect(fixture.ui.setWorkingIndicator).not.toHaveBeenCalled();
      expect(fixture.ui.setWorkingVisible).not.toHaveBeenCalled();
    }
  });

  it("keeps one timer per active session and clears it on replacement", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    const timerCount = vi.getTimerCount();
    const replacement = { ...fixture.ctx, sessionManager: { ...fixture.ctx.sessionManager, getSessionId: () => "replacement", getSessionFile: () => "/replacement" } };
    await fixture.emit("session_start", {}, replacement);
    expect(vi.getTimerCount()).toBe(timerCount - 1);
    await fixture.emit("session_shutdown", { reason: "quit" }, replacement);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses updates between low-level runs and clears only after settling", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();

    await fixture.emit("agent_end", {}, fixture.ctx);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.ui.setWorkingMessage).not.toHaveBeenCalled();

    await fixture.emit("agent_start", {}, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("Waiting"));
    fixture.ui.setWorkingMessage.mockClear();
    await fixture.emit("agent_end", {}, fixture.ctx);
    await fixture.emit("agent_settled", {}, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledOnce();
    expect(fixture.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(fixture.ui.setWorkingIndicator).toHaveBeenLastCalledWith();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("coalesces repeated phase messages", async () => {
    const fixture = makeFixture();
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingIndicator.mockClear();
    fixture.ui.setWorkingMessage.mockClear();
    const event = { assistantMessageEvent: { type: "thinking_delta" } };
    await fixture.emit("message_update", event, fixture.ctx);
    await fixture.emit("message_update", event, fixture.ctx);
    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledOnce();
    expect(fixture.ui.setWorkingIndicator).not.toHaveBeenCalled();
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("updates the Tokyo spinner and elapsed together every 250ms", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingIndicator.mockClear();
    fixture.ui.setWorkingMessage.mockClear();

    await vi.advanceTimersByTimeAsync(1000);

    expect(fixture.ui.setWorkingIndicator).toHaveBeenCalledTimes(4);
    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledTimes(4);
    const frames = fixture.ui.setWorkingIndicator.mock.calls.map(
      ([options]: [{ frames: string[] }]) => options.frames,
    );
    expect(frames.every((value: string[]) => value.length === 1)).toBe(true);
    expect(new Set(frames.map((value: string[]) => value[0])).size).toBe(4);
    expect(frames.every((value: string[]) => visibleWidth(value[0]) === 1)).toBe(true);
    expect(
      fixture.ui.setWorkingIndicator.mock.calls.every(
        ([options]: [{ intervalMs?: number }]) => options.intervalMs === undefined,
      ),
    ).toBe(true);

    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });

  it("keeps the 250ms elapsed fallback when the host lacks indicator customization", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    delete fixture.ui.setWorkingIndicator;
    await fixture.emit("session_start", {}, fixture.ctx);
    await fixture.emit("agent_start", {}, fixture.ctx);
    fixture.ui.setWorkingMessage.mockClear();

    await vi.advanceTimersByTimeAsync(500);

    expect(fixture.ui.setWorkingMessage).toHaveBeenCalledTimes(2);
    await fixture.emit("session_shutdown", { reason: "quit" }, fixture.ctx);
  });
});
