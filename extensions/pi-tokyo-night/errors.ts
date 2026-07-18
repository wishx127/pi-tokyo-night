/** Unified log prefix for all extension error messages. */
export const EXT_PREFIX = "[pi-tokyo-night]";

/** Check whether an error is caused by a stale extension context.
 *  Pi marks contexts as stale after session switch/reload; calling methods on
 *  a stale context throws. We detect this and degrade gracefully. */
export function isStaleExtensionContextError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("This extension instance is stale") ||
    err.message.includes("This extension ctx is stale")
  );
}

/** Unified error handler for extension operations. Stale context errors are
 *  silently ignored (expected during shutdown); all other errors are logged
 *  with the standard prefix. */
export function handleExtensionError(err: unknown, context: string): void {
  if (isStaleExtensionContextError(err)) return;
  console.error(`${EXT_PREFIX} ${context}:`, err);
}
