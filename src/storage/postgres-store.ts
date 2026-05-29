/**
 * A durable {@link MessageStore} backed by PostgreSQL via the `pg` driver.
 *
 * This is the horizontally-scalable sibling of {@link SqliteMessageStore}:
 * multiple Posthorn processes can share the same Postgres database, enabling
 * active/active deployments and the hosted cloud tier. The storage contract is
 * identical — both backends pass the same conformance suite in
 * `conformance.ts`.
 *
 * Differences from the SQLite backend worth noting:
 *  - Epoch-ms timestamps are stored as `BIGINT` (SQLite `INTEGER` is 64-bit
 *    natively; PostgreSQL `INTEGER` is 32-bit — not enough for epoch ms).
 *  - `BEGIN` is used for transactions (PostgreSQL uses MVCC; `BEGIN IMMEDIATE`
 *    is not needed — a `READ COMMITTED` transaction is serializable for the
 *    check-then-insert idiom when combined with an index).
 *  - UTC-day bucketing uses `TO_CHAR(TO_TIMESTAMP(created_at / 1000.0), 'YYYY-MM-DD')`.
 *  - A dedicated `initialize()` method creates/migrates the schema (the SQLite
 *    version does this in the constructor synchronously; Postgres requires async).
 */

import type { Pool, PoolClient } from "pg";
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
  type MessageCursor,
  type MessagePage,
  type MessageStore,
  type NewMessage,
  type UsageRange,
  type UsageSummary,
} from "./message-store.js";

export interface PostgresMessageStoreOptions {
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Message-id generator. Defaults to {@link createMessageId}. */
  generateId?: () => string;
  /**
   * How long an idempotency key stays bound, in ms. Defaults to 24h.
   * Pass `Number.POSITIVE_INFINITY` to never expire keys.
   */
  idempotencyWindowMs?: number;
}

interface MessageRow {
  readonly id: string;
  readonly app_id: string;
  readonly idempotency_key: string | null;
  readonly event_type: string;
  readonly payload: string;
  readonly channel: string | null;
  readonly deliver_at: string | null; // pg returns BIGINT as string
  readonly expires_at: string | null; // pg returns BIGINT as string
  readonly priority: string;
  readonly created_at: string; // pg returns BIGINT as string
  readonly fanned_out_at: string | null;
}

interface IdempotencyRow {
  readonly message_id: string;
  readonly fingerprint: string;
  readonly stored_at: string; // BIGINT as string
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    appId: row.app_id,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    payload: row.payload,
    channel: row.channel ?? null,
    deliverAt: row.deliver_at !== null ? Number(row.deliver_at) : null,
    expiresAt: row.expires_at !== null ? Number(row.expires_at) : null,
    priority: (row.priority ?? "normal") as import("./message-store.js").MessagePriority,
    createdAt: Number(row.created_at),
  };
}

export class PostgresMessageStore implements MessageStore {
  readonly #pool: Pool;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #idempotencyWindowMs: number;

  constructor(pool: Pool, options: PostgresMessageStoreOptions = {}) {
    const {
      now = Date.now,
      generateId = createMessageId,
      idempotencyWindowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS,
    } = options;
    assertValidIdempotencyWindow(idempotencyWindowMs);
    this.#pool = pool;
    this.#now = now;
    this.#generateId = generateId;
    this.#idempotencyWindowMs = idempotencyWindowMs;
  }

  /** Create tables and indexes. Idempotent — safe to call on every boot. */
  async initialize(): Promise<void> {
    await this.#pool.query(SCHEMA);
    // Additive migration: add deliver_at to existing databases created before
    // scheduled delivery was introduced. No-op for fresh tables that already
    // have the column from the CREATE TABLE above.
    await this.#pool.query(
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS deliver_at BIGINT",
    );
    // Additive migration: add expires_at for message expiry. No-op for fresh tables.
    await this.#pool.query(
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at BIGINT",
    );
    // Additive migration: add priority for delivery ordering. Existing rows default to 'normal'.
    await this.#pool.query(
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'",
    );
    await this.#pool.query(INDEXES);
  }

  /** Truncate all tables owned by this store. For testing only. */
  async truncate(): Promise<void> {
    await this.#pool.query(
      "TRUNCATE TABLE messages, idempotency_keys RESTART IDENTITY CASCADE",
    );
  }

  /** No-op — pool lifecycle is managed by the caller. */
  close(): void {}

  async create(input: NewMessage): Promise<CreateMessageResult> {
    const { appId, eventType, payload, idempotencyKey: key, channel, deliverAt, expiresAt, priority } =
      normalizeNewMessage(input);
    const nowMs = this.#now();
    const fingerprint = messageFingerprint(eventType, payload);

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.#createWithinTransaction(
        client,
        appId,
        eventType,
        payload,
        channel,
        deliverAt,
        expiresAt,
        priority,
        key,
        fingerprint,
        nowMs,
      );
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already aborted
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async #createWithinTransaction(
    client: PoolClient,
    appId: string,
    eventType: string,
    payload: string,
    channel: string | null,
    deliverAt: number | null,
    expiresAt: number | null,
    priority: import("./message-store.js").MessagePriority,
    key: string | null,
    fingerprint: string,
    nowMs: number,
  ): Promise<CreateMessageResult> {
    if (key !== null) {
      const { rows } = await client.query<IdempotencyRow>(
        "SELECT message_id, fingerprint, stored_at FROM idempotency_keys WHERE app_id = $1 AND key = $2",
        [appId, key],
      );
      const existing = rows[0];
      if (
        existing !== undefined &&
        !isIdempotencyExpired(Number(existing.stored_at), nowMs, this.#idempotencyWindowMs)
      ) {
        if (existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError(key);
        }
        const { rows: msgRows } = await client.query<MessageRow>(
          "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, expires_at, priority, created_at, fanned_out_at FROM messages WHERE id = $1",
          [existing.message_id],
        );
        const row = msgRows[0];
        if (row !== undefined) {
          return {
            message: rowToMessage(row),
            deduplicated: true,
            fanoutPending: row.fanned_out_at === null,
          };
        }
      }
      await client.query(
        "DELETE FROM idempotency_keys WHERE app_id = $1 AND key = $2",
        [appId, key],
      );
    }

    const id = this.#generateId();
    await client.query(
      "INSERT INTO messages (id, app_id, idempotency_key, event_type, payload, channel, deliver_at, expires_at, priority, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [id, appId, key, eventType, payload, channel, deliverAt, expiresAt, priority, nowMs],
    );
    if (key !== null) {
      await client.query(
        "INSERT INTO idempotency_keys (app_id, key, message_id, fingerprint, stored_at) VALUES ($1, $2, $3, $4, $5)",
        [appId, key, id, fingerprint, nowMs],
      );
    }
    return {
      message: { id, appId, idempotencyKey: key, eventType, payload, channel, deliverAt, expiresAt, priority, createdAt: nowMs },
      deduplicated: false,
      fanoutPending: true,
    };
  }

  async get(id: string): Promise<Message | null> {
    const { rows } = await this.#pool.query<MessageRow>(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, expires_at, priority, created_at, fanned_out_at FROM messages WHERE id = $1",
      [id],
    );
    const row = rows[0];
    return row !== undefined ? rowToMessage(row) : null;
  }

  async getByIdempotencyKey(appId: string, key: string): Promise<Message | null> {
    const { rows } = await this.#pool.query<IdempotencyRow>(
      "SELECT message_id, fingerprint, stored_at FROM idempotency_keys WHERE app_id = $1 AND key = $2",
      [appId, key],
    );
    const entry = rows[0];
    if (
      entry === undefined ||
      isIdempotencyExpired(Number(entry.stored_at), this.#now(), this.#idempotencyWindowMs)
    ) {
      return null;
    }
    return this.get(entry.message_id);
  }

  async markFannedOut(id: string): Promise<void> {
    await this.#pool.query(
      "UPDATE messages SET fanned_out_at = $1 WHERE id = $2 AND fanned_out_at IS NULL",
      [this.#now(), id],
    );
  }

  async listPendingFanout(options?: ListPendingFanoutOptions): Promise<Message[]> {
    const { limit, createdAtOrBefore } = resolvePendingFanoutQuery(options);
    const cutoff = Number.isFinite(createdAtOrBefore)
      ? Math.floor(createdAtOrBefore)
      : Number.MAX_SAFE_INTEGER;
    const { rows } = await this.#pool.query<MessageRow>(
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, expires_at, created_at, fanned_out_at" +
        " FROM messages WHERE fanned_out_at IS NULL AND created_at <= $1" +
        " ORDER BY created_at ASC, id ASC LIMIT $2",
      [cutoff, limit],
    );
    return rows.map(rowToMessage);
  }

  async listByApp(appId: string, options?: ListMessagesOptions): Promise<MessagePage> {
    const { limit, cursor, eventType, channel, after, before } =
      resolveListMessagesQuery(options);
    const fetchLimit = limit + 1;
    const sel = "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, expires_at, priority, created_at, fanned_out_at FROM messages";
    let rows: MessageRow[];

    if (after !== undefined || before !== undefined) {
      // Range-filtered listing (inspection query): compose the predicate
      // dynamically rather than enumerate every channel×eventType×cursor×range
      // combination. Same predicate columns → same index usage.
      rows = await this.#listByAppRanged({ appId, eventType, channel, cursor, after, before, fetchLimit });
    } else if (channel !== undefined) {
      // Channel filter: use IS NOT DISTINCT FROM to match both NULL and string values
      if (eventType === null) {
        if (cursor === null) {
          ({ rows } = await this.#pool.query<MessageRow>(
            sel + " WHERE app_id = $1 AND channel IS NOT DISTINCT FROM $2" +
              " ORDER BY created_at DESC, id DESC LIMIT $3",
            [appId, channel, fetchLimit],
          ));
        } else {
          ({ rows } = await this.#pool.query<MessageRow>(
            sel + " WHERE app_id = $1 AND channel IS NOT DISTINCT FROM $2" +
              " AND (created_at < $3 OR (created_at = $4 AND id < $5))" +
              " ORDER BY created_at DESC, id DESC LIMIT $6",
            [appId, channel, cursor.createdAt, cursor.createdAt, cursor.id, fetchLimit],
          ));
        }
      } else {
        if (cursor === null) {
          ({ rows } = await this.#pool.query<MessageRow>(
            sel + " WHERE app_id = $1 AND event_type = $2 AND channel IS NOT DISTINCT FROM $3" +
              " ORDER BY created_at DESC, id DESC LIMIT $4",
            [appId, eventType, channel, fetchLimit],
          ));
        } else {
          ({ rows } = await this.#pool.query<MessageRow>(
            sel + " WHERE app_id = $1 AND event_type = $2 AND channel IS NOT DISTINCT FROM $3" +
              " AND (created_at < $4 OR (created_at = $5 AND id < $6))" +
              " ORDER BY created_at DESC, id DESC LIMIT $7",
            [appId, eventType, channel, cursor.createdAt, cursor.createdAt, cursor.id, fetchLimit],
          ));
        }
      }
    } else if (eventType === null) {
      if (cursor === null) {
        ({ rows } = await this.#pool.query<MessageRow>(
          sel + " WHERE app_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
          [appId, fetchLimit],
        ));
      } else {
        ({ rows } = await this.#pool.query<MessageRow>(
          sel + " WHERE app_id = $1" +
            " AND (created_at < $2 OR (created_at = $3 AND id < $4))" +
            " ORDER BY created_at DESC, id DESC LIMIT $5",
          [appId, cursor.createdAt, cursor.createdAt, cursor.id, fetchLimit],
        ));
      }
    } else {
      if (cursor === null) {
        ({ rows } = await this.#pool.query<MessageRow>(
          sel + " WHERE app_id = $1 AND event_type = $2" +
            " ORDER BY created_at DESC, id DESC LIMIT $3",
          [appId, eventType, fetchLimit],
        ));
      } else {
        ({ rows } = await this.#pool.query<MessageRow>(
          sel + " WHERE app_id = $1 AND event_type = $2" +
            " AND (created_at < $3 OR (created_at = $4 AND id < $5))" +
            " ORDER BY created_at DESC, id DESC LIMIT $6",
          [appId, eventType, cursor.createdAt, cursor.createdAt, cursor.id, fetchLimit],
        ));
      }
    }

    const hasMore = rows.length > limit;
    const messages = (hasMore ? rows.slice(0, limit) : rows).map(rowToMessage);
    const last = messages[messages.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeMessageCursor(last) : null;
    return { messages, nextCursor };
  }

  /**
   * Dynamic-predicate variant of {@link listByApp}, used only when a `createdAt`
   * range bound (`after`/`before`) is present. Mirrors the SQLite store's ranged
   * path: composes `event_type = $n`, `channel IS NOT DISTINCT FROM $n`, the keyset
   * cursor clause, and the half-open `[after, before)` range, allocating `$n`
   * placeholders as it goes.
   */
  async #listByAppRanged(q: {
    appId: string;
    eventType: string | null;
    channel: string | null | undefined;
    cursor: MessageCursor | null;
    after: number | undefined;
    before: number | undefined;
    fetchLimit: number;
  }): Promise<MessageRow[]> {
    const params: (string | number | null)[] = [];
    const ph = (value: string | number | null): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [`app_id = ${ph(q.appId)}`];
    if (q.channel !== undefined) {
      where.push(`channel IS NOT DISTINCT FROM ${ph(q.channel)}`);
    }
    if (q.eventType !== null) {
      where.push(`event_type = ${ph(q.eventType)}`);
    }
    if (q.after !== undefined) {
      where.push(`created_at >= ${ph(q.after)}`);
    }
    if (q.before !== undefined) {
      where.push(`created_at < ${ph(q.before)}`);
    }
    if (q.cursor !== null) {
      where.push(
        `(created_at < ${ph(q.cursor.createdAt)} OR (created_at = ${ph(q.cursor.createdAt)} AND id < ${ph(q.cursor.id)}))`,
      );
    }
    const limitPh = ph(q.fetchLimit);
    const sql =
      "SELECT id, app_id, idempotency_key, event_type, payload, channel, deliver_at, expires_at, priority, created_at, fanned_out_at FROM messages WHERE " +
      where.join(" AND ") +
      ` ORDER BY created_at DESC, id DESC LIMIT ${limitPh}`;
    const { rows } = await this.#pool.query<MessageRow>(sql, params);
    return rows;
  }

  async summarizeUsageByApp(appId: string, range: UsageRange): Promise<UsageSummary> {
    const { fromMs, toMs } = resolveUsageRange(range);
    const { rows } = await this.#pool.query<{ day: string; n: string }>(
      "SELECT TO_CHAR(TO_TIMESTAMP(created_at / 1000.0), 'YYYY-MM-DD') AS day, COUNT(*) AS n" +
        " FROM messages WHERE app_id = $1 AND created_at >= $2 AND created_at < $3" +
        " GROUP BY day ORDER BY day ASC",
      [appId, fromMs, toMs],
    );
    let total = 0;
    const daily = rows.map((row) => {
      const messages = Number(row.n);
      total += messages;
      return { date: row.day, messages };
    });
    return { appId, fromMs, toMs, total, daily };
  }

  async pruneMessages(olderThanMs: number): Promise<number> {
    await this.#pool.query(
      "DELETE FROM idempotency_keys WHERE stored_at < $1",
      [olderThanMs],
    );
    const result = await this.#pool.query(
      "DELETE FROM messages WHERE created_at < $1 AND fanned_out_at IS NOT NULL",
      [olderThanMs],
    );
    return result.rowCount ?? 0;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT    PRIMARY KEY,
  app_id          TEXT    NOT NULL,
  idempotency_key TEXT,
  event_type      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  channel         TEXT,
  deliver_at      BIGINT,
  expires_at      BIGINT,
  priority        TEXT    NOT NULL DEFAULT 'normal',
  created_at      BIGINT  NOT NULL,
  fanned_out_at   BIGINT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  app_id      TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  message_id  TEXT    NOT NULL,
  fingerprint TEXT    NOT NULL,
  stored_at   BIGINT  NOT NULL,
  PRIMARY KEY (app_id, key),
  FOREIGN KEY (message_id) REFERENCES messages (id)
);
`;

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
