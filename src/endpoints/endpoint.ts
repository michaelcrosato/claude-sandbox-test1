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
  /** The signing secret (`whsec_…`), per Standard Webhooks. */
  readonly secret: string;
  /** Human-readable label. Empty string when none was given. */
  readonly description: string;
  /**
   * The event types this endpoint is subscribed to. `null` means *all* events;
   * a (possibly empty) array means *exactly* those types. See
   * {@link endpointSubscribesTo}.
   */
  readonly eventTypes: readonly string[] | null;
  /**
   * When `true`, the endpoint is administratively paused. Fan-out skips it, and a
   * resolver declines to resolve it (so an in-flight task fails rather than
   * delivers — see `endpoint-resolver.ts`).
   */
  readonly disabled: boolean;
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
  /** Delete an endpoint. Returns `true` if it existed, `false` otherwise. */
  delete(id: string): Promise<boolean>;
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
  return {
    id: current.id,
    appId: current.appId,
    url: "url" in patch ? normalizeUrl(patch.url) : current.url,
    secret: "secret" in patch ? normalizeSecret(patch.secret) : current.secret,
    description:
      "description" in patch
        ? normalizeDescription(patch.description)
        : current.description,
    eventTypes:
      "eventTypes" in patch
        ? normalizeEventTypes(patch.eventTypes)
        : current.eventTypes,
    disabled:
      "disabled" in patch ? normalizeDisabled(patch.disabled) : current.disabled,
    createdAt: current.createdAt,
    updatedAt: nowMs,
  };
}
