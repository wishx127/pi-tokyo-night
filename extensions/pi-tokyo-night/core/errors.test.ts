import { describe, expect, it } from "vitest";
import { isStaleExtensionContextError } from "./errors";

describe("isStaleExtensionContextError", () => {
  it("recognizes the current Pi stale-context message", () => {
    expect(
      isStaleExtensionContextError(
        new Error("This extension ctx is stale after session replacement"),
      ),
    ).toBe(true);
  });

  it("keeps compatibility with the previous stale-context message", () => {
    expect(
      isStaleExtensionContextError(
        new Error("This extension instance is stale"),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated errors as stale", () => {
    expect(isStaleExtensionContextError(new Error("network failure"))).toBe(
      false,
    );
  });
});
