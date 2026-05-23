/**
 * An in-memory {@link DeliveryAttemptStore}.
 *
 * The reference backend: zero dependencies, the behavioural specification the
 * durable SQLite backend must match. Ideal for embedding Posthorn in a single
 * process where audit durability across restarts is not required, and for tests.
 *
 * Attempts are held in an insertion-ordered map of immutable records. Insertion
 * order is the read order (oldest-first), matching the SQLite backend's `rowid`
 * order — and since the worker records attempts as they happen, that order is
 * chronological. Records are never mutated or removed (append-only audit log).
 */

import {
  createAttemptId,
  normalizeNewAttempt,
  type DeliveryAttempt,
  type DeliveryAttemptStore,
  type NewDeliveryAttempt,
} from "./delivery-attempt.js";

/** Construction options for {@link InMemoryDeliveryAttemptStore}. */
export interface InMemoryDeliveryAttemptStoreOptions {
  /** Attempt-id generator. Defaults to {@link createAttemptId}. */
  generateId?: () => string;
}

export class InMemoryDeliveryAttemptStore implements DeliveryAttemptStore {
  readonly #generateId: () => string;
  /** attempt id → immutable record. Insertion order is preserved (oldest-first). */
  readonly #attempts = new Map<string, DeliveryAttempt>();

  constructor(options: InMemoryDeliveryAttemptStoreOptions = {}) {
    this.#generateId = options.generateId ?? createAttemptId;
  }

  /** Number of attempts recorded (append-only — never decreases). */
  get size(): number {
    return this.#attempts.size;
  }

  async record(input: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    const normalized = normalizeNewAttempt(input);
    const id = this.#generateId();
    if (this.#attempts.has(id)) {
      throw new Error(`generated attempt id "${id}" collides with an existing one`);
    }
    const attempt: DeliveryAttempt = { id, ...normalized };
    this.#attempts.set(id, attempt);
    return attempt;
  }

  async listByMessage(messageId: string): Promise<readonly DeliveryAttempt[]> {
    const out: DeliveryAttempt[] = [];
    // Map iteration is insertion order → oldest-first, matching SQLite's rowid.
    for (const attempt of this.#attempts.values()) {
      if (attempt.messageId === messageId) out.push(attempt);
    }
    return out;
  }
}
