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
  reduce,
  type DeliveryState,
  type DeliveryStatus,
} from "../delivery/delivery-state.js";
import {
  DEFAULT_RETRY_POLICY,
  type JitterOptions,
  type RetryPolicy,
} from "../delivery/retry-policy.js";

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
   * Epoch-ms before which the task is not claimable. Omit (or `null`) to make
   * it deliverable immediately. Useful for scheduled/delayed first delivery.
   */
  readonly availableAt?: number | null;
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
  /** Time the failure occurred, epoch ms — the basis for the next retry. */
  readonly nowMs: number;
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
  readonly availableAt: number | null;
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
  const availableAt = input.availableAt ?? null;
  if (availableAt !== null && !Number.isFinite(availableAt)) {
    throw new TypeError("availableAt must be a finite epoch-ms timestamp or null");
  }
  return { messageId, availableAt };
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
} {
  if (typeof input.error !== "string") {
    throw new TypeError("fail error must be a string");
  }
  if (!Number.isFinite(input.nowMs)) {
    throw new TypeError("fail nowMs must be a finite number");
  }
  return { error: input.error, nowMs: input.nowMs };
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
 * Transition a `delivering` task after a failed attempt: reschedule to `pending`
 * with a policy-derived `nextAttemptAt`, or dead-letter once retries are spent.
 * Releases the lease either way.
 */
export function applyFailure(
  policy: RetryPolicy,
  task: DeliveryTask,
  error: string,
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
    updatedAt: nowMs,
  };
}
