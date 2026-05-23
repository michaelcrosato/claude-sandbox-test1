import { describe, expect, it } from "vitest";
import {
  activeSigningSecrets,
  applyEndpointUpdate,
  createEndpointId,
  DEFAULT_SECRET_ROTATION_OVERLAP_MS,
  endpointSubscribesTo,
  MAX_PREVIOUS_SECRETS,
  normalizeNewEndpoint,
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
  });

  it("rejects a disabled flag that is not a boolean", () => {
    expect(() =>
      // @ts-expect-error — disabled must be a boolean
      normalizeNewEndpoint({ appId: "a", url: "https://x.test/h", disabled: "yes" }),
    ).toThrow(TypeError);
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
    disabled: false,
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
    disabled: false,
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
