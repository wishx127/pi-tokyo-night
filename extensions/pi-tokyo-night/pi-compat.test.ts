import { describe, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { evaluatePiCompatibility, requestHostRender } from "./pi-compat";

function createDynamicTuiProxy(
  getTarget: () => Pick<TUI, "requestRender">,
): Pick<TUI, "requestRender"> {
  return new Proxy({} as Pick<TUI, "requestRender">, {
    get: (_target, property) => {
      const value = Reflect.get(getTarget(), property, getTarget());
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const current = getTarget();
        const method = Reflect.get(current, property, current);
        return Reflect.apply(method, current, args);
      };
    },
    set: () => {
      throw new Error("Tokyo Night must not mutate host TUI methods");
    },
  });
}

describe("Pi public compatibility contract", () => {
  it("accepts 0.79.0 and newer supported versions without selecting an implementation", () => {
    expect(evaluatePiCompatibility("0.79.0")).toMatchObject({
      minimum: "0.79.0",
      supported: true,
    });
    expect(evaluatePiCompatibility("0.84.3").supported).toBe(true);
    expect(evaluatePiCompatibility("0.78.9").supported).toBe(false);
  });

  it("directly requests redraw through a raw public TUI-like object", () => {
    const requestRender = vi.fn();
    requestHostRender({ requestRender });
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("does not recurse and follows a renderer switch through the dynamic proxy", () => {
    const regular = { requestRender: vi.fn() };
    const fullscreen = { requestRender: vi.fn() };
    let current: Pick<TUI, "requestRender"> = regular;
    const proxy = createDynamicTuiProxy(() => current);

    expect(() => requestHostRender(proxy)).not.toThrow();
    current = fullscreen;
    expect(() => requestHostRender(proxy, true)).not.toThrow();

    expect(regular.requestRender).toHaveBeenCalledWith();
    expect(fullscreen.requestRender).toHaveBeenCalledWith(true);
  });

  it("rejects host method mutation", () => {
    const target = createDynamicTuiProxy(() => ({ requestRender: vi.fn() }));
    expect(() => Reflect.set(target, "requestRender", vi.fn())).toThrow(
      "must not mutate",
    );
  });
});
