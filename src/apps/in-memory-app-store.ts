/**
 * An in-memory {@link AppStore}.
 *
 * The reference backend: zero dependencies, the behavioural specification the
 * durable backends must match. Ideal for embedding Posthorn in a single process
 * and for tests.
 *
 * Apps and API keys are held in insertion-ordered maps as immutable snapshots —
 * each mutation replaces the entry with a fresh value, so a snapshot a caller
 * already holds never changes underneath them. Insertion order is the
 * {@link AppStore.list}/{@link AppStore.listApiKeys} order (oldest-first),
 * matching the SQLite backend's `rowid` order. A second index maps a key's hash
 * to its id so {@link AppStore.authenticate} is O(1), mirroring the SQLite hash
 * index.
 *
 * Determinism is preserved by injecting the clock, id generators, and secret
 * generator, mirroring the rest of the core.
 */

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

/** Construction options for {@link InMemoryAppStore}. */
export interface InMemoryAppStoreOptions {
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  now?: () => number;
  /** App-id generator. Defaults to {@link createAppId}. */
  generateAppId?: () => string;
  /** API-key-id generator. Defaults to {@link createApiKeyId}. */
  generateApiKeyId?: () => string;
  /** API-key-secret generator. Defaults to {@link generateApiKeySecret}. */
  generateApiKeySecret?: () => string;
}

/** Internal record: an {@link ApiKey} plus the secret hash used for lookup. */
interface StoredApiKey {
  readonly key: ApiKey;
  readonly keyHash: string;
}

export class InMemoryAppStore implements AppStore {
  readonly #now: () => number;
  readonly #generateAppId: () => string;
  readonly #generateApiKeyId: () => string;
  readonly #generateApiKeySecret: () => string;

  /** appId → immutable app snapshot. Insertion order is preserved. */
  readonly #apps = new Map<string, App>();
  /** keyId → stored key record. Insertion order is preserved. */
  readonly #keys = new Map<string, StoredApiKey>();
  /** keyHash → keyId, the authenticate lookup index. */
  readonly #byHash = new Map<string, string>();

  constructor(options: InMemoryAppStoreOptions = {}) {
    const {
      now = Date.now,
      generateAppId: makeAppId = createAppId,
      generateApiKeyId: makeKeyId = createApiKeyId,
      generateApiKeySecret: makeSecret = generateApiKeySecret,
    } = options;
    this.#now = now;
    this.#generateAppId = makeAppId;
    this.#generateApiKeyId = makeKeyId;
    this.#generateApiKeySecret = makeSecret;
  }

  /** Number of apps currently held. Convenience for inspection/tests. */
  get size(): number {
    return this.#apps.size;
  }

  async create(input?: NewApp): Promise<App> {
    const normalized = normalizeNewApp(input);
    const nowMs = this.#now();
    const id = this.#generateAppId();
    if (this.#apps.has(id)) {
      throw new Error(`generated app id "${id}" collides with an existing one`);
    }
    const app: App = {
      id,
      name: normalized.name,
      monthlyMessageQuota: normalized.monthlyMessageQuota,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this.#apps.set(id, app);
    return app;
  }

  async get(id: string): Promise<App | null> {
    return this.#apps.get(id) ?? null;
  }

  async list(): Promise<readonly App[]> {
    // Map iteration is insertion order → oldest-first.
    return [...this.#apps.values()];
  }

  async update(id: string, patch: AppUpdate): Promise<App> {
    const current = this.#apps.get(id);
    if (current === undefined) {
      throw new UnknownAppError(id);
    }
    const next = applyAppUpdate(current, patch, this.#now());
    this.#apps.set(id, next); // same key → keeps insertion order
    return next;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.#apps.delete(id)) {
      return false;
    }
    // Cascade: drop the app's keys and their hash-index entries.
    for (const [keyId, stored] of this.#keys) {
      if (stored.key.appId === id) {
        this.#keys.delete(keyId);
        this.#byHash.delete(stored.keyHash);
      }
    }
    return true;
  }

  async createApiKey(appId: string): Promise<CreatedApiKey> {
    if (!this.#apps.has(appId)) {
      throw new UnknownAppError(appId);
    }
    const nowMs = this.#now();
    const id = this.#generateApiKeyId();
    if (this.#keys.has(id)) {
      throw new Error(`generated api key id "${id}" collides with an existing one`);
    }
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
    this.#keys.set(id, { key: apiKey, keyHash });
    this.#byHash.set(keyHash, id);
    return { apiKey, secret };
  }

  async listApiKeys(appId: string): Promise<readonly ApiKey[]> {
    const out: ApiKey[] = [];
    for (const stored of this.#keys.values()) {
      if (stored.key.appId === appId) out.push(stored.key);
    }
    return out;
  }

  async revokeApiKey(keyId: string): Promise<boolean> {
    const stored = this.#keys.get(keyId);
    if (stored === undefined || stored.key.revokedAt !== null) {
      return false;
    }
    const revoked: ApiKey = { ...stored.key, revokedAt: this.#now() };
    // Keep the hash index so a revoked key resolves to a record we can reject,
    // rather than silently looking like an unknown key.
    this.#keys.set(keyId, { key: revoked, keyHash: stored.keyHash });
    return true;
  }

  async authenticate(presentedSecret: string): Promise<App | null> {
    if (typeof presentedSecret !== "string" || presentedSecret.length === 0) {
      return null;
    }
    const hash = hashApiKey(presentedSecret);
    const keyId = this.#byHash.get(hash);
    if (keyId === undefined) {
      return null;
    }
    const stored = this.#keys.get(keyId);
    if (stored === undefined || stored.key.revokedAt !== null) {
      return null;
    }
    if (!apiKeyHashesEqual(hash, stored.keyHash)) {
      return null; // defense-in-depth; the index match makes this unreachable
    }
    // Record last-used time on successful authentication.
    const updated: ApiKey = { ...stored.key, lastUsedAt: this.#now() };
    this.#keys.set(keyId, { key: updated, keyHash: stored.keyHash });
    return this.#apps.get(stored.key.appId) ?? null;
  }
}
