import type { TUI } from "@earendil-works/pi-tui";

export type HostRenderTarget = Pick<TUI, "requestRender">;

/** Structural compatibility shape for Pi versions that expose a custom working indicator. */
interface WorkingIndicatorOptionsCompat {
  frames?: string[];
  intervalMs?: number;
}

type WorkingIndicatorSetter = (
  options?: WorkingIndicatorOptionsCompat,
) => void;

/** Optional fullscreen capability exposed by newer Pi TUI implementations. */
export type TuiModeProbe = {
  readonly mode?: string;
};

/** First published Pi release containing the agent_settled lifecycle event. */
export const MINIMUM_PI_VERSION = "0.80.5" as const;

export interface PiCompatibility {
  version: string;
  supported: boolean;
  minimum: typeof MINIMUM_PI_VERSION;
}

const MINIMUM_MAJOR = 0;
const MINIMUM_MINOR = 80;
const MINIMUM_PATCH = 5;

function parseVersion(version: string): [number, number, number] | null {
  const match = version.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function evaluatePiCompatibility(version: string): PiCompatibility {
  const parsed = parseVersion(version);
  const supported = parsed !== null && (
    parsed[0] > MINIMUM_MAJOR ||
    (parsed[0] === MINIMUM_MAJOR && (
      parsed[1] > MINIMUM_MINOR ||
      (parsed[1] === MINIMUM_MINOR && parsed[2] >= MINIMUM_PATCH)
    ))
  );
  return { version, supported, minimum: MINIMUM_PI_VERSION };
}

export function isFullscreenTui(target: TUI | TuiModeProbe): boolean {
  return "mode" in target && target.mode === "fullscreen";
}

export function resolveWorkingIndicatorSetter(
  target: unknown,
): WorkingIndicatorSetter | undefined {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function")
  ) {
    return undefined;
  }
  let setter: unknown;
  try {
    setter = Reflect.get(target, "setWorkingIndicator");
  } catch {
    return undefined;
  }
  if (typeof setter !== "function") return undefined;

  return (options?: WorkingIndicatorOptionsCompat): void => {
    Reflect.apply(setter, target, options === undefined ? [] : [options]);
  };
}

export function requestHostRender(
  target: HostRenderTarget | null,
  force = false,
): void {
  if (!target) return;
  if (force) {
    target.requestRender(true);
  } else {
    target.requestRender();
  }
}
