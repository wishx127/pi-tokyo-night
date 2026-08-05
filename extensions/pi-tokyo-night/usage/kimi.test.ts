import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createKimiUsageStore,
  fetchKimiUsage,
  isKimiModel,
  parseKimiUsage,
  resolveKimiApiKey,
} from "./index";
import type { UsageSnapshot } from "./types";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/fake-agent",
}));

const NOW = new Date("2026-07-25T12:00:00Z");

function mockFs(files: Record<string, unknown>): void {
  const normalizedFiles = new Map(
    Object.entries(files).map(([file, value]) => [path.normalize(file), value]),
  );
  vi.spyOn(fs, "readFileSync").mockImplementation(((
    p: fs.PathOrFileDescriptor,
  ) => {
    const key = path.normalize(String(p));
    if (normalizedFiles.has(key)) return JSON.stringify(normalizedFiles.get(key));
    const err = new Error(`ENOENT: no such file: ${key}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }) as unknown as typeof fs.readFileSync);
}

describe("isKimiModel", () => {
  it("matches only the kimi-coding provider", () => {
    expect(isKimiModel(undefined)).toBe(false);
    expect(isKimiModel({ provider: "openai-codex" } as never)).toBe(false);
    expect(isKimiModel({ provider: "kimi-coding" } as never)).toBe(true);
  });
});

describe("parseKimiUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("parses the full API response with string-encoded numerics", () => {
    const snap = parseKimiUsage({
      limits: [
        {
          window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "100",
            used: "25",
            remaining: "75",
            resetTime: "2026-07-25T15:30:00Z",
          },
        },
      ],
      usage: {
        limit: "500",
        used: "100",
        remaining: "400",
        resetTime: "2026-08-01T12:00:00Z",
      },
    });

    expect(snap).toEqual({
      primary: { usedPercent: 25, windowMinutes: 300, resetsInSeconds: 12_600 },
      secondary: { usedPercent: 20, windowMinutes: 10_080, resetsInSeconds: 604_800 },
      capturedAt: NOW.getTime(),
    });
  });

  it("picks the shortest rolling window as primary", () => {
    const snap = parseKimiUsage({
      limits: [
        {
          window: { duration: "1", timeUnit: "TIME_UNIT_DAY" },
          detail: { limit: "200", used: "50", resetTime: "2026-07-26T12:00:00Z" },
        },
        {
          window: { duration: "5", timeUnit: "TIME_UNIT_HOUR" },
          detail: { limit: "100", used: "10", resetTime: "2026-07-25T13:00:00Z" },
        },
      ],
    });

    expect(snap?.primary?.windowMinutes).toBe(300);
    expect(snap?.secondary).toBeUndefined();
  });

  it("returns undefined for payloads without any usable window", () => {
    expect(parseKimiUsage(undefined)).toBeUndefined();
    expect(parseKimiUsage("nope")).toBeUndefined();
    expect(parseKimiUsage({})).toBeUndefined();
    expect(parseKimiUsage({ limits: [], usage: {} })).toBeUndefined();
  });

  it("skips malformed limit entries instead of failing the whole payload", () => {
    const valid = {
      window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "10", resetTime: "2026-07-25T13:00:00Z" },
    };
    const snap = parseKimiUsage({
      limits: [
        { window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "abc", used: "10", resetTime: "2026-07-25T13:00:00Z" } },
        { window: { duration: "300", timeUnit: "TIME_UNIT_UNKNOWN" }, detail: { limit: "100", used: "10", resetTime: "2026-07-25T13:00:00Z" } },
        { window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "0", used: "0", resetTime: "2026-07-25T13:00:00Z" } },
        { detail: { limit: "100", used: "10", resetTime: "2026-07-25T13:00:00Z" } },
        valid,
      ],
    });

    expect(snap?.primary?.windowMinutes).toBe(300);
  });

  it("returns undefined when every entry is malformed", () => {
    const snap = parseKimiUsage({
      limits: [
        { window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "abc", used: "10", resetTime: "2026-07-25T13:00:00Z" } },
        { window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "10" } },
      ],
    });

    expect(snap).toBeUndefined();
  });

  it("clamps usedPercent to 100 and a past resetTime to 0 seconds", () => {
    const snap = parseKimiUsage({
      usage: {
        limit: "100",
        used: "150",
        resetTime: "2026-07-25T11:00:00Z", // already in the past
      },
    });

    expect(snap?.secondary?.usedPercent).toBe(100);
    expect(snap?.secondary?.resetsInSeconds).toBe(0);
  });
});

describe("Kimi snapshot stores", () => {
  it("keeps snapshots isolated between stores", () => {
    const first = createKimiUsageStore();
    const second = createKimiUsageStore();
    const snap: UsageSnapshot = { capturedAt: 123 };

    expect(first.getSnapshot()).toBeUndefined();
    expect(second.getSnapshot()).toBeUndefined();

    first.setSnapshot(snap);

    expect(first.getSnapshot()).toBe(snap);
    expect(second.getSnapshot()).toBeUndefined();

    first.clearSnapshot();
    expect(first.getSnapshot()).toBeUndefined();
  });
});

describe("fetchKimiUsage", () => {
  const okPayload = {
    limits: [
      {
        window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "25", resetTime: "2026-07-25T15:30:00Z" },
      },
    ],
    usage: { limit: "500", used: "100", resetTime: "2026-08-01T12:00:00Z" },
  };

  function stubFetch(impl: () => Promise<Partial<Response>>): void {
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the usages endpoint with the bearer credential", async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(okPayload) }),
    );

    await fetchKimiUsage("test-key");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.kimi.com/coding/v1/usages",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });

  it("returns the parsed snapshot on success", async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(okPayload) }),
    );

    const result = await fetchKimiUsage("test-key");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.primary).toMatchObject({
        usedPercent: 25,
        windowMinutes: 300,
      });
      expect(result.snapshot.secondary).toMatchObject({
        usedPercent: 20,
        windowMinutes: 10_080,
      });
    }
  });

  it("reports network failures without throwing", async () => {
    stubFetch(() => Promise.reject(new Error("socket hang up")));

    const result = await fetchKimiUsage("test-key");

    expect(result).toEqual({ ok: false, error: "network: socket hang up" });
  });

  it("adds an auth hint to 401 responses", async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 401 }));

    const result = await fetchKimiUsage("test-key");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("401");
    if (!result.ok) expect(result.error).toContain("auth failed");
  });

  it("reports other HTTP errors without the auth hint", async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 500 }));

    const result = await fetchKimiUsage("test-key");

    expect(result).toEqual({ ok: false, error: "HTTP 500" });
  });

  it("rejects a non-JSON response body", async () => {
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("unexpected token")),
      }),
    );

    const result = await fetchKimiUsage("test-key");

    expect(result).toEqual({ ok: false, error: "invalid JSON response" });
  });

  it("rejects a well-formed response that carries no usage data", async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    );

    const result = await fetchKimiUsage("test-key");

    expect(result).toEqual({ ok: false, error: "no usage data in response" });
  });
});

describe("resolveKimiApiKey", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
  });

  it("prefers the ModelRegistry credential over file-based fallbacks", async () => {
    mockFs({ "/fake-agent/auth.json": { "kimi-coding": { key: "auth-key" } } });

    const key = await resolveKimiApiKey(() => Promise.resolve("registry-key"));

    expect(key).toBe("registry-key");
  });

  it("falls back to Pi's auth store when the registry lookup fails", async () => {
    mockFs({ "/fake-agent/auth.json": { "kimi-coding": { key: "auth-key" } } });

    const key = await resolveKimiApiKey(() => Promise.reject(new Error("unavailable")));

    expect(key).toBe("auth-key");
  });

  it("uses an unexpired OAuth access token from the auth store", async () => {
    mockFs({
      "/fake-agent/auth.json": {
        "kimi-coding": { access: "oauth-token", expires: Date.now() + 3_600_000 },
      },
    });

    const key = await resolveKimiApiKey();

    expect(key).toBe("oauth-token");
  });

  it("skips an expired auth-store token and falls through to the Kimi CLI store", async () => {
    process.env.HOME = "/fake-home";
    mockFs({
      "/fake-agent/auth.json": {
        "kimi-coding": { access: "expired-token", expires: Date.now() - 1_000 },
      },
      "/fake-home/.kimi/credentials/kimi-code.json": {
        access_token: "cli-token",
        expires_at: (Date.now() + 3_600_000) / 1000,
      },
    });

    const key = await resolveKimiApiKey();

    expect(key).toBe("cli-token");
  });

  it("returns undefined when no credential source yields a usable key", async () => {
    process.env.HOME = "/fake-home";
    mockFs({
      "/fake-agent/auth.json": {
        "kimi-coding": { access: "expired-token", expires: Date.now() - 1_000 },
      },
      "/fake-home/.kimi/credentials/kimi-code.json": {
        access_token: "stale-cli-token",
        expires_at: (Date.now() - 1_000) / 1000,
      },
    });

    const key = await resolveKimiApiKey(() => Promise.resolve(undefined));

    expect(key).toBeUndefined();
  });
});
