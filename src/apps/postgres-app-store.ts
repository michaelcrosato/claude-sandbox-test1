/**
 * A durable {@link AppStore} backed by PostgreSQL.
 *
 * Horizontally-scalable sibling of {@link SqliteAppStore}: tenants and API
 * keys are shared across Posthorn instances without any in-process state.
 * Holds to the same behavioural contract and passes the same conformance suite.
 */

import type { Pool } from "pg";
import {
  apiKeyHashesEqual,
  apiKeyPrefix,
  applyAppUpdate,
  createApiKeyId,
  createAppId,
  generateApiKeySecret,
  generateSystemWebhookSecret,
  hashApiKey,
  normalizeNewApp,
  UnknownAppError,
  type ApiKey,
  type App,
  type AppStore,
  type AppUpdate,
  type CreatedApiKey,
  type CreatedApp,
  type NewApp,
} from "./app.js";

export interface PostgresAppStoreOptions {
  now?: () => number;
  generateAppId?: () => string;
  generateApiKeyId?: () => string;
  generateApiKeySecret?: () => string;
}

interface AppRow {
  readonly id: string;
  readonly name: string;
  readonly monthly_message_quota: string | null; // BIGINT as string
  readonly system_webhook_url: string | null;
  readonly system_webhook_secret: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ApiKeyRow {
  readonly id: string;
  readonly app_id: string;
  readonly key_hash: string;
  readonly prefix: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly last_used_at: string | null;
}

function rowToApp(row: AppRow): App {
  return {
    id: row.id,
    name: row.name,
    monthlyMessageQuota:
      row.monthly_message_quota === null ? null : Number(row.monthly_message_quota),
    systemWebhookUrl: row.system_webhook_url ?? null,
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
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  };
}

export class PostgresAppStore implements AppStore {
  readonly #pool: Pool;
  readonly #now: () => number;
  readonly #generateAppId: () => string;
  readonly #generateApiKeyId: () => string;
  readonly #generateApiKeySecret: () => string;

  constructor(pool: Pool, options: PostgresAppStoreOptions = {}) {
    const {
      now = Date.now,
      generateAppId = createAppId,
      generateApiKeyId: makeKeyId = createApiKeyId,
      generateApiKeySecret: makeSecret = generateApiKeySecret,
    } = options;
    this.#pool = pool;
    this.#now = now;
    this.#generateAppId = generateAppId;
    this.#generateApiKeyId = makeKeyId;
    this.#generateApiKeySecret = makeSecret;
  }

  async initialize(): Promise<void> {
    await this.#pool.query(SCHEMA);
  }

  async truncate(): Promise<void> {
    await this.#pool.query(
      "TRUNCATE TABLE api_keys, apps RESTART IDENTITY CASCADE",
    );
  }

  close(): void {}

  async create(input?: NewApp): Promise<CreatedApp> {
    const normalized = normalizeNewApp(input);
    const nowMs = this.#now();
    const id = this.#generateAppId();
    const app: App = {
      id,
      name: normalized.name,
      monthlyMessageQuota: normalized.monthlyMessageQuota,
      systemWebhookUrl: normalized.systemWebhookUrl,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    await this.#pool.query(
      "INSERT INTO apps (id, name, monthly_message_quota, system_webhook_url, system_webhook_secret, created_at, updated_at)" +
        " VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [app.id, app.name, app.monthlyMessageQuota, app.systemWebhookUrl,
       normalized.systemWebhookSecret, app.createdAt, app.updatedAt],
    );
    return { ...app, systemWebhookSecret: normalized.systemWebhookSecret };
  }

  async get(id: string): Promise<App | null> {
    const { rows } = await this.#pool.query<AppRow>(
      "SELECT * FROM apps WHERE id = $1",
      [id],
    );
    const row = rows[0];
    return row !== undefined ? rowToApp(row) : null;
  }

  async list(): Promise<readonly App[]> {
    const { rows } = await this.#pool.query<AppRow>(
      "SELECT * FROM apps ORDER BY created_at ASC, id ASC",
    );
    return rows.map(rowToApp);
  }

  async update(id: string, patch: AppUpdate): Promise<App> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<AppRow>(
        "SELECT * FROM apps WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new UnknownAppError(id);
      }
      const next = applyAppUpdate(rowToApp(row), patch, this.#now());
      await client.query(
        "UPDATE apps SET name=$1, monthly_message_quota=$2, system_webhook_url=$3, updated_at=$4 WHERE id=$5",
        [next.name, next.monthlyMessageQuota, next.systemWebhookUrl, next.updatedAt, next.id],
      );
      if ("systemWebhookUrl" in patch) {
        if (next.systemWebhookUrl === null) {
          await client.query(
            "UPDATE apps SET system_webhook_secret = NULL WHERE id = $1",
            [id],
          );
        } else if (row.system_webhook_secret === null) {
          await client.query(
            "UPDATE apps SET system_webhook_secret = $1 WHERE id = $2",
            [generateSystemWebhookSecret(), id],
          );
        }
      }
      await client.query("COMMIT");
      return next;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.#pool.query(
      "DELETE FROM apps WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createApiKey(appId: string): Promise<CreatedApiKey> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<AppRow>(
        "SELECT id FROM apps WHERE id = $1 FOR UPDATE",
        [appId],
      );
      if (rows[0] === undefined) {
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
        lastUsedAt: null,
      };
      await client.query(
        "INSERT INTO api_keys (id, app_id, key_hash, prefix, created_at, revoked_at, last_used_at)" +
          " VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, appId, keyHash, apiKey.prefix, nowMs, null, null],
      );
      await client.query("COMMIT");
      return { apiKey, secret };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async listApiKeys(appId: string): Promise<readonly ApiKey[]> {
    const { rows } = await this.#pool.query<ApiKeyRow>(
      "SELECT * FROM api_keys WHERE app_id = $1 ORDER BY created_at ASC, id ASC",
      [appId],
    );
    return rows.map(rowToApiKey);
  }

  async revokeApiKey(keyId: string): Promise<boolean> {
    const result = await this.#pool.query(
      "UPDATE api_keys SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL",
      [this.#now(), keyId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async authenticate(presentedSecret: string): Promise<App | null> {
    if (typeof presentedSecret !== "string" || presentedSecret.length === 0) {
      return null;
    }
    const hash = hashApiKey(presentedSecret);
    const { rows } = await this.#pool.query<ApiKeyRow>(
      "SELECT * FROM api_keys WHERE key_hash = $1",
      [hash],
    );
    const row = rows[0];
    if (row === undefined || row.revoked_at !== null) {
      return null;
    }
    if (!apiKeyHashesEqual(hash, row.key_hash)) {
      return null;
    }
    await this.#pool.query(
      "UPDATE api_keys SET last_used_at = $1 WHERE id = $2",
      [this.#now(), row.id],
    );
    return this.get(row.app_id);
  }

  async getSystemWebhookConfig(appId: string): Promise<{ url: string; secret: string } | null> {
    const { rows } = await this.#pool.query<{
      system_webhook_url: string | null;
      system_webhook_secret: string | null;
    }>(
      "SELECT system_webhook_url, system_webhook_secret FROM apps WHERE id = $1",
      [appId],
    );
    const row = rows[0];
    if (row === undefined || row.system_webhook_url === null || row.system_webhook_secret === null) {
      return null;
    }
    return { url: row.system_webhook_url, secret: row.system_webhook_secret };
  }

  async rotateSystemWebhookSecret(appId: string): Promise<string> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<AppRow>(
        "SELECT id FROM apps WHERE id = $1 FOR UPDATE",
        [appId],
      );
      if (rows[0] === undefined) {
        throw new UnknownAppError(appId);
      }
      const newSecret = generateSystemWebhookSecret();
      await client.query(
        "UPDATE apps SET system_webhook_secret = $1 WHERE id = $2",
        [newSecret, appId],
      );
      await client.query("COMMIT");
      return newSecret;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
      throw err;
    } finally {
      client.release();
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  id                    TEXT   PRIMARY KEY,
  name                  TEXT   NOT NULL,
  monthly_message_quota BIGINT,
  system_webhook_url    TEXT,
  system_webhook_secret TEXT,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT   PRIMARY KEY,
  app_id       TEXT   NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  key_hash     TEXT   NOT NULL UNIQUE,
  prefix       TEXT   NOT NULL,
  created_at   BIGINT NOT NULL,
  revoked_at   BIGINT,
  last_used_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_app ON api_keys (app_id);
`;
