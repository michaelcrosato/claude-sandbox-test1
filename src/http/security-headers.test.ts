import { describe, expect, it } from "vitest";
import { securityHeadersForPath, surfaceForPath } from "./security-headers.js";

describe("surfaceForPath", () => {
  it("classifies portal paths (exact and nested)", () => {
    expect(surfaceForPath("/portal")).toBe("portal");
    expect(surfaceForPath("/portal/endpoints")).toBe("portal");
    expect(surfaceForPath("/portal/endpoints/abc/test")).toBe("portal");
  });

  it("classifies dashboard paths, including the tenant sub-tree", () => {
    expect(surfaceForPath("/dashboard")).toBe("dashboard");
    expect(surfaceForPath("/dashboard/apps")).toBe("dashboard");
    expect(surfaceForPath("/dashboard/tenant")).toBe("dashboard");
    expect(surfaceForPath("/dashboard/tenant/login")).toBe("dashboard");
  });

  it("treats everything else (API, health, metrics, root) as the api surface", () => {
    expect(surfaceForPath("/")).toBe("api");
    expect(surfaceForPath("/healthz")).toBe("api");
    expect(surfaceForPath("/metrics")).toBe("api");
    expect(surfaceForPath("/v1/endpoints")).toBe("api");
    expect(surfaceForPath("/openapi.json")).toBe("api");
  });

  it("does not let a prefix lookalike escape the api surface", () => {
    // A path that merely starts with the letters but isn't the segment must not
    // be misclassified into an HTML surface.
    expect(surfaceForPath("/portalish")).toBe("api");
    expect(surfaceForPath("/dashboards")).toBe("api");
    expect(surfaceForPath("/v1/portal")).toBe("api");
  });
});

describe("securityHeadersForPath", () => {
  it("stamps the universal headers on every surface", () => {
    for (const path of ["/v1/endpoints", "/dashboard", "/portal"]) {
      const h = securityHeadersForPath(path);
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["referrer-policy"]).toBe("no-referrer");
    }
  });

  it("gives the API surface no CSP and no framing controls (JSON/text carries no markup)", () => {
    const h = securityHeadersForPath("/v1/endpoints");
    expect(h["content-security-policy"]).toBeUndefined();
    expect(h["x-frame-options"]).toBeUndefined();
    expect(Object.keys(h).sort()).toEqual(["referrer-policy", "x-content-type-options"]);
  });

  it("leaves the API surface cacheable (it also serves public health/openapi/docs)", () => {
    // No `Cache-Control` on the API surface: the public health, /openapi.json, and
    // docs responses share this surface and benefit from being cacheable, and the
    // authenticated JSON is bearer-token (not a cookie back-button) risk.
    expect(securityHeadersForPath("/v1/endpoints")["cache-control"]).toBeUndefined();
    expect(securityHeadersForPath("/openapi.json")["cache-control"]).toBeUndefined();
    expect(securityHeadersForPath("/healthz")["cache-control"]).toBeUndefined();
  });

  it("locks the dashboard down, forbids framing, and forbids caching", () => {
    const h = securityHeadersForPath("/dashboard/apps");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["cache-control"]).toBe("no-store");
    const csp = h["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("applies the same dashboard policy to the tenant sub-tree", () => {
    expect(securityHeadersForPath("/dashboard/tenant")).toEqual(
      securityHeadersForPath("/dashboard"),
    );
  });

  it("locks the portal's resources down but keeps it embeddable", () => {
    const h = securityHeadersForPath("/portal/endpoints");
    // Embeddability is the portal's whole point: NO frame controls.
    expect(h["x-frame-options"]).toBeUndefined();
    // Authenticated tenant data still must not be cached, even though it's frameable.
    expect(h["cache-control"]).toBe("no-store");
    const csp = h["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("frame-ancestors");
  });

  it("returns a fresh, mutable object each call (safe to spread into other headers)", () => {
    const a = securityHeadersForPath("/portal");
    const b = securityHeadersForPath("/portal");
    expect(a).not.toBe(b);
    a["connection"] = "close";
    expect(b["connection"]).toBeUndefined();
  });
});
