import { describe, expect, it } from "vitest";
import {
  activeSigningSecrets,
  applyEndpointUpdate,
  createEndpointId,
  DEFAULT_AUTO_DISABLE_AFTER_MS,
  DEFAULT_SECRET_ROTATION_OVERLAP_MS,
  endpointSubscribesTo,
  evaluateEndpointHealth,
  MAX_CUSTOM_HEADERS,
  MAX_NON_RETRYABLE_STATUSES,
  MAX_PREVIOUS_SECRETS,
  normalizeHeaders,
  normalizeNewEndpoint,
  normalizeRetryPolicy,
  rotateEndpointSecret,
  UnknownEndpointError,
  type Endpoint,
} from "./endpoint.js";

describe("createEndpointId", () => {
  it("is ep_-prefixed and effectively unique", () => {
    const a = createEndpointId();
    const b = createEndpointId();
    expect(a.startsWith("ep_")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("endpointSubscribesTo", () => {
  it("matches everything when the filter is null (subscribe-to-all)", () => {
    expect(endpointSubscribesTo({ eventTypes: null }, "anything")).toBe(true);
  });

  it("matches only listed types for an explicit filter", () => {
    const ep = { eventTypes: ["user.created", "user.updated"] };
    expect(endpointSubscribesTo(ep, "user.created")).toBe(true);
    expect(endpointSubscribesTo(ep, "user.deleted")).toBe(false);
  });

  it("matches nothing for an empty filter", () => {
    expect(endpointSubscribesTo({ eventTypes: [] }, "user.created")).toBe(false);
  });
});

describe("UnknownEndpointError", () => {
  it("carries the id and a stable name", () => {
    const err = new UnknownEndpointError("ep_42");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnknownEndpointError");
    expect(err.endpointId).toBe("ep_42");
  });
});

describe("normalizeNewEndpoint", () => {
  it("signals an omitted secret with null and applies defaults", () => {
    const n = normalizeNewEndpoint({ appId: "app_1", url: "https://x.test/h" });
    expect(n.secret).toBeNull();
    expect(n.description).toBe("");
    expect(n.eventTypes).toBeNull();
    expect(n.disabled).toBe(false);
    expect(n.headers).toBeNull();
  });

  it("rejects a disabled flag that is not a boolean", () => {
    expect(() =>
      // @ts-expect-error — disabled must be a boolean
      normalizeNewEndpoint({ appId: "a", url: "https://x.test/h", disabled: "yes" }),
    ).toThrow(TypeError);
  });
});

describe("normalizeRetryPolicy — nonRetryableStatuses", () => {
  it("returns null for null/undefined input (use system default)", () => {
    expect(normalizeRetryPolicy(null)).toBeNull();
    expect(normalizeRetryPolicy(undefined)).toBeNull();
  });

  it("preserves nonRetryableStatuses when provided", () => {
    const p = normalizeRetryPolicy({ delaysMs: [1000], nonRetryableStatuses: [400, 401] });
    expect(p?.nonRetryableStatuses).toEqual([400, 401]);
  });

  it("omits nonRetryableStatuses when absent", () => {
    const p = normalizeRetryPolicy({ delaysMs: [1000] });
    expect(p?.nonRetryableStatuses).toBeUndefined();
  });

  it("deduplicates nonRetryableStatuses, order-preserving", () => {
    const p = normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: [410, 400, 410] });
    expect(p?.nonRetryableStatuses).toEqual([410, 400]);
  });

  it("normalizes an empty nonRetryableStatuses array to undefined", () => {
    const p = normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: [] });
    expect(p?.nonRetryableStatuses).toBeUndefined();
  });

  it(`rejects more than MAX_NON_RETRYABLE_STATUSES (${MAX_NON_RETRYABLE_STATUSES}) entries`, () => {
    const tooMany = Array.from({ length: MAX_NON_RETRYABLE_STATUSES + 1 }, (_, i) => 400 + i);
    expect(() =>
      normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: tooMany }),
    ).toThrow(TypeError);
  });

  it("rejects non-integer entries in nonRetryableStatuses", () => {
    expect(() =>
      normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: [400.5] }),
    ).toThrow(TypeError);
    expect(() =>
      normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: ["400"] }),
    ).toThrow(TypeError);
  });

  it("rejects status codes outside the 100–599 range", () => {
    expect(() =>
      normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: [99] }),
    ).toThrow(TypeError);
    expect(() =>
      normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: [600] }),
    ).toThrow(TypeError);
  });

  it("accepts boundary status codes 100 and 599", () => {
    const p = normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: [100, 599] });
    expect(p?.nonRetryableStatuses).toEqual([100, 599]);
  });

  it("rejects a non-array nonRetryableStatuses", () => {
    expect(() =>
      normalizeRetryPolicy({ delaysMs: [], nonRetryableStatuses: 400 }),
    ).toThrow(TypeError);
  });
});

describe("normalizeHeaders", () => {
  it("returns null for undefined, null, and empty object", () => {
    expect(normalizeHeaders(undefined)).toBeNull();
    expect(normalizeHeaders(null)).toBeNull();
    expect(normalizeHeaders({})).toBeNull();
  });

  it("round-trips a valid header map", () => {
    const out = normalizeHeaders({ "X-API-Key": "secret", "X-Tenant-ID": "t1" });
    expect(out).toEqual({ "X-API-Key": "secret", "X-Tenant-ID": "t1" });
  });

  it("rejects non-object input", () => {
    expect(() => normalizeHeaders("X-Foo: bar")).toThrow(TypeError);
    expect(() => normalizeHeaders(["X-Foo", "bar"])).toThrow(TypeError);
    expect(() => normalizeHeaders(42)).toThrow(TypeError);
  });

  it("rejects reserved (Standard Webhooks + content-type) header names (case-insensitive)", () => {
    expect(() => normalizeHeaders({ "webhook-id": "x" })).toThrow(TypeError);
    expect(() => normalizeHeaders({ "Webhook-Timestamp": "x" })).toThrow(TypeError);
    expect(() => normalizeHeaders({ "WEBHOOK-SIGNATURE": "x" })).toThrow(TypeError);
    expect(() => normalizeHeaders({ "content-type": "application/json" })).toThrow(TypeError);
    expect(() => normalizeHeaders({ "Content-Type": "text/plain" })).toThrow(TypeError);
  });

  it("rejects headers that contain CR or LF (injection prevention)", () => {
    expect(() => normalizeHeaders({ "X-Foo\r": "bar" })).toThrow(TypeError);
    expect(() => normalizeHeaders({ "X-Foo": "bar\nbaz" })).toThrow(TypeError);
  });

  it("rejects non-string values", () => {
    expect(() => normalizeHeaders({ "X-Num": 42 })).toThrow(TypeError);
  });

  it(`rejects maps with more than MAX_CUSTOM_HEADERS (${MAX_CUSTOM_HEADERS}) entries`, () => {
    const big: Record<string, string> = {};
    for (let i = 0; i <= MAX_CUSTOM_HEADERS; i++) big[`X-H-${i}`] = `v${i}`;
    expect(() => normalizeHeaders(big)).toThrow(TypeError);
  });
});

describe("applyEndpointUpdate", () => {
  const base: Endpoint = {
    id: "ep_1",
    appId: "app_1",
    url: "https://x.test/a",
    secret: "whsec_a",
    previousSecrets: [],
    description: "d",
    eventTypes: ["a"],
    headers: null,
    retryPolicy: null,
    disabled: false,
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };

  it("preserves identity + createdAt, advances updatedAt, leaves unpatched fields", () => {
    const next = applyEndpointUpdate(base, { disabled: true }, 5_000);
    expect(next.id).toBe("ep_1");
    expect(next.appId).toBe("app_1");
    expect(next.createdAt).toBe(1_000);
    expect(next.updatedAt).toBe(5_000);
    expect(next.disabled).toBe(true);
    expect(next.url).toBe(base.url);
    expect(next.secret).toBe(base.secret);
    expect(next.eventTypes).toEqual(["a"]);
  });

  it("validates patched fields the same way create does", () => {
    expect(() => applyEndpointUpdate(base, { url: "ftp://nope" }, 2_000)).toThrow(
      TypeError,
    );
  });

  it("carries previousSecrets through untouched (a direct secret patch is a hard swap)", () => {
    const withRetired: Endpoint = {
      ...base,
      previousSecrets: [{ secret: "whsec_old", expiresAt: 9_000 }],
    };
    // A normal patch preserves the rotation retirees…
    expect(
      applyEndpointUpdate(withRetired, { disabled: true }, 2_000).previousSecrets,
    ).toEqual([{ secret: "whsec_old", expiresAt: 9_000 }]);
    // …and so does a direct secret hard-swap (rotation overlap is rotateSecret's job).
    const swapped = applyEndpointUpdate(withRetired, { secret: "whsec_hard" }, 2_000);
    expect(swapped.secret).toBe("whsec_hard");
    expect(swapped.previousSecrets).toEqual([{ secret: "whsec_old", expiresAt: 9_000 }]);
  });

  it("clears the failure streak when a disabled endpoint is re-enabled", () => {
    const unhealthy: Endpoint = {
      ...base,
      disabled: true,
      consecutiveFailures: 7,
      firstFailureAt: 100,
      lastFailureAt: 800,
    };
    const reEnabled = applyEndpointUpdate(unhealthy, { disabled: false }, 2_000);
    expect(reEnabled.disabled).toBe(false);
    expect(reEnabled.consecutiveFailures).toBe(0);
    expect(reEnabled.firstFailureAt).toBeNull();
    expect(reEnabled.lastFailureAt).toBeNull();
  });

  it("preserves health on an unrelated patch (no re-enable)", () => {
    const unhealthy: Endpoint = {
      ...base,
      consecutiveFailures: 3,
      firstFailureAt: 100,
      lastFailureAt: 800,
    };
    const patched = applyEndpointUpdate(unhealthy, { description: "x" }, 2_000);
    expect(patched.consecutiveFailures).toBe(3);
    expect(patched.firstFailureAt).toBe(100);
    expect(patched.lastFailureAt).toBe(800);
  });

  it("sets, replaces, and clears custom headers", () => {
    const withHeaders = applyEndpointUpdate(base, { headers: { "X-Foo": "bar" } }, 2_000);
    expect(withHeaders.headers).toEqual({ "X-Foo": "bar" });
    const replaced = applyEndpointUpdate(withHeaders, { headers: { "X-Baz": "qux" } }, 3_000);
    expect(replaced.headers).toEqual({ "X-Baz": "qux" });
    const cleared = applyEndpointUpdate(replaced, { headers: null }, 4_000);
    expect(cleared.headers).toBeNull();
  });

  it("preserves headers when headers is not in the patch", () => {
    const withHeaders: Endpoint = { ...base, headers: { "X-Keep": "me" } };
    const patched = applyEndpointUpdate(withHeaders, { description: "x" }, 2_000);
    expect(patched.headers).toEqual({ "X-Keep": "me" });
  });
});

describe("evaluateEndpointHealth", () => {
  const healthy: Endpoint = {
    id: "ep_1",
    appId: "app_1",
    url: "https://x.test/a",
    secret: "whsec_a",
    previousSecrets: [],
    description: "",
    eventTypes: null,
    headers: null,
    retryPolicy: null,
    disabled: false,
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };

  it("treats a success on a healthy endpoint as a no-op (no write, same reference)", () => {
    const r = evaluateEndpointHealth(healthy, "succeeded", 5_000);
    expect(r.changed).toBe(false);
    expect(r.autoDisabled).toBe(false);
    expect(r.endpoint).toBe(healthy); // unchanged reference → backend skips persist
  });

  it("a single failure opens the streak but never disables", () => {
    const r = evaluateEndpointHealth(healthy, "failed", 5_000, 100_000);
    expect(r.changed).toBe(true);
    expect(r.autoDisabled).toBe(false);
    expect(r.endpoint.consecutiveFailures).toBe(1);
    expect(r.endpoint.firstFailureAt).toBe(5_000);
    expect(r.endpoint.lastFailureAt).toBe(5_000);
    expect(r.endpoint.disabled).toBe(false);
    expect(r.endpoint.updatedAt).toBe(5_000);
  });

  it("a success after failures resets the streak (and advances updatedAt)", () => {
    const failing: Endpoint = {
      ...healthy,
      consecutiveFailures: 4,
      firstFailureAt: 1_000,
      lastFailureAt: 4_000,
    };
    const r = evaluateEndpointHealth(failing, "succeeded", 9_000);
    expect(r.changed).toBe(true);
    expect(r.endpoint.consecutiveFailures).toBe(0);
    expect(r.endpoint.firstFailureAt).toBeNull();
    expect(r.endpoint.lastFailureAt).toBeNull();
    expect(r.endpoint.updatedAt).toBe(9_000);
  });

  it("auto-disables once the streak has lasted at least the window", () => {
    const opened = evaluateEndpointHealth(healthy, "failed", 1_000, 100_000);
    expect(opened.endpoint.disabled).toBe(false);
    // A later failure, once first→now spans the window, flips disabled.
    const tripped = evaluateEndpointHealth(opened.endpoint, "failed", 1_000 + 100_000, 100_000);
    expect(tripped.autoDisabled).toBe(true);
    expect(tripped.endpoint.disabled).toBe(true);
    expect(tripped.endpoint.consecutiveFailures).toBe(2);
  });

  it("a window of 0 disables auto-disabling but still tracks failures", () => {
    const opened = evaluateEndpointHealth(healthy, "failed", 1_000, 0);
    const later = evaluateEndpointHealth(opened.endpoint, "failed", 1_000 + 10 * 86_400_000, 0);
    expect(later.autoDisabled).toBe(false);
    expect(later.endpoint.disabled).toBe(false);
    expect(later.endpoint.consecutiveFailures).toBe(2);
  });

  it("never re-flips an already-disabled endpoint (autoDisabled is false), but keeps counting", () => {
    const disabled: Endpoint = {
      ...healthy,
      disabled: true,
      consecutiveFailures: 9,
      firstFailureAt: 0,
      lastFailureAt: 9_000,
    };
    const r = evaluateEndpointHealth(disabled, "failed", 1_000_000, 1);
    expect(r.autoDisabled).toBe(false); // it was already disabled
    expect(r.endpoint.disabled).toBe(true);
    expect(r.endpoint.consecutiveFailures).toBe(10);
  });

  it("defaults the window to DEFAULT_AUTO_DISABLE_AFTER_MS", () => {
    const opened = evaluateEndpointHealth(healthy, "failed", 0);
    // Just under the default window → still enabled.
    const justUnder = evaluateEndpointHealth(opened.endpoint, "failed", DEFAULT_AUTO_DISABLE_AFTER_MS - 1);
    expect(justUnder.endpoint.disabled).toBe(false);
    // At the default window → disabled.
    const at = evaluateEndpointHealth(opened.endpoint, "failed", DEFAULT_AUTO_DISABLE_AFTER_MS);
    expect(at.endpoint.disabled).toBe(true);
  });

  it("rejects non-finite inputs", () => {
    expect(() => evaluateEndpointHealth(healthy, "failed", Number.NaN)).toThrow(TypeError);
    expect(() => evaluateEndpointHealth(healthy, "failed", 1_000, -1)).toThrow(TypeError);
    expect(() => evaluateEndpointHealth(healthy, "failed", 1_000, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe("activeSigningSecrets", () => {
  const ep = (
    secret: string,
    previousSecrets: Endpoint["previousSecrets"],
  ): Pick<Endpoint, "secret" | "previousSecrets"> => ({ secret, previousSecrets });

  it("returns just the primary when there are no retired secrets", () => {
    expect(activeSigningSecrets(ep("whsec_a", []), 1_000)).toEqual(["whsec_a"]);
  });

  it("includes still-active retirees (primary first) and drops expired ones", () => {
    const e = ep("whsec_new", [
      { secret: "whsec_active", expiresAt: 2_000 },
      { secret: "whsec_expired", expiresAt: 1_000 },
    ]);
    // At t=1500: active is in window (2000 > 1500); expired is out (1000 <= 1500).
    expect(activeSigningSecrets(e, 1_500)).toEqual(["whsec_new", "whsec_active"]);
    // At t=2500: both retirees are past their expiry — only the primary remains.
    expect(activeSigningSecrets(e, 2_500)).toEqual(["whsec_new"]);
  });

  it("treats expiresAt as exclusive (a secret stops at exactly its expiry)", () => {
    const e = ep("whsec_new", [{ secret: "whsec_x", expiresAt: 2_000 }]);
    expect(activeSigningSecrets(e, 1_999)).toEqual(["whsec_new", "whsec_x"]);
    expect(activeSigningSecrets(e, 2_000)).toEqual(["whsec_new"]);
  });
});

describe("rotateEndpointSecret", () => {
  const base: Endpoint = {
    id: "ep_1",
    appId: "app_1",
    url: "https://x.test/a",
    secret: "whsec_v1",
    previousSecrets: [],
    description: "",
    eventTypes: null,
    headers: null,
    retryPolicy: null,
    disabled: false,
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };

  it("installs the new primary, retires the old with the default overlap, bumps updatedAt", () => {
    const next = rotateEndpointSecret(base, "whsec_v2", 5_000);
    expect(next.secret).toBe("whsec_v2");
    expect(next.previousSecrets).toEqual([
      { secret: "whsec_v1", expiresAt: 5_000 + DEFAULT_SECRET_ROTATION_OVERLAP_MS },
    ]);
    expect(next.updatedAt).toBe(5_000);
    // Identity + the rest are preserved.
    expect(next.id).toBe("ep_1");
    expect(next.createdAt).toBe(1_000);
    // During the overlap, both sign; after it, only the new one does.
    expect(activeSigningSecrets(next, 6_000)).toEqual(["whsec_v2", "whsec_v1"]);
    expect(
      activeSigningSecrets(next, 5_000 + DEFAULT_SECRET_ROTATION_OVERLAP_MS + 1),
    ).toEqual(["whsec_v2"]);
  });

  it("retires nothing when overlapMs is 0 (an instant hard swap)", () => {
    const next = rotateEndpointSecret(base, "whsec_v2", 5_000, 0);
    expect(next.secret).toBe("whsec_v2");
    expect(next.previousSecrets).toEqual([]);
  });

  it("prunes already-expired retirees while retiring the current primary", () => {
    const withExpired: Endpoint = {
      ...base,
      secret: "whsec_v2",
      previousSecrets: [
        { secret: "whsec_v1", expiresAt: 4_000 }, // expired by t=5000
      ],
    };
    const next = rotateEndpointSecret(withExpired, "whsec_v3", 5_000, 1_000);
    // The expired v1 is dropped; v2 is retained with the new overlap.
    expect(next.previousSecrets).toEqual([{ secret: "whsec_v2", expiresAt: 6_000 }]);
  });

  it("keeps multiple non-expired retirees newest-first", () => {
    const after1 = rotateEndpointSecret(base, "whsec_v2", 5_000, 100_000);
    const after2 = rotateEndpointSecret(after1, "whsec_v3", 6_000, 100_000);
    expect(after2.secret).toBe("whsec_v3");
    expect(after2.previousSecrets).toEqual([
      { secret: "whsec_v2", expiresAt: 106_000 },
      { secret: "whsec_v1", expiresAt: 105_000 },
    ]);
  });

  it(`caps retained secrets at MAX_PREVIOUS_SECRETS (${MAX_PREVIOUS_SECRETS}), dropping the oldest`, () => {
    let ep = base;
    // Rotate well past the cap, all within one long overlap so none expire.
    for (let i = 2; i <= MAX_PREVIOUS_SECRETS + 4; i++) {
      ep = rotateEndpointSecret(ep, `whsec_v${i}`, 1_000 + i, 10_000_000);
    }
    expect(ep.previousSecrets).toHaveLength(MAX_PREVIOUS_SECRETS);
    // The newest retiree is the immediately-previous primary; the oldest survivors
    // were dropped, so the original v1 is gone.
    expect(ep.previousSecrets.map((s) => s.secret)).not.toContain("whsec_v1");
  });

  it("rejects a malformed secret or a negative/non-finite overlap (TypeError → 400)", () => {
    expect(() => rotateEndpointSecret(base, "", 5_000)).toThrow(TypeError);
    // @ts-expect-error — secret must be a string
    expect(() => rotateEndpointSecret(base, 123, 5_000)).toThrow(TypeError);
    expect(() => rotateEndpointSecret(base, "whsec_v2", 5_000, -1)).toThrow(TypeError);
    expect(() =>
      rotateEndpointSecret(base, "whsec_v2", 5_000, Number.POSITIVE_INFINITY),
    ).toThrow(TypeError);
  });
});
