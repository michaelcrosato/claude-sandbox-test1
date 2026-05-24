/**
 * A durable {@link EventTypeStore} backed by PostgreSQL.
 *
 * Horizontally-scalable sibling of {@link SqliteEventTypeStore}. Holds to the
 * same behavioural contract and passes the same conformance suite.
 */

import type { Pool, PoolClient } from "pg";
import {
  applyEventTypeUpdate,
  DuplicateEventTypeError,
  normalizeNewEventType,
  UnknownEventTypeError,
  type EventType,
  type EventTypeStore,
  type EventTypeUpdate,
  type ListEventTypesOptions,
  type NewEventType,
} from "./event-type.js";

export interface PostgresEventTypeStoreOptions {
  now?: () => number;
}

interface EventTypeRow {
  readonly id: string;
  readonly app_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly schema_example: string | null;
  readonly archived: boolean;
  readonly created_at: string; // BIGINT as string
  readonly updated_at: string; // BIGINT as string
}

function rowToEventType(row: EventTypeRow): EventType {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    description: row.description ?? null,
    schemaExample: row.schema_example ?? null,
    archived: row.archived,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PostgresEventTypeStore implements EventTypeStore {
  readonly #pool: Pool;
  readonly #now: () => number;

  constructor(pool: Pool, options: PostgresEventTypeStoreOptions = {}) {
    const { now = Date.now } = options;
    this.#pool = pool;
    this.#now = now;
  }

  async initialize(): Promise<void> {
    await this.#pool.query(SCHEMA);
  }

  async truncate(): Promise<void> {
    await this.#pool.query(
      "TRUNCATE TABLE event_types RESTART IDENTITY CASCADE",
    );
  }

  close(): void {}

  async create(input: NewEventType): Promise<EventType> {
    const normalized = normalizeNewEventType(input);
    const nowMs = this.#now();
    try {
      await this.#pool.query(
        "INSERT INTO event_types (id, app_id, name, description, schema_example, archived, created_at, updated_at)" +
          " VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7)",
        [
          normalized.id, normalized.appId, normalized.name,
          normalized.description, normalized.schemaExample,
          nowMs, nowMs,
        ],
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("duplicate key value violates unique constraint")
      ) {
        throw new DuplicateEventTypeError(normalized.appId, normalized.id);
      }
      throw err;
    }
    return {
      id: normalized.id,
      appId: normalized.appId,
      name: normalized.name,
      description: normalized.description,
      schemaExample: normalized.schemaExample,
      archived: false,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
  }

  async get(appId: string, id: string): Promise<EventType | null> {
    const { rows } = await this.#pool.query<EventTypeRow>(
      "SELECT * FROM event_types WHERE app_id = $1 AND id = $2",
      [appId, id],
    );
    const row = rows[0];
    return row !== undefined ? rowToEventType(row) : null;
  }

  async list(appId: string, options: ListEventTypesOptions = {}): Promise<readonly EventType[]> {
    let rows: EventTypeRow[];
    if (options.includeArchived === true) {
      ({ rows } = await this.#pool.query<EventTypeRow>(
        "SELECT * FROM event_types WHERE app_id = $1 ORDER BY id ASC",
        [appId],
      ));
    } else {
      ({ rows } = await this.#pool.query<EventTypeRow>(
        "SELECT * FROM event_types WHERE app_id = $1 AND archived = FALSE ORDER BY id ASC",
        [appId],
      ));
    }
    return rows.map(rowToEventType);
  }

  async update(appId: string, id: string, patch: EventTypeUpdate): Promise<EventType> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.#getForUpdate(client, appId, id);
      const next = applyEventTypeUpdate(current, patch, this.#now());
      await client.query(
        "UPDATE event_types SET name=$1, description=$2, schema_example=$3, updated_at=$4" +
          " WHERE app_id=$5 AND id=$6",
        [next.name, next.description, next.schemaExample, next.updatedAt, appId, id],
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

  async archive(appId: string, id: string): Promise<boolean> {
    const result = await this.#pool.query(
      "UPDATE event_types SET archived = TRUE, updated_at = $1" +
        " WHERE app_id = $2 AND id = $3 AND archived = FALSE",
      [this.#now(), appId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async #getForUpdate(client: PoolClient, appId: string, id: string): Promise<EventType> {
    const { rows } = await client.query<EventTypeRow>(
      "SELECT * FROM event_types WHERE app_id = $1 AND id = $2 FOR UPDATE",
      [appId, id],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new UnknownEventTypeError(id);
    }
    return rowToEventType(row);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_types (
  id             TEXT    NOT NULL,
  app_id         TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  description    TEXT,
  schema_example TEXT,
  archived       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     BIGINT  NOT NULL,
  updated_at     BIGINT  NOT NULL,
  PRIMARY KEY (app_id, id)
);

CREATE INDEX IF NOT EXISTS idx_event_types_app ON event_types (app_id, archived, id);
`;
