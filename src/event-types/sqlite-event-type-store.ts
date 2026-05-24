import { createRequire } from "node:module";
import type {
  DatabaseSync as SqliteDatabase,
  StatementSync,
} from "node:sqlite";
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

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export interface SqliteEventTypeStoreOptions {
  location?: string;
  now?: () => number;
}

interface EventTypeRow {
  readonly id: string;
  readonly app_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly schema_example: string | null;
  readonly archived: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function rowToEventType(row: EventTypeRow): EventType {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    description: row.description ?? null,
    schemaExample: row.schema_example ?? null,
    archived: row.archived !== 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_types (
  id             TEXT    NOT NULL,
  app_id         TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  description    TEXT,
  schema_example TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_event_types_app ON event_types (app_id, archived, id);
`;

export class SqliteEventTypeStore implements EventTypeStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => number;

  readonly #insert: StatementSync;
  readonly #selectOne: StatementSync;
  readonly #listAll: StatementSync;
  readonly #listActive: StatementSync;
  readonly #update: StatementSync;
  readonly #archive: StatementSync;

  constructor(options: SqliteEventTypeStoreOptions = {}) {
    const { location = ":memory:", now = Date.now } = options;
    this.#now = now;
    this.#db = new DatabaseSync(location);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);

    this.#insert = this.#db.prepare(
      `INSERT INTO event_types (id, app_id, name, description, schema_example, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    this.#selectOne = this.#db.prepare(
      "SELECT * FROM event_types WHERE app_id = ? AND id = ?",
    );
    this.#listAll = this.#db.prepare(
      "SELECT * FROM event_types WHERE app_id = ? ORDER BY id ASC",
    );
    this.#listActive = this.#db.prepare(
      "SELECT * FROM event_types WHERE app_id = ? AND archived = 0 ORDER BY id ASC",
    );
    this.#update = this.#db.prepare(
      "UPDATE event_types SET name = ?, description = ?, schema_example = ?, updated_at = ? WHERE app_id = ? AND id = ?",
    );
    this.#archive = this.#db.prepare(
      "UPDATE event_types SET archived = 1, updated_at = ? WHERE app_id = ? AND id = ? AND archived = 0",
    );
  }

  async create(input: NewEventType): Promise<EventType> {
    const normalized = normalizeNewEventType(input);
    const nowMs = this.#now();
    try {
      this.#insert.run(
        normalized.id,
        normalized.appId,
        normalized.name,
        normalized.description,
        normalized.schemaExample,
        nowMs,
        nowMs,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
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
    const row = this.#selectOne.get(appId, id) as EventTypeRow | undefined;
    return row === undefined ? null : rowToEventType(row);
  }

  async list(appId: string, options: ListEventTypesOptions = {}): Promise<readonly EventType[]> {
    const rows = (
      options.includeArchived === true
        ? (this.#listAll.all(appId) as unknown as EventTypeRow[])
        : (this.#listActive.all(appId) as unknown as EventTypeRow[])
    );
    return rows.map(rowToEventType);
  }

  async update(appId: string, id: string, patch: EventTypeUpdate): Promise<EventType> {
    const current = await this.get(appId, id);
    if (current === null) {
      throw new UnknownEventTypeError(id);
    }
    const next = applyEventTypeUpdate(current, patch, this.#now());
    this.#update.run(next.name, next.description, next.schemaExample, next.updatedAt, appId, id);
    return next;
  }

  async archive(appId: string, id: string): Promise<boolean> {
    const result = this.#archive.run(this.#now(), appId, id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.#db.close();
  }
}
