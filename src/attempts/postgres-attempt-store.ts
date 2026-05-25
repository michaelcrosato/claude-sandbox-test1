/**
 * A durable {@link DeliveryAttemptStore} backed by PostgreSQL.
 *
 * Horizontally-scalable sibling of {@link SqliteDeliveryAttemptStore}. The
 * audit log is append-only (INSERT only, no UPDATE/DELETE), so concurrent
 * writers never conflict. Holds to the same behavioural contract and passes
 * the same conformance suite.
 */

import type { Pool } from "pg";
import {
  createAttemptId,
  encodeAttemptCursor,
  normalizeNewAttempt,
  resolveListAttemptsQuery,
  type AttemptPage,
  type AttemptUsageDay,
  type AttemptUsageSummary,
  type DeliveryAttempt,
  type DeliveryAttemptOutcome,
  type DeliveryAttemptStore,
  type EndpointStats,
  type EndpointStatsDay,
  type ListAttemptsOptions,
  type NewDeliveryAttempt,
} from "./delivery-attempt.js";
import type { DeliveryFailureReason } from "../delivery/failure-reason.js";
import {
  resolveUsageRange,
  type UsageRange,
} from "../storage/message-store.js";

export interface PostgresAttemptStoreOptions {
  generateId?: () => string;
}

interface AttemptRow {
  readonly id: string;
  readonly task_id: string;
  readonly message_id: string;
  readonly app_id: string | null;
  readonly endpoint_id: string | null;
  readonly attempt_number: string; // BIGINT as string
  readonly outcome: string;
  readonly response_status: string | null; // BIGINT as string
  readonly error: string | null;
  readonly failure_reason: string | null;
  readonly request_body: string | null;
  readonly response_body: string | null;
  readonly duration_ms: string; // BIGINT as string
  readonly attempted_at: string; // BIGINT as string
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
    failureReason: row.failure_reason as DeliveryFailureReason | null,
    requestBody: row.request_body,
    responseBody: row.response_body,
    durationMs: Number(row.duration_ms),
    attemptedAt: Number(row.attempted_at),
  };
}

export class PostgresDeliveryAttemptStore implements DeliveryAttemptStore {
  readonly #pool: Pool;
  readonly #generateId: () => string;

  constructor(pool: Pool, options: PostgresAttemptStoreOptions = {}) {
    const { generateId = createAttemptId } = options;
    this.#pool = pool;
    this.#generateId = generateId;
  }

  async initialize(): Promise<void> {
    await this.#pool.query(SCHEMA);
    await this.#pool.query(INDEXES);
  }

  async truncate(): Promise<void> {
    await this.#pool.query(
      "TRUNCATE TABLE delivery_attempts RESTART IDENTITY CASCADE",
    );
  }

  close(): void {}

  async record(input: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    const n = normalizeNewAttempt(input);
    const id = this.#generateId();
    await this.#pool.query(
      "INSERT INTO delivery_attempts" +
        " (id, task_id, message_id, app_id, endpoint_id, attempt_number, outcome," +
        "  response_status, error, failure_reason, request_body, response_body," +
        "  duration_ms, attempted_at)" +
        " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [
        id, n.taskId, n.messageId, n.appId, n.endpointId,
        n.attemptNumber, n.outcome, n.responseStatus, n.error, n.failureReason,
        n.requestBody, n.responseBody, n.durationMs, n.attemptedAt,
      ],
    );
    return { id, ...n };
  }

  async listByMessage(messageId: string, options: ListAttemptsOptions = {}): Promise<AttemptPage> {
    const { limit, cursor } = resolveListAttemptsQuery(options);
    const fetchLimit = limit + 1;
    let rows: AttemptRow[];
    if (cursor === null) {
      ({ rows } = await this.#pool.query<AttemptRow>(
        "SELECT * FROM delivery_attempts WHERE message_id = $1" +
          " ORDER BY attempted_at ASC, id ASC LIMIT $2",
        [messageId, fetchLimit],
      ));
    } else {
      ({ rows } = await this.#pool.query<AttemptRow>(
        "SELECT * FROM delivery_attempts WHERE message_id = $1" +
          " AND (attempted_at > $2 OR (attempted_at = $3 AND id > $4))" +
          " ORDER BY attempted_at ASC, id ASC LIMIT $5",
        [messageId, cursor.attemptedAt, cursor.attemptedAt, cursor.id, fetchLimit],
      ));
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(rowToAttempt);
    const last = page[page.length - 1];
    return {
      data: page,
      nextCursor:
        hasMore && last !== undefined
          ? encodeAttemptCursor({ attemptedAt: last.attemptedAt, id: last.id })
          : null,
    };
  }

  async listByTask(taskId: string, options: ListAttemptsOptions = {}): Promise<AttemptPage> {
    const { limit, cursor } = resolveListAttemptsQuery(options);
    const fetchLimit = limit + 1;
    let rows: AttemptRow[];
    if (cursor === null) {
      ({ rows } = await this.#pool.query<AttemptRow>(
        "SELECT * FROM delivery_attempts WHERE task_id = $1" +
          " ORDER BY attempted_at ASC, id ASC LIMIT $2",
        [taskId, fetchLimit],
      ));
    } else {
      ({ rows } = await this.#pool.query<AttemptRow>(
        "SELECT * FROM delivery_attempts WHERE task_id = $1" +
          " AND (attempted_at > $2 OR (attempted_at = $3 AND id > $4))" +
          " ORDER BY attempted_at ASC, id ASC LIMIT $5",
        [taskId, cursor.attemptedAt, cursor.attemptedAt, cursor.id, fetchLimit],
      ));
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(rowToAttempt);
    const last = page[page.length - 1];
    return {
      data: page,
      nextCursor:
        hasMore && last !== undefined
          ? encodeAttemptCursor({ attemptedAt: last.attemptedAt, id: last.id })
          : null,
    };
  }

  async summarizeAttemptsByApp(
    appId: string,
    range: UsageRange,
  ): Promise<AttemptUsageSummary> {
    const { fromMs, toMs } = resolveUsageRange(range);
    const { rows } = await this.#pool.query<{
      day: string;
      n: string;
      ok: string;
      bad: string;
    }>(
      "SELECT TO_CHAR(TO_TIMESTAMP(attempted_at / 1000.0), 'YYYY-MM-DD') AS day," +
        " COUNT(*) AS n," +
        " SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) AS ok," +
        " SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS bad" +
        " FROM delivery_attempts" +
        " WHERE app_id = $1 AND attempted_at >= $2 AND attempted_at < $3" +
        " GROUP BY day ORDER BY day ASC",
      [appId, fromMs, toMs],
    );
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

  async pruneOldAttempts(olderThanMs: number): Promise<number> {
    const result = await this.#pool.query(
      "DELETE FROM delivery_attempts WHERE attempted_at < $1",
      [olderThanMs],
    );
    return result.rowCount ?? 0;
  }

  async statsByEndpoint(endpointId: string, range: UsageRange): Promise<EndpointStats> {
    const { fromMs, toMs } = resolveUsageRange(range);
    const { rows } = await this.#pool.query<{
      day: string;
      n: string;
      ok: string;
      bad: string;
      total_dur: string;
    }>(
      "SELECT TO_CHAR(TO_TIMESTAMP(attempted_at / 1000.0), 'YYYY-MM-DD') AS day," +
        " COUNT(*) AS n," +
        " SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) AS ok," +
        " SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS bad," +
        " SUM(duration_ms) AS total_dur" +
        " FROM delivery_attempts" +
        " WHERE endpoint_id = $1 AND attempted_at >= $2 AND attempted_at < $3" +
        " GROUP BY day ORDER BY day ASC",
      [endpointId, fromMs, toMs],
    );
    let total = 0;
    let succeeded = 0;
    let failed = 0;
    let totalDurationMs = 0;
    const daily: EndpointStatsDay[] = rows.map((row) => {
      const attempts = Number(row.n);
      const ok = Number(row.ok);
      const bad = Number(row.bad);
      total += attempts;
      succeeded += ok;
      failed += bad;
      totalDurationMs += Number(row.total_dur);
      return { date: row.day, attempts, succeeded: ok, failed: bad };
    });
    return {
      endpointId,
      fromMs,
      toMs,
      total,
      succeeded,
      failed,
      successRate: total > 0 ? Math.round((succeeded / total) * 10_000) / 10_000 : null,
      avgDurationMs: total > 0 ? Math.round(totalDurationMs / total) : null,
      daily,
    };
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id              TEXT   PRIMARY KEY,
  task_id         TEXT   NOT NULL,
  message_id      TEXT   NOT NULL,
  app_id          TEXT,
  endpoint_id     TEXT,
  attempt_number  BIGINT NOT NULL,
  outcome         TEXT   NOT NULL,
  response_status BIGINT,
  error           TEXT,
  failure_reason  TEXT,
  request_body    TEXT,
  response_body   TEXT,
  duration_ms     BIGINT NOT NULL,
  attempted_at    BIGINT NOT NULL
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_message_paged
  ON delivery_attempts (message_id, attempted_at, id);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_task_paged
  ON delivery_attempts (task_id, attempted_at, id);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_app
  ON delivery_attempts (app_id, attempted_at)
  WHERE app_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_endpoint
  ON delivery_attempts (endpoint_id, attempted_at)
  WHERE endpoint_id IS NOT NULL;
`;
