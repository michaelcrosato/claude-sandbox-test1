import { describe, expect, it } from "vitest";
import {
  hstsHeaderValue,
  isRequestSecure,
  securityHeadersForPath,
  surfaceForPath,
} from "./security-headers.js";

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

  it("omits Strict-Transport-Security by default (no hsts argument)", () => {
    for (const path of ["/v1/endpoints", "/dashboard", "/portal", "/healthz"]) {
      expect(securityHeadersForPath(path)["strict-transport-security"]).toBeUndefined();
    }
  });

  it("stamps a supplied HSTS value on every surface (transport-level, not content)", () => {
    const sts = "max-age=31536000; includeSubDomains";
    for (const path of ["/v1/endpoints", "/dashboard", "/portal", "/healthz", "/openapi.json"]) {
      expect(securityHeadersForPath(path, sts)["strict-transport-security"]).toBe(sts);
    }
  });

  it("treats null / empty-string hsts as disabled (no header)", () => {
    expect(securityHeadersForPath("/dashboard", null)["strict-transport-security"]).toBeUndefined();
    expect(securityHeadersForPath("/dashboard", "")["strict-transport-security"]).toBeUndefined();
  });

  it("leaves the other per-surface headers intact when HSTS is added", () => {
    const h = securityHeadersForPath("/dashboard/apps", "max-age=600");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["cache-control"]).toBe("no-store");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["strict-transport-security"]).toBe("max-age=600");
  });
});

describe("hstsHeaderValue", () => {
  it("returns null when disabled (max-age <= 0 or non-finite)", () => {
    const base = { includeSubDomains: false, preload: false };
    expect(hstsHeaderValue({ ...base, maxAgeSeconds: 0 })).toBeNull();
    expect(hstsHeaderValue({ ...base, maxAgeSeconds: -1 })).toBeNull();
    expect(hstsHeaderValue({ ...base, maxAgeSeconds: Number.NaN })).toBeNull();
    expect(hstsHeaderValue({ ...base, maxAgeSeconds: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("emits a bare max-age when no modifiers are set", () => {
    expect(
      hstsHeaderValue({ maxAgeSeconds: 31_536_000, includeSubDomains: false, preload: false }),
    ).toBe("max-age=31536000");
  });

  it("appends includeSubDomains, then preload, in the conventional order", () => {
    expect(
      hstsHeaderValue({ maxAgeSeconds: 63_072_000, includeSubDomains: true, preload: false }),
    ).toBe("max-age=63072000; includeSubDomains");
    expect(
      hstsHeaderValue({ maxAgeSeconds: 63_072_000, includeSubDomains: true, preload: true }),
    ).toBe("max-age=63072000; includeSubDomains; preload");
  });

  it("floors a fractional max-age to an integer", () => {
    expect(
      hstsHeaderValue({ maxAgeSeconds: 100.9, includeSubDomains: false, preload: false }),
    ).toBe("max-age=100");
  });
});

describe("isRequestSecure", () => {
  it("is secure on a direct TLS socket regardless of forwarded-proto", () => {
    expect(isRequestSecure({ encrypted: true, forwardedProto: undefined })).toBe(true);
    expect(isRequestSecure({ encrypted: true, forwardedProto: "http" })).toBe(true);
  });

  it("is secure when X-Forwarded-Proto is https (trimmed, case-insensitive)", () => {
    expect(isRequestSecure({ encrypted: false, forwardedProto: "https" })).toBe(true);
    expect(isRequestSecure({ encrypted: false, forwardedProto: "HTTPS" })).toBe(true);
    expect(isRequestSecure({ encrypted: false, forwardedProto: "  https  " })).toBe(true);
  });

  it("reads the leftmost token of a proxy-chain X-Forwarded-Proto list", () => {
    // The client-facing protocol is the first entry; a trailing internal hop must
    // not flip the verdict either way.
    expect(isRequestSecure({ encrypted: false, forwardedProto: "https, http" })).toBe(true);
    expect(isRequestSecure({ encrypted: false, forwardedProto: "http, https" })).toBe(false);
  });

  it("is insecure on plain HTTP with no, empty, or non-https forwarded-proto", () => {
    expect(isRequestSecure({ encrypted: false, forwardedProto: undefined })).toBe(false);
    expect(isRequestSecure({ encrypted: false, forwardedProto: "http" })).toBe(false);
    expect(isRequestSecure({ encrypted: false, forwardedProto: "" })).toBe(false);
    expect(isRequestSecure({ encrypted: false, forwardedProto: "ws" })).toBe(false);
  });
});
