/**
 * An in-memory {@link DeliveryQueue}.
 *
 * The reference backend: zero dependencies, the behavioural specification the
 * durable backends must match. Ideal for embedding Posthorn in a single process
 * where durability across restarts is not required, and for tests.
 *
 * Tasks are held in an insertion-ordered map and stored as immutable snapshots —
 * each transition replaces the entry with a fresh {@link DeliveryTask}, so a
 * snapshot a caller already holds never mutates underneath them. Insertion order
 * is the claim order (oldest-first), matching the SQLite backend's `rowid` order.
 *
 * Determinism is preserved by injecting the clock, id generator, and lease-token
 * generator, mirroring the rest of the core.
 */

import {
  applyCancel,
  applyClaim,
  applyFailure,
  applyManualRetry,
  applyPostpone,
  applySuccess,
  claimableState,
  createLeaseToken,
  createTaskId,
  encodeDeliveryCursor,
  isDeliveryAfterCursor,
  normalizeClaimOptions,
  normalizeEnqueueInput,
  normalizeFailInput,
  resolveListDeliveriesQuery,
  StaleLeaseError,
  UnknownDeliveryTaskError,
  assertValidVisibilityTimeout,
  zeroDeliveryCounts,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  type ClaimOptions,
  type DeliveryCountsByStatus,
  type DeliveryPage,
  type DeliveryQueue,
  type DeliveryTask,
  type EnqueueInput,
  type FailInput,
  type ListByAppOptions,
  type ListByEndpointOptions,
} from "./delivery-queue.js";
import {
  emptyDeliveryFailureCounts,
  isDeliveryFailureReason,
  type DeliveryFailureReasonCounts,
} from "../delivery/failure-reason.js";
import {
  DEFAULT_RETRY_POLICY,
  type JitterOptions,
  type RetryPolicy,
} from "../delivery/retry-policy.js";

/** Construction options for {@link InMemoryDeliveryQueue}. */
export interface InMemoryQueueOptions {
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Task-id generator. Defaults to {@link createTaskId}. */
  generateId?: () => string;
  /** Lease-token generator. Defaults to {@link createLeaseToken}. */
  generateLeaseToken?: () => string;
  /** Retry schedule consulted on failure. Defaults to {@link DEFAULT_RETRY_POLICY}. */
  retryPolicy?: RetryPolicy;
  /** Jitter applied to retry delays. Defaults to none (deterministic). */
  jitter?: JitterOptions;
  /**
   * How long a claimed task's lease lasts before it may be reclaimed, in ms.
   * Set comfortably above a worker's per-attempt HTTP timeout. Must be `> 0`.
   * Defaults to {@link DEFAULT_VISIBILITY_TIMEOUT_MS}.
   */
  visibilityTimeoutMs?: number;
}

export class InMemoryDeliveryQueue implements DeliveryQueue {
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #generateLeaseToken: () => string;
  readonly #policy: RetryPolicy;
  readonly #jitter: JitterOptions;
  readonly #visibilityTimeoutMs: number;
  /** task id → immutable task snapshot. Insertion order is preserved. */
  readonly #tasks = new Map<string, DeliveryTask>();

  constructor(options: InMemoryQueueOptions = {}) {
    const {
      now = Date.now,
      generateId = createTaskId,
      generateLeaseToken = createLeaseToken,
      retryPolicy = DEFAULT_RETRY_POLICY,
      jitter = {},
      visibilityTimeoutMs = DEFAULT_VISIBILITY_TIMEOUT_MS,
    } = options;
    assertValidVisibilityTimeout(visibilityTimeoutMs);
    this.#now = now;
    this.#generateId = generateId;
    this.#generateLeaseToken = generateLeaseToken;
    this.#policy = retryPolicy;
    this.#jitter = jitter;
    this.#visibilityTimeoutMs = visibilityTimeoutMs;
  }

  /** Number of tasks currently held (terminal ones are never pruned). */
  get size(): number {
    return this.#tasks.size;
  }

  async enqueue(input: EnqueueInput): Promise<DeliveryTask> {
    const { messageId, endpointId, appId, availableAt, priority } = normalizeEnqueueInput(input);
    const nowMs = this.#now();
    const id = this.#generateId();
    if (this.#tasks.has(id)) {
      throw new Error(`generated task id "${id}" collides with an existing one`);
    }
    const task: DeliveryTask = {
      id,
      messageId,
      endpointId,
      appId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: availableAt,
      leaseExpiresAt: null,
      leaseToken: null,
      lastError: null,
      failureReason: null,
      priority,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this.#tasks.set(id, task);
    return task;
  }

  async claimDue(options: ClaimOptions): Promise<readonly DeliveryTask[]> {
    const { nowMs, limit } = normalizeClaimOptions(options);
    // Collect all claimable candidates, sort priority DESC then createdAt ASC / id ASC
    // (matches the SQL ORDER BY priority DESC, rowid/created_at ASC so behaviour is identical).
    const candidates = [...this.#tasks.values()]
      .filter((t) => claimableState(t, nowMs) !== null)
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    const claimed: DeliveryTask[] = [];
    for (const task of candidates) {
      if (claimed.length >= limit) break;
      const leased = applyClaim(
        this.#policy,
        task,
        nowMs,
        this.#generateLeaseToken(),
        this.#visibilityTimeoutMs,
        this.#jitter,
      );
      this.#tasks.set(leased.id, leased);
      claimed.push(leased);
    }
    return claimed;
  }

  async complete(taskId: string, leaseToken: string): Promise<DeliveryTask> {
    const task = this.#requireLeaseHolder(taskId, leaseToken);
    const next = applySuccess(this.#policy, task, this.#now(), this.#jitter);
    this.#tasks.set(next.id, next);
    return next;
  }

  async fail(
    taskId: string,
    leaseToken: string,
    input: FailInput,
  ): Promise<DeliveryTask> {
    const { error, nowMs, minDelayMs, retryPolicy, failureReason } = normalizeFailInput(input);
    const task = this.#requireLeaseHolder(taskId, leaseToken);
    let next = applyFailure(retryPolicy ?? this.#policy, task, error, failureReason, nowMs, this.#jitter);
    if (
      next.status === "pending" &&
      next.nextAttemptAt !== null &&
      minDelayMs !== undefined
    ) {
      const floor = nowMs + minDelayMs;
      if (next.nextAttemptAt < floor) {
        next = { ...next, nextAttemptAt: floor };
      }
    }
    this.#tasks.set(next.id, next);
    return next;
  }

  async retry(taskId: string): Promise<DeliveryTask> {
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      throw new UnknownDeliveryTaskError(taskId);
    }
    // applyManualRetry throws DeliveryStateError if the task is not terminal.
    const next = applyManualRetry(this.#policy, task, this.#now());
    this.#tasks.set(next.id, next); // same key → keeps insertion order
    return next;
  }

  async cancel(taskId: string): Promise<DeliveryTask> {
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      throw new UnknownDeliveryTaskError(taskId);
    }
    // applyCancel throws DeliveryStateError if the task is not pending.
    const next = applyCancel(task, this.#now());
    this.#tasks.set(next.id, next);
    return next;
  }

  async postpone(
    taskId: string,
    leaseToken: string,
    availableAt: number,
    nowMs: number,
  ): Promise<DeliveryTask> {
    const task = this.#requireLeaseHolder(taskId, leaseToken);
    const next = applyPostpone(task, availableAt, nowMs);
    this.#tasks.set(next.id, next);
    return next;
  }

  async get(taskId: string): Promise<DeliveryTask | null> {
    return this.#tasks.get(taskId) ?? null;
  }

  async listByMessage(messageId: string): Promise<readonly DeliveryTask[]> {
    const tasks: DeliveryTask[] = [];
    // Map iteration is insertion order → oldest-first, matching SQLite's rowid.
    for (const task of this.#tasks.values()) {
      if (task.messageId === messageId) tasks.push(task);
    }
    return tasks;
  }

  async listByEndpoint(
    endpointId: string,
    options?: ListByEndpointOptions,
  ): Promise<DeliveryPage> {
    const { limit, cursor } = resolveListDeliveriesQuery(options);
    const status = options?.status ?? null;
    // Sort newest-first (createdAt DESC, id DESC) — mirrors the SQLite ORDER BY.
    const ordered = [...this.#tasks.values()]
      .filter((t) => t.endpointId === endpointId)
      .filter((t) => status === null || t.status === status)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      });
    const after =
      cursor === null
        ? ordered
        : ordered.filter((t) => isDeliveryAfterCursor(t, cursor));
    const hasMore = after.length > limit;
    const deliveries = after.slice(0, limit);
    const last = deliveries[deliveries.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeDeliveryCursor(last) : null;
    return { deliveries, nextCursor };
  }

  async listByApp(appId: string, options?: ListByAppOptions): Promise<DeliveryPage> {
    const { limit, cursor } = resolveListDeliveriesQuery(options);
    const status = options?.status ?? null;
    const failureReason = options?.failureReason ?? null;
    // Sort newest-first (createdAt DESC, id DESC) — mirrors the SQLite ORDER BY.
    const ordered = [...this.#tasks.values()]
      .filter((t) => t.appId === appId)
      .filter((t) => status === null || t.status === status)
      .filter((t) => failureReason === null || t.failureReason === failureReason)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      });
    const after =
      cursor === null
        ? ordered
        : ordered.filter((t) => isDeliveryAfterCursor(t, cursor));
    const hasMore = after.length > limit;
    const deliveries = after.slice(0, limit);
    const last = deliveries[deliveries.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeDeliveryCursor(last) : null;
    return { deliveries, nextCursor };
  }

  async pruneTerminalTasks(olderThanMs: number): Promise<number> {
    let deleted = 0;
    for (const [id, task] of this.#tasks) {
      if (
        (task.status === "succeeded" || task.status === "dead_letter") &&
        task.updatedAt < olderThanMs
      ) {
        this.#tasks.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async countByStatus(): Promise<DeliveryCountsByStatus> {
    const counts = zeroDeliveryCounts();
    for (const task of this.#tasks.values()) {
      counts[task.status] += 1;
    }
    return counts;
  }

  async countDeadLettersByReason(): Promise<DeliveryFailureReasonCounts> {
    const counts = emptyDeliveryFailureCounts();
    for (const task of this.#tasks.values()) {
      if (task.status !== "dead_letter") continue;
      // A pre-classification (null) or unrecognized reason folds into `other`, so the
      // sum stays equal to the dead_letter total.
      const reason = isDeliveryFailureReason(task.failureReason) ? task.failureReason : "other";
      counts[reason] += 1;
    }
    return counts;
  }

  /**
   * Resolve the task and assert the caller holds its live lease, or throw the
   * appropriate typed error.
   */
  #requireLeaseHolder(taskId: string, leaseToken: string): DeliveryTask {
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      throw new UnknownDeliveryTaskError(taskId);
    }
    if (task.status !== "delivering" || task.leaseToken !== leaseToken) {
      throw new StaleLeaseError(taskId);
    }
    return task;
  }
}
