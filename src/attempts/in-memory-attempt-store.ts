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
  compareAttemptsOldestFirst,
  createAttemptId,
  encodeAttemptCursor,
  isAttemptAfterCursor,
  normalizeNewAttempt,
  resolveListAttemptsQuery,
  type AttemptPage,
  type AttemptUsageDay,
  type AttemptUsageSummary,
  type DeliveryAttempt,
  type DeliveryAttemptStore,
  type EndpointStats,
  type EndpointStatsDay,
  type ListAttemptsOptions,
  type NewDeliveryAttempt,
} from "./delivery-attempt.js";
import {
  resolveUsageRange,
  utcDayKey,
  type UsageRange,
} from "../storage/message-store.js";
import { emptyDeliveryFailureCounts } from "../delivery/failure-reason.js";

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

  async listByMessage(messageId: string, options: ListAttemptsOptions = {}): Promise<AttemptPage> {
    const { limit, cursor } = resolveListAttemptsQuery(options);
    // Collect all candidates, sort oldest-first, then apply cursor.
    let candidates: DeliveryAttempt[] = [];
    for (const attempt of this.#attempts.values()) {
      if (attempt.messageId === messageId) candidates.push(attempt);
    }
    candidates.sort(compareAttemptsOldestFirst);
    if (cursor !== null) {
      candidates = candidates.filter((a) => isAttemptAfterCursor(a, cursor));
    }
    // Take limit+1 to detect whether a next page exists.
    const hasMore = candidates.length > limit;
    const page = candidates.slice(0, limit);
    return {
      data: page,
      nextCursor: hasMore ? encodeAttemptCursor(page[page.length - 1]!) : null,
    };
  }

  async listByTask(taskId: string, options: ListAttemptsOptions = {}): Promise<AttemptPage> {
    const { limit, cursor } = resolveListAttemptsQuery(options);
    let candidates: DeliveryAttempt[] = [];
    for (const attempt of this.#attempts.values()) {
      if (attempt.taskId === taskId) candidates.push(attempt);
    }
    candidates.sort(compareAttemptsOldestFirst);
    if (cursor !== null) {
      candidates = candidates.filter((a) => isAttemptAfterCursor(a, cursor));
    }
    const hasMore = candidates.length > limit;
    const page = candidates.slice(0, limit);
    return {
      data: page,
      nextCursor: hasMore ? encodeAttemptCursor(page[page.length - 1]!) : null,
    };
  }

  async pruneOldAttempts(olderThanMs: number): Promise<number> {
    let deleted = 0;
    for (const [id, attempt] of this.#attempts) {
      if (attempt.attemptedAt < olderThanMs) {
        this.#attempts.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async summarizeAttemptsByApp(
    appId: string,
    range: UsageRange,
  ): Promise<AttemptUsageSummary> {
    const { fromMs, toMs } = resolveUsageRange(range);
    const byDay = new Map<string, { attempts: number; succeeded: number; failed: number }>();
    let total = 0;
    let succeeded = 0;
    let failed = 0;
    for (const attempt of this.#attempts.values()) {
      // A null-tenant attempt (vanished message) belongs to no app; `=== appId`
      // excludes it, matching the SQLite `app_id = ?` predicate (NULL never equals).
      if (attempt.appId !== appId) continue;
      // Half-open [fromMs, toMs): an attempt exactly at fromMs counts; one at toMs does not.
      if (attempt.attemptedAt < fromMs || attempt.attemptedAt >= toMs) continue;
      const day = utcDayKey(attempt.attemptedAt);
      const bucket = byDay.get(day) ?? { attempts: 0, succeeded: 0, failed: 0 };
      bucket.attempts += 1;
      total += 1;
      if (attempt.outcome === "succeeded") {
        bucket.succeeded += 1;
        succeeded += 1;
      } else {
        bucket.failed += 1;
        failed += 1;
      }
      byDay.set(day, bucket);
    }
    const daily: AttemptUsageDay[] = [...byDay.entries()]
      .map(([date, c]) => ({ date, attempts: c.attempts, succeeded: c.succeeded, failed: c.failed }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { appId, fromMs, toMs, total, succeeded, failed, daily };
  }

  async statsByEndpoint(endpointId: string, range: UsageRange): Promise<EndpointStats> {
    const { fromMs, toMs } = resolveUsageRange(range);
    const byDay = new Map<string, { attempts: number; succeeded: number; failed: number }>();
    const failureReasons = emptyDeliveryFailureCounts();
    let total = 0;
    let succeeded = 0;
    let failed = 0;
    let totalDurationMs = 0;
    for (const attempt of this.#attempts.values()) {
      if (attempt.endpointId !== endpointId) continue;
      if (attempt.attemptedAt < fromMs || attempt.attemptedAt >= toMs) continue;
      const day = utcDayKey(attempt.attemptedAt);
      const bucket = byDay.get(day) ?? { attempts: 0, succeeded: 0, failed: 0 };
      bucket.attempts += 1;
      total += 1;
      totalDurationMs += attempt.durationMs;
      if (attempt.outcome === "succeeded") {
        bucket.succeeded += 1;
        succeeded += 1;
      } else {
        bucket.failed += 1;
        failed += 1;
        // A classified failure folds into its reason bucket; a legacy null-reason
        // failed attempt has no cause to attribute and is left out (still in `failed`).
        if (attempt.failureReason !== null) failureReasons[attempt.failureReason] += 1;
      }
      byDay.set(day, bucket);
    }
    const daily: EndpointStatsDay[] = [...byDay.entries()]
      .map(([date, c]) => ({ date, attempts: c.attempts, succeeded: c.succeeded, failed: c.failed }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      endpointId,
      fromMs,
      toMs,
      total,
      succeeded,
      failed,
      successRate: total > 0 ? Math.round((succeeded / total) * 10_000) / 10_000 : null,
      avgDurationMs: total > 0 ? Math.round(totalDurationMs / total) : null,
      daily,
      failureReasons,
    };
  }
}
