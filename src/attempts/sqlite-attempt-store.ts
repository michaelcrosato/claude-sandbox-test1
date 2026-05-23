/**
 * A durable {@link DeliveryAttemptStore} backed by SQLite via Node's built-in
 * `node:sqlite` module — **zero third-party dependencies, no native compile step**.
 * It is the durable sibling of {@link InMemoryDeliveryAttemptStore}, held to the
 * exact same contract: the two pass one shared conformance suite, so the audit log
 * survives a restart without changing how it reads.
 *
 * The table is append-only (one `INSERT` per attempt, no `UPDATE`/`DELETE`), so it
 * grows with delivery volume. That is the point of an audit log — every attempt is
 * kept (Axiom 3 in spirit) — and it is why this lives apart from the queue: the
 * scheduler's hot path never scans it. A future tick can prune/tier it by age
 * without touching delivery correctness.
 */

import { createRequire } from "node:module";
import type {
  DatabaseSync as SqliteDatabase,
  StatementSync,
} from "node:sqlite";
import {
  createAttemptId,
  normalizeNewAttempt,
  type DeliveryAttempt,
  type DeliveryAttemptOutcome,
  type DeliveryAttemptStore,
  type NewDeliveryAttempt,
} from "./delivery-attempt.js";

// Loaded through createRequire rather than a static `import ... from
// "node:sqlite"`: it is a genuine Node builtin, but bundlers whose builtin lists
// predate it (e.g. Vite 5, our test runner) choke on the static specifier.
// Requiring it keeps it a runtime builtin lookup. (See sqlite-store/sqlite-queue.)
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** Construction options for {@link SqliteDeliveryAttemptStore}. */
export interface SqliteDeliveryAttemptStoreOptions {
  /**
   * Where to store the database: a filesystem path for durability, or
   * `":memory:"` (the default) for an ephemeral, process-lifetime log.
   */
  location?: string;
  /** Attempt-id generator. Defaults to {@link createAttemptId}. */
  generateId?: () => string;
}

/** Shape of a row from the `delivery_attempts` table. */
interface AttemptRow {
  readonly id: string;
  readonly task_id: string;
  readonly message_id: string;
  readonly endpoint_id: string | null;
  readonly attempt_number: number;
  readonly outcome: string;
  readonly response_status: number | null;
  readonly error: string | null;
  readonly duration_ms: number;
  readonly attempted_at: number;
}

function rowToAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    messageId: row.message_id,
    endpointId: row.endpoint_id,
    attemptNumber: Number(row.attempt_number),
    outcome: row.outcome as DeliveryAttemptOutcome,
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    error: row.error,
    durationMs: Number(row.duration_ms),
    attemptedAt: Number(row.attempted_at),
  };
}

export class SqliteDeliveryAttemptStore implements DeliveryAttemptStore {
  readonly #db: SqliteDatabase;
  readonly #generateId: () => string;

  // Prepared once at construction, reused per call.
  readonly #insert: StatementSync;
  readonly #selectByMessage: StatementSync;
  readonly #countAll: StatementSync;

  constructor(options: SqliteDeliveryAttemptStoreOptions = {}) {
    const { location = ":memory:", generateId = createAttemptId } = options;
    this.#generateId = generateId;

    this.#db = new DatabaseSync(location);
    // WAL gives crash-safe, concurrent-reader durability for file-backed logs
    // (a no-op for `:memory:`).
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(SCHEMA);

    this.#insert = this.#db.prepare(
      `INSERT INTO delivery_attempts
         (id, task_id, message_id, endpoint_id, attempt_number, outcome,
          response_status, error, duration_ms, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // All attempts for one message, oldest-first (rowid = record order). Backed by
    // idx_delivery_attempts_message so it stays cheap as the log grows unbounded.
    this.#selectByMessage = this.#db.prepare(
      "SELECT * FROM delivery_attempts WHERE message_id = ? ORDER BY rowid",
    );
    this.#countAll = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM delivery_attempts",
    );
  }

  /** Number of attempts recorded (append-only — never decreases). */
  get size(): number {
    return Number((this.#countAll.get() as { n: number }).n);
  }

  async record(input: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    const n = normalizeNewAttempt(input);
    const id = this.#generateId();
    // The PRIMARY KEY enforces id uniqueness; a collision surfaces as a throw.
    this.#insert.run(
      id,
      n.taskId,
      n.messageId,
      n.endpointId,
      n.attemptNumber,
      n.outcome,
      n.responseStatus,
      n.error,
      n.durationMs,
      n.attemptedAt,
    );
    return { id, ...n };
  }

  async listByMessage(messageId: string): Promise<readonly DeliveryAttempt[]> {
    const rows = this.#selectByMessage.all(messageId) as unknown as AttemptRow[];
    return rows.map(rowToAttempt);
  }

  /** Close the underlying database handle. */
  close(): void {
    this.#db.close();
  }
}

/**
 * `STRICT` enforces declared column types; `IF NOT EXISTS` lets a restart reattach
 * to an existing database unchanged. The index backs the per-message read. Rows are
 * never updated or deleted — the log is append-only (Axiom 3 in spirit).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id              TEXT    PRIMARY KEY,
  task_id         TEXT    NOT NULL,
  message_id      TEXT    NOT NULL,
  endpoint_id     TEXT,
  attempt_number  INTEGER NOT NULL,
  outcome         TEXT    NOT NULL,
  response_status INTEGER,
  error           TEXT,
  duration_ms     INTEGER NOT NULL,
  attempted_at    INTEGER NOT NULL
) STRICT;

-- Backs listByMessage (the per-message attempt history): the index narrows to one
-- message, then ORDER BY rowid yields the rows oldest-first (record order). Keeps
-- the read cheap as the log grows unbounded.
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_message
  ON delivery_attempts (message_id);
`;
