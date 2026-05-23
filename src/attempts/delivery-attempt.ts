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
import type { UsageRange } from "../storage/message-store.js";

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
  /**
   * The tenant (application) this attempt was made on behalf of, mirrored from the
   * delivered message. Denormalized onto the attempt — exactly like `messageId` and
   * `endpointId` — so per-tenant **delivery usage** ({@link DeliveryAttemptStore.summarizeAttemptsByApp})
   * is a single indexed range scan rather than a join through the message table. It
   * is `null` only when the message could not be loaded at delivery time (a vanished
   * message); such an attempt belongs to no tenant and is excluded from every
   * per-tenant summary.
   */
  readonly appId: string | null;
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
  /**
   * The tenant the delivered message belongs to. Defaults to `null` when omitted —
   * the worker passes the loaded message's `appId`, or `null` if the message had
   * vanished. A `null`-tenant attempt is excluded from per-tenant usage.
   */
  readonly appId?: string | null;
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
  /**
   * Summarize a tenant's **delivery-attempt usage** over the half-open epoch-ms range
   * `[range.fromMs, range.toMs)`, broken down by **UTC calendar day** — the *operations*
   * read model a hosted control plane bills on, the companion to
   * {@link import("../storage/message-store.js").MessageStore.summarizeUsageByApp}
   * (accepted messages). Where messages count what a tenant *sent*, this counts what
   * Posthorn actually *did* — every HTTP delivery attempt, retries included — which is
   * the real resource/cost unit incumbents meter ("operations").
   *
   * Each recorded attempt counts once; the per-day and grand totals split into
   * `succeeded` / `failed` so a dashboard shows both volume and delivery health.
   * Scoped to `appId` via the denormalized {@link DeliveryAttempt.appId}: attempts with
   * a `null` tenant (a vanished message) belong to no app and are never counted.
   * Computed straight from the append-only attempts log — the source of truth, so the
   * count is always exact with no separate rollup to drift — riding a `(app_id,
   * attempted_at)` index so it stays a bounded range scan as the log grows. Shares the
   * message store's {@link UsageRange} and UTC-day bucketing, so the two usage views
   * line up day-for-day and cannot drift.
   */
  summarizeAttemptsByApp(
    appId: string,
    range: UsageRange,
  ): Promise<AttemptUsageSummary>;
}

/** One UTC calendar day's delivery-attempt counts for a tenant. */
export interface AttemptUsageDay {
  /** The UTC day, ISO `YYYY-MM-DD`. */
  readonly date: string;
  /** Total delivery attempts made for the tenant on this day (within the range). */
  readonly attempts: number;
  /** Of those, attempts that reached the receiver with a 2xx. */
  readonly succeeded: number;
  /** Of those, attempts that failed (non-2xx, transport, or pre-flight). */
  readonly failed: number;
}

/**
 * A tenant's delivery-attempt usage over a range — the *operations* metering/billing
 * read model (the delivery-side companion to the message-side
 * {@link import("../storage/message-store.js").UsageSummary}).
 */
export interface AttemptUsageSummary {
  /** The tenant the summary is for. */
  readonly appId: string;
  /** The query's inclusive lower bound (epoch ms), echoed back. */
  readonly fromMs: number;
  /** The query's exclusive upper bound (epoch ms), echoed back. */
  readonly toMs: number;
  /** Total attempts across the whole range (the billable operations count). */
  readonly total: number;
  /** Of `total`, attempts that succeeded. */
  readonly succeeded: number;
  /** Of `total`, attempts that failed. */
  readonly failed: number;
  /** Per-UTC-day breakdown, oldest day first; only days with at least one attempt. */
  readonly daily: readonly AttemptUsageDay[];
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
  readonly appId: string | null;
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
  const appId = input.appId ?? null;
  if (appId !== null && (typeof appId !== "string" || appId.length === 0)) {
    throw new TypeError("appId must be a non-empty string when provided");
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
    appId,
    endpointId,
    attemptNumber: input.attemptNumber,
    outcome: input.outcome,
    responseStatus,
    error,
    durationMs: input.durationMs,
    attemptedAt: input.attemptedAt,
  };
}
