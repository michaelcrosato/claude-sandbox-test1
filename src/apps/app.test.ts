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
  normalizeNewApp,
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
  it("defaults an absent or omitted name to empty string", () => {
    expect(normalizeNewApp()).toEqual({ name: "" });
    expect(normalizeNewApp({})).toEqual({ name: "" });
  });

  it("keeps a provided name and rejects a non-string", () => {
    expect(normalizeNewApp({ name: "Acme" })).toEqual({ name: "Acme" });
    // @ts-expect-error — name must be a string
    expect(() => normalizeNewApp({ name: 1 })).toThrow(TypeError);
  });
});

describe("applyAppUpdate", () => {
  const base: App = {
    id: "app_1",
    name: "before",
    createdAt: 1000,
    updatedAt: 1000,
  };

  it("patches name, advances updatedAt, preserves id/createdAt", () => {
    const next = applyAppUpdate(base, { name: "after" }, 2000);
    expect(next).toEqual({
      id: "app_1",
      name: "after",
      createdAt: 1000,
      updatedAt: 2000,
    });
  });

  it("leaves name unchanged when the patch omits it", () => {
    const next = applyAppUpdate(base, {}, 2000);
    expect(next.name).toBe("before");
    expect(next.updatedAt).toBe(2000);
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
