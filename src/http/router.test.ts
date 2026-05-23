import { describe, expect, it } from "vitest";
import {
  defineRoutes,
  matchRoute,
  toSegments,
  type Route,
} from "./router.js";

/** A tiny route table covering literal, parameterized, and overlapping paths. */
function routes(): readonly Route<string>[] {
  return defineRoutes<string>([
    { method: "GET", pattern: "/healthz", handler: "health" },
    { method: "POST", pattern: "/v1/messages", handler: "createMessage" },
    { method: "GET", pattern: "/v1/endpoints", handler: "listEndpoints" },
    { method: "POST", pattern: "/v1/endpoints", handler: "createEndpoint" },
    { method: "GET", pattern: "/v1/endpoints/:id", handler: "getEndpoint" },
    { method: "DELETE", pattern: "/v1/endpoints/:id", handler: "deleteEndpoint" },
  ]);
}

describe("toSegments", () => {
  it("ignores leading and trailing slashes", () => {
    expect(toSegments("/")).toEqual([]);
    expect(toSegments("/v1/endpoints")).toEqual(["v1", "endpoints"]);
    expect(toSegments("/v1/endpoints/")).toEqual(["v1", "endpoints"]);
    expect(toSegments("//v1//endpoints//")).toEqual(["v1", "endpoints"]);
  });
});

describe("matchRoute", () => {
  it("matches a literal path and method", () => {
    const result = matchRoute(routes(), "GET", "/healthz");
    expect(result).toEqual({ kind: "matched", handler: "health", params: {} });
  });

  it("matches case-insensitively on method", () => {
    const result = matchRoute(routes(), "get", "/healthz");
    expect(result.kind).toBe("matched");
  });

  it("treats a trailing slash as the same path", () => {
    const result = matchRoute(routes(), "GET", "/v1/endpoints/");
    expect(result).toMatchObject({ kind: "matched", handler: "listEndpoints" });
  });

  it("captures a named parameter", () => {
    const result = matchRoute(routes(), "GET", "/v1/endpoints/ep_123");
    expect(result).toEqual({
      kind: "matched",
      handler: "getEndpoint",
      params: { id: "ep_123" },
    });
  });

  it("URL-decodes a captured parameter", () => {
    const result = matchRoute(routes(), "GET", "/v1/endpoints/ep%20x");
    expect(result).toMatchObject({ kind: "matched", params: { id: "ep x" } });
  });

  it("treats a malformed percent-encoding as not found", () => {
    const result = matchRoute(routes(), "GET", "/v1/endpoints/%zz");
    // The only route of that shape fails to decode, so nothing matches.
    expect(result.kind).toBe("notFound");
  });

  it("distinguishes the same path under different methods", () => {
    expect(matchRoute(routes(), "GET", "/v1/endpoints")).toMatchObject({
      handler: "listEndpoints",
    });
    expect(matchRoute(routes(), "POST", "/v1/endpoints")).toMatchObject({
      handler: "createEndpoint",
    });
  });

  it("reports methodNotAllowed (with the allowed set) for a known path, wrong method", () => {
    const result = matchRoute(routes(), "PUT", "/v1/endpoints/ep_1");
    expect(result.kind).toBe("methodNotAllowed");
    if (result.kind === "methodNotAllowed") {
      expect([...result.allow].sort()).toEqual(["DELETE", "GET"]);
    }
  });

  it("reports notFound for an unknown path", () => {
    expect(matchRoute(routes(), "GET", "/nope").kind).toBe("notFound");
    expect(matchRoute(routes(), "GET", "/v1/endpoints/ep_1/extra").kind).toBe(
      "notFound",
    );
  });

  it("does not match a parameter against an empty segment count", () => {
    // "/v1/endpoints" has 2 segments; ":id" route needs 3 — no false match.
    expect(matchRoute(routes(), "GET", "/v1/endpoints")).toMatchObject({
      handler: "listEndpoints",
    });
  });
});
