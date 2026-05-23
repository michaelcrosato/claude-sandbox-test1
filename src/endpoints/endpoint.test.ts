import { describe, expect, it } from "vitest";
import {
  applyEndpointUpdate,
  createEndpointId,
  endpointSubscribesTo,
  normalizeNewEndpoint,
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
});
