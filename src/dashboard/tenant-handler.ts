/**
 * Tenant dashboard request→response handler.
 *
 * Serves a browser UI at `/dashboard/tenant/*` that lets a tenant browse their
 * own webhook messages, per-endpoint delivery statuses, and per-attempt audit
 * logs. Authentication is via the tenant's existing API key — the same credential
 * used with the JSON API — presented once in a login form to obtain an `HttpOnly;
 * SameSite=Strict` session cookie. Every page query is scoped to the session's
 * `appId` (taken from the store at login, never from a URL parameter or body).
 *
 * This handler is always wired when the gateway runs — the dashboard is enabled
 * for every tenant with a valid API key, no extra config flag needed, since it
 * adds no new credential surface beyond what the JSON API already exposes.
 *
 * Security decisions (not incidental):
 * - Tenancy from the session, never from a URL param. A tenant's `appId` is
 *   resolved at login by `AppStore.authenticate` and stored in the session; every
 *   subsequent query uses that session-held `appId`, so a tenant cannot forge
 *   another tenant's data by crafting a URL.
 * - Cross-tenant resources return `404`, not `403` — same as the JSON API.
 * - Session cookies are `HttpOnly; Secure; SameSite=Strict`. No CSRF token needed.
 * - Session store is in-memory: a restart forces re-login (expected for a
 *   developer-debugging tool).
 */

import type { ApiRequest, ApiResponse, ApiHandler } from "../http/api.js";
import type { AppStore } from "../apps/app.js";
import type { EndpointStore } from "../endpoints/endpoint.js";
import type { MessageStore } from "../storage/message-store.js";
import { utcMonthRange } from "../storage/message-store.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import {
  MAX_LIST_ATTEMPTS_LIMIT,
  type DeliveryAttemptStore,
} from "../attempts/delivery-attempt.js";
import type { TenantSessionStore } from "./tenant-sessions.js";
import {
  tenantLoginPage,
  tenantMessagesPage,
  tenantMessageDetailPage,
  tenantEndpointsPage,
  type EnrichedDelivery,
  type UsageStats,
} from "./tenant-views.js";

export interface TenantDashboardDeps {
  readonly apps: AppStore;
  readonly endpoints: EndpointStore;
  readonly messages: MessageStore;
  readonly queue: DeliveryQueue;
  readonly attempts: DeliveryAttemptStore;
  readonly sessions: TenantSessionStore;
  /** Clock (epoch ms). Defaults to `Date.now`; inject in tests for determinism. */
  readonly now?: () => number;
}

/** Cookie name for the tenant dashboard session. Distinct from the admin `ph_session`. */
const COOKIE = "ph_tenant_session";

/** Default message page size. */
const DEFAULT_PAGE_LIMIT = 25;

/** Parse the dashboard session cookie from the request, or `undefined`. */
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
 * Create the tenant dashboard request→response handler. Returns a function
 * compatible with `ApiHandler` that handles every `/dashboard/tenant/*` path.
 */
export function createTenantDashboardHandler(deps: TenantDashboardDeps): ApiHandler {
  const { apps, endpoints, messages, queue, attempts, sessions } = deps;
  const clock = deps.now ?? (() => Date.now());

  function sessionCookie(token: string): string {
    return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
  }

  function clearCookie(): string {
    return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  }

  /**
   * Validate the session cookie on a request. Returns the `appId` when valid, or an
   * `ApiResponse` redirect-to-login when the session is absent or expired.
   */
  function requireAuth(req: ApiRequest): { appId: string } | ApiResponse {
    const token = getSessionToken(req);
    if (token === undefined) return redirect("/dashboard/tenant/login");
    const appId = sessions.validateSession(token, clock());
    if (appId === null) return redirect("/dashboard/tenant/login");
    return { appId };
  }

  return async (req: ApiRequest): Promise<ApiResponse> => {
    const method = req.method.toUpperCase();

    // Strip the /dashboard/tenant prefix and split into segments.
    const sub = req.path.replace(/^\/dashboard\/tenant\/?/, "");
    const segs = sub.split("/").filter(Boolean);
    const [s0, s1, s2] = segs;

    // ── GET /dashboard/tenant ────────────────────────────────────────────────
    if (method === "GET" && segs.length === 0) {
      return redirect("/dashboard/tenant/messages");
    }

    // ── GET /dashboard/tenant/login ──────────────────────────────────────────
    if (method === "GET" && s0 === "login" && segs.length === 1) {
      return html(200, tenantLoginPage());
    }

    // ── POST /dashboard/tenant/login ─────────────────────────────────────────
    if (method === "POST" && s0 === "login" && segs.length === 1) {
      const form = parseForm(req.rawBody);
      const key = (form["apikey"] ?? "").trim();
      if (key === "") {
        return html(200, tenantLoginPage("Please enter your API key."));
      }
      const app = await apps.authenticate(key);
      if (app === null) {
        return html(200, tenantLoginPage("Invalid API key."));
      }
      const sessionToken = sessions.createSession(app.id, clock());
      return redirect("/dashboard/tenant/messages", { "set-cookie": sessionCookie(sessionToken) });
    }

    // ── POST /dashboard/tenant/logout ────────────────────────────────────────
    if (method === "POST" && s0 === "logout" && segs.length === 1) {
      const existing = getSessionToken(req);
      if (existing !== undefined) sessions.deleteSession(existing);
      return redirect("/dashboard/tenant/login", { "set-cookie": clearCookie() });
    }

    // ── GET /dashboard/tenant/messages ───────────────────────────────────────
    if (method === "GET" && s0 === "messages" && segs.length === 1) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const { appId } = auth;

      const cursor = req.query["cursor"];
      const resolvedCursor = cursor !== undefined && cursor !== "" ? cursor : null;
      const nowMs = clock();
      const monthRange = utcMonthRange(nowMs);
      const [page, usageSummary, app] = await Promise.all([
        messages.listByApp(appId, { limit: DEFAULT_PAGE_LIMIT, cursor: resolvedCursor }),
        messages.summarizeUsageByApp(appId, monthRange),
        apps.get(appId),
      ]);
      const usageStats: UsageStats = {
        currentMonth: usageSummary.total,
        quota: app !== null ? app.monthlyMessageQuota : null,
        periodStart: new Date(monthRange.fromMs).toISOString().slice(0, 10),
        resetsAt: new Date(monthRange.toMs).toISOString().slice(0, 10),
      };
      return html(
        200,
        tenantMessagesPage(page.messages, page.nextCursor, cursor, usageStats),
      );
    }

    // ── GET /dashboard/tenant/messages/:id ──────────────────────────────────
    if (method === "GET" && s0 === "messages" && s1 !== undefined && s2 === undefined) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const { appId } = auth;

      const messageId = s1;
      const message = await messages.get(messageId);
      // Tenant-scope check: treat another tenant's message as absent (404).
      if (message === null || message.appId !== appId) return NOT_FOUND;

      const [tasks, attemptsPage] = await Promise.all([
        queue.listByMessage(messageId),
        // Use the maximum page size for the dashboard; a single message's attempt
        // log is bounded by (endpoints × retry_budget), well within 200.
        attempts.listByMessage(messageId, { limit: MAX_LIST_ATTEMPTS_LIMIT }),
      ]);
      const attemptLog = attemptsPage.data;

      // Enrich delivery tasks with endpoint URLs (best-effort: a deleted endpoint is null).
      const enriched: EnrichedDelivery[] = await Promise.all(
        tasks.map(async (task) => {
          if (task.endpointId === null) return { task, endpointUrl: null };
          const ep = await endpoints.get(task.endpointId);
          return { task, endpointUrl: ep !== null && ep.appId === appId ? ep.url : null };
        }),
      );

      return html(200, tenantMessageDetailPage(message, enriched, attemptLog));
    }

    // ── GET /dashboard/tenant/endpoints ─────────────────────────────────────
    if (method === "GET" && s0 === "endpoints" && segs.length === 1) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const { appId } = auth;

      const eps = await endpoints.listByApp(appId);
      return html(200, tenantEndpointsPage(eps));
    }

    return NOT_FOUND;
  };
}
