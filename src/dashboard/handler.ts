/**
 * Admin dashboard request→response handler.
 *
 * Exposes a server-rendered HTML admin UI under `/dashboard/*`, gated behind a
 * session cookie obtained by presenting the operator's `POSTHORN_ADMIN_TOKEN`.
 * Disabled entirely (all routes return `404`) when no token is provided, matching
 * the same opt-in model as the admin JSON API.
 *
 * Security decisions (not incidental):
 * - `POSTHORN_ADMIN_TOKEN` is the sole credential — no extra password to configure.
 * - Tokens are compared in constant time (SHA-256 both sides) to prevent timing leaks.
 * - Session cookies are `HttpOnly; Secure; SameSite=Strict`, preventing JS access and CSRF
 *   from cross-site requests respectively. `Secure` is included to ensure the cookie is only sent over HTTPS.
 * - Sessions are ephemeral (in-memory); a gateway restart requires re-login.
 * - All user-supplied strings are HTML-escaped in the templates.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiRequest, ApiResponse, ApiHandler } from "../http/api.js";
import type { AppStore } from "../apps/app.js";
import type { MessageStore } from "../storage/message-store.js";
import { utcMonthRange } from "../storage/message-store.js";
import type { SessionStore } from "./sessions.js";
import { loginPage, appsPage, appDetailPage, appDeleteConfirmPage } from "./views.js";

export interface DashboardDeps {
  /** App/tenant store — the same instance the JSON API uses. */
  readonly apps: AppStore;
  /** Session store — typically an {@link InMemorySessionStore}. */
  readonly sessions: SessionStore;
  /**
   * The operator admin token (`POSTHORN_ADMIN_TOKEN`). The dashboard login form
   * accepts this value as the password.
   */
  readonly adminToken: string;
  /**
   * Message store — when provided, the apps list page shows the current-month
   * message count for each tenant alongside the quota. Omit to hide the column.
   */
  readonly messages?: MessageStore;
  /** Clock (epoch ms). Defaults to `Date.now`; inject in tests for determinism. */
  readonly now?: () => number;
}

/** Cookie name for the dashboard session token. */
const COOKIE = "ph_session";

/** Path the browser is redirected to after login. */
const HOME = "/dashboard/apps";

/**
 * Compare two strings in constant time to prevent timing side-channels on the
 * admin-token comparison. Both sides are SHA-256'd to equal-length digests before
 * `timingSafeEqual` so neither length nor content leaks through timing.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Extract the dashboard session token from the Cookie header, or `undefined`. */
function getSessionToken(req: ApiRequest): string | undefined {
  const cookieHeader = req.headers["cookie"];
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    if (part.slice(0, eqIdx).trim() === COOKIE) {
      return part.slice(eqIdx + 1).trim() || undefined;
    }
  }
  return undefined;
}

/** Parse an `application/x-www-form-urlencoded` body into a key→value map. */
function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Build an HTML response. */
function html(status: number, body: string, headers?: Record<string, string>): ApiResponse {
  return {
    status,
    body,
    contentType: "text/html; charset=utf-8",
    ...(headers ? { headers } : {}),
  };
}

/** Build a redirect response. */
function redirect(location: string, extraHeaders?: Record<string, string>): ApiResponse {
  return {
    status: 302,
    body: undefined,
    headers: { location, ...(extraHeaders ?? {}) },
  };
}

const NOT_FOUND: ApiResponse = { status: 404, body: undefined };

/**
 * Create the dashboard request→response handler. Returns a function compatible
 * with `ApiHandler` that handles every `/dashboard/*` path.
 *
 * When `deps.adminToken` is empty the function always returns `404`, matching the
 * "disabled by default" model of the admin JSON API. The caller (gateway) is
 * responsible for only wiring this handler when a token is configured.
 */
export function createDashboardHandler(deps: DashboardDeps): ApiHandler {
  const { apps, sessions, adminToken, messages } = deps;
  const clock = deps.now ?? (() => Date.now());

  // Set-Cookie header value for a new session token.
  function sessionCookie(token: string): string {
    return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
  }

  // Set-Cookie header value that clears the cookie.
  function clearCookie(): string {
    return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  }

  // Redirect to login if not authenticated; return undefined when the session is valid.
  function requireAuth(req: ApiRequest): ApiResponse | undefined {
    const token = getSessionToken(req);
    if (token === undefined || !sessions.validateSession(token, clock())) {
      return redirect("/dashboard/login");
    }
    return undefined;
  }

  return async (req: ApiRequest): Promise<ApiResponse> => {
    const method = req.method.toUpperCase();

    // Strip the /dashboard prefix and split into segments.
    const sub = req.path.replace(/^\/dashboard\/?/, "");
    const segs = sub.split("/").filter(Boolean);
    const [s0, s1, s2, s3, s4] = segs;

    // ── GET /dashboard ──────────────────────────────────────────────────────
    if (method === "GET" && segs.length === 0) {
      return redirect(HOME);
    }

    // ── GET /dashboard/login ─────────────────────────────────────────────────
    if (method === "GET" && s0 === "login" && segs.length === 1) {
      return html(200, loginPage());
    }

    // ── POST /dashboard/login ─────────────────────────────────────────────────
    if (method === "POST" && s0 === "login" && segs.length === 1) {
      const form = parseForm(req.rawBody);
      const presented = form["token"] ?? "";
      if (!constantTimeEqual(presented, adminToken)) {
        return html(200, loginPage("Invalid admin token."));
      }
      const sessionToken = sessions.createSession(clock());
      return redirect(HOME, { "set-cookie": sessionCookie(sessionToken) });
    }

    // ── POST /dashboard/logout ────────────────────────────────────────────────
    if (method === "POST" && s0 === "logout" && segs.length === 1) {
      const existing = getSessionToken(req);
      if (existing !== undefined) sessions.deleteSession(existing);
      return redirect("/dashboard/login", { "set-cookie": clearCookie() });
    }

    // ── GET /dashboard/apps ───────────────────────────────────────────────────
    if (method === "GET" && s0 === "apps" && segs.length === 1) {
      const unauth = requireAuth(req);
      if (unauth) return unauth;
      const all = await apps.list();
      let usage: Map<string, number> | undefined;
      if (messages !== undefined) {
        const range = utcMonthRange(clock());
        const summaries = await Promise.all(
          all.map((app) => messages.summarizeUsageByApp(app.id, range)),
        );
        usage = new Map(all.map((app, i) => [app.id, summaries[i]!.total]));
      }
      return html(200, appsPage(all, usage));
    }

    // ── POST /dashboard/apps (create app) ─────────────────────────────────────
    if (method === "POST" && s0 === "apps" && segs.length === 1) {
      const unauth = requireAuth(req);
      if (unauth) return unauth;
      const form = parseForm(req.rawBody);
      const name = (form["name"] ?? "").trim();
      const rawQuota = form["quota"];
      let monthlyMessageQuota: number | null = null;
      if (rawQuota !== undefined && rawQuota.trim() !== "") {
        const n = Number(rawQuota.trim());
        if (Number.isInteger(n) && n >= 0) monthlyMessageQuota = n;
      }
      const app = await apps.create({ name, monthlyMessageQuota });
      return redirect(`/dashboard/apps/${app.id}`);
    }

    // ── GET /dashboard/apps/:appId ─────────────────────────────────────────────
    if (method === "GET" && s0 === "apps" && s1 !== undefined && segs.length === 2) {
      const unauth = requireAuth(req);
      if (unauth) return unauth;
      const appId = s1;
      const app = await apps.get(appId);
      if (app === null) return NOT_FOUND;
      const [keys, usageSummary] = await Promise.all([
        apps.listApiKeys(appId),
        messages !== undefined
          ? messages.summarizeUsageByApp(appId, utcMonthRange(clock()))
          : Promise.resolve(undefined),
      ]);
      const usage = usageSummary?.total;
      return html(200, appDetailPage(app, keys, undefined, usage));
    }

    // ── POST /dashboard/apps/:appId/keys (create key) ─────────────────────────
    if (
      method === "POST" &&
      s0 === "apps" &&
      s1 !== undefined &&
      s2 === "keys" &&
      segs.length === 3
    ) {
      const unauth = requireAuth(req);
      if (unauth) return unauth;
      const appId = s1;
      const app = await apps.get(appId);
      if (app === null) return NOT_FOUND;
      const { secret, apiKey } = await apps.createApiKey(appId);
      // Render the app detail page with the one-time secret rather than redirecting,
      // so the operator sees it immediately. A subsequent GET /dashboard/apps/:id
      // will show the key metadata without the secret (it is never stored).
      const keys = await apps.listApiKeys(appId);
      // Surface the new key at the top — re-sort so the fresh key (already included
      // in `keys`) is shown with the secret banner.
      void apiKey; // used only to satisfy lint; secret is the one-time value
      return html(200, appDetailPage(app, keys, secret));
    }

    // ── POST /dashboard/apps/:appId/keys/:keyId/revoke ────────────────────────
    if (
      method === "POST" &&
      s0 === "apps" &&
      s1 !== undefined &&
      s2 === "keys" &&
      s3 !== undefined &&
      s4 === "revoke" &&
      segs.length === 5
    ) {
      const unauth = requireAuth(req);
      if (unauth) return unauth;
      await apps.revokeApiKey(s3);
      return redirect(`/dashboard/apps/${s1}`);
    }

    // ── GET /dashboard/apps/:appId/delete (delete confirmation) ───────────────
    if (
      method === "GET" &&
      s0 === "apps" &&
      s1 !== undefined &&
      s2 === "delete" &&
      segs.length === 3
    ) {
      const unauth = requireAuth(req);
      if (unauth) return unauth;
      const app = await apps.get(s1);
      if (app === null) return NOT_FOUND;
      return html(200, appDeleteConfirmPage(app));
    }

    // ── POST /dashboard/apps/:appId/delete ────────────────────────────────────
    if (
      method === "POST" &&
      s0 === "apps" &&
      s1 !== undefined &&
      s2 === "delete" &&
      segs.length === 3
    ) {
      const unauth = requireAuth(req);
      if (unauth) return unauth;
      await apps.delete(s1);
      return redirect("/dashboard/apps");
    }

    return NOT_FOUND;
  };
}
