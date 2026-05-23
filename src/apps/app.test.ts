/**
 * Unit tests for the pure, shared helpers in `app.ts`: id/secret generation, the
 * API-key hash (with a golden vector that pins the on-disk hash format across
 * versions — changing it would silently invalidate every stored key), the
 * display prefix, constant-time hash comparison, and create/update normalization.
 */

import { describe, expect, it } from "vitest";
import {
  API_KEY_SECRET_PREFIX,
  apiKeyHashesEqual,
  apiKeyPrefix,
  applyAppUpdate,
  createApiKeyId,
  createAppId,
  generateApiKeySecret,
  hashApiKey,
  isQuotaExceeded,
  quotaRemaining,
  normalizeNewApp,
  normalizeQuota,
  UnknownAppError,
  type App,
} from "./app.js";

describe("id and secret generators", () => {
  it("mints prefixed, unique, URL-safe app ids", () => {
    const a = createAppId();
    const b = createAppId();
    expect(a).toMatch(/^app_[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });

  it("mints prefixed, unique api-key ids", () => {
    const a = createApiKeyId();
    expect(a).toMatch(/^ak_[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(createApiKeyId());
  });

  it("mints high-entropy phk_ secrets", () => {
    const s = generateApiKeySecret();
    expect(s.startsWith(API_KEY_SECRET_PREFIX)).toBe(true);
    expect(s).not.toBe(generateApiKeySecret());
    // 32 bytes base64url ≈ 43 chars, plus the "phk_" prefix.
    expect(s.length).toBeGreaterThan(40);
  });
});

describe("hashApiKey", () => {
  it("matches a known SHA-256 golden vector (hex, lowercase)", () => {
    expect(hashApiKey("phk_test_secret")).toBe(
      "e931d8c47de5cffa3074e625811b77396d3cf0fe2b9771ee8ad35d4b8badf94d",
    );
    expect(hashApiKey("phk_test_1")).toBe(
      "16689eaf12f47250f55b79d2ef8a87be47d5803cf6d7c463486bc82c4ab70e6a",
    );
  });

  it("is deterministic and 64 hex chars wide", () => {
    expect(hashApiKey("x")).toBe(hashApiKey("x"));
    expect(hashApiKey("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("apiKeyPrefix", () => {
  it("returns the first 12 chars (the non-secret display prefix)", () => {
    expect(apiKeyPrefix("phk_abcdefghijklmnop")).toBe("phk_abcdefgh");
  });

  it("returns the whole string when shorter than the prefix length", () => {
    expect(apiKeyPrefix("phk_x")).toBe("phk_x");
  });
});

describe("apiKeyHashesEqual", () => {
  it("is true for identical hex hashes and false for different ones", () => {
    const h = hashApiKey("phk_test_1");
    expect(apiKeyHashesEqual(h, h)).toBe(true);
    expect(apiKeyHashesEqual(h, hashApiKey("phk_test_2"))).toBe(false);
  });

  it("is false for malformed or unequal-length input", () => {
    expect(apiKeyHashesEqual("", "")).toBe(false);
    expect(apiKeyHashesEqual("ab", "abcd")).toBe(false);
  });
});

describe("normalizeNewApp", () => {
  it("defaults an absent or omitted name to empty string and quota to null", () => {
    expect(normalizeNewApp()).toEqual({ name: "", monthlyMessageQuota: null });
    expect(normalizeNewApp({})).toEqual({ name: "", monthlyMessageQuota: null });
  });

  it("keeps a provided name and rejects a non-string", () => {
    expect(normalizeNewApp({ name: "Acme" })).toEqual({
      name: "Acme",
      monthlyMessageQuota: null,
    });
    // @ts-expect-error — name must be a string
    expect(() => normalizeNewApp({ name: 1 })).toThrow(TypeError);
  });

  it("carries a provided monthly quota through", () => {
    expect(normalizeNewApp({ monthlyMessageQuota: 1000 })).toEqual({
      name: "",
      monthlyMessageQuota: 1000,
    });
  });
});

describe("normalizeQuota", () => {
  it("collapses absent and null to null (no limit)", () => {
    expect(normalizeQuota(undefined)).toBeNull();
    expect(normalizeQuota(null)).toBeNull();
  });

  it("keeps a non-negative integer, including 0 (a suspended tenant)", () => {
    expect(normalizeQuota(0)).toBe(0);
    expect(normalizeQuota(1000)).toBe(1000);
  });

  it("rejects a negative, fractional, or non-number quota", () => {
    expect(() => normalizeQuota(-1)).toThrow(TypeError);
    expect(() => normalizeQuota(1.5)).toThrow(TypeError);
    expect(() => normalizeQuota("100")).toThrow(TypeError);
    expect(() => normalizeQuota(Number.NaN)).toThrow(TypeError);
  });
});

describe("isQuotaExceeded", () => {
  it("is never exceeded for a null quota (no limit)", () => {
    expect(isQuotaExceeded(0, null)).toBe(false);
    expect(isQuotaExceeded(1_000_000, null)).toBe(false);
  });

  it("is false below the quota and true at or above it (the next message is rejected)", () => {
    expect(isQuotaExceeded(0, 2)).toBe(false);
    expect(isQuotaExceeded(1, 2)).toBe(false);
    // Usage equal to the quota means it is spent — the next send is the one blocked.
    expect(isQuotaExceeded(2, 2)).toBe(true);
    expect(isQuotaExceeded(3, 2)).toBe(true);
  });

  it("blocks every send for a quota of 0", () => {
    expect(isQuotaExceeded(0, 0)).toBe(true);
  });
});

describe("quotaRemaining", () => {
  it("is null (unbounded) for a null quota", () => {
    expect(quotaRemaining(0, null)).toBeNull();
    expect(quotaRemaining(1_000_000, null)).toBeNull();
  });

  it("is the headroom below the quota", () => {
    expect(quotaRemaining(0, 10)).toBe(10);
    expect(quotaRemaining(3, 10)).toBe(7);
    expect(quotaRemaining(10, 10)).toBe(0);
  });

  it("floors at 0 on a soft-limit overshoot (never negative)", () => {
    expect(quotaRemaining(12, 10)).toBe(0);
  });

  it("is 0 for a quota of 0 (a suspended tenant)", () => {
    expect(quotaRemaining(0, 0)).toBe(0);
  });
});

describe("applyAppUpdate", () => {
  const base: App = {
    id: "app_1",
    name: "before",
    monthlyMessageQuota: null,
    createdAt: 1000,
    updatedAt: 1000,
  };

  it("patches name, advances updatedAt, preserves id/createdAt", () => {
    const next = applyAppUpdate(base, { name: "after" }, 2000);
    expect(next).toEqual({
      id: "app_1",
      name: "after",
      monthlyMessageQuota: null,
      createdAt: 1000,
      updatedAt: 2000,
    });
  });

  it("leaves name unchanged when the patch omits it", () => {
    const next = applyAppUpdate(base, {}, 2000);
    expect(next.name).toBe("before");
    expect(next.updatedAt).toBe(2000);
  });

  it("sets, then clears, the monthly quota while leaving the other fields intact", () => {
    const capped = applyAppUpdate(base, { monthlyMessageQuota: 500 }, 2000);
    expect(capped.monthlyMessageQuota).toBe(500);
    expect(capped.name).toBe("before");

    // A name-only patch leaves the quota untouched…
    const renamed = applyAppUpdate(capped, { name: "after" }, 3000);
    expect(renamed.monthlyMessageQuota).toBe(500);

    // …and null removes the limit again.
    const lifted = applyAppUpdate(renamed, { monthlyMessageQuota: null }, 4000);
    expect(lifted.monthlyMessageQuota).toBeNull();
  });

  it("rejects a negative or non-integer quota patch", () => {
    expect(() => applyAppUpdate(base, { monthlyMessageQuota: -1 }, 2000)).toThrow(TypeError);
    expect(() => applyAppUpdate(base, { monthlyMessageQuota: 2.5 }, 2000)).toThrow(TypeError);
  });
});

describe("UnknownAppError", () => {
  it("carries the offending app id", () => {
    const err = new UnknownAppError("app_x");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnknownAppError");
    expect(err.appId).toBe("app_x");
  });
});
