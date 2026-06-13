import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PosthornConfig } from './config';

export const POSTHORN_DATABASE_FILE = 'posthorn.sqlite';

export interface StorageOptions {
  readonly dataDir: PosthornConfig['dataDir'];
}

export interface PosthornStorage {
  readonly databasePath: string;
  readonly db: DatabaseSync;
  initializeSchema(): void;
  listTables(): string[];
  close(): void;
}

const INITIAL_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_message_quota INTEGER,
  system_signing_secret_ciphertext TEXT,
  system_signing_secret_key_version TEXT,
  system_signing_secret_nonce TEXT,
  previous_system_signing_secret_ciphertext TEXT,
  previous_system_signing_secret_key_version TEXT,
  previous_system_signing_secret_nonce TEXT,
  previous_system_signing_secret_expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  name TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_secret_keys (
  id TEXT PRIMARY KEY,
  key_material TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  event_types_json TEXT,
  non_secret_headers_json TEXT,
  secret_header_refs_json TEXT,
  signing_secret_ciphertext TEXT NOT NULL,
  signing_secret_key_version TEXT NOT NULL,
  signing_secret_nonce TEXT NOT NULL,
  previous_signing_secret_ciphertext TEXT,
  previous_signing_secret_key_version TEXT,
  previous_signing_secret_nonce TEXT,
  previous_signing_secret_expires_at TEXT,
  rate_limit_per_second INTEGER,
  rate_limit_window_started_at TEXT,
  rate_limit_window_count INTEGER NOT NULL DEFAULT 0,
  payload_format TEXT NOT NULL DEFAULT 'envelope',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT,
  payload_hash TEXT,
  deduplication_key TEXT,
  deduplication_expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  response_status INTEGER,
  duration_ms INTEGER,
  failure_reason TEXT,
  attempted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deliveries_status_due_idx
ON deliveries(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS deliveries_status_lease_idx
ON deliveries(status, lease_expires_at);

CREATE INDEX IF NOT EXISTS deliveries_endpoint_status_updated_idx
ON deliveries(endpoint_id, status, updated_at);

CREATE INDEX IF NOT EXISTS delivery_attempts_attempted_delivery_idx
ON delivery_attempts(attempted_at, delivery_id);

CREATE INDEX IF NOT EXISTS delivery_attempts_delivery_attempted_idx
ON delivery_attempts(delivery_id, attempted_at);

CREATE TABLE IF NOT EXISTS event_types (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  description TEXT,
  schema_example_json TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS event_types_active_unique
ON event_types(app_id, event_type)
WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS event_types_app_active_created_idx
ON event_types(app_id, archived_at, created_at);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  endpoint_id TEXT REFERENCES endpoints(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS portal_sessions_app_expires_idx
ON portal_sessions(app_id, expires_at);

CREATE TABLE IF NOT EXISTS usage_months (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  messages_accepted INTEGER NOT NULL DEFAULT 0,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(app_id, month)
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('0001_initial', datetime('now'));
`;

export function openStorage(options: StorageOptions): PosthornStorage {
  const databasePath = resolveDatabasePath(options.dataDir);
  const db = new DatabaseSync(databasePath);

  const storage: PosthornStorage = {
    databasePath,
    db,
    initializeSchema() {
      initializeSchema(db);
    },
    listTables() {
      return db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String(row.name));
    },
    close() {
      db.close();
    },
  };

  storage.initializeSchema();
  return storage;
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(INITIAL_SCHEMA_SQL);
  migrateAppSystemSecretColumns(db);
  migrateEndpointSecretRotationColumns(db);
  migrateEndpointRateLimitColumns(db);
  migrateEndpointPayloadFormatColumns(db);
  migrateMessageDeduplicationColumns(db);
}

function migrateAppSystemSecretColumns(db: DatabaseSync): void {
  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(apps)').all() as Array<{
        readonly name: unknown;
      }>
    ).map((row) => String(row.name)),
  );

  for (const column of APP_SYSTEM_SECRET_COLUMNS) {
    if (!columns.has(column.name)) {
      db.exec(`ALTER TABLE apps ADD COLUMN ${column.definition}`);
    }
  }
}

function migrateEndpointSecretRotationColumns(db: DatabaseSync): void {
  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(endpoints)').all() as Array<{
        readonly name: unknown;
      }>
    ).map((row) => String(row.name)),
  );

  for (const column of ENDPOINT_SECRET_ROTATION_COLUMNS) {
    if (!columns.has(column.name)) {
      db.exec(`ALTER TABLE endpoints ADD COLUMN ${column.definition}`);
    }
  }
}

function migrateEndpointRateLimitColumns(db: DatabaseSync): void {
  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(endpoints)').all() as Array<{
        readonly name: unknown;
      }>
    ).map((row) => String(row.name)),
  );

  for (const column of ENDPOINT_RATE_LIMIT_COLUMNS) {
    if (!columns.has(column.name)) {
      db.exec(`ALTER TABLE endpoints ADD COLUMN ${column.definition}`);
    }
  }
}

function migrateEndpointPayloadFormatColumns(db: DatabaseSync): void {
  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(endpoints)').all() as Array<{
        readonly name: unknown;
      }>
    ).map((row) => String(row.name)),
  );

  for (const column of ENDPOINT_PAYLOAD_FORMAT_COLUMNS) {
    if (!columns.has(column.name)) {
      db.exec(`ALTER TABLE endpoints ADD COLUMN ${column.definition}`);
    }
  }
}

function migrateMessageDeduplicationColumns(db: DatabaseSync): void {
  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(messages)').all() as Array<{
        readonly name: unknown;
      }>
    ).map((row) => String(row.name)),
  );

  for (const column of MESSAGE_DEDUPLICATION_COLUMNS) {
    if (!columns.has(column.name)) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${column.definition}`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_deduplication_lookup_idx
    ON messages(app_id, event_type, deduplication_key, deduplication_expires_at)
    WHERE deduplication_key IS NOT NULL AND deduplication_expires_at IS NOT NULL
  `);
}

const APP_SYSTEM_SECRET_COLUMNS = [
  {
    name: 'system_signing_secret_ciphertext',
    definition: 'system_signing_secret_ciphertext TEXT',
  },
  {
    name: 'system_signing_secret_key_version',
    definition: 'system_signing_secret_key_version TEXT',
  },
  {
    name: 'system_signing_secret_nonce',
    definition: 'system_signing_secret_nonce TEXT',
  },
  {
    name: 'previous_system_signing_secret_ciphertext',
    definition: 'previous_system_signing_secret_ciphertext TEXT',
  },
  {
    name: 'previous_system_signing_secret_key_version',
    definition: 'previous_system_signing_secret_key_version TEXT',
  },
  {
    name: 'previous_system_signing_secret_nonce',
    definition: 'previous_system_signing_secret_nonce TEXT',
  },
  {
    name: 'previous_system_signing_secret_expires_at',
    definition: 'previous_system_signing_secret_expires_at TEXT',
  },
] as const;

const ENDPOINT_SECRET_ROTATION_COLUMNS = [
  {
    name: 'previous_signing_secret_ciphertext',
    definition: 'previous_signing_secret_ciphertext TEXT',
  },
  {
    name: 'previous_signing_secret_key_version',
    definition: 'previous_signing_secret_key_version TEXT',
  },
  {
    name: 'previous_signing_secret_nonce',
    definition: 'previous_signing_secret_nonce TEXT',
  },
  {
    name: 'previous_signing_secret_expires_at',
    definition: 'previous_signing_secret_expires_at TEXT',
  },
] as const;

const ENDPOINT_RATE_LIMIT_COLUMNS = [
  {
    name: 'rate_limit_per_second',
    definition: 'rate_limit_per_second INTEGER',
  },
  {
    name: 'rate_limit_window_started_at',
    definition: 'rate_limit_window_started_at TEXT',
  },
  {
    name: 'rate_limit_window_count',
    definition: 'rate_limit_window_count INTEGER NOT NULL DEFAULT 0',
  },
] as const;

const ENDPOINT_PAYLOAD_FORMAT_COLUMNS = [
  {
    name: 'payload_format',
    definition: "payload_format TEXT NOT NULL DEFAULT 'envelope'",
  },
] as const;

const MESSAGE_DEDUPLICATION_COLUMNS = [
  {
    name: 'deduplication_key',
    definition: 'deduplication_key TEXT',
  },
  {
    name: 'deduplication_expires_at',
    definition: 'deduplication_expires_at TEXT',
  },
] as const;

function resolveDatabasePath(dataDir: string): string {
  if (dataDir === ':memory:') return dataDir;
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, POSTHORN_DATABASE_FILE);
}
