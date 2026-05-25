/**
 * Per-surface HTTP security-response headers — the pure policy core for the
 * defense-in-depth headers stamped onto every response at the socket edge.
 *
 * Posthorn serves three kinds of response over one port: machine API/Prometheus
 * (JSON + text), the admin/tenant **dashboards** (operator HTML, must never be
 * framed), and the consumer **portal** (HTML that is *designed* to be embedded in
 * a customer's app via an iframe). A single blanket policy can't fit all three —
 * a `X-Frame-Options: DENY` that protects the dashboards would break the portal's
 * core embedding use case. So the policy is a pure function of the request path,
 * mirroring how {@link matchRoute} keeps routing a pure decision and the
 * `node:http` adapter stays a thin I/O shell.
 *
 * Why these directives are safe to lock down this hard: every HTML view in this
 * repo is server-rendered with **zero** `<script>` tags (the consumer-portal XSS
 * fix removed the last inline `<script>`), no external scripts/styles/fonts/images,
 * and same-origin `<form action>` targets only — its sole dynamic content is inline
 * `<style>` blocks and `style=` attributes. So `default-src 'none'` with just
 * `style-src 'unsafe-inline'` + `form-action 'self'` renders every page intact
 * while making a reflected/stored-XSS payload non-executable by construction
 * (a second layer behind output escaping). JSON/text API responses carry no markup,
 * so they need only `nosniff` (kill MIME-sniffing) + a no-referrer policy.
 */

/** The response surfaces, distinguished only by URL prefix. */
export type ResponseSurface = "portal" | "dashboard" | "api";

/**
 * Content-Security-Policy fragments shared by both HTML surfaces. Kept as named
 * constants so the dashboard and portal policies can't silently drift apart in
 * the part that *must* stay identical (the resource lockdown).
 *
 * `default-src 'none'` denies every fetch directive that isn't re-granted below
 * (scripts, images, fonts, connects, frames, objects). `script-src 'none'` is
 * redundant with that fallback but stated explicitly so the no-JS contract is
 * legible at the header. `style-src 'unsafe-inline'` is the one concession the
 * server-rendered HTML actually needs. `form-action 'self'` confines every form
 * POST to this origin (an injected `<form action="https://evil">` can't exfiltrate)
 * and `base-uri 'none'` blocks a `<base>`-tag hijack of those relative actions.
 */
const HTML_CSP_RESOURCE_POLICY =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

/**
 * Dashboard CSP: the shared resource lockdown plus `frame-ancestors 'none'`, the
 * modern anti-clickjacking control. The admin and tenant dashboards are operator
 * surfaces that should never be embedded anywhere.
 */
const DASHBOARD_CSP = `${HTML_CSP_RESOURCE_POLICY}; frame-ancestors 'none'`;

/**
 * Portal CSP: the shared resource lockdown **without** any `frame-ancestors`
 * directive. The consumer portal is meant to be iframed into a tenant's own app,
 * so framing is left open by design (and, correspondingly, no `X-Frame-Options`
 * is emitted for portal paths).
 */
const PORTAL_CSP = HTML_CSP_RESOURCE_POLICY;

/** Headers applied to *every* response regardless of surface. */
const UNIVERSAL_HEADERS: Readonly<Record<string, string>> = {
  // Stop browsers from MIME-sniffing a response into a more dangerous type
  // (e.g. treating a JSON/text body as HTML or a script).
  "x-content-type-options": "nosniff",
  // Don't leak the (often id-bearing) request URL via the Referer header on any
  // navigation or sub-request originating from our responses.
  "referrer-policy": "no-referrer",
};

/**
 * Classify a request pathname into its security surface. Purely prefix-based: the
 * URL space defines the posture, independent of whether the matching handler is
 * actually wired — a 404 served under `/dashboard/*` (dashboard disabled) still
 * carries anti-framing headers, and a 404 under `/portal/*` still stays frameable.
 * `/dashboard/tenant*` and `/dashboard*` deliberately collapse to one policy.
 */
export function surfaceForPath(path: string): ResponseSurface {
  if (path === "/portal" || path.startsWith("/portal/")) {
    return "portal";
  }
  if (path === "/dashboard" || path.startsWith("/dashboard/")) {
    return "dashboard";
  }
  return "api";
}

/**
 * The complete set of security headers to stamp on a response for the given
 * request path. Always includes {@link UNIVERSAL_HEADERS}; the HTML surfaces add a
 * Content-Security-Policy, and the dashboards additionally send the legacy
 * `X-Frame-Options: DENY` as a backstop for clients predating `frame-ancestors`.
 * Returns a fresh object each call (safe for the caller to spread/mutate).
 */
export function securityHeadersForPath(path: string): Record<string, string> {
  const surface = surfaceForPath(path);
  if (surface === "dashboard") {
    return {
      ...UNIVERSAL_HEADERS,
      "content-security-policy": DASHBOARD_CSP,
      "x-frame-options": "DENY",
    };
  }
  if (surface === "portal") {
    return {
      ...UNIVERSAL_HEADERS,
      "content-security-policy": PORTAL_CSP,
    };
  }
  return { ...UNIVERSAL_HEADERS };
}
