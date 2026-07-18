import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildStatusLine } from "./status-bar";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const config = {
  get: () => ({ codexQuota: false }),
} as any;

function makeAssistant(input: number, output: number): unknown {
  return {
    type: "message",
    id: `${input}-${output}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      usage: { input, output, cost: { total: 1.25 } },
    } as AssistantMessage,
  };
}

function makeContext(
  branch: unknown[],
  getContextUsage?: () => unknown,
  sessionManagerOverride?: unknown,
): ExtensionContext {
  const sessionManager = sessionManagerOverride ?? {
    getBranch: () => branch,
    getLeafId: () => "leaf-1",
    getSessionId: () => "session-1",
  };
  return {
    sessionManager,
    getContextUsage,
    model: { id: "test-model", contextWindow: 1000 },
    cwd: "/workspace/project",
  } as unknown as ExtensionContext;
}

describe("buildStatusLine", () => {
  it("keeps cumulative tokens separate from current context usage", () => {
    const ctx = makeContext(
      [makeAssistant(1000, 500)],
      () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    );

    const line = buildStatusLine(500, theme, ctx, "", "high", config);

    expect(line).toContain("Σ 1.5k tokens");
    expect(line).toContain("10%/1.0k");
    expect(line).not.toContain("100%/1.0k");
  });

  it("falls back to cumulative usage when the context API is unavailable", () => {
    const ctx = makeContext([makeAssistant(1000, 0)]);

    const line = buildStatusLine(500, theme, ctx, "", "high", config);

    expect(line).toContain("100%/1.0k");
  });

  it("reuses stats for one leaf, invalidates on leaf changes, and isolates sessions", () => {
    const getBranch = vi.fn(() => [makeAssistant(10, 20)]);
    let leaf = "leaf-a";
    const manager = {
      getBranch,
      getLeafId: () => leaf,
      getSessionId: () => "session-a",
    };
    const ctx = makeContext([], undefined, manager);

    buildStatusLine(500, theme, ctx, "", "high", config);
    buildStatusLine(500, theme, ctx, "", "high", config);
    expect(getBranch).toHaveBeenCalledTimes(1);

    leaf = "leaf-b";
    getBranch.mockReturnValue([makeAssistant(200, 0)]);
    const changedLine = buildStatusLine(500, theme, ctx, "", "high", config);
    expect(getBranch).toHaveBeenCalledTimes(2);
    expect(changedLine).toContain("Σ 200 tokens");

    const otherBranch = vi.fn(() => [makeAssistant(3, 4)]);
    const otherCtx = makeContext([], undefined, {
      getBranch: otherBranch,
      getLeafId: () => "leaf-a",
      getSessionId: () => "session-a",
    });
    buildStatusLine(500, theme, otherCtx, "", "high", config);
    expect(otherBranch).toHaveBeenCalledTimes(1);
  });
});
