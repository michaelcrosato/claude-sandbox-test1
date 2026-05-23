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
          return { message, deduplicated: true };
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
    if (key !== null) {
      this.#setIdempotency(appId, key, {
        messageId: id,
        fingerprint,
        storedAt: nowMs,
      });
    }
    return { message, deduplicated: false };
  }

  async get(id: string): Promise<Message | null> {
    return this.#messages.get(id) ?? null;
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
