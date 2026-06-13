import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeSchema, openStorage, POSTHORN_DATABASE_FILE } from '../src/index';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('openStorage', () => {
  it('opens and initializes an in-memory SQLite database', () => {
    const storage = openStorage({ dataDir: ':memory:' });
    try {
      expect(storage.databasePath).toBe(':memory:');
      expect(storage.listTables()).toEqual([
        'api_keys',
        'apps',
        'deliveries',
        'delivery_attempts',
        'endpoints',
        'event_types',
        'local_secret_keys',
        'messages',
        'portal_sessions',
        'schema_migrations',
        'usage_months',
      ]);

      storage.initializeSchema();
      expect(storage.listTables()).toContain('schema_migrations');
    } finally {
      storage.close();
    }
  });

  it('keeps endpoint secret storage recoverable and avoids plaintext secret headers', () => {
    const storage = openStorage({ dataDir: ':memory:' });
    try {
      const columns = storage.db
        .prepare('PRAGMA table_info(endpoints)')
        .all()
        .map((row) => String(row.name));

      expect(columns).toContain('non_secret_headers_json');
      expect(columns).toContain('secret_header_refs_json');
      expect(columns).toContain('signing_secret_ciphertext');
      expect(columns).toContain('signing_secret_key_version');
      expect(columns).toContain('signing_secret_nonce');
      expect(columns).toContain('previous_signing_secret_ciphertext');
      expect(columns).toContain('previous_signing_secret_key_version');
      expect(columns).toContain('previous_signing_secret_nonce');
      expect(columns).toContain('previous_signing_secret_expires_at');
      expect(columns).toContain('rate_limit_per_second');
      expect(columns).toContain('rate_limit_window_started_at');
      expect(columns).toContain('rate_limit_window_count');
      expect(columns).not.toContain('headers_json');
      expect(columns).not.toContain('signing_secret_hash');
      const indexes = storage.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all()
        .map((row) => String(row.name));
      expect(indexes).toEqual(
        expect.arrayContaining([
          'deliveries_status_due_idx',
          'deliveries_status_lease_idx',
          'deliveries_endpoint_status_updated_idx',
          'delivery_attempts_attempted_delivery_idx',
          'delivery_attempts_delivery_attempted_idx',
        ]),
      );
    } finally {
      storage.close();
    }
  });

  it('keeps app system signing secrets protected and migrates legacy app tables', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE apps (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          monthly_message_quota INTEGER,
          created_at TEXT NOT NULL
        );
        INSERT INTO apps (id, name, monthly_message_quota, created_at)
        VALUES ('app_legacy', 'Legacy App', NULL, '2026-06-12T00:00:00.000Z');
      `);

      initializeSchema(db);
      initializeSchema(db);

      const columns = db
        .prepare('PRAGMA table_info(apps)')
        .all()
        .map((row) => String(row.name));
      expect(columns.filter((name) => name === 'system_signing_secret_ciphertext')).toHaveLength(1);
      expect(columns.filter((name) => name === 'system_signing_secret_key_version')).toHaveLength(1);
      expect(columns.filter((name) => name === 'system_signing_secret_nonce')).toHaveLength(1);
      expect(columns.filter((name) => name === 'previous_system_signing_secret_ciphertext')).toHaveLength(1);
      expect(columns.filter((name) => name === 'previous_system_signing_secret_key_version')).toHaveLength(1);
      expect(columns.filter((name) => name === 'previous_system_signing_secret_nonce')).toHaveLength(1);
      expect(columns.filter((name) => name === 'previous_system_signing_secret_expires_at')).toHaveLength(1);
      expect(db.prepare('SELECT name FROM apps WHERE id = ?').get('app_legacy')).toEqual({ name: 'Legacy App' });
    } finally {
      db.close();
    }
  });

  it('adds endpoint rotation columns idempotently for existing SQLite files', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE endpoints (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
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
      `);

      initializeSchema(db);
      initializeSchema(db);

      const columns = db
        .prepare('PRAGMA table_info(endpoints)')
        .all()
        .map((row) => String(row.name));

      expect(columns.filter((name) => name === 'previous_signing_secret_ciphertext')).toHaveLength(1);
      expect(columns.filter((name) => name === 'previous_signing_secret_key_version')).toHaveLength(1);
      expect(columns.filter((name) => name === 'previous_signing_secret_nonce')).toHaveLength(1);
      expect(columns.filter((name) => name === 'previous_signing_secret_expires_at')).toHaveLength(1);
      expect(columns.filter((name) => name === 'rate_limit_per_second')).toHaveLength(1);
      expect(columns.filter((name) => name === 'rate_limit_window_started_at')).toHaveLength(1);
      expect(columns.filter((name) => name === 'rate_limit_window_count')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('opens a file-backed SQLite database and persists synthetic data', () => {
    const dataDir = makeTempDir();
    const first = openStorage({ dataDir });
    try {
      expect(first.databasePath).toBe(join(dataDir, POSTHORN_DATABASE_FILE));
      first.db
        .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
        .run('app_test', 'Synthetic App', 100, '2026-06-12T00:00:00Z');
    } finally {
      first.close();
    }

    const second = openStorage({ dataDir });
    try {
      const row = second.db.prepare('SELECT name, monthly_message_quota FROM apps WHERE id = ?').get('app_test');

      expect(row).toEqual({
        name: 'Synthetic App',
        monthly_message_quota: 100,
      });
    } finally {
      second.close();
    }
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'posthorn-storage-'));
  tempDirs.push(dir);
  return dir;
}
