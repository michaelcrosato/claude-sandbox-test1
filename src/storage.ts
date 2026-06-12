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
}

function resolveDatabasePath(dataDir: string): string {
  if (dataDir === ':memory:') return dataDir;
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, POSTHORN_DATABASE_FILE);
}
