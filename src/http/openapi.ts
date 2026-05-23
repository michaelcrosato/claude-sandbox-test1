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

import { MAX_LIST_MESSAGES_LIMIT } from "../storage/message-store.js";
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
        "infrastructure: a single container with no Redis. This is the tenant-facing " +
        "v1 API. Every authenticated route is scoped to the API key's owning tenant — " +
        "an `appId` is never read from a request body — and cross-tenant access returns " +
        "`404` (existence is never revealed). App and API-key provisioning is a privileged " +
        "bootstrap operation done out of band (the `posthorn admin` CLI), not an HTTP route.",
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
      { name: "Operational", description: "Liveness, metrics, and this document." },
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
          ],
          responses: {
            "200": jsonResponse("A page of messages.", ref("MessageList")),
            "400": errorResponse("Invalid `limit` or `cursor`."),
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
            "400": errorResponse("Malformed request body (e.g. a non-http(s) URL)."),
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
            "400": errorResponse("Malformed request body."),
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
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A Posthorn API key presented as a Bearer token: `Authorization: Bearer <key>`. " +
            "Mint one with the `posthorn admin create-key` CLI.",
        },
      },
      schemas: {
        Health: {
          type: "object",
          required: ["status"],
          properties: { status: { type: "string", examples: ["ok"] } },
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
                  description: "A stable, machine-readable error code.",
                  examples: ["not_found", "unauthorized", "invalid_request", "idempotency_conflict"],
                },
                message: { type: "string", description: "A human-readable explanation." },
              },
            },
          },
        },
        MessageSummary: {
          type: "object",
          description: "A message without its payload or per-endpoint deliveries (list/accept view).",
          required: ["id", "appId", "eventType", "idempotencyKey", "createdAt"],
          properties: {
            id: { type: "string", examples: ["msg_2Yx9..."] },
            appId: { type: "string" },
            eventType: { type: "string", examples: ["user.created"] },
            idempotencyKey: { type: ["string", "null"] },
            createdAt: epochMs("Creation time, epoch ms."),
          },
        },
        Message: {
          type: "object",
          description: "A message plus its per-endpoint delivery statuses (detail view).",
          required: ["id", "appId", "eventType", "idempotencyKey", "payload", "createdAt", "deliveries"],
          properties: {
            id: { type: "string" },
            appId: { type: "string" },
            eventType: { type: "string" },
            idempotencyKey: { type: ["string", "null"] },
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
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string" },
            endpointId: { type: ["string", "null"] },
            status: {
              type: "string",
              enum: ["pending", "delivering", "succeeded", "dead_letter"],
              description: "`dead_letter` is terminal until an operator retry revives it.",
            },
            attempts: { type: "integer", minimum: 0, description: "Attempts started so far." },
            nextAttemptAt: {
              type: ["integer", "null"],
              format: "int64",
              description: "When the next attempt is due (epoch ms) while `pending`; otherwise null.",
            },
            lastError: { type: ["string", "null"], description: "Detail of the most recent failure." },
            createdAt: epochMs("Enqueue time, epoch ms."),
            updatedAt: epochMs("Last state change, epoch ms."),
          },
        },
        Endpoint: {
          type: "object",
          description: "A delivery destination. The signing secret is never included in this view.",
          required: ["id", "appId", "url", "description", "eventTypes", "disabled", "createdAt", "updatedAt"],
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
            disabled: { type: "boolean", description: "When true, the endpoint is paused and skipped by fan-out." },
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
            disabled: { type: "boolean", description: "Whether the endpoint starts paused. Defaults to false." },
          },
        },
        EndpointUpdate: {
          type: "object",
          description: "The body of `PATCH /v1/endpoints/{id}`. Only the provided fields change.",
          properties: {
            url: { type: "string", format: "uri" },
            secret: { type: "string", description: "Rotate the signing secret." },
            description: { type: "string" },
            eventTypes: { type: ["array", "null"], items: { type: "string" } },
            disabled: { type: "boolean" },
          },
        },
        FanoutSummary: {
          type: "object",
          description: "How many endpoints a message fanned out to, and why others were skipped.",
          required: ["matched", "skippedDisabled", "skippedUnsubscribed"],
          properties: {
            matched: { type: "integer", minimum: 0, description: "Endpoints a delivery was enqueued for." },
            skippedDisabled: { type: "integer", minimum: 0, description: "Endpoints skipped as disabled." },
            skippedUnsubscribed: {
              type: "integer",
              minimum: 0,
              description: "Endpoints skipped as not subscribed to the event type.",
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
      },
    },
  };
}
