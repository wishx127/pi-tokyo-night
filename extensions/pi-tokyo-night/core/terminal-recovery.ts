import { StdinBuffer, type TUI } from "@earendil-works/pi-tui";
import { handleExtensionError } from "./errors";

export interface TerminalRecoveryTarget {
  terminal: Pick<TUI["terminal"], "write" | "start" | "stop">;
  readonly mode?: string;
  addInputListener?: TUI["addInputListener"];
}

export interface TerminalRecoveryCallbacks {
  onFocus(focused: boolean): void;
  onResize(): void;
  onActive(active: boolean): void;
}

export interface TerminalRecoverySources {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

const QUERY_FOCUS = "\x1b[?1004$p";
const ENABLE_FOCUS = "\x1b[?1004h";
const DISABLE_FOCUS = "\x1b[?1004l";
type Subscriber = { target: TerminalRecoveryTarget; callbacks: TerminalRecoveryCallbacks };
type Observation = {
  subscribe(target: TerminalRecoveryTarget, callbacks: TerminalRecoveryCallbacks): { dispose(): void } | undefined;
};
const observations = new WeakMap<TerminalRecoveryTarget["terminal"], Observation>();
// Replies carry no request id, so pending positions must survive observer reloads.
const queryLedgers = new WeakMap<TerminalRecoveryTarget["terminal"], { issued: number; received: number }>();

function escapeTimeoutMs(): number {
  const configured = Number(process.env.PI_TUI_ESC_TIMEOUT);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return process.env.SSH_CONNECTION || process.env.SSH_TTY ? 100 : 10;
}

/** Observe raw focus input; keep focus and our query replies out of the editor. */
export function observeTerminalRecovery(
  target: TerminalRecoveryTarget,
  callbacks: TerminalRecoveryCallbacks,
  sources: TerminalRecoverySources = { input: process.stdin, output: process.stdout },
): { dispose(): void } | undefined {
  if (!sources.input.isTTY || !sources.output.isTTY) return undefined;
  const existing = observations.get(target.terminal);
  if (existing) return existing.subscribe(target, callbacks);
  let queries = queryLedgers.get(target.terminal);
  if (!queries) {
    queries = { issued: 0, received: 0 };
    queryLedgers.set(target.terminal, queries);
  }
  const subscribers = new Set<Subscriber>();
  const notify = (subscriber: TerminalRecoveryCallbacks, invoke: (callbacks: TerminalRecoveryCallbacks) => void): boolean => {
    try {
      invoke(subscriber);
      return true;
    } catch (error) {
      handleExtensionError(error, "terminal recovery callback");
      return false;
    }
  };
  const writeProtocol = (data: string): boolean => {
    try {
      target.terminal.write(data);
      return true;
    } catch (error) {
      handleExtensionError(error, "terminal recovery protocol");
      return false;
    }
  };
  const publish = (invoke: (callbacks: TerminalRecoveryCallbacks) => void): void => {
    for (const subscriber of [...subscribers]) {
      if (subscribers.has(subscriber)) notify(subscriber.callbacks, invoke);
    }
  };
  let ownsFocusReporting = false;
  let currentQuery: number | undefined;
  let removeReplyListener: (() => void) | undefined;
  let disposed = false;
  let active = true;
  const bufferOptions = { timeout: 50, escapeTimeout: escapeTimeoutMs() };
  const parser = new StdinBuffer(bufferOptions);
  const onInput = (data: string | Buffer): void => { parser.process(data); };
  parser.on("data", (data) => {
    if (data === "\x1b[I") publish((subscriber) => subscriber.onFocus(true));
    else if (data === "\x1b[O") publish((subscriber) => subscriber.onFocus(false));
  });
  sources.input.on("data", onInput);
  const onResize = (): void => publish((subscriber) => subscriber.onResize());
  sources.output.on("resize", onResize);
  const originalStart = target.terminal.start;
  const originalStop = target.terminal.stop;
  const startDescriptor = Object.getOwnPropertyDescriptor(target.terminal, "start");
  const stopDescriptor = Object.getOwnPropertyDescriptor(target.terminal, "stop");
  const disableOwnedFocus = (): void => {
    if (!ownsFocusReporting) return;
    ownsFocusReporting = false;
    writeProtocol(DISABLE_FOCUS);
  };
  const queryFocus = (): boolean => {
    const currentTarget = [...subscribers].at(-1)?.target ?? target;
    if (!currentTarget.addInputListener) return true;
    try {
      removeReplyListener = currentTarget.addInputListener((data) => {
        if (data === "\x1b[I" || data === "\x1b[O") return { consume: true };
        const status = /^\x1b\[\?1004;([0-4])\$y$/.exec(data)?.[1];
        if (!status || queries.received === queries.issued) return undefined;
        const query = ++queries.received;
        if (active && query === currentQuery) {
          currentQuery = undefined;
          // Unknown/permanently closed states are not permission to change a
          // mode possibly owned by another extension. Only own a known change.
          if (status === "2") {
            ownsFocusReporting = true;
            writeProtocol(ENABLE_FOCUS);
          }
        }
        return { consume: true };
      });
      // Replies have no request id. Keep old pending positions across restarts
      // so a late reply cannot grant ownership to a different renderer. A lost
      // old reply conservatively leaves later ownership unknown, without timers.
      currentQuery = ++queries.issued;
      if (writeProtocol(QUERY_FOCUS)) return true;
      currentQuery = undefined;
    } catch (error) {
      handleExtensionError(error, "terminal recovery input listener");
    }
    return false;
  };
  const restoreMethods = (): void => {
    for (const [name, owned, descriptor] of [
      ["start", start, startDescriptor],
      ["stop", stop, stopDescriptor],
    ] as const) {
      if (target.terminal[name] !== owned) continue;
      if (descriptor) Reflect.defineProperty(target.terminal, name, descriptor);
      else Reflect.deleteProperty(target.terminal, name);
    }
  };
  const detach = (): void => {
    sources.input.off("data", onInput);
    sources.output.off("resize", onResize);
    parser.clear();
    try {
      removeReplyListener?.();
    } catch (error) {
      handleExtensionError(error, "terminal recovery input cleanup");
    }
    removeReplyListener = undefined;
    currentQuery = undefined;
  };
  const start: typeof originalStart = function (this: TerminalRecoveryTarget["terminal"], ...args) {
    originalStart.apply(this, args);
    if (disposed || active) return;
    active = true;
    sources.input.on("data", onInput);
    sources.output.on("resize", onResize);
    queryFocus();
    publish((subscriber) => subscriber.onActive(true));
  };
  const stop: typeof originalStop = function (this: TerminalRecoveryTarget["terminal"]) {
    if (!disposed && active) {
      active = false;
      detach();
      disableOwnedFocus();
      publish((subscriber) => subscriber.onActive(false));
    }
    originalStop.call(this);
  };
  try {
    if (!Reflect.set(target.terminal, "start", start) ||
      !Reflect.set(target.terminal, "stop", stop)) {
      restoreMethods();
      detach();
      parser.destroy();
      return undefined;
    }
  } catch {
    restoreMethods();
    detach();
    parser.destroy();
    return undefined;
  }
  if (!queryFocus()) {
    disposed = true;
    restoreMethods();
    detach();
    parser.destroy();
    return undefined;
  }
  const observation: Observation = {
    subscribe(subscriberTarget, subscriberCallbacks) {
      const subscriber = { target: subscriberTarget, callbacks: subscriberCallbacks };
      subscribers.add(subscriber);
      const handle = {
        dispose() {
          if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
          disposed = true;
          observations.delete(target.terminal);
          detach();
          parser.destroy();
          restoreMethods();
          disableOwnedFocus();
        },
      };
      if (!notify(subscriberCallbacks, (subscriber) => subscriber.onActive(active))) {
        handle.dispose();
        return undefined;
      }
      return handle;
    },
  };
  observations.set(target.terminal, observation);
  return observation.subscribe(target, callbacks);
}
