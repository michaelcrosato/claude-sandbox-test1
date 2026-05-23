/**
 * A durable {@link AppStore} backed by SQLite via Node's built-in `node:sqlite`
 * module — **zero third-party dependencies, no native compile step**. The durable
 * sibling of {@link InMemoryAppStore}, held to the exact same contract: the two
 * share one validation/normalization and key-hashing implementation (see
 * `app.ts`) and pass one conformance suite. Only persistence differs.
 *
 * Tenancy and credentials must survive a restart for delivery to keep working and
 * for keys to stay valid, so this is the production backend. Two tables: `apps`
 * and `api_keys`. A foreign key ties each key to its app; deleting an app
 * cascade-deletes its keys inside one transaction. `api_keys.key_hash` is the
 * unique, indexed `sha256(secret)` that powers O(1) {@link
 * SqliteAppStore.authenticate}; `revoked_at` is `NULL` for a live key.
 */

import { createRequire } from "node:module";
import type {
  DatabaseSync as SqliteDatabase,
  StatementSync,
} from "node:sqlite";
import {
  apiKeyHashesEqual,
  apiKeyPrefix,
  applyAppUpdate,
  createApiKeyId,
  createAppId,
  generateApiKeySecret,
  hashApiKey,
  normalizeNewApp,
  UnknownAppError,
  type ApiKey,
  type App,
  type AppStore,
  type AppUpdate,
  type CreatedApiKey,
  type NewApp,
} from "./app.js";

// `node:sqlite` is loaded through createRequire rather than a static
// `import ... from "node:sqlite"`. It is a genuine Node builtin and works either
// way at runtime, but bundlers whose builtin lists predate it (e.g. Vite 5, used
// by our test runner) choke on the static specifier. Requiring it keeps it a
// runtime builtin lookup. (Same approach as the message store, queue, endpoints.)
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** Construction options for {@link SqliteAppStore}. */
export interface SqliteAppStoreOptions {
  /**
   * Where to store the database: a filesystem path for durability, or
   * `":memory:"` (the default) for an ephemeral, process-lifetime store.
   */
  location?: string;
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  now?: () => number;
  /** App-id generator. Defaults to {@link createAppId}. */
  generateAppId?: () => string;
  /** API-key-id generator. Defaults to {@link createApiKeyId}. */
  generateApiKeyId?: () => string;
  /** API-key-secret generator. Defaults to {@link generateApiKeySecret}. */
  generateApiKeySecret?: () => string;
}

/** Shape of a row from the `apps` table. */
interface AppRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Shape of a row from the `api_keys` table. */
interface ApiKeyRow {
  readonly id: string;
  readonly app_id: string;
  readonly key_hash: string;
  readonly prefix: string;
  readonly created_at: number;
  readonly revoked_at: number | null;
}

function rowToApp(row: AppRow): App {
  return {
    id: row.id,
    name: row.name,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    appId: row.app_id,
    prefix: row.prefix,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

export class SqliteAppStore implements AppStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => number;
  readonly #generateAppId: () => string;
  readonly #generateApiKeyId: () => string;
  readonly #generateApiKeySecret: () => string;

  // Statements are prepared once at construction and reused per call.
  readonly #selectApp: StatementSync;
  readonly #listApps: StatementSync;
  readonly #insertApp: StatementSync;
  readonly #updateApp: StatementSync;
  readonly #deleteApp: StatementSync;
  readonly #insertKey: StatementSync;
  readonly #selectKeysByApp: StatementSync;
  readonly #selectKeyByHash: StatementSync;
  readonly #revokeKey: StatementSync;
  readonly #countApps: StatementSync;

  constructor(options: SqliteAppStoreOptions = {}) {
    const {
      location = ":memory:",
      now = Date.now,
      generateAppId: makeAppId = createAppId,
      generateApiKeyId: makeKeyId = createApiKeyId,
      generateApiKeySecret: makeSecret = generateApiKeySecret,
    } = options;
    this.#now = now;
    this.#generateAppId = makeAppId;
    this.#generateApiKeyId = makeKeyId;
    this.#generateApiKeySecret = makeSecret;

    this.#db = new DatabaseSync(location);
    // WAL gives crash-safe, concurrent-reader durability for file-backed stores
    // (a no-op for `:memory:`). Foreign keys enforce the api_keys → apps link.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);

    this.#selectApp = this.#db.prepare("SELECT * FROM apps WHERE id = ?");
    // rowid order is insertion order → oldest-first, matching the in-memory backend.
    this.#listApps = this.#db.prepare("SELECT * FROM apps ORDER BY rowid");
    this.#insertApp = this.#db.prepare(
      "INSERT INTO apps (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    this.#updateApp = this.#db.prepare(
      "UPDATE apps SET name = ?, updated_at = ? WHERE id = ?",
    );
    this.#deleteApp = this.#db.prepare("DELETE FROM apps WHERE id = ?");
    this.#insertKey = this.#db.prepare(
      `INSERT INTO api_keys (id, app_id, key_hash, prefix, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.#selectKeysByApp = this.#db.prepare(
      "SELECT * FROM api_keys WHERE app_id = ? ORDER BY rowid",
    );
    this.#selectKeyByHash = this.#db.prepare(
      "SELECT * FROM api_keys WHERE key_hash = ?",
    );
    this.#revokeKey = this.#db.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    );
    this.#countApps = this.#db.prepare("SELECT COUNT(*) AS n FROM apps");
  }

  /** Number of apps currently held. Convenience for inspection/tests. */
  get size(): number {
    return Number((this.#countApps.get() as { n: number }).n);
  }

  async create(input?: NewApp): Promise<App> {
    const normalized = normalizeNewApp(input);
    const nowMs = this.#now();
    const id = this.#generateAppId();
    const app: App = { id, name: normalized.name, createdAt: nowMs, updatedAt: nowMs };
    // The PRIMARY KEY enforces id uniqueness; a collision surfaces as a throw.
    this.#insertApp.run(app.id, app.name, app.createdAt, app.updatedAt);
    return app;
  }

  async get(id: string): Promise<App | null> {
    const row = this.#selectApp.get(id) as AppRow | undefined;
    return row === undefined ? null : rowToApp(row);
  }

  async list(): Promise<readonly App[]> {
    const rows = this.#listApps.all() as unknown as AppRow[];
    return rows.map(rowToApp);
  }

  async update(id: string, patch: AppUpdate): Promise<App> {
    return this.#transaction(() => {
      const row = this.#selectApp.get(id) as AppRow | undefined;
      if (row === undefined) {
        throw new UnknownAppError(id);
      }
      const next = applyAppUpdate(rowToApp(row), patch, this.#now());
      this.#updateApp.run(next.name, next.updatedAt, next.id);
      return next;
    });
  }

  async delete(id: string): Promise<boolean> {
    // FK ON DELETE CASCADE removes the app's keys atomically with the app.
    const result = this.#deleteApp.run(id);
    return Number(result.changes) > 0;
  }

  async createApiKey(appId: string): Promise<CreatedApiKey> {
    return this.#transaction(() => {
      if ((this.#selectApp.get(appId) as AppRow | undefined) === undefined) {
        throw new UnknownAppError(appId);
      }
      const nowMs = this.#now();
      const id = this.#generateApiKeyId();
      const secret = this.#generateApiKeySecret();
      const keyHash = hashApiKey(secret);
      const apiKey: ApiKey = {
        id,
        appId,
        prefix: apiKeyPrefix(secret),
        createdAt: nowMs,
        revokedAt: null,
      };
      this.#insertKey.run(id, appId, keyHash, apiKey.prefix, nowMs, null);
      return { apiKey, secret };
    });
  }

  async listApiKeys(appId: string): Promise<readonly ApiKey[]> {
    const rows = this.#selectKeysByApp.all(appId) as unknown as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  async revokeApiKey(keyId: string): Promise<boolean> {
    // The `revoked_at IS NULL` guard makes a re-revoke a no-op (0 changes).
    const result = this.#revokeKey.run(this.#now(), keyId);
    return Number(result.changes) > 0;
  }

  async authenticate(presentedSecret: string): Promise<App | null> {
    if (typeof presentedSecret !== "string" || presentedSecret.length === 0) {
      return null;
    }
    const hash = hashApiKey(presentedSecret);
    const row = this.#selectKeyByHash.get(hash) as ApiKeyRow | undefined;
    if (row === undefined || row.revoked_at !== null) {
      return null;
    }
    if (!apiKeyHashesEqual(hash, row.key_hash)) {
      return null; // defense-in-depth; the unique-hash lookup makes this unreachable
    }
    return this.get(row.app_id);
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
 * reattach to an existing database unchanged (crash-safe replay). `api_keys`
 * references `apps(id)` with `ON DELETE CASCADE`, so deleting an app reaps its
 * keys atomically. `key_hash` is UNIQUE and indexed — the authenticate lookup;
 * `revoked_at` is `NULL` for a live key. The app index backs the
 * {@link SqliteAppStore.listApiKeys} scan.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT    PRIMARY KEY,
  app_id     TEXT    NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  key_hash   TEXT    NOT NULL UNIQUE,
  prefix     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_api_keys_app ON api_keys (app_id);
`;
