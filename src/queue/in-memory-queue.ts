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
  applyClaim,
  applyFailure,
  applySuccess,
  claimableState,
  createLeaseToken,
  createTaskId,
  normalizeClaimOptions,
  normalizeEnqueueInput,
  normalizeFailInput,
  StaleLeaseError,
  UnknownDeliveryTaskError,
  assertValidVisibilityTimeout,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  type ClaimOptions,
  type DeliveryQueue,
  type DeliveryTask,
  type EnqueueInput,
  type FailInput,
} from "./delivery-queue.js";
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
    const { messageId, endpointId, availableAt } = normalizeEnqueueInput(input);
    const nowMs = this.#now();
    const id = this.#generateId();
    if (this.#tasks.has(id)) {
      throw new Error(`generated task id "${id}" collides with an existing one`);
    }
    const task: DeliveryTask = {
      id,
      messageId,
      endpointId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: availableAt,
      leaseExpiresAt: null,
      leaseToken: null,
      lastError: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this.#tasks.set(id, task);
    return task;
  }

  async claimDue(options: ClaimOptions): Promise<readonly DeliveryTask[]> {
    const { nowMs, limit } = normalizeClaimOptions(options);
    const claimed: DeliveryTask[] = [];
    // Map iteration is insertion order → oldest-first claiming.
    for (const task of this.#tasks.values()) {
      if (claimed.length >= limit) break;
      if (claimableState(task, nowMs) === null) continue;
      const leased = applyClaim(
        this.#policy,
        task,
        nowMs,
        this.#generateLeaseToken(),
        this.#visibilityTimeoutMs,
        this.#jitter,
      );
      this.#tasks.set(leased.id, leased); // same key → keeps insertion order
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
    const { error, nowMs } = normalizeFailInput(input);
    const task = this.#requireLeaseHolder(taskId, leaseToken);
    const next = applyFailure(this.#policy, task, error, nowMs, this.#jitter);
    this.#tasks.set(next.id, next);
    return next;
  }

  async get(taskId: string): Promise<DeliveryTask | null> {
    return this.#tasks.get(taskId) ?? null;
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
