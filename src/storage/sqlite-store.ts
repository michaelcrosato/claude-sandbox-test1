/**
 * A durable {@link MessageStore} backed by SQLite via Node's built-in
 * `node:sqlite` module — **zero third-party dependencies and no native
 * compilation step**. This is what makes Posthorn's "single process, no Redis,
 * SQLite-by-default" wedge real: it runs anywhere Node 22.5+ runs, and survives
 * process restarts (crash-safe replay) without a separate database to operate.
 *
 * It is the durable sibling of {@link InMemoryMessageStore} and is held to the
 * exact same behavioural contract — the two share one validation, dedup, and
 * expiry implementation (see `message-store.ts`) and pass one conformance suite.
 *
 * The schema mirrors the in-memory design's two maps:
 *   - `messages`         — the source of truth, never pruned (Axiom 3 in spirit);
 *   - `idempotency_keys` — the key → message binding that ages out of relevance.
 * `created_at`/`stored_at` are epoch ms; expiry is decided in JS by the shared
 * {@link isIdempotencyExpired} so the two backends cannot drift.
 */

import { createRequire } from "node:module";
import type {
  DatabaseSync as SqliteDatabase,
  StatementSync,
} from "node:sqlite";
import {
  assertValidIdempotencyWindow,
  createMessageId,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  IdempotencyConflictError,
  isIdempotencyExpired,
  messageFingerprint,
  normalizeNewMessage,
  type CreateMessageResult,
  type Message,
  type MessageStore,
  type NewMessage,
} from "./message-store.js";

// `node:sqlite` is loaded through createRequire rather than a static
// `import ... from "node:sqlite"`. It is a genuine Node builtin and works
// either way at runtime, but bundlers whose builtin lists predate it (e.g.
// Vite 5, used by our test runner) choke on the static specifier. Requiring it
// keeps it a runtime builtin lookup and sidesteps that resolution entirely.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** Construction options for {@link SqliteMessageStore}. */
export interface SqliteStoreOptions {
  /**
   * Where to store the database: a filesystem path for durability, or
   * `":memory:"` (the default) for an ephemeral, process-lifetime store.
   */
  location?: string;
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Message-id generator. Defaults to {@link createMessageId}. */
  generateId?: () => string;
  /**
   * How long an idempotency key stays bound to its message, in ms. After this
   * elapses the key is free to be reused for a fresh message. Must be `> 0`;
   * pass `Number.POSITIVE_INFINITY` to never expire keys. Defaults to 24h.
   */
  idempotencyWindowMs?: number;
}

/** Shape of a row from the `messages` table. */
interface MessageRow {
  readonly id: string;
  readonly app_id: string;
  readonly idempotency_key: string | null;
  readonly event_type: string;
  readonly payload: string;
  readonly created_at: number;
}

/** Shape of a row from the `idempotency_keys` table. */
interface IdempotencyRow {
  readonly message_id: string;
  readonly fingerprint: string;
  readonly stored_at: number;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    appId: row.app_id,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export class SqliteMessageStore implements MessageStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #idempotencyWindowMs: number;

  // Statements are prepared once at construction and reused per call.
  readonly #selectMessage: StatementSync;
  readonly #selectIdempotency: StatementSync;
  readonly #insertMessage: StatementSync;
  readonly #insertIdempotency: StatementSync;
  readonly #deleteIdempotency: StatementSync;
  readonly #countMessages: StatementSync;

  constructor(options: SqliteStoreOptions = {}) {
    const {
      location = ":memory:",
      now = Date.now,
      generateId = createMessageId,
      idempotencyWindowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS,
    } = options;
    assertValidIdempotencyWindow(idempotencyWindowMs);
    this.#now = now;
    this.#generateId = generateId;
    this.#idempotencyWindowMs = idempotencyWindowMs;

    this.#db = new DatabaseSync(location);
    // WAL gives crash-safe, concurrent-reader durability for file-backed stores
    // (a no-op for `:memory:`); foreign keys enforce the binding→message link.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);

    this.#selectMessage = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, created_at FROM messages WHERE id = ?",
    );
    this.#selectIdempotency = this.#db.prepare(
      "SELECT message_id, fingerprint, stored_at FROM idempotency_keys WHERE app_id = ? AND key = ?",
    );
    this.#insertMessage = this.#db.prepare(
      "INSERT INTO messages (id, app_id, idempotency_key, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#insertIdempotency = this.#db.prepare(
      "INSERT INTO idempotency_keys (app_id, key, message_id, fingerprint, stored_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.#deleteIdempotency = this.#db.prepare(
      "DELETE FROM idempotency_keys WHERE app_id = ? AND key = ?",
    );
    this.#countMessages = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM messages",
    );
  }

  /** Number of messages currently held. Convenience for inspection/tests. */
  get size(): number {
    return Number((this.#countMessages.get() as { n: number }).n);
  }

  async create(input: NewMessage): Promise<CreateMessageResult> {
    const { appId, eventType, payload, idempotencyKey: key } =
      normalizeNewMessage(input);
    const nowMs = this.#now();
    const fingerprint = messageFingerprint(eventType, payload);

    // BEGIN IMMEDIATE takes the write lock up front, so the check-then-insert
    // for an idempotency key is atomic even across concurrent connections.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#createWithinTransaction(
        appId,
        eventType,
        payload,
        key,
        fingerprint,
        nowMs,
      );
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

  #createWithinTransaction(
    appId: string,
    eventType: string,
    payload: string,
    key: string | null,
    fingerprint: string,
    nowMs: number,
  ): CreateMessageResult {
    if (key !== null) {
      const existing = this.#selectIdempotency.get(appId, key) as
        | IdempotencyRow
        | undefined;
      if (
        existing !== undefined &&
        !isIdempotencyExpired(existing.stored_at, nowMs, this.#idempotencyWindowMs)
      ) {
        if (existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError(key);
        }
        const row = this.#selectMessage.get(existing.message_id) as
          | MessageRow
          | undefined;
        // messages is never pruned, so a live binding always resolves; guard
        // anyway rather than assert.
        if (row !== undefined) {
          return { message: rowToMessage(row), deduplicated: true };
        }
      }
      // Absent or expired: drop any stale binding and fall through to create.
      this.#deleteIdempotency.run(appId, key);
    }

    const id = this.#generateId();
    if (this.#selectMessage.get(id) !== undefined) {
      throw new Error(
        `generated message id "${id}" collides with an existing one`,
      );
    }
    this.#insertMessage.run(id, appId, key, eventType, payload, nowMs);
    if (key !== null) {
      this.#insertIdempotency.run(appId, key, id, fingerprint, nowMs);
    }
    return {
      message: {
        id,
        appId,
        idempotencyKey: key,
        eventType,
        payload,
        createdAt: nowMs,
      },
      deduplicated: false,
    };
  }

  async get(id: string): Promise<Message | null> {
    const row = this.#selectMessage.get(id) as MessageRow | undefined;
    return row === undefined ? null : rowToMessage(row);
  }

  async getByIdempotencyKey(
    appId: string,
    key: string,
  ): Promise<Message | null> {
    const entry = this.#selectIdempotency.get(appId, key) as
      | IdempotencyRow
      | undefined;
    if (
      entry === undefined ||
      isIdempotencyExpired(entry.stored_at, this.#now(), this.#idempotencyWindowMs)
    ) {
      return null;
    }
    const row = this.#selectMessage.get(entry.message_id) as
      | MessageRow
      | undefined;
    return row === undefined ? null : rowToMessage(row);
  }

  /** Close the underlying database handle. Idempotent-safe to call once. */
  close(): void {
    this.#db.close();
  }
}

/**
 * Idempotent schema. `STRICT` enforces declared column types; the foreign key
 * keeps every idempotency binding pointing at a real message. `IF NOT EXISTS`
 * lets a restart reattach to an existing database unchanged (crash-safe replay).
 *
 * Idempotency keys are scoped per tenant: the binding's primary key is the
 * composite `(app_id, key)`, so the same key in two apps is two independent
 * rows and one tenant's key can never resolve another tenant's message.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT    PRIMARY KEY,
  app_id          TEXT    NOT NULL,
  idempotency_key TEXT,
  event_type      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  app_id     TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  message_id TEXT    NOT NULL,
  fingerprint TEXT   NOT NULL,
  stored_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, key),
  FOREIGN KEY (message_id) REFERENCES messages (id)
) STRICT;
`;
