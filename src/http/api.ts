/**
 * The HTTP API handler — Posthorn's tenant-facing surface, expressed as a pure
 * request→response function over the existing stores.
 *
 * This is the layer that finally makes Posthorn a *runnable service* rather than a
 * library: it composes {@link AppStore} (authentication), {@link EndpointStore}
 * (subscription CRUD), and {@link ingest} (the accept-and-fan-out headline op)
 * behind a small REST surface. It deliberately holds **no** transport code — the
 * `node:http` socket plumbing lives in `server.ts` (the thin I/O adapter), so this
 * handler stays deterministic and testable without opening a port, exactly like
 * the delivery worker's pure decision helpers sit behind its injectable transport.
 *
 * ## Surface (v1)
 *
 * | Method | Path                 | Auth   | Purpose                                  |
 * | ------ | -------------------- | ------ | ---------------------------------------- |
 * | GET    | /healthz             | none   | Liveness probe.                          |
 * | GET    | /metrics             | none   | Prometheus exposition (operator metrics).|
 * | POST   | /v1/messages         | Bearer | Accept an event and fan it out (202).    |
 * | GET    | /v1/messages         | Bearer | List the tenant's messages (paginated).  |
 * | GET    | /v1/messages/:id     | Bearer | Read a message + its delivery statuses.  |
 * | POST   | /v1/messages/:id/retry | Bearer | Replay a message's dead-lettered deliveries. |
 * | GET    | /v1/endpoints        | Bearer | List the tenant's endpoints.             |
 * | POST   | /v1/endpoints        | Bearer | Create an endpoint (201, secret once).   |
 * | GET    | /v1/endpoints/:id    | Bearer | Fetch one endpoint (tenant-scoped).      |
 * | PATCH  | /v1/endpoints/:id    | Bearer | Update an endpoint (tenant-scoped).      |
 * | DELETE | /v1/endpoints/:id    | Bearer | Delete an endpoint (204, tenant-scoped). |
 *
 * ## Security model (decided, not incidental)
 *
 * - **Tenancy comes from the key, never the body.** Every authenticated route
 *   scopes to `authenticate(bearer).id`; an `appId` in a request body is ignored,
 *   so a caller cannot act as another tenant by forging a field.
 * - **Cross-tenant access is `404`, not `403`.** Reading/patching/deleting another
 *   app's endpoint is indistinguishable from "does not exist", so the API never
 *   confirms the existence of another tenant's resources.
 * - **Signing secrets are write-only over HTTP.** An endpoint's `secret` is
 *   returned exactly once, in the `201` create response (you need it to configure
 *   verification); it is never echoed by list/get/update. The receiver-side secret
 *   should not be sprayed across every read.
 * - **App/key provisioning is intentionally not an HTTP route.** Minting a tenant
 *   or an API key is a privileged, bootstrap operation; exposing it unauthenticated
 *   would be an open door, and there is no key yet to authenticate it. It stays on
 *   the programmatic {@link AppStore} (an admin CLI / control-plane route is a
 *   later tick). This API is the *tenant-facing* surface only.
 */

import {
  IdempotencyConflictError,
  MAX_LIST_MESSAGES_LIMIT,
  type ListMessagesOptions,
  type Message,
  type MessageStore,
  type NewMessage,
} from "../storage/message-store.js";
import {
  UnknownEndpointError,
  type Endpoint,
  type EndpointStore,
  type EndpointUpdate,
  type NewEndpoint,
} from "../endpoints/endpoint.js";
import type { DeliveryQueue, DeliveryTask } from "../queue/delivery-queue.js";
import { retryMessageDeliveries } from "../queue/retry-message.js";
import type { App, AppStore } from "../apps/app.js";
import { ingest } from "../fanout/fanout.js";
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheus,
  type MetricsRegistry,
} from "../metrics/metrics.js";
import {
  defineRoutes,
  matchRoute,
  type RouteParams,
  type Route,
} from "./router.js";

/** The stores the API composes. One instance per running Posthorn service. */
export interface ApiDeps {
  /** Authenticates each request's API key to its owning tenant. */
  readonly apps: AppStore;
  /** Backs the endpoint CRUD routes. */
  readonly endpoints: EndpointStore;
  /** Where {@link ingest} accepts (and deduplicates) messages. */
  readonly messages: MessageStore;
  /** Where {@link ingest} enqueues the resulting delivery work. */
  readonly queue: DeliveryQueue;
  /**
   * Operational metrics. When supplied, `GET /metrics` serves the Prometheus
   * exposition and ingest is counted; when omitted (a minimal embedding),
   * `GET /metrics` is `404`. Optional so the API can be composed without it.
   */
  readonly metrics?: MetricsRegistry;
}

/**
 * A normalized, transport-agnostic request. The `server.ts` adapter builds one of
 * these from a `node:http` request; tests can build one by hand. Header keys are
 * lower-cased (HTTP header names are case-insensitive); `rawBody` is the exact
 * request body, or `""` when there is none.
 */
export interface ApiRequest {
  readonly method: string;
  /** The URL pathname only — no query string (that is parsed into {@link query}). */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * Parsed query-string parameters, keys as written. The `server.ts` adapter
   * builds this from the request URL; for a repeated key the first value wins.
   * Empty when there is no query string.
   */
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
}

/**
 * A transport-agnostic response. `body` is a JSON-serializable value, or
 * `undefined` for an empty body (e.g. `204`). `headers` carries any extra response
 * headers (`Allow`, `WWW-Authenticate`); the adapter adds `Content-Type`/`-Length`.
 */
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * When set, `body` is treated as an already-serialized string and written
   * verbatim with this `Content-Type` (instead of being JSON-encoded). The escape
   * hatch for non-JSON responses such as the Prometheus text exposition served at
   * `GET /metrics`. Omitted for the JSON responses every other route returns.
   */
  readonly contentType?: string;
}

/** The function `server.ts` drives once per request. */
export type ApiHandler = (req: ApiRequest) => Promise<ApiResponse>;

/**
 * An error carrying the HTTP status and machine-readable code it should surface
 * as. Thrown freely inside route handlers; the dispatcher catches it and renders
 * the standard `{ error: { code, message } }` envelope.
 */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** Build a JSON response. */
function json(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): ApiResponse {
  return headers ? { status, body, headers } : { status, body };
}

/** Render any thrown value into a response, mapping known domain errors to codes. */
function toErrorResponse(err: unknown): ApiResponse {
  if (err instanceof HttpError) {
    // A 401 advertises the scheme the client should use, per RFC 7235.
    return json(
      err.status,
      { error: { code: err.code, message: err.message } },
      err.status === 401 ? { "www-authenticate": "Bearer" } : undefined,
    );
  }
  if (err instanceof IdempotencyConflictError) {
    return json(409, { error: { code: "idempotency_conflict", message: err.message } });
  }
  if (err instanceof UnknownEndpointError) {
    return json(404, { error: { code: "not_found", message: err.message } });
  }
  // Every intake validator in the codebase (`normalizeNew*`/`apply*Update`) throws
  // TypeError on malformed input, so a TypeError on a request path is a client
  // error, surfaced as 400. (A genuine internal bug that threw TypeError would also
  // land here; the validators are the only realistic source on these routes.)
  if (err instanceof TypeError) {
    return json(400, { error: { code: "invalid_request", message: err.message } });
  }
  return json(500, { error: { code: "internal_error", message: "internal server error" } });
}

/** Extract the bearer token from an `Authorization` header, or `null` if absent/malformed. */
function extractBearer(req: ApiRequest): string | null {
  const header = req.headers["authorization"];
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/** Parse a request body that must be a JSON object, throwing the right 400 otherwise. */
function parseJsonObject(req: ApiRequest): Record<string, unknown> {
  if (req.rawBody.length === 0) {
    throw new HttpError(400, "invalid_request", "a JSON request body is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody);
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** A required path parameter; absent only on a routing bug, surfaced as 500. */
function requireParam(params: RouteParams, name: string): string {
  const value = params[name];
  if (value === undefined) {
    throw new HttpError(500, "internal_error", `missing route parameter "${name}"`);
  }
  return value;
}

/**
 * Parse the `?limit=&cursor=` query of the message-list route into store options.
 * A present-but-invalid `limit` (non-integer or outside `[1, MAX]`) is a client
 * error → `400`; the cursor is passed through opaquely (the store validates its
 * shape, surfacing a malformed one as a `TypeError` → `400`). An absent param is
 * simply omitted so the store applies its own default.
 */
function parseListMessagesParams(
  query: Readonly<Record<string, string | undefined>>,
): ListMessagesOptions {
  const options: { limit?: number; cursor?: string } = {};
  const rawLimit = query["limit"];
  if (rawLimit !== undefined) {
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_MESSAGES_LIMIT) {
      throw new HttpError(
        400,
        "invalid_request",
        `limit must be an integer in [1, ${MAX_LIST_MESSAGES_LIMIT}]`,
      );
    }
    options.limit = limit;
  }
  const rawCursor = query["cursor"];
  if (rawCursor !== undefined && rawCursor.length > 0) {
    options.cursor = rawCursor;
  }
  return options;
}

/**
 * The non-secret view of an endpoint returned by list/get/update. Crucially omits
 * `secret` — the signing secret is write-only over HTTP (see the module docstring).
 */
function endpointView(endpoint: Endpoint): Record<string, unknown> {
  return {
    id: endpoint.id,
    appId: endpoint.appId,
    url: endpoint.url,
    description: endpoint.description,
    eventTypes: endpoint.eventTypes,
    disabled: endpoint.disabled,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

/**
 * The tenant-facing view of one delivery attempt-state, as returned by the
 * message-status read. Surfaces exactly the fields a producer needs to answer
 * "what happened to my webhook?" — the destination (`endpointId`), the current
 * `status` (pending/delivering/succeeded/dead_letter), how many `attempts` have
 * run, when the next retry is due, and the `lastError` if one failed. The opaque
 * `leaseToken` is internal queue plumbing and is deliberately omitted.
 */
function deliveryView(task: DeliveryTask): Record<string, unknown> {
  return {
    id: task.id,
    endpointId: task.endpointId,
    status: task.status,
    attempts: task.attempts,
    nextAttemptAt: task.nextAttemptAt,
    lastError: task.lastError,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * The summary view of a message in a list/index response. Deliberately lighter
 * than {@link messageView}: it omits the (potentially large) `payload` and the
 * per-endpoint `deliveries` — listing a page of messages should not fan out into
 * a delivery query per row. Fetch `GET /v1/messages/:id` for the full detail.
 */
function messageListItemView(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    appId: message.appId,
    eventType: message.eventType,
    idempotencyKey: message.idempotencyKey,
    createdAt: message.createdAt,
  };
}

/** The tenant-facing view of a message and its per-endpoint delivery statuses. */
function messageView(
  message: Message,
  deliveries: readonly DeliveryTask[],
): Record<string, unknown> {
  return {
    id: message.id,
    appId: message.appId,
    eventType: message.eventType,
    idempotencyKey: message.idempotencyKey,
    // The producer's own payload, echoed back so it can confirm what was sent.
    payload: message.payload,
    createdAt: message.createdAt,
    deliveries: deliveries.map(deliveryView),
  };
}

/** Base context every route handler receives. */
interface BaseContext {
  readonly req: ApiRequest;
  readonly params: RouteParams;
}

/** Context for an authenticated route: the base plus the resolved tenant. */
interface AuthedContext extends BaseContext {
  readonly app: App;
}

type RouteHandler = (ctx: BaseContext) => Promise<ApiResponse>;
type AuthedHandler = (ctx: AuthedContext) => Promise<ApiResponse>;

/**
 * Create the request handler for a Posthorn service. Builds the route table once;
 * the returned {@link ApiHandler} is then driven per request and never mutates.
 */
export function createApi(deps: ApiDeps): ApiHandler {
  /** Wrap an authenticated handler with bearer-token resolution to a tenant. */
  const authed =
    (handler: AuthedHandler): RouteHandler =>
    async (ctx) => {
      const token = extractBearer(ctx.req);
      if (token === null) {
        throw new HttpError(401, "unauthorized", "missing or malformed Authorization header");
      }
      const app = await deps.apps.authenticate(token);
      if (app === null) {
        throw new HttpError(401, "unauthorized", "invalid or revoked API key");
      }
      return handler({ ...ctx, app });
    };

  /** Load an endpoint, enforcing tenant ownership; 404 if absent or not the caller's. */
  const loadOwnedEndpoint = async (appId: string, id: string): Promise<Endpoint> => {
    const endpoint = await deps.endpoints.get(id);
    if (endpoint === null || endpoint.appId !== appId) {
      throw new HttpError(404, "not_found", `no endpoint with id "${id}"`);
    }
    return endpoint;
  };

  const health: RouteHandler = async () => json(200, { status: "ok" });

  const metricsExposition: RouteHandler = async () => {
    const registry = deps.metrics;
    if (registry === undefined) {
      // Metrics not wired (a minimal embedding) — the route effectively does not
      // exist. 404 keeps that indistinguishable from any other unknown path.
      throw new HttpError(404, "not_found", "metrics are not enabled");
    }
    // Counters are in-memory (instant); the backlog gauge is read from the queue
    // at scrape time so it is never stale.
    const deliveryTasksByStatus = await deps.queue.countByStatus();
    const text = renderPrometheus({
      version: registry.version,
      uptimeSeconds: registry.uptimeSeconds(),
      counters: registry.counters(),
      deliveryTasksByStatus,
    });
    return { status: 200, body: text, contentType: PROMETHEUS_CONTENT_TYPE };
  };

  const createMessage: AuthedHandler = async (ctx) => {
    const body = parseJsonObject(ctx.req);
    if (!("payload" in body)) {
      throw new HttpError(400, "invalid_request", "payload is required");
    }
    // The delivered/signed body is the exact JSON serialization of `payload`; the
    // receiver verifies these bytes. `eventType`/`idempotencyKey` are validated by
    // the store's `normalizeNewMessage` (TypeError → 400). `appId` is the
    // authenticated tenant — never read from the body.
    const input: NewMessage = {
      appId: ctx.app.id,
      eventType: body["eventType"] as string,
      payload: JSON.stringify(body["payload"]),
      ...("idempotencyKey" in body
        ? { idempotencyKey: body["idempotencyKey"] as string | null }
        : {}),
    };
    const result = await ingest(input, {
      messages: deps.messages,
      endpoints: deps.endpoints,
      queue: deps.queue,
    });
    deps.metrics?.recordIngest({ deduplicated: result.deduplicated });
    return json(202, {
      message: {
        id: result.message.id,
        appId: result.message.appId,
        eventType: result.message.eventType,
        idempotencyKey: result.message.idempotencyKey,
        createdAt: result.message.createdAt,
      },
      deduplicated: result.deduplicated,
      fanout:
        result.fanout === null
          ? null
          : {
              matched: result.fanout.matched,
              skippedDisabled: result.fanout.skippedDisabled,
              skippedUnsubscribed: result.fanout.skippedUnsubscribed,
            },
    });
  };

  const listMessages: AuthedHandler = async (ctx) => {
    const page = await deps.messages.listByApp(
      ctx.app.id,
      parseListMessagesParams(ctx.req.query),
    );
    // `data` mirrors the endpoint-list shape; `nextCursor` (opaque, or null on the
    // last page) is fed back as `?cursor=` to page forward. Tenancy is the key's,
    // so a caller only ever pages its own messages.
    return json(200, {
      data: page.messages.map(messageListItemView),
      nextCursor: page.nextCursor,
    });
  };

  const getMessage: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const message = await deps.messages.get(id);
    // Cross-tenant (or absent) reads are 404 — existence is never revealed,
    // consistent with the endpoint routes. Tenancy comes from the key, so a
    // caller can only ever read its own messages.
    if (message === null || message.appId !== ctx.app.id) {
      throw new HttpError(404, "not_found", `no message with id "${id}"`);
    }
    const deliveries = await deps.queue.listByMessage(id);
    return json(200, messageView(message, deliveries));
  };

  const retryMessage: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const message = await deps.messages.get(id);
    // Tenancy from the key; another tenant's (or an absent) message is 404 —
    // existence is never revealed, identical to the read route above.
    if (message === null || message.appId !== ctx.app.id) {
      throw new HttpError(404, "not_found", `no message with id "${id}"`);
    }
    // Re-drive the dead-lettered deliveries; returns the refreshed per-endpoint
    // statuses (the replayed ones now back to `pending`) so the caller sees the
    // effect immediately — the same shape as GET /v1/messages/:id's deliveries.
    const result = await retryMessageDeliveries(id, { queue: deps.queue });
    return json(200, {
      id: message.id,
      retried: result.retried,
      deliveries: result.tasks.map(deliveryView),
    });
  };

  const listEndpoints: AuthedHandler = async (ctx) => {
    const all = await deps.endpoints.listByApp(ctx.app.id);
    return json(200, { data: all.map(endpointView) });
  };

  const createEndpoint: AuthedHandler = async (ctx) => {
    const body = parseJsonObject(ctx.req);
    // `appId` is forced to the authenticated tenant; any body `appId` is ignored.
    const input: NewEndpoint = {
      appId: ctx.app.id,
      url: body["url"] as string,
      ...("secret" in body ? { secret: body["secret"] as string } : {}),
      ...("description" in body ? { description: body["description"] as string } : {}),
      ...("eventTypes" in body
        ? { eventTypes: body["eventTypes"] as readonly string[] | null }
        : {}),
      ...("disabled" in body ? { disabled: body["disabled"] as boolean } : {}),
    };
    const created = await deps.endpoints.create(input);
    // The signing secret is returned exactly once, here, so the tenant can
    // configure receiver-side verification. Never echoed by list/get/update.
    return json(201, { ...endpointView(created), secret: created.secret });
  };

  const getEndpoint: AuthedHandler = async (ctx) => {
    const endpoint = await loadOwnedEndpoint(ctx.app.id, requireParam(ctx.params, "id"));
    return json(200, endpointView(endpoint));
  };

  const updateEndpoint: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    await loadOwnedEndpoint(ctx.app.id, id); // 404 unless it is the caller's
    const body = parseJsonObject(ctx.req);
    // Only the patchable fields are forwarded; `appId` is not patchable (an
    // endpoint never migrates tenants). Values are validated by `applyEndpointUpdate`.
    const patch: EndpointUpdate = {
      ...("url" in body ? { url: body["url"] as string } : {}),
      ...("secret" in body ? { secret: body["secret"] as string } : {}),
      ...("description" in body ? { description: body["description"] as string } : {}),
      ...("eventTypes" in body
        ? { eventTypes: body["eventTypes"] as readonly string[] | null }
        : {}),
      ...("disabled" in body ? { disabled: body["disabled"] as boolean } : {}),
    };
    const updated = await deps.endpoints.update(id, patch);
    return json(200, endpointView(updated));
  };

  const deleteEndpoint: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    await loadOwnedEndpoint(ctx.app.id, id); // 404 unless it is the caller's
    await deps.endpoints.delete(id);
    return { status: 204, body: undefined };
  };

  const routes: readonly Route<RouteHandler>[] = defineRoutes<RouteHandler>([
    { method: "GET", pattern: "/healthz", handler: health },
    { method: "GET", pattern: "/metrics", handler: metricsExposition },
    { method: "POST", pattern: "/v1/messages", handler: authed(createMessage) },
    { method: "GET", pattern: "/v1/messages", handler: authed(listMessages) },
    { method: "GET", pattern: "/v1/messages/:id", handler: authed(getMessage) },
    { method: "POST", pattern: "/v1/messages/:id/retry", handler: authed(retryMessage) },
    { method: "GET", pattern: "/v1/endpoints", handler: authed(listEndpoints) },
    { method: "POST", pattern: "/v1/endpoints", handler: authed(createEndpoint) },
    { method: "GET", pattern: "/v1/endpoints/:id", handler: authed(getEndpoint) },
    { method: "PATCH", pattern: "/v1/endpoints/:id", handler: authed(updateEndpoint) },
    { method: "DELETE", pattern: "/v1/endpoints/:id", handler: authed(deleteEndpoint) },
  ]);

  return async (req) => {
    const lookup = matchRoute(routes, req.method, req.path);
    if (lookup.kind === "notFound") {
      return json(404, {
        error: { code: "not_found", message: `no route for ${req.method} ${req.path}` },
      });
    }
    if (lookup.kind === "methodNotAllowed") {
      return json(
        405,
        {
          error: {
            code: "method_not_allowed",
            message: `${req.method} not allowed on ${req.path}`,
          },
        },
        { allow: lookup.allow.join(", ") },
      );
    }
    try {
      return await lookup.handler({ req, params: lookup.params });
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}
