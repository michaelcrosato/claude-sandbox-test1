import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openStorage, POSTHORN_DATABASE_FILE } from '../src/index';

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
        'local_secret_keys',
        'messages',
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
      expect(columns).not.toContain('headers_json');
      expect(columns).not.toContain('signing_secret_hash');
    } finally {
      storage.close();
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
