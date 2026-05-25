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
 * repo is server-rendered with **zero** `<script>` tags and **no inline event
 * handlers** (`onclick`/`onsubmit`/…) — destructive-action confirmations are
 * server-rendered interstitial pages, not JS `confirm()`, *precisely so*
 * `script-src 'none'` can hold without silently disabling them — plus no external
 * scripts/styles/fonts/images and same-origin `<form action>` targets only; its
 * sole dynamic content is inline `<style>` blocks and `style=` attributes. So
 * `default-src 'none'` with just
 * `style-src 'unsafe-inline'` + `form-action 'self'` renders every page intact
 * while making a reflected/stored-XSS payload non-executable by construction
 * (a second layer behind output escaping). JSON/text API responses carry no markup,
 * so they need only `nosniff` (kill MIME-sniffing) + a no-referrer policy.
 *
 * Both HTML surfaces are also served behind a session cookie (operator dashboards)
 * or a portal session (consumer portal) and render tenant-scoped data, so they add
 * `Cache-Control: no-store` to keep that authenticated markup out of every cache —
 * the browser's disk/back-forward store and any shared proxy alike — closing the
 * "log out, press Back, see the prior tenant's data" leak on a shared machine. The
 * API surface is deliberately left cacheable: it also serves the *public* health,
 * `/openapi.json`, and docs responses, which benefit from being cached, and its
 * authenticated JSON is bearer-token (not cookie) driven and not a back-button risk.
 *
 * One header crosses every surface when enabled: `Strict-Transport-Security` (HSTS).
 * It is a transport assertion about the *whole origin* (force HTTPS for `max-age`
 * seconds), not about a given response's content, so — unlike CSP / X-Frame-Options —
 * it is stamped on the API surface too. It is **opt-in and off by default**
 * ({@link hstsHeaderValue} returns `null` until configured) because it is only
 * meaningful when the origin is actually reached over HTTPS and an over-long
 * `max-age` set before every host is TLS-ready can lock a domain out of plain HTTP
 * for that window. This service terminates TLS at an upstream proxy; the emitted
 * header reaches the browser over that HTTPS hop and is inert on a plain-HTTP probe.
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

/**
 * `Cache-Control` for the authenticated HTML surfaces (dashboards + portal).
 * `no-store` is the strongest directive — it forbids *any* cache (browser disk,
 * back/forward buffer, and shared proxies) from retaining the response — which is
 * the correct posture for cookie/session-scoped pages rendering tenant data. Shared
 * by both HTML surfaces so the cache posture can't drift between them.
 */
const HTML_CACHE_CONTROL = "no-store";

/**
 * HSTS (HTTP Strict Transport Security) policy. Disabled by default: HSTS is only
 * meaningful — and only safe — when the origin is actually reached over HTTPS, and
 * an over-long `max-age` set before every host/subdomain is TLS-ready can lock a
 * domain out of plain HTTP for that whole window. So it is an explicit opt-in: the
 * value is a transport assertion the operator makes deliberately. A `maxAgeSeconds`
 * of `0` (or negative) disables it — no header is emitted.
 */
export interface HstsPolicy {
  /** `max-age` in seconds. `0` (or negative) disables HSTS — no header is emitted. */
  readonly maxAgeSeconds: number;
  /** Append `; includeSubDomains` — extend the policy to every subdomain too. */
  readonly includeSubDomains: boolean;
  /** Append `; preload` — opt into the browser HSTS preload lists. */
  readonly preload: boolean;
}

/**
 * Build the `Strict-Transport-Security` header value for a policy, or `null` when
 * HSTS is disabled (`maxAgeSeconds <= 0`). Pure and total. Produces, e.g.,
 * `max-age=31536000; includeSubDomains; preload`. Directive order is the
 * conventional one — `max-age` first, then `includeSubDomains`, then `preload` —
 * which is also the order the preload-list submission rules expect.
 */
export function hstsHeaderValue(policy: HstsPolicy): string | null {
  if (!Number.isFinite(policy.maxAgeSeconds) || policy.maxAgeSeconds <= 0) {
    return null;
  }
  let value = `max-age=${Math.floor(policy.maxAgeSeconds)}`;
  if (policy.includeSubDomains) {
    value += "; includeSubDomains";
  }
  if (policy.preload) {
    value += "; preload";
  }
  return value;
}

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
 * Content-Security-Policy plus `Cache-Control: no-store` (authenticated, tenant-
 * scoped markup must not be cached), and the dashboards additionally send the legacy
 * `X-Frame-Options: DENY` as a backstop for clients predating `frame-ancestors`.
 *
 * `hsts` is the precomputed `Strict-Transport-Security` value (see
 * {@link hstsHeaderValue}); when a non-empty string is supplied it is added to
 * *every* surface, since HSTS governs the origin's transport rather than any one
 * response's content. Omit it (or pass `null`) to emit no HSTS header — the default.
 *
 * Returns a fresh object each call (safe for the caller to spread/mutate).
 */
export function securityHeadersForPath(
  path: string,
  hsts?: string | null,
): Record<string, string> {
  const surface = surfaceForPath(path);
  const headers: Record<string, string> =
    surface === "dashboard"
      ? {
          ...UNIVERSAL_HEADERS,
          "content-security-policy": DASHBOARD_CSP,
          "x-frame-options": "DENY",
          "cache-control": HTML_CACHE_CONTROL,
        }
      : surface === "portal"
        ? {
            ...UNIVERSAL_HEADERS,
            "content-security-policy": PORTAL_CSP,
            "cache-control": HTML_CACHE_CONTROL,
          }
        : { ...UNIVERSAL_HEADERS };
  if (hsts !== undefined && hsts !== null && hsts.length > 0) {
    headers["strict-transport-security"] = hsts;
  }
  return headers;
}
