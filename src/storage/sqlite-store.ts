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
  encodeMessageCursor,
  IdempotencyConflictError,
  isIdempotencyExpired,
  messageFingerprint,
  normalizeNewMessage,
  resolveListMessagesQuery,
  resolvePendingFanoutQuery,
  resolveUsageRange,
  type CreateMessageResult,
  type ListMessagesOptions,
  type ListPendingFanoutOptions,
  type Message,
  type MessagePage,
  type MessageStore,
  type NewMessage,
  type UsageRange,
  type UsageSummary,
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
  readonly channel: string | null;
  readonly deliver_at: number | null;
  readonly created_at: number;
  /** Outbox marker: NULL while the message still owes a fan-out, else the time it was fanned out. */
  readonly fanned_out_at: number | null;
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
    channel: row.channel ?? null,
    deliverAt: row.deliver_at ?? null,
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
  readonly #markFannedOut: StatementSync;
  readonly #listPendingFanout: StatementSync;
  readonly #listByApp: StatementSync;
  readonly #listByAppAfter: StatementSync;
  readonly #listByAppFiltered: StatementSync;
  readonly #listByAppAfterFiltered: StatementSync;
  readonly #listByAppChannel: StatementSync;
  readonly #listByAppAfterChannel: StatementSync;
  readonly #summarizeUsage: StatementSync;

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
    // Bring a database created by a pre-outbox version up to schema, then build
    // the index that depends on the (now-guaranteed) outbox column.
    this.#migrateFanoutColumn();
    // Likewise for the channel column. Existing rows default to NULL (untagged), which
    // is the correct semantic and preserves existing behaviour.
    this.#migrateChannelColumn();
    // Add deliver_at for scheduled delivery. Existing rows default to NULL (immediate),
    // which is the correct semantic for messages created before scheduling existed.
    this.#migrateDeliverAtColumn();
    this.#db.exec(INDEXES);

    this.#selectMessage = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at, fanned_out_at FROM messages WHERE id = ?",
    );
    this.#selectIdempotency = this.#db.prepare(
      "SELECT message_id, fingerprint, stored_at FROM idempotency_keys WHERE app_id = ? AND key = ?",
    );
    this.#insertMessage = this.#db.prepare(
      "INSERT INTO messages (id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
    // Set the marker once: `fanned_out_at IS NULL` makes a repeated call a no-op
    // (idempotent) and preserves the first fan-out time.
    this.#markFannedOut = this.#db.prepare(
      "UPDATE messages SET fanned_out_at = ? WHERE id = ? AND fanned_out_at IS NULL",
    );
    // Oldest-first; the partial index on (created_at, id) WHERE fanned_out_at IS
    // NULL keeps this cheap even as `messages` grows unbounded.
    this.#listPendingFanout = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at, fanned_out_at" +
        " FROM messages WHERE fanned_out_at IS NULL AND created_at <= ?" +
        " ORDER BY created_at ASC, id ASC LIMIT ?",
    );
    // Newest-first page of a tenant's messages (first page). The DESC scan rides
    // idx_messages_app_created backwards; ORDER BY mirrors compareMessagesNewestFirst.
    this.#listByApp = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at, fanned_out_at" +
        " FROM messages WHERE app_id = ?" +
        " ORDER BY created_at DESC, id DESC LIMIT ?",
    );
    // Subsequent pages: the keyset predicate mirrors isMessageAfterCursor — every
    // row strictly older than the cursor's (created_at, id).
    this.#listByAppAfter = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at, fanned_out_at" +
        " FROM messages WHERE app_id = ?" +
        " AND (created_at < ? OR (created_at = ? AND id < ?))" +
        " ORDER BY created_at DESC, id DESC LIMIT ?",
    );
    // Filtered variants: same as above but with an additional event_type = ? predicate.
    // The idx_messages_app_event_created (app_id, event_type, created_at, id) index lets
    // the planner narrow straight to the matching event type before scanning.
    this.#listByAppFiltered = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at, fanned_out_at" +
        " FROM messages WHERE app_id = ? AND event_type = ?" +
        " ORDER BY created_at DESC, id DESC LIMIT ?",
    );
    this.#listByAppAfterFiltered = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at, fanned_out_at" +
        " FROM messages WHERE app_id = ? AND event_type = ?" +
        " AND (created_at < ? OR (created_at = ? AND id < ?))" +
        " ORDER BY created_at DESC, id DESC LIMIT ?",
    );
    // Channel-filtered variants: filter by channel IS NULL or channel = ?
    // The idx_messages_app_channel_created (app_id, channel, created_at, id) index covers this.
    this.#listByAppChannel = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at, fanned_out_at" +
        " FROM messages WHERE app_id = ? AND channel IS ?" +
        " ORDER BY created_at DESC, id DESC LIMIT ?",
    );
    this.#listByAppAfterChannel = this.#db.prepare(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, created_at, fanned_out_at" +
        " FROM messages WHERE app_id = ? AND channel IS ?" +
        " AND (created_at < ? OR (created_at = ? AND id < ?))" +
        " ORDER BY created_at DESC, id DESC LIMIT ?",
    );
    // Per-tenant message usage grouped by UTC day. Integer division `created_at /
    // 1000` yields epoch seconds (created_at is INTEGER ms); `date(…, 'unixepoch')`
    // renders the UTC `YYYY-MM-DD`, mirroring the shared utcDayKey rule. The half-open
    // [from, to) range rides idx_messages_app_created (app_id, created_at, id).
    this.#summarizeUsage = this.#db.prepare(
      "SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n" +
        " FROM messages WHERE app_id = ? AND created_at >= ? AND created_at < ?" +
        " GROUP BY day ORDER BY day ASC",
    );
  }

  /**
   * Add the `channel` column to a database created before channel-based routing existed.
   * Existing rows default to `NULL` (untagged message), which is the correct semantic
   * and preserves existing behaviour. For a fresh database the column is in {@link SCHEMA}
   * and this is a no-op.
   */
  #migrateChannelColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(messages)").all() as {
      name: string;
    }[];
    if (columns.some((c) => c.name === "channel")) {
      return;
    }
    this.#db.exec("ALTER TABLE messages ADD COLUMN channel TEXT");
  }

  /**
   * Add the `deliver_at` column to a database created before scheduled delivery
   * existed. Existing rows default to `NULL` (immediate delivery), which is the
   * correct semantic. For a fresh database the column is in {@link SCHEMA} and
   * this is a no-op.
   */
  #migrateDeliverAtColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(messages)").all() as {
      name: string;
    }[];
    if (columns.some((c) => c.name === "deliver_at")) {
      return;
    }
    this.#db.exec("ALTER TABLE messages ADD COLUMN deliver_at INTEGER");
  }

  /**
   * Ensure the `fanned_out_at` outbox column exists. A database created by a
   * pre-outbox build has the column missing (its `CREATE TABLE IF NOT EXISTS` is
   * a no-op on the existing table); add it, then backfill existing rows as
   * **already fanned out** so an upgrade does not re-deliver the entire history.
   * For a fresh database the column is in {@link SCHEMA} and this is a no-op.
   */
  #migrateFanoutColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(messages)").all() as {
      name: string;
    }[];
    if (columns.some((c) => c.name === "fanned_out_at")) {
      return;
    }
    this.#db.exec("ALTER TABLE messages ADD COLUMN fanned_out_at INTEGER");
    this.#db.exec(
      "UPDATE messages SET fanned_out_at = created_at WHERE fanned_out_at IS NULL",
    );
  }

  /** Number of messages currently held. Convenience for inspection/tests. */
  get size(): number {
    return Number((this.#countMessages.get() as { n: number }).n);
  }

  async create(input: NewMessage): Promise<CreateMessageResult> {
    const { appId, eventType, payload, idempotencyKey: key, channel, deliverAt } =
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
        channel,
        deliverAt,
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
    channel: string | null,
    deliverAt: number | null,
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
          // A retry of an orphaned create (accepted, but its fan-out never
          // completed) still owes a fan-out; report it so ingest can recover.
          return {
            message: rowToMessage(row),
            deduplicated: true,
            fanoutPending: row.fanned_out_at === null,
          };
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
    // fanned_out_at is left unset (NULL) — the message owes a fan-out. Inserting
    // it in this same transaction as the message makes "accepted" and "needs
    // fan-out" a single atomic fact: the read side of the transactional outbox.
    this.#insertMessage.run(id, appId, key, eventType, payload, channel, deliverAt, nowMs);
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
        channel,
        deliverAt,
        createdAt: nowMs,
      },
      deduplicated: false,
      fanoutPending: true,
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

  async markFannedOut(id: string): Promise<void> {
    this.#markFannedOut.run(this.#now(), id);
  }

  async listPendingFanout(
    options?: ListPendingFanoutOptions,
  ): Promise<Message[]> {
    const { limit, createdAtOrBefore } = resolvePendingFanoutQuery(options);
    // SQLite has no Infinity for an INTEGER column; cap at the largest safe
    // integer, which dwarfs any epoch-ms timestamp ("no age cap").
    const cutoff = Number.isFinite(createdAtOrBefore)
      ? Math.floor(createdAtOrBefore)
      : Number.MAX_SAFE_INTEGER;
    const rows = this.#listPendingFanout.all(cutoff, limit) as unknown as
      | MessageRow[];
    return rows.map(rowToMessage);
  }

  async listByApp(
    appId: string,
    options?: ListMessagesOptions,
  ): Promise<MessagePage> {
    const { limit, cursor, eventType, channel } = resolveListMessagesQuery(options);
    // Fetch one extra row: its presence is exactly the signal that a further page
    // exists, without a second COUNT query.
    const fetchLimit = limit + 1;
    const rows = (
      channel !== undefined
        // Channel-filtered: use IS ? predicate (handles null correctly in SQLite)
        ? cursor === null
          ? this.#listByAppChannel.all(appId, channel, fetchLimit)
          : this.#listByAppAfterChannel.all(
              appId,
              channel,
              cursor.createdAt,
              cursor.createdAt,
              cursor.id,
              fetchLimit,
            )
        : eventType === null
          ? cursor === null
            ? this.#listByApp.all(appId, fetchLimit)
            : this.#listByAppAfter.all(
                appId,
                cursor.createdAt,
                cursor.createdAt,
                cursor.id,
                fetchLimit,
              )
          : cursor === null
            ? this.#listByAppFiltered.all(appId, eventType, fetchLimit)
            : this.#listByAppAfterFiltered.all(
                appId,
                eventType,
                cursor.createdAt,
                cursor.createdAt,
                cursor.id,
                fetchLimit,
              )
    ) as unknown as MessageRow[];
    const hasMore = rows.length > limit;
    const messages = (hasMore ? rows.slice(0, limit) : rows).map(rowToMessage);
    const last = messages[messages.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeMessageCursor(last) : null;
    return { messages, nextCursor };
  }

  async summarizeUsageByApp(
    appId: string,
    range: UsageRange,
  ): Promise<UsageSummary> {
    const { fromMs, toMs } = resolveUsageRange(range);
    const rows = this.#summarizeUsage.all(appId, fromMs, toMs) as unknown as {
      day: string;
      n: number;
    }[];
    let total = 0;
    const daily = rows.map((row) => {
      const messages = Number(row.n);
      total += messages;
      return { date: row.day, messages };
    });
    return { appId, fromMs, toMs, total, daily };
  }

  async pruneMessages(olderThanMs: number): Promise<number> {
    // Two-step: prune stale idempotency bindings first (they reference messages),
    // then prune old fanned-out messages. Messages still owing a fan-out are left
    // untouched (fanned_out_at IS NOT NULL guard).
    this.#db.prepare("DELETE FROM idempotency_keys WHERE stored_at < ?").run(olderThanMs);
    const result = this.#db
      .prepare("DELETE FROM messages WHERE created_at < ? AND fanned_out_at IS NOT NULL")
      .run(olderThanMs);
    return Number(result.changes);
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
 *
 * `messages.fanned_out_at` is the transactional outbox marker: NULL means the
 * message still owes a fan-out (it is recorded NULL in the same insert that
 * accepts the message); a timestamp means its fan-out was enqueued. A database
 * created before this column existed is migrated by {@link SqliteMessageStore.#migrateFanoutColumn}.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT    PRIMARY KEY,
  app_id          TEXT    NOT NULL,
  idempotency_key TEXT,
  event_type      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  channel         TEXT,
  deliver_at      INTEGER,
  created_at      INTEGER NOT NULL,
  fanned_out_at   INTEGER
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

/**
 * Indexes, created after {@link SqliteMessageStore.#migrateFanoutColumn} so the
 * `fanned_out_at` column is guaranteed to exist. A **partial** index over only
 * the unfanned rows keeps `listPendingFanout` (and the outbox sweep) an indexed
 * lookup over a near-empty set, even though `messages` itself grows unbounded.
 * `idx_messages_app_created` covers the unfiltered keyset scan; the narrower
 * `idx_messages_app_event_created` covers the `?eventType=` filtered scan —
 * `(app_id, event_type, created_at, id)`, letting the planner skip straight to the
 * matching type. All use `IF NOT EXISTS`, so an existing DB gains them on next open
 * with no migration (they are pure read optimizations over existing rows).
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_messages_pending_fanout
  ON messages (created_at, id) WHERE fanned_out_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_app_created
  ON messages (app_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_messages_app_event_created
  ON messages (app_id, event_type, created_at, id);

CREATE INDEX IF NOT EXISTS idx_messages_app_channel_created
  ON messages (app_id, channel, created_at, id);
`;
