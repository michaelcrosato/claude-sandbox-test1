/**
 * The endpoint store: how Posthorn persists *where* events are delivered.
 *
 * A message says *what* happened; an {@link Endpoint} says *who* should hear about
 * it and *how to prove* the delivery is authentic — a destination URL, the signing
 * secret, and an optional event-type subscription filter. This is the configuration
 * the delivery worker needs but the queue does not carry: a queued
 * {@link DeliveryTask} references an endpoint by opaque id, and an
 * `EndpointResolver` (see `endpoint-resolver.ts`) loads it through this store at
 * send time.
 *
 * Like {@link MessageStore} and {@link DeliveryQueue}, this is a backend-agnostic
 * contract (`in-memory` reference + durable `SQLite`, one shared conformance suite),
 * so the rest of the system never depends on the storage engine. It is the data
 * foundation P3's HTTP API (apps/endpoints CRUD) and message fan-out sit on.
 *
 * ## Tenancy
 *
 * Every endpoint carries an `appId` — the tenant it belongs to — so a single
 * Posthorn instance is multi-tenant from day one and {@link EndpointStore.listByApp}
 * never leaks across tenants. The `appId` is treated as an opaque scope string here;
 * the application/tenant entity that mints and validates it is a later tick.
 */

import { randomBytes } from "node:crypto";
import {
  fixedSchedule,
  type RetryPolicy,
} from "../delivery/retry-policy.js";

// ---- Endpoint Filter DSL ----

/**
 * A comparison against a scalar value extracted from the message payload via a
 * dot-path. If the path is absent or the types are incompatible for ordered
 * operators, the filter evaluates to `false`. The `contains` op checks
 * substring membership for string payloads and element membership for arrays.
 */
export interface FieldFilter {
  readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith";
  /** Dot-separated key path into the message payload, e.g. `"data.status"`. */
  readonly path: string;
  readonly value: string | number | boolean | null;
}

/** Logical AND: all child filters must match. */
export interface AndFilter {
  readonly op: "and";
  readonly filters: readonly EndpointFilter[];
}

/** Logical OR: at least one child filter must match. */
export interface OrFilter {
  readonly op: "or";
  readonly filters: readonly EndpointFilter[];
}

/** Logical NOT: inverts the child filter. */
export interface NotFilter {
  readonly op: "not";
  readonly filter: EndpointFilter;
}

/**
 * A filter expression that gates delivery based on the message payload.
 * `null` on an endpoint means no filter — deliver all matching event types.
 * When set, a delivery is only enqueued when the payload matches this
 * expression. See {@link matchesFilter} and {@link normalizeEndpointFilter}.
 */
export type EndpointFilter = FieldFilter | AndFilter | OrFilter | NotFilter;

/** Maximum total nodes in a single filter tree. Prevents runaway evaluation. */
export const MAX_FILTER_NODES = 20;
/** Maximum nesting depth of logical combinators. Prevents deeply nested trees. */
export const MAX_FILTER_DEPTH = 5;

/**
 * A signing secret that was retired by a rotation but is still used to sign
 * deliveries until {@link ExpiringSecret.expiresAt}. This is what makes secret
 * rotation *zero-downtime*: for the overlap window after a rotation, each delivery
 * is signed with the new primary secret **and** every still-active retired one
 * (multiple space-delimited tokens in the `webhook-signature` header, which the
 * Standard Webhooks verifier already accepts), so a receiver that has not yet
 * switched to the new secret keeps verifying. See {@link rotateEndpointSecret}.
 */
export interface ExpiringSecret {
  /** The retired signing secret (`whsec_…` or bare base64). */
  readonly secret: string;
  /** Epoch ms after which this secret is no longer used to sign. */
  readonly expiresAt: number;
}

/**
 * A delivery destination. Immutable snapshot; every mutation produces a new one
 * with a bumped `updatedAt`.
 */
export interface Endpoint {
  /** Server-assigned unique id (e.g. `ep_…`). */
  readonly id: string;
  /** The tenant this endpoint belongs to. Opaque scope string. */
  readonly appId: string;
  /** Absolute `http`/`https` URL the signed payload is POSTed to. */
  readonly url: string;
  /** The current (primary) signing secret (`whsec_…`), per Standard Webhooks. */
  readonly secret: string;
  /**
   * Secrets retired by a rotation that are still used to sign until each one's
   * `expiresAt` — the overlap window that makes rotation zero-downtime. Newest
   * retirement first; empty for an endpoint that has never rotated. Populated only
   * by {@link rotateEndpointSecret} (a direct `secret` patch via
   * {@link applyEndpointUpdate} is a deliberate hard swap and leaves this list
   * untouched). Never exposed over HTTP.
   */
  readonly previousSecrets: readonly ExpiringSecret[];
  /** Human-readable label. Empty string when none was given. */
  readonly description: string;
  /**
   * The event types this endpoint is subscribed to. `null` means *all* events;
   * a (possibly empty) array means *exactly* those types. See
   * {@link endpointSubscribesTo}.
   */
  readonly eventTypes: readonly string[] | null;
  /**
   * Custom HTTP headers added to every delivery to this endpoint — useful for
   * receiver-side authentication (`X-API-Key`, `Authorization: Bearer …`) or
   * tenant routing. `null` means no custom headers. The Standard Webhooks signing
   * headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) and
   * `content-type` are always set by Posthorn and cannot be overridden here; see
   * {@link FORBIDDEN_DELIVERY_HEADERS}.
   */
  readonly headers: Readonly<Record<string, string>> | null;
  /**
   * Custom retry schedule for this endpoint. When `null` the system-wide default
   * policy applies. When set, `delaysMs` overrides that policy for deliveries to
   * this endpoint only — useful when some endpoints warrant faster retries (e.g.
   * high-priority payments) or fewer (e.g. analytics sinks where staleness is
   * acceptable).
   */
  readonly retryPolicy: RetryPolicy | null;
  /**
   * Payload filter — if set, a delivery is only enqueued when the message
   * payload matches this expression. `null` means no filter (deliver all
   * matching event types). Evaluated at fan-out time against the parsed payload
   * so non-matching messages are dropped before any queue work is created.
   * See {@link matchesFilter} and {@link normalizeEndpointFilter}.
   */
  readonly filter: EndpointFilter | null;
  /**
   * Channel this endpoint is scoped to. `null` = **global**: receives all messages
   * regardless of channel. A string value = **channel-scoped**: receives only
   * messages whose channel matches. Global endpoints also receive channel-tagged
   * messages; channel endpoints never receive untagged (null-channel) messages
   * unless their channel is null.
   */
  readonly channel: string | null;
  /**
   * When `true`, the endpoint is administratively paused. Fan-out skips it, and a
   * resolver declines to resolve it (so an in-flight task fails rather than
   * delivers — see `endpoint-resolver.ts`).
   */
  readonly disabled: boolean;
  /**
   * Number of consecutive *dead-lettered* deliveries to this endpoint since its last
   * successful delivery (or since creation). Reset to `0` by any success. Surfaced
   * for observability ("why is this endpoint unhealthy?") and, together with
   * {@link Endpoint.firstFailureAt}, the basis for automatic disabling — see
   * {@link evaluateEndpointHealth}.
   */
  readonly consecutiveFailures: number;
  /**
   * Epoch ms when the current run of consecutive failures began, or `null` when the
   * endpoint is healthy (no active failure streak). Once a delivery has been failing
   * continuously for at least the configured window measured from this instant, the
   * endpoint is auto-disabled.
   */
  readonly firstFailureAt: number | null;
  /** Epoch ms of the most recent dead-lettered delivery, or `null` when healthy. */
  readonly lastFailureAt: number | null;
  /** Creation time, epoch ms. */
  readonly createdAt: number;
  /** Time of the last mutation, epoch ms. */
  readonly updatedAt: number;
}

/** The fields a caller provides to create an endpoint. */
export interface NewEndpoint {
  /** The owning tenant. Must be a non-empty string. */
  readonly appId: string;
  /** Absolute `http`/`https` destination URL. */
  readonly url: string;
  /**
   * Signing secret (`whsec_…` or bare base64). Omit to have a fresh, secure one
   * generated — the common case. Must be a non-empty string when provided.
   */
  readonly secret?: string;
  /** Optional human-readable label. Defaults to `""`. */
  readonly description?: string;
  /**
   * Subscription filter. Omit (or pass `null`) to subscribe to all events; pass
   * an array to subscribe to exactly those event types. Defaults to all.
   */
  readonly eventTypes?: readonly string[] | null;
  /** Whether the endpoint starts paused. Defaults to `false`. */
  readonly disabled?: boolean;
  /**
   * Custom HTTP headers to add to every delivery. Omit (or pass `null`) for none.
   * Cannot contain reserved headers (see {@link FORBIDDEN_DELIVERY_HEADERS}).
   */
  readonly headers?: Readonly<Record<string, string>> | null;
  /**
   * Custom retry schedule. Omit (or pass `null`) to use the system-wide default.
   * An array of inter-attempt delays in milliseconds; length is the number of
   * retries (max {@link MAX_RETRY_POLICY_RETRIES}). Each delay must be a finite,
   * non-negative number.
   */
  readonly retryPolicy?: RetryPolicy | null;
  /**
   * Payload filter. Omit (or pass `null`) for no filter — deliver all matching
   * event types. When set, only messages whose payload matches the expression
   * trigger a delivery. See {@link EndpointFilter}.
   */
  readonly filter?: EndpointFilter | null;
  /**
   * Channel scope. Omit (or pass `null`) for a global endpoint that receives all
   * messages. Set to a string to scope this endpoint to only messages tagged with
   * the same channel.
   */
  readonly channel?: string | null;
}

/**
 * A patch applied to an existing endpoint. Every field is optional; only the
 * provided fields change. `appId` is intentionally *not* patchable — an endpoint
 * never migrates tenants.
 */
export interface EndpointUpdate {
  /** Replace the destination URL (validated like {@link NewEndpoint.url}). */
  readonly url?: string;
  /** Rotate the signing secret (validated like {@link NewEndpoint.secret}). */
  readonly secret?: string;
  /** Replace the description. */
  readonly description?: string;
  /** Replace the subscription filter (`null` = all events). */
  readonly eventTypes?: readonly string[] | null;
  /** Pause or resume the endpoint. */
  readonly disabled?: boolean;
  /**
   * Replace custom delivery headers. Pass `null` to clear all custom headers.
   * Cannot contain reserved headers (see {@link FORBIDDEN_DELIVERY_HEADERS}).
   */
  readonly headers?: Readonly<Record<string, string>> | null;
  /**
   * Replace the retry schedule. Pass `null` to revert to the system-wide default.
   * Same shape and constraints as {@link NewEndpoint.retryPolicy}.
   */
  readonly retryPolicy?: RetryPolicy | null;
  /**
   * Replace the payload filter. Pass `null` to remove the filter (deliver all
   * matching event types again). Same shape and constraints as
   * {@link NewEndpoint.filter}.
   */
  readonly filter?: EndpointFilter | null;
  /**
   * Replace the channel scope. Pass `null` to make the endpoint global again.
   */
  readonly channel?: string | null;
}

/**
 * The result of {@link EndpointStore.recordDeliveryOutcome}. Surfaces both the
 * resulting endpoint snapshot and whether this call triggered an auto-disable,
 * so callers (the delivery worker via the gateway) can emit the
 * `endpoint.disabled` system webhook event without a separate read.
 */
export interface EndpointOutcomeResult {
  /** The resulting endpoint snapshot, or `null` if the id is unknown/deleted. */
  readonly endpoint: Endpoint | null;
  /**
   * `true` only when this specific call transitioned the endpoint from enabled to
   * automatically disabled (i.e. the failure streak just crossed the threshold).
   * Always `false` when `endpoint` is `null` or when the endpoint was already disabled.
   */
  readonly autoDisabled: boolean;
}

/**
 * Durable storage for endpoints, scoped by tenant.
 *
 * Asynchronous so one contract spans synchronous engines (in-memory, SQLite via
 * `node:sqlite`) and asynchronous ones (Postgres) alike; sync backends resolve
 * eagerly.
 */
export interface EndpointStore {
  /** Create an endpoint, returning the freshly created snapshot. */
  create(input: NewEndpoint): Promise<Endpoint>;
  /** Fetch an endpoint by id, or `null` if unknown. */
  get(id: string): Promise<Endpoint | null>;
  /** List a tenant's endpoints, oldest-first. Empty array for an unknown tenant. */
  listByApp(appId: string): Promise<readonly Endpoint[]>;
  /**
   * Apply a patch to an endpoint and return the updated snapshot. Throws
   * {@link UnknownEndpointError} if the id is unknown.
   */
  update(id: string, patch: EndpointUpdate): Promise<Endpoint>;
  /**
   * Rotate the endpoint's signing secret with zero downtime: install a fresh
   * primary secret while keeping the old one active for an overlap window (see
   * {@link rotateEndpointSecret}). Returns the updated snapshot — whose `secret`
   * is the **new** primary, to be revealed to the caller exactly once, like
   * {@link create}'s. Throws {@link UnknownEndpointError} if the id is unknown.
   */
  rotateSecret(id: string, options?: RotateSecretOptions): Promise<Endpoint>;
  /**
   * Record a *terminal* delivery outcome against an endpoint's health (see
   * {@link evaluateEndpointHealth}) and persist any resulting change — including an
   * **automatic disable** once the endpoint has been failing continuously for
   * `autoDisableAfterMs` (default {@link DEFAULT_AUTO_DISABLE_AFTER_MS}; `0` turns
   * auto-disabling off, health still tracked).
   *
   * Returns the resulting snapshot — the *unchanged* one when a healthy endpoint
   * succeeds (the no-write hot path, since most deliveries succeed) — or `null` if
   * the id is unknown (e.g. the endpoint was deleted), which is a no-op. Callers
   * (the delivery worker) report best-effort and ignore the result.
   */
  recordDeliveryOutcome(
    id: string,
    outcome: DeliveryHealthOutcome,
    nowMs: number,
    autoDisableAfterMs?: number,
  ): Promise<EndpointOutcomeResult>;
  /** Delete an endpoint. Returns `true` if it existed, `false` otherwise. */
  delete(id: string): Promise<boolean>;
}

/** Options for {@link EndpointStore.rotateSecret}. */
export interface RotateSecretOptions {
  /**
   * The new primary secret to install. Omit to have the backend generate a fresh,
   * secure one (the common case). Must be a non-empty string when provided.
   */
  readonly secret?: string;
  /**
   * How long (ms) the *old* primary secret keeps being used to sign after the
   * rotation, so receivers mid-migration still verify. Defaults to
   * {@link DEFAULT_SECRET_ROTATION_OVERLAP_MS}. `0` retires the old secret
   * immediately (an instant hard swap, no overlap).
   */
  readonly overlapMs?: number;
}

/** Thrown when an operation references an endpoint id the store does not hold. */
export class UnknownEndpointError extends Error {
  /** The unknown endpoint id. */
  readonly endpointId: string;
  constructor(endpointId: string) {
    super(`no endpoint with id "${endpointId}"`);
    this.name = "UnknownEndpointError";
    this.endpointId = endpointId;
  }
}

/**
 * Maximum number of custom delivery headers per endpoint. Bounds the header-map
 * size stored and the extra signing work done per delivery.
 */
export const MAX_CUSTOM_HEADERS = 20;

/** Maximum length of a channel string. */
export const MAX_CHANNEL_LENGTH = 200;

/**
 * Validate and normalize a channel value. Returns `null` for absent/null input
 * (no channel scoping). Throws {@link TypeError} on a non-string, empty string,
 * oversized string, or a string containing control characters.
 */
export function normalizeChannel(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new TypeError("channel must be a string or null");
  if (v.length === 0) throw new TypeError("channel must not be empty");
  if (v.length > MAX_CHANNEL_LENGTH)
    throw new TypeError(`channel must be at most ${MAX_CHANNEL_LENGTH} characters`);
  if (/[\r\n\0]/.test(v)) throw new TypeError("channel must not contain control characters");
  return v;
}

/**
 * Maximum number of retries in a custom per-endpoint retry policy. The total
 * delivery attempts is this + 1. Bounds the array size stored per endpoint.
 */
export const MAX_RETRY_POLICY_RETRIES = 20;

/**
 * Maximum delay (ms) allowed in a custom retry policy: 30 days. Prevents a
 * misconfigured endpoint from parking tasks indefinitely.
 */
export const MAX_RETRY_POLICY_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Maximum number of status codes in a `nonRetryableStatuses` list. Bounds the
 * array size stored per endpoint's retry policy.
 */
export const MAX_NON_RETRYABLE_STATUSES = 20;

/**
 * Header names that Posthorn controls and a caller cannot override via custom
 * headers. They are applied after the custom headers in {@link buildSignedRequest},
 * so they always win regardless — this set makes the rejection explicit at
 * intake so callers see a clear error rather than a silent override.
 */
export const FORBIDDEN_DELIVERY_HEADERS = new Set([
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "content-type",
]);

/** Prefix on generated endpoint ids. */
const ENDPOINT_ID_PREFIX = "ep_";

/**
 * The default endpoint-id generator: an `ep_`-prefixed, URL-safe token with 144
 * bits of CSPRNG entropy. Inject a deterministic generator in tests.
 */
export function createEndpointId(): string {
  return ENDPOINT_ID_PREFIX + randomBytes(18).toString("base64url");
}

/**
 * Whether an endpoint is subscribed to a given event type. A `null` filter
 * (subscribe-to-all) matches everything; otherwise membership decides. Pure and
 * shared so fan-out and any backend agree exactly.
 */
export function endpointSubscribesTo(
  endpoint: Pick<Endpoint, "eventTypes">,
  eventType: string,
): boolean {
  return endpoint.eventTypes === null || endpoint.eventTypes.includes(eventType);
}

/**
 * Validate a destination URL, returning its normalized string form. Must be an
 * absolute `http:`/`https:` URL — anything else is a configuration error and a
 * security risk (e.g. `file:`/`javascript:`), so it throws {@link TypeError}.
 */
function normalizeUrl(url: unknown): string {
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError("url must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`url is not a valid absolute URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`url must use http or https, got "${parsed.protocol}"`);
  }
  return parsed.toString();
}

/**
 * Validate a supplied secret. Required to be a non-empty string here; the
 * "generate one when omitted" behaviour for create lives in
 * {@link normalizeNewEndpoint}, which signals it with `null` so each backend can
 * use its own (injectable, test-deterministic) secret generator.
 */
function normalizeSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError("secret must be a non-empty string when provided");
  }
  return secret;
}

/** Validate an optional description, defaulting an absent one to `""`. */
function normalizeDescription(description: unknown): string {
  if (description === undefined) {
    return "";
  }
  if (typeof description !== "string") {
    throw new TypeError("description must be a string");
  }
  return description;
}

/**
 * Validate an event-type filter and return its canonical form: `null` for
 * subscribe-to-all, or a de-duplicated, order-preserving array of non-empty
 * strings. Canonicalizing here keeps equality stable across backends (the SQLite
 * backend persists this exact array as JSON).
 */
function normalizeEventTypes(
  eventTypes: readonly string[] | null | undefined,
): readonly string[] | null {
  if (eventTypes === undefined || eventTypes === null) {
    return null;
  }
  if (!Array.isArray(eventTypes)) {
    throw new TypeError("eventTypes must be an array of strings, or null");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const type of eventTypes) {
    if (typeof type !== "string" || type.length === 0) {
      throw new TypeError("each eventType must be a non-empty string");
    }
    if (!seen.has(type)) {
      seen.add(type);
      out.push(type);
    }
  }
  return out;
}

/** Validate an optional boolean flag, defaulting an absent one to `false`. */
function normalizeDisabled(disabled: unknown): boolean {
  if (disabled === undefined) {
    return false;
  }
  if (typeof disabled !== "boolean") {
    throw new TypeError("disabled must be a boolean");
  }
  return disabled;
}

/** Validate a tenant scope id. */
function normalizeAppId(appId: unknown): string {
  if (typeof appId !== "string" || appId.length === 0) {
    throw new TypeError("appId must be a non-empty string");
  }
  return appId;
}

/** The validated, normalized fields of a {@link NewEndpoint}. */
export interface NormalizedNewEndpoint {
  readonly appId: string;
  readonly url: string;
  /** The supplied secret, or `null` when the caller omitted it (generate one). */
  readonly secret: string | null;
  readonly description: string;
  readonly eventTypes: readonly string[] | null;
  readonly disabled: boolean;
  readonly headers: Readonly<Record<string, string>> | null;
  readonly retryPolicy: RetryPolicy | null;
  readonly filter: EndpointFilter | null;
  readonly channel: string | null;
}

/**
 * Validate and normalize a custom headers map: rejects reserved headers, non-string
 * values, newlines in keys/values (header-injection prevention), and maps that exceed
 * {@link MAX_CUSTOM_HEADERS}. An empty map normalizes to `null` (canonical "none").
 */
export function normalizeHeaders(
  headers: unknown,
): Readonly<Record<string, string>> | null {
  if (headers === undefined || headers === null) return null;
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("headers must be a plain object or null");
  }
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    throw new TypeError(
      `headers may not contain more than ${MAX_CUSTOM_HEADERS} entries`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("each header name must be a non-empty string");
    }
    if (/[\r\n]/.test(key)) {
      throw new TypeError(`header name "${key}" must not contain CR or LF`);
    }
    if (FORBIDDEN_DELIVERY_HEADERS.has(key.toLowerCase())) {
      throw new TypeError(
        `header "${key}" is reserved by Posthorn and cannot be set as a custom header`,
      );
    }
    if (typeof value !== "string") {
      throw new TypeError(`header value for "${key}" must be a string`);
    }
    if (/[\r\n]/.test(value)) {
      throw new TypeError(`header value for "${key}" must not contain CR or LF`);
    }
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Validate and normalize the `nonRetryableStatuses` field of a retry policy.
 * Returns `undefined` for absent/null/empty. Each entry must be a valid HTTP
 * status code integer in [100, 599]. Deduplicates, order-preserving.
 */
function normalizeNonRetryableStatuses(value: unknown): readonly number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("retryPolicy.nonRetryableStatuses must be an array of integers or null");
  }
  if (value.length > MAX_NON_RETRYABLE_STATUSES) {
    throw new TypeError(
      `retryPolicy.nonRetryableStatuses may not contain more than ${MAX_NON_RETRYABLE_STATUSES} entries`,
    );
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const s of value) {
    if (typeof s !== "number" || !Number.isInteger(s) || s < 100 || s > 599) {
      throw new TypeError(
        "each entry in retryPolicy.nonRetryableStatuses must be a valid HTTP status code (100–599)",
      );
    }
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.length === 0 ? undefined : Object.freeze(out);
}

/**
 * Validate and normalize a custom retry policy. Returns `null` for
 * "use system default" (`undefined` / `null` input). Otherwise validates that
 * the payload is `{ delaysMs: number[], nonRetryableStatuses?: number[] }` with
 * at most {@link MAX_RETRY_POLICY_RETRIES} delay entries, each finite,
 * non-negative, and at most {@link MAX_RETRY_POLICY_DELAY_MS}, and at most
 * {@link MAX_NON_RETRYABLE_STATUSES} non-retryable status codes in [100, 599].
 * Re-uses {@link fixedSchedule} for the per-delay checks.
 */
export function normalizeRetryPolicy(policy: unknown): RetryPolicy | null {
  if (policy === undefined || policy === null) return null;
  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("retryPolicy must be an object { delaysMs: number[] } or null");
  }
  const raw = policy as Record<string, unknown>;
  if (!Array.isArray(raw["delaysMs"])) {
    throw new TypeError("retryPolicy.delaysMs must be an array");
  }
  const delaysMs = raw["delaysMs"] as unknown[];
  if (delaysMs.length > MAX_RETRY_POLICY_RETRIES) {
    throw new TypeError(
      `retryPolicy.delaysMs may not contain more than ${MAX_RETRY_POLICY_RETRIES} entries`,
    );
  }
  for (const d of delaysMs) {
    if (typeof d !== "number") {
      throw new TypeError("each delay in retryPolicy.delaysMs must be a number");
    }
    if (d > MAX_RETRY_POLICY_DELAY_MS) {
      throw new TypeError(
        `each delay in retryPolicy.delaysMs must not exceed ${MAX_RETRY_POLICY_DELAY_MS} ms (30 days)`,
      );
    }
  }
  // fixedSchedule validates finite + non-negative per-delay; reuse it.
  const base = fixedSchedule(delaysMs as number[]);
  const nonRetryableStatuses = normalizeNonRetryableStatuses(raw["nonRetryableStatuses"]);
  if (nonRetryableStatuses !== undefined) {
    return { ...base, nonRetryableStatuses };
  }
  return base;
}

const FIELD_FILTER_OPS = new Set<string>([
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith",
]);
const LOGICAL_OPS = new Set<string>(["and", "or"]);

function validateFilterNode(
  raw: unknown,
  depth: number,
  counter: { count: number },
): EndpointFilter {
  if (depth >= MAX_FILTER_DEPTH) {
    throw new TypeError(
      `filter exceeds maximum nesting depth of ${MAX_FILTER_DEPTH}`,
    );
  }
  if (++counter.count > MAX_FILTER_NODES) {
    throw new TypeError(
      `filter exceeds maximum of ${MAX_FILTER_NODES} nodes`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("each filter node must be a plain object");
  }
  const node = raw as Record<string, unknown>;
  const op = node["op"];
  if (typeof op !== "string") {
    throw new TypeError('each filter node must have an "op" string field');
  }
  if (LOGICAL_OPS.has(op)) {
    const filters = node["filters"];
    if (!Array.isArray(filters) || filters.length === 0) {
      throw new TypeError(`"${op}" filter must have a non-empty "filters" array`);
    }
    if (filters.length > 10) {
      throw new TypeError(
        `"${op}" filter may not have more than 10 children`,
      );
    }
    const validated = filters.map((f) => validateFilterNode(f, depth + 1, counter));
    return { op: op as "and" | "or", filters: validated };
  }
  if (op === "not") {
    const inner = node["filter"];
    if (inner === undefined) {
      throw new TypeError('"not" filter must have a "filter" field');
    }
    return { op: "not", filter: validateFilterNode(inner, depth + 1, counter) };
  }
  if (FIELD_FILTER_OPS.has(op)) {
    const path = node["path"];
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError('field filter must have a non-empty "path" string');
    }
    if (path.length > 100) {
      throw new TypeError("filter path must not exceed 100 characters");
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(path)) {
      throw new TypeError(
        `filter path "${path}" is invalid: use dot-separated identifier segments (letters, digits, underscores)`,
      );
    }
    const value = node["value"];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new TypeError('filter "value" must be a string, number, boolean, or null');
    }
    if (
      (op === "contains" || op === "startsWith") &&
      value !== null &&
      typeof value !== "string"
    ) {
      throw new TypeError(`"${op}" filter "value" must be a string or null`);
    }
    return {
      op: op as FieldFilter["op"],
      path,
      value: value as string | number | boolean | null,
    };
  }
  throw new TypeError(`unknown filter op "${op}"`);
}

/**
 * Validate and normalize a payload filter. Returns `null` for absent/`null`
 * input (no filter). Throws {@link TypeError} on malformed structure, unknown
 * ops, invalid paths, over-deep nesting ({@link MAX_FILTER_DEPTH}), or too
 * many nodes ({@link MAX_FILTER_NODES}).
 */
export function normalizeEndpointFilter(raw: unknown): EndpointFilter | null {
  if (raw === undefined || raw === null) return null;
  return validateFilterNode(raw, 0, { count: 0 });
}

/** Extract a value at a dot-path from a parsed payload object. */
function getPathValue(path: string, obj: unknown): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function evalFilter(filter: EndpointFilter, payload: unknown): boolean {
  if (filter.op === "and") {
    return filter.filters.every((f) => evalFilter(f, payload));
  }
  if (filter.op === "or") {
    return filter.filters.some((f) => evalFilter(f, payload));
  }
  if (filter.op === "not") {
    return !evalFilter(filter.filter, payload);
  }
  // FieldFilter
  const actual = getPathValue(filter.path, payload);
  const expected = filter.value;
  switch (filter.op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains":
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    case "startsWith":
      return (
        typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected)
      );
  }
}

/**
 * Evaluate a filter expression against a parsed message payload. A `null` or
 * `undefined` filter always returns `true` (no filter = deliver everything).
 * Pure and shared so fan-out and any caller agree exactly.
 */
export function matchesFilter(
  filter: EndpointFilter | null | undefined,
  payload: unknown,
): boolean {
  if (filter == null) return true;
  return evalFilter(filter, payload);
}

/**
 * Validate and normalize a create call, throwing {@link TypeError} on malformed
 * input. Shared by every backend so they enforce an identical intake contract. A
 * `secret` of `null` means none was supplied and the backend should mint one with
 * its injected secret generator.
 */
export function normalizeNewEndpoint(input: NewEndpoint): NormalizedNewEndpoint {
  return {
    appId: normalizeAppId(input.appId),
    url: normalizeUrl(input.url),
    secret: input.secret === undefined ? null : normalizeSecret(input.secret),
    description: normalizeDescription(input.description),
    eventTypes: normalizeEventTypes(input.eventTypes),
    disabled: normalizeDisabled(input.disabled),
    headers: normalizeHeaders(input.headers),
    retryPolicy: normalizeRetryPolicy(input.retryPolicy),
    filter: normalizeEndpointFilter(input.filter),
    channel: normalizeChannel(input.channel),
  };
}

/**
 * Apply a validated patch to an existing endpoint, returning the next immutable
 * snapshot with `updatedAt` advanced to `nowMs`. Each provided field is run
 * through the same validators as create, so an update cannot smuggle in a state
 * that create would reject. Shared by every backend so update semantics cannot
 * drift. `id`, `appId`, and `createdAt` are preserved.
 */
export function applyEndpointUpdate(
  current: Endpoint,
  patch: EndpointUpdate,
  nowMs: number,
): Endpoint {
  const nextDisabled =
    "disabled" in patch ? normalizeDisabled(patch.disabled) : current.disabled;
  // Re-enabling a (possibly auto-)disabled endpoint clears its failure streak so it
  // resumes from a clean slate — otherwise a stale streak would immediately re-trip
  // auto-disable on the next failure. Recovery is a deliberate operator action.
  const reEnabled = current.disabled && !nextDisabled;
  return {
    id: current.id,
    appId: current.appId,
    url: "url" in patch ? normalizeUrl(patch.url) : current.url,
    secret: "secret" in patch ? normalizeSecret(patch.secret) : current.secret,
    // A direct `secret` patch is a hard swap; the overlap-managed retirees are
    // owned solely by rotateEndpointSecret and carried through untouched here.
    previousSecrets: current.previousSecrets,
    description:
      "description" in patch
        ? normalizeDescription(patch.description)
        : current.description,
    eventTypes:
      "eventTypes" in patch
        ? normalizeEventTypes(patch.eventTypes)
        : current.eventTypes,
    headers: "headers" in patch ? normalizeHeaders(patch.headers) : current.headers,
    retryPolicy:
      "retryPolicy" in patch
        ? normalizeRetryPolicy(patch.retryPolicy)
        : current.retryPolicy,
    filter:
      "filter" in patch
        ? normalizeEndpointFilter(patch.filter)
        : current.filter,
    channel:
      "channel" in patch
        ? normalizeChannel(patch.channel)
        : current.channel,
    disabled: nextDisabled,
    consecutiveFailures: reEnabled ? 0 : current.consecutiveFailures,
    firstFailureAt: reEnabled ? null : current.firstFailureAt,
    lastFailureAt: reEnabled ? null : current.lastFailureAt,
    createdAt: current.createdAt,
    updatedAt: nowMs,
  };
}

/**
 * Default overlap window for {@link rotateEndpointSecret}: how long the previous
 * secret keeps signing after a rotation. 24h gives receivers a generous, but
 * bounded, window to switch to the new secret before it stops being used.
 */
export const DEFAULT_SECRET_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * The most retired secrets an endpoint retains. Bounds the number of signatures
 * on a single delivery (and so the header size and HMAC work) if an operator
 * rotates several times within one overlap window; the oldest beyond this are
 * dropped. The primary secret is always in addition to these.
 */
export const MAX_PREVIOUS_SECRETS = 8;

/**
 * The secrets a delivery should be signed with at `nowMs`: the current primary
 * plus every retired secret still inside its overlap window (expired ones are
 * filtered out). Pure and shared so the resolver/worker and any backend agree
 * exactly on which secrets are active. The result is never empty (the primary is
 * always present) and is ordered primary-first.
 */
export function activeSigningSecrets(
  endpoint: Pick<Endpoint, "secret" | "previousSecrets">,
  nowMs: number,
): readonly string[] {
  const stillActive = endpoint.previousSecrets
    .filter((s) => s.expiresAt > nowMs)
    .map((s) => s.secret);
  return [endpoint.secret, ...stillActive];
}

/**
 * Rotate an endpoint's signing secret with zero downtime, returning the next
 * immutable snapshot. Pure (the new secret and clock are supplied, never sampled
 * here, so backends stay deterministic): `newSecret` becomes the primary, the old
 * primary is retained as an {@link ExpiringSecret} that keeps signing for
 * `overlapMs`, already-expired retirees are pruned, and the list is capped at
 * {@link MAX_PREVIOUS_SECRETS} (oldest dropped). `overlapMs` of `0` retires the
 * old secret immediately (a hard swap with no overlap). Throws {@link TypeError}
 * on a malformed secret or a negative/non-finite `overlapMs` — the same intake
 * discipline as create/update, so a bad request surfaces as a `400`.
 */
export function rotateEndpointSecret(
  current: Endpoint,
  newSecret: string,
  nowMs: number,
  overlapMs: number = DEFAULT_SECRET_ROTATION_OVERLAP_MS,
): Endpoint {
  const secret = normalizeSecret(newSecret);
  if (typeof overlapMs !== "number" || !Number.isFinite(overlapMs) || overlapMs < 0) {
    throw new TypeError("overlapMs must be a non-negative finite number");
  }
  const expiresAt = nowMs + overlapMs;
  const previousSecrets: ExpiringSecret[] = [
    // Retain the just-retired primary only if the overlap keeps it active.
    ...(overlapMs > 0 ? [{ secret: current.secret, expiresAt }] : []),
    // Keep prior retirees that have not yet expired; drop the dead ones.
    ...current.previousSecrets.filter((s) => s.expiresAt > nowMs),
  ].slice(0, MAX_PREVIOUS_SECRETS);
  return {
    ...current,
    secret,
    previousSecrets,
    updatedAt: nowMs,
  };
}

/**
 * Default window before an endpoint that is failing continuously is automatically
 * disabled: **5 days**. Long enough that a sustained-but-recoverable receiver outage
 * (which the multi-attempt, ~28h retry schedule already absorbs *per message*) does
 * not trip it, yet short enough to stop indefinitely wasting delivery attempts — and
 * the tenant's metered delivery operations — on a permanently-dead endpoint.
 * Configurable via `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS`; `0` turns auto-disabling
 * off entirely (health is still tracked and surfaced over the API).
 */
export const DEFAULT_AUTO_DISABLE_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

/** A *terminal* delivery outcome, as reported to endpoint-health tracking. */
export type DeliveryHealthOutcome = "succeeded" | "failed";

/** The result of folding one delivery outcome into an endpoint's health. */
export interface EndpointHealthEvaluation {
  /**
   * The next endpoint snapshot. The **same reference** as the input `current` when
   * nothing changed, so a backend can cheaply skip the persist (`changed === false`).
   */
  readonly endpoint: Endpoint;
  /** Whether any field changed — i.e. whether a backend should persist. */
  readonly changed: boolean;
  /** Whether this evaluation flipped `disabled` from `false` to `true` (auto-disable). */
  readonly autoDisabled: boolean;
}

/**
 * Pure endpoint-health state machine: fold one *terminal* delivery outcome into an
 * endpoint's health and return the next snapshot.
 *
 * - A `succeeded` outcome clears any failure streak (the endpoint is demonstrably
 *   alive). It is a **no-op** when the endpoint was already healthy — so the steady
 *   state (success after success) writes nothing.
 * - A `failed` (dead-lettered) outcome opens or extends the streak. Once the streak
 *   has lasted at least `autoDisableAfterMs`, measured from {@link Endpoint.firstFailureAt},
 *   the endpoint is auto-disabled so fan-out stops sending it new work. A single
 *   isolated failure can never disable (its streak duration is `0`); *sustained*
 *   failure is required. `autoDisableAfterMs` of `0` disables auto-disabling entirely.
 *
 * A success never *re*-enables a disabled endpoint — recovery is a deliberate operator
 * action ({@link applyEndpointUpdate} with `disabled: false`, which also clears the
 * streak). Pure and shared so every backend agrees exactly; `updatedAt` advances to
 * `nowMs` only when something changed. Throws {@link TypeError} on non-finite inputs.
 */
export function evaluateEndpointHealth(
  current: Endpoint,
  outcome: DeliveryHealthOutcome,
  nowMs: number,
  autoDisableAfterMs: number = DEFAULT_AUTO_DISABLE_AFTER_MS,
): EndpointHealthEvaluation {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite number");
  }
  if (!Number.isFinite(autoDisableAfterMs) || autoDisableAfterMs < 0) {
    throw new TypeError("autoDisableAfterMs must be a non-negative finite number");
  }

  if (outcome === "succeeded") {
    const alreadyHealthy =
      current.consecutiveFailures === 0 &&
      current.firstFailureAt === null &&
      current.lastFailureAt === null;
    if (alreadyHealthy) {
      return { endpoint: current, changed: false, autoDisabled: false };
    }
    return {
      endpoint: {
        ...current,
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastFailureAt: null,
        updatedAt: nowMs,
      },
      changed: true,
      autoDisabled: false,
    };
  }

  // `failed`: open the streak (first failure) or extend it.
  const firstFailureAt = current.firstFailureAt ?? nowMs;
  const shouldDisable =
    autoDisableAfterMs > 0 &&
    !current.disabled &&
    nowMs - firstFailureAt >= autoDisableAfterMs;
  return {
    endpoint: {
      ...current,
      consecutiveFailures: current.consecutiveFailures + 1,
      firstFailureAt,
      lastFailureAt: nowMs,
      disabled: current.disabled || shouldDisable,
      updatedAt: nowMs,
    },
    changed: true,
    autoDisabled: shouldDisable,
  };
}
