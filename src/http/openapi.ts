/**
 * The OpenAPI 3.1 description of Posthorn's v1 HTTP surface — the machine-readable
 * contract that lets *any* language generate a typed client and renders interactive
 * docs (Swagger UI / Redoc), the cross-language complement to the TS SDK.
 *
 * It is **hand-authored** rather than reflected out of the handler, because a useful
 * spec carries far more than the route table: per-field descriptions, request/response
 * schemas, error codes, examples, and the security model. What stops it from silently
 * drifting from the real router is not generation but a **conformance test** — exactly
 * the discipline the rest of the codebase uses for its dual store backends: the spec's
 * documented operations are asserted, in both directions, to equal the router's single
 * source of truth (`API_ROUTE_KEYS` in `api.ts`). A route added without a doc entry (or
 * vice versa) fails the build, so "the spec matches the API" is a proven fact, not a hope.
 *
 * Zero runtime dependencies (the same posture as `node:sqlite`/`node:http`/`node:crypto`):
 * the document is a plain JSON-serializable object built by a pure function, served
 * verbatim at `GET /openapi.json`. The version is read from `package.json` (via the same
 * `version.ts` seam `/metrics` uses), so the published spec always names the running build.
 */

import {
  MAX_LIST_MESSAGES_LIMIT,
  MAX_USAGE_RANGE_DAYS,
} from "../storage/message-store.js";
import {
  DEFAULT_STATS_DAYS,
  MAX_CAPTURED_BODY_BYTES,
  MAX_LIST_ATTEMPTS_LIMIT,
  MAX_STATS_DAYS,
} from "../attempts/delivery-attempt.js";
import { MAX_LIST_DELIVERIES_LIMIT } from "../queue/delivery-queue.js";
import { MAX_REPLAY_LIMIT } from "../queue/replay-endpoint.js";
import { PLAN_IDS } from "../apps/plan.js";
import { DELIVERY_FAILURE_REASONS } from "../delivery/failure-reason.js";
import { API_ERROR_CODES } from "./error-codes.js";
import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_NON_RETRYABLE_STATUSES,
  MAX_RETRY_POLICY_DELAY_MS,
  MAX_RETRY_POLICY_RETRIES,
} from "../endpoints/endpoint.js";
import { POSTHORN_VERSION } from "../version.js";

/** A JSON Schema / OpenAPI schema object (or a `$ref`). Loosely typed on purpose. */
type SchemaObject = Record<string, unknown>;

/** The shape of the document {@link buildOpenApiDocument} returns. */
export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly summary: string;
    readonly description: string;
    readonly license: { readonly name: string; readonly identifier: string };
  };
  readonly servers: readonly { readonly url: string; readonly description: string }[];
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  /** Global default: every operation requires the Bearer scheme unless it overrides with `security: []`. */
  readonly security: readonly Record<string, readonly string[]>[];
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    readonly securitySchemes: Record<string, unknown>;
    readonly schemas: Record<string, SchemaObject>;
  };
}

/** A `$ref` to a named component schema. */
const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });

/** A nullable reference — `anyOf: [<ref>, null]`, the OpenAPI 3.1 idiom. */
const nullableRef = (name: string): SchemaObject => ({
  anyOf: [ref(name), { type: "null" }],
});

/** A JSON request body wrapping a schema. */
const jsonBody = (schema: SchemaObject): Record<string, unknown> => ({
  required: true,
  content: { "application/json": { schema } },
});

/** A JSON response with a description and a body schema. */
const jsonResponse = (description: string, schema: SchemaObject): Record<string, unknown> => ({
  description,
  content: { "application/json": { schema } },
});

/** A standard error-envelope response. */
const errorResponse = (description: string): Record<string, unknown> =>
  jsonResponse(description, ref("Error"));

/**
 * A `400` response for a route that runs the SSRF URL guard
 * ({@link assertUrlDeliverable} in `api.ts`). Beyond the route's own validation
 * errors (carried by `description`), a destination URL that resolves to a
 * private/internal address is rejected with the stable `url_not_allowed` code.
 * Both the description (human-facing) and a concrete envelope `example`
 * (machine-facing) surface it, so SDK/codegen consumers can branch on it.
 * One shared definition keeps the four URL-guarded routes from drifting apart.
 */
const urlGuardedErrorResponse = (description: string): Record<string, unknown> => ({
  description:
    `${description} A URL whose host is (or resolves to) a private or internal address ` +
    "is rejected with `url_not_allowed`.",
  content: {
    "application/json": {
      schema: ref("Error"),
      examples: {
        url_not_allowed: {
          summary: "The destination URL targets a private/internal address",
          value: {
            error: {
              code: "url_not_allowed",
              message:
                'webhook destination host "10.0.0.1" is a private or internal address; ' +
                "set POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true to allow delivery to private networks",
            },
          },
        },
      },
    },
  },
});

/** An epoch-millisecond timestamp. */
const epochMs = (description: string): SchemaObject => ({
  type: "integer",
  format: "int64",
  description,
});

/** The reusable `:id` path parameter. */
const idParam = (description: string): Record<string, unknown> => ({
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});

/**
 * Build the OpenAPI 3.1 document for the v1 surface. Pure: returns a fresh,
 * fully-populated object on every call (no shared mutable singleton), with
 * `info.version` taken from the running build.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "Posthorn",
      version: POSTHORN_VERSION,
      summary: "Reliable, signed, observable webhook delivery.",
      description:
        "Posthorn is open-core, Standard Webhooks-compliant webhook delivery " +
        "infrastructure: a single container with no Redis. The tenant-facing v1 routes " +
        "are scoped to the API key's owning tenant — an `appId` is never read from a " +
        "request body — and cross-tenant access returns `404` (existence is never " +
        "revealed). App and API-key provisioning is a privileged control-plane operation " +
        "on the separate `/v1/admin/*` routes, authenticated by an out-of-band operator " +
        "admin token (`POSTHORN_ADMIN_TOKEN`) and **disabled by default** (those routes " +
        "are `404` unless the token is configured); the `posthorn admin` CLI is the " +
        "equivalent keyless local-shell path.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [
      {
        url: "/",
        description: "The running Posthorn instance (paths are relative to its host).",
      },
    ],
    tags: [
      { name: "Messages", description: "Send messages and observe their delivery." },
      { name: "Endpoints", description: "Manage the destinations messages fan out to." },
      {
        name: "Usage",
        description:
          "Your own message usage and current-month quota status — the self-service " +
          "view a customer (or a dashboard) reads to track consumption against its plan.",
      },
      {
        name: "Admin",
        description:
          "Control-plane provisioning of tenants (apps) and API keys. Authenticated by " +
          "the operator admin token, not a tenant key; disabled (every route `404`) unless " +
          "`POSTHORN_ADMIN_TOKEN` is set.",
      },
      { name: "Operational", description: "Liveness, metrics, and this document." },
      {
        name: "EventTypes",
        description:
          "The event type catalog: named, human-readable event type definitions that document " +
          "what events your application emits. Operators define event types (e.g. `user.created`, " +
          "`payment.failed`) with names and descriptions; the portal can then present checkboxes " +
          "instead of free-text subscription inputs.",
      },
      {
        name: "Portal",
        description:
          "Consumer App Portal: the customer-facing webhook management UI. A tenant mints " +
          "a portal session (via `POST /v1/portal/sessions`) and receives a short-lived token " +
          "that grants their customer access to the portal at `/portal/login?token=<token>`. " +
          "The customer can then create, edit, and delete endpoints, rotate signing secrets, " +
          "and view recent delivery status — all scoped to the tenant's `appId`, without the " +
          "customer ever seeing the tenant API key.",
      },
    ],
    security: [{ bearerAuth: [] }],
    paths: {
      "/healthz": {
        get: {
          operationId: "getHealth",
          tags: ["Operational"],
          summary: "Liveness probe",
          description: "Returns `200` while the service is up. Unauthenticated.",
          security: [],
          responses: {
            "200": jsonResponse("The service is up.", ref("Health")),
          },
        },
      },
      "/readyz": {
        get: {
          operationId: "getReadiness",
          tags: ["Operational"],
          summary: "Readiness probe",
          description:
            "Returns `200` when the storage backend is reachable and this replica can serve " +
            "traffic, or `503` when the backend is unreachable. Distinct from `/healthz`: " +
            "liveness says the process is up (do not restart it for a transient backend blip), " +
            "readiness says whether to route traffic to this replica *now*. Use it as the " +
            "readiness probe behind a load balancer / Kubernetes so a replica whose database " +
            "is down is pulled from rotation instead of accepting ingest it cannot store. " +
            "Unauthenticated.",
          security: [],
          responses: {
            "200": jsonResponse("The backend is reachable; this replica is ready.", ref("Readiness")),
            "503": jsonResponse(
              "The backend is unreachable; this replica is not ready to serve.",
              ref("Readiness"),
            ),
          },
        },
      },
      "/metrics": {
        get: {
          operationId: "getMetrics",
          tags: ["Operational"],
          summary: "Prometheus metrics exposition",
          description:
            "The standard Prometheus text exposition (v0.0.4). Exposes only " +
            "instance-aggregate counters/gauges — no tenant id, payload, or secret — so it " +
            "is safe to scrape unauthenticated; restrict it at the network layer if desired. " +
            "Returns `404` if metrics are not enabled on this instance.",
          security: [],
          responses: {
            "200": {
              description: "The Prometheus text exposition.",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                  example:
                    "# HELP posthorn_messages_ingested_total Messages accepted for delivery.\n" +
                    "# TYPE posthorn_messages_ingested_total counter\n" +
                    "posthorn_messages_ingested_total 42\n",
                },
              },
            },
            "404": errorResponse("Metrics are not enabled on this instance."),
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          tags: ["Operational"],
          summary: "This OpenAPI document",
          description: "The OpenAPI 3.1 description of this API. Unauthenticated.",
          security: [],
          responses: {
            "200": jsonResponse("The OpenAPI 3.1 document.", { type: "object" }),
          },
        },
      },
      "/v1/messages": {
        post: {
          operationId: "sendMessage",
          tags: ["Messages"],
          summary: "Send a message",
          description:
            "Accept an event and fan it out to the tenant's endpoints that subscribe to its " +
            "`eventType`. Returns `202` immediately; delivery happens asynchronously (poll " +
            "`GET /v1/messages/{id}` for status). When an `idempotencyKey` is supplied, a " +
            "repeat send with the same key returns the original message (`deduplicated: true`) " +
            "instead of fanning out again; reusing a key with a different payload is a `409`.",
          requestBody: jsonBody(ref("NewMessage")),
          responses: {
            "202": jsonResponse("Accepted; includes the fan-out summary.", ref("IngestResult")),
            "400": errorResponse("Malformed or missing request body."),
            "401": errorResponse("Missing or invalid API key."),
            "409": errorResponse("Idempotency key reused with a different payload."),
            "429": errorResponse(
              "The tenant's monthly message quota is reached (a deduplicated replay is exempt).",
            ),
          },
        },
        get: {
          operationId: "listMessages",
          tags: ["Messages"],
          summary: "List messages",
          description:
            "List the tenant's messages, newest first. Keyset-paginated: pass the previous " +
            "page's `nextCursor` as `?cursor=` to page forward (stable under concurrent inserts). " +
            "Rows are lean (no payload, no per-endpoint deliveries) — fetch one message for detail.",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_LIST_MESSAGES_LIMIT },
              description: `Page size, 1..${MAX_LIST_MESSAGES_LIMIT}. A server default applies when omitted.`,
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Opaque cursor from a prior page's `nextCursor`.",
            },
            {
              name: "eventType",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter to messages whose `eventType` exactly matches this value. Omit for all event types.",
            },
            {
              name: "channel",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Filter to messages whose `channel` exactly matches this value. " +
                "Omit to return messages across all channels.",
            },
          ],
          responses: {
            "200": jsonResponse("A page of messages.", ref("MessageList")),
            "400": errorResponse("Invalid `limit` or `cursor`."),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
      },
      "/v1/messages/batch": {
        post: {
          operationId: "sendMessageBatch",
          tags: ["Messages"],
          summary: "Send a batch of messages",
          description:
            "Accept up to 100 messages in a single call and fan each out to the tenant's " +
            "matching endpoints. Each item is processed independently: a per-item error " +
            "(e.g. `invalid_request`, `quota_exceeded`, `idempotency_conflict`) is returned " +
            "in that result slot without aborting the rest of the batch. The response is " +
            "always `200`; inspect each `result.ok` to detect per-item failures. " +
            "Idempotency keys are honored per message and quota-exempt replays are never " +
            "double-delivered. Quota enforcement mirrors the single-message endpoint: a " +
            "quota-exceeded error is returned for items that would breach the tenant's limit; " +
            "subsequent items in the same request also fail once the budget is exhausted.",
          requestBody: jsonBody(ref("BatchMessageInput")),
          responses: {
            "200": jsonResponse(
              "Per-message results (inspect `ok` on each element for success/failure).",
              ref("BatchResults"),
            ),
            "400": errorResponse(
              "The `messages` field is missing, not an array, or exceeds 100 items.",
            ),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
      },
      "/v1/messages/{id}": {
        get: {
          operationId: "getMessage",
          tags: ["Messages"],
          summary: "Get a message and its delivery statuses",
          description:
            "Fetch one message plus one delivery record per subscribed endpoint — the answer " +
            'to "what happened to my webhook?". Another tenant\'s (or an unknown) message is `404`.',
          parameters: [idParam("The message id.")],
          responses: {
            "200": jsonResponse("The message and its per-endpoint deliveries.", ref("Message")),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such message for this tenant."),
          },
        },
      },
      "/v1/messages/{id}/attempts": {
        get: {
          operationId: "listMessageAttempts",
          tags: ["Messages"],
          summary: "List a message's delivery attempts",
          description:
            "The per-attempt audit log for this message — one record per HTTP attempt the " +
            "worker made, oldest-first, across every endpoint it fanned out to. Each carries " +
            "the attempt number, outcome, the receiver's HTTP status (or `null` on a transport/" +
            "pre-flight failure), the error, and the latency. This is the depth behind " +
            '"observable": where `GET /v1/messages/{id}` shows each delivery\'s *current* state, ' +
            "this shows the *history* of how it got there. Another tenant's (or an unknown) " +
            "message is `404`. Keyset-paginated oldest-first: pass `nextCursor` back as " +
            "`?cursor=` to page forward.",
          parameters: [
            idParam("The message id."),
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_LIST_ATTEMPTS_LIMIT },
              description: `Page size, 1..${MAX_LIST_ATTEMPTS_LIMIT}. A server default applies when omitted.`,
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Opaque cursor from a prior page's `nextCursor`.",
            },
          ],
          responses: {
            "200": jsonResponse("A page of delivery attempts.", ref("DeliveryAttemptList")),
            "400": errorResponse("Invalid `limit` or `cursor`."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such message for this tenant."),
          },
        },
      },
      "/v1/messages/{id}/retry": {
        post: {
          operationId: "retryMessage",
          tags: ["Messages"],
          summary: "Retry a message's dead-lettered deliveries",
          description:
            "Replay the deliveries of this message that have exhausted their automatic retries " +
            "and landed in `dead_letter` — the operator recovery path once a failing receiver is " +
            "fixed. Healthy deliveries (pending/in-flight/succeeded) are left untouched. Returns " +
            "the refreshed per-endpoint statuses (replayed ones back to `pending`).",
          parameters: [idParam("The message id.")],
          responses: {
            "200": jsonResponse("The deliveries after the retry.", ref("RetryResult")),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such message for this tenant."),
          },
        },
      },
      "/v1/messages/{id}/cancel": {
        post: {
          operationId: "cancelMessage",
          tags: ["Messages"],
          summary: "Cancel a message's pending deliveries",
          description:
            "Abort the pending (scheduled/queued) deliveries for this message — " +
            "the operator's abort path when an endpoint was disabled or misconfigured " +
            "before the delivery fired. Only `pending` deliveries are cancelled; " +
            "in-flight (`delivering`), succeeded, and dead-lettered deliveries are " +
            "left untouched. Returns the count cancelled and the refreshed per-endpoint statuses.",
          parameters: [idParam("The message id.")],
          responses: {
            "200": jsonResponse("The deliveries after the cancellation.", ref("CancelResult")),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such message for this tenant."),
          },
        },
      },
      "/v1/endpoints": {
        get: {
          operationId: "listEndpoints",
          tags: ["Endpoints"],
          summary: "List endpoints",
          description: "List the tenant's endpoints, oldest first. Signing secrets are never echoed.",
          responses: {
            "200": jsonResponse("The tenant's endpoints.", ref("EndpointList")),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
        post: {
          operationId: "createEndpoint",
          tags: ["Endpoints"],
          summary: "Create an endpoint",
          description:
            "Register a delivery destination. The signing secret is returned **exactly once**, " +
            "in this response, so you can configure receiver-side verification — it is never echoed " +
            "by any subsequent read. Omit `secret` to have a secure one generated (the common case).",
          requestBody: jsonBody(ref("NewEndpoint")),
          responses: {
            "201": jsonResponse("The created endpoint, including its one-time secret.", ref("EndpointWithSecret")),
            "400": urlGuardedErrorResponse("Malformed request body (e.g. a non-http(s) URL)."),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
      },
      "/v1/endpoints/{id}": {
        get: {
          operationId: "getEndpoint",
          tags: ["Endpoints"],
          summary: "Get an endpoint",
          description: "Fetch one endpoint. Another tenant's (or an unknown) endpoint is `404`.",
          parameters: [idParam("The endpoint id.")],
          responses: {
            "200": jsonResponse("The endpoint (without its secret).", ref("Endpoint")),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
        patch: {
          operationId: "updateEndpoint",
          tags: ["Endpoints"],
          summary: "Update an endpoint",
          description:
            "Patch an endpoint; only the provided fields change. Pass `secret` to rotate the " +
            "signing secret. The tenant (`appId`) is never patchable. The updated secret is not " +
            "echoed in the response.",
          parameters: [idParam("The endpoint id.")],
          requestBody: jsonBody(ref("EndpointUpdate")),
          responses: {
            "200": jsonResponse("The updated endpoint (without its secret).", ref("Endpoint")),
            "400": urlGuardedErrorResponse("Malformed request body."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
        delete: {
          operationId: "deleteEndpoint",
          tags: ["Endpoints"],
          summary: "Delete an endpoint",
          description: "Delete an endpoint. Another tenant's (or an unknown) endpoint is `404`.",
          parameters: [idParam("The endpoint id.")],
          responses: {
            "204": { description: "Deleted; no content." },
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
      },
      "/v1/endpoints/{id}/deliveries": {
        get: {
          operationId: "listEndpointDeliveries",
          tags: ["Endpoints"],
          summary: "List an endpoint's delivery history",
          description:
            "List all deliveries for an endpoint, newest-first — the endpoint-centric " +
            "view that complements `GET /v1/messages/{id}`. Each entry is the current state " +
            "of one (message, endpoint) delivery: status, attempts, next retry time, and the " +
            "source `messageId` so you can navigate to the full message detail. Keyset-paginated: " +
            "pass `nextCursor` back as `?cursor=` to page forward. Another tenant's (or an " +
            "unknown) endpoint is `404`.",
          parameters: [
            idParam("The endpoint id."),
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_LIST_DELIVERIES_LIMIT },
              description: `Page size, 1–${MAX_LIST_DELIVERIES_LIMIT}. Defaults to 50.`,
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Opaque cursor from a prior page's `nextCursor`.",
            },
          ],
          responses: {
            "200": jsonResponse(
              "A page of deliveries for the endpoint, newest-first.",
              ref("EndpointDeliveryList"),
            ),
            "400": errorResponse("Malformed `?limit=` or `?cursor=` parameter."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
      },
      "/v1/endpoints/{id}/deliveries/retry": {
        post: {
          operationId: "retryEndpointDeliveries",
          tags: ["Endpoints"],
          summary: "Bulk-retry an endpoint's dead-lettered deliveries",
          description:
            "Re-drive up to " + MAX_LIST_DELIVERIES_LIMIT + " of an endpoint's dead-lettered deliveries — the " +
            "per-endpoint recovery path once a specific failing receiver is fixed. Only `dead_letter` " +
            "tasks are targeted; healthy deliveries (pending/in-flight/succeeded) are untouched. " +
            "Revived tasks become `pending` with a fresh attempt budget, deliverable immediately. " +
            "When `hasMore` is `true` there are further dead-lettered deliveries for this endpoint " +
            "not addressed this call; re-invoke until `hasMore` is `false` to fully drain. " +
            "Another tenant's (or an unknown) endpoint is `404`.",
          security: [{ BearerAuth: [] }],
          parameters: [idParam("The endpoint id.")],
          responses: {
            "200": jsonResponse("The bulk-retry tally.", ref("BulkRetryResult")),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
      },
      "/v1/endpoints/{id}/replay": {
        post: {
          operationId: "replayEndpoint",
          tags: ["Endpoints"],
          summary: "Replay historical messages to an endpoint",
          description:
            "Scan the tenant's message history and enqueue fresh delivery tasks for messages " +
            "that match the endpoint's subscription (event-type filter, channel, and payload filter). " +
            "This is the catch-up path for a newly-added endpoint (which has never seen prior messages) " +
            "or a recovering endpoint (re-deliver without waiting for manual per-message retries). " +
            "Each enqueued task is a brand-new `pending` delivery — the stable `webhook-id` on each " +
            "delivery lets the receiver deduplicate if it has already processed the message. " +
            "The scan is bounded by the optional `since`/`until` epoch-ms window and the `limit` " +
            `(default ${MAX_REPLAY_LIMIT}, max ${MAX_REPLAY_LIMIT}). ` +
            "When `hasMore` is `true` there are more messages in the window not yet replayed; " +
            "re-invoke until `false` to fully drain. Another tenant's (or an unknown) endpoint is `404`.",
          security: [{ BearerAuth: [] }],
          parameters: [idParam("The endpoint id.")],
          requestBody: {
            required: false,
            content: { "application/json": { schema: ref("ReplayRequest") } },
          },
          responses: {
            "200": jsonResponse("The replay tally.", ref("ReplayResult")),
            "400": errorResponse("Malformed request body (e.g. an invalid `limit`)."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
      },
      "/v1/endpoints/{id}/stats": {
        get: {
          operationId: "getEndpointStats",
          tags: ["Endpoints"],
          summary: "Get an endpoint's delivery statistics",
          description:
            "Aggregate delivery-attempt statistics for a single endpoint over a trailing " +
            `window of 1–${MAX_STATS_DAYS} calendar days (default ${DEFAULT_STATS_DAYS}). ` +
            "Returns total attempts, success/failure counts, overall success rate, mean " +
            "attempt duration, and a per-UTC-day breakdown for trend analysis. All counts " +
            "are zero and `successRate`/`avgDurationMs` are `null` when no attempts were " +
            "recorded in the window. Another tenant's (or an unknown) endpoint is `404`.",
          parameters: [
            idParam("The endpoint id."),
            {
              name: "days",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_STATS_DAYS, default: DEFAULT_STATS_DAYS },
              description: `Trailing window in calendar days (1–${MAX_STATS_DAYS}). Defaults to ${DEFAULT_STATS_DAYS}.`,
            },
          ],
          responses: {
            "200": jsonResponse("Delivery statistics for the endpoint.", ref("EndpointStats")),
            "400": errorResponse("Malformed `?days=` parameter."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
      },
      "/v1/endpoints/{id}/rotate-secret": {
        post: {
          operationId: "rotateEndpointSecret",
          tags: ["Endpoints"],
          summary: "Rotate an endpoint's signing secret (zero-downtime)",
          description:
            "Install a fresh signing secret while keeping the old one valid for an overlap " +
            "window, so deliveries are signed with **both** until receivers switch — no webhook " +
            "is dropped mid-rotation. The **new** secret is returned **exactly once** in this " +
            "response (configure your receivers with it); the old secret keeps verifying until " +
            "`overlapMs` elapses, then stops being used. The request body is optional: omit it " +
            "to auto-generate the new secret with the default overlap. Another tenant's (or an " +
            "unknown) endpoint is `404`.",
          parameters: [idParam("The endpoint id.")],
          requestBody: {
            required: false,
            content: { "application/json": { schema: ref("RotateSecretRequest") } },
          },
          responses: {
            "200": jsonResponse(
              "The endpoint with its new one-time secret installed.",
              ref("EndpointWithSecret"),
            ),
            "400": errorResponse("Malformed request body (e.g. an empty `secret` or negative `overlapMs`)."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
      },
      "/v1/endpoints/{id}/test": {
        post: {
          operationId: "testEndpoint",
          tags: ["Endpoints"],
          summary: "Send a test delivery to an endpoint",
          description:
            "Send a one-shot signed webhook to the endpoint URL and return the result " +
            "synchronously — the canonical way to verify an endpoint is wired correctly after " +
            "creation or configuration changes. The delivery is **not** stored, **not** queued, " +
            "and does **not** count against the tenant's monthly quota. The response always has " +
            "status `200`; `success` inside the body reports whether the endpoint responded " +
            "with a 2xx. Another tenant's (or an unknown) endpoint is `404`; a `disabled` " +
            "endpoint is `400`.",
          parameters: [idParam("The endpoint id.")],
          requestBody: {
            required: false,
            content: { "application/json": { schema: ref("TestEndpointInput") } },
          },
          responses: {
            "200": jsonResponse(
              "The synchronous delivery result (always 200, check `success` in the body).",
              ref("TestEndpointResult"),
            ),
            "400": errorResponse("Malformed request body, or the endpoint is disabled."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such endpoint for this tenant."),
          },
        },
      },
      "/v1/deliveries": {
        get: {
          operationId: "listDeliveries",
          tags: ["Deliveries"],
          summary: "List the tenant's deliveries across all messages and endpoints",
          description:
            "List all deliveries for the authenticated tenant, newest-first — the " +
            "app-wide cross-endpoint view that complements `GET /v1/endpoints/{id}/deliveries` " +
            "(one endpoint) and `GET /v1/messages/{id}` (one message). Optionally filter by " +
            "`?status=` (e.g. `dead_letter`) and/or `?failureReason=` (e.g. `connection_refused`) " +
            "— the two filters compose, for one-query failure triage. Each entry carries " +
            "both `messageId` and `endpointId` so you can navigate to either detail view. " +
            "Only deliveries that were enqueued with an `appId` appear; deliveries created " +
            "before per-tenant tracking was added are silently excluded. Keyset-paginated: " +
            "pass `nextCursor` back as `?cursor=` to page forward.",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["pending", "delivering", "succeeded", "dead_letter", "cancelled"],
              },
              description:
                "Filter by delivery status. Omit to return all statuses.",
            },
            {
              name: "failureReason",
              in: "query",
              required: false,
              schema: { type: "string", enum: [...DELIVERY_FAILURE_REASONS] },
              description:
                "Filter by the delivery's latest structured failure-reason code (e.g. " +
                "`connection_refused`, `http_5xx`, `request_timeout`). Omit for no reason " +
                "filter. Composes with `?status=`; deliveries that never failed are excluded.",
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_LIST_DELIVERIES_LIMIT },
              description: `Page size, 1–${MAX_LIST_DELIVERIES_LIMIT}. Defaults to 50.`,
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Opaque cursor from a prior page's `nextCursor`.",
            },
          ],
          responses: {
            "200": jsonResponse(
              "A page of deliveries for the tenant, newest-first.",
              ref("AppDeliveryList"),
            ),
            "400": errorResponse(
              "Malformed `?status=`, `?failureReason=`, `?limit=`, or `?cursor=` parameter.",
            ),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
      },
      "/v1/deliveries/{id}": {
        get: {
          operationId: "getDelivery",
          tags: ["Deliveries"],
          summary: "Fetch a single delivery by ID",
          description:
            "Retrieve the current state of one `(message, endpoint)` delivery task by its " +
            "ID. Returns the same shape as a row in `GET /v1/deliveries` — status, attempts, " +
            "nextAttemptAt, lastError, failureReason, messageId, and endpointId — letting you " +
            "navigate to the full message or endpoint detail. Another tenant's (or unknown) " +
            "delivery is `404`.",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The delivery task ID.",
            },
          ],
          responses: {
            "200": jsonResponse("The delivery task.", ref("AppDelivery")),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("Delivery not found or belongs to another tenant."),
          },
        },
      },
      "/v1/deliveries/{id}/attempts": {
        get: {
          operationId: "listDeliveryAttempts",
          tags: ["Deliveries"],
          summary: "List attempts for a delivery",
          description:
            "Fetch the per-attempt HTTP history for a single delivery task — " +
            "the same records surfaced by `GET /v1/messages/{id}/attempts` but scoped " +
            "to one `(message, endpoint)` pair rather than all endpoints for a message. " +
            "Each entry records the HTTP status, response body (up to 4 KB), error, " +
            "and latency so you can diagnose exactly which attempt failed and why. " +
            "Oldest-first. Keyset-paginated: pass `nextCursor` as `?cursor=`.",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The delivery task ID.",
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_LIST_ATTEMPTS_LIMIT },
              description: `Page size, 1–${MAX_LIST_ATTEMPTS_LIMIT}. Defaults to 50.`,
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Opaque cursor from a prior page's `nextCursor`.",
            },
          ],
          responses: {
            "200": jsonResponse("A page of delivery attempts, oldest-first.", ref("DeliveryAttemptList")),
            "400": errorResponse("Malformed `?limit=` or `?cursor=` parameter."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("Delivery not found or belongs to another tenant."),
          },
        },
      },
      "/v1/deliveries/retry": {
        post: {
          operationId: "retryAllDeliveries",
          tags: ["Deliveries"],
          summary: "Bulk-retry dead-lettered deliveries",
          description:
            "Re-drive up to " + MAX_LIST_DELIVERIES_LIMIT + " of the tenant's dead-lettered deliveries — the " +
            "tenant-wide recovery path once a failing receiver is fixed. Only `dead_letter` " +
            "tasks are targeted (pending/in-flight/succeeded are left untouched). Each revived " +
            "delivery is reset to a fresh `pending` state with its attempt budget reset, so the " +
            "worker re-attempts it under the full retry schedule. When `hasMore` is `true` there " +
            "are further dead-lettered deliveries not addressed this call; re-invoke until " +
            "`hasMore` is `false` to fully drain the backlog.",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": jsonResponse("The bulk-retry tally.", ref("BulkRetryResult")),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
      },
      "/v1/usage": {
        get: {
          operationId: "getUsage",
          tags: ["Usage"],
          summary: "Get your usage and quota status",
          description:
            "Your own message usage plus a live `quota` block for the **current** UTC " +
            "calendar month — the self-service counterpart to the admin metering route, " +
            "scoped to the API key's tenant. The breakdown defaults to the current month; " +
            "pass `?from=&to=` (inclusive `YYYY-MM-DD` UTC days, span capped at " +
            `${MAX_USAGE_RANGE_DAYS} days) to pull any historical window — the \`quota\` ` +
            "block still reports this month either way (where the message-quota gate stands), " +
            "so you can see how close you are to your plan limit and when the allowance resets. " +
            "Counts are exact (a deduplicated retry is never double-counted).",
          parameters: [
            {
              name: "from",
              in: "query",
              required: false,
              schema: { type: "string", format: "date" },
              description:
                "Inclusive start day, `YYYY-MM-DD` (UTC). Omit (with `to`) for the current month.",
            },
            {
              name: "to",
              in: "query",
              required: false,
              schema: { type: "string", format: "date" },
              description: "Inclusive end day, `YYYY-MM-DD` (UTC). Must be on or after `from`.",
            },
          ],
          responses: {
            "200": jsonResponse(
              "Your message usage over the range, plus current-month quota status.",
              ref("TenantUsage"),
            ),
            "400": errorResponse("A partial or invalid `from`/`to`, or a range over the day cap."),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
      },
      "/v1/portal/sessions": {
        post: {
          operationId: "createPortalSession",
          tags: ["Portal"],
          summary: "Mint a consumer portal session",
          description:
            "Create a short-lived portal session for one of your customers. Returns a `token` " +
            "and a `portalUrl` — redirect your customer to `portalUrl` (or embed it in an `<iframe>`) " +
            "and they will be able to manage their webhook endpoints in your Posthorn tenant without " +
            "ever seeing your API key. The session is scoped to your tenant; every portal action is " +
            "automatically tenant-isolated. Requires a tenant API key.",
          requestBody: jsonBody(ref("NewPortalSession")),
          responses: {
            "201": jsonResponse(
              "The portal session token and a ready-to-use redirect URL.",
              ref("PortalSessionResult"),
            ),
            "400": errorResponse("Missing or invalid `externalUserId` or `expiresIn` out of range."),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
      },
      "/v1/event-types": {
        get: {
          operationId: "listEventTypes",
          tags: ["EventTypes"],
          summary: "List event types",
          description:
            "List the tenant's event type catalog, sorted by id. By default excludes archived " +
            "event types; pass `?includeArchived=true` to include them.",
          parameters: [
            {
              name: "includeArchived",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description: "When `true`, archived event types are included in the results.",
            },
          ],
          responses: {
            "200": jsonResponse("The tenant's event types.", ref("EventTypeList")),
            "401": errorResponse("Missing or invalid API key."),
          },
        },
        post: {
          operationId: "createEventType",
          tags: ["EventTypes"],
          summary: "Create an event type",
          description:
            "Define a new event type in the catalog. The `id` (slug) must be unique within " +
            "the tenant and may contain letters, digits, dots, underscores, and hyphens.",
          requestBody: jsonBody(ref("NewEventType")),
          responses: {
            "201": jsonResponse("The created event type.", ref("EventType")),
            "400": errorResponse("Malformed request body or invalid id/name."),
            "401": errorResponse("Missing or invalid API key."),
            "409": errorResponse("An event type with that id already exists."),
          },
        },
      },
      "/v1/event-types/{id}": {
        get: {
          operationId: "getEventType",
          tags: ["EventTypes"],
          summary: "Get an event type",
          description: "Fetch one event type by id. Returns `404` if not found.",
          parameters: [idParam("The event type id (slug).")],
          responses: {
            "200": jsonResponse("The event type.", ref("EventType")),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such event type for this tenant."),
          },
        },
        patch: {
          operationId: "updateEventType",
          tags: ["EventTypes"],
          summary: "Update an event type",
          description: "Patch an event type; only the provided fields change.",
          parameters: [idParam("The event type id (slug).")],
          requestBody: jsonBody(ref("UpdateEventType")),
          responses: {
            "200": jsonResponse("The updated event type.", ref("EventType")),
            "400": errorResponse("Malformed request body."),
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No such event type for this tenant."),
          },
        },
        delete: {
          operationId: "archiveEventType",
          tags: ["EventTypes"],
          summary: "Archive an event type",
          description:
            "Archive an event type (soft delete). Archived types are excluded from the default " +
            "list but can be retrieved with `?includeArchived=true`. Returns `204` regardless " +
            "of whether the event type exists.",
          parameters: [idParam("The event type id (slug).")],
          responses: {
            "204": { description: "Archived (or already not found); no content." },
            "401": errorResponse("Missing or invalid API key."),
          },
        },
      },
      "/v1/admin/apps": {
        post: {
          operationId: "createApp",
          tags: ["Admin"],
          summary: "Create a tenant (app)",
          description:
            "Provision a new tenant. The optional body may set a human-readable `name`. " +
            "Requires the admin token.",
          security: [{ adminAuth: [] }],
          requestBody: {
            required: false,
            content: { "application/json": { schema: ref("NewApp") } },
          },
          responses: {
            "201": jsonResponse(
              "The created tenant, including the one-time system webhook secret (if a URL was set).",
              ref("CreatedApp"),
            ),
            "400": urlGuardedErrorResponse("Malformed request body."),
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("The admin API is not enabled on this instance."),
          },
        },
        get: {
          operationId: "listApps",
          tags: ["Admin"],
          summary: "List tenants",
          description: "List all tenants (apps), oldest first. Requires the admin token.",
          security: [{ adminAuth: [] }],
          responses: {
            "200": jsonResponse("All tenants.", ref("AppList")),
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("The admin API is not enabled on this instance."),
          },
        },
      },
      "/v1/admin/apps/{id}": {
        get: {
          operationId: "getApp",
          tags: ["Admin"],
          summary: "Get a tenant",
          description: "Fetch one tenant by id. Requires the admin token.",
          security: [{ adminAuth: [] }],
          parameters: [idParam("The app id.")],
          responses: {
            "200": jsonResponse("The tenant.", ref("App")),
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("No such app (or the admin API is not enabled)."),
          },
        },
        patch: {
          operationId: "updateApp",
          tags: ["Admin"],
          summary: "Update a tenant",
          description:
            "Patch a tenant; only the provided fields change. Assign a `plan` (free/pro/scale, " +
            "or null for custom) to stamp its catalog quota, set `monthlyMessageQuota` directly " +
            "(a non-negative integer, or null to remove the limit) to override it, or `name` to " +
            "rename. Requires the admin token.",
          security: [{ adminAuth: [] }],
          parameters: [idParam("The app id.")],
          requestBody: jsonBody(ref("AppUpdate")),
          responses: {
            "200": jsonResponse("The updated tenant.", ref("App")),
            "400": urlGuardedErrorResponse("Malformed request body (e.g. a negative or non-integer quota)."),
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("No such app (or the admin API is not enabled)."),
          },
        },
        delete: {
          operationId: "deleteApp",
          tags: ["Admin"],
          summary: "Delete a tenant",
          description:
            "Delete a tenant and **cascade-delete its API keys**. (Its endpoints and messages " +
            "live in independent stores and are not reaped here.) Requires the admin token.",
          security: [{ adminAuth: [] }],
          parameters: [idParam("The app id.")],
          responses: {
            "204": { description: "Deleted; no content." },
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("No such app (or the admin API is not enabled)."),
          },
        },
      },
      "/v1/admin/apps/{id}/rotate-system-secret": {
        post: {
          operationId: "rotateSystemWebhookSecret",
          tags: ["Admin"],
          summary: "Rotate the app's system webhook signing secret",
          description:
            "Generate a new system webhook signing secret for this app and return it **once** — " +
            "the store keeps only its stored form. Use this to obtain the secret when the system " +
            "webhook URL was added via `PATCH` rather than at create time, or to rotate an existing " +
            "secret. Requires the admin token.",
          security: [{ adminAuth: [] }],
          parameters: [idParam("The app id.")],
          responses: {
            "201": jsonResponse(
              "The new system webhook signing secret (one-time).",
              ref("RotateSystemSecretResult"),
            ),
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("No such app (or the admin API is not enabled)."),
          },
        },
      },
      "/v1/admin/apps/{id}/keys": {
        post: {
          operationId: "createApiKey",
          tags: ["Admin"],
          summary: "Mint an API key",
          description:
            "Mint a new API key for a tenant. The plaintext `secret` is returned **exactly " +
            "once** in this response — the store keeps only its hash — so persist it now; it is " +
            "never recoverable. Authenticate tenant requests with it as " +
            "`Authorization: Bearer <secret>`. Requires the admin token.",
          security: [{ adminAuth: [] }],
          parameters: [idParam("The app id.")],
          responses: {
            "201": jsonResponse("The new key's metadata plus its one-time secret.", ref("CreatedApiKey")),
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("No such app (or the admin API is not enabled)."),
          },
        },
        get: {
          operationId: "listApiKeys",
          tags: ["Admin"],
          summary: "List a tenant's API keys",
          description:
            "List a tenant's API keys — metadata only (id, prefix, timestamps, revocation); the " +
            "secret is never echoed. Requires the admin token.",
          security: [{ adminAuth: [] }],
          parameters: [idParam("The app id.")],
          responses: {
            "200": jsonResponse("The tenant's API keys.", ref("ApiKeyList")),
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("No such app (or the admin API is not enabled)."),
          },
        },
      },
      "/v1/admin/apps/{id}/usage": {
        get: {
          operationId: "getAppUsage",
          tags: ["Admin"],
          summary: "Get a tenant's message usage",
          description:
            "A tenant's message volume over a date range, broken down by UTC day — the metering " +
            "read model a hosted control plane bills and enforces quotas on (this market prices " +
            "per message). `from` and `to` are inclusive `YYYY-MM-DD` UTC days; the span is capped " +
            `at ${MAX_USAGE_RANGE_DAYS} days. Counts are exact (computed from the messages ` +
            "themselves, not a separate rollup) and a deduplicated retry is never double-counted. " +
            "Requires the admin token.",
          security: [{ adminAuth: [] }],
          parameters: [
            idParam("The app id."),
            {
              name: "from",
              in: "query",
              required: true,
              schema: { type: "string", format: "date" },
              description: "Inclusive start day, `YYYY-MM-DD` (UTC).",
            },
            {
              name: "to",
              in: "query",
              required: true,
              schema: { type: "string", format: "date" },
              description: "Inclusive end day, `YYYY-MM-DD` (UTC). Must be on or after `from`.",
            },
          ],
          responses: {
            "200": jsonResponse("The tenant's message usage over the range.", ref("Usage")),
            "400": errorResponse("Missing/invalid `from`/`to`, or a range over the day cap."),
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse("No such app (or the admin API is not enabled)."),
          },
        },
      },
      "/v1/admin/keys/{id}": {
        delete: {
          operationId: "revokeApiKey",
          tags: ["Admin"],
          summary: "Revoke an API key",
          description:
            "Revoke an API key by id. A revoked key never authenticates again. Requires the admin token.",
          security: [{ adminAuth: [] }],
          parameters: [idParam("The API key id.")],
          responses: {
            "204": { description: "Revoked; no content." },
            "401": errorResponse("Missing or invalid admin token."),
            "404": errorResponse(
              "No live key with that id (unknown or already revoked), or the admin API is not enabled.",
            ),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A Posthorn API key presented as a Bearer token: `Authorization: Bearer <key>`. " +
            "Mint one with the `posthorn admin create-key` CLI or `POST /v1/admin/apps/{id}/keys`.",
        },
        adminAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "The operator admin token presented as a Bearer token: `Authorization: Bearer " +
            "<POSTHORN_ADMIN_TOKEN>`. Authorizes the control-plane (`/v1/admin/*`) routes only. " +
            "A distinct credential from a tenant API key; the admin API is disabled (every " +
            "route `404`) unless the token is configured.",
        },
      },
      schemas: {
        EventType: {
          type: "object",
          description: "A named event type in the catalog.",
          required: ["id", "appId", "name", "description", "schemaExample", "archived", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", description: "The event type slug, e.g. `user.created`.", examples: ["user.created"] },
            appId: { type: "string" },
            name: { type: "string", description: "Human-readable label.", examples: ["User Created"] },
            description: { type: ["string", "null"], description: "Optional longer description." },
            schemaExample: { type: ["string", "null"], description: "Optional JSON example of the event payload." },
            archived: { type: "boolean", description: "Whether this event type is archived (soft-deleted)." },
            createdAt: epochMs("Creation time, epoch ms."),
            updatedAt: epochMs("Last mutation time, epoch ms."),
          },
        },
        NewEventType: {
          type: "object",
          description: "Input to `POST /v1/event-types`.",
          required: ["id", "name"],
          properties: {
            id: {
              type: "string",
              description:
                "The event type slug. Must start with a letter or digit and contain only " +
                "letters, digits, dots, underscores, or hyphens. Max 100 characters.",
              examples: ["user.created"],
            },
            name: { type: "string", description: "Human-readable label. Max 200 characters.", examples: ["User Created"] },
            description: { type: ["string", "null"], description: "Optional longer description. Max 1000 characters." },
            schemaExample: { type: ["string", "null"], description: "Optional JSON string example of the event payload." },
          },
        },
        UpdateEventType: {
          type: "object",
          description: "Input to `PATCH /v1/event-types/{id}`. Only provided fields change.",
          properties: {
            name: { type: "string", description: "Replace the human-readable label." },
            description: { type: ["string", "null"], description: "Replace the description (null to clear)." },
            schemaExample: { type: ["string", "null"], description: "Replace the schema example (null to clear)." },
          },
        },
        EventTypeList: {
          type: "object",
          required: ["data"],
          properties: { data: { type: "array", items: ref("EventType") } },
        },
        Health: {
          type: "object",
          required: ["status"],
          properties: { status: { type: "string", examples: ["ok"] } },
        },
        Readiness: {
          type: "object",
          required: ["status"],
          properties: { status: { type: "string", examples: ["ready", "not_ready"] } },
        },
        Error: {
          type: "object",
          description: "The standard error envelope every non-2xx response uses.",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  // The closed set of machine-readable codes is sourced verbatim from
                  // API_ERROR_CODES (src/http/error-codes.ts), the same single source
                  // of truth the API emits from. A bidirectional test in openapi.test.ts
                  // asserts this enum equals that array, so the documented contract can
                  // never drift from what the API returns.
                  enum: [...API_ERROR_CODES],
                  description:
                    "A stable, machine-readable error code. The full closed set is " +
                    "enumerated here; an SDK or generated client branches on it.",
                },
                message: { type: "string", description: "A human-readable explanation." },
              },
            },
          },
        },
        MessageSummary: {
          type: "object",
          description: "A message without its payload or per-endpoint deliveries (list/accept view).",
          required: ["id", "appId", "eventType", "idempotencyKey", "channel", "priority", "deliverAt", "expiresAt", "createdAt"],
          properties: {
            id: { type: "string", examples: ["msg_2Yx9..."] },
            appId: { type: "string" },
            eventType: { type: "string", examples: ["user.created"] },
            idempotencyKey: { type: ["string", "null"] },
            channel: {
              type: ["string", "null"],
              maxLength: 200,
              description:
                "The routing channel, or `null` for an untagged message. " +
                "Only endpoints whose `channel` is `null` (global) or matches this value receive the message.",
              examples: ["customer/user_42"],
            },
            priority: {
              type: "string",
              enum: ["high", "normal", "low"],
              description:
                "Delivery priority. Higher-priority messages are claimed from the queue before lower-priority ones " +
                "when multiple tasks are due at the same time. Defaults to `normal`.",
            },
            deliverAt: {
              type: ["integer", "null"],
              format: "int64",
              description:
                "Epoch-ms before which no delivery is attempted, or `null` for immediate delivery. " +
                "Mirrors the `sendAt` field from the create request.",
            },
            expiresAt: {
              type: ["integer", "null"],
              format: "int64",
              description:
                "Epoch-ms after which the message must not be delivered, or `null` for no expiry. " +
                "When the delivery worker picks up a task past this time, the delivery is dead-lettered immediately without retrying.",
            },
            createdAt: epochMs("Creation time, epoch ms."),
          },
        },
        Message: {
          type: "object",
          description: "A message plus its per-endpoint delivery statuses (detail view).",
          required: ["id", "appId", "eventType", "idempotencyKey", "channel", "priority", "deliverAt", "expiresAt", "payload", "createdAt", "deliveries"],
          properties: {
            id: { type: "string" },
            appId: { type: "string" },
            eventType: { type: "string" },
            idempotencyKey: { type: ["string", "null"] },
            channel: { type: ["string", "null"], maxLength: 200 },
            priority: {
              type: "string",
              enum: ["high", "normal", "low"],
              description:
                "Delivery priority. Higher-priority messages are claimed from the queue before lower-priority ones " +
                "when multiple tasks are due at the same time. Defaults to `normal`.",
            },
            deliverAt: {
              type: ["integer", "null"],
              format: "int64",
              description:
                "Epoch-ms before which no delivery is attempted, or `null` for immediate delivery.",
            },
            expiresAt: {
              type: ["integer", "null"],
              format: "int64",
              description:
                "Epoch-ms after which the message must not be delivered, or `null` for no expiry.",
            },
            payload: {
              type: "string",
              description: "The exact serialized JSON body that was signed and delivered, byte-for-byte.",
            },
            createdAt: epochMs("Creation time, epoch ms."),
            deliveries: { type: "array", items: ref("Delivery") },
          },
        },
        Delivery: {
          type: "object",
          description: "The state of one (message, endpoint) delivery.",
          required: [
            "id",
            "endpointId",
            "status",
            "attempts",
            "nextAttemptAt",
            "lastError",
            "failureReason",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string" },
            endpointId: { type: ["string", "null"] },
            status: {
              type: "string",
              enum: ["pending", "delivering", "succeeded", "dead_letter", "cancelled"],
              description: "`dead_letter` is terminal until an operator retry revives it. `cancelled` is terminal (operator abort).",
            },
            attempts: { type: "integer", minimum: 0, description: "Attempts started so far." },
            nextAttemptAt: {
              type: ["integer", "null"],
              format: "int64",
              description: "When the next attempt is due (epoch ms) while `pending`; otherwise null.",
            },
            lastError: { type: ["string", "null"], description: "Detail of the most recent failure." },
            failureReason: {
              type: ["string", "null"],
              enum: [...DELIVERY_FAILURE_REASONS, null],
              description:
                "The structured, machine-readable cause of the most recent failure — one stable " +
                "code (the queryable companion to the free-text `lastError`), denormalized from the " +
                "failing attempt. Null on a delivery that has never failed, cleared by an operator " +
                "retry, and null for failures recorded before this field shipped.",
            },
            createdAt: epochMs("Enqueue time, epoch ms."),
            updatedAt: epochMs("Last state change, epoch ms."),
          },
        },
        DeliveryAttempt: {
          type: "object",
          description: "One recorded HTTP delivery attempt (an append-only audit record).",
          required: [
            "id",
            "taskId",
            "endpointId",
            "attemptNumber",
            "outcome",
            "responseStatus",
            "error",
            "failureReason",
            "requestBody",
            "responseBody",
            "durationMs",
            "attemptedAt",
          ],
          properties: {
            id: { type: "string", examples: ["datt_5Qm2..."] },
            taskId: { type: "string", description: "The delivery (message×endpoint) this attempt belongs to." },
            endpointId: { type: ["string", "null"], description: "The destination endpoint." },
            attemptNumber: {
              type: "integer",
              minimum: 1,
              description: "Which attempt this was for its delivery, 1-based (1 = first try).",
            },
            outcome: {
              type: "string",
              enum: ["succeeded", "failed"],
              description: "Whether the attempt reached the receiver with a 2xx.",
            },
            responseStatus: {
              type: ["integer", "null"],
              description:
                "The receiver's HTTP status, or null when no response arrived (a transport " +
                "failure such as DNS/refused/timeout, or a pre-flight failure).",
            },
            error: { type: ["string", "null"], description: "Failure detail when `outcome` is `failed`; null on success." },
            failureReason: {
              type: ["string", "null"],
              enum: [...DELIVERY_FAILURE_REASONS, null],
              description:
                "The structured, machine-readable cause of a failed attempt — one stable code " +
                "you can group or filter by (the queryable companion to the free-text `error`). " +
                "Null on a succeeded attempt, and on attempts recorded before this field shipped.",
            },
            requestBody: {
              type: ["string", "null"],
              maxLength: MAX_CAPTURED_BODY_BYTES,
              description:
                `The signed message payload sent to the receiver, truncated to ${MAX_CAPTURED_BODY_BYTES} bytes. ` +
                "Null when no send was attempted (pre-flight failure: message not found or endpoint not resolved).",
            },
            responseBody: {
              type: ["string", "null"],
              maxLength: MAX_CAPTURED_BODY_BYTES,
              description:
                `The HTTP response body returned by the receiver, truncated to ${MAX_CAPTURED_BODY_BYTES} bytes. ` +
                "Null when no response arrived (transport error or pre-flight failure). " +
                'An empty string means the receiver responded with an empty body.',
            },
            durationMs: {
              type: "integer",
              minimum: 0,
              description: "Wall-clock duration of the attempt, ms (0 for a pre-flight failure with no send).",
            },
            attemptedAt: epochMs("When the attempt started, epoch ms."),
          },
        },
        FieldFilter: {
          type: "object",
          description:
            "A comparison filter: extracts a value at `path` from the message payload and " +
            "compares it to `value` using `op`. Returns false when the path is absent or " +
            "types are incompatible for ordered operators.",
          required: ["op", "path", "value"],
          properties: {
            op: {
              type: "string",
              enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith"],
              description:
                "`eq`/`neq` equality; `gt`/`gte`/`lt`/`lte` numeric ordered comparison; " +
                "`contains` substring (strings) or element membership (arrays); " +
                "`startsWith` string prefix.",
            },
            path: {
              type: "string",
              description: "Dot-separated key path into the parsed message payload.",
              examples: ["data.status", "amount", "user.id"],
            },
            value: {
              oneOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
              ],
              description: "Scalar to compare the extracted value against.",
            },
          },
        },
        LogicalFilter: {
          type: "object",
          description: "Logical AND or OR combinator over a list of sub-filters.",
          required: ["op", "filters"],
          properties: {
            op: { type: "string", enum: ["and", "or"] },
            filters: {
              type: "array",
              items: ref("EndpointFilter"),
              minItems: 1,
              maxItems: 10,
              description: "Child filters. All must match for `and`; at least one for `or`.",
            },
          },
        },
        NotFilter: {
          type: "object",
          description: "Logical NOT — inverts the result of the child filter.",
          required: ["op", "filter"],
          properties: {
            op: { type: "string", enum: ["not"] },
            filter: ref("EndpointFilter"),
          },
        },
        EndpointFilter: {
          oneOf: [ref("FieldFilter"), ref("LogicalFilter"), ref("NotFilter")],
          description:
            "A filter expression that gates delivery based on the message payload. " +
            "Field filters compare a dot-path value against a scalar; logical combinators " +
            "(`and`/`or`/`not`) compose them into arbitrarily complex expressions. " +
            `Maximum ${MAX_FILTER_NODES} total nodes and ${MAX_FILTER_DEPTH} levels of nesting.`,
        },
        RetryPolicyConfig: {
          type: "object",
          description:
            "A custom retry schedule: an ordered list of delays (ms) between consecutive delivery " +
            "attempts, plus an optional set of HTTP status codes that bypass retries and immediately " +
            "dead-letter the delivery. `delaysMs.length` is the number of retries; total attempts = " +
            `retries + 1. Maximum ${MAX_RETRY_POLICY_RETRIES} retries; each delay must be 0–${MAX_RETRY_POLICY_DELAY_MS} ms.`,
          required: ["delaysMs"],
          properties: {
            delaysMs: {
              type: "array",
              items: { type: "integer", minimum: 0 },
              maxItems: MAX_RETRY_POLICY_RETRIES,
              description: "Ordered inter-attempt delays in milliseconds.",
              examples: [[5000, 300000, 1800000, 7200000]],
            },
            nonRetryableStatuses: {
              type: "array",
              items: { type: "integer", minimum: 100, maximum: 599 },
              maxItems: MAX_NON_RETRYABLE_STATUSES,
              description:
                "HTTP status codes that bypass the retry schedule and immediately dead-letter the " +
                "delivery. Useful for 4xx codes (e.g. 400, 401, 410) where retrying cannot succeed " +
                "— the receiver has permanently rejected the request.",
              examples: [[400, 401, 403, 410]],
            },
          },
        },
        Endpoint: {
          type: "object",
          description: "A delivery destination. The signing secret is never included in this view.",
          required: [
            "id", "appId", "url", "description", "eventTypes", "channel", "rateLimit", "headers", "retryPolicy", "filter",
            "disabled", "consecutiveFailures", "firstFailureAt", "lastFailureAt",
            "createdAt", "updatedAt",
          ],
          properties: {
            id: { type: "string", examples: ["ep_3Kp1..."] },
            appId: { type: "string" },
            url: { type: "string", format: "uri", description: "The http(s) URL the signed payload is POSTed to." },
            description: { type: "string", description: "Human-readable label; empty string when none." },
            eventTypes: {
              type: ["array", "null"],
              items: { type: "string" },
              description: "Subscription filter. `null` means all events; an array means exactly those types.",
            },
            channel: {
              type: ["string", "null"],
              maxLength: 200,
              description:
                "The routing channel this endpoint is scoped to, or `null` for a global endpoint. " +
                "A global endpoint receives every message regardless of the message's channel. " +
                "A channel-scoped endpoint receives only messages whose `channel` exactly matches.",
            },
            headers: {
              type: ["object", "null"],
              additionalProperties: { type: "string" },
              description:
                "Custom HTTP headers added to every delivery (e.g. `X-API-Key`). " +
                "`null` means no custom headers. Standard Webhooks signing headers and " +
                "`content-type` are always controlled by Posthorn and cannot be set here.",
            },
            retryPolicy: {
              oneOf: [ref("RetryPolicyConfig"), { type: "null" }],
              description:
                "Per-endpoint retry schedule. `null` means the system-wide default policy applies. " +
                "When set, `delaysMs` replaces the global schedule for deliveries to this endpoint.",
            },
            rateLimit: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: 10000,
              description:
                "Maximum deliveries per 60-second sliding window. The worker postpones tasks " +
                "that exceed the limit without consuming a retry attempt. `null` means no limit.",
            },
            filter: {
              oneOf: [ref("EndpointFilter"), { type: "null" }],
              description:
                "Payload filter. `null` means no filter — deliver all matching event types. " +
                "When set, a delivery is only enqueued when the message payload matches this " +
                "expression. Evaluated at fan-out time against the parsed JSON payload.",
            },
            disabled: {
              type: "boolean",
              description:
                "When true, the endpoint is paused and skipped by fan-out — set manually, " +
                "or automatically after the endpoint fails continuously (see consecutiveFailures).",
            },
            consecutiveFailures: {
              type: "integer",
              minimum: 0,
              description: "Consecutive dead-lettered deliveries since the last success; 0 when healthy.",
            },
            firstFailureAt: {
              type: ["integer", "null"],
              description: "Epoch ms the current failure streak began; null when healthy. Basis for auto-disabling.",
            },
            lastFailureAt: {
              type: ["integer", "null"],
              description: "Epoch ms of the most recent dead-lettered delivery; null when healthy.",
            },
            createdAt: epochMs("Creation time, epoch ms."),
            updatedAt: epochMs("Last mutation time, epoch ms."),
          },
        },
        EndpointWithSecret: {
          allOf: [
            ref("Endpoint"),
            {
              type: "object",
              required: ["secret"],
              properties: {
                secret: {
                  type: "string",
                  description: "The signing secret (`whsec_…`). Returned only here, only once.",
                },
              },
            },
          ],
        },
        NewMessage: {
          type: "object",
          description: "The body of `POST /v1/messages`. A body `appId` is ignored — tenancy is the key's.",
          required: ["eventType", "payload"],
          properties: {
            eventType: { type: "string", examples: ["user.created"] },
            payload: {
              description: "Any JSON value. Delivered (and signed) as its exact JSON serialization.",
            },
            idempotencyKey: {
              type: ["string", "null"],
              description: "Collapse repeat sends onto one message, scoped to this tenant.",
            },
            sendAt: {
              type: ["string", "null"],
              format: "date-time",
              description:
                "ISO 8601 timestamp before which no delivery attempt is made. Omit or pass `null` for immediate delivery. " +
                "Past timestamps are treated as immediate. Each endpoint in the fan-out inherits the same delay.",
              examples: ["2026-06-01T09:00:00Z"],
            },
            expiresAt: {
              type: ["string", "null"],
              format: "date-time",
              description:
                "ISO 8601 timestamp after which the message must not be delivered. Omit or pass `null` for no expiry. " +
                "If the delivery worker picks up a task after this time, the delivery is dead-lettered immediately " +
                "without retrying — preventing stale events from being delivered after their window has closed.",
              examples: ["2026-06-01T09:05:00Z"],
            },
            channel: {
              type: ["string", "null"],
              maxLength: 200,
              description:
                "Optional routing channel. When set, only endpoints whose `channel` is `null` (global) or " +
                "matches this exact value will receive the message. Omit or pass `null` for an untagged broadcast " +
                "(received only by global endpoints).",
              examples: ["customer/user_42"],
            },
            priority: {
              type: "string",
              enum: ["high", "normal", "low"],
              description:
                "Delivery priority. Higher-priority messages are claimed from the queue before lower-priority ones " +
                "when multiple tasks are due at the same time. Defaults to `normal` when omitted.",
            },
          },
        },
        NewEndpoint: {
          type: "object",
          description: "The body of `POST /v1/endpoints`. A body `appId` is ignored — tenancy is the key's.",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri", description: "Absolute http(s) destination URL." },
            secret: { type: "string", description: "Omit to auto-generate a secure secret (the common case)." },
            description: { type: "string", description: "Optional human-readable label." },
            eventTypes: {
              type: ["array", "null"],
              items: { type: "string" },
              description: "Subscription filter. Omit or pass `null` for all events.",
            },
            channel: {
              type: ["string", "null"],
              maxLength: 200,
              description:
                "Routing channel. When set, this endpoint only receives messages whose `channel` matches. " +
                "Omit or pass `null` for a global endpoint that receives all messages.",
              examples: ["customer/user_42"],
            },
            disabled: { type: "boolean", description: "Whether the endpoint starts paused. Defaults to false." },
            headers: {
              type: ["object", "null"],
              additionalProperties: { type: "string" },
              description:
                "Custom HTTP headers to add to every delivery. Omit or pass `null` for none. " +
                "Standard Webhooks signing headers and `content-type` may not be set here.",
            },
            retryPolicy: {
              oneOf: [ref("RetryPolicyConfig"), { type: "null" }],
              description:
                "Custom retry schedule. Omit or pass `null` to use the system-wide default policy.",
            },
            rateLimit: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: 10000,
              description:
                "Max deliveries per 60-second window. Omit or pass `null` for no limit.",
            },
            filter: {
              oneOf: [ref("EndpointFilter"), { type: "null" }],
              description:
                "Payload filter. Omit or pass `null` for no filter — deliver all matching event types.",
            },
          },
        },
        EndpointUpdate: {
          type: "object",
          description:
            "The body of `PATCH /v1/endpoints/{id}`. Only the provided fields change. A `secret` " +
            "here is a hard swap (no overlap); use `rotate-secret` for zero-downtime rotation.",
          properties: {
            url: { type: "string", format: "uri" },
            secret: { type: "string", description: "Hard-swap the signing secret (no overlap)." },
            description: { type: "string" },
            eventTypes: { type: ["array", "null"], items: { type: "string" } },
            channel: {
              type: ["string", "null"],
              maxLength: 200,
              description: "Replace the routing channel. Pass `null` to make the endpoint global.",
            },
            disabled: { type: "boolean" },
            headers: {
              type: ["object", "null"],
              additionalProperties: { type: "string" },
              description: "Replace custom delivery headers. Pass `null` to clear all.",
            },
            retryPolicy: {
              oneOf: [ref("RetryPolicyConfig"), { type: "null" }],
              description:
                "Replace the retry schedule. Pass `null` to revert to the system-wide default.",
            },
            rateLimit: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: 10000,
              description:
                "Replace the delivery rate limit. Pass `null` to remove the limit.",
            },
            filter: {
              oneOf: [ref("EndpointFilter"), { type: "null" }],
              description:
                "Replace the payload filter. Pass `null` to remove the filter (deliver all matching event types).",
            },
          },
        },
        RotateSecretRequest: {
          type: "object",
          description:
            "The (optional) body of `POST /v1/endpoints/{id}/rotate-secret`. Omit it entirely to " +
            "auto-generate the new secret with the default overlap window.",
          properties: {
            secret: {
              type: "string",
              description: "The new primary secret. Omit to auto-generate a secure one (the common case).",
            },
            overlapMs: {
              type: "integer",
              minimum: 0,
              description:
                "How long (ms) the old secret keeps signing after the rotation, so receivers " +
                "mid-migration still verify. Defaults to 24h. `0` is an instant hard swap (no overlap).",
            },
          },
        },
        TestEndpointInput: {
          type: "object",
          description:
            "The (optional) body of `POST /v1/endpoints/{id}/test`. Omit it entirely to send a " +
            "generic test event (`eventType: \"test\"`, `payload: {\"test\":true}`).",
          properties: {
            eventType: {
              type: "string",
              description: "The event type to send (e.g. `\"user.created\"`). Defaults to `\"test\"`.",
            },
            payload: {
              description: "The event body — any JSON value. Defaults to `{\"test\":true}`.",
            },
          },
        },
        TestEndpointResult: {
          type: "object",
          description: "Synchronous result of a one-shot test delivery.",
          required: ["success", "durationMs"],
          properties: {
            success: {
              type: "boolean",
              description: "Whether the endpoint responded with a 2xx status.",
            },
            httpStatus: {
              type: "integer",
              description: "The HTTP status the endpoint returned, if a response was received.",
            },
            error: {
              type: "string",
              description:
                "Transport-level error message when no response was received (DNS failure, " +
                "connection refused, timeout, etc.).",
            },
            durationMs: {
              type: "integer",
              description: "Round-trip latency in milliseconds.",
            },
          },
        },
        FanoutSummary: {
          type: "object",
          description: "How many endpoints a message fanned out to, and why others were skipped.",
          required: ["matched", "skippedDisabled", "skippedUnsubscribed", "skippedChannel", "skippedFiltered"],
          properties: {
            matched: { type: "integer", minimum: 0, description: "Endpoints a delivery was enqueued for." },
            skippedDisabled: { type: "integer", minimum: 0, description: "Endpoints skipped as disabled." },
            skippedUnsubscribed: {
              type: "integer",
              minimum: 0,
              description: "Endpoints skipped as not subscribed to the event type.",
            },
            skippedChannel: {
              type: "integer",
              minimum: 0,
              description:
                "Enabled, subscribed endpoints skipped because their channel did not match the message's channel.",
            },
            skippedFiltered: {
              type: "integer",
              minimum: 0,
              description: "Enabled, subscribed endpoints skipped because their payload filter did not match.",
            },
          },
        },
        IngestResult: {
          type: "object",
          description: "The `202` body of `POST /v1/messages`.",
          required: ["message", "deduplicated", "fanout"],
          properties: {
            message: ref("MessageSummary"),
            deduplicated: { type: "boolean", description: "True when an idempotency key matched an existing message." },
            fanout: {
              ...nullableRef("FanoutSummary"),
              description: "The fan-out summary, or null when fan-out was suppressed (a deduplicated replay).",
            },
          },
        },
        MessageList: {
          type: "object",
          description: "A keyset-paginated page of messages.",
          required: ["data", "nextCursor"],
          properties: {
            data: { type: "array", items: ref("MessageSummary") },
            nextCursor: {
              type: ["string", "null"],
              description: "Pass as `?cursor=` for the next page; null on the last page.",
            },
          },
        },
        EndpointList: {
          type: "object",
          required: ["data"],
          properties: { data: { type: "array", items: ref("Endpoint") } },
        },
        DeliveryAttemptList: {
          type: "object",
          description:
            "One page of a message's delivery attempts, oldest-first. " +
            "Pass `nextCursor` as `?cursor=` to fetch the next page; `null` on the last page.",
          required: ["data", "nextCursor"],
          properties: {
            data: { type: "array", items: ref("DeliveryAttempt") },
            nextCursor: {
              type: ["string", "null"],
              description: "Opaque cursor for the next page, or null when this is the last page.",
            },
          },
        },
        EndpointDelivery: {
          allOf: [
            ref("Delivery"),
            {
              type: "object",
              description:
                "A delivery in an endpoint's history — extends Delivery with the " +
                "source `messageId` so you can navigate to the originating message.",
              required: ["messageId"],
              properties: {
                messageId: { type: "string", description: "The message this delivery belongs to." },
              },
            },
          ],
        },
        EndpointDeliveryList: {
          type: "object",
          description:
            "A keyset-paginated page of an endpoint's deliveries, newest-first. " +
            "Pass `nextCursor` as `?cursor=` to fetch the next page; `null` on the last page.",
          required: ["data", "nextCursor"],
          properties: {
            data: { type: "array", items: ref("EndpointDelivery") },
            nextCursor: {
              type: ["string", "null"],
              description: "Opaque cursor for the next page, or null when this is the last page.",
            },
          },
        },
        EndpointStatsDay: {
          type: "object",
          description: "Delivery-attempt counts for a single endpoint on one UTC calendar day.",
          required: ["date", "attempts", "succeeded", "failed"],
          properties: {
            date: { type: "string", format: "date", description: "UTC day, ISO `YYYY-MM-DD`." },
            attempts: { type: "integer", minimum: 0, description: "Total delivery attempts on this day." },
            succeeded: { type: "integer", minimum: 0, description: "Attempts that reached the receiver with a 2xx." },
            failed: { type: "integer", minimum: 0, description: "Attempts that failed (non-2xx, transport, or pre-flight)." },
          },
        },
        DeliveryFailureReasonCounts: {
          type: "object",
          description:
            "A per-reason tally of failed delivery attempts — one integer per stable " +
            "`DeliveryFailureReason` code, every key always present (zeros included). The " +
            "same closed taxonomy the `posthorn_delivery_failures_total{reason}` metric uses.",
          required: [...DELIVERY_FAILURE_REASONS],
          additionalProperties: false,
          properties: Object.fromEntries(
            DELIVERY_FAILURE_REASONS.map((reason) => [
              reason,
              { type: "integer", minimum: 0, description: `Failed attempts classified as \`${reason}\`.` },
            ]),
          ),
        },
        EndpointStats: {
          type: "object",
          description:
            "Aggregate delivery-attempt statistics for a single endpoint over a trailing " +
            "calendar-day window. Use `GET /v1/endpoints/{id}/stats` to retrieve.",
          required: ["endpointId", "fromMs", "toMs", "total", "succeeded", "failed", "successRate", "avgDurationMs", "daily", "failureReasons"],
          properties: {
            endpointId: { type: "string", description: "The endpoint these statistics are for." },
            fromMs: epochMs("Inclusive start of the window (epoch ms)."),
            toMs: epochMs("Exclusive end of the window (epoch ms)."),
            total: { type: "integer", minimum: 0, description: "Total delivery attempts in the window." },
            succeeded: { type: "integer", minimum: 0, description: "Attempts that reached the receiver with a 2xx." },
            failed: { type: "integer", minimum: 0, description: "Attempts that failed." },
            successRate: {
              type: ["number", "null"],
              minimum: 0,
              maximum: 1,
              description: "`succeeded / total` rounded to 4 decimal places, or `null` when `total` is 0.",
            },
            avgDurationMs: {
              type: ["integer", "null"],
              minimum: 0,
              description: "Mean attempt duration in ms (all attempts, succeeded and failed), or `null` when `total` is 0.",
            },
            daily: {
              type: "array",
              items: ref("EndpointStatsDay"),
              description: "Per-UTC-day breakdown, oldest day first; only days with at least one attempt.",
            },
            failureReasons: {
              allOf: [ref("DeliveryFailureReasonCounts")],
              description:
                "Why the `failed` attempts failed — a per-reason tally to triage a flapping " +
                "endpoint. Classified failures sum to `failed` (legacy attempts recorded before " +
                "failure-reason classification have a null reason and are excluded).",
            },
          },
        },
        AppDelivery: {
          allOf: [
            ref("Delivery"),
            {
              type: "object",
              description:
                "A delivery in the tenant's app-wide list — extends Delivery with " +
                "`messageId` and `endpointId` so you can navigate to either detail view.",
              required: ["messageId"],
              properties: {
                messageId: { type: "string", description: "The message this delivery belongs to." },
              },
            },
          ],
        },
        AppDeliveryList: {
          type: "object",
          description:
            "A keyset-paginated page of the tenant's deliveries across all messages and " +
            "endpoints, newest-first. Pass `nextCursor` as `?cursor=` to fetch the next page; " +
            "`null` on the last page.",
          required: ["data", "nextCursor"],
          properties: {
            data: { type: "array", items: ref("AppDelivery") },
            nextCursor: {
              type: ["string", "null"],
              description: "Opaque cursor for the next page, or null when this is the last page.",
            },
          },
        },
        RetryResult: {
          type: "object",
          description: "The result of replaying a message's dead-lettered deliveries.",
          required: ["id", "retried", "deliveries"],
          properties: {
            id: { type: "string" },
            retried: { type: "integer", minimum: 0, description: "How many dead-lettered deliveries were revived." },
            deliveries: { type: "array", items: ref("Delivery") },
          },
        },
        CancelResult: {
          type: "object",
          description: "The result of cancelling a message's pending deliveries.",
          required: ["id", "cancelled", "deliveries"],
          properties: {
            id: { type: "string" },
            cancelled: { type: "integer", minimum: 0, description: "How many pending deliveries were cancelled." },
            deliveries: { type: "array", items: ref("Delivery") },
          },
        },
        BulkRetryResult: {
          type: "object",
          description: "The result of a bulk dead-letter retry for the tenant.",
          required: ["retried", "hasMore"],
          properties: {
            retried: {
              type: "integer",
              minimum: 0,
              description: "Dead-lettered deliveries reset to `pending` this call.",
            },
            hasMore: {
              type: "boolean",
              description:
                "`true` when further dead-lettered deliveries remain beyond this call's limit. " +
                "Re-invoke `POST /v1/deliveries/retry` until `false` to fully drain the backlog.",
            },
          },
        },
        ReplayRequest: {
          type: "object",
          description:
            "Optional input for `POST /v1/endpoints/{id}/replay`. All fields have defaults; " +
            "omit the body entirely to replay all matching historical messages up to the default limit.",
          properties: {
            since: {
              type: ["integer", "null"],
              minimum: 0,
              description:
                "Inclusive epoch-ms lower bound — only messages created at or after this " +
                "timestamp are replayed. Absent means no lower bound.",
            },
            until: {
              type: ["integer", "null"],
              minimum: 0,
              description:
                "Exclusive epoch-ms upper bound — only messages created strictly before this " +
                "timestamp are replayed. Absent means no upper bound.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_REPLAY_LIMIT,
              description:
                `Maximum delivery tasks to enqueue this call (1–${MAX_REPLAY_LIMIT}). ` +
                `Defaults to ${MAX_REPLAY_LIMIT}. When the limit is reached, ` +
                "`hasMore` is `true`; re-invoke to continue.",
            },
          },
        },
        ReplayResult: {
          type: "object",
          description: "The result of an endpoint message replay.",
          required: ["enqueued", "hasMore"],
          properties: {
            enqueued: {
              type: "integer",
              minimum: 0,
              description: "Fresh delivery tasks enqueued this call.",
            },
            hasMore: {
              type: "boolean",
              description:
                "`true` when the scan was truncated by `limit` — more messages in the time " +
                "window may match the endpoint's subscription. Re-invoke until `false` to " +
                "fully replay the window.",
            },
          },
        },
        PlanEntitlements: {
          type: "object",
          description:
            "The metered allowances a plan tier grants. Each is a non-negative integer or " +
            "null (no limit). Only `monthlyMessageQuota` is actively enforced today (stamped " +
            "onto the tenant); `retentionDays` and `rateLimitPerMinute` are the plan's declared " +
            "allowances surfaced for display.",
          required: ["monthlyMessageQuota", "retentionDays", "rateLimitPerMinute"],
          properties: {
            monthlyMessageQuota: {
              type: ["integer", "null"],
              minimum: 0,
              description: "Messages the tenant may accept per UTC calendar month under this plan.",
            },
            retentionDays: {
              type: ["integer", "null"],
              minimum: 0,
              description:
                "Days of delivered message/attempt history the plan declares. Note: the running " +
                "gateway prunes by the instance-wide `POSTHORN_RETENTION_DAYS`, not this per-plan value.",
            },
            rateLimitPerMinute: {
              type: ["integer", "null"],
              minimum: 0,
              description:
                "The default per-endpoint delivery rate (deliveries/minute) the plan grants — the " +
                "same unit as a per-endpoint `rateLimit` and `POSTHORN_DEFAULT_RATE_LIMIT`.",
            },
          },
        },
        App: {
          type: "object",
          description: "A tenant. The unit a single instance serves, owns endpoints/messages, and (in the hosted plane) is metered/billed.",
          required: ["id", "name", "plan", "entitlements", "monthlyMessageQuota", "systemWebhookUrl", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", examples: ["app_2Yx9..."], description: "The `appId` endpoints and messages reference." },
            name: { type: "string", description: "Human-readable label; empty string when none." },
            plan: {
              type: ["string", "null"],
              enum: [...PLAN_IDS, null],
              description:
                "The assigned plan tier, or null for a custom/unmanaged tenant (the default). " +
                "Assigning a plan stamps its `monthlyMessageQuota` onto the tenant; the stored " +
                "quota is the live enforced value, while this records which preset was applied.",
            },
            entitlements: {
              ...nullableRef("PlanEntitlements"),
              description:
                "The catalog allowances the assigned `plan` grants, or null for a custom/" +
                "unmanaged tenant. A read-model convenience resolved from the plan; the enforced " +
                "value remains `monthlyMessageQuota` below.",
            },
            monthlyMessageQuota: {
              type: ["integer", "null"],
              minimum: 0,
              description:
                "Messages this tenant may accept per UTC calendar month, or null for no limit. " +
                "When set, `POST /v1/messages` returns `429` once it is reached (the freemium/" +
                "usage-pricing gate); a deduplicated replay is exempt and never counts.",
            },
            systemWebhookUrl: {
              type: ["string", "null"],
              format: "uri",
              description:
                "The URL Posthorn POSTs signed system events to, or null if system webhooks " +
                "are not configured. Events fired: `endpoint.disabled` (an endpoint was " +
                "auto-disabled after sustained failures) and `message.dead_lettered` (a " +
                "delivery exhausted all retry attempts). Both payloads are Standard Webhooks " +
                "signed with the app's system webhook secret. The secret is never included " +
                "in the app snapshot; use `POST /v1/admin/apps/{id}/rotate-system-secret` " +
                "to obtain or rotate it.",
            },
            createdAt: epochMs("Creation time, epoch ms."),
            updatedAt: epochMs("Last mutation time, epoch ms."),
          },
        },
        CreatedApp: {
          description:
            "A freshly created tenant: its full `App` snapshot plus the one-time system webhook " +
            "signing secret. The secret is returned exactly once here — it is never recoverable " +
            "afterward (only its stored form is kept for signing). `null` when no `systemWebhookUrl` " +
            "was supplied at creation.",
          allOf: [
            ref("App"),
            {
              type: "object",
              required: ["systemWebhookSecret"],
              properties: {
                systemWebhookSecret: {
                  type: ["string", "null"],
                  description:
                    "The plaintext system webhook signing secret (`sws_…`). Returned once, never " +
                    "recoverable — persist it now. `null` when `systemWebhookUrl` was not configured.",
                },
              },
            },
          ],
        },
        NewApp: {
          type: "object",
          description: "The (optional) body of `POST /v1/admin/apps`. Omit it entirely to create an unnamed, custom-plan, unlimited tenant.",
          properties: {
            name: { type: "string", description: "Optional human-readable label." },
            plan: {
              type: ["string", "null"],
              enum: [...PLAN_IDS, null],
              description:
                "Optional plan tier to assign; omit or null for a custom/unmanaged tenant (the " +
                "default). Stamps the plan's quota onto the tenant unless `monthlyMessageQuota` " +
                "is also given (which overrides it).",
            },
            monthlyMessageQuota: {
              type: ["integer", "null"],
              minimum: 0,
              description: "Optional monthly message quota; omit or null for no limit. Overrides any quota the `plan` would stamp.",
            },
            systemWebhookUrl: {
              type: ["string", "null"],
              format: "uri",
              description:
                "URL to receive signed system events (`endpoint.disabled`, " +
                "`message.dead_lettered`). Must be http/https. When set, a signing secret " +
                "is auto-generated and returned once in the response.",
            },
          },
        },
        AppUpdate: {
          type: "object",
          description:
            "The body of `PATCH /v1/admin/apps/{id}`. Only the provided fields change; " +
            "assigning a `plan` re-stamps its catalog quota (an explicit `monthlyMessageQuota` " +
            "in the same patch overrides it; null removes the limit).",
          properties: {
            name: { type: "string", description: "Replace the human-readable label." },
            plan: {
              type: ["string", "null"],
              enum: [...PLAN_IDS, null],
              description:
                "Reassign the plan tier, or null for custom/unmanaged. Assigning a non-null plan " +
                "(without an explicit `monthlyMessageQuota` in the same patch) re-stamps the quota " +
                "from the catalog. Omit to leave unchanged.",
            },
            monthlyMessageQuota: {
              type: ["integer", "null"],
              minimum: 0,
              description: "Replace the monthly message quota; null removes the limit. Overrides any quota the `plan` would stamp.",
            },
            systemWebhookUrl: {
              type: ["string", "null"],
              format: "uri",
              description:
                "Replace the system webhook URL (null disables system webhooks and clears " +
                "the stored signing secret). Omit to leave it unchanged.",
            },
          },
        },
        RotateSystemSecretResult: {
          type: "object",
          description: "The result of rotating a system webhook secret: the new plaintext secret, returned once.",
          required: ["secret"],
          properties: {
            secret: {
              type: "string",
              description: "The new plaintext system webhook signing secret (`sws_…`). Returned once — persist it now.",
            },
          },
        },
        AppList: {
          type: "object",
          required: ["data"],
          properties: { data: { type: "array", items: ref("App") } },
        },
        ApiKey: {
          type: "object",
          description: "An API key's non-secret metadata. The secret is never included (the store keeps only its hash).",
          required: ["id", "appId", "prefix", "createdAt", "revokedAt", "lastUsedAt"],
          properties: {
            id: { type: "string", examples: ["ak_5Qm2..."], description: "Used to revoke the key." },
            appId: { type: "string", description: "The tenant this key authenticates as." },
            prefix: {
              type: "string",
              examples: ["phk_a1b2c3d4"],
              description: "A non-secret display fragment of the secret, so a key is recognisable in a list.",
            },
            createdAt: epochMs("Creation time, epoch ms."),
            revokedAt: {
              type: ["integer", "null"],
              format: "int64",
              description: "When the key was revoked (epoch ms), or null while it is still live.",
            },
            lastUsedAt: {
              type: ["integer", "null"],
              format: "int64",
              description: "The last time this key successfully authenticated a request (epoch ms), or null if it has never been used.",
            },
          },
        },
        ApiKeyList: {
          type: "object",
          required: ["data"],
          properties: { data: { type: "array", items: ref("ApiKey") } },
        },
        CreatedApiKey: {
          type: "object",
          description: "A freshly minted key: its metadata plus the one-time plaintext secret (shown only here).",
          required: ["apiKey", "secret"],
          properties: {
            apiKey: ref("ApiKey"),
            secret: {
              type: "string",
              examples: ["phk_..."],
              description: "The plaintext key secret. Returned once, never recoverable — store it now.",
            },
          },
        },
        Usage: {
          type: "object",
          description:
            "A tenant's usage over a date range — the metering/billing read model: accepted " +
            "messages (`total`/`daily`) plus delivery-attempt operations (`deliveries`).",
          required: ["appId", "from", "to", "total", "daily", "deliveries"],
          properties: {
            appId: { type: "string" },
            from: { type: "string", format: "date", description: "Inclusive start day (UTC), echoed back." },
            to: { type: "string", format: "date", description: "Inclusive end day (UTC), echoed back." },
            total: {
              type: "integer",
              minimum: 0,
              description: "Total messages accepted across the range (the billable count).",
            },
            daily: {
              type: "array",
              items: ref("UsageDay"),
              description: "Per-UTC-day message breakdown, oldest day first; only days with at least one message.",
            },
            deliveries: ref("DeliveryUsage"),
          },
        },
        UsageDay: {
          type: "object",
          description: "One UTC day's message count.",
          required: ["date", "messages"],
          properties: {
            date: { type: "string", format: "date", description: "The UTC day, `YYYY-MM-DD`." },
            messages: { type: "integer", minimum: 0, description: "Messages accepted on this day." },
          },
        },
        DeliveryUsage: {
          type: "object",
          description:
            "A tenant's delivery-attempt (operations) usage over the same range — every HTTP " +
            "delivery attempt Posthorn made, retries included, split by outcome.",
          required: ["total", "succeeded", "failed", "daily"],
          properties: {
            total: {
              type: "integer",
              minimum: 0,
              description: "Total delivery attempts across the range (the billable operations count).",
            },
            succeeded: { type: "integer", minimum: 0, description: "Of `total`, attempts that reached a 2xx." },
            failed: { type: "integer", minimum: 0, description: "Of `total`, attempts that failed." },
            daily: {
              type: "array",
              items: ref("DeliveryUsageDay"),
              description: "Per-UTC-day attempt breakdown, oldest day first; only days with at least one attempt.",
            },
          },
        },
        DeliveryUsageDay: {
          type: "object",
          description: "One UTC day's delivery-attempt counts.",
          required: ["date", "attempts", "succeeded", "failed"],
          properties: {
            date: { type: "string", format: "date", description: "The UTC day, `YYYY-MM-DD`." },
            attempts: { type: "integer", minimum: 0, description: "Total delivery attempts on this day." },
            succeeded: { type: "integer", minimum: 0, description: "Of those, attempts that reached a 2xx." },
            failed: { type: "integer", minimum: 0, description: "Of those, attempts that failed." },
          },
        },
        QuotaStatus: {
          type: "object",
          description:
            "A tenant's current-month quota status — the window `POST /v1/messages` enforces.",
          required: ["monthlyMessageQuota", "used", "remaining", "periodStart", "resetsAt"],
          properties: {
            monthlyMessageQuota: {
              type: ["integer", "null"],
              minimum: 0,
              description: "The plan's monthly message cap, or null for no limit.",
            },
            used: {
              type: "integer",
              minimum: 0,
              description: "Messages accepted so far this UTC month.",
            },
            remaining: {
              type: ["integer", "null"],
              minimum: 0,
              description:
                "Messages still allowed this month (floored at 0), or null when unlimited.",
            },
            periodStart: {
              type: "string",
              format: "date",
              description: "First day of the current UTC month, `YYYY-MM-DD`.",
            },
            resetsAt: {
              type: "string",
              format: "date",
              description: "First day of next UTC month — when the allowance resets, `YYYY-MM-DD`.",
            },
          },
        },
        TenantUsage: {
          description:
            "The tenant self-service usage view (`GET /v1/usage`): the queried range's message " +
            "breakdown plus a live current-month `quota` block.",
          allOf: [
            ref("Usage"),
            {
              type: "object",
              required: ["quota"],
              properties: { quota: ref("QuotaStatus") },
            },
          ],
        },
        BatchMessageInput: {
          type: "object",
          description: "The body of `POST /v1/messages/batch`.",
          required: ["messages"],
          properties: {
            messages: {
              type: "array",
              items: ref("NewMessage"),
              minItems: 1,
              maxItems: 100,
              description: "The messages to accept, up to 100. Each item uses the same shape as `POST /v1/messages`.",
            },
          },
        },
        BatchMessageOk: {
          type: "object",
          description: "A successfully accepted message in a batch response.",
          required: ["ok", "message", "deduplicated", "fanout"],
          properties: {
            ok: { type: "boolean", enum: [true] },
            message: ref("MessageSummary"),
            deduplicated: { type: "boolean", description: "True when an idempotency key collapsed this onto an existing message." },
            fanout: {
              ...nullableRef("FanoutSummary"),
              description: "The fan-out summary, or null for a deduplicated replay.",
            },
          },
        },
        BatchMessageError: {
          type: "object",
          description: "A failed message in a batch response.",
          required: ["ok", "error"],
          properties: {
            ok: { type: "boolean", enum: [false] },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  examples: ["invalid_request", "quota_exceeded", "idempotency_conflict"],
                },
                message: { type: "string" },
              },
            },
          },
        },
        BatchResults: {
          type: "object",
          description: "The `200` body of `POST /v1/messages/batch`: one result per input message, in order.",
          required: ["results"],
          properties: {
            results: {
              type: "array",
              items: { anyOf: [ref("BatchMessageOk"), ref("BatchMessageError")] },
              description: "One entry per message in the request, in the same order.",
            },
          },
        },
        NewPortalSession: {
          type: "object",
          description: "Input to `POST /v1/portal/sessions`.",
          required: ["externalUserId"],
          properties: {
            externalUserId: {
              type: "string",
              description:
                "Your identifier for the customer gaining portal access. Opaque to Posthorn — " +
                "used for auditing and to let you revoke the session later. Must be non-empty.",
              examples: ["user_123", "org_456"],
            },
            expiresIn: {
              type: "integer",
              minimum: 1,
              maximum: 604800,
              description:
                "How long the session remains valid, in seconds. Defaults to 86400 (24 h). " +
                "Maximum 604800 (7 days).",
              examples: [86400],
            },
          },
        },
        PortalSessionResult: {
          type: "object",
          description: "A minted consumer portal session.",
          required: ["token", "portalUrl", "expiresAt"],
          properties: {
            token: {
              type: "string",
              description:
                "The opaque session token. Pass it to the customer via `portalUrl` — there is " +
                "no need to handle it directly.",
            },
            portalUrl: {
              type: "string",
              format: "uri",
              description:
                "The full URL to redirect your customer to. It exchanges the token for an " +
                "`HttpOnly` session cookie and lands the customer at the portal endpoints page.",
              examples: ["https://webhooks.example.com/portal/login?token=…"],
            },
            expiresAt: epochMs("When the session expires, epoch ms."),
          },
        },
      },
    },
  };
}
