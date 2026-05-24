/**
 * Consumer App Portal request→response handler.
 *
 * Serves the customer-facing webhook management UI at `/portal/*`. A SaaS tenant
 * mints a portal session via `POST /v1/portal/sessions` (tenant API key auth) and
 * receives a short-lived token + a `portalUrl`. The customer is redirected to that
 * URL, which exchanges the token for an `HttpOnly` session cookie; every subsequent
 * request uses that cookie. The session is scoped to the tenant's `appId`, so every
 * portal query is automatically tenant-isolated without any additional scoping logic.
 *
 * Pages:
 *  GET  /portal/login?token=  — exchange token for cookie, redirect to /portal/endpoints
 *  GET  /portal/login         — expired / no-token page
 *  GET  /portal              — redirect to /portal/endpoints (or /portal/login)
 *  GET  /portal/endpoints     — list endpoints + create form
 *  POST /portal/endpoints     — create endpoint, show secret once on the same page
 *  GET  /portal/endpoints/:id — endpoint detail + edit + deliveries
 *  POST /portal/endpoints/:id/update        — update endpoint, reload detail
 *  POST /portal/endpoints/:id/rotate-secret — rotate signing secret (secret shown once)
 *  POST /portal/endpoints/:id/delete        — delete, redirect to /portal/endpoints
 *  POST /portal/logout        — clear session cookie
 *
 * Security decisions (not incidental):
 *  - Session cookie is `HttpOnly; SameSite=Strict`. No CSRF token needed.
 *  - `appId` comes from the session (resolved at token exchange), never a URL param.
 *  - Cross-tenant endpoints return `404` (existence never revealed).
 *  - The signing secret is shown exactly once (at endpoint creation and at rotation);
 *    it is never echoed by the detail page. This matches the JSON API behaviour.
 */

import { randomUUID } from "node:crypto";
import type { ApiRequest, ApiResponse, ApiHandler } from "../http/api.js";
import type { EndpointStore, NewEndpoint, EndpointUpdate } from "../endpoints/endpoint.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import type { PortalSessionStore } from "./portal-session.js";
import type { EventTypeStore } from "../event-types/event-type.js";
import { DeliveryStateError } from "../delivery/delivery-state.js";
import {
  buildSignedRequest,
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchTransport,
  isSuccessStatus,
  type Transport,
} from "../worker/delivery-worker.js";
import { endpointToDeliveryTarget } from "../endpoints/endpoint-resolver.js";
import {
  portalExpiredPage,
  portalEndpointsPage,
  portalEndpointDetailPage,
  portalDeliveryDetailPage,
  portalRotatedSecretPage,
  type DeliveryRow,
  type PortalTestResult,
} from "./portal-views.js";

export interface PortalDeps {
  readonly endpoints: EndpointStore;
  readonly queue: DeliveryQueue;
  readonly sessions: PortalSessionStore;
  readonly eventTypes?: EventTypeStore;
  /** Clock (epoch ms). Defaults to `Date.now`; inject in tests for determinism. */
  readonly now?: () => number;
  /**
   * HTTP transport for portal test deliveries. Defaults to {@link fetchTransport};
   * inject a fake in tests.
   */
  readonly transport?: Transport;
}

/** Cookie name for the portal session. Distinct from the admin and tenant dashboard cookies. */
const COOKIE = "ph_portal_session";

/** Number of recent deliveries to show on the endpoint detail page. */
const RECENT_DELIVERIES_LIMIT = 20;

/** Parse the portal session cookie, or `undefined`. */
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

/** Parse an `application/x-www-form-urlencoded` body. */
function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Parse an `application/x-www-form-urlencoded` body collecting all values per key. */
function parseFormAll(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of new URLSearchParams(body)) {
    const arr = out.get(k);
    if (arr !== undefined) arr.push(v);
    else out.set(k, [v]);
  }
  return out;
}

function html(status: number, bodyStr: string, headers?: Record<string, string>): ApiResponse {
  return {
    status,
    body: bodyStr,
    contentType: "text/html; charset=utf-8",
    ...(headers !== undefined ? { headers } : {}),
  };
}

function redirect(location: string, extraHeaders?: Record<string, string>): ApiResponse {
  return { status: 302, body: undefined, headers: { location, ...(extraHeaders ?? {}) } };
}

const NOT_FOUND: ApiResponse = { status: 404, body: undefined };

/** Parse a comma-separated event-types string into an array or null ("all events"). */
function parseEventTypes(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a headers textarea value into a plain object or null.
 * Accepts one `Header-Name: value` pair per line; empty lines and lines without
 * a `:` are skipped. Returns `null` when no valid pairs are found (semantically
 * equivalent to "no custom headers").
 */
function parseHeadersTextarea(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key.length > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function createPortalHandler(deps: PortalDeps): ApiHandler {
  const { endpoints, queue, sessions } = deps;
  const clock = deps.now ?? (() => Date.now());
  const eventTypesStore = deps.eventTypes;
  const send = deps.transport ?? fetchTransport;

  function sessionCookie(token: string): string {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/portal`;
  }

  function clearCookie(): string {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/portal; Max-Age=0`;
  }

  /** Validate the session cookie. Returns `{ appId }` when valid, or a redirect response. */
  function requireAuth(req: ApiRequest): { appId: string } | ApiResponse {
    const token = getSessionToken(req);
    if (token === undefined) return redirect("/portal/login");
    const session = sessions.getSession(token, clock());
    if (session === null) return redirect("/portal/login");
    return { appId: session.appId };
  }

  return async (req: ApiRequest): Promise<ApiResponse> => {
    const method = req.method.toUpperCase();
    const sub = req.path.replace(/^\/portal\/?/, "");
    const segs = sub.split("/").filter(Boolean);
    const [s0, s1, s2, s3, s4] = segs;

    // ── GET /portal ────────────────────────────────────────────────────────────
    if (method === "GET" && segs.length === 0) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      return redirect("/portal/endpoints");
    }

    // ── GET /portal/login ──────────────────────────────────────────────────────
    // Token exchange: a valid `?token=` sets the session cookie and redirects.
    // Without a valid token, show the "link expired" page (200 — not a user error).
    if (method === "GET" && s0 === "login" && segs.length === 1) {
      const rawToken = req.query["token"];
      if (rawToken === undefined || rawToken.length === 0) {
        return html(200, portalExpiredPage());
      }
      const session = sessions.getSession(rawToken, clock());
      if (session === null) {
        return html(200, portalExpiredPage());
      }
      return redirect("/portal/endpoints", { "set-cookie": sessionCookie(rawToken) });
    }

    // ── POST /portal/logout ────────────────────────────────────────────────────
    if (method === "POST" && s0 === "logout" && segs.length === 1) {
      const existing = getSessionToken(req);
      if (existing !== undefined) sessions.deleteSession(existing);
      return redirect("/portal/login", { "set-cookie": clearCookie() });
    }

    // ── GET /portal/endpoints ──────────────────────────────────────────────────
    if (method === "GET" && s0 === "endpoints" && segs.length === 1) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const eps = await endpoints.listByApp(auth.appId);
      const catalogTypes = eventTypesStore !== undefined
        ? (await eventTypesStore.list(auth.appId)).map((et) => ({ id: et.id, name: et.name }))
        : undefined;
      return html(200, portalEndpointsPage(eps, undefined, catalogTypes));
    }

    // ── POST /portal/endpoints ─────────────────────────────────────────────────
    // Creates an endpoint; shows the one-time secret in a banner on the same page.
    if (method === "POST" && s0 === "endpoints" && segs.length === 1) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const { appId } = auth;
      const catalogTypes = eventTypesStore !== undefined
        ? (await eventTypesStore.list(appId)).map((et) => ({ id: et.id, name: et.name }))
        : undefined;
      const hasCatalog = catalogTypes !== undefined && catalogTypes.length > 0;
      let resolvedEventTypes: string[] | null;
      if (hasCatalog) {
        const formAll = parseFormAll(req.rawBody);
        if (formAll.get("subscribeAll")?.[0] === "1") {
          resolvedEventTypes = null;
        } else {
          resolvedEventTypes = (formAll.get("eventType") ?? []).filter(Boolean);
        }
      } else {
        const form = parseForm(req.rawBody);
        resolvedEventTypes = parseEventTypes(form["eventTypes"] ?? "");
      }
      const form = parseForm(req.rawBody);
      const rawDesc = form["description"] ?? "";
      const input: NewEndpoint = {
        appId,
        url: (form["url"] ?? "").trim(),
        description: rawDesc,
        eventTypes: resolvedEventTypes,
        headers: parseHeadersTextarea(form["headers"] ?? ""),
      };
      let secret: string;
      try {
        const created = await endpoints.create(input);
        secret = created.secret;
      } catch (err) {
        // Validation error (e.g. bad URL) — show the list with an inline error.
        const eps = await endpoints.listByApp(appId);
        const errMsg = err instanceof Error ? err.message : "Invalid input.";
        // Inject a JS alert as the simplest way to surface the error without
        // refactoring the view to carry a separate error slot for the create form.
        return html(200, portalEndpointsPage(eps, undefined, catalogTypes) + `<script>alert(${JSON.stringify(errMsg)})</script>`);
      }
      // Reload the list and show the secret banner.
      const eps = await endpoints.listByApp(appId);
      return html(200, portalEndpointsPage(eps, secret, catalogTypes));
    }

    // ── GET /portal/endpoints/:id ──────────────────────────────────────────────
    if (method === "GET" && s0 === "endpoints" && s1 !== undefined && s2 === undefined) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const ep = await endpoints.get(s1);
      if (ep === null || ep.appId !== auth.appId) return NOT_FOUND;
      const page = await queue.listByEndpoint(s1, { limit: RECENT_DELIVERIES_LIMIT });
      const rows: DeliveryRow[] = page.deliveries.map((task) => ({
        task,
        messageId: task.messageId ?? "",
      }));
      const catalogTypes = eventTypesStore !== undefined
        ? (await eventTypesStore.list(auth.appId)).map((et) => ({ id: et.id, name: et.name }))
        : undefined;
      return html(200, portalEndpointDetailPage(ep, rows, undefined, catalogTypes));
    }

    // ── POST /portal/endpoints/:id/update ─────────────────────────────────────
    if (method === "POST" && s0 === "endpoints" && s1 !== undefined && s2 === "update") {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const ep = await endpoints.get(s1);
      if (ep === null || ep.appId !== auth.appId) return NOT_FOUND;
      const catalogTypes = eventTypesStore !== undefined
        ? (await eventTypesStore.list(auth.appId)).map((et) => ({ id: et.id, name: et.name }))
        : undefined;
      const hasCatalog = catalogTypes !== undefined && catalogTypes.length > 0;
      let resolvedEventTypes: string[] | null;
      if (hasCatalog) {
        const formAll = parseFormAll(req.rawBody);
        if (formAll.get("subscribeAll")?.[0] === "1") {
          resolvedEventTypes = null;
        } else {
          resolvedEventTypes = (formAll.get("eventType") ?? []).filter(Boolean);
        }
      } else {
        const form = parseForm(req.rawBody);
        resolvedEventTypes = parseEventTypes(form["eventTypes"] ?? "");
      }
      const form = parseForm(req.rawBody);
      const rawUrl2 = (form["url"] ?? "").trim();
      const patch: EndpointUpdate = {
        ...(rawUrl2.length > 0 ? { url: rawUrl2 } : {}),
        description: form["description"] ?? "",
        eventTypes: resolvedEventTypes,
        disabled: form["disabled"] === "1",
        headers: parseHeadersTextarea(form["headers"] ?? ""),
      };
      let updated: typeof ep;
      try {
        updated = await endpoints.update(s1, patch);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Invalid input.";
        const page = await queue.listByEndpoint(s1, { limit: RECENT_DELIVERIES_LIMIT });
        const rows: DeliveryRow[] = page.deliveries.map((task) => ({
          task,
          messageId: task.messageId ?? "",
        }));
        return html(200, portalEndpointDetailPage(ep, rows, errMsg, catalogTypes));
      }
      const page = await queue.listByEndpoint(updated.id, { limit: RECENT_DELIVERIES_LIMIT });
      const rows: DeliveryRow[] = page.deliveries.map((task) => ({
        task,
        messageId: task.messageId ?? "",
      }));
      return html(200, portalEndpointDetailPage(updated, rows, undefined, catalogTypes));
    }

    // ── POST /portal/endpoints/:id/rotate-secret ───────────────────────────────
    if (method === "POST" && s0 === "endpoints" && s1 !== undefined && s2 === "rotate-secret") {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const ep = await endpoints.get(s1);
      if (ep === null || ep.appId !== auth.appId) return NOT_FOUND;
      const rotated = await endpoints.rotateSecret(s1);
      return html(200, portalRotatedSecretPage(rotated, rotated.secret));
    }

    // ── POST /portal/endpoints/:id/delete ─────────────────────────────────────
    if (method === "POST" && s0 === "endpoints" && s1 !== undefined && s2 === "delete") {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const ep = await endpoints.get(s1);
      if (ep === null || ep.appId !== auth.appId) return NOT_FOUND;
      await endpoints.delete(s1);
      return redirect("/portal/endpoints");
    }

    // ── POST /portal/endpoints/:id/test ───────────────────────────────────────
    if (method === "POST" && s0 === "endpoints" && s1 !== undefined && s2 === "test" && segs.length === 3) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const ep = await endpoints.get(s1);
      if (ep === null || ep.appId !== auth.appId) return NOT_FOUND;
      const now = clock();
      const syntheticMessage = {
        id: `test_${randomUUID()}`,
        appId: auth.appId,
        eventType: "test",
        payload: JSON.stringify({ test: true }),
        idempotencyKey: null,
        channel: null,
        deliverAt: null,
        createdAt: now,
        fanoutPending: false,
      };
      const target = endpointToDeliveryTarget(ep, now);
      const signedReq = buildSignedRequest(syntheticMessage, target, now);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
      const sentAt = Date.now();
      let httpStatus: number | undefined;
      let error: string | undefined;
      try {
        const response = await send(signedReq, controller.signal);
        httpStatus = response.status;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      const durationMs = Date.now() - sentAt;
      const testResult: PortalTestResult = {
        success: httpStatus !== undefined && isSuccessStatus(httpStatus),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(error !== undefined ? { error } : {}),
        durationMs,
      };
      const page = await queue.listByEndpoint(s1, { limit: RECENT_DELIVERIES_LIMIT });
      const rows: DeliveryRow[] = page.deliveries.map((task) => ({
        task,
        messageId: task.messageId ?? "",
      }));
      const catalogTypes = eventTypesStore !== undefined
        ? (await eventTypesStore.list(auth.appId)).map((et) => ({ id: et.id, name: et.name }))
        : undefined;
      return html(200, portalEndpointDetailPage(ep, rows, undefined, catalogTypes, testResult));
    }

    // ── GET /portal/endpoints/:id/deliveries/:deliveryId ──────────────────────
    if (
      method === "GET" &&
      s0 === "endpoints" &&
      s1 !== undefined &&
      s2 === "deliveries" &&
      s3 !== undefined &&
      segs.length === 4
    ) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const ep = await endpoints.get(s1);
      if (ep === null || ep.appId !== auth.appId) return NOT_FOUND;
      const task = await queue.get(s3);
      if (task === null || task.endpointId !== s1) return NOT_FOUND;
      const retried = req.query["retried"] === "1";
      return html(200, portalDeliveryDetailPage(ep, task, retried));
    }

    // ── POST /portal/endpoints/:id/deliveries/:deliveryId/retry ───────────────
    if (
      method === "POST" &&
      s0 === "endpoints" &&
      s1 !== undefined &&
      s2 === "deliveries" &&
      s3 !== undefined &&
      s4 === "retry"
    ) {
      const auth = requireAuth(req);
      if ("status" in auth) return auth;
      const ep = await endpoints.get(s1);
      if (ep === null || ep.appId !== auth.appId) return NOT_FOUND;
      const task = await queue.get(s3);
      if (task === null || task.endpointId !== s1) return NOT_FOUND;
      try {
        await queue.retry(s3);
      } catch (err) {
        if (err instanceof DeliveryStateError) {
          // Non-terminal task — already active; redirect back to detail page.
          return redirect(`/portal/endpoints/${s1}/deliveries/${s3}`);
        }
        throw err;
      }
      return redirect(`/portal/endpoints/${s1}/deliveries/${s3}?retried=1`);
    }

    return NOT_FOUND;
  };
}
