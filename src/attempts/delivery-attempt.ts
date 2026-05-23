/**
 * The per-attempt delivery audit log — one immutable record per HTTP delivery
 * attempt, the depth behind Posthorn's "observable" promise.
 *
 * The {@link DeliveryQueue} already persists the *latest* state of each
 * (message, endpoint) delivery — its status, attempt count, and `lastError`. That
 * answers "where does this delivery stand right now?" but throws away the history:
 * it cannot tell an operator that attempt 3 got an HTTP 503 after 1.2s while
 * attempt 4 timed out. That history — one row per attempt, with the response code,
 * the error, and the latency — is the single most-used view in every incumbent's
 * dashboard (Svix "message attempts", Convoy "delivery attempts") and the data a
 * developer actually debugs a flaky receiver from.
 *
 * This module is that append-only log. It is deliberately *separate* from the
 * queue: the queue holds the small, load-bearing delivery *state* that drives
 * scheduling; this holds the unbounded, write-once *audit trail* that only
 * observability reads. Keeping them apart means a busy delivery loop never bloats
 * the row the scheduler reads on every claim, and the audit table can be pruned or
 * tiered independently later without touching delivery correctness.
 *
 * Like {@link MessageStore} and {@link DeliveryQueue} it is a backend-agnostic
 * contract proven by one shared conformance suite, so the in-memory reference and
 * the durable SQLite backend are interchangeable. The {@link DeliveryWorker}
 * writes one record per attempt through an injected seam; the HTTP layer reads them
 * back per message at `GET /v1/messages/:id/attempts`.
 */

import { randomBytes } from "node:crypto";

/**
 * The outcome of a single attempt. Narrower than the delivery {@link DeliveryStatus}
 * on purpose: an *attempt* either reached the receiver with a 2xx (`succeeded`) or
 * it did not (`failed`). `dead_letter` is a property of the *task* once its attempts
 * are exhausted — not of any one attempt — so it has no place here.
 */
export type DeliveryAttemptOutcome = "succeeded" | "failed";

/**
 * One recorded delivery attempt. Immutable and append-only — an attempt is never
 * updated once written, so the log is a faithful, ordered history.
 */
export interface DeliveryAttempt {
  /** Server-assigned unique id (`datt_…`). */
  readonly id: string;
  /** The delivery task this attempt belongs to. */
  readonly taskId: string;
  /**
   * The message delivered. Denormalized onto the attempt so the per-message read
   * (`GET /v1/messages/:id/attempts`) is a single indexed scan rather than a join
   * through the task table.
   */
  readonly messageId: string;
  /** The destination endpoint, mirrored from the task; `null` if the task had none. */
  readonly endpointId: string | null;
  /**
   * Which attempt this was for its task, 1-based — equal to the task's `attempts`
   * count at the moment the attempt ran. Attempt 1 is the first try, attempt 2 the
   * first retry, and so on.
   */
  readonly attemptNumber: number;
  /** Whether the attempt reached the receiver with a 2xx. */
  readonly outcome: DeliveryAttemptOutcome;
  /**
   * The HTTP status the receiver returned, or `null` when no response arrived at
   * all — a transport failure (DNS, refused, timeout) or a pre-flight failure (the
   * endpoint could not be resolved, the message vanished). On a `succeeded` attempt
   * this is always a 2xx.
   */
  readonly responseStatus: number | null;
  /** Failure detail when `outcome` is `failed`; `null` on success. */
  readonly error: string | null;
  /** Wall-clock duration of the attempt, in ms (0 for a pre-flight failure with no send). */
  readonly durationMs: number;
  /** When the attempt started, epoch ms. */
  readonly attemptedAt: number;
}

/**
 * The fields a caller (the {@link DeliveryWorker}) provides to record an attempt.
 * The store assigns the `id`. `endpointId`/`responseStatus`/`error` default to
 * `null` when omitted.
 */
export interface NewDeliveryAttempt {
  readonly taskId: string;
  readonly messageId: string;
  readonly endpointId?: string | null;
  readonly attemptNumber: number;
  readonly outcome: DeliveryAttemptOutcome;
  readonly responseStatus?: number | null;
  readonly error?: string | null;
  readonly durationMs: number;
  readonly attemptedAt: number;
}

/**
 * An append-only store of {@link DeliveryAttempt}s.
 *
 * Asynchronous so one contract spans synchronous engines (in-memory, SQLite via
 * `node:sqlite`) and asynchronous ones (a future Postgres) alike; sync backends
 * resolve eagerly.
 */
export interface DeliveryAttemptStore {
  /** Append one attempt, returning the stored record with its assigned id. */
  record(input: NewDeliveryAttempt): Promise<DeliveryAttempt>;
  /**
   * List every attempt for `messageId`, oldest-first (the order they were
   * recorded, which is chronological). Returns an empty array when the message has
   * no recorded attempts or the id is unknown/empty — a pure read that never throws
   * on an absent message. This is the data primitive behind
   * `GET /v1/messages/:id/attempts`.
   */
  listByMessage(messageId: string): Promise<readonly DeliveryAttempt[]>;
}

/** Prefix on generated attempt ids. */
const ATTEMPT_ID_PREFIX = "datt_";

/**
 * Default attempt-id generator: a `datt_`-prefixed URL-safe token with 144 bits of
 * CSPRNG entropy (the same shape as task/message ids). Inject a deterministic
 * generator in tests.
 */
export function createAttemptId(): string {
  return ATTEMPT_ID_PREFIX + randomBytes(18).toString("base64url");
}

/** A validated/normalized {@link NewDeliveryAttempt}, ready to persist. */
export interface NormalizedNewAttempt {
  readonly taskId: string;
  readonly messageId: string;
  readonly endpointId: string | null;
  readonly attemptNumber: number;
  readonly outcome: DeliveryAttemptOutcome;
  readonly responseStatus: number | null;
  readonly error: string | null;
  readonly durationMs: number;
  readonly attemptedAt: number;
}

/**
 * Validate and normalize a {@link NewDeliveryAttempt}, throwing {@link TypeError}
 * on malformed input. Shared by every backend so they enforce an identical intake
 * contract (the same discipline as `normalizeEnqueueInput`/`normalizeNewMessage`).
 */
export function normalizeNewAttempt(input: NewDeliveryAttempt): NormalizedNewAttempt {
  const { taskId, messageId } = input;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new TypeError("taskId must be a non-empty string");
  }
  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new TypeError("messageId must be a non-empty string");
  }
  const endpointId = input.endpointId ?? null;
  if (
    endpointId !== null &&
    (typeof endpointId !== "string" || endpointId.length === 0)
  ) {
    throw new TypeError("endpointId must be a non-empty string when provided");
  }
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new TypeError("attemptNumber must be a positive integer");
  }
  if (input.outcome !== "succeeded" && input.outcome !== "failed") {
    throw new TypeError('outcome must be "succeeded" or "failed"');
  }
  const responseStatus = input.responseStatus ?? null;
  if (responseStatus !== null && !Number.isInteger(responseStatus)) {
    throw new TypeError("responseStatus must be an integer or null");
  }
  const error = input.error ?? null;
  if (error !== null && typeof error !== "string") {
    throw new TypeError("error must be a string or null");
  }
  if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
    throw new TypeError("durationMs must be a non-negative integer");
  }
  if (!Number.isFinite(input.attemptedAt)) {
    throw new TypeError("attemptedAt must be a finite epoch-ms timestamp");
  }
  return {
    taskId,
    messageId,
    endpointId,
    attemptNumber: input.attemptNumber,
    outcome: input.outcome,
    responseStatus,
    error,
    durationMs: input.durationMs,
    attemptedAt: input.attemptedAt,
  };
}
