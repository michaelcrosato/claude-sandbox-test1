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
  type AttemptUsageDay,
  type AttemptUsageSummary,
  type DeliveryAttempt,
  type DeliveryAttemptOutcome,
  type DeliveryAttemptStore,
  type NewDeliveryAttempt,
} from "./delivery-attempt.js";
import {
  resolveUsageRange,
  type UsageRange,
} from "../storage/message-store.js";

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
  readonly app_id: string | null;
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
    appId: row.app_id,
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
  readonly #summarizeByApp: StatementSync;

  constructor(options: SqliteDeliveryAttemptStoreOptions = {}) {
    const { location = ":memory:", generateId = createAttemptId } = options;
    this.#generateId = generateId;

    this.#db = new DatabaseSync(location);
    // WAL gives crash-safe, concurrent-reader durability for file-backed logs
    // (a no-op for `:memory:`).
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(SCHEMA);
    this.#migrateAppIdColumn();

    this.#insert = this.#db.prepare(
      `INSERT INTO delivery_attempts
         (id, task_id, message_id, app_id, endpoint_id, attempt_number, outcome,
          response_status, error, duration_ms, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // All attempts for one message, oldest-first (rowid = record order). Backed by
    // idx_delivery_attempts_message so it stays cheap as the log grows unbounded.
    this.#selectByMessage = this.#db.prepare(
      "SELECT * FROM delivery_attempts WHERE message_id = ? ORDER BY rowid",
    );
    this.#countAll = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM delivery_attempts",
    );
    // Per-tenant delivery-attempt usage grouped by UTC day, split by outcome. Integer
    // division `attempted_at / 1000` yields epoch seconds (attempted_at is INTEGER ms);
    // `date(…, 'unixepoch')` renders the UTC `YYYY-MM-DD`, mirroring the shared utcDayKey
    // rule. `app_id = ?` excludes NULL-tenant rows (a vanished message) — SQL NULL never
    // equals a value — matching the in-memory `=== appId`. The half-open [from, to) range
    // rides idx_delivery_attempts_app (app_id, attempted_at).
    this.#summarizeByApp = this.#db.prepare(
      "SELECT date(attempted_at / 1000, 'unixepoch') AS day, COUNT(*) AS n," +
        " SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) AS ok," +
        " SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS bad" +
        " FROM delivery_attempts" +
        " WHERE app_id = ? AND attempted_at >= ? AND attempted_at < ?" +
        " GROUP BY day ORDER BY day ASC",
    );
  }

  /**
   * Ensure the `app_id` column and its per-tenant index exist. A database created by a
   * pre-tenant-usage build has the column missing (its `CREATE TABLE IF NOT EXISTS` was
   * a no-op on the existing table); add it nullable so the upgrade is seamless. Existing
   * rows keep `app_id = NULL` — they predate per-tenant delivery metering and are simply
   * never counted in a per-tenant summary (honest: the data to attribute them was never
   * recorded). For a fresh database the column is already in {@link SCHEMA} and the ALTER
   * is skipped.
   *
   * The companion `(app_id, attempted_at)` index is deliberately **not** in {@link SCHEMA}
   * and is created here, unconditionally and idempotently, *after* the column is
   * guaranteed to exist — because on a pre-existing table SCHEMA runs before this ALTER,
   * so an index DDL there would reference a not-yet-existing column and fail.
   */
  #migrateAppIdColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(delivery_attempts)").all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "app_id")) {
      this.#db.exec("ALTER TABLE delivery_attempts ADD COLUMN app_id TEXT");
    }
    // app_id now exists (fresh: from SCHEMA; upgraded: from the ALTER above), so the
    // per-tenant range-scan index can be created safely on both paths.
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS idx_delivery_attempts_app" +
        " ON delivery_attempts (app_id, attempted_at)",
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
      n.appId,
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

  async summarizeAttemptsByApp(
    appId: string,
    range: UsageRange,
  ): Promise<AttemptUsageSummary> {
    const { fromMs, toMs } = resolveUsageRange(range);
    const rows = this.#summarizeByApp.all(appId, fromMs, toMs) as unknown as {
      day: string;
      n: number;
      ok: number;
      bad: number;
    }[];
    let total = 0;
    let succeeded = 0;
    let failed = 0;
    const daily: AttemptUsageDay[] = rows.map((row) => {
      const attempts = Number(row.n);
      const ok = Number(row.ok);
      const bad = Number(row.bad);
      total += attempts;
      succeeded += ok;
      failed += bad;
      return { date: row.day, attempts, succeeded: ok, failed: bad };
    });
    return { appId, fromMs, toMs, total, succeeded, failed, daily };
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
  app_id          TEXT,
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

-- The (app_id, attempted_at) index that backs the per-tenant usage range scan is
-- created in #migrateAppIdColumn, not here: on a pre-tenant-usage database this SCHEMA
-- runs before the app_id column is added, so an index DDL referencing it would fail.
`;
