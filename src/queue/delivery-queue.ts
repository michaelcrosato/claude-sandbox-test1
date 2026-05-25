/**
 * The durable delivery queue — Posthorn's reliable-delivery spine.
 *
 * P0–P2 built the *decisions* (sign, when-to-retry, the delivery state machine)
 * and *intake* (the message store) as separate, pure islands. This module is the
 * seam that joins them into actual reliable delivery: a durable work queue that
 * hands due deliveries to a worker, leases each one so a single attempt is in
 * flight at a time, and — crucially for the "single process, no Redis, crash-safe"
 * wedge — *replays in-flight work after a crash* without any external broker.
 *
 * Like {@link MessageStore} it is a backend-agnostic contract: a backend persists
 * tasks however it likes, but every backend behaves identically because the
 * *transition logic* is shared and pure (see {@link applyClaim} /
 * {@link applySuccess} / {@link applyFailure}, all of which defer to the proven
 * delivery-state reducer). A single conformance suite proves the equivalence.
 *
 * ## Lease model (at-least-once)
 *
 * `claimDue` atomically moves a due task to `delivering`, stamps it with a fresh
 * **lease token**, and sets a **visibility timeout** (`leaseExpiresAt`). Only the
 * holder of that token may `complete`/`fail` the task. If the worker crashes or
 * stalls past the timeout, the lease lapses and the task becomes claimable again
 * — its in-flight work is never lost. This is at-least-once delivery: a stalled
 * worker whose lease lapsed may double-deliver, which is exactly why every
 * message carries a stable id for the receiver to dedup on (Standard Webhooks).
 */

import { randomBytes } from "node:crypto";
import {
  DeliveryStateError,
  reduce,
  type DeliveryState,
  type DeliveryStatus,
} from "../delivery/delivery-state.js";
import {
  DEFAULT_RETRY_POLICY,
  type JitterOptions,
  type RetryPolicy,
} from "../delivery/retry-policy.js";
import {
  isDeliveryFailureReason,
  type DeliveryFailureReason,
} from "../delivery/failure-reason.js";

/**
 * A unit of delivery work: "attempt to deliver message `messageId`." Immutable;
 * every transition produces a new snapshot. `messageId` is an opaque reference
 * (the queue never loads the message itself — the worker does), so the same
 * queue can later carry richer units (e.g. message×endpoint) unchanged.
 */
export interface DeliveryTask {
  /** Server-assigned unique task id (e.g. `dtask_…`). */
  readonly id: string;
  /** The message this task delivers. Opaque to the queue. */
  readonly messageId: string;
  /**
   * The endpoint this task delivers to, or `null` if unspecified. Opaque to the
   * queue (it is carried, never interpreted); a worker's `EndpointResolver`
   * uses it to look up the destination URL + signing secret. The fan-out step
   * sets it, creating one task per (message, endpoint) pair.
   */
  readonly endpointId: string | null;
  /**
   * The tenant (app) this delivery belongs to, or `null` for tasks enqueued
   * before per-app tracking was added (pre-migration rows). Denormalized from
   * the message at enqueue time — the same pattern as {@link DeliveryAttempt.appId}
   * — so per-tenant listing is a single indexed scan rather than a join.
   */
  readonly appId: string | null;
  /** Current delivery status (shared vocabulary with the delivery FSM). */
  readonly status: DeliveryStatus;
  /** Count of attempts started so far (incremented on each claim). */
  readonly attempts: number;
  /**
   * While `pending`, the epoch-ms at which the task next becomes claimable;
   * `null` means "claimable immediately". Always `null` when not `pending`.
   */
  readonly nextAttemptAt: number | null;
  /**
   * While `delivering`, the epoch-ms at which the lease lapses and the task may
   * be reclaimed (crash/stall recovery). `null` when not `delivering`.
   */
  readonly leaseExpiresAt: number | null;
  /**
   * While `delivering`, the token a worker must present to `complete`/`fail`
   * this task. `null` when not `delivering`. A new token is minted per claim,
   * so a reclaim invalidates the previous holder's token.
   */
  readonly leaseToken: string | null;
  /** Detail of the most recent failure, if any. */
  readonly lastError: string | null;
  /**
   * The structured, machine-readable cause of the most recent failure — one stable
   * {@link DeliveryFailureReason} code (the queryable companion to the free-text
   * `lastError`). Denormalized from the failing attempt onto the task at `fail` time
   * so a per-tenant delivery listing can group/filter by *why* without joining the
   * attempt log. `null` on a task that has never failed, and cleared on a manual
   * retry (a fresh slate), exactly mirroring `lastError`'s lifecycle.
   */
  readonly failureReason: DeliveryFailureReason | null;
  /**
   * Delivery priority: `1` = high, `0` = normal, `-1` = low. Higher values are
   * claimed first by `claimDue` when multiple tasks are due simultaneously. Set
   * from the message's `priority` field at fan-out time. Defaults to `0`.
   */
  readonly priority: number;
  /** Enqueue time, epoch ms. */
  readonly createdAt: number;
  /** Time of the last state change, epoch ms. */
  readonly updatedAt: number;
}

/** Fields a caller provides to enqueue a delivery. */
export interface EnqueueInput {
  /** The message to deliver. Must be a non-empty string. */
  readonly messageId: string;
  /**
   * The endpoint this delivery targets. Opaque to the queue; the worker resolves
   * it to a URL + signing secret. Omit (or pass `null`) when no endpoint applies.
   * Must be a non-empty string when provided.
   */
  readonly endpointId?: string | null;
  /**
   * The tenant (app) this delivery belongs to. Pass `message.appId` at fan-out
   * time so the task can be found via {@link DeliveryQueue.listByApp}. Omit (or
   * pass `null`) when the tenant is not known (e.g. legacy code paths without
   * per-app tracking). Must be a non-empty string when provided.
   */
  readonly appId?: string | null;
  /**
   * Epoch-ms before which the task is not claimable. Omit (or `null`) to make
   * it deliverable immediately. Useful for scheduled/delayed first delivery.
   */
  readonly availableAt?: number | null;
  /**
   * Numeric delivery priority: `1` = high, `0` = normal (default), `-1` = low.
   * Higher-priority tasks are claimed before lower-priority ones when multiple
   * tasks are due at the same time. Omit (or `0`) for normal priority.
   */
  readonly priority?: number;
}

/** Options for a {@link DeliveryQueue.claimDue} call. */
export interface ClaimOptions {
  /** Current time, epoch ms — the basis for due-ness and lease expiry. */
  readonly nowMs: number;
  /** Maximum tasks to claim in this batch. Defaults to {@link DEFAULT_CLAIM_LIMIT}. */
  readonly limit?: number;
}

/** Detail a worker reports when an attempt fails. */
export interface FailInput {
  /** Human-readable failure reason, recorded as `lastError`. */
  readonly error: string;
  /**
   * The structured classification of this failure, denormalized onto the task as
   * its {@link DeliveryTask.failureReason}. Omit (or `null`) when no classification
   * applies (e.g. an internal caller without a worker's signals); the prior reason
   * is then overwritten with `null`, keeping it in lock-step with `error`.
   */
  readonly failureReason?: DeliveryFailureReason | null;
  /** Time the failure occurred, epoch ms — the basis for the next retry. */
  readonly nowMs: number;
  /**
   * Minimum delay in ms before the next retry attempt, sourced from the
   * receiver's `Retry-After` response header. When provided, `nextAttemptAt`
   * is floored at `nowMs + minDelayMs` so Posthorn never retries sooner than
   * the receiver asked. Smaller than the policy-computed delay → policy wins.
   * Has no effect when the task dead-letters (budget exhausted — terminal).
   */
  readonly minDelayMs?: number;
  /**
   * Per-endpoint retry policy to use for this task, overriding the queue's
   * global policy. When absent, the queue's own policy applies. Supplied by
   * the delivery worker from the endpoint's stored {@link RetryPolicy}.
   */
  readonly retryPolicy?: RetryPolicy;
}

/**
 * A complete count of tasks by delivery status. Every {@link DeliveryStatus} key
 * is always present (zero when none), so a consumer (e.g. the metrics endpoint)
 * can render a full gauge family without a missing series.
 */
export type DeliveryCountsByStatus = Readonly<Record<DeliveryStatus, number>>;

/** Default page size for {@link DeliveryQueue.listByEndpoint}. */
export const DEFAULT_LIST_DELIVERIES_LIMIT = 50;

/**
 * Largest page {@link DeliveryQueue.listByEndpoint} will return in one call.
 * A caller asking for more is a {@link RangeError}.
 */
export const MAX_LIST_DELIVERIES_LIMIT = 200;

/** Base pagination options shared by all delivery-list methods. */
export interface ListDeliveriesOptions {
  /**
   * Page size, an integer in `[1, {@link MAX_LIST_DELIVERIES_LIMIT}]`. Defaults
   * to {@link DEFAULT_LIST_DELIVERIES_LIMIT}.
   */
  readonly limit?: number;
  /**
   * Opaque cursor from a prior page's {@link DeliveryPage.nextCursor}. Omit (or
   * `null`) for the first page. A malformed cursor throws {@link TypeError}.
   */
  readonly cursor?: string | null;
}

/**
 * Options for {@link DeliveryQueue.listByEndpoint} — extends the base pagination
 * options with an optional status filter, mirroring {@link ListByAppOptions}.
 */
export interface ListByEndpointOptions extends ListDeliveriesOptions {
  /**
   * When set, only return deliveries with this status. Omit (or `null`) to
   * return deliveries in all statuses (the default).
   */
  readonly status?: DeliveryStatus | null;
}

/**
 * Options for {@link DeliveryQueue.listByApp} — extends the base pagination
 * options with optional `status` and `failureReason` filters. The two filters
 * compose: supplying both narrows to deliveries that match the status *and* the
 * structured failure reason (e.g. `dead_letter` deliveries that failed with
 * `connection_refused`).
 */
export interface ListByAppOptions extends ListDeliveriesOptions {
  /**
   * When set, only return deliveries with this status. Omit (or `null`) to
   * return deliveries in all statuses (the default).
   */
  readonly status?: DeliveryStatus | null;
  /**
   * When set, only return deliveries whose latest {@link DeliveryTask.failureReason}
   * equals this code — the one-query failure-triage filter ("show me every
   * delivery that failed with `connection_refused`"). Omit (or `null`) to apply
   * no reason filter (the default). Tasks that have never failed carry a `null`
   * `failureReason` and are excluded whenever this filter is set.
   */
  readonly failureReason?: DeliveryFailureReason | null;
}

/** One page of {@link DeliveryQueue.listByEndpoint}, newest-first. */
export interface DeliveryPage {
  /** This page's delivery tasks, newest-first. */
  readonly deliveries: DeliveryTask[];
  /** Opaque cursor for the following page, or `null` when this is the last page. */
  readonly nextCursor: string | null;
}

/** A decoded keyset cursor — the `(createdAt, id)` of the last task on a page. */
export interface DeliveryCursor {
  readonly createdAt: number;
  readonly id: string;
}

/**
 * Encode a keyset cursor that points just *after* `task` in newest-first order.
 * Opaque, URL-safe (base64url). Mirrors the message cursor encoding.
 */
export function encodeDeliveryCursor(task: {
  readonly createdAt: number;
  readonly id: string;
}): string {
  return Buffer.from(`${task.createdAt}:${task.id}`, "utf8").toString("base64url");
}

/**
 * Decode a cursor produced by {@link encodeDeliveryCursor}, throwing
 * {@link TypeError} on any malformed token (so the HTTP layer renders a 400).
 */
export function decodeDeliveryCursor(cursor: string): DeliveryCursor {
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
 * Resolve {@link ListDeliveriesOptions} into a concrete `(limit, cursor)`. Shared
 * by every backend so they page identically. `limit` defaults to
 * {@link DEFAULT_LIST_DELIVERIES_LIMIT} and must be a positive integer in
 * `[1, {@link MAX_LIST_DELIVERIES_LIMIT}]`.
 */
export function resolveListDeliveriesQuery(options: ListDeliveriesOptions = {}): {
  limit: number;
  cursor: DeliveryCursor | null;
} {
  const limit = options.limit ?? DEFAULT_LIST_DELIVERIES_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_DELIVERIES_LIMIT) {
    throw new RangeError(
      `limit must be an integer in [1, ${MAX_LIST_DELIVERIES_LIMIT}]`,
    );
  }
  const cursor =
    options.cursor === undefined || options.cursor === null
      ? null
      : decodeDeliveryCursor(options.cursor);
  return { limit, cursor };
}

/**
 * Whether `task` comes *after* `cursor` in newest-first order — i.e. it is older
 * (lower `createdAt`), or has the same timestamp and a lexicographically smaller `id`.
 * The single shared rule for the in-memory filter and the SQLite keyset predicate.
 */
export function isDeliveryAfterCursor(
  task: { readonly createdAt: number; readonly id: string },
  cursor: DeliveryCursor,
): boolean {
  if (task.createdAt !== cursor.createdAt) {
    return task.createdAt < cursor.createdAt;
  }
  return task.id < cursor.id;
}

/**
 * A fresh, all-zero status→count map. Backends start from this and fold their
 * counts into it, so every status is represented even when the queue is empty.
 */
export function zeroDeliveryCounts(): Record<DeliveryStatus, number> {
  return { pending: 0, delivering: 0, succeeded: 0, dead_letter: 0, cancelled: 0 };
}

/**
 * A durable queue of delivery work.
 *
 * Asynchronous so one contract spans synchronous engines (in-memory, SQLite via
 * `node:sqlite`) and asynchronous ones (Postgres) alike; sync backends resolve
 * eagerly.
 */
export interface DeliveryQueue {
  /** Enqueue a delivery, returning the freshly created `pending` task. */
  enqueue(input: EnqueueInput): Promise<DeliveryTask>;
  /**
   * Atomically claim up to `limit` due tasks, oldest-first, moving each to
   * `delivering` with a fresh lease. A task is due when it is `pending` and its
   * `nextAttemptAt` has arrived, or `delivering` with a lapsed lease.
   */
  claimDue(options: ClaimOptions): Promise<readonly DeliveryTask[]>;
  /**
   * Mark a leased task delivered (terminal `succeeded`). Throws
   * {@link UnknownDeliveryTaskError} if the id is unknown, or
   * {@link StaleLeaseError} if `leaseToken` does not match the live lease.
   */
  complete(taskId: string, leaseToken: string): Promise<DeliveryTask>;
  /**
   * Record a failed attempt on a leased task: reschedule it (`pending` with a
   * new `nextAttemptAt`) per the retry policy, or dead-letter it once retries
   * are exhausted. Same error contract as {@link DeliveryQueue.complete}.
   */
  fail(
    taskId: string,
    leaseToken: string,
    input: FailInput,
  ): Promise<DeliveryTask>;
  /** Fetch a task by id, or `null` if unknown. */
  get(taskId: string): Promise<DeliveryTask | null>;
  /**
   * Manually re-drive a finished delivery — the operator's recovery path. Resets
   * a **terminal** task (`succeeded` or `dead_letter`) to a fresh `pending`
   * state, deliverable immediately and with its attempt budget reset, so a worker
   * re-attempts it under the full retry schedule. The canonical use is replaying
   * a `dead_letter` delivery after its receiver has been fixed (the only escape
   * from that otherwise-permanent terminal state).
   *
   * Throws {@link UnknownDeliveryTaskError} if the id is unknown, or
   * `DeliveryStateError` if the task is not terminal — a `pending`/`delivering`
   * task is already being driven, so there is nothing to revive. That makes a
   * second `retry` of an already-revived (now `pending`) task throw, which a bulk
   * caller treats as an expected, catchable "already revived" condition (see
   * `retryMessageDeliveries`), mirroring how a lapsed lease surfaces as
   * {@link StaleLeaseError}.
   */
  retry(taskId: string): Promise<DeliveryTask>;
  /**
   * Reschedule a leased task for delivery at `availableAt` **without** consuming a
   * retry attempt — the rate-limit path. Moves the task from `delivering` back to
   * `pending(availableAt)` and releases the lease so another claim cycle picks it up.
   * Use when the worker decides to defer delivery (e.g. the endpoint's per-minute
   * rate limit is saturated) without penalising the task's retry budget.
   *
   * Same error contract as {@link complete}:
   * - {@link UnknownDeliveryTaskError} if the task id is unknown.
   * - {@link StaleLeaseError} if `leaseToken` does not match the live lease.
   */
  postpone(
    taskId: string,
    leaseToken: string,
    availableAt: number,
    nowMs: number,
  ): Promise<DeliveryTask>;
  /**
   * Cancel a `pending` delivery — the operator's abort path for a scheduled or
   * queued task that should not be sent. Moves the task to the terminal
   * `cancelled` state so the worker never claims it. An in-flight (`delivering`)
   * task cannot be cancelled (the HTTP request is already in progress).
   *
   * Throws {@link UnknownDeliveryTaskError} if the id is unknown, or
   * {@link DeliveryStateError} if the task is not `pending` — a `delivering`
   * task is in flight; a terminal task has nothing left to cancel. That makes a
   * second `cancel` of an already-cancelled task throw, which a bulk caller
   * treats as an expected, catchable "already cancelled" condition, mirroring how
   * a concurrent `retry` surfaces as {@link DeliveryStateError}.
   */
  cancel(taskId: string): Promise<DeliveryTask>;
  /**
   * List every delivery task for `messageId`, oldest-first (enqueue order).
   * Returns an empty array when the message has no tasks — because fan-out
   * matched no endpoint, or the id is unknown/empty. A pure read projection: it
   * never mutates and never throws on an unknown id (an absent message is simply
   * zero deliveries). This is the data primitive behind the delivery-status read
   * surface ("what happened to my message?") — the worker persists per-task
   * `status`/`attempts`/`lastError` here, and this exposes them per message.
   */
  listByMessage(messageId: string): Promise<readonly DeliveryTask[]>;
  /**
   * List delivery tasks for `endpointId`, newest-first (enqueue-time descending),
   * keyset-paginated. Returns an empty page when the endpoint has no tasks — because
   * no messages matched it, or the id is unknown. A pure read: never mutates, never
   * throws on an unknown endpoint id. This is the endpoint-centric view that
   * complements {@link listByMessage}: "what messages has this endpoint received,
   * and what is their delivery status?" The cursor encodes the last row's
   * `(createdAt, id)` so the page is stable under concurrent inserts.
   */
  listByEndpoint(
    endpointId: string,
    options?: ListByEndpointOptions,
  ): Promise<DeliveryPage>;
  /**
   * List delivery tasks for `appId`, newest-first (enqueue-time descending),
   * keyset-paginated, with optional `status` and `failureReason` filters (which
   * compose). Returns an empty page when the app has no tasks. A pure read:
   * never mutates, never throws on an unknown app id. This is the tenant-wide
   * cross-endpoint view: "show me all my deliveries" (or just the dead-lettered
   * ones, or just the ones that failed with `connection_refused`). Only tasks
   * enqueued with `appId` set appear; tasks without an `appId` (pre-migration
   * rows) are silently excluded — honest, since the attribution data was never
   * recorded.
   */
  listByApp(appId: string, options?: ListByAppOptions): Promise<DeliveryPage>;
  /**
   * Delete terminal delivery tasks (`succeeded` or `dead_letter`) whose `updatedAt`
   * is older than `olderThanMs` (epoch ms). Active tasks (`pending`/`delivering`) are
   * never deleted. Returns the count of tasks deleted. Called by the data pruner when
   * `POSTHORN_RETENTION_DAYS` is set.
   */
  pruneTerminalTasks(olderThanMs: number): Promise<number>;
  /**
   * Count tasks grouped by delivery status — the point-in-time backlog/health
   * gauge behind the metrics surface ("how much is queued / in flight / stuck in
   * dead_letter right now?"). Always returns every status key (zero when none),
   * so a caller renders a complete gauge family. A pure read: never mutates,
   * never throws on an empty queue.
   */
  countByStatus(): Promise<DeliveryCountsByStatus>;
}

/** Thrown when an operation references a task id the queue does not hold. */
export class UnknownDeliveryTaskError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`no delivery task with id "${taskId}"`);
    this.name = "UnknownDeliveryTaskError";
    this.taskId = taskId;
  }
}

/**
 * Thrown when `complete`/`fail` is called without holding the task's live lease
 * — the task is not `delivering`, or the supplied token no longer matches
 * (e.g. the lease lapsed and another worker reclaimed it). This is an *expected,
 * catchable* condition under at-least-once delivery, not necessarily a bug: a
 * worker that sees it should simply discard its now-orphaned result.
 */
export class StaleLeaseError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`lease for delivery task "${taskId}" is not held (stale or reclaimed)`);
    this.name = "StaleLeaseError";
    this.taskId = taskId;
  }
}

/** Default visibility timeout: a claimed task's lease lapses after 30s. */
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

/** Default ceiling on tasks returned by a single `claimDue` batch. */
export const DEFAULT_CLAIM_LIMIT = 100;

/** Prefix on generated task ids. */
const TASK_ID_PREFIX = "dtask_";

/**
 * Default task-id generator: a `dtask_`-prefixed URL-safe token with 144 bits of
 * CSPRNG entropy. Inject a deterministic generator in tests.
 */
export function createTaskId(): string {
  return TASK_ID_PREFIX + randomBytes(18).toString("base64url");
}

/**
 * Default lease-token generator: a URL-safe token with 144 bits of CSPRNG
 * entropy, unguessable so a stale worker cannot accidentally collide with a live
 * lease. Inject a deterministic generator in tests.
 */
export function createLeaseToken(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Validate a visibility timeout at construction. Shared by every backend so they
 * reject the same inputs identically. Must be a positive, finite number of ms.
 */
export function assertValidVisibilityTimeout(visibilityTimeoutMs: number): void {
  if (!Number.isFinite(visibilityTimeoutMs) || visibilityTimeoutMs <= 0) {
    throw new RangeError("visibilityTimeoutMs must be a positive, finite number");
  }
}

/** A validated/normalized {@link EnqueueInput}. */
export interface NormalizedEnqueue {
  readonly messageId: string;
  readonly endpointId: string | null;
  readonly appId: string | null;
  readonly availableAt: number | null;
  readonly priority: number;
}

/**
 * Validate and normalize an enqueue call, throwing {@link TypeError} on bad
 * input. Shared so every backend enforces an identical intake contract.
 */
export function normalizeEnqueueInput(input: EnqueueInput): NormalizedEnqueue {
  const { messageId } = input;
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
  const appId = input.appId ?? null;
  if (
    appId !== null &&
    (typeof appId !== "string" || appId.length === 0)
  ) {
    throw new TypeError("appId must be a non-empty string when provided");
  }
  const availableAt = input.availableAt ?? null;
  if (availableAt !== null && !Number.isFinite(availableAt)) {
    throw new TypeError("availableAt must be a finite epoch-ms timestamp or null");
  }
  const priority = input.priority ?? 0;
  if (![-1, 0, 1].includes(priority)) {
    throw new RangeError("priority must be -1, 0, or 1");
  }
  return { messageId, endpointId, appId, availableAt, priority };
}

/** Validate {@link ClaimOptions} and resolve the effective limit. */
export function normalizeClaimOptions(options: ClaimOptions): {
  nowMs: number;
  limit: number;
} {
  const { nowMs } = options;
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("claimDue nowMs must be a finite number");
  }
  const limit = options.limit ?? DEFAULT_CLAIM_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("claimDue limit must be a positive integer");
  }
  return { nowMs, limit };
}

/** Validate a {@link FailInput}. */
export function normalizeFailInput(input: FailInput): {
  error: string;
  nowMs: number;
  minDelayMs: number | undefined;
  retryPolicy: RetryPolicy | undefined;
  failureReason: DeliveryFailureReason | null;
} {
  if (typeof input.error !== "string") {
    throw new TypeError("fail error must be a string");
  }
  if (!Number.isFinite(input.nowMs)) {
    throw new TypeError("fail nowMs must be a finite number");
  }
  const { minDelayMs } = input;
  if (
    minDelayMs !== undefined &&
    (!Number.isFinite(minDelayMs) || minDelayMs < 0)
  ) {
    throw new TypeError(
      "fail minDelayMs must be a non-negative finite number when provided",
    );
  }
  const { failureReason } = input;
  if (
    failureReason !== undefined &&
    failureReason !== null &&
    !isDeliveryFailureReason(failureReason)
  ) {
    throw new TypeError(
      "fail failureReason must be a known DeliveryFailureReason or null when provided",
    );
  }
  return {
    error: input.error,
    nowMs: input.nowMs,
    minDelayMs,
    retryPolicy: input.retryPolicy,
    failureReason: failureReason ?? null,
  };
}

/** Project the FSM-relevant fields of a task into a {@link DeliveryState}. */
function taskToDeliveryState(task: DeliveryTask): DeliveryState {
  return {
    status: task.status,
    attempts: task.attempts,
    nextAttemptAt: task.nextAttemptAt,
    lastError: task.lastError,
  };
}

/**
 * The single, shared rule for whether a task may be claimed at `nowMs`, returned
 * as the `pending`-equivalent {@link DeliveryState} to start an attempt from (or
 * `null` if not claimable). Every backend defers to this so claim semantics
 * cannot drift between engines.
 *
 * Two cases are claimable: a `pending` task whose `nextAttemptAt` has arrived,
 * and a `delivering` task whose lease has lapsed (crash/stall recovery) — the
 * latter is reclaimed *as pending* so a fresh attempt is started against it.
 */
export function claimableState(
  task: DeliveryTask,
  nowMs: number,
): DeliveryState | null {
  if (
    task.status === "pending" &&
    (task.nextAttemptAt === null || task.nextAttemptAt <= nowMs)
  ) {
    return taskToDeliveryState(task);
  }
  if (
    task.status === "delivering" &&
    task.leaseExpiresAt !== null &&
    task.leaseExpiresAt <= nowMs
  ) {
    // Lease lapsed: the prior attempt is presumed dead (it already counted
    // toward `attempts`). Reclaim as pending so applyClaim starts a fresh one.
    return {
      status: "pending",
      attempts: task.attempts,
      nextAttemptAt: null,
      lastError: task.lastError,
    };
  }
  return null;
}

/** Whether {@link claimableState} would return a state for this task. */
export function isClaimable(task: DeliveryTask, nowMs: number): boolean {
  return claimableState(task, nowMs) !== null;
}

/**
 * Transition a claimable task to `delivering` under a fresh lease. Pure: the
 * attempt-accounting comes from the delivery-state reducer, the lease overlay is
 * applied here. Backends call this then persist the result.
 *
 * @throws if `task` is not claimable at `nowMs` (a backend invariant violation).
 */
export function applyClaim(
  policy: RetryPolicy,
  task: DeliveryTask,
  nowMs: number,
  leaseToken: string,
  visibilityTimeoutMs: number,
  jitter: JitterOptions = {},
): DeliveryTask {
  const state = claimableState(task, nowMs);
  if (state === null) {
    throw new Error(`applyClaim called on a non-claimable task "${task.id}"`);
  }
  const next = reduce(policy, state, { type: "attemptStarted" }, jitter);
  return {
    ...task,
    status: next.status,
    attempts: next.attempts,
    nextAttemptAt: null,
    leaseExpiresAt: nowMs + visibilityTimeoutMs,
    leaseToken,
    lastError: next.lastError,
    updatedAt: nowMs,
  };
}

/** Transition a `delivering` task to terminal `succeeded`, releasing the lease. */
export function applySuccess(
  policy: RetryPolicy,
  task: DeliveryTask,
  nowMs: number,
  jitter: JitterOptions = {},
): DeliveryTask {
  const next = reduce(
    policy,
    taskToDeliveryState(task),
    { type: "attemptSucceeded" },
    jitter,
  );
  return {
    ...task,
    status: next.status,
    attempts: next.attempts,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: next.lastError,
    updatedAt: nowMs,
  };
}

/**
 * Manually re-drive a finished delivery: reset a **terminal** task to a fresh
 * `pending` state, deliverable immediately and with its attempt budget reset.
 * Pure — the terminal→pending revival comes from the delivery-state reducer
 * (the `manualRetry` event), so it cannot drift from the rest of the FSM; the
 * lease overlay is cleared here. Backends call this then persist the result.
 *
 * @throws `DeliveryStateError` if `task` is not terminal (a `pending`/
 *         `delivering` task is already being driven — nothing to revive).
 */
export function applyManualRetry(
  policy: RetryPolicy,
  task: DeliveryTask,
  nowMs: number,
): DeliveryTask {
  const next = reduce(policy, taskToDeliveryState(task), { type: "manualRetry" });
  return {
    ...task,
    status: next.status,
    attempts: next.attempts,
    nextAttemptAt: next.nextAttemptAt,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: next.lastError,
    // Clear the structured reason on revival too — the reducer wipes `lastError`
    // for a fresh slate, and this field tracks it in lock-step.
    failureReason: null,
    updatedAt: nowMs,
  };
}

/**
 * Cancel a `pending` delivery task, moving it to the terminal `cancelled` state.
 * Pure — the cancel transition comes from the delivery-state reducer so it
 * cannot drift from the FSM; no lease fields are present on a pending task, so
 * none need clearing. Backends call this then persist the result.
 *
 * @throws `DeliveryStateError` if `task` is not `pending`.
 */
export function applyCancel(task: DeliveryTask, nowMs: number): DeliveryTask {
  const next = reduce(
    {} as RetryPolicy, // policy is unused by the cancel event
    taskToDeliveryState(task),
    { type: "cancel" },
  );
  return {
    ...task,
    status: next.status,
    attempts: next.attempts,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: next.lastError,
    updatedAt: nowMs,
  };
}

/**
 * Reschedule a `delivering` task back to `pending(availableAt)` **without**
 * counting this as a failed attempt — the rate-limit path. Releases the lease
 * so another claim can pick it up at `availableAt`. The attempt counter is
 * deliberately preserved (not incremented), so the task retains its full retry
 * budget for actual delivery failures.
 *
 * @throws `DeliveryStateError` when the task is not `delivering`.
 */
export function applyPostpone(
  task: DeliveryTask,
  availableAt: number,
  nowMs: number,
): DeliveryTask {
  if (task.status !== "delivering") {
    throw new DeliveryStateError(
      `cannot postpone a task with status "${task.status}"; task must be "delivering"`,
    );
  }
  return {
    ...task,
    status: "pending",
    nextAttemptAt: availableAt,
    leaseExpiresAt: null,
    leaseToken: null,
    updatedAt: nowMs,
  };
}

/**
 * Transition a `delivering` task after a failed attempt: reschedule to `pending`
 * with a policy-derived `nextAttemptAt`, or dead-letter once retries are spent.
 * Releases the lease either way.
 */
export function applyFailure(
  policy: RetryPolicy,
  task: DeliveryTask,
  error: string,
  failureReason: DeliveryFailureReason | null,
  nowMs: number,
  jitter: JitterOptions = {},
): DeliveryTask {
  const next = reduce(
    policy,
    taskToDeliveryState(task),
    { type: "attemptFailed", error, nowMs },
    jitter,
  );
  return {
    ...task,
    status: next.status,
    attempts: next.attempts,
    nextAttemptAt: next.nextAttemptAt,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: next.lastError,
    // Denormalize the structured reason alongside `lastError`. The reducer carries
    // `lastError`; this field is the worker's classification, set in the same step.
    failureReason,
    updatedAt: nowMs,
  };
}
