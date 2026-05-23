/**
 * A durable {@link EndpointStore} backed by SQLite via Node's built-in
 * `node:sqlite` module — **zero third-party dependencies, no native compile
 * step**. The durable sibling of {@link InMemoryEndpointStore}, held to the exact
 * same contract: the two share one validation/normalization implementation (see
 * `endpoint.ts`) and pass one conformance suite. Only persistence differs.
 *
 * Endpoint configuration must survive a restart for delivery to keep working, so
 * this is the production backend for the "single process, no Redis, crash-safe"
 * wedge. The subscription filter (`eventTypes`) is stored as a JSON array (or
 * `NULL` for subscribe-to-all); `disabled` as a 0/1 integer (STRICT-friendly).
 */

import { createRequire } from "node:module";
import type {
  DatabaseSync as SqliteDatabase,
  StatementSync,
} from "node:sqlite";
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
  type EndpointOutcomeResult,
  type EndpointStore,
  type EndpointUpdate,
  type ExpiringSecret,
  type NewEndpoint,
  type RotateSecretOptions,
} from "./endpoint.js";

// `node:sqlite` is loaded through createRequire rather than a static
// `import ... from "node:sqlite"`. It is a genuine Node builtin and works either
// way at runtime, but bundlers whose builtin lists predate it (e.g. Vite 5, used
// by our test runner) choke on the static specifier. Requiring it keeps it a
// runtime builtin lookup. (Same approach as the message store and queue.)
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** Construction options for {@link SqliteEndpointStore}. */
export interface SqliteEndpointStoreOptions {
  /**
   * Where to store the database: a filesystem path for durability, or
   * `":memory:"` (the default) for an ephemeral, process-lifetime store.
   */
  location?: string;
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Endpoint-id generator. Defaults to {@link createEndpointId}. */
  generateId?: () => string;
  /** Signing-secret generator for created endpoints. Defaults to {@link generateSecret}. */
  generateSecret?: () => string;
}

/** Shape of a row from the `endpoints` table. */
interface EndpointRow {
  readonly id: string;
  readonly app_id: string;
  readonly url: string;
  readonly secret: string;
  readonly previous_secrets: string;
  readonly description: string;
  readonly event_types: string | null;
  readonly disabled: number;
  readonly consecutive_failures: number;
  readonly first_failure_at: number | null;
  readonly last_failure_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function rowToEndpoint(row: EndpointRow): Endpoint {
  return {
    id: row.id,
    appId: row.app_id,
    url: row.url,
    secret: row.secret,
    // Stored as a JSON array of { secret, expiresAt }; '[]' for a never-rotated
    // endpoint (and the migration default for rows from a pre-rotation build).
    previousSecrets: JSON.parse(row.previous_secrets) as ExpiringSecret[],
    description: row.description,
    eventTypes:
      row.event_types === null
        ? null
        : (JSON.parse(row.event_types) as string[]),
    disabled: row.disabled !== 0,
    consecutiveFailures: Number(row.consecutive_failures),
    firstFailureAt: row.first_failure_at === null ? null : Number(row.first_failure_at),
    lastFailureAt: row.last_failure_at === null ? null : Number(row.last_failure_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Serialize an endpoint's subscription filter for the `event_types` column. */
function eventTypesToColumn(eventTypes: readonly string[] | null): string | null {
  return eventTypes === null ? null : JSON.stringify(eventTypes);
}

export class SqliteEndpointStore implements EndpointStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #generateSecret: () => string;

  // Statements are prepared once at construction and reused per call.
  readonly #selectEndpoint: StatementSync;
  readonly #selectByApp: StatementSync;
  readonly #insertEndpoint: StatementSync;
  readonly #updateEndpoint: StatementSync;
  readonly #rotateSecretStmt: StatementSync;
  readonly #recordHealthStmt: StatementSync;
  readonly #deleteEndpoint: StatementSync;
  readonly #countEndpoints: StatementSync;

  constructor(options: SqliteEndpointStoreOptions = {}) {
    const {
      location = ":memory:",
      now = Date.now,
      generateId = createEndpointId,
      generateSecret: makeSecret = generateSecret,
    } = options;
    this.#now = now;
    this.#generateId = generateId;
    this.#generateSecret = makeSecret;

    this.#db = new DatabaseSync(location);
    // WAL gives crash-safe, concurrent-reader durability for file-backed stores
    // (a no-op for `:memory:`).
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(SCHEMA);
    // Bring a database created by a pre-rotation version up to schema. For a fresh
    // database the column is in SCHEMA and this is a no-op.
    this.#migratePreviousSecretsColumn();
    // Likewise for the endpoint-health columns added with auto-disable. Existing rows
    // default to healthy (0 failures, no streak). No-op on a fresh database.
    this.#migrateHealthColumns();

    this.#selectEndpoint = this.#db.prepare(
      "SELECT * FROM endpoints WHERE id = ?",
    );
    // rowid order is insertion order → oldest-first, matching the in-memory backend.
    this.#selectByApp = this.#db.prepare(
      "SELECT * FROM endpoints WHERE app_id = ? ORDER BY rowid",
    );
    this.#insertEndpoint = this.#db.prepare(
      `INSERT INTO endpoints
         (id, app_id, url, secret, previous_secrets, description, event_types,
          disabled, consecutive_failures, first_failure_at, last_failure_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#updateEndpoint = this.#db.prepare(
      `UPDATE endpoints
         SET url = ?, secret = ?, description = ?, event_types = ?,
             disabled = ?, consecutive_failures = ?, first_failure_at = ?,
             last_failure_at = ?, updated_at = ?
       WHERE id = ?`,
    );
    // Rotation is the only path that writes previous_secrets after creation; it is
    // separate from #updateEndpoint (which preserves the column untouched).
    this.#rotateSecretStmt = this.#db.prepare(
      `UPDATE endpoints
         SET secret = ?, previous_secrets = ?, updated_at = ?
       WHERE id = ?`,
    );
    // Health-only write (recordDeliveryOutcome): touches just the health columns,
    // disabled (an auto-disable can flip it), and updated_at.
    this.#recordHealthStmt = this.#db.prepare(
      `UPDATE endpoints
         SET consecutive_failures = ?, first_failure_at = ?, last_failure_at = ?,
             disabled = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.#deleteEndpoint = this.#db.prepare("DELETE FROM endpoints WHERE id = ?");
    this.#countEndpoints = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM endpoints",
    );
  }

  /**
   * Add the `previous_secrets` column to a database created before zero-downtime
   * secret rotation existed. Existing rows default to `'[]'` (never rotated), so an
   * upgrade is seamless. For a fresh database the column is in {@link SCHEMA} and
   * this is a no-op.
   */
  #migratePreviousSecretsColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(endpoints)").all() as {
      name: string;
    }[];
    if (columns.some((c) => c.name === "previous_secrets")) {
      return;
    }
    this.#db.exec(
      "ALTER TABLE endpoints ADD COLUMN previous_secrets TEXT NOT NULL DEFAULT '[]'",
    );
  }

  /**
   * Add the endpoint-health columns to a database created before automatic
   * disabling existed. Existing rows backfill to healthy (`0` consecutive failures,
   * no failure streak), so an upgrade is seamless and changes no behaviour. For a
   * fresh database the columns are in {@link SCHEMA} and this is a no-op.
   */
  #migrateHealthColumns(): void {
    const columns = this.#db.prepare("PRAGMA table_info(endpoints)").all() as {
      name: string;
    }[];
    if (columns.some((c) => c.name === "consecutive_failures")) {
      return;
    }
    this.#db.exec(
      "ALTER TABLE endpoints ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0",
    );
    // Nullable: NULL is the healthy "no active streak" state.
    this.#db.exec("ALTER TABLE endpoints ADD COLUMN first_failure_at INTEGER");
    this.#db.exec("ALTER TABLE endpoints ADD COLUMN last_failure_at INTEGER");
  }

  /** Number of endpoints currently held. Convenience for inspection/tests. */
  get size(): number {
    return Number((this.#countEndpoints.get() as { n: number }).n);
  }

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
      disabled: normalized.disabled,
      consecutiveFailures: 0,
      firstFailureAt: null,
      lastFailureAt: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    // The PRIMARY KEY enforces id uniqueness; a collision surfaces as a throw.
    this.#insertEndpoint.run(
      endpoint.id,
      endpoint.appId,
      endpoint.url,
      endpoint.secret,
      JSON.stringify(endpoint.previousSecrets),
      endpoint.description,
      eventTypesToColumn(endpoint.eventTypes),
      endpoint.disabled ? 1 : 0,
      endpoint.consecutiveFailures,
      endpoint.firstFailureAt,
      endpoint.lastFailureAt,
      endpoint.createdAt,
      endpoint.updatedAt,
    );
    return endpoint;
  }

  async get(id: string): Promise<Endpoint | null> {
    const row = this.#selectEndpoint.get(id) as EndpointRow | undefined;
    return row === undefined ? null : rowToEndpoint(row);
  }

  async listByApp(appId: string): Promise<readonly Endpoint[]> {
    const rows = this.#selectByApp.all(appId) as unknown as EndpointRow[];
    return rows.map(rowToEndpoint);
  }

  async update(id: string, patch: EndpointUpdate): Promise<Endpoint> {
    return this.#transaction(() => {
      const row = this.#selectEndpoint.get(id) as EndpointRow | undefined;
      if (row === undefined) {
        throw new UnknownEndpointError(id);
      }
      const next = applyEndpointUpdate(rowToEndpoint(row), patch, this.#now());
      this.#updateEndpoint.run(
        next.url,
        next.secret,
        next.description,
        eventTypesToColumn(next.eventTypes),
        next.disabled ? 1 : 0,
        next.consecutiveFailures,
        next.firstFailureAt,
        next.lastFailureAt,
        next.updatedAt,
        next.id,
      );
      return next;
    });
  }

  async rotateSecret(
    id: string,
    options: RotateSecretOptions = {},
  ): Promise<Endpoint> {
    // Read-modify-write under one BEGIN IMMEDIATE so a concurrent rotation cannot
    // interleave and lose a retired secret (the same atomicity create/update use).
    return this.#transaction(() => {
      const row = this.#selectEndpoint.get(id) as EndpointRow | undefined;
      if (row === undefined) {
        throw new UnknownEndpointError(id);
      }
      const newSecret = options.secret ?? this.#generateSecret();
      const next = rotateEndpointSecret(
        rowToEndpoint(row),
        newSecret,
        this.#now(),
        options.overlapMs,
      );
      this.#rotateSecretStmt.run(
        next.secret,
        JSON.stringify(next.previousSecrets),
        next.updatedAt,
        next.id,
      );
      return next;
    });
  }

  async recordDeliveryOutcome(
    id: string,
    outcome: DeliveryHealthOutcome,
    nowMs: number,
    autoDisableAfterMs?: number,
  ): Promise<EndpointOutcomeResult> {
    // Fast path: a successful delivery to a healthy endpoint changes nothing, so read
    // without taking a write lock and skip the transaction entirely. This is the
    // steady state (most deliveries succeed), so the hot path stays a single read.
    const row = this.#selectEndpoint.get(id) as EndpointRow | undefined;
    if (row === undefined) {
      return { endpoint: null, autoDisabled: false }; // deleted/unknown endpoint → no-op
    }
    const firstEval = evaluateEndpointHealth(
      rowToEndpoint(row),
      outcome,
      nowMs,
      autoDisableAfterMs,
    );
    if (!firstEval.changed) {
      return { endpoint: firstEval.endpoint, autoDisabled: firstEval.autoDisabled };
    }
    // A write is needed: re-evaluate inside a transaction so the read-modify-write is
    // atomic against a concurrent outcome for the same endpoint (no lost update).
    return this.#transaction(() => {
      const current = this.#selectEndpoint.get(id) as EndpointRow | undefined;
      if (current === undefined) {
        return { endpoint: null, autoDisabled: false };
      }
      const result = evaluateEndpointHealth(
        rowToEndpoint(current),
        outcome,
        nowMs,
        autoDisableAfterMs,
      );
      if (result.changed) {
        this.#recordHealthStmt.run(
          result.endpoint.consecutiveFailures,
          result.endpoint.firstFailureAt,
          result.endpoint.lastFailureAt,
          result.endpoint.disabled ? 1 : 0,
          result.endpoint.updatedAt,
          id,
        );
      }
      return { endpoint: result.endpoint, autoDisabled: result.autoDisabled };
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = this.#deleteEndpoint.run(id);
    return Number(result.changes) > 0;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.#db.close();
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
 * reattach to an existing database unchanged (crash-safe replay). The index backs
 * the {@link SqliteEndpointStore.listByApp} scan. `event_types` is a JSON array
 * (or `NULL` = subscribe-to-all); `disabled` is a 0/1 integer. `previous_secrets`
 * is a JSON array of `{ secret, expiresAt }` retired during rotation (`'[]'` when
 * never rotated); a pre-rotation database gains it via
 * {@link SqliteEndpointStore.#migratePreviousSecretsColumn}. The health columns
 * (`consecutive_failures` + the nullable `first_failure_at`/`last_failure_at`) track
 * the streak that drives auto-disabling; a pre-health database gains them via
 * {@link SqliteEndpointStore.#migrateHealthColumns}, backfilled as healthy.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS endpoints (
  id               TEXT    PRIMARY KEY,
  app_id           TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  secret           TEXT    NOT NULL,
  previous_secrets TEXT    NOT NULL DEFAULT '[]',
  description      TEXT    NOT NULL,
  event_types      TEXT,
  disabled         INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  first_failure_at     INTEGER,
  last_failure_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_endpoints_app ON endpoints (app_id);
`;
