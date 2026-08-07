import type { TUI } from "@earendil-works/pi-tui";

export type HostRenderTarget = Pick<TUI, "requestRender">;

export interface PiCompatibility {
  version: string;
  supported: boolean;
  minimum: "0.79.0";
}

const MINIMUM_MAJOR = 0;
const MINIMUM_MINOR = 79;

function parseVersion(version: string): [number, number, number] | null {
  const match = version.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function evaluatePiCompatibility(version: string): PiCompatibility {
  const parsed = parseVersion(version);
  const supported = parsed !== null && (
    parsed[0] > MINIMUM_MAJOR ||
    (parsed[0] === MINIMUM_MAJOR && parsed[1] >= MINIMUM_MINOR)
  );
  return { version, supported, minimum: "0.79.0" };
}

export function isFullscreenTui(target: TUI): boolean {
  return (target as TUI & { readonly mode?: string }).mode === "fullscreen";
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
