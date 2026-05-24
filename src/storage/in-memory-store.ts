/**
 * An in-memory {@link MessageStore}.
 *
 * The reference backend: zero dependencies, used directly for tests and for
 * embedding Posthorn in a single process where durability across restarts is
 * not required. It is the behavioural specification that the SQLite/Postgres
 * backends (see docs/PROJECT.md) must match.
 *
 * Determinism is preserved by injecting the clock and id generator, mirroring
 * the rest of the core. The map preserves insertion order, so a future `list`
 * can yield messages oldest-first without extra bookkeeping.
 */

import {
  assertValidIdempotencyWindow,
  compareMessagesNewestFirst,
  createMessageId,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  encodeMessageCursor,
  IdempotencyConflictError,
  isIdempotencyExpired,
  isMessageAfterCursor,
  messageFingerprint,
  normalizeNewMessage,
  resolveListMessagesQuery,
  resolvePendingFanoutQuery,
  resolveUsageRange,
  utcDayKey,
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

/** Construction options for {@link InMemoryMessageStore}. */
export interface InMemoryStoreOptions {
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

/** What the store remembers about each live idempotency key. */
interface IdempotencyEntry {
  readonly messageId: string;
  readonly fingerprint: string;
  readonly storedAt: number;
}

export class InMemoryMessageStore implements MessageStore {
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #idempotencyWindowMs: number;
  /** id → message. Insertion order is preserved. */
  readonly #messages = new Map<string, Message>();
  /**
   * appId → (idempotency key → entry). Idempotency keys are scoped per tenant
   * so the same key in two apps is two independent bindings — one tenant's key
   * never dedups against, or leaks, another tenant's message.
   */
  readonly #idempotency = new Map<string, Map<string, IdempotencyEntry>>();
  /**
   * The outbox: ids of messages still owing a fan-out. A message joins on create
   * and leaves on {@link markFannedOut}. The mirror of the SQLite backend's
   * `fanned_out_at IS NULL` rows; iteration order follows `#messages` (creation
   * order), so {@link listPendingFanout} is oldest-first.
   */
  readonly #pendingFanout = new Set<string>();

  constructor(options: InMemoryStoreOptions = {}) {
    const {
      now = Date.now,
      generateId = createMessageId,
      idempotencyWindowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS,
    } = options;
    assertValidIdempotencyWindow(idempotencyWindowMs);
    this.#now = now;
    this.#generateId = generateId;
    this.#idempotencyWindowMs = idempotencyWindowMs;
  }

  /** Number of messages currently held. Convenience for inspection/tests. */
  get size(): number {
    return this.#messages.size;
  }

  async create(input: NewMessage): Promise<CreateMessageResult> {
    const { appId, eventType, payload, idempotencyKey: key } =
      normalizeNewMessage(input);

    const nowMs = this.#now();
    const fingerprint = messageFingerprint(eventType, payload);

    if (key !== null) {
      const existing = this.#idempotency.get(appId)?.get(key);
      if (
        existing !== undefined &&
        !isIdempotencyExpired(existing.storedAt, nowMs, this.#idempotencyWindowMs)
      ) {
        if (existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError(key);
        }
        const message = this.#messages.get(existing.messageId);
        // The message map is the source of truth and is never pruned, so a live
        // index entry always resolves; guard anyway rather than assert.
        if (message !== undefined) {
          // A retry of an orphaned create (accepted, but its fan-out never
          // completed) still owes a fan-out; report it so ingest can recover.
          return {
            message,
            deduplicated: true,
            fanoutPending: this.#pendingFanout.has(message.id),
          };
        }
      }
      // Absent or expired: drop any stale binding and fall through to create.
      this.#deleteIdempotency(appId, key);
    }

    const id = this.#generateId();
    if (this.#messages.has(id)) {
      throw new Error(`generated message id "${id}" collides with an existing one`);
    }
    const message: Message = {
      id,
      appId,
      idempotencyKey: key,
      eventType,
      payload,
      createdAt: nowMs,
    };
    this.#messages.set(id, message);
    // A new message is accepted and recorded as owing a fan-out atomically (one
    // synchronous step here; one transaction in the SQLite backend).
    this.#pendingFanout.add(id);
    if (key !== null) {
      this.#setIdempotency(appId, key, {
        messageId: id,
        fingerprint,
        storedAt: nowMs,
      });
    }
    return { message, deduplicated: false, fanoutPending: true };
  }

  async get(id: string): Promise<Message | null> {
    return this.#messages.get(id) ?? null;
  }

  async markFannedOut(id: string): Promise<void> {
    this.#pendingFanout.delete(id);
  }

  async listPendingFanout(
    options?: ListPendingFanoutOptions,
  ): Promise<Message[]> {
    const { limit, createdAtOrBefore } = resolvePendingFanoutQuery(options);
    const pending: Message[] = [];
    // #messages preserves insertion (creation) order, so this is oldest-first.
    for (const message of this.#messages.values()) {
      if (pending.length >= limit) break;
      if (
        this.#pendingFanout.has(message.id) &&
        message.createdAt <= createdAtOrBefore
      ) {
        pending.push(message);
      }
    }
    return pending;
  }

  async listByApp(
    appId: string,
    options?: ListMessagesOptions,
  ): Promise<MessagePage> {
    const { limit, cursor, eventType } = resolveListMessagesQuery(options);
    // Sort by the shared newest-first comparator (not insertion order) so this
    // matches the SQLite backend exactly, including the id tiebreak when several
    // messages share a createdAt. #messages is never pruned, so this is total.
    const ordered = [...this.#messages.values()]
      .filter((m) => m.appId === appId && (eventType === null || m.eventType === eventType))
      .sort(compareMessagesNewestFirst);
    const after =
      cursor === null
        ? ordered
        : ordered.filter((m) => isMessageAfterCursor(m, cursor));
    // One extra beyond `limit` would remain ⇒ there is a further page.
    const hasMore = after.length > limit;
    const messages = after.slice(0, limit);
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
    const byDay = new Map<string, number>();
    let total = 0;
    for (const message of this.#messages.values()) {
      if (message.appId !== appId) continue;
      // Half-open [fromMs, toMs): a message exactly at fromMs counts; one at toMs does not.
      if (message.createdAt < fromMs || message.createdAt >= toMs) continue;
      const day = utcDayKey(message.createdAt);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      total += 1;
    }
    const daily = [...byDay.entries()]
      .map(([date, messages]) => ({ date, messages }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { appId, fromMs, toMs, total, daily };
  }

  async getByIdempotencyKey(
    appId: string,
    key: string,
  ): Promise<Message | null> {
    const entry = this.#idempotency.get(appId)?.get(key);
    if (
      entry === undefined ||
      isIdempotencyExpired(entry.storedAt, this.#now(), this.#idempotencyWindowMs)
    ) {
      return null;
    }
    return this.#messages.get(entry.messageId) ?? null;
  }

  /** Bind `key` to an entry within `appId`'s namespace, creating it if needed. */
  #setIdempotency(appId: string, key: string, entry: IdempotencyEntry): void {
    let perApp = this.#idempotency.get(appId);
    if (perApp === undefined) {
      perApp = new Map<string, IdempotencyEntry>();
      this.#idempotency.set(appId, perApp);
    }
    perApp.set(key, entry);
  }

  /** Drop `key` from `appId`'s namespace, pruning the namespace when empty. */
  #deleteIdempotency(appId: string, key: string): void {
    const perApp = this.#idempotency.get(appId);
    if (perApp === undefined) return;
    perApp.delete(key);
    if (perApp.size === 0) this.#idempotency.delete(appId);
  }
}
