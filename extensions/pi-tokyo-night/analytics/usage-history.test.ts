import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readUsageHistory,
  summarizeUsageHistory,
  type UsageHistory,
} from "./usage-history";

function localDate(
  year: number,
  month: number,
  day: number,
  hour = 12,
): number {
  return new Date(year, month, day, hour).getTime();
}

describe("summarizeUsageHistory", () => {
  it("groups the last three natural days into daily totals and model distribution", () => {
    const now = new Date(2026, 2, 10, 15);
    const history: UsageHistory = {
      records: [
        { timestamp: localDate(2026, 2, 8), provider: "openai", model: "gpt", tokens: 120 },
        { timestamp: localDate(2026, 2, 9), provider: "anthropic", model: "claude", tokens: 50 },
        { timestamp: localDate(2026, 2, 10), provider: "openai", model: "gpt", tokens: 30 },
        { timestamp: localDate(2026, 2, 7), provider: "openai", model: "gpt", tokens: 999 },
      ],
    };

    const summary = summarizeUsageHistory(history, 3, now);

    expect(summary.totalTokens).toBe(200);
    expect(summary.daily.map((day) => day.tokens)).toEqual([120, 50, 30]);
    expect(summary.models).toEqual([
      { provider: "openai", model: "gpt", tokens: 150, dailyTokens: [120, 0, 30] },
      { provider: "anthropic", model: "claude", tokens: 50, dailyTokens: [0, 50, 0] },
    ]);
  });

  it("builds an all-conversations daily window from the first valid record through today", () => {
    const now = new Date(2026, 2, 10, 15);
    const history: UsageHistory = {
      records: [
        { timestamp: localDate(2026, 2, 1), provider: "openai", model: "gpt", tokens: 10 },
        { timestamp: localDate(2026, 2, 10), provider: "anthropic", model: "claude", tokens: 20 },
        { timestamp: localDate(2026, 2, 11), provider: "openai", model: "future", tokens: 99 },
      ],
    };

    const summary = summarizeUsageHistory(history, "all", now);

    expect(summary.totalTokens).toBe(30);
    expect(summary.daily).toHaveLength(10);
    expect(summary.daily[0]?.tokens).toBe(10);
    expect(summary.daily.at(-1)?.tokens).toBe(20);
    expect(summary.models.map((model) => model.model)).toEqual(["claude", "gpt"]);
  });

  it("backfills direct assistant usage from nested Pi session files", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const now = new Date(2026, 2, 10, 15);
    try {
      await mkdir(join(sessionsDirectory, "parent", "run-0"), { recursive: true });
      await writeFile(
        join(sessionsDirectory, "parent", "session.jsonl"),
        [
          JSON.stringify({
            type: "message",
            id: "assistant-a",
            timestamp: "2026-03-10T08:00:00.000Z",
            message: {
              role: "assistant",
              timestamp: localDate(2026, 2, 10, 8),
              provider: "openai",
              model: "gpt",
              usage: { input: 10, output: 5, cacheRead: 500, cacheWrite: 2 },
            },
          }),
          JSON.stringify({
            type: "message",
            id: "tool-a",
            message: {
              role: "toolResult",
              usage: { input: 100, output: 100, cacheWrite: 100 },
            },
          }),
        ].join("\n") + "\n",
      );
      await writeFile(
        join(sessionsDirectory, "parent", "run-0", "session.jsonl"),
        JSON.stringify({
          type: "message",
          id: "assistant-b",
          timestamp: "2026-03-09T08:00:00.000Z",
          message: {
            role: "assistant",
            timestamp: localDate(2026, 2, 9, 8),
            provider: "anthropic",
            model: "claude",
            usage: { input: 20, output: 8, cacheWrite: 1 },
          },
        }) + "\n",
      );

      const history = await readUsageHistory({ sessionsDirectory, now });
      const summary = summarizeUsageHistory(history!, 3, now);

      expect(history?.collectedAt).toBe(now.getTime());
      expect(summary.totalTokens).toBe(46);
      expect(summary.models).toEqual([
        { provider: "anthropic", model: "claude", tokens: 29, dailyTokens: [0, 29, 0] },
        { provider: "openai", model: "gpt", tokens: 17, dailyTokens: [0, 0, 17] },
      ]);
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("retains all historical records so the All range is not source-limited to 30 days", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const now = new Date(2026, 2, 10, 15);
    try {
      await writeFile(
        join(sessionsDirectory, "old-session.jsonl"),
        JSON.stringify({
          type: "message",
          id: "old-assistant",
          message: {
            role: "assistant",
            timestamp: localDate(2025, 0, 1, 8),
            provider: "openai",
            model: "gpt",
            usage: { input: 10, output: 5 },
          },
        }) + "\n",
      );

      const history = await readUsageHistory({ sessionsDirectory, now, cachePath: null });

      expect(history?.records).toEqual([
        { timestamp: localDate(2025, 0, 1, 8), provider: "openai", model: "gpt", tokens: 15 },
      ]);
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("writes a metadata-only cache without prompt content", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const sessionFile = join(sessionsDirectory, "session.jsonl");
    const cachePath = join(sessionsDirectory, "usage-cache.json");
    const now = new Date(2026, 2, 10, 15);
    const sessionEntry = (input: number) => JSON.stringify({
      type: "message",
      id: "cached-assistant",
      message: {
        role: "assistant",
        timestamp: localDate(2026, 2, 10, 8),
        provider: "openai",
        model: "gpt",
        content: "secret-prompt-body",
        usage: { input, output: 5 },
      },
    }) + "\n";
    try {
      await writeFile(sessionFile, sessionEntry(10));
      const first = await readUsageHistory({ sessionsDirectory, now, cachePath });
      const second = await readUsageHistory({ sessionsDirectory, now, cachePath });
      const cachedPayload = await readFile(cachePath, "utf8");

      expect(first?.records[0]?.tokens).toBe(15);
      expect(second?.records[0]?.tokens).toBe(15);
      expect(cachedPayload).not.toContain("secret-prompt-body");
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("reparses a session when its size or mtime fingerprint changes", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const sessionFile = join(sessionsDirectory, "session.jsonl");
    const cachePath = join(sessionsDirectory, "usage-cache.json");
    const now = new Date(2026, 2, 10, 15);
    const sessionEntry = (input: number) => JSON.stringify({
      type: "message",
      id: "changed-assistant",
      message: {
        role: "assistant",
        timestamp: localDate(2026, 2, 10, 8),
        provider: "openai",
        model: "gpt",
        usage: { input, output: 5 },
      },
    }) + "\n";
    try {
      await writeFile(sessionFile, sessionEntry(10));
      const first = await readUsageHistory({ sessionsDirectory, now, cachePath });
      const original = await stat(sessionFile);
      await writeFile(sessionFile, sessionEntry(20));
      await utimes(sessionFile, original.atimeMs / 1000 + 2, original.mtimeMs / 1000 + 2);

      const second = await readUsageHistory({ sessionsDirectory, now, cachePath });

      expect(first?.records[0]?.tokens).toBe(15);
      expect(second?.records[0]?.tokens).toBe(25);
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("retains a large assistant entry when role appears after content", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const now = new Date(2026, 2, 10, 15);
    try {
      await writeFile(
        join(sessionsDirectory, "large-assistant.jsonl"),
        JSON.stringify({
          type: "message",
          id: "large-assistant",
          message: {
            content: "x".repeat(70 * 1024),
            role: "assistant",
            timestamp: localDate(2026, 2, 10, 8),
            provider: "openai",
            model: "gpt",
            usage: { input: 10, output: 5 },
          },
        }) + "\n",
      );

      const history = await readUsageHistory({ sessionsDirectory, now, cachePath: null });

      expect(history?.records).toEqual([
        { timestamp: localDate(2026, 2, 10, 8), provider: "openai", model: "gpt", tokens: 15 },
      ]);
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("does not parse oversized tool output with a nested assistant-role decoy", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const now = new Date(2026, 2, 10, 15);
    const parse = vi.spyOn(JSON, "parse");
    try {
      await writeFile(
        join(sessionsDirectory, "large-tool-output.jsonl"),
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              metadata: { role: "assistant" },
              content: "x".repeat(70 * 1024),
            },
          }),
          JSON.stringify({
            type: "message",
            id: "assistant-after-tool",
            message: {
              role: "assistant",
              timestamp: localDate(2026, 2, 10, 8),
              provider: "openai",
              model: "gpt",
              usage: { input: 10, output: 5 },
            },
          }),
        ].join("\n") + "\n",
      );

      const history = await readUsageHistory({ sessionsDirectory, now, cachePath: null });

      expect(summarizeUsageHistory(history!, 3, now).totalTokens).toBe(15);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("includes valid in-range usage even when a copied session has an old mtime", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const now = new Date(2026, 2, 10, 15);
    const sessionFile = join(sessionsDirectory, "old-session.jsonl");
    try {
      await writeFile(
        sessionFile,
        JSON.stringify({
          type: "message",
          id: "old-file",
          message: {
            role: "assistant",
            timestamp: localDate(2026, 2, 10, 8),
            provider: "openai",
            model: "gpt",
            usage: { input: 10, output: 5 },
          },
        }) + "\n",
      );
      const old = new Date(now);
      old.setDate(old.getDate() - 30);
      await utimes(sessionFile, old, old);

      const history = await readUsageHistory({ sessionsDirectory, now });

      expect(history?.records).toEqual([
        { timestamp: localDate(2026, 2, 10, 8), provider: "openai", model: "gpt", tokens: 15 },
      ]);
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("ignores usage records without a safe provider and model attribution", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const now = new Date(2026, 2, 10, 15);
    try {
      await writeFile(
        join(sessionsDirectory, "session.jsonl"),
        [
          JSON.stringify({
            type: "message",
            id: "unsafe-model",
            message: {
              role: "assistant",
              timestamp: localDate(2026, 2, 10, 8),
              provider: "openai\u001b[2J",
              model: "gpt",
              usage: { input: 10, output: 5 },
            },
          }),
          JSON.stringify({
            type: "message",
            id: "safe-model",
            message: {
              role: "assistant",
              timestamp: localDate(2026, 2, 10, 9),
              provider: "openai",
              model: "gpt",
              usage: { input: 10, output: 5 },
            },
          }),
        ].join("\n") + "\n",
      );

      const history = await readUsageHistory({ sessionsDirectory, now });

      expect(history?.records).toEqual([
        { timestamp: localDate(2026, 2, 10, 9), provider: "openai", model: "gpt", tokens: 15 },
      ]);
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("keeps separate id-less assistant records with the same display fingerprint", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const now = new Date(2026, 2, 10, 15);
    try {
      await writeFile(
        join(sessionsDirectory, "imported.jsonl"),
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              timestamp: localDate(2026, 2, 10, 8),
              provider: "openai",
              model: "gpt",
              usage: { input: 10, output: 5 },
            },
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              timestamp: localDate(2026, 2, 10, 8),
              provider: "openai",
              model: "gpt",
              usage: { input: 5, output: 10 },
            },
          }),
        ].join("\n") + "\n",
      );

      const history = await readUsageHistory({ sessionsDirectory, now });

      expect(summarizeUsageHistory(history!, 3, now).totalTokens).toBe(30);
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("returns no history when cancellation is already requested", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        readUsageHistory({ sessionsDirectory, signal: controller.signal }),
      ).resolves.toBeNull();
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });

  it("reports an unreadable session root instead of presenting empty history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const sessionsPath = join(directory, "not-a-directory");
    try {
      await writeFile(sessionsPath, "not a session directory");

      await expect(readUsageHistory({ sessionsDirectory: sessionsPath })).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not double count an assistant entry copied into a forked session", async () => {
    const sessionsDirectory = await mkdtemp(join(tmpdir(), "tokyo-usage-"));
    const now = new Date(2026, 2, 10, 15);
    const originalEntry = JSON.stringify({
      type: "message",
      id: "shared-assistant-entry",
      timestamp: "2026-03-10T08:00:00.000Z",
      message: {
        role: "assistant",
        timestamp: localDate(2026, 2, 10, 8),
        provider: "openai",
        model: "gpt",
        usage: { input: 10, output: 5, cacheWrite: 2 },
      },
    }) + "\n";
    const forkedCopy = JSON.stringify({
      type: "message",
      id: "shared-assistant-entry",
      timestamp: "2026-03-10T09:00:00.000Z",
      message: {
        role: "assistant",
        timestamp: localDate(2026, 2, 10, 9),
        provider: "openai",
        model: "gpt",
        usage: { input: 10, output: 5, cacheWrite: 2 },
      },
    }) + "\n";
    try {
      await mkdir(join(sessionsDirectory, "fork"), { recursive: true });
      await writeFile(join(sessionsDirectory, "original.jsonl"), originalEntry);
      await writeFile(join(sessionsDirectory, "fork", "copy.jsonl"), forkedCopy);

      const history = await readUsageHistory({ sessionsDirectory, now });

      expect(summarizeUsageHistory(history!, 3, now).totalTokens).toBe(17);
    } finally {
      await rm(sessionsDirectory, { recursive: true, force: true });
    }
  });
});
