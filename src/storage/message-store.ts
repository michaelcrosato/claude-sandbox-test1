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
import { normalizeChannel } from "../endpoints/endpoint.js";

/**
 * Valid message priority values. Higher priority messages are delivered before
 * lower priority ones when multiple tasks are due at the same time.
 */
export const VALID_PRIORITIES = ["high", "normal", "low"] as const;

/** The delivery priority of a message. */
export type MessagePriority = (typeof VALID_PRIORITIES)[number];

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
  /**
   * Channel tag for this message. `null` = untagged; only global (null-channel)
   * endpoints receive it. A string scopes delivery to matching-channel endpoints
   * plus all global endpoints.
   */
  readonly channel: string | null;
  /**
   * Epoch-ms before which no delivery attempt is made, or `null` for immediate
   * delivery. Stored from the producer's `sendAt` field (ISO 8601 on the wire;
   * epoch-ms here). Applied uniformly to every task in the fan-out — including
   * the outbox recovery path — so the scheduled time survives a crash between
   * message accept and fan-out.
   */
  readonly deliverAt: number | null;
  /**
   * Epoch-ms after which the message must not be delivered, or `null` for no
   * expiry. When the delivery worker picks up a task and finds
   * `now > expiresAt`, it dead-letters the delivery immediately (no retries)
   * with an "expired" error rather than attempting an already-stale send.
   * Stored from the producer's `expiresAt` field (ISO 8601 on the wire;
   * epoch-ms here). Applies to every task in the fan-out so the expiry
   * survives crashes just like `deliverAt`.
   */
  readonly expiresAt: number | null;
  /**
   * Delivery priority. Higher-priority messages are claimed from the queue
   * before lower-priority ones when multiple tasks are due simultaneously.
   * Defaults to `"normal"` when not specified.
   */
  readonly priority: MessagePriority;
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
  /**
   * Optional channel tag. `null` (or absent) = untagged. A string scopes
   * delivery to matching-channel and global endpoints only.
   */
  readonly channel?: string | null;
  /**
   * Epoch-ms before which no delivery attempt is made. Omit or pass `null` for
   * immediate delivery. Past timestamps are treated as immediate. Stored on the
   * message so the fan-out dispatcher honours it even after a crash.
   */
  readonly deliverAt?: number | null;
  /**
   * Epoch-ms after which the message must not be delivered. Omit or pass `null`
   * for no expiry. Stored on the message so expiry survives crashes just like
   * `deliverAt`. Must be a non-negative integer when provided.
   */
  readonly expiresAt?: number | null;
  /**
   * Delivery priority. Higher-priority messages are delivered before lower-priority
   * ones when multiple tasks are due at the same time. Defaults to `"normal"`.
   */
  readonly priority?: MessagePriority;
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
  /**
   * `true` when the message still owes a fan-out (its durable outbox marker is
   * set). It is always `true` for a freshly created message, and `true` for a
   * *deduplicated* replay whose original create was accepted but had **not** yet
   * recorded its fan-out as done — i.e. a crash struck between accept and
   * fan-out. It is `false` once the message has been {@link MessageStore.markFannedOut}.
   *
   * {@link import("../fanout/fanout.js").ingest} uses this to drive fan-out
   * exactly when it is owed: a normal create fans out and clears the marker; a
   * deduplicated retry of an *orphaned* create re-drives the fan-out the crash
   * skipped, instead of silently dropping it. This is the read side of the
   * transactional outbox — the marker is written in the same transaction that
   * accepts the message, so "accepted" and "needs fan-out" can never disagree.
   */
  readonly fanoutPending: boolean;
}

/** Default page size for {@link MessageStore.listPendingFanout}. */
export const DEFAULT_PENDING_FANOUT_LIMIT = 100;

/** Filters for {@link MessageStore.listPendingFanout}. */
export interface ListPendingFanoutOptions {
  /**
   * Maximum number of messages to return. Defaults to
   * {@link DEFAULT_PENDING_FANOUT_LIMIT}. Must be a positive integer.
   */
  readonly limit?: number;
  /**
   * When set, only return messages created at or before this epoch-ms cutoff. A
   * fan-out dispatcher passes `now - graceMs` so it never races a *healthy*
   * in-flight ingest whose own inline fan-out is about to clear the marker — it
   * recovers only genuine orphans older than the grace period. Omit to return
   * all pending messages regardless of age.
   */
  readonly createdAtOrBefore?: number;
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
  /**
   * Mark a message's fan-out as done, clearing its outbox marker so it is no
   * longer reported by {@link listPendingFanout} and a later deduplicated retry
   * sees `fanoutPending: false`. Called immediately after a message's fan-out
   * has been enqueued. Idempotent: a no-op for an unknown id or one whose marker
   * is already cleared.
   */
  markFannedOut(id: string): Promise<void>;
  /**
   * List messages that still owe a fan-out (outbox marker set), **oldest-first**,
   * for a fan-out dispatcher to drain. This is the durable record that closes the
   * accept→fan-out crash window: because the marker is written in the same
   * transaction that accepts the message, a crash before fan-out completes leaves
   * the message here to be recovered, rather than silently undelivered.
   */
  listPendingFanout(options?: ListPendingFanoutOptions): Promise<Message[]>;
  /**
   * List a tenant's messages, **newest-first** (by `createdAt`, then `id` as a
   * stable tiebreak), one page at a time. This is the read side of the producer's
   * "what have I sent?" question — the collection view that complements the
   * single-message {@link get} read.
   *
   * Keyset-paginated, not offset-paginated: pass the previous page's
   * {@link MessagePage.nextCursor} back as {@link ListMessagesOptions.cursor} to
   * fetch the next page, which is `null` once the last page is reached. Keyset
   * paging is stable under concurrent inserts — a message accepted mid-pagination
   * appears on page one and never shifts rows out from under an in-flight scan, the
   * classic offset-pagination bug — and stays an indexed lookup as the (unbounded)
   * message log grows.
   *
   * Scoped to `appId`: never returns, or reveals the existence of, another
   * tenant's messages.
   */
  listByApp(appId: string, options?: ListMessagesOptions): Promise<MessagePage>;
  /**
   * Delete messages that are older than `olderThanMs` (epoch ms) and have already
   * been fanned out (outbox marker cleared), plus their idempotency-key bindings.
   * Messages with a pending fan-out are never deleted. Returns the count of messages
   * deleted. Called by the data pruner when `POSTHORN_RETENTION_DAYS` is set; safe to
   * call on a live gateway (WAL mode in the SQLite backend makes it non-blocking).
   */
  pruneMessages(olderThanMs: number): Promise<number>;
  /**
   * Summarize a tenant's message volume over the half-open epoch-ms range
   * `[range.fromMs, range.toMs)`, broken down by **UTC calendar day** — the data a
   * hosted control plane meters and bills usage on (this market prices per message;
   * see docs/PROJECT.md). Each accepted message counts once; a deduplicated retry
   * adds no new message, so it is never double-counted.
   *
   * It is computed from the messages table — the source of truth — so the count is
   * always exact (there is no separate rollup to fall out of sync), and it rides the
   * same `(app_id, created_at)` index that backs {@link listByApp}, so it stays an
   * indexed range scan as the (unbounded) log grows. Scoped to `appId`: it never
   * counts, or reveals the existence of, another tenant's messages.
   */
  summarizeUsageByApp(appId: string, range: UsageRange): Promise<UsageSummary>;
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
  readonly channel: string | null;
  readonly deliverAt: number | null;
  readonly expiresAt: number | null;
  readonly priority: MessagePriority;
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
  const channel = normalizeChannel("channel" in input ? input.channel : undefined);
  const deliverAt = input.deliverAt ?? null;
  if (deliverAt !== null && (!Number.isInteger(deliverAt) || deliverAt < 0)) {
    throw new TypeError("deliverAt must be a non-negative integer");
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt < 0)) {
    throw new TypeError("expiresAt must be a non-negative integer");
  }
  const rawPriority = input.priority ?? "normal";
  if (!(VALID_PRIORITIES as readonly string[]).includes(rawPriority)) {
    throw new TypeError(`priority must be one of: ${VALID_PRIORITIES.join(", ")}`);
  }
  const priority = rawPriority as MessagePriority;
  return { appId, eventType, payload, idempotencyKey, channel, deliverAt, expiresAt, priority };
}

/**
 * Resolve {@link ListPendingFanoutOptions} into a concrete `(limit, cutoff)`
 * pair, shared by every backend so they page and filter identically. `limit`
 * defaults to {@link DEFAULT_PENDING_FANOUT_LIMIT} and must be a positive
 * integer; an absent `createdAtOrBefore` becomes `+Infinity` (no age cap).
 */
export function resolvePendingFanoutQuery(
  options: ListPendingFanoutOptions = {},
): { limit: number; createdAtOrBefore: number } {
  const limit = options.limit ?? DEFAULT_PENDING_FANOUT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  return {
    limit,
    createdAtOrBefore: options.createdAtOrBefore ?? Number.POSITIVE_INFINITY,
  };
}

/** Default page size for {@link MessageStore.listByApp}. */
export const DEFAULT_LIST_MESSAGES_LIMIT = 50;

/**
 * Largest page {@link MessageStore.listByApp} will return in one call. A caller
 * asking for more is a {@link RangeError}, so the server can never be coerced into
 * materializing an unbounded page.
 */
export const MAX_LIST_MESSAGES_LIMIT = 200;

/** Options for {@link MessageStore.listByApp}. */
export interface ListMessagesOptions {
  /**
   * Page size, an integer in `[1, {@link MAX_LIST_MESSAGES_LIMIT}]`. Defaults to
   * {@link DEFAULT_LIST_MESSAGES_LIMIT}.
   */
  readonly limit?: number;
  /**
   * Opaque cursor from a prior page's {@link MessagePage.nextCursor}. Omit (or
   * `null`) for the first page. A malformed cursor throws {@link TypeError}.
   */
  readonly cursor?: string | null;
  /**
   * When set, only messages whose `eventType` equals this value are returned.
   * `null` or omitting the field means no filter — all event types are included.
   */
  readonly eventType?: string | null;
  /**
   * When set, only messages whose `channel` equals this value are returned.
   * Pass `null` explicitly to return only untagged (null-channel) messages.
   * Omitting the field entirely means no channel filter — all channels are included.
   */
  readonly channel?: string | null;
  /**
   * Inclusive `createdAt` lower bound (epoch ms): only messages with
   * `createdAt >= after` are returned. `null` or omitted means no lower bound.
   * Together with {@link before} this is a half-open `[after, before)` window,
   * matching the `[from, to)` convention used elsewhere (usage ranges, replay).
   */
  readonly after?: number | null;
  /**
   * Exclusive `createdAt` upper bound (epoch ms): only messages with
   * `createdAt < before` are returned. `null` or omitted means no upper bound.
   */
  readonly before?: number | null;
}

/** One page of {@link MessageStore.listByApp}, newest-first, plus the next cursor. */
export interface MessagePage {
  /** This page's messages, newest-first. */
  readonly messages: Message[];
  /** Opaque cursor for the following page, or `null` when this is the last page. */
  readonly nextCursor: string | null;
}

/** A decoded keyset cursor — the `(createdAt, id)` of the last message on a page. */
export interface MessageCursor {
  readonly createdAt: number;
  readonly id: string;
}

/**
 * Encode a keyset cursor that points just *after* `message` in newest-first
 * order. Opaque, URL-safe (base64url), and paired with
 * {@link decodeMessageCursor}; clients should treat it as a black box.
 */
export function encodeMessageCursor(message: {
  readonly createdAt: number;
  readonly id: string;
}): string {
  return Buffer.from(`${message.createdAt}:${message.id}`, "utf8").toString(
    "base64url",
  );
}

/**
 * Decode a cursor produced by {@link encodeMessageCursor}, throwing
 * {@link TypeError} on any malformed token (so the HTTP layer renders a 400, not a
 * 500). The `createdAt` prefix is all digits and ids never contain a `:`, so the
 * first colon splits the two unambiguously.
 */
export function decodeMessageCursor(cursor: string): MessageCursor {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new TypeError("cursor must be a non-empty string");
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep <= 0) {
    throw new TypeError("malformed cursor");
  }
  const createdAt = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isInteger(createdAt) || createdAt < 0 || id.length === 0) {
    throw new TypeError("malformed cursor");
  }
  return { createdAt, id };
}

/**
 * Resolve {@link ListMessagesOptions} into a concrete `(limit, cursor, eventType)`,
 * shared by every backend so they page identically. `limit` defaults to
 * {@link DEFAULT_LIST_MESSAGES_LIMIT} and must be an integer in
 * `[1, {@link MAX_LIST_MESSAGES_LIMIT}]` (RangeError otherwise); a malformed
 * `cursor` throws TypeError via {@link decodeMessageCursor}.
 */
export function resolveListMessagesQuery(
  options: ListMessagesOptions = {},
): {
  limit: number;
  cursor: MessageCursor | null;
  eventType: string | null;
  channel: string | null | undefined;
  after: number | undefined;
  before: number | undefined;
} {
  const limit = options.limit ?? DEFAULT_LIST_MESSAGES_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_MESSAGES_LIMIT) {
    throw new RangeError(
      `limit must be an integer in [1, ${MAX_LIST_MESSAGES_LIMIT}]`,
    );
  }
  const cursor =
    options.cursor === undefined || options.cursor === null
      ? null
      : decodeMessageCursor(options.cursor);
  const eventType =
    options.eventType === undefined || options.eventType === null || options.eventType === ""
      ? null
      : options.eventType;
  // channel: undefined means "no filter"; null means "only null-channel messages"; string = exact match
  const channel = "channel" in options ? options.channel ?? null : undefined;
  // after/before: undefined means "no bound". A present value must be a non-negative
  // integer epoch-ms; the half-open window is [after, before).
  const after = resolveCreatedAtBound(options.after, "after");
  const before = resolveCreatedAtBound(options.before, "before");
  return { limit, cursor, eventType, channel, after, before };
}

/**
 * Normalize a `createdAt` range bound: `null`/omitted → `undefined` (no bound);
 * otherwise it must be a non-negative integer epoch-ms, or this throws
 * {@link RangeError} (mirroring the `limit` contract).
 */
function resolveCreatedAtBound(
  value: number | null | undefined,
  name: "after" | "before",
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer (epoch ms)`);
  }
  return value;
}

/**
 * Order two messages **newest-first**: `createdAt` descending, then `id`
 * descending as a stable tiebreak. The single textual definition of the
 * {@link MessageStore.listByApp} ordering — the SQLite backend mirrors it as
 * `ORDER BY created_at DESC, id DESC` and the in-memory backend sorts by this
 * comparator, so the two cannot drift. (Ids are ASCII, so JS string order matches
 * SQLite's default BINARY collation.)
 */
export function compareMessagesNewestFirst(
  a: { readonly createdAt: number; readonly id: string },
  b: { readonly createdAt: number; readonly id: string },
): number {
  if (a.createdAt !== b.createdAt) {
    return b.createdAt - a.createdAt;
  }
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/**
 * Whether `message` falls strictly *after* `cursor` in newest-first order — i.e.
 * belongs on a later page. Mirrors the SQLite keyset predicate
 * `created_at < ? OR (created_at = ? AND id < ?)`.
 */
export function isMessageAfterCursor(
  message: { readonly createdAt: number; readonly id: string },
  cursor: MessageCursor,
): boolean {
  return (
    message.createdAt < cursor.createdAt ||
    (message.createdAt === cursor.createdAt && message.id < cursor.id)
  );
}

/**
 * Largest span, in days, a single {@link MessageStore.summarizeUsageByApp} query
 * may cover. The HTTP layer enforces it so an admin cannot request an unbounded
 * daily breakdown (and the response stays bounded); a little over a year, enough
 * to cover any billing period.
 */
export const MAX_USAGE_RANGE_DAYS = 366;

/** A half-open epoch-ms range `[fromMs, toMs)` for a usage query. */
export interface UsageRange {
  /** Inclusive lower bound (epoch ms). */
  readonly fromMs: number;
  /** Exclusive upper bound (epoch ms). */
  readonly toMs: number;
}

/** One UTC calendar day's message count for a tenant. */
export interface UsageDay {
  /** The UTC day, ISO `YYYY-MM-DD`. */
  readonly date: string;
  /** Messages the tenant had accepted on this day (within the queried range). */
  readonly messages: number;
}

/** A tenant's message usage over a range — the metering/billing read model. */
export interface UsageSummary {
  /** The tenant the summary is for. */
  readonly appId: string;
  /** The query's inclusive lower bound (epoch ms), echoed back. */
  readonly fromMs: number;
  /** The query's exclusive upper bound (epoch ms), echoed back. */
  readonly toMs: number;
  /** Total messages across the whole range (the billable count). */
  readonly total: number;
  /** Per-UTC-day breakdown, oldest day first; only days with at least one message. */
  readonly daily: readonly UsageDay[];
}

/**
 * The UTC calendar day (`YYYY-MM-DD`) containing an epoch-ms instant. The single
 * shared day-bucketing rule for usage: the in-memory backend groups by it, and the
 * SQLite backend mirrors it as `date(created_at / 1000, 'unixepoch')` — the two are
 * held equal by the conformance suite, so they cannot drift. (Both floor to the same
 * UTC day: `floor(floor(ms / 1000) / 86400) === floor(ms / 86400000)`.)
 */
export function utcDayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * The half-open epoch-ms range `[firstOfMonth, firstOfNextMonth)` of the **UTC
 * calendar month** containing `nowMs` — the window a monthly message quota is
 * enforced over. Pure: derived entirely from the clock, so the quota "resets" at the
 * UTC month boundary with no scheduled job (the range simply moves). `Date.UTC` rolls
 * December over to the next January correctly. Pair with
 * {@link MessageStore.summarizeUsageByApp} to count a tenant's messages this month and
 * {@link import("../apps/app.js").isQuotaExceeded} to decide whether the next is admitted.
 */
export function utcMonthRange(nowMs: number): UsageRange {
  const d = new Date(nowMs);
  return {
    fromMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    toMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/**
 * Validate a usage range, shared by every backend so they reject identically.
 * Bounds must be finite with `fromMs <= toMs` (an empty range is allowed and yields
 * a zero summary). Throws {@link RangeError} otherwise — a library-facing backstop;
 * the HTTP layer validates the calendar dates and span before the store is reached.
 */
export function resolveUsageRange(range: UsageRange): {
  fromMs: number;
  toMs: number;
} {
  const { fromMs, toMs } = range;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new RangeError("usage range bounds must be finite numbers");
  }
  if (fromMs > toMs) {
    throw new RangeError("usage range fromMs must be <= toMs");
  }
  return { fromMs, toMs };
}
