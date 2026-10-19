import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, StdinBuffer } from "@earendil-works/pi-tui";
import { observeTerminalRecovery, type TerminalRecoveryTarget } from "./terminal-recovery";

type TuiInputListener = Parameters<NonNullable<TerminalRecoveryTarget["addInputListener"]>>[0];

function makeFixture(mode: string | undefined = "regular") {
  const input = Object.assign(new EventEmitter(), { isTTY: true });
  const output = Object.assign(new EventEmitter(), { isTTY: true });
  const terminal = {
    write: vi.fn(),
    start: vi.fn((_onInput: (data: string) => void, _onResize: () => void) => {}),
    stop: vi.fn(),
  };
  const replyListeners = new Set<TuiInputListener>();
  const addInputListener = vi.fn((listener: TuiInputListener) => {
    replyListeners.add(listener);
    return () => { replyListeners.delete(listener); };
  });
  const target = { terminal, mode, addInputListener };
  const callbacks = { onFocus: vi.fn(), onResize: vi.fn(), onActive: vi.fn() };
  const sources = {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  };
  const reply = (data: string) => {
    const consumed = [...replyListeners].some((listener) => listener(data)?.consume);
    input.emit("data", data);
    return consumed;
  };
  return { input, output, terminal, target, callbacks, sources, reply, replyListeners };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("terminal recovery event adapter", () => {
  it("observes fragmented focus input without changing what the host receives", () => {
    const fixture = makeFixture();
    const hostInput = vi.fn();
    fixture.input.on("data", hostInput);
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    try {
      for (const chunk of ["\x1b", "[", "O", "\x1b[I", "hello"]) fixture.input.emit("data", chunk);

      expect(fixture.callbacks.onFocus.mock.calls).toEqual([[false], [true]]);
      expect(hostInput.mock.calls).toEqual([["\x1b"], ["["], ["O"], ["\x1b[I"], ["hello"]]);
      expect(fixture.callbacks.onActive).toHaveBeenCalledWith(true);
      expect(fixture.terminal.write).toHaveBeenCalledWith("\x1b[?1004$p");
    } finally {
      observer?.dispose();
    }
  });

  it("forwards resize events while ignoring focus sequences inside bracketed paste", () => {
    const fixture = makeFixture();
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    try {
      fixture.input.emit("data", "\x1b[200~pasted \x1b[I\x1b[O\x1b[201~");
      fixture.output.emit("resize");

      expect(fixture.callbacks.onFocus).not.toHaveBeenCalled();
      expect(fixture.callbacks.onResize).toHaveBeenCalledOnce();
    } finally {
      observer?.dispose();
    }
  });

  it.each([
    ["regular", "1", undefined],
    ["regular", "2", "l"],
    ["regular", "3", undefined],
    ["fullscreen", "4", undefined],
    ["fullscreen", "0", undefined],
    ["regular", undefined, undefined],
    ["fullscreen", undefined, undefined],
    [undefined, undefined, undefined],
  ] as const)("only restores focus reporting it enabled from a known closed state in %s mode (reply %s)", (mode, status, suffix) => {
    const fixture = makeFixture(mode);
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    if (status) fixture.reply(`\x1b[?1004;${status}$y`);
    fixture.terminal.write.mockClear();

    observer?.dispose();
    observer?.dispose();

    expect(fixture.terminal.write.mock.calls).toEqual(suffix ? [[`\x1b[?1004${suffix}`]] : []);
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.output.listenerCount("resize")).toBe(0);
  });

  it.each(["input", "output"] as const)("leaves non-TTY %s streams untouched", (source) => {
    const fixture = makeFixture();
    fixture[source].isTTY = false;
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    try {
      expect(observer).toBeUndefined();
      expect(fixture.terminal.write).not.toHaveBeenCalled();
      expect(fixture.input.listenerCount("data")).toBe(0);
      expect(fixture.output.listenerCount("resize")).toBe(0);
    } finally {
      observer?.dispose();
    }
  });

  it("disables reporting during terminal stops and reattaches after a renderer restart", () => {
    const fixture = makeFixture();
    const originalStart = fixture.terminal.start;
    const originalStop = fixture.terminal.stop;
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    try {
      fixture.reply("\x1b[?1004;2$y");
      fixture.terminal.stop();
      expect(originalStop).toHaveBeenCalledOnce();
      expect(fixture.terminal.write).toHaveBeenLastCalledWith("\x1b[?1004l");
      expect(fixture.callbacks.onActive.mock.calls).toEqual([[true], [false]]);
      fixture.input.emit("data", "\x1b[O");
      fixture.output.emit("resize");
      expect(fixture.callbacks.onFocus).not.toHaveBeenCalled();
      expect(fixture.callbacks.onResize).not.toHaveBeenCalled();

      fixture.target.mode = "fullscreen";
      const input = vi.fn();
      const resize = vi.fn();
      fixture.terminal.start(input, resize);
      expect(originalStart).toHaveBeenCalledWith(input, resize);
      expect(fixture.callbacks.onActive.mock.calls).toEqual([[true], [false], [true]]);
      expect(fixture.terminal.write).toHaveBeenLastCalledWith("\x1b[?1004$p");
      fixture.reply("\x1b[?1004;2$y");
      fixture.input.emit("data", "\x1b[I");
      fixture.output.emit("resize");
      expect(fixture.callbacks.onFocus).toHaveBeenCalledWith(true);
      expect(fixture.callbacks.onResize).toHaveBeenCalledOnce();
    } finally {
      observer?.dispose();
    }
    expect(fixture.terminal.start).toBe(originalStart);
    expect(fixture.terminal.stop).toBe(originalStop);
    expect(fixture.terminal.write).toHaveBeenLastCalledWith("\x1b[?1004l");
  });

  it("shares one terminal hook until its final subscriber leaves", () => {
    const fixture = makeFixture();
    const originalStart = fixture.terminal.start;
    const first = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    const start = fixture.terminal.start;
    const secondCallbacks = { onFocus: vi.fn(), onResize: vi.fn(), onActive: vi.fn() };
    const second = observeTerminalRecovery(fixture.target, secondCallbacks, fixture.sources);
    try {
      expect(fixture.terminal.start).toBe(start);
      expect(fixture.terminal.write).toHaveBeenCalledOnce();
      expect(fixture.input.listenerCount("data")).toBe(1);
      expect(fixture.output.listenerCount("resize")).toBe(1);
      fixture.reply("\x1b[?1004;2$y");
      first?.dispose();
      expect(fixture.terminal.write).toHaveBeenCalledTimes(2);
      fixture.input.emit("data", "\x1b[O");
      fixture.output.emit("resize");
      expect(fixture.callbacks.onFocus).not.toHaveBeenCalled();
      expect(secondCallbacks.onFocus).toHaveBeenCalledWith(false);
      expect(secondCallbacks.onResize).toHaveBeenCalledOnce();
    } finally {
      first?.dispose();
      second?.dispose();
    }
    expect(fixture.terminal.start).toBe(originalStart);
    expect(fixture.terminal.write).toHaveBeenLastCalledWith("\x1b[?1004l");
    expect(fixture.input.listenerCount("data")).toBe(0);
  });

  it("restores inherited lifecycle methods without replacing a later owner's wrapper", () => {
    const fixture = makeFixture();
    const inherited = fixture.terminal;
    const terminal = Object.create(inherited) as typeof inherited;
    const target = { terminal, mode: "regular" };
    const observer = observeTerminalRecovery(target, fixture.callbacks, fixture.sources);
    const ownedStop = terminal.stop;
    const laterStop = vi.fn(() => ownedStop.call(terminal));
    terminal.stop = laterStop;

    observer?.dispose();
    terminal.stop();

    expect(Object.hasOwn(terminal, "start")).toBe(false);
    expect(terminal.stop).toBe(laterStop);
    expect(inherited.stop).toHaveBeenCalledOnce();
    expect(fixture.callbacks.onActive.mock.calls).toEqual([[true]]);
  });

  it("declines read-only terminal lifecycle methods without leaving listeners behind", () => {
    const fixture = makeFixture();
    Object.freeze(fixture.terminal);

    expect(observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources)).toBeUndefined();
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.output.listenerCount("resize")).toBe(0);
    expect(fixture.terminal.write).not.toHaveBeenCalled();
  });

  it("keeps a failing subscriber from interrupting native input or other subscribers", () => {
    const fixture = makeFixture();
    const error = new Error("recovery callback failed");
    fixture.callbacks.onFocus.mockImplementation(() => { throw error; });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    const secondCallbacks = { onFocus: vi.fn(), onResize: vi.fn(), onActive: vi.fn() };
    const second = observeTerminalRecovery(fixture.target, secondCallbacks, fixture.sources);
    try {
      expect(() => fixture.input.emit("data", "\x1b[I")).not.toThrow();
      expect(secondCallbacks.onFocus).toHaveBeenCalledWith(true);
      expect(log).toHaveBeenCalledWith("[pi-tokyo-night] terminal recovery callback:", error);
    } finally {
      first?.dispose();
      second?.dispose();
      log.mockRestore();
    }
  });

  it.each(["write", "onActive"] as const)("rolls back observation when initial %s fails", (failure) => {
    const fixture = makeFixture();
    const originalStart = fixture.terminal.start;
    const originalStop = fixture.terminal.stop;
    const error = new Error("initial observation failed");
    if (failure === "write") fixture.terminal.write.mockImplementationOnce(() => { throw error; });
    else fixture.callbacks.onActive.mockImplementationOnce(() => { throw error; });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources)).toBeUndefined();
      expect(fixture.input.listenerCount("data")).toBe(0);
      expect(fixture.output.listenerCount("resize")).toBe(0);
      expect(fixture.terminal.start).toBe(originalStart);
      expect(fixture.terminal.stop).toBe(originalStop);
      const replacement = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
      expect(replacement).toBeDefined();
      replacement?.dispose();
    } finally {
      log.mockRestore();
    }
  });

  it("completes cleanup when restoring focus reporting fails", () => {
    const fixture = makeFixture();
    const originalStart = fixture.terminal.start;
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    fixture.reply("\x1b[?1004;2$y");
    fixture.terminal.write.mockImplementationOnce(() => { throw new Error("terminal closed"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => observer?.dispose()).not.toThrow();
      expect(fixture.input.listenerCount("data")).toBe(0);
      expect(fixture.output.listenerCount("resize")).toBe(0);
      expect(fixture.terminal.start).toBe(originalStart);
    } finally {
      log.mockRestore();
    }
  });

  it("does not mistake a later owner's state query for the pre-observation state", () => {
    const fixture = makeFixture();
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    fixture.reply("\x1b[?1004;2$y");
    expect(fixture.reply("\x1b[?1004;1$y")).toBe(false);

    observer?.dispose();

    expect(fixture.terminal.write).toHaveBeenLastCalledWith("\x1b[?1004l");
  });

  it("discards an old query reply after restart without changing the new renderer's state", () => {
    const fixture = makeFixture();
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    fixture.terminal.stop();
    fixture.target.mode = "fullscreen";
    fixture.terminal.start(vi.fn(), vi.fn());
    expect(fixture.reply("\x1b[?1004;2$y")).toBe(true);
    expect(fixture.reply("\x1b[?1004;1$y")).toBe(true);

    observer?.dispose();

    expect(fixture.terminal.write.mock.calls).toEqual([["\x1b[?1004$p"], ["\x1b[?1004$p"]]);
    expect(fixture.replyListeners.size).toBe(0);
  });

  it("keeps pending query ordering across disposal and replacement observation", () => {
    const fixture = makeFixture();
    const first = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    first?.dispose();
    expect(fixture.replyListeners.size).toBe(0);
    expect(fixture.input.listenerCount("data")).toBe(0);
    fixture.target.mode = "fullscreen";
    const replacement = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);

    expect(fixture.reply("\x1b[?1004;2$y")).toBe(true);
    expect(fixture.reply("\x1b[?1004;1$y")).toBe(true);
    replacement?.dispose();

    expect(fixture.terminal.write.mock.calls).toEqual([["\x1b[?1004$p"], ["\x1b[?1004$p"]]);
    expect(fixture.replyListeners.size).toBe(0);
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.output.listenerCount("resize")).toBe(0);
  });

  it("keeps unknown ownership conservative when an old reply was lost while stopped", () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    fixture.terminal.stop();
    fixture.reply("\x1b[?1004;2$y");
    fixture.terminal.start(vi.fn(), vi.fn());
    fixture.reply("\x1b[?1004;1$y");

    observer?.dispose();

    expect(fixture.terminal.write.mock.calls).toEqual([["\x1b[?1004$p"], ["\x1b[?1004$p"]]);
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.output.listenerCount("resize")).toBe(0);
    expect(fixture.replyListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not query without a public reply listener but still observes resize", () => {
    const fixture = makeFixture();
    const observer = observeTerminalRecovery({ terminal: fixture.terminal }, fixture.callbacks, fixture.sources);
    fixture.output.emit("resize");
    observer?.dispose();
    expect(fixture.callbacks.onResize).toHaveBeenCalledOnce();
    expect(fixture.terminal.write).not.toHaveBeenCalled();
  });

  it.each(["SSH_CONNECTION", "PI_TUI_ESC_TIMEOUT"] as const)("uses the host escape timeout for fragmented focus with %s", (source) => {
    vi.useFakeTimers();
    vi.stubEnv("SSH_CONNECTION", "");
    vi.stubEnv("SSH_TTY", "");
    vi.stubEnv("PI_TUI_ESC_TIMEOUT", "");
    vi.stubEnv(source, source === "SSH_CONNECTION" ? "remote" : "100");
    const fixture = makeFixture();
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    fixture.input.emit("data", "\x1b");
    vi.advanceTimersByTime(25);
    fixture.input.emit("data", "[");
    vi.advanceTimersByTime(25);
    fixture.input.emit("data", "I");
    expect(fixture.callbacks.onFocus).toHaveBeenCalledWith(true);
    observer?.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes only its own query reply so native editor jump mode survives", () => {
    const fixture = makeFixture();
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    const editor = new Editor({ requestRender() {}, terminal: { rows: 24 } } as any, { borderColor: (text: string) => text } as any);
    editor.setText("abcabc");
    editor.handleInput("\x01");
    editor.handleInput("\x1d");
    const response = "\x1b[?1004;2$y";
    const hostParser = new StdinBuffer();
    hostParser.on("data", (data) => { if (!fixture.reply(data)) editor.handleInput(data); });
    hostParser.process("\x1b[?1004;");
    hostParser.process("2$y");
    editor.handleInput("c");
    expect(editor.getText()).toBe("abcabc");
    expect(editor.getCursor().col).toBe(2);
    expect(fixture.reply(response)).toBe(false);
    hostParser.destroy();
    observer?.dispose();
  });

  it("keeps focus reports out of native editor jump mode while observing both events", () => {
    const fixture = makeFixture();
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    fixture.reply("\x1b[?1004;2$y");
    const editor = new Editor({ requestRender() {}, terminal: { rows: 24 } } as any, { borderColor: (text: string) => text } as any);
    editor.setText("abcabc");
    editor.handleInput("\x01");
    editor.handleInput("\x1d");
    const hostParser = new StdinBuffer();
    hostParser.on("data", (data) => { if (!fixture.reply(data)) editor.handleInput(data); });

    hostParser.process("\x1b[O\x1b[I");
    editor.handleInput("c");

    expect(editor.getText()).toBe("abcabc");
    expect(editor.getCursor().col).toBe(2);
    expect(fixture.callbacks.onFocus.mock.calls).toEqual([[false], [true]]);
    hostParser.destroy();
    observer?.dispose();
  });

  it("passes pasted protocol text through without treating it as a state response", () => {
    const fixture = makeFixture();
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    const paste = "\x1b[200~\x1b[?1004;2$y\x1b[I\x1b[201~";

    expect(fixture.reply(paste)).toBe(false);
    expect(fixture.callbacks.onFocus).not.toHaveBeenCalled();
    expect(fixture.terminal.write.mock.calls).toEqual([["\x1b[?1004$p"]]);
    expect(fixture.reply("\x1b[?1004;2$y")).toBe(true);
    expect(fixture.terminal.write).toHaveBeenLastCalledWith("\x1b[?1004h");
    observer?.dispose();
  });

  it("still restores lifecycle methods if a public input listener's cleanup fails", () => {
    const fixture = makeFixture();
    const originalStart = fixture.terminal.start;
    fixture.target.addInputListener.mockImplementationOnce((listener) => {
      fixture.replyListeners.add(listener);
      return () => { fixture.replyListeners.delete(listener); throw new Error("listener cleanup failed"); };
    });
    const observer = observeTerminalRecovery(fixture.target, fixture.callbacks, fixture.sources);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => observer?.dispose()).not.toThrow();
      expect(fixture.input.listenerCount("data")).toBe(0);
      expect(fixture.replyListeners.size).toBe(0);
      expect(fixture.terminal.start).toBe(originalStart);
    } finally {
      log.mockRestore();
    }
  });
});
