/**
 * A durable {@link EndpointStore} backed by PostgreSQL.
 *
 * Horizontally-scalable sibling of {@link SqliteEndpointStore}. Multiple
 * Posthorn workers read/write endpoints from the same Postgres database without
 * any in-process state. Holds to the same behavioural contract and passes the
 * same conformance suite.
 */

import type { Pool, PoolClient } from "pg";
import { generateSecret } from "../signing/webhook-signature.js";
import {
  applyEndpointUpdate,
  createEndpointId,
  evaluateEndpointHealth,
  normalizeNewEndpoint,
  rotateEndpointSecret,
  UnknownEndpointError,
  type DeliveryHealthOutcome,
  type Endpoint,
  type EndpointFilter,
  type EndpointOutcomeResult,
  type EndpointStore,
  type EndpointUpdate,
  type ExpiringSecret,
  type NewEndpoint,
  type RotateSecretOptions,
} from "./endpoint.js";
import type { RetryPolicy } from "../delivery/retry-policy.js";

export interface PostgresEndpointStoreOptions {
  now?: () => number;
  generateId?: () => string;
  generateSecret?: () => string;
}

interface EndpointRow {
  readonly id: string;
  readonly app_id: string;
  readonly url: string;
  readonly secret: string;
  readonly previous_secrets: string;
  readonly description: string;
  readonly event_types: string | null;
  readonly headers: string | null;
  readonly retry_policy: string | null;
  readonly filter: string | null;
  readonly channel: string | null;
  readonly rate_limit: number | null;
  readonly disabled: boolean;
  readonly consecutive_failures: string; // BIGINT as string
  readonly first_failure_at: string | null;
  readonly last_failure_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToEndpoint(row: EndpointRow): Endpoint {
  return {
    id: row.id,
    appId: row.app_id,
    url: row.url,
    secret: row.secret,
    previousSecrets: JSON.parse(row.previous_secrets) as ExpiringSecret[],
    description: row.description,
    eventTypes: row.event_types === null ? null : (JSON.parse(row.event_types) as string[]),
    headers: row.headers === null ? null : (JSON.parse(row.headers) as Record<string, string>),
    retryPolicy: row.retry_policy === null ? null : (JSON.parse(row.retry_policy) as RetryPolicy),
    filter: row.filter === null ? null : (JSON.parse(row.filter) as EndpointFilter),
    channel: row.channel ?? null,
    rateLimit: row.rate_limit ?? null,
    disabled: row.disabled,
    consecutiveFailures: Number(row.consecutive_failures),
    firstFailureAt: row.first_failure_at === null ? null : Number(row.first_failure_at),
    lastFailureAt: row.last_failure_at === null ? null : Number(row.last_failure_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PostgresEndpointStore implements EndpointStore {
  readonly #pool: Pool;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #generateSecret: () => string;

  constructor(pool: Pool, options: PostgresEndpointStoreOptions = {}) {
    const {
      now = Date.now,
      generateId = createEndpointId,
      generateSecret: makeSecret = generateSecret,
    } = options;
    this.#pool = pool;
    this.#now = now;
    this.#generateId = generateId;
    this.#generateSecret = makeSecret;
  }

  async initialize(): Promise<void> {
    await this.#pool.query(SCHEMA);
  }

  async truncate(): Promise<void> {
    await this.#pool.query(
      "TRUNCATE TABLE endpoints RESTART IDENTITY CASCADE",
    );
  }

  close(): void {}

  async create(input: NewEndpoint): Promise<Endpoint> {
    const normalized = normalizeNewEndpoint(input);
    const nowMs = this.#now();
    const id = this.#generateId();
    const endpoint: Endpoint = {
      id,
      appId: normalized.appId,
      url: normalized.url,
      secret: normalized.secret ?? this.#generateSecret(),
      previousSecrets: [],
      description: normalized.description,
      eventTypes: normalized.eventTypes,
      headers: normalized.headers,
      retryPolicy: normalized.retryPolicy,
      filter: normalized.filter,
      channel: normalized.channel,
      rateLimit: normalized.rateLimit,
      disabled: normalized.disabled,
      consecutiveFailures: 0,
      firstFailureAt: null,
      lastFailureAt: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    await this.#pool.query(
      "INSERT INTO endpoints (id, app_id, url, secret, previous_secrets, description," +
        " event_types, headers, retry_policy, filter, channel, rate_limit, disabled, consecutive_failures," +
        " first_failure_at, last_failure_at, created_at, updated_at)" +
        " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
      [
        endpoint.id, endpoint.appId, endpoint.url, endpoint.secret,
        JSON.stringify(endpoint.previousSecrets), endpoint.description,
        endpoint.eventTypes !== null ? JSON.stringify(endpoint.eventTypes) : null,
        endpoint.headers !== null ? JSON.stringify(endpoint.headers) : null,
        endpoint.retryPolicy !== null ? JSON.stringify(endpoint.retryPolicy) : null,
        endpoint.filter !== null ? JSON.stringify(endpoint.filter) : null,
        endpoint.channel,
        endpoint.rateLimit,
        endpoint.disabled,
        endpoint.consecutiveFailures, endpoint.firstFailureAt, endpoint.lastFailureAt,
        endpoint.createdAt, endpoint.updatedAt,
      ],
    );
    return endpoint;
  }

  async get(id: string): Promise<Endpoint | null> {
    const { rows } = await this.#pool.query<EndpointRow>(
      "SELECT * FROM endpoints WHERE id = $1",
      [id],
    );
    const row = rows[0];
    return row !== undefined ? rowToEndpoint(row) : null;
  }

  async listByApp(appId: string): Promise<readonly Endpoint[]> {
    const { rows } = await this.#pool.query<EndpointRow>(
      "SELECT * FROM endpoints WHERE app_id = $1 ORDER BY created_at ASC, id ASC",
      [appId],
    );
    return rows.map(rowToEndpoint);
  }

  async update(id: string, patch: EndpointUpdate): Promise<Endpoint> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const endpoint = await this.#getForUpdate(client, id);
      const next = applyEndpointUpdate(endpoint, patch, this.#now());
      await client.query(
        "UPDATE endpoints SET url=$1, secret=$2, description=$3, event_types=$4, headers=$5," +
          " retry_policy=$6, filter=$7, channel=$8, rate_limit=$9, disabled=$10, consecutive_failures=$11," +
          " first_failure_at=$12, last_failure_at=$13, updated_at=$14 WHERE id=$15",
        [
          next.url, next.secret, next.description,
          next.eventTypes !== null ? JSON.stringify(next.eventTypes) : null,
          next.headers !== null ? JSON.stringify(next.headers) : null,
          next.retryPolicy !== null ? JSON.stringify(next.retryPolicy) : null,
          next.filter !== null ? JSON.stringify(next.filter) : null,
          next.channel,
          next.rateLimit,
          next.disabled, next.consecutiveFailures, next.firstFailureAt, next.lastFailureAt,
          next.updatedAt, next.id,
        ],
      );
      await client.query("COMMIT");
      return next;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async rotateSecret(id: string, options: RotateSecretOptions = {}): Promise<Endpoint> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const endpoint = await this.#getForUpdate(client, id);
      const newSecret = options.secret ?? this.#generateSecret();
      const next = rotateEndpointSecret(endpoint, newSecret, this.#now(), options.overlapMs);
      await client.query(
        "UPDATE endpoints SET secret=$1, previous_secrets=$2, updated_at=$3 WHERE id=$4",
        [next.secret, JSON.stringify(next.previousSecrets), next.updatedAt, next.id],
      );
      await client.query("COMMIT");
      return next;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async recordDeliveryOutcome(
    id: string,
    outcome: DeliveryHealthOutcome,
    nowMs: number,
    autoDisableAfterMs?: number,
  ): Promise<EndpointOutcomeResult> {
    // Fast-path read: if a success on a healthy endpoint → no write needed.
    const { rows: initRows } = await this.#pool.query<EndpointRow>(
      "SELECT * FROM endpoints WHERE id = $1",
      [id],
    );
    const initRow = initRows[0];
    if (initRow === undefined) {
      return { endpoint: null, autoDisabled: false };
    }
    const firstEval = evaluateEndpointHealth(
      rowToEndpoint(initRow),
      outcome,
      nowMs,
      autoDisableAfterMs,
    );
    if (!firstEval.changed) {
      return { endpoint: firstEval.endpoint, autoDisabled: firstEval.autoDisabled };
    }
    // Re-evaluate inside a transaction to avoid a lost update from a concurrent outcome.
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<EndpointRow>(
        "SELECT * FROM endpoints WHERE id = $1 FOR UPDATE",
        [id],
      );
      const current = rows[0];
      if (current === undefined) {
        await client.query("ROLLBACK");
        return { endpoint: null, autoDisabled: false };
      }
      const result = evaluateEndpointHealth(
        rowToEndpoint(current),
        outcome,
        nowMs,
        autoDisableAfterMs,
      );
      if (result.changed) {
        await client.query(
          "UPDATE endpoints SET consecutive_failures=$1, first_failure_at=$2," +
            " last_failure_at=$3, disabled=$4, updated_at=$5 WHERE id=$6",
          [
            result.endpoint.consecutiveFailures, result.endpoint.firstFailureAt,
            result.endpoint.lastFailureAt, result.endpoint.disabled,
            result.endpoint.updatedAt, id,
          ],
        );
      }
      await client.query("COMMIT");
      return { endpoint: result.endpoint, autoDisabled: result.autoDisabled };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.#pool.query(
      "DELETE FROM endpoints WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async #getForUpdate(client: PoolClient, id: string): Promise<Endpoint> {
    const { rows } = await client.query<EndpointRow>(
      "SELECT * FROM endpoints WHERE id = $1 FOR UPDATE",
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new UnknownEndpointError(id);
    }
    return rowToEndpoint(row);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS endpoints (
  id                   TEXT    PRIMARY KEY,
  app_id               TEXT    NOT NULL,
  url                  TEXT    NOT NULL,
  secret               TEXT    NOT NULL,
  previous_secrets     TEXT    NOT NULL DEFAULT '[]',
  description          TEXT    NOT NULL,
  event_types          TEXT,
  headers              TEXT,
  retry_policy         TEXT,
  filter               TEXT,
  channel              TEXT,
  rate_limit           INTEGER,
  disabled             BOOLEAN NOT NULL DEFAULT FALSE,
  consecutive_failures BIGINT  NOT NULL DEFAULT 0,
  first_failure_at     BIGINT,
  last_failure_at      BIGINT,
  created_at           BIGINT  NOT NULL,
  updated_at           BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_endpoints_app ON endpoints (app_id);
`;
