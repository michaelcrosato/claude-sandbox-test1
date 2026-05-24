/**
 * A durable {@link DeliveryQueue} backed by SQLite via Node's built-in
 * `node:sqlite` module — **zero third-party dependencies, no native compile
 * step**. This is what makes the "single process, no Redis, crash-safe" wedge
 * real for delivery: claimed work survives a process restart, and a lease that
 * was in flight when the process died is *replayed* once it lapses.
 *
 * It is the durable sibling of {@link InMemoryDeliveryQueue}, held to the exact
 * same contract: the two share one transition implementation (see
 * `delivery-queue.ts`) and pass one conformance suite. Only persistence differs.
 *
 * `claimDue` runs in a `BEGIN IMMEDIATE` transaction so the select-then-lease is
 * atomic across connections — two workers can never claim the same task. Tasks
 * are claimed in `rowid` order (insertion order), matching the in-memory backend.
 */

import { createRequire } from "node:module";
import type {
  DatabaseSync as SqliteDatabase,
  StatementSync,
} from "node:sqlite";
import {
  applyCancel,
  applyClaim,
  applyFailure,
  applyManualRetry,
  applySuccess,
  assertValidVisibilityTimeout,
  createLeaseToken,
  createTaskId,
  decodeDeliveryCursor,
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

// Loaded through createRequire rather than a static `import ... from
// "node:sqlite"`: it is a genuine Node builtin, but bundlers whose builtin
// lists predate it (e.g. Vite 5, our test runner) choke on the static
// specifier. Requiring it keeps it a runtime builtin lookup. (See sqlite-store.)
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** Construction options for {@link SqliteDeliveryQueue}. */
export interface SqliteQueueOptions {
  /**
   * Where to store the database: a filesystem path for durability, or
   * `":memory:"` (the default) for an ephemeral, process-lifetime queue.
   */
  location?: string;
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

/** Shape of a row from the `delivery_tasks` table. */
interface TaskRow {
  readonly id: string;
  readonly message_id: string;
  readonly endpoint_id: string | null;
  readonly app_id: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly next_attempt_at: number | null;
  readonly lease_expires_at: number | null;
  readonly lease_token: string | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
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
    leaseExpiresAt:
      row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    leaseToken: row.lease_token,
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class SqliteDeliveryQueue implements DeliveryQueue {
  readonly #db: SqliteDatabase;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #generateLeaseToken: () => string;
  readonly #policy: RetryPolicy;
  readonly #jitter: JitterOptions;
  readonly #visibilityTimeoutMs: number;

  // Prepared once at construction, reused per call.
  readonly #selectTask: StatementSync;
  readonly #selectByMessage: StatementSync;
  readonly #selectByEndpoint: StatementSync;
  readonly #selectByEndpointAfter: StatementSync;
  readonly #selectByEndpointFiltered: StatementSync;
  readonly #selectByEndpointFilteredAfter: StatementSync;
  readonly #selectByApp: StatementSync;
  readonly #selectByAppAfter: StatementSync;
  readonly #selectByAppFiltered: StatementSync;
  readonly #selectByAppFilteredAfter: StatementSync;
  readonly #selectClaimable: StatementSync;
  readonly #insertTask: StatementSync;
  readonly #updateTask: StatementSync;
  readonly #countTasks: StatementSync;
  readonly #countByStatus: StatementSync;

  constructor(options: SqliteQueueOptions = {}) {
    const {
      location = ":memory:",
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

    this.#db = new DatabaseSync(location);
    // WAL gives crash-safe, concurrent-reader durability for file-backed queues
    // (a no-op for `:memory:`).
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(SCHEMA);
    // Ensure app_id column + indexes exist (idempotent; handles pre-migration DBs).
    this.#migrateAppIdColumn();

    this.#selectTask = this.#db.prepare(
      "SELECT * FROM delivery_tasks WHERE id = ?",
    );
    // All tasks for one message, oldest-first (rowid order) — the delivery-status
    // read. Backed by idx_delivery_tasks_message so it stays cheap as the table
    // grows unbounded (terminal tasks are never pruned).
    this.#selectByMessage = this.#db.prepare(
      "SELECT * FROM delivery_tasks WHERE message_id = ? ORDER BY rowid",
    );
    // All tasks for one endpoint, newest-first — the endpoint history view.
    // Backed by idx_delivery_tasks_endpoint_created (endpoint_id, created_at, id).
    this.#selectByEndpoint = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE endpoint_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    // Continuation page: keyset predicate advances past (cursorCreatedAt, cursorId).
    this.#selectByEndpointAfter = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE endpoint_id = ?
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    // Status-filtered endpoint listing — backed by idx_delivery_tasks_endpoint_status_created.
    this.#selectByEndpointFiltered = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE endpoint_id = ? AND status = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    this.#selectByEndpointFilteredAfter = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE endpoint_id = ? AND status = ?
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    // App-wide listing, newest-first — backed by idx_delivery_tasks_app.
    this.#selectByApp = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE app_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    this.#selectByAppAfter = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE app_id = ?
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    // Status-filtered app listing — backed by idx_delivery_tasks_app_status.
    this.#selectByAppFiltered = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE app_id = ? AND status = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    this.#selectByAppFilteredAfter = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE app_id = ? AND status = ?
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    // Claimable = due pending OR delivering with a lapsed lease. rowid order
    // claims oldest-first; the partial-ish index keeps the scan cheap.
    this.#selectClaimable = this.#db.prepare(
      `SELECT * FROM delivery_tasks
       WHERE (status = 'pending'
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'delivering'
              AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       ORDER BY rowid
       LIMIT ?`,
    );
    this.#insertTask = this.#db.prepare(
      `INSERT INTO delivery_tasks
         (id, message_id, endpoint_id, app_id, status, attempts, next_attempt_at,
          lease_expires_at, lease_token, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#updateTask = this.#db.prepare(
      `UPDATE delivery_tasks
         SET status = ?, attempts = ?, next_attempt_at = ?,
             lease_expires_at = ?, lease_token = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.#countTasks = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM delivery_tasks",
    );
    // Backlog/health gauge: a single grouped scan, far cheaper than four counts.
    this.#countByStatus = this.#db.prepare(
      "SELECT status, COUNT(*) AS n FROM delivery_tasks GROUP BY status",
    );
  }

  /**
   * Ensure the `app_id` column and its per-tenant indexes exist. A database
   * created by a pre-app-listing build has the column missing (its
   * `CREATE TABLE IF NOT EXISTS` was a no-op); add it nullable so the upgrade is
   * seamless. Existing rows keep `app_id = NULL` — they predate per-tenant
   * delivery listing and are simply excluded from `listByApp` (honest: the
   * attribution data was never recorded). For a fresh database the column is
   * already in {@link SCHEMA} and the ALTER is skipped.
   *
   * The companion indexes are created unconditionally and idempotently *after*
   * the column is guaranteed to exist — they reference `app_id`, so they must
   * come after any ALTER, not inside SCHEMA.
   */
  #migrateAppIdColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(delivery_tasks)").all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "app_id")) {
      this.#db.exec("ALTER TABLE delivery_tasks ADD COLUMN app_id TEXT");
    }
    // Unfiltered app listing: (app_id, created_at, id) — drives ORDER BY without a sort.
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS idx_delivery_tasks_app" +
        " ON delivery_tasks (app_id, created_at, id)" +
        " WHERE app_id IS NOT NULL",
    );
    // Status-filtered listing: (app_id, status, created_at, id) — covers WHERE app_id = ? AND status = ?.
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS idx_delivery_tasks_app_status" +
        " ON delivery_tasks (app_id, status, created_at, id)" +
        " WHERE app_id IS NOT NULL",
    );
  }

  /** Number of tasks currently held (terminal ones are never pruned). */
  get size(): number {
    return Number((this.#countTasks.get() as { n: number }).n);
  }

  async enqueue(input: EnqueueInput): Promise<DeliveryTask> {
    const { messageId, endpointId, appId, availableAt } = normalizeEnqueueInput(input);
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
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    // The PRIMARY KEY enforces id uniqueness; a collision surfaces as a throw.
    this.#insertTask.run(
      task.id,
      task.messageId,
      task.endpointId,
      task.appId,
      task.status,
      task.attempts,
      task.nextAttemptAt,
      task.leaseExpiresAt,
      task.leaseToken,
      task.lastError,
      task.createdAt,
      task.updatedAt,
    );
    return task;
  }

  async claimDue(options: ClaimOptions): Promise<readonly DeliveryTask[]> {
    const { nowMs, limit } = normalizeClaimOptions(options);
    return this.#transaction(() => {
      const rows = this.#selectClaimable.all(
        nowMs,
        nowMs,
        limit,
      ) as unknown as TaskRow[];
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
        this.#persist(leased);
        claimed.push(leased);
      }
      return claimed;
    });
  }

  async complete(taskId: string, leaseToken: string): Promise<DeliveryTask> {
    return this.#transaction(() => {
      const task = this.#requireLeaseHolder(taskId, leaseToken);
      const next = applySuccess(this.#policy, task, this.#now(), this.#jitter);
      this.#persist(next);
      return next;
    });
  }

  async fail(
    taskId: string,
    leaseToken: string,
    input: FailInput,
  ): Promise<DeliveryTask> {
    const { error, nowMs, minDelayMs, retryPolicy } = normalizeFailInput(input);
    return this.#transaction(() => {
      const task = this.#requireLeaseHolder(taskId, leaseToken);
      let next = applyFailure(retryPolicy ?? this.#policy, task, error, nowMs, this.#jitter);
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
      this.#persist(next);
      return next;
    });
  }

  async retry(taskId: string): Promise<DeliveryTask> {
    return this.#transaction(() => {
      const row = this.#selectTask.get(taskId) as TaskRow | undefined;
      if (row === undefined) {
        throw new UnknownDeliveryTaskError(taskId);
      }
      // applyManualRetry throws DeliveryStateError on a non-terminal task; the
      // transaction then rolls back and re-throws, leaving the row untouched.
      const next = applyManualRetry(this.#policy, rowToTask(row), this.#now());
      this.#persist(next);
      return next;
    });
  }

  async cancel(taskId: string): Promise<DeliveryTask> {
    return this.#transaction(() => {
      const row = this.#selectTask.get(taskId) as TaskRow | undefined;
      if (row === undefined) {
        throw new UnknownDeliveryTaskError(taskId);
      }
      // applyCancel throws DeliveryStateError if the task is not pending.
      const next = applyCancel(rowToTask(row), this.#now());
      this.#persist(next);
      return next;
    });
  }

  async get(taskId: string): Promise<DeliveryTask | null> {
    const row = this.#selectTask.get(taskId) as TaskRow | undefined;
    return row === undefined ? null : rowToTask(row);
  }

  async listByMessage(messageId: string): Promise<readonly DeliveryTask[]> {
    const rows = this.#selectByMessage.all(messageId) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  async listByEndpoint(
    endpointId: string,
    options?: ListByEndpointOptions,
  ): Promise<DeliveryPage> {
    const { limit, cursor } = resolveListDeliveriesQuery(options);
    const status = options?.status ?? null;
    // Fetch one extra to detect whether a further page exists.
    const fetchLimit = limit + 1;
    let rows: unknown[];
    if (status === null) {
      rows =
        cursor === null
          ? this.#selectByEndpoint.all(endpointId, fetchLimit)
          : this.#selectByEndpointAfter.all(
              endpointId,
              cursor.createdAt,
              cursor.createdAt,
              cursor.id,
              fetchLimit,
            );
    } else {
      rows =
        cursor === null
          ? this.#selectByEndpointFiltered.all(endpointId, status, fetchLimit)
          : this.#selectByEndpointFilteredAfter.all(
              endpointId,
              status,
              cursor.createdAt,
              cursor.createdAt,
              cursor.id,
              fetchLimit,
            );
    }
    const hasMore = rows.length > limit;
    const deliveries = (rows as unknown as TaskRow[]).slice(0, limit).map(rowToTask);
    const last = deliveries[deliveries.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeDeliveryCursor(last) : null;
    return { deliveries, nextCursor };
  }

  async listByApp(appId: string, options?: ListByAppOptions): Promise<DeliveryPage> {
    const { limit, cursor } = resolveListDeliveriesQuery(options);
    const status = options?.status ?? null;
    // Fetch one extra to detect whether a further page exists.
    const fetchLimit = limit + 1;
    let rows: unknown[];
    if (status === null) {
      rows =
        cursor === null
          ? this.#selectByApp.all(appId, fetchLimit)
          : this.#selectByAppAfter.all(
              appId,
              cursor.createdAt,
              cursor.createdAt,
              cursor.id,
              fetchLimit,
            );
    } else {
      rows =
        cursor === null
          ? this.#selectByAppFiltered.all(appId, status, fetchLimit)
          : this.#selectByAppFilteredAfter.all(
              appId,
              status,
              cursor.createdAt,
              cursor.createdAt,
              cursor.id,
              fetchLimit,
            );
    }
    const hasMore = rows.length > limit;
    const deliveries = (rows as unknown as TaskRow[]).slice(0, limit).map(rowToTask);
    const last = deliveries[deliveries.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeDeliveryCursor(last) : null;
    return { deliveries, nextCursor };
  }

  async pruneTerminalTasks(olderThanMs: number): Promise<number> {
    const result = this.#db
      .prepare(
        "DELETE FROM delivery_tasks WHERE updated_at < ? AND status IN ('succeeded', 'dead_letter', 'cancelled')",
      )
      .run(olderThanMs);
    return Number(result.changes);
  }

  async countByStatus(): Promise<DeliveryCountsByStatus> {
    const counts = zeroDeliveryCounts();
    const rows = this.#countByStatus.all() as unknown as {
      status: string;
      n: number;
    }[];
    for (const row of rows) {
      // Defensive: ignore any unrecognized status rather than widening the map.
      if (row.status in counts) {
        counts[row.status as DeliveryStatus] += Number(row.n);
      }
    }
    return counts;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.#db.close();
  }

  /** Write a task's mutable fields back to its row. */
  #persist(task: DeliveryTask): void {
    this.#updateTask.run(
      task.status,
      task.attempts,
      task.nextAttemptAt,
      task.leaseExpiresAt,
      task.leaseToken,
      task.lastError,
      task.updatedAt,
      task.id,
    );
  }

  /** Resolve the task and assert the caller holds its live lease. */
  #requireLeaseHolder(taskId: string, leaseToken: string): DeliveryTask {
    const row = this.#selectTask.get(taskId) as TaskRow | undefined;
    if (row === undefined) {
      throw new UnknownDeliveryTaskError(taskId);
    }
    const task = rowToTask(row);
    if (task.status !== "delivering" || task.leaseToken !== leaseToken) {
      throw new StaleLeaseError(taskId);
    }
    return task;
  }

  /** Run `fn` inside a `BEGIN IMMEDIATE` transaction (atomic across connections). */
  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Transaction already resolved/aborted; surface the original error.
      }
      throw err;
    }
  }
}

/**
 * `STRICT` enforces declared column types; `IF NOT EXISTS` lets a restart
 * reattach to an existing database unchanged (crash-safe replay). The index
 * backs the `claimDue` scan. Tasks are never deleted — terminal ones simply stop
 * matching the claimable predicate (Axiom 3 in spirit: every attempt is kept).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_tasks (
  id               TEXT    PRIMARY KEY,
  message_id       TEXT    NOT NULL,
  endpoint_id      TEXT,
  app_id           TEXT,
  status           TEXT    NOT NULL,
  attempts         INTEGER NOT NULL,
  next_attempt_at  INTEGER,
  lease_expires_at INTEGER,
  lease_token      TEXT,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_delivery_tasks_claimable
  ON delivery_tasks (status, next_attempt_at, lease_expires_at);

-- Backs listByMessage (the delivery-status read). IF NOT EXISTS means an
-- existing pre-index database gains it automatically on the next open — no
-- migration step needed, since it is a pure read optimization over existing rows.
CREATE INDEX IF NOT EXISTS idx_delivery_tasks_message
  ON delivery_tasks (message_id);

-- Backs listByEndpoint (endpoint delivery history, newest-first).
-- Partial index (WHERE endpoint_id IS NOT NULL) keeps it focused on fan-out tasks.
CREATE INDEX IF NOT EXISTS idx_delivery_tasks_endpoint_created
  ON delivery_tasks (endpoint_id, created_at, id)
  WHERE endpoint_id IS NOT NULL;

-- Backs listByEndpoint with a status filter (e.g. dead_letter bulk-retry).
CREATE INDEX IF NOT EXISTS idx_delivery_tasks_endpoint_status_created
  ON delivery_tasks (endpoint_id, status, created_at, id)
  WHERE endpoint_id IS NOT NULL;
`;
