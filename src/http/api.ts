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
 * | GET    | /healthz             | none   | Liveness probe (static — process is up). |
 * | GET    | /readyz              | none   | Readiness probe (200 ready / 503 not_ready, backend-gated). |
 * | GET    | /metrics             | none   | Prometheus exposition (operator metrics).|
 * | GET    | /openapi.json        | none   | The OpenAPI 3.1 description of this API.  |
 * | POST   | /v1/signup           | none   | Self-serve: create a tenant + first key (201). Opt-in, rate-limited, `404` when disabled. |
 * | POST   | /v1/messages         | Bearer | Accept an event and fan it out (202).    |
 * | GET    | /v1/messages         | Bearer | List the tenant's messages (paginated).  |
 * | GET    | /v1/messages/:id     | Bearer | Read a message + its delivery statuses.  |
 * | GET    | /v1/messages/:id/attempts | Bearer | List a message's per-attempt audit log. |
 * | POST   | /v1/messages/:id/retry | Bearer | Replay a message's dead-lettered deliveries. |
 * | GET    | /v1/endpoints        | Bearer | List the tenant's endpoints.             |
 * | POST   | /v1/endpoints        | Bearer | Create an endpoint (201, secret once).   |
 * | GET    | /v1/endpoints/:id    | Bearer | Fetch one endpoint (tenant-scoped).      |
 * | PATCH  | /v1/endpoints/:id    | Bearer | Update an endpoint (tenant-scoped).      |
 * | DELETE | /v1/endpoints/:id    | Bearer | Delete an endpoint (204, tenant-scoped). |
 * | POST   | /v1/endpoints/:id/rotate-secret | Bearer | Rotate signing secret, zero-downtime (secret once). |
 * | POST   | /v1/endpoints/:id/test | Bearer | Send a one-shot test delivery; returns result synchronously. |
 * | GET    | /v1/deliveries       | Bearer | List the tenant's deliveries (paginated, status filter). |
 * | POST   | /v1/deliveries/retry | Bearer | Bulk-retry the tenant's dead-lettered deliveries.       |
 * | GET    | /v1/usage            | Bearer | The tenant's own message + delivery usage and quota status. |
 * | POST   | /v1/admin/apps       | Admin  | Create a tenant (app).                   |
 * | GET    | /v1/admin/apps       | Admin  | List all tenants.                        |
 * | GET    | /v1/admin/apps/:id   | Admin  | Fetch one tenant.                        |
 * | PATCH  | /v1/admin/apps/:id   | Admin  | Update a tenant (name / message quota).  |
 * | DELETE | /v1/admin/apps/:id   | Admin  | Delete a tenant (204; cascades its keys).|
 * | POST   | /v1/admin/apps/:id/keys | Admin | Mint an API key (201, secret once).     |
 * | GET    | /v1/admin/apps/:id/keys | Admin | List a tenant's keys (metadata only).   |
 * | GET    | /v1/admin/apps/:id/usage | Admin | Per-tenant message + delivery usage (metering/billing). |
 * | DELETE | /v1/admin/keys/:id   | Admin  | Revoke an API key (204).                 |
 *
 * `Bearer` = a tenant API key; `Admin` = the operator admin token
 * (`POSTHORN_ADMIN_TOKEN`). The admin group is `404` unless that token is set.
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
 *   returned exactly once — in the `201` create response, and again as the *new*
 *   secret in the `rotate-secret` response (you need it to configure verification);
 *   it is never echoed by list/get/update. The retired secrets kept active during a
 *   rotation overlap are never exposed at all. The receiver-side secret should not
 *   be sprayed across every read.
 * - **App/key provisioning is gated, not absent.** Minting a tenant or an API key
 *   is privileged: it is never reachable with a tenant key, and the tenant-facing
 *   routes never create credentials. It lives on a separate **admin/control-plane
 *   surface** (`/v1/admin/*`) authenticated by an out-of-band operator **admin
 *   token** ({@link ApiDeps.adminToken} / `POSTHORN_ADMIN_TOKEN`). That surface is
 *   **disabled by default** — every admin route is `404` unless the token is
 *   configured — so the door is opt-in, never open, and a disabled instance never
 *   reveals the surface exists. The keyless `posthorn admin` CLI remains the
 *   local-shell bootstrap path (no network credential required); this HTTP surface
 *   is the path for remote/hosted operation and the seam the P5 control plane builds on.
 */

import {
  IdempotencyConflictError,
  MAX_LIST_MESSAGES_LIMIT,
  MAX_USAGE_RANGE_DAYS,
  VALID_PRIORITIES,
  utcDayKey,
  utcMonthRange,
  type ListMessagesOptions,
  type Message,
  type MessagePriority,
  type MessageStore,
  type NewMessage,
  type UsageRange,
  type UsageSummary,
} from "../storage/message-store.js";
import {
  UnknownEndpointError,
  type Endpoint,
  type EndpointFilter,
  type EndpointStore,
  type EndpointUpdate,
  type NewEndpoint,
  type RotateSecretOptions,
} from "../endpoints/endpoint.js";
import type { RetryPolicy } from "../delivery/retry-policy.js";
import {
  DuplicateEventTypeError,
  UnknownEventTypeError,
  type EventType,
  type EventTypeStore,
} from "../event-types/event-type.js";
import {
  MAX_LIST_DELIVERIES_LIMIT,
  type DeliveryPage,
  type DeliveryQueue,
  type DeliveryTask,
  type ListByAppOptions,
  type ListDeliveriesOptions,
} from "../queue/delivery-queue.js";
import type { DeliveryStatus } from "../delivery/delivery-state.js";
import {
  isDeliveryFailureReason,
  type DeliveryFailureReason,
} from "../delivery/failure-reason.js";
import { errorEnvelope, type ApiErrorCode } from "./error-codes.js";
import { retryMessageDeliveries } from "../queue/retry-message.js";
import { cancelMessageDeliveries } from "../queue/cancel-message.js";
import {
  retryAppDeliveries,
  retryEndpointDeliveries,
  type BulkRetryResult,
} from "../queue/retry-app.js";
import {
  normalizeReplayLimit,
  replayEndpointMessages,
  type ReplayResult,
} from "../queue/replay-endpoint.js";
import {
  DEFAULT_STATS_DAYS,
  MAX_LIST_ATTEMPTS_LIMIT,
  MAX_STATS_DAYS,
  type AttemptUsageSummary,
  type DeliveryAttempt,
  type DeliveryAttemptStore,
  type EndpointStats,
  type ListAttemptsOptions,
} from "../attempts/delivery-attempt.js";
import {
  isQuotaExceeded,
  quotaRemaining,
  UnknownAppError,
  type ApiKey,
  type App,
  type AppStore,
  type AppUpdate,
  type CreatedApp,
  type NewApp,
} from "../apps/app.js";
import { entitlementsForPlan, type PlanId } from "../apps/plan.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { ingest } from "../fanout/fanout.js";
import {
  buildSignedRequest,
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchTransport,
  isSuccessStatus,
  SlidingWindowRateLimiter,
  type Transport,
} from "../worker/delivery-worker.js";
import { endpointToDeliveryTarget } from "../endpoints/endpoint-resolver.js";
import { BlockedUrlError, assertUrlDeliverable } from "../net/ssrf-guard.js";
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheus,
  type MetricsRegistry,
} from "../metrics/metrics.js";
import {
  defineRoutes,
  matchRoute,
  toSegments,
  type RouteParams,
  type Route,
} from "./router.js";
import { buildOpenApiDocument } from "./openapi.js";
import { forwardedProtoIsHttps } from "./security-headers.js";
import type { BillingProvider } from "../billing/index.js";
import { StripeSignatureError } from "../billing/index.js";

/** Maximum number of messages accepted in a single `POST /v1/messages/batch` call. */
export const MAX_BATCH_MESSAGES = 100;

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
  /** The per-attempt delivery audit log read by `GET /v1/messages/:id/attempts`. */
  readonly attempts: DeliveryAttemptStore;
  /**
   * Operational metrics. When supplied, `GET /metrics` serves the Prometheus
   * exposition and ingest is counted; when omitted (a minimal embedding),
   * `GET /metrics` is `404`. Optional so the API can be composed without it.
   */
  readonly metrics?: MetricsRegistry;
  /**
   * The operator admin token enabling the admin/control-plane routes (`/v1/admin/*`).
   * When supplied (non-empty), those routes authenticate by comparing the presented
   * Bearer token to this value in constant time and provision apps/keys against
   * {@link ApiDeps.apps}, cross-tenant. When omitted/empty (the default) every admin
   * route is `404` — indistinguishable from a nonexistent path — so the surface is
   * opt-in. It is a *distinct* credential from a tenant API key: a tenant key never
   * satisfies an admin route, and the admin token is never looked up as a key.
   */
  readonly adminToken?: string;
  /**
   * Clock returning epoch ms, used only to locate the current UTC calendar month when
   * enforcing a tenant's monthly message quota on `POST /v1/messages`. Defaults to
   * {@link Date.now}; injected by tests to pin the billing window deterministically.
   */
  readonly now?: () => number;
  /**
   * Portal session store enabling the `POST /v1/portal/sessions` route. When
   * omitted, that route returns `404` — the portal feature is disabled. Wired
   * in the gateway alongside the portal handler so they share the same store.
   */
  readonly portalSessions?: import("../portal/portal-session.js").PortalSessionStore;
  /**
   * Canonical public base URL for the `portalUrl` returned by
   * `POST /v1/portal/sessions` — a bare origin (`https://hooks.example.com`). When
   * set it is authoritative and the request's `Host`/`X-Forwarded-Proto` are ignored,
   * which is the correct posture behind a host-rewriting proxy (the inbound `Host` is
   * the gateway's internal name) and avoids building an operator-facing link from a
   * client-settable header. When omitted the URL is derived from the request as before.
   * Validated/normalized upstream by {@link import("../runtime/config.js").loadConfig}
   * (`POSTHORN_PUBLIC_BASE_URL`); wired in by the gateway.
   */
  readonly publicBaseUrl?: string;
  /** Backs the event-type catalog CRUD routes. */
  readonly eventTypes: EventTypeStore;
  /**
   * HTTP transport used by `POST /v1/endpoints/:id/test` to send the one-shot
   * test delivery. Defaults to {@link fetchTransport}; inject a fake in tests.
   */
  readonly transport?: Transport;
  /**
   * Per-request timeout for test deliveries (ms). Defaults to
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}. `0` disables the timeout.
   */
  readonly testRequestTimeoutMs?: number;
  /**
   * Allow endpoint URLs that target private/internal addresses. Defaults to
   * `false` (block) — the SSRF defense for a webhook sender: creating or updating
   * an endpoint whose URL points at loopback, a private/link-local range, the
   * cloud-metadata address, or an internal hostname is rejected with
   * `400 url_not_allowed`. See {@link assertUrlDeliverable} and
   * `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS`.
   */
  readonly allowPrivateNetworks?: boolean;
  /**
   * Backend readiness probe for `GET /readyz`. Resolves when the storage backend is
   * reachable and rejects when it is not — distinct from the static `/healthz`
   * liveness signal. The gateway wires this to a cheap backend round-trip (a
   * `SELECT 1` against the shared Postgres pool, where a remote database can be down
   * independently of the process; an immediate success for the embedded SQLite
   * backend, which has no out-of-process dependency to fail). `/readyz` returns `200`
   * on resolve and `503` on reject, so an orchestrator pulls a replica whose database
   * is unreachable out of rotation rather than routing ingest it cannot durably store.
   * When omitted (a minimal embedding), `/readyz` always returns `200` — there is no
   * wired backend dependency to gate on.
   */
  readonly checkReadiness?: () => Promise<void>;
  /**
   * The pluggable billing backend (the flag-gated payment seam). When omitted, or
   * when the wired provider has no configured webhook secret
   * ({@link BillingProvider.webhookConfigured} is `false`), `POST /v1/billing/webhook`
   * is `404` — the same opt-in posture as the admin API. The gateway always wires one
   * (the {@link NoopBillingProvider} unless an operator enabled Stripe), so the route
   * is live only when a provider with a webhook secret is configured.
   */
  readonly billing?: BillingProvider;
  /**
   * Self-serve signup settings enabling the public `POST /v1/signup` route. When
   * omitted, or when `enabled` is `false`, that route is `404` — the same opt-in
   * posture as the admin API, so an unattended gateway never lets the world mint
   * tenants. When enabled, signups are rate-limited gateway-wide to `ratePerMinute`
   * (a coarse global cap: the socket-agnostic core has no trustworthy client IP, and
   * `X-Forwarded-For` is spoofable). Wired from {@link import("../runtime/config.js").SignupConfig}.
   */
  readonly signup?: { readonly enabled: boolean; readonly ratePerMinute: number };
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
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
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
      errorEnvelope(err.code, err.message),
      err.status === 401 ? { "www-authenticate": "Bearer" } : undefined,
    );
  }
  if (err instanceof IdempotencyConflictError) {
    return json(409, errorEnvelope("idempotency_conflict", err.message));
  }
  if (
    err instanceof UnknownEndpointError ||
    err instanceof UnknownAppError ||
    err instanceof UnknownEventTypeError
  ) {
    return json(404, errorEnvelope("not_found", err.message));
  }
  if (err instanceof DuplicateEventTypeError) {
    return json(409, errorEnvelope("conflict", err.message));
  }
  if (err instanceof BlockedUrlError) {
    // A tenant tried to point an endpoint at a private/internal address; the SSRF
    // guard rejected it. A distinct code lets clients tell this apart from a
    // generic validation error.
    return json(400, errorEnvelope("url_not_allowed", err.message));
  }
  // Validators throw TypeError for type mismatches and RangeError for out-of-range
  // values (e.g. a `limit` outside `[1, MAX]`). Both are client errors on request paths.
  if (err instanceof TypeError || err instanceof RangeError) {
    return json(400, errorEnvelope("invalid_request", err.message));
  }
  return json(500, errorEnvelope("internal_error", "internal server error"));
}

/**
 * Constant-time string equality, used to compare a presented admin token against
 * the configured one without leaking length or content through timing. Both inputs
 * are SHA-256'd to fixed-width digests first, so {@link timingSafeEqual} never sees
 * unequal lengths (which would itself leak) and the comparison does not short-circuit
 * at the first differing byte.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a, "utf8").digest();
  const bh = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ah, bh);
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

/**
 * Parse an optional `sendAt` field from a request body. Accepts an ISO 8601 string
 * and converts it to epoch-ms. Missing / null → `null` (immediate delivery).
 * Throws `TypeError` on bad input so the global error handler renders it as 400.
 */
function parseSendAt(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new TypeError("sendAt must be a string");
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new TypeError("sendAt must be a valid ISO 8601 date string");
  return t;
}

/**
 * Parse an optional `expiresAt` field from a request body. Accepts an ISO 8601
 * string and converts it to epoch-ms. Missing / null → `null` (no expiry).
 * Throws `TypeError` on bad input so the global error handler renders it as 400.
 */
function parseExpiresAt(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new TypeError("expiresAt must be a string");
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new TypeError("expiresAt must be a valid ISO 8601 date string");
  return t;
}

/**
 * Parse an optional `priority` field from a request body. Accepts `"high"`,
 * `"normal"`, or `"low"`. Missing/undefined → `undefined` (store applies default).
 * Throws `TypeError` on an invalid value so the global handler renders it as 400.
 */
function parsePriority(v: unknown): MessagePriority | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(VALID_PRIORITIES as readonly string[]).includes(v)) {
    throw new TypeError(`priority must be one of: ${VALID_PRIORITIES.join(", ")}`);
  }
  return v as MessagePriority;
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
 * Parse the `?limit=&cursor=&eventType=` query of the message-list route into store
 * options. A present-but-invalid `limit` (non-integer or outside `[1, MAX]`) is a
 * client error → `400`; the cursor is passed through opaquely (the store validates its
 * shape, surfacing a malformed one as a `TypeError` → `400`). An absent param is
 * simply omitted so the store applies its own default.
 */
function parseListMessagesParams(
  query: Readonly<Record<string, string | undefined>>,
): ListMessagesOptions {
  const options: {
    limit?: number;
    cursor?: string;
    eventType?: string;
    channel?: string;
    after?: number;
    before?: number;
  } = {};
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
  const rawEventType = query["eventType"];
  if (rawEventType !== undefined && rawEventType.length > 0) {
    options.eventType = rawEventType;
  }
  const rawChannel = query["channel"];
  if (rawChannel !== undefined && rawChannel.length > 0) {
    options.channel = rawChannel;
  }
  const after = parseCreatedAtBoundParam(query["after"], "after");
  if (after !== undefined) {
    options.after = after;
  }
  const before = parseCreatedAtBoundParam(query["before"], "before");
  if (before !== undefined) {
    options.before = before;
  }
  return options;
}

/**
 * Parse an `?after=`/`?before=` created-at bound: an epoch-ms non-negative integer,
 * or `undefined` when the param is absent/empty. A present-but-invalid value is a
 * client error → `400` (mirrors the `limit` rule).
 */
function parseCreatedAtBoundParam(
  raw: string | undefined,
  name: "after" | "before",
): number | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(
      400,
      "invalid_request",
      `${name} must be a non-negative integer (epoch ms)`,
    );
  }
  return value;
}

/**
 * Parse the `?limit=&cursor=` query of the endpoint deliveries route into store
 * options. Mirrors {@link parseListMessagesParams}.
 */
function parseListDeliveriesParams(
  query: Readonly<Record<string, string | undefined>>,
): ListDeliveriesOptions {
  const options: { limit?: number; cursor?: string } = {};
  const rawLimit = query["limit"];
  if (rawLimit !== undefined) {
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_DELIVERIES_LIMIT) {
      throw new HttpError(
        400,
        "invalid_request",
        `limit must be an integer in [1, ${MAX_LIST_DELIVERIES_LIMIT}]`,
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
 * Parse the `?limit=`, `?cursor=`, `?status=`, and `?failureReason=` query of the
 * app deliveries route into store options. `?status=` and `?failureReason=` are
 * both optional and compose; an unrecognised value for either is a 400.
 */
function parseListByAppParams(
  query: Readonly<Record<string, string | undefined>>,
): ListByAppOptions {
  let options: ListByAppOptions = parseListDeliveriesParams(query);

  const rawStatus = query["status"];
  if (rawStatus !== undefined && rawStatus.length > 0) {
    const validStatuses: readonly string[] = ["pending", "delivering", "succeeded", "dead_letter"];
    if (!validStatuses.includes(rawStatus)) {
      throw new HttpError(
        400,
        "invalid_request",
        `status must be one of: ${validStatuses.join(", ")}`,
      );
    }
    options = { ...options, status: rawStatus as DeliveryStatus };
  }

  const rawReason = query["failureReason"];
  if (rawReason !== undefined && rawReason.length > 0) {
    if (!isDeliveryFailureReason(rawReason)) {
      throw new HttpError(
        400,
        "invalid_request",
        `failureReason is not a recognised delivery-failure reason code`,
      );
    }
    options = { ...options, failureReason: rawReason as DeliveryFailureReason };
  }

  return options;
}

/**
 * Parse the `?limit=&cursor=` query of the attempt-log route into store options.
 * Mirrors {@link parseListMessagesParams}: a present-but-invalid `limit` is `400`;
 * the cursor is passed through opaquely (the store validates its shape → `400`).
 */
function parseListAttemptsParams(
  query: Readonly<Record<string, string | undefined>>,
): ListAttemptsOptions {
  const options: { limit?: number; cursor?: string } = {};
  const rawLimit = query["limit"];
  if (rawLimit !== undefined) {
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_ATTEMPTS_LIMIT) {
      throw new HttpError(
        400,
        "invalid_request",
        `limit must be an integer in [1, ${MAX_LIST_ATTEMPTS_LIMIT}]`,
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

/** A strict `YYYY-MM-DD` shape (calendar validity is then checked via `Date.parse`). */
const USAGE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Milliseconds in a UTC day — exact, since UTC has no daylight-saving shifts. */
const USAGE_DAY_MS = 86_400_000;

/** Parse a required `YYYY-MM-DD` query param to the epoch-ms of its UTC midnight, else 400. */
function parseUsageDate(value: string | undefined, field: string): number {
  if (value === undefined || !USAGE_DATE_PATTERN.test(value)) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} is required and must be a UTC date in YYYY-MM-DD format`,
    );
  }
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  // Reject a NaN parse *and* a calendar overflow: `Date.parse` leniently rolls an
  // out-of-range day/month over (e.g. `2026-02-30` → Mar 2), so round-trip the parsed
  // instant back to a day string and require it to equal the input.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "invalid_request", `${field} is not a valid calendar date`);
  }
  return ms;
}

/**
 * Parse the `?from=&to=` query of the admin usage route into a half-open epoch-ms
 * range. Both are *inclusive* `YYYY-MM-DD` UTC days, so `to` is expanded to the end
 * of that day (its midnight + one day, exclusive). `to` must be on/after `from`, and
 * the span is capped at {@link MAX_USAGE_RANGE_DAYS} so a single query cannot request
 * an unbounded daily breakdown. Any violation is a `400`.
 */
function parseUsageRangeParams(
  query: Readonly<Record<string, string | undefined>>,
): UsageRange {
  const fromMs = parseUsageDate(query["from"], "from");
  const toDayMs = parseUsageDate(query["to"], "to");
  if (toDayMs < fromMs) {
    throw new HttpError(400, "invalid_request", "to must be on or after from");
  }
  const toMs = toDayMs + USAGE_DAY_MS; // half-open, but inclusive of the whole `to` day
  if (Math.round((toMs - fromMs) / USAGE_DAY_MS) > MAX_USAGE_RANGE_DAYS) {
    throw new HttpError(
      400,
      "invalid_request",
      `the date range must span at most ${MAX_USAGE_RANGE_DAYS} days`,
    );
  }
  return { fromMs, toMs };
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
    headers: endpoint.headers,
    retryPolicy: endpoint.retryPolicy,
    filter: endpoint.filter ?? null,
    channel: endpoint.channel,
    rateLimit: endpoint.rateLimit,
    disabled: endpoint.disabled,
    // Endpoint health (observability): a tenant can see how/why an endpoint became
    // unhealthy, and whether it was auto-disabled after sustained failure.
    consecutiveFailures: endpoint.consecutiveFailures,
    firstFailureAt: endpoint.firstFailureAt,
    lastFailureAt: endpoint.lastFailureAt,
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
    failureReason: task.failureReason,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * The tenant-facing view of a delivery in an endpoint's history list. Extends
 * {@link deliveryView} with `messageId` — in the endpoint-centric view the source
 * message is not implied by context, so the caller needs it to navigate.
 */
function endpointDeliveryView(task: DeliveryTask): Record<string, unknown> {
  return {
    id: task.id,
    messageId: task.messageId,
    endpointId: task.endpointId,
    status: task.status,
    attempts: task.attempts,
    nextAttemptAt: task.nextAttemptAt,
    lastError: task.lastError,
    failureReason: task.failureReason,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * The tenant-facing view of one recorded delivery attempt — the per-attempt audit
 * log behind `GET /v1/messages/:id/attempts`. An attempt carries no secrets, so the
 * view is the full record: which task/endpoint, the 1-based attempt number, the
 * outcome, the HTTP status (or `null` on a transport/pre-flight failure), the error,
 * the structured `failureReason` code, the latency, and when it ran. It is mapped
 * explicitly (rather than echoed) so a
 * future internal field is never leaked by accident — the same discipline as
 * {@link deliveryView} and {@link endpointView}.
 */
function attemptView(attempt: DeliveryAttempt): Record<string, unknown> {
  return {
    id: attempt.id,
    taskId: attempt.taskId,
    endpointId: attempt.endpointId,
    attemptNumber: attempt.attemptNumber,
    outcome: attempt.outcome,
    responseStatus: attempt.responseStatus,
    error: attempt.error,
    failureReason: attempt.failureReason,
    requestBody: attempt.requestBody,
    responseBody: attempt.responseBody,
    durationMs: attempt.durationMs,
    attemptedAt: attempt.attemptedAt,
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
    channel: message.channel,
    priority: message.priority,
    deliverAt: message.deliverAt,
    expiresAt: message.expiresAt,
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
    channel: message.channel,
    priority: message.priority,
    deliverAt: message.deliverAt,
    expiresAt: message.expiresAt,
    createdAt: message.createdAt,
    deliveries: deliveries.map(deliveryView),
  };
}

/**
 * The admin (control-plane) view of a tenant. Carries no secret material — an app
 * is just identity + label. Mapped explicitly so a future internal field is never
 * leaked by accident, the same discipline as {@link endpointView}.
 */
function appView(app: App): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    // The assigned plan tier (null = custom/unmanaged), with the catalog allowances
    // it grants resolved for display. `entitlements` is null for a custom plan.
    plan: app.plan,
    entitlements: entitlementsForPlan(app.plan),
    // The tenant's monthly message quota (null = no limit) — operator-visible so a
    // dashboard can show the plan; not secret material.
    monthlyMessageQuota: app.monthlyMessageQuota,
    // The system webhook URL is operator-visible (not secret). The signing secret is
    // never included in the standard app view — use the create response or rotate
    // endpoint to obtain it.
    systemWebhookUrl: app.systemWebhookUrl,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

/**
 * The create-time view of a tenant — extends {@link appView} with the one-time
 * system webhook signing secret. The secret is returned here and never again;
 * the store keeps only its stored form for signing.
 */
function createdAppView(createdApp: CreatedApp): Record<string, unknown> {
  return {
    ...appView(createdApp),
    systemWebhookSecret: createdApp.systemWebhookSecret,
  };
}

/**
 * The admin view of an API key's metadata. Never includes the secret — the store
 * keeps only its hash, and the plaintext is surfaced exactly once at creation (see
 * the `createApiKey` handler). `prefix` is the non-secret display fragment so an
 * operator can recognise a key in a list.
 */
function apiKeyView(key: ApiKey): Record<string, unknown> {
  return {
    id: key.id,
    appId: key.appId,
    prefix: key.prefix,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
    lastUsedAt: key.lastUsedAt,
  };
}

/**
 * The view of a tenant's usage over a date range — the metering / billing read model,
 * shared by the admin (`GET /v1/admin/apps/:id/usage`) and tenant (`GET /v1/usage`)
 * routes. `from`/`to` are echoed back as the inclusive `YYYY-MM-DD` UTC days the caller
 * queried (the store works in epoch ms internally); `total`/`daily` are the **accepted
 * message** counts, and the `deliveries` block is the **delivery-attempt (operations)**
 * counts — what Posthorn actually *did* (every HTTP attempt, retries included), the
 * other half this market bills on. Both cover the same range and share the UTC-day
 * bucketing, so a dashboard lines them up day-for-day.
 */
function usageView(
  summary: UsageSummary,
  deliveries: AttemptUsageSummary,
): Record<string, unknown> {
  return {
    appId: summary.appId,
    from: utcDayKey(summary.fromMs),
    // toMs is exclusive (midnight after the `to` day); step back into that day for display.
    to: utcDayKey(summary.toMs - 1),
    total: summary.total,
    daily: summary.daily.map((day) => ({ date: day.date, messages: day.messages })),
    deliveries: {
      total: deliveries.total,
      succeeded: deliveries.succeeded,
      failed: deliveries.failed,
      daily: deliveries.daily.map((day) => ({
        date: day.date,
        attempts: day.attempts,
        succeeded: day.succeeded,
        failed: day.failed,
      })),
    },
  };
}

/**
 * The tenant self-service view for `GET /v1/usage`: the queried range's message
 * breakdown (the same shape {@link usageView} returns) plus a live `quota` block
 * describing the tenant's **current** UTC-calendar-month status — the enforcement
 * window `POST /v1/messages` checks. The quota block is independent of the queried
 * range (a custom `?from=&to=` pulls historical usage while `quota` still reports
 * this month), so a tenant — or the dashboard rendering it — can see how close it
 * is to its plan limit and when the allowance resets. `remaining` is `null` for an
 * unlimited tenant; `resetsAt` is the first day of next UTC month (the exclusive
 * upper bound of {@link import("../storage/message-store.js").utcMonthRange}).
 */
function tenantUsageView(
  summary: UsageSummary,
  deliveries: AttemptUsageSummary,
  app: App,
  monthUsed: number,
  monthRange: UsageRange,
): Record<string, unknown> {
  return {
    ...usageView(summary, deliveries),
    quota: {
      monthlyMessageQuota: app.monthlyMessageQuota,
      used: monthUsed,
      remaining: quotaRemaining(monthUsed, app.monthlyMessageQuota),
      periodStart: utcDayKey(monthRange.fromMs),
      resetsAt: utcDayKey(monthRange.toMs),
    },
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
 * Every v1 route as `"METHOD pattern"`. This is the **single source of truth** for
 * the API surface: {@link createApi} maps each key to a handler (the `Record` type
 * below makes that mapping exhaustive at compile time — a key with no handler, or a
 * handler with no key, fails to typecheck), and the OpenAPI document
 * (`openapi.ts`) is asserted against this same list so the two can never drift.
 */
export const API_ROUTE_KEYS = [
  "GET /healthz",
  "GET /readyz",
  "GET /metrics",
  "GET /openapi.json",
  // Public, unauthenticated self-serve onboarding. Opt-in: `404` unless signup is
  // enabled; rate-limited gateway-wide when on. The only write route with no credential.
  "POST /v1/signup",
  "POST /v1/messages",
  "POST /v1/messages/batch",
  "GET /v1/messages",
  "GET /v1/messages/:id",
  "GET /v1/messages/:id/attempts",
  "POST /v1/messages/:id/retry",
  "POST /v1/messages/:id/cancel",
  "GET /v1/endpoints",
  "POST /v1/endpoints",
  "GET /v1/endpoints/:id",
  "PATCH /v1/endpoints/:id",
  "DELETE /v1/endpoints/:id",
  "POST /v1/endpoints/:id/rotate-secret",
  "POST /v1/endpoints/:id/test",
  "GET /v1/endpoints/:id/deliveries",
  "POST /v1/endpoints/:id/deliveries/retry",
  "POST /v1/endpoints/:id/replay",
  "GET /v1/endpoints/:id/stats",
  "GET /v1/deliveries",
  "GET /v1/deliveries/:id",
  "GET /v1/deliveries/:id/attempts",
  "POST /v1/deliveries/retry",
  "GET /v1/usage",
  "POST /v1/portal/sessions",
  "GET /v1/event-types",
  "POST /v1/event-types",
  "GET /v1/event-types/:id",
  "PATCH /v1/event-types/:id",
  "DELETE /v1/event-types/:id",
  // Inbound billing webhook. Signature-authenticated (the provider's webhook secret),
  // not a tenant key; `404` unless a billing provider with a webhook secret is wired.
  "POST /v1/billing/webhook",
  // Admin / control-plane. Authenticated by the operator admin token (not a tenant
  // key); the whole group is `404` unless `POSTHORN_ADMIN_TOKEN` is configured.
  "POST /v1/admin/apps",
  "GET /v1/admin/apps",
  "GET /v1/admin/apps/:id",
  "PATCH /v1/admin/apps/:id",
  "DELETE /v1/admin/apps/:id",
  "POST /v1/admin/apps/:id/keys",
  "GET /v1/admin/apps/:id/keys",
  "GET /v1/admin/apps/:id/usage",
  "POST /v1/admin/apps/:id/rotate-system-secret",
  "DELETE /v1/admin/keys/:id",
] as const;

/** One of the {@link API_ROUTE_KEYS} `"METHOD pattern"` strings. */
export type ApiRouteKey = (typeof API_ROUTE_KEYS)[number];

/** Split a route key into its method and pattern halves (the method has no spaces). */
function splitRouteKey(key: ApiRouteKey): { method: string; pattern: string } {
  const sep = key.indexOf(" ");
  return { method: key.slice(0, sep), pattern: key.slice(sep + 1) };
}

/**
 * Convert a router pattern to an OpenAPI path template: each `:name` segment becomes
 * `{name}` (e.g. `/v1/messages/:id` → `/v1/messages/{id}`). Pure; shared with the
 * spec drift test so the router and the document agree on path templating.
 */
export function patternToOpenApiPath(pattern: string): string {
  const segments = toSegments(pattern).map((segment) =>
    segment.startsWith(":") ? `{${segment.slice(1)}}` : segment,
  );
  return `/${segments.join("/")}`;
}

/**
 * Create the request handler for a Posthorn service. Builds the route table once;
 * the returned {@link ApiHandler} is then driven per request and never mutates.
 */
export function createApi(deps: ApiDeps): ApiHandler {
  /** Clock for the monthly-quota window; defaults to the real one. */
  const now = deps.now ?? Date.now;

  /** SSRF policy for endpoint URLs; blocking private/internal targets by default. */
  const ssrfPolicy = { allowPrivateNetworks: deps.allowPrivateNetworks ?? false };

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

  /**
   * Wrap a handler so it requires the operator admin token (the control-plane auth,
   * distinct from a tenant API key). When no admin token is configured the route is
   * `404` — indistinguishable from a nonexistent path, so the admin surface's
   * existence is never revealed by probing a disabled instance. When configured, the
   * presented Bearer token is compared in constant time; a tenant key (or any other
   * value) never matches.
   */
  const adminAuthed =
    (handler: RouteHandler): RouteHandler =>
    async (ctx) => {
      const adminToken = deps.adminToken;
      if (adminToken === undefined || adminToken.length === 0) {
        throw new HttpError(
          404,
          "not_found",
          `no route for ${ctx.req.method} ${ctx.req.path}`,
        );
      }
      const token = extractBearer(ctx.req);
      if (token === null || !constantTimeEqual(token, adminToken)) {
        throw new HttpError(401, "unauthorized", "missing or invalid admin token");
      }
      return handler(ctx);
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

  // Readiness, distinct from liveness: `/healthz` is a static "the process is up"
  // signal (never restart a pod for a transient backend blip), while `/readyz` asks
  // "should this replica receive traffic *right now*?" by probing the storage backend.
  // A replica whose database is unreachable answers `503` so an orchestrator/LB stops
  // routing ingest it could not durably store, while keeping the process alive to
  // recover. Unwired (a minimal embedding with no backend round-trip to gate on)
  // degrades to always-ready. The probe error is deliberately not echoed — `/readyz`
  // is unauthenticated, so the body stays a fixed status with no backend detail.
  const ready: RouteHandler = async () => {
    const check = deps.checkReadiness;
    if (check === undefined) {
      return json(200, { status: "ready" });
    }
    try {
      await check();
    } catch {
      return json(503, { status: "not_ready" });
    }
    return json(200, { status: "ready" });
  };

  const metricsExposition: RouteHandler = async () => {
    const registry = deps.metrics;
    if (registry === undefined) {
      // Metrics not wired (a minimal embedding) — the route effectively does not
      // exist. 404 keeps that indistinguishable from any other unknown path.
      throw new HttpError(404, "not_found", "metrics are not enabled");
    }
    // Counters are in-memory (instant); the backlog gauges are read from the queue
    // at scrape time so they are never stale. One round-trip each, in parallel.
    const [deliveryTasksByStatus, deadLettersByReason] = await Promise.all([
      deps.queue.countByStatus(),
      deps.queue.countDeadLettersByReason(),
    ]);
    const text = renderPrometheus({
      version: registry.version,
      uptimeSeconds: registry.uptimeSeconds(),
      counters: registry.counters(),
      deliveryTasksByStatus,
      deadLettersByReason,
    });
    return { status: 200, body: text, contentType: PROMETHEUS_CONTENT_TYPE };
  };

  // The OpenAPI document is static (its only variable is the build version), so it is
  // built once at construction and served verbatim — the cross-language complement to
  // the TS SDK and the source for interactive docs.
  const openApiDocument = buildOpenApiDocument();
  const openapi: RouteHandler = async () => json(200, openApiDocument);

  const createMessage: AuthedHandler = async (ctx) => {
    const body = parseJsonObject(ctx.req);
    if (!("payload" in body)) {
      throw new HttpError(400, "invalid_request", "payload is required");
    }
    // Enforce the tenant's monthly message quota *before* accepting (the freemium /
    // usage-based-pricing gate). Skipped entirely for an unlimited tenant (the default
    // null quota), so the hot path is untouched unless a limit is configured. An
    // idempotent *replay* of a message already accepted this period is exempt — it
    // creates no new message, so failing it would break idempotency (a client retrying
    // a send it already made would wrongly see 429). Soft limit: a burst of concurrent
    // sends near the ceiling can overshoot by at most the concurrency, the standard
    // trade for not serializing ingest behind a counter.
    if (ctx.app.monthlyMessageQuota !== null) {
      const rawKey = "idempotencyKey" in body ? body["idempotencyKey"] : undefined;
      const replayKey = typeof rawKey === "string" && rawKey.length > 0 ? rawKey : null;
      const isReplay =
        replayKey !== null &&
        (await deps.messages.getByIdempotencyKey(ctx.app.id, replayKey)) !== null;
      if (!isReplay) {
        const usage = await deps.messages.summarizeUsageByApp(
          ctx.app.id,
          utcMonthRange(now()),
        );
        if (isQuotaExceeded(usage.total, ctx.app.monthlyMessageQuota)) {
          throw new HttpError(
            429,
            "quota_exceeded",
            `monthly message quota of ${ctx.app.monthlyMessageQuota} reached`,
          );
        }
      }
    }
    // The delivered/signed body is the exact JSON serialization of `payload`; the
    // receiver verifies these bytes. `eventType`/`idempotencyKey` are validated by
    // the store's `normalizeNewMessage` (TypeError → 400). `appId` is the
    // authenticated tenant — never read from the body.
    const sendAtMs = parseSendAt("sendAt" in body ? body["sendAt"] : undefined);
    const expiresAtMs = parseExpiresAt("expiresAt" in body ? body["expiresAt"] : undefined);
    const priorityVal = parsePriority("priority" in body ? body["priority"] : undefined);
    const input: NewMessage = {
      appId: ctx.app.id,
      eventType: body["eventType"] as string,
      payload: JSON.stringify(body["payload"]),
      ...("idempotencyKey" in body
        ? { idempotencyKey: body["idempotencyKey"] as string | null }
        : {}),
      ...("channel" in body ? { channel: body["channel"] as string | null } : {}),
      ...(priorityVal !== undefined ? { priority: priorityVal } : {}),
      ...(sendAtMs !== null ? { deliverAt: sendAtMs } : {}),
      ...(expiresAtMs !== null ? { expiresAt: expiresAtMs } : {}),
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
        channel: result.message.channel,
        priority: result.message.priority,
        deliverAt: result.message.deliverAt,
        expiresAt: result.message.expiresAt,
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
              skippedChannel: result.fanout.skippedChannel,
              skippedFiltered: result.fanout.skippedFiltered,
            },
    });
  };

  const batchSendMessages: AuthedHandler = async (ctx) => {
    const body = parseJsonObject(ctx.req);
    if (!Array.isArray(body["messages"])) {
      throw new HttpError(400, "invalid_request", "messages must be a non-empty array");
    }
    const rawMessages = body["messages"] as unknown[];
    if (rawMessages.length === 0) {
      throw new HttpError(400, "invalid_request", "messages must be a non-empty array");
    }
    if (rawMessages.length > MAX_BATCH_MESSAGES) {
      throw new HttpError(
        400,
        "invalid_request",
        `messages may contain at most ${MAX_BATCH_MESSAGES} items`,
      );
    }

    // Compute remaining quota once for the whole batch. Replays are exempt (they
    // return the already-stored message without re-delivering), so the pre-check
    // for each idempotent item happens before decrementing.
    let quotaBudget: number | null = null; // null = unlimited
    if (ctx.app.monthlyMessageQuota !== null) {
      const usage = await deps.messages.summarizeUsageByApp(ctx.app.id, utcMonthRange(now()));
      quotaBudget = Math.max(0, ctx.app.monthlyMessageQuota - usage.total);
    }

    let consumed = 0; // new (non-duplicate) messages accepted so far in this batch
    const results: unknown[] = [];

    for (const rawMsg of rawMessages) {
      if (rawMsg === null || typeof rawMsg !== "object" || Array.isArray(rawMsg)) {
        results.push({
          ok: false,
          ...errorEnvelope("invalid_request", "each message must be a JSON object"),
        });
        continue;
      }
      const msg = rawMsg as Record<string, unknown>;
      if (!("payload" in msg)) {
        results.push({
          ok: false,
          ...errorEnvelope("invalid_request", "payload is required"),
        });
        continue;
      }

      // Quota pre-flight: idempotent replays are exempt; everything else counts.
      if (quotaBudget !== null) {
        const rawKey = "idempotencyKey" in msg ? msg["idempotencyKey"] : undefined;
        const lookupKey = typeof rawKey === "string" && rawKey.length > 0 ? rawKey : null;
        const isReplay =
          lookupKey !== null &&
          (await deps.messages.getByIdempotencyKey(ctx.app.id, lookupKey)) !== null;
        if (!isReplay && consumed >= quotaBudget) {
          results.push({
            ok: false,
            ...errorEnvelope(
              "quota_exceeded",
              `monthly message quota of ${ctx.app.monthlyMessageQuota} reached`,
            ),
          });
          continue;
        }
      }

      try {
        const itemSendAtMs = parseSendAt("sendAt" in msg ? msg["sendAt"] : undefined);
        const itemExpiresAtMs = parseExpiresAt("expiresAt" in msg ? msg["expiresAt"] : undefined);
        const itemPriorityVal = parsePriority("priority" in msg ? msg["priority"] : undefined);
        const input: NewMessage = {
          appId: ctx.app.id,
          eventType: msg["eventType"] as string,
          payload: JSON.stringify(msg["payload"]),
          ...("idempotencyKey" in msg
            ? { idempotencyKey: msg["idempotencyKey"] as string | null }
            : {}),
          ...("channel" in msg ? { channel: msg["channel"] as string | null } : {}),
          ...(itemPriorityVal !== undefined ? { priority: itemPriorityVal } : {}),
          ...(itemSendAtMs !== null ? { deliverAt: itemSendAtMs } : {}),
          ...(itemExpiresAtMs !== null ? { expiresAt: itemExpiresAtMs } : {}),
        };
        const result = await ingest(input, {
          messages: deps.messages,
          endpoints: deps.endpoints,
          queue: deps.queue,
        });
        deps.metrics?.recordIngest({ deduplicated: result.deduplicated });
        if (!result.deduplicated) {
          consumed++;
        }
        results.push({
          ok: true,
          message: {
            id: result.message.id,
            appId: result.message.appId,
            eventType: result.message.eventType,
            idempotencyKey: result.message.idempotencyKey,
            channel: result.message.channel,
            priority: result.message.priority,
            deliverAt: result.message.deliverAt,
            expiresAt: result.message.expiresAt,
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
                  skippedChannel: result.fanout.skippedChannel,
                  skippedFiltered: result.fanout.skippedFiltered,
                },
        });
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          results.push({
            ok: false,
            ...errorEnvelope("idempotency_conflict", (err as Error).message),
          });
        } else if (err instanceof TypeError) {
          results.push({
            ok: false,
            ...errorEnvelope("invalid_request", (err as TypeError).message),
          });
        } else {
          throw err; // unexpected — let the outer error handler render a 500
        }
      }
    }

    return json(200, { results });
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

  const listMessageAttempts: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const message = await deps.messages.get(id);
    // Tenancy from the key; another tenant's (or an absent) message is 404 —
    // existence is never revealed, identical to the read/retry routes above.
    if (message === null || message.appId !== ctx.app.id) {
      throw new HttpError(404, "not_found", `no message with id "${id}"`);
    }
    const page = await deps.attempts.listByMessage(
      id,
      parseListAttemptsParams(ctx.req.query),
    );
    return json(200, { data: page.data.map(attemptView), nextCursor: page.nextCursor });
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

  const cancelMessage: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const message = await deps.messages.get(id);
    if (message === null || message.appId !== ctx.app.id) {
      throw new HttpError(404, "not_found", `no message with id "${id}"`);
    }
    const result = await cancelMessageDeliveries(id, { queue: deps.queue });
    return json(200, {
      id: message.id,
      cancelled: result.cancelled,
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
      ...("headers" in body
        ? { headers: body["headers"] as Record<string, string> | null }
        : {}),
      ...("retryPolicy" in body
        ? { retryPolicy: body["retryPolicy"] as RetryPolicy | null }
        : {}),
      ...("filter" in body
        ? { filter: body["filter"] as EndpointFilter | null }
        : {}),
      ...("channel" in body ? { channel: body["channel"] as string | null } : {}),
      ...("rateLimit" in body ? { rateLimit: body["rateLimit"] as number | null } : {}),
    };
    // SSRF guard: reject a destination that points at a private/internal address
    // before it is ever stored (BlockedUrlError → 400 url_not_allowed).
    assertUrlDeliverable(input.url, ssrfPolicy);
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
      ...("headers" in body
        ? { headers: body["headers"] as Record<string, string> | null }
        : {}),
      ...("retryPolicy" in body
        ? { retryPolicy: body["retryPolicy"] as RetryPolicy | null }
        : {}),
      ...("filter" in body
        ? { filter: body["filter"] as EndpointFilter | null }
        : {}),
      ...("channel" in body ? { channel: body["channel"] as string | null } : {}),
      ...("rateLimit" in body ? { rateLimit: body["rateLimit"] as number | null } : {}),
    };
    // SSRF guard: re-check on update, but only when the URL is actually changing
    // (an unrelated patch must not be blocked by a pre-existing internal URL).
    if (patch.url !== undefined) {
      assertUrlDeliverable(patch.url, ssrfPolicy);
    }
    const updated = await deps.endpoints.update(id, patch);
    return json(200, endpointView(updated));
  };

  const deleteEndpoint: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    await loadOwnedEndpoint(ctx.app.id, id); // 404 unless it is the caller's
    await deps.endpoints.delete(id);
    return { status: 204, body: undefined };
  };

  const rotateEndpointSecret: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    await loadOwnedEndpoint(ctx.app.id, id); // 404 unless it is the caller's
    // The body is optional: an empty body means "generate a fresh secret, default
    // overlap" (the common case). When present, it may set `secret` and/or
    // `overlapMs`; both are validated by the store's pure rotateEndpointSecret
    // (TypeError → 400).
    const options: { secret?: string; overlapMs?: number } = {};
    if (ctx.req.rawBody.length > 0) {
      const body = parseJsonObject(ctx.req);
      if ("secret" in body) options.secret = body["secret"] as string;
      if ("overlapMs" in body) options.overlapMs = body["overlapMs"] as number;
    }
    const rotated = await deps.endpoints.rotateSecret(
      id,
      options satisfies RotateSecretOptions,
    );
    // Like create, the NEW primary secret is revealed exactly once here so the
    // tenant can configure receiver-side verification; the prior secret keeps
    // verifying through the overlap window. Retired secrets are never exposed.
    return json(200, { ...endpointView(rotated), secret: rotated.secret });
  };

  const testEndpoint: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const endpoint = await loadOwnedEndpoint(ctx.app.id, id);
    if (endpoint.disabled) {
      throw new HttpError(400, "endpoint_disabled", "cannot test a disabled endpoint");
    }
    // Body is entirely optional. Default: a generic test event.
    let eventType = "test";
    let payload = JSON.stringify({ test: true });
    if (ctx.req.rawBody.length > 0) {
      const parsed = parseJsonObject(ctx.req);
      if ("eventType" in parsed && typeof parsed["eventType"] === "string") {
        eventType = parsed["eventType"];
      }
      if ("payload" in parsed && parsed["payload"] !== undefined) {
        payload = JSON.stringify(parsed["payload"]);
      }
    }
    // Synthetic message — not stored, not queued, not counted against quota.
    const now = (deps.now ?? Date.now)();
    const syntheticMessage = {
      id: `test_${randomUUID()}`,
      appId: ctx.app.id,
      eventType,
      payload,
      idempotencyKey: null,
      channel: null,
      deliverAt: null,
      expiresAt: null,
      priority: "normal" as const,
      createdAt: now,
      fanoutPending: false,
    };
    const target = endpointToDeliveryTarget(endpoint, now);
    const signedReq = buildSignedRequest(syntheticMessage, target, now);
    const send = deps.transport ?? fetchTransport;
    const timeoutMs = deps.testRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer =
      controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const sentAt = Date.now();
    let httpStatus: number | undefined;
    let error: string | undefined;
    try {
      const response = await send(signedReq, controller?.signal ?? new AbortController().signal);
      httpStatus = response.status;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const durationMs = Date.now() - sentAt;
    const success = httpStatus !== undefined && isSuccessStatus(httpStatus);
    return json(200, {
      success,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(error !== undefined ? { error } : {}),
      durationMs,
    });
  };

  const getEndpointDeliveries: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    // Ownership check: another tenant's (or an absent) endpoint is 404 — existence
    // is never revealed, consistent with every other endpoint route.
    await loadOwnedEndpoint(ctx.app.id, id);
    const page = await deps.queue.listByEndpoint(
      id,
      parseListDeliveriesParams(ctx.req.query),
    );
    return json(200, {
      data: page.deliveries.map(endpointDeliveryView),
      nextCursor: page.nextCursor,
    });
  };

  const retryEndpointAllDeliveries: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    await loadOwnedEndpoint(ctx.app.id, id);
    const result: BulkRetryResult = await retryEndpointDeliveries(id, {
      queue: deps.queue,
    });
    return json(200, result);
  };

  const replayEndpoint: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const endpoint = await loadOwnedEndpoint(ctx.app.id, id);
    // Body is optional — all fields have defaults. Only parse when present.
    let since: number | null = null;
    let until: number | null = null;
    let limit: number | undefined;
    if (ctx.req.rawBody.length > 0) {
      const body = parseJsonObject(ctx.req);
      if ("since" in body) {
        const raw = body["since"];
        if (raw !== null && raw !== undefined) {
          const val = Number(raw);
          if (!Number.isFinite(val) || val < 0) {
            throw new HttpError(400, "invalid_request", "since must be a non-negative epoch-ms number");
          }
          since = val;
        }
      }
      if ("until" in body) {
        const raw = body["until"];
        if (raw !== null && raw !== undefined) {
          const val = Number(raw);
          if (!Number.isFinite(val) || val < 0) {
            throw new HttpError(400, "invalid_request", "until must be a non-negative epoch-ms number");
          }
          until = val;
        }
      }
      if ("limit" in body && body["limit"] !== undefined && body["limit"] !== null) {
        limit = body["limit"] as number;
      }
    }
    // normalizeReplayLimit validates the limit range and applies the default.
    // An out-of-range limit throws RangeError, which toErrorResponse maps to 400.
    const result: ReplayResult = await replayEndpointMessages(
      endpoint,
      { messages: deps.messages, queue: deps.queue },
      { since, until, ...(limit !== undefined ? { limit } : {}) },
    );
    return json(200, result);
  };

  const getEndpointStats: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    // Ownership check — another tenant's (or absent) endpoint is 404, same as every
    // other endpoint sub-route. Stats expose delivery data; we must never return
    // another tenant's stats even if the endpointId is guessed correctly.
    await loadOwnedEndpoint(ctx.app.id, id);
    // Parse ?days=N (1..MAX_STATS_DAYS). Default: DEFAULT_STATS_DAYS.
    const rawDays = ctx.req.query["days"];
    let days = DEFAULT_STATS_DAYS;
    if (rawDays !== undefined) {
      const parsed = Number(rawDays);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_STATS_DAYS) {
        throw new HttpError(
          400,
          "invalid_request",
          `days must be an integer in [1, ${MAX_STATS_DAYS}]`,
        );
      }
      days = parsed;
    }
    const toMs = now();
    const fromMs = toMs - days * USAGE_DAY_MS;
    const stats: EndpointStats = await deps.attempts.statsByEndpoint(id, { fromMs, toMs });
    return json(200, stats);
  };

  const getAppDeliveries: AuthedHandler = async (ctx) => {
    const page = await deps.queue.listByApp(
      ctx.app.id,
      parseListByAppParams(ctx.req.query),
    );
    return json(200, {
      data: page.deliveries.map(endpointDeliveryView),
      nextCursor: page.nextCursor,
    });
  };

  const getDelivery: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const task = await deps.queue.get(id);
    // Tenancy from the key; another tenant's (or absent) delivery is 404 — existence
    // is never revealed, consistent with all other tenant-scoped resource routes.
    if (task === null || task.appId !== ctx.app.id) {
      throw new HttpError(404, "not_found", `no delivery with id "${id}"`);
    }
    return json(200, endpointDeliveryView(task));
  };

  const listDeliveryAttempts: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const task = await deps.queue.get(id);
    if (task === null || task.appId !== ctx.app.id) {
      throw new HttpError(404, "not_found", `no delivery with id "${id}"`);
    }
    const page = await deps.attempts.listByTask(id, parseListAttemptsParams(ctx.req.query));
    return json(200, { data: page.data.map(attemptView), nextCursor: page.nextCursor });
  };

  const retryAllDeliveries: AuthedHandler = async (ctx) => {
    const result: BulkRetryResult = await retryAppDeliveries(ctx.app.id, {
      queue: deps.queue,
    });
    return json(200, result);
  };

  const getUsage: AuthedHandler = async (ctx) => {
    // The tenant's *own* usage + live quota status — the self-service counterpart to
    // the admin metering route (`GET /v1/admin/apps/:id/usage`), scoped to the key's
    // tenant (never a body/path appId). The current UTC month is both the natural
    // self-service default and the quota-enforcement window.
    const monthRange = utcMonthRange(now());
    // Default the breakdown to the current month; a caller may request any historical
    // window with ?from=&to= (the same inclusive-day contract as the admin route — a
    // partial or malformed range is a 400 via parseUsageRangeParams).
    const hasRangeQuery =
      ctx.req.query["from"] !== undefined || ctx.req.query["to"] !== undefined;
    const range = hasRangeQuery ? parseUsageRangeParams(ctx.req.query) : monthRange;
    const summary = await deps.messages.summarizeUsageByApp(ctx.app.id, range);
    // The delivery-attempt (operations) breakdown over the same range — what Posthorn
    // actually delivered for this tenant, retries included.
    const deliveries = await deps.attempts.summarizeAttemptsByApp(ctx.app.id, range);
    // The quota block always reflects the *current* month. Reuse the summary's total
    // when the queried range already is the current month (the default — one store
    // call); only a custom range needs a second count.
    const monthUsed = hasRangeQuery
      ? (await deps.messages.summarizeUsageByApp(ctx.app.id, monthRange)).total
      : summary.total;
    return json(200, tenantUsageView(summary, deliveries, ctx.app, monthUsed, monthRange));
  };

  // --- Admin / control-plane handlers ---------------------------------------
  // These provision tenants and API keys cross-tenant; they receive a BaseContext
  // (no resolved `app`) and are gated by `adminAuthed`, not `authed`.

  const createApp: RouteHandler = async (ctx) => {
    // The body is optional: no body creates an unnamed, custom-plan, unlimited app.
    // When present, `name`, `plan`, `monthlyMessageQuota`, and `systemWebhookUrl` are
    // validated by the store's normalizeNewApp (TypeError → 400). Assigning a `plan`
    // stamps its quota unless an explicit `monthlyMessageQuota` overrides it.
    const body = ctx.req.rawBody.length > 0 ? parseJsonObject(ctx.req) : {};
    // Reject a private/internal system webhook URL before it is stored, mirroring the
    // endpoint-URL guard (BlockedUrlError → 400 url_not_allowed). The system-event send
    // is also guarded at connection time (the gateway's guarded transport); both layers
    // share the allowPrivateNetworks opt-out. A non-string (incl. null = clear) defers to
    // the store's syntactic validation.
    if (typeof body["systemWebhookUrl"] === "string") {
      assertUrlDeliverable(body["systemWebhookUrl"], ssrfPolicy);
    }
    const input: NewApp = {
      ...("name" in body ? { name: body["name"] as string } : {}),
      ...("plan" in body ? { plan: body["plan"] as PlanId | null } : {}),
      ...("monthlyMessageQuota" in body
        ? { monthlyMessageQuota: body["monthlyMessageQuota"] as number | null }
        : {}),
      ...("systemWebhookUrl" in body
        ? { systemWebhookUrl: body["systemWebhookUrl"] as string | null }
        : {}),
    };
    const app = await deps.apps.create(input);
    // Return the create view — includes the one-time systemWebhookSecret.
    return json(201, createdAppView(app));
  };

  const updateApp: RouteHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const body = parseJsonObject(ctx.req);
    // Reject a private/internal system webhook URL before it is stored — same guard as
    // create (BlockedUrlError → 400 url_not_allowed). `null` (clear the webhook) and any
    // non-string skip this and defer to applyAppUpdate's syntactic validation.
    if (typeof body["systemWebhookUrl"] === "string") {
      assertUrlDeliverable(body["systemWebhookUrl"], ssrfPolicy);
    }
    // Only the patchable fields are forwarded; values are validated by applyAppUpdate
    // (TypeError → 400). Assigning a `plan` re-stamps its catalog quota; an explicit
    // `monthlyMessageQuota` overrides it (null removes the limit). `systemWebhookUrl`
    // null clears the system webhook. An unknown app throws UnknownAppError → 404.
    const patch: AppUpdate = {
      ...("name" in body ? { name: body["name"] as string } : {}),
      ...("plan" in body ? { plan: body["plan"] as PlanId | null } : {}),
      ...("monthlyMessageQuota" in body
        ? { monthlyMessageQuota: body["monthlyMessageQuota"] as number | null }
        : {}),
      ...("systemWebhookUrl" in body
        ? { systemWebhookUrl: body["systemWebhookUrl"] as string | null }
        : {}),
    };
    const app = await deps.apps.update(id, patch);
    return json(200, appView(app));
  };

  const listApps: RouteHandler = async () => {
    const apps = await deps.apps.list();
    return json(200, { data: apps.map(appView) });
  };

  const getApp: RouteHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const app = await deps.apps.get(id);
    if (app === null) {
      throw new HttpError(404, "not_found", `no app with id "${id}"`);
    }
    return json(200, appView(app));
  };

  const deleteApp: RouteHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    // Cascade-deletes the app's API keys (see AppStore.delete). An unknown app is
    // 404 so a delete is never silently a no-op.
    const existed = await deps.apps.delete(id);
    if (!existed) {
      throw new HttpError(404, "not_found", `no app with id "${id}"`);
    }
    return { status: 204, body: undefined };
  };

  const createApiKey: RouteHandler = async (ctx) => {
    const appId = requireParam(ctx.params, "id");
    // createApiKey throws UnknownAppError for an unknown app → mapped to 404.
    const created = await deps.apps.createApiKey(appId);
    // The plaintext secret is revealed exactly once, here (the store keeps only its
    // hash) — the same secret-once rule as endpoint create. Persist it now.
    return json(201, { apiKey: apiKeyView(created.apiKey), secret: created.secret });
  };

  const listApiKeys: RouteHandler = async (ctx) => {
    const appId = requireParam(ctx.params, "id");
    // Distinguish "unknown app" (404) from "app with no keys" (200, empty) — the
    // same distinction the `posthorn admin list-keys` CLI makes.
    if ((await deps.apps.get(appId)) === null) {
      throw new HttpError(404, "not_found", `no app with id "${appId}"`);
    }
    const keys = await deps.apps.listApiKeys(appId);
    return json(200, { data: keys.map(apiKeyView) });
  };

  const revokeApiKey: RouteHandler = async (ctx) => {
    const keyId = requireParam(ctx.params, "id");
    const revoked = await deps.apps.revokeApiKey(keyId);
    if (!revoked) {
      // Unknown id or already-revoked: the store cannot tell them apart, and neither
      // should the surface (it reveals nothing about which keys ever existed).
      throw new HttpError(404, "not_found", `no live key with id "${keyId}"`);
    }
    return { status: 204, body: undefined };
  };

  const rotateSystemWebhookSecret: RouteHandler = async (ctx) => {
    const appId = requireParam(ctx.params, "id");
    // Unknown app throws UnknownAppError → 404.
    const newSecret = await deps.apps.rotateSystemWebhookSecret(appId);
    // Return the new secret once — the store keeps only its stored form.
    return json(201, { secret: newSecret });
  };

  const getAppUsage: RouteHandler = async (ctx) => {
    const appId = requireParam(ctx.params, "id");
    // An unknown tenant is 404; a known tenant with no traffic is a 200 with total 0
    // — the same "unknown app vs. empty" distinction listApiKeys makes.
    if ((await deps.apps.get(appId)) === null) {
      throw new HttpError(404, "not_found", `no app with id "${appId}"`);
    }
    const range = parseUsageRangeParams(ctx.req.query);
    const summary = await deps.messages.summarizeUsageByApp(appId, range);
    const deliveries = await deps.attempts.summarizeAttemptsByApp(appId, range);
    return json(200, usageView(summary, deliveries));
  };

  function eventTypeView(et: EventType): Record<string, unknown> {
    return {
      id: et.id,
      appId: et.appId,
      name: et.name,
      description: et.description,
      schemaExample: et.schemaExample,
      archived: et.archived,
      createdAt: et.createdAt,
      updatedAt: et.updatedAt,
    };
  }

  const listEventTypes: AuthedHandler = async (ctx) => {
    const includeArchived = ctx.req.query["includeArchived"] === "true";
    const list = await deps.eventTypes.list(ctx.app.id, { includeArchived });
    return json(200, { data: list.map(eventTypeView) });
  };

  const createEventType: AuthedHandler = async (ctx) => {
    const body = parseJsonObject(ctx.req);
    if (!("id" in body)) {
      throw new HttpError(400, "invalid_request", "id is required");
    }
    if (!("name" in body)) {
      throw new HttpError(400, "invalid_request", "name is required");
    }
    const input = {
      appId: ctx.app.id,
      id: body["id"] as string,
      name: body["name"] as string,
      ...("description" in body ? { description: body["description"] as string | null } : {}),
      ...("schemaExample" in body ? { schemaExample: body["schemaExample"] as string | null } : {}),
    };
    try {
      const et = await deps.eventTypes.create(input);
      return json(201, eventTypeView(et));
    } catch (err) {
      if (err instanceof DuplicateEventTypeError) {
        return json(409, errorEnvelope("conflict", err.message));
      }
      throw err;
    }
  };

  const getEventType: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const et = await deps.eventTypes.get(ctx.app.id, id);
    if (et === null) {
      throw new HttpError(404, "not_found", `no event type with id "${id}"`);
    }
    return json(200, eventTypeView(et));
  };

  const updateEventType: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    const body = parseJsonObject(ctx.req);
    const patch = {
      ...("name" in body ? { name: body["name"] as string } : {}),
      ...("description" in body ? { description: body["description"] as string | null } : {}),
      ...("schemaExample" in body ? { schemaExample: body["schemaExample"] as string | null } : {}),
    };
    try {
      const et = await deps.eventTypes.update(ctx.app.id, id, patch);
      return json(200, eventTypeView(et));
    } catch (err) {
      if (err instanceof UnknownEventTypeError) {
        return json(404, errorEnvelope("not_found", err.message));
      }
      throw err;
    }
  };

  const archiveEventType: AuthedHandler = async (ctx) => {
    const id = requireParam(ctx.params, "id");
    await deps.eventTypes.archive(ctx.app.id, id);
    return { status: 204, body: undefined };
  };

  // Maximum portal session TTL the caller can request (7 days in seconds).
  const MAX_PORTAL_EXPIRES_IN_S = 7 * 24 * 60 * 60;
  // Default portal session TTL (24 h in seconds).
  const DEFAULT_PORTAL_EXPIRES_IN_S = 24 * 60 * 60;

  const createPortalSession: AuthedHandler = async (ctx) => {
    if (deps.portalSessions === undefined) {
      // Portal feature disabled on this instance (no session store wired).
      return json(404, errorEnvelope("not_found", "portal is not enabled on this instance"));
    }
    const body = parseJsonObject(ctx.req);
    const rawUserId = body["externalUserId"];
    if (typeof rawUserId !== "string" || rawUserId.trim().length === 0) {
      throw new HttpError(400, "invalid_request", "externalUserId must be a non-empty string");
    }
    const externalUserId = rawUserId.trim();

    let expiresInS = DEFAULT_PORTAL_EXPIRES_IN_S;
    if ("expiresIn" in body) {
      const raw = body["expiresIn"];
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
        throw new HttpError(400, "invalid_request", "expiresIn must be a positive integer (seconds)");
      }
      if (raw > MAX_PORTAL_EXPIRES_IN_S) {
        throw new HttpError(
          400,
          "invalid_request",
          `expiresIn must not exceed ${MAX_PORTAL_EXPIRES_IN_S} (7 days)`,
        );
      }
      expiresInS = raw;
    }

    const nowMs = (deps.now ?? Date.now)();
    const ttlMs = expiresInS * 1000;
    const token = deps.portalSessions.createSession(ctx.app.id, externalUserId, nowMs, ttlMs);
    const expiresAt = nowMs + ttlMs;

    // Build the portal URL the caller can redirect the end-user to. When the operator
    // has configured a canonical public base URL (POSTHORN_PUBLIC_BASE_URL) it is
    // authoritative — the correct posture behind a host-rewriting proxy, where the
    // inbound Host header is the gateway's *internal* name rather than the public one,
    // and it never builds an operator-facing link out of a client-settable header.
    // Otherwise derive the origin from the request: `x-forwarded-proto` (set by common
    // reverse proxies) upgrades the scheme to `https` for TLS-terminated deployments,
    // read through the shared leftmost-token parse — a proxy chain sends a comma list
    // (`https, http`), so a naive whole-value read would render `https, http://host`.
    let origin: string;
    if (deps.publicBaseUrl !== undefined && deps.publicBaseUrl.length > 0) {
      origin = deps.publicBaseUrl;
    } else {
      const proto = forwardedProtoIsHttps(ctx.req.headers["x-forwarded-proto"]) ? "https" : "http";
      const host = ctx.req.headers["host"] ?? "localhost";
      origin = `${proto}://${host}`;
    }
    const portalUrl = `${origin}/portal/login?token=${token}`;

    return json(201, { token, portalUrl, expiresAt });
  };

  // POST /v1/billing/webhook — the inbound provider webhook. Unlike every other v1
  // route it is **not** tenant-authenticated: the request is authenticated by the
  // provider's webhook *signature*, verified inside the provider against the raw body.
  // The route is `404` unless a billing provider with a configured webhook secret is
  // wired (`webhookConfigured`), the same opt-in posture as the admin API — so an
  // instance with billing off, or Stripe on but no webhook secret, never reveals the
  // route exists. A signature/verification failure maps to `400 invalid_request`; a
  // verified-but-unrecognized event still returns `200` (`handled: false`) so the
  // processor stops retrying (only the signature gate is fatal).
  // --- Self-serve signup (public, opt-in) -----------------------------------
  // The one unauthenticated write route: it bootstraps a tenant + its first API key so
  // a user can onboard without an operator. Disabled by default (`404`, exactly like a
  // disabled admin route); when enabled it is rate-limited gateway-wide. One limiter
  // instance per gateway — in-process, not coordinated across replicas (the same caveat
  // as delivery rate limiting), which is acceptable for a coarse anti-spray cap.
  const signupRateLimiter = new SlidingWindowRateLimiter();
  const createSignup: RouteHandler = async (ctx) => {
    const signup = deps.signup;
    if (signup === undefined || !signup.enabled) {
      // Hidden exactly like a disabled admin route — never reveal the surface exists.
      throw new HttpError(404, "not_found", `no route for ${ctx.req.method} ${ctx.req.path}`);
    }
    // Rate-limit before any work, counting every attempt (not just successes), so a
    // flood of malformed bodies cannot slip past the cap. A single global bucket: the
    // socket-agnostic core has no trustworthy client IP, and `X-Forwarded-For` is
    // spoofable, so a per-IP key would be both impossible here and trivially evaded.
    const nowMs = now();
    const gate = signupRateLimiter.tryConsume("signup", signup.ratePerMinute, nowMs);
    if (!gate.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((gate.retryAt - nowMs) / 1000));
      return json(429, errorEnvelope("rate_limited", "signup rate limit exceeded; retry later"), {
        "retry-after": String(retryAfterSeconds),
      });
    }
    // The body is optional; only `name` is honored. The plan is forced to "free" — a
    // self-serve tenant can never grant itself a paid tier or a custom quota.
    const body = ctx.req.rawBody.length > 0 ? parseJsonObject(ctx.req) : {};
    const input: NewApp = {
      plan: "free",
      ...("name" in body ? { name: body["name"] as string } : {}),
    };
    const app = await deps.apps.create(input);
    // Mint the tenant's first API key. The plaintext secret is revealed exactly once,
    // here (the store keeps only its hash) — the caller must persist it now.
    const key = await deps.apps.createApiKey(app.id);
    return json(201, {
      app: createdAppView(app),
      apiKey: apiKeyView(key.apiKey),
      secret: key.secret,
    });
  };

  const billingWebhook: RouteHandler = async (ctx) => {
    const provider = deps.billing;
    if (provider === undefined || !provider.webhookConfigured) {
      throw new HttpError(404, "not_found", `no route for ${ctx.req.method} ${ctx.req.path}`);
    }
    try {
      const result = await provider.handleWebhook(ctx.req.rawBody, ctx.req.headers, now());
      return json(200, { received: true, handled: result.handled, type: result.type });
    } catch (err) {
      if (err instanceof StripeSignatureError) {
        // Fixed message — never echo the verifier's detail (which could hint at the
        // failure mode); the StripeSignatureError itself never carries the digest.
        throw new HttpError(
          400,
          "invalid_request",
          "billing webhook signature verification failed",
        );
      }
      throw err;
    }
  };

  // One handler per route key. The `Record<ApiRouteKey, …>` type makes this
  // exhaustive: a missing key or a stray extra key is a compile error, so the route
  // table and {@link API_ROUTE_KEYS} (and therefore the OpenAPI document) cannot drift.
  const handlers: Record<ApiRouteKey, RouteHandler> = {
    "GET /healthz": health,
    "GET /readyz": ready,
    "GET /metrics": metricsExposition,
    "GET /openapi.json": openapi,
    // Gating (opt-in 404 + rate limit) lives inside the handler, so it is registered
    // unwrapped — it is neither tenant- nor admin-authenticated.
    "POST /v1/signup": createSignup,
    "POST /v1/messages": authed(createMessage),
    "POST /v1/messages/batch": authed(batchSendMessages),
    "GET /v1/messages": authed(listMessages),
    "GET /v1/messages/:id": authed(getMessage),
    "GET /v1/messages/:id/attempts": authed(listMessageAttempts),
    "POST /v1/messages/:id/retry": authed(retryMessage),
    "POST /v1/messages/:id/cancel": authed(cancelMessage),
    "GET /v1/endpoints": authed(listEndpoints),
    "POST /v1/endpoints": authed(createEndpoint),
    "GET /v1/endpoints/:id": authed(getEndpoint),
    "PATCH /v1/endpoints/:id": authed(updateEndpoint),
    "DELETE /v1/endpoints/:id": authed(deleteEndpoint),
    "POST /v1/endpoints/:id/rotate-secret": authed(rotateEndpointSecret),
    "POST /v1/endpoints/:id/test": authed(testEndpoint),
    "GET /v1/endpoints/:id/deliveries": authed(getEndpointDeliveries),
    "POST /v1/endpoints/:id/deliveries/retry": authed(retryEndpointAllDeliveries),
    "POST /v1/endpoints/:id/replay": authed(replayEndpoint),
    "GET /v1/endpoints/:id/stats": authed(getEndpointStats),
    "GET /v1/deliveries": authed(getAppDeliveries),
    "GET /v1/deliveries/:id": authed(getDelivery),
    "GET /v1/deliveries/:id/attempts": authed(listDeliveryAttempts),
    "POST /v1/deliveries/retry": authed(retryAllDeliveries),
    "GET /v1/usage": authed(getUsage),
    "POST /v1/portal/sessions": authed(createPortalSession),
    "GET /v1/event-types": authed(listEventTypes),
    "POST /v1/event-types": authed(createEventType),
    "GET /v1/event-types/:id": authed(getEventType),
    "PATCH /v1/event-types/:id": authed(updateEventType),
    "DELETE /v1/event-types/:id": authed(archiveEventType),
    "POST /v1/billing/webhook": billingWebhook,
    "POST /v1/admin/apps": adminAuthed(createApp),
    "GET /v1/admin/apps": adminAuthed(listApps),
    "GET /v1/admin/apps/:id": adminAuthed(getApp),
    "PATCH /v1/admin/apps/:id": adminAuthed(updateApp),
    "DELETE /v1/admin/apps/:id": adminAuthed(deleteApp),
    "POST /v1/admin/apps/:id/keys": adminAuthed(createApiKey),
    "GET /v1/admin/apps/:id/keys": adminAuthed(listApiKeys),
    "GET /v1/admin/apps/:id/usage": adminAuthed(getAppUsage),
    "POST /v1/admin/apps/:id/rotate-system-secret": adminAuthed(rotateSystemWebhookSecret),
    "DELETE /v1/admin/keys/:id": adminAuthed(revokeApiKey),
  };

  const routes: readonly Route<RouteHandler>[] = defineRoutes<RouteHandler>(
    API_ROUTE_KEYS.map((key) => {
      const { method, pattern } = splitRouteKey(key);
      return { method, pattern, handler: handlers[key] };
    }),
  );

  return async (req) => {
    const lookup = matchRoute(routes, req.method, req.path);
    if (lookup.kind === "notFound") {
      return json(404, errorEnvelope("not_found", `no route for ${req.method} ${req.path}`));
    }
    if (lookup.kind === "methodNotAllowed") {
      return json(
        405,
        errorEnvelope("method_not_allowed", `${req.method} not allowed on ${req.path}`),
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
