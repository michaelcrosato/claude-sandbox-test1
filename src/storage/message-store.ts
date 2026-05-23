/**
 * The message store: how Posthorn persists the events it is asked to deliver.
 *
 * This module defines the *seam* between Posthorn's deterministic core and
 * whatever backs it durably (an in-memory map today; SQLite/Postgres next —
 * see docs/PROJECT.md). Every backend implements the same {@link MessageStore}
 * contract, so the rest of the system never depends on the storage engine.
 *
 * It also owns **idempotent intake**: producers routinely retry a create call
 * after a network blip, and Posthorn must not fan a duplicate event out to a
 * customer's endpoints. A caller-supplied idempotency key collapses those
 * retries onto the single message that was first accepted for the key.
 */

import { createHash, randomBytes } from "node:crypto";

/** A message accepted for delivery. Immutable once created. */
export interface Message {
  /** Server-assigned unique id (e.g. `msg_…`). */
  readonly id: string;
  /**
   * The tenant (application) this message belongs to. Opaque scope string —
   * the entity that mints/validates it is a later tick. Fan-out delivers a
   * message only to endpoints in this same `appId`.
   */
  readonly appId: string;
  /**
   * The idempotency key the producer supplied, or `null` if none was given.
   * Recorded for traceability; dedup itself is handled by the store.
   */
  readonly idempotencyKey: string | null;
  /** The event type / topic, e.g. `"user.created"`. */
  readonly eventType: string;
  /** The exact serialized body to be signed and delivered, byte-for-byte. */
  readonly payload: string;
  /** Creation time, epoch ms. */
  readonly createdAt: number;
}

/** The fields a caller provides to create a message. */
export interface NewMessage {
  /** The owning tenant (application). Must be a non-empty string. */
  readonly appId: string;
  /**
   * Optional idempotency key. When present, a repeat create with the same key
   * *within the same app* (and inside the store's idempotency window) returns
   * the original message instead of creating a new one. Must be a non-empty
   * string when provided.
   */
  readonly idempotencyKey?: string | null;
  /** The event type / topic. Must be a non-empty string. */
  readonly eventType: string;
  /** The exact serialized body to deliver. */
  readonly payload: string;
}

/** The outcome of {@link MessageStore.create}. */
export interface CreateMessageResult {
  /** The stored message — freshly created, or the one a prior call created. */
  readonly message: Message;
  /**
   * `true` when an existing message was returned because its idempotency key
   * had already been seen; `false` when a new message was created.
   */
  readonly deduplicated: boolean;
}

/**
 * Durable storage for messages, plus idempotent intake.
 *
 * The interface is asynchronous so that a single contract spans both
 * synchronous engines (in-memory, better-sqlite3) and asynchronous ones
 * (Postgres, networked stores); synchronous backends simply resolve eagerly.
 */
export interface MessageStore {
  /**
   * Accept a message for delivery.
   *
   * If {@link NewMessage.idempotencyKey} is set and a non-expired message
   * already exists for that key *in the same app*, the original is returned
   * with `deduplicated: true` — *provided the request matches*. A reused key
   * paired with a different `eventType`/`payload` is a programming error and
   * throws {@link IdempotencyConflictError}. Idempotency keys are scoped per
   * tenant, so the same key in two apps never collides.
   */
  create(input: NewMessage): Promise<CreateMessageResult>;
  /** Fetch a message by its id, or `null` if unknown. */
  get(id: string): Promise<Message | null>;
  /**
   * Fetch the message associated with an idempotency key *within an app*, or
   * `null` if that app has no live binding for the key (unknown or its window
   * has elapsed). Scoped by `appId` so one tenant's key never resolves — or
   * leaks — another tenant's message.
   */
  getByIdempotencyKey(appId: string, key: string): Promise<Message | null>;
}

/**
 * Thrown when an idempotency key is reused for a request that differs from the
 * one it was first stored against. Surfacing this (rather than silently
 * returning the stale message) catches a real client bug: the same key must
 * always describe the same request.
 */
export class IdempotencyConflictError extends Error {
  /** The conflicting idempotency key. */
  readonly key: string;
  constructor(key: string) {
    super(
      `idempotency key "${key}" was already used for a different request`,
    );
    this.name = "IdempotencyConflictError";
    this.key = key;
  }
}

/**
 * Compute a stable fingerprint of a message's identifying content.
 *
 * Pure and deterministic. Each field is length-prefixed before hashing so that
 * no pair of distinct `(eventType, payload)` inputs can collide by shifting the
 * boundary between them (e.g. `("ab","c")` vs `("a","bc")`).
 */
export function messageFingerprint(eventType: string, payload: string): string {
  return createHash("sha256")
    .update(`${Buffer.byteLength(eventType, "utf8")}:`, "utf8")
    .update(eventType, "utf8")
    .update(`:${Buffer.byteLength(payload, "utf8")}:`, "utf8")
    .update(payload, "utf8")
    .digest("hex");
}

/** Prefix on generated message ids. */
const MESSAGE_ID_PREFIX = "msg_";

/**
 * The default message-id generator: a `msg_`-prefixed, URL-safe token with 144
 * bits of CSPRNG entropy. Inject a deterministic generator in tests.
 */
export function createMessageId(): string {
  return MESSAGE_ID_PREFIX + randomBytes(18).toString("base64url");
}

/** Default idempotency window: 24 hours, matching common provider behaviour. */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Validate an idempotency window at store construction. Shared by every backend
 * so they reject the same inputs identically. Must be `> 0`;
 * `Number.POSITIVE_INFINITY` is permitted and means "never expire".
 */
export function assertValidIdempotencyWindow(windowMs: number): void {
  if (!(windowMs > 0)) {
    throw new RangeError(
      "idempotencyWindowMs must be a positive number (or Infinity)",
    );
  }
}

/**
 * The single, shared rule for whether an idempotency binding has aged out:
 * `true` once `windowMs` has fully elapsed since `storedAt`. The `>=` makes the
 * window half-open `[storedAt, storedAt + windowMs)`, and an infinite window
 * never expires (`anything >= Infinity` is `false`). Every backend defers to
 * this so dedup semantics cannot drift between engines.
 */
export function isIdempotencyExpired(
  storedAt: number,
  nowMs: number,
  windowMs: number,
): boolean {
  return nowMs - storedAt >= windowMs;
}

/** A {@link NewMessage} whose fields have been validated and normalized. */
export interface NormalizedNewMessage {
  readonly appId: string;
  readonly eventType: string;
  readonly payload: string;
  readonly idempotencyKey: string | null;
}

/**
 * Validate and normalize the caller-supplied fields of a create call, throwing
 * {@link TypeError} on malformed input. Shared by every backend so they enforce
 * the same intake contract; the `idempotencyKey` is collapsed to `null` when
 * absent.
 */
export function normalizeNewMessage(input: NewMessage): NormalizedNewMessage {
  const { appId, eventType, payload } = input;
  if (typeof appId !== "string" || appId.length === 0) {
    throw new TypeError("appId must be a non-empty string");
  }
  if (typeof eventType !== "string" || eventType.length === 0) {
    throw new TypeError("eventType must be a non-empty string");
  }
  if (typeof payload !== "string") {
    throw new TypeError("payload must be a string");
  }
  const idempotencyKey = input.idempotencyKey ?? null;
  if (
    idempotencyKey !== null &&
    (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)
  ) {
    throw new TypeError(
      "idempotencyKey must be a non-empty string when provided",
    );
  }
  return { appId, eventType, payload, idempotencyKey };
}
