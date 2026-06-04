/**
 * A durable {@link DeliveryQueue} backed by PostgreSQL.
 *
 * The horizontally-scalable sibling of {@link SqliteDeliveryQueue}. Multiple
 * Posthorn workers can share one Postgres database and claim tasks without
 * stepping on each other — `SELECT … FOR UPDATE SKIP LOCKED` is the
 * Postgres-idiomatic equivalent of SQLite's `BEGIN IMMEDIATE` for claim
 * atomicity, and it is actually more concurrent: two workers processing
 * separate claimable rows never block each other.
 */

import type { Pool, PoolClient } from "pg";
import {
  applyCancel,
  applyClaim,
  applyFailure,
  applyManualRetry,
  applyPostpone,
  applySuccess,
  assertValidVisibilityTimeout,
  createLeaseToken,
  createTaskId,
  encodeDeliveryCursor,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  normalizeClaimOptions,
  normalizeEnqueueInput,
  normalizeFailInput,
  resolveListDeliveriesQuery,
  StaleLeaseError,
  UnknownDeliveryTaskError,
  zeroDeliveryCounts,
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
  DEFAULT_RETRY_POLICY,
  type JitterOptions,
  type RetryPolicy,
} from "../delivery/retry-policy.js";
import type { DeliveryStatus } from "../delivery/delivery-state.js";
import {
  emptyDeliveryFailureCounts,
  isDeliveryFailureReason,
  type DeliveryFailureReasonCounts,
} from "../delivery/failure-reason.js";

export interface PostgresQueueOptions {
  now?: () => number;
  generateId?: () => string;
  generateLeaseToken?: () => string;
  retryPolicy?: RetryPolicy;
  jitter?: JitterOptions;
  visibilityTimeoutMs?: number;
}

interface TaskRow {
  readonly id: string;
  readonly message_id: string;
  readonly endpoint_id: string | null;
  readonly app_id: string | null;
  readonly status: string;
  readonly attempts: string; // BIGINT as string
  readonly next_attempt_at: string | null;
  readonly lease_expires_at: string | null;
  readonly lease_token: string | null;
  readonly last_error: string | null;
  readonly failure_reason: string | null;
  readonly priority: number; // INTEGER — pg returns small ints as number
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToTask(row: TaskRow): DeliveryTask {
  return {
    id: row.id,
    messageId: row.message_id,
    endpointId: row.endpoint_id,
    appId: row.app_id,
    status: row.status as DeliveryStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    leaseToken: row.lease_token,
    lastError: row.last_error,
    // Cast the stored TEXT to the closed reason domain — same trust model as `status`.
    failureReason: row.failure_reason as DeliveryTask["failureReason"],
    priority: row.priority ?? 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PostgresDeliveryQueue implements DeliveryQueue {
  readonly #pool: Pool;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #generateLeaseToken: () => string;
  readonly #policy: RetryPolicy;
  readonly #jitter: JitterOptions;
  readonly #visibilityTimeoutMs: number;

  constructor(pool: Pool, options: PostgresQueueOptions = {}) {
    const {
      now = Date.now,
      generateId = createTaskId,
      generateLeaseToken = createLeaseToken,
      retryPolicy = DEFAULT_RETRY_POLICY,
      jitter = {},
      visibilityTimeoutMs = DEFAULT_VISIBILITY_TIMEOUT_MS,
    } = options;
    assertValidVisibilityTimeout(visibilityTimeoutMs);
    this.#pool = pool;
    this.#now = now;
    this.#generateId = generateId;
    this.#generateLeaseToken = generateLeaseToken;
    this.#policy = retryPolicy;
    this.#jitter = jitter;
    this.#visibilityTimeoutMs = visibilityTimeoutMs;
  }

  async initialize(): Promise<void> {
    await this.#pool.query(SCHEMA);
    await this.#pool.query(INDEXES);
    // Additive migration: add priority for delivery ordering. Existing rows default to 0 (normal).
    await this.#pool.query(
      "ALTER TABLE delivery_tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0",
    );
    // Additive migration: denormalized structured failure reason. Existing rows read
    // back null (the code was never recorded for failures that predate this column).
    await this.#pool.query(
      "ALTER TABLE delivery_tasks ADD COLUMN IF NOT EXISTS failure_reason TEXT",
    );
    // Reason-filtered app listing index — created after the failure_reason column
    // is guaranteed to exist (it references that column, so it cannot live in the
    // INDEXES block, which runs before the ALTER on a pre-migration DB).
    await this.#pool.query(
      "CREATE INDEX IF NOT EXISTS idx_delivery_tasks_app_reason" +
        " ON delivery_tasks (app_id, failure_reason, created_at, id)" +
        " WHERE app_id IS NOT NULL",
    );
  }

  async truncate(): Promise<void> {
    await this.#pool.query(
      "TRUNCATE TABLE delivery_tasks RESTART IDENTITY CASCADE",
    );
  }

  close(): void {}

  async enqueue(input: EnqueueInput): Promise<DeliveryTask> {
    const { messageId, endpointId, appId, availableAt, priority } = normalizeEnqueueInput(input);
    const nowMs = this.#now();
    const id = this.#generateId();
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
    await this.#pool.query(
      "INSERT INTO delivery_tasks (id, message_id, endpoint_id, app_id, status, attempts," +
        " next_attempt_at, lease_expires_at, lease_token, last_error, failure_reason," +
        " priority, created_at, updated_at)" +
        " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [
        task.id, task.messageId, task.endpointId, task.appId,
        task.status, task.attempts, task.nextAttemptAt,
        task.leaseExpiresAt, task.leaseToken, task.lastError,
        task.failureReason, task.priority, task.createdAt, task.updatedAt,
      ],
    );
    return task;
  }

  async claimDue(options: ClaimOptions): Promise<readonly DeliveryTask[]> {
    const { nowMs, limit } = normalizeClaimOptions(options);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE SKIP LOCKED: multiple workers can claim different rows
      // concurrently without blocking each other — the Postgres equivalent of
      // SQLite's BEGIN IMMEDIATE for queue-drain atomicity.
      const { rows } = await client.query<TaskRow>(
        "SELECT * FROM delivery_tasks" +
          " WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))" +
          "    OR (status = 'delivering' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $2)" +
          " ORDER BY priority DESC, created_at ASC, id ASC" +
          " LIMIT $3 FOR UPDATE SKIP LOCKED",
        [nowMs, nowMs, limit],
      );
      const claimed: DeliveryTask[] = [];
      for (const row of rows) {
        const leased = applyClaim(
          this.#policy,
          rowToTask(row),
          nowMs,
          this.#generateLeaseToken(),
          this.#visibilityTimeoutMs,
          this.#jitter,
        );
        await this.#persist(client, leased);
        claimed.push(leased);
      }
      await client.query("COMMIT");
      return claimed;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async complete(taskId: string, leaseToken: string): Promise<DeliveryTask> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const task = await this.#requireLeaseHolder(client, taskId, leaseToken);
      const next = applySuccess(this.#policy, task, this.#now(), this.#jitter);
      await this.#persist(client, next);
      await client.query("COMMIT");
      return next;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async fail(taskId: string, leaseToken: string, input: FailInput): Promise<DeliveryTask> {
    const { error, nowMs, minDelayMs, retryPolicy, failureReason } = normalizeFailInput(input);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const task = await this.#requireLeaseHolder(client, taskId, leaseToken);
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
      await this.#persist(client, next);
      await client.query("COMMIT");
      return next;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async retry(taskId: string): Promise<DeliveryTask> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<TaskRow>(
        "SELECT * FROM delivery_tasks WHERE id = $1 FOR UPDATE",
        [taskId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new UnknownDeliveryTaskError(taskId);
      }
      const next = applyManualRetry(this.#policy, rowToTask(row), this.#now());
      await this.#persist(client, next);
      await client.query("COMMIT");
      return next;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async cancel(taskId: string): Promise<DeliveryTask> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<TaskRow>(
        "SELECT * FROM delivery_tasks WHERE id = $1 FOR UPDATE",
        [taskId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new UnknownDeliveryTaskError(taskId);
      }
      // applyCancel throws DeliveryStateError if the task is not pending.
      const next = applyCancel(rowToTask(row), this.#now());
      await this.#persist(client, next);
      await client.query("COMMIT");
      return next;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async postpone(
    taskId: string,
    leaseToken: string,
    availableAt: number,
    nowMs: number,
  ): Promise<DeliveryTask> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const task = await this.#requireLeaseHolder(client, taskId, leaseToken);
      const next = applyPostpone(task, availableAt, nowMs);
      await this.#persist(client, next);
      await client.query("COMMIT");
      return next;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async get(taskId: string): Promise<DeliveryTask | null> {
    const { rows } = await this.#pool.query<TaskRow>(
      "SELECT * FROM delivery_tasks WHERE id = $1",
      [taskId],
    );
    const row = rows[0];
    return row !== undefined ? rowToTask(row) : null;
  }

  async listByMessage(messageId: string): Promise<readonly DeliveryTask[]> {
    const { rows } = await this.#pool.query<TaskRow>(
      "SELECT * FROM delivery_tasks WHERE message_id = $1 ORDER BY created_at ASC, id ASC",
      [messageId],
    );
    return rows.map(rowToTask);
  }

  async listByEndpoint(endpointId: string, options?: ListByEndpointOptions): Promise<DeliveryPage> {
    const { limit, cursor } = resolveListDeliveriesQuery(options);
    const status = options?.status ?? null;
    const fetchLimit = limit + 1;
    let rows: TaskRow[];
    if (status === null) {
      if (cursor === null) {
        ({ rows } = await this.#pool.query<TaskRow>(
          "SELECT * FROM delivery_tasks WHERE endpoint_id = $1" +
            " ORDER BY created_at DESC, id DESC LIMIT $2",
          [endpointId, fetchLimit],
        ));
      } else {
        ({ rows } = await this.#pool.query<TaskRow>(
          "SELECT * FROM delivery_tasks WHERE endpoint_id = $1" +
            " AND (created_at < $2 OR (created_at = $3 AND id < $4))" +
            " ORDER BY created_at DESC, id DESC LIMIT $5",
          [endpointId, cursor.createdAt, cursor.createdAt, cursor.id, fetchLimit],
        ));
      }
    } else {
      if (cursor === null) {
        ({ rows } = await this.#pool.query<TaskRow>(
          "SELECT * FROM delivery_tasks WHERE endpoint_id = $1 AND status = $2" +
            " ORDER BY created_at DESC, id DESC LIMIT $3",
          [endpointId, status, fetchLimit],
        ));
      } else {
        ({ rows } = await this.#pool.query<TaskRow>(
          "SELECT * FROM delivery_tasks WHERE endpoint_id = $1 AND status = $2" +
            " AND (created_at < $3 OR (created_at = $4 AND id < $5))" +
            " ORDER BY created_at DESC, id DESC LIMIT $6",
          [endpointId, status, cursor.createdAt, cursor.createdAt, cursor.id, fetchLimit],
        ));
      }
    }
    const hasMore = rows.length > limit;
    const deliveries = rows.slice(0, limit).map(rowToTask);
    const last = deliveries[deliveries.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeDeliveryCursor(last) : null;
    return { deliveries, nextCursor };
  }

  async listByApp(appId: string, options?: ListByAppOptions): Promise<DeliveryPage> {
    const { limit, cursor } = resolveListDeliveriesQuery(options);
    const status = options?.status ?? null;
    const failureReason = options?.failureReason ?? null;
    const fetchLimit = limit + 1;

    // Build the predicate and positional params in lock-step. `status` and
    // `failureReason` are independent, composable filters, so the WHERE clause
    // is assembled dynamically rather than enumerating every combination.
    const conditions = ["app_id = $1"];
    const params: (string | number)[] = [appId];
    const next = (value: string | number): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (status !== null) {
      conditions.push(`status = ${next(status)}`);
    }
    if (failureReason !== null) {
      conditions.push(`failure_reason = ${next(failureReason)}`);
    }
    if (cursor !== null) {
      const lt = next(cursor.createdAt);
      const eq = next(cursor.createdAt);
      const id = next(cursor.id);
      conditions.push(`(created_at < ${lt} OR (created_at = ${eq} AND id < ${id}))`);
    }
    const limitPlaceholder = next(fetchLimit);

    const { rows } = await this.#pool.query<TaskRow>(
      `SELECT * FROM delivery_tasks WHERE ${conditions.join(" AND ")}` +
        ` ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
      params,
    );
    const hasMore = rows.length > limit;
    const deliveries = (rows as TaskRow[]).slice(0, limit).map(rowToTask);
    const last = deliveries[deliveries.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeDeliveryCursor(last) : null;
    return { deliveries, nextCursor };
  }

  async pruneTerminalTasks(olderThanMs: number): Promise<number> {
    const result = await this.#pool.query(
      "DELETE FROM delivery_tasks WHERE updated_at < $1 AND status IN ('succeeded', 'dead_letter', 'cancelled')",
      [olderThanMs],
    );
    return result.rowCount ?? 0;
  }

  async countByStatus(): Promise<DeliveryCountsByStatus> {
    const counts = zeroDeliveryCounts();
    const { rows } = await this.#pool.query<{ status: string; n: string }>(
      "SELECT status, COUNT(*) AS n FROM delivery_tasks GROUP BY status",
    );
    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status as DeliveryStatus] += Number(row.n);
      }
    }
    return counts;
  }

  async countDeadLettersByReason(): Promise<DeliveryFailureReasonCounts> {
    const counts = emptyDeliveryFailureCounts();
    const { rows } = await this.#pool.query<{ reason: string | null; n: string }>(
      "SELECT failure_reason AS reason, COUNT(*) AS n FROM delivery_tasks" +
        " WHERE status = 'dead_letter' GROUP BY failure_reason",
    );
    for (const row of rows) {
      // A null (legacy/pre-classification) or unrecognized reason folds into `other`,
      // keeping the sum equal to the dead_letter total.
      const reason = isDeliveryFailureReason(row.reason) ? row.reason : "other";
      counts[reason] += Number(row.n);
    }
    return counts;
  }

  async #persist(client: PoolClient, task: DeliveryTask): Promise<void> {
    await client.query(
      "UPDATE delivery_tasks SET status=$1, attempts=$2, next_attempt_at=$3," +
        " lease_expires_at=$4, lease_token=$5, last_error=$6, failure_reason=$7," +
        " updated_at=$8 WHERE id=$9",
      [
        task.status, task.attempts, task.nextAttemptAt,
        task.leaseExpiresAt, task.leaseToken, task.lastError,
        task.failureReason, task.updatedAt, task.id,
      ],
    );
  }

  async #requireLeaseHolder(client: PoolClient, taskId: string, leaseToken: string): Promise<DeliveryTask> {
    const { rows } = await client.query<TaskRow>(
      "SELECT * FROM delivery_tasks WHERE id = $1 FOR UPDATE",
      [taskId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new UnknownDeliveryTaskError(taskId);
    }
    const task = rowToTask(row);
    if (task.status !== "delivering" || task.leaseToken !== leaseToken) {
      throw new StaleLeaseError(taskId);
    }
    return task;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_tasks (
  id               TEXT    PRIMARY KEY,
  message_id       TEXT    NOT NULL,
  endpoint_id      TEXT,
  app_id           TEXT,
  status           TEXT    NOT NULL,
  attempts         BIGINT  NOT NULL,
  next_attempt_at  BIGINT,
  lease_expires_at BIGINT,
  lease_token      TEXT,
  last_error       TEXT,
  failure_reason   TEXT,
  priority         INTEGER NOT NULL DEFAULT 0,
  created_at       BIGINT  NOT NULL,
  updated_at       BIGINT  NOT NULL
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_delivery_tasks_claimable
  ON delivery_tasks (status, next_attempt_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_delivery_tasks_message
  ON delivery_tasks (message_id);

CREATE INDEX IF NOT EXISTS idx_delivery_tasks_endpoint_created
  ON delivery_tasks (endpoint_id, created_at, id)
  WHERE endpoint_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_tasks_app
  ON delivery_tasks (app_id, created_at, id)
  WHERE app_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_tasks_app_status
  ON delivery_tasks (app_id, status, created_at, id)
  WHERE app_id IS NOT NULL;
`;
