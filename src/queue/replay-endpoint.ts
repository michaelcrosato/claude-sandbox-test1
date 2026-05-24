/**
 * Endpoint message replay — the operator recovery path for a new or recovering endpoint.
 *
 * {@link retryEndpointDeliveries} (in `retry-app.ts`) revives dead-lettered tasks that
 * already exist. This module covers the complementary case: an endpoint that was added
 * *after* historical messages were accepted, or an endpoint that needs its delivery
 * history unconditionally replayed, has no existing tasks to revive — it needs *new*
 * delivery work enqueued against the existing message log.
 *
 * `replayEndpointMessages` pages through the tenant's message history, applies the
 * endpoint's own subscription rules (event-type filter, channel, payload filter), and
 * enqueues a fresh {@link DeliveryTask} for each matching message.  A `limit` bounds
 * the work per call; `hasMore` signals when another call is needed to continue the scan.
 * Optional `since`/`until` epoch-ms bounds narrow the scan to a time window so operators
 * do not need to replay the entire tenant history to catch up after a short outage.
 */

import { selectFanoutTargets } from "../fanout/fanout.js";
import type { Endpoint } from "../endpoints/endpoint.js";
import type { MessageStore } from "../storage/message-store.js";
import type { DeliveryQueue } from "./delivery-queue.js";
import { MAX_LIST_MESSAGES_LIMIT } from "../storage/message-store.js";

/**
 * Maximum messages {@link replayEndpointMessages} may enqueue per call.
 * Operators replay a large history by calling the route repeatedly until
 * `hasMore` is `false`.
 */
export const MAX_REPLAY_LIMIT = 1000;

/** Default per-call enqueue cap for {@link replayEndpointMessages}. */
export const DEFAULT_REPLAY_LIMIT = 100;

/** Internal page size used when scanning the message log. */
const SCAN_PAGE_SIZE = Math.min(200, MAX_LIST_MESSAGES_LIMIT);

/** Options for {@link replayEndpointMessages}. */
export interface ReplayOptions {
  /**
   * Inclusive epoch-ms lower bound — only messages created at or after this
   * timestamp are considered. Absent means no lower bound (scan from the most
   * recent message all the way back).
   */
  readonly since?: number | null;
  /**
   * Exclusive epoch-ms upper bound — only messages created strictly before this
   * timestamp are considered. Absent means no upper bound.
   */
  readonly until?: number | null;
  /**
   * Maximum messages to enqueue this call; `[1, {@link MAX_REPLAY_LIMIT}]`.
   * Defaults to {@link DEFAULT_REPLAY_LIMIT}. When the limit is reached, `hasMore`
   * is `true` and the caller may re-invoke to continue.
   */
  readonly limit?: number;
}

/** The result of a {@link replayEndpointMessages} call. */
export interface ReplayResult {
  /** Number of new delivery tasks enqueued this call. */
  readonly enqueued: number;
  /**
   * `true` when the scan was truncated by `limit` — there are more messages in
   * the time window that may match the endpoint's subscription.  Re-invoke (with
   * the same `since`/`until`) to continue; each call enqueues the next batch.
   * `false` when the entire time window was scanned.
   */
  readonly hasMore: boolean;
}

/** Dependencies for {@link replayEndpointMessages}. */
export interface ReplayDeps {
  readonly messages: MessageStore;
  readonly queue: DeliveryQueue;
}

/**
 * Validate and coerce the `limit` field of {@link ReplayOptions}.
 * Must be a positive integer in `[1, {@link MAX_REPLAY_LIMIT}]`.
 */
export function normalizeReplayLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_REPLAY_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_REPLAY_LIMIT) {
    throw new RangeError(
      `limit must be an integer in [1, ${MAX_REPLAY_LIMIT}]`,
    );
  }
  return value;
}

/**
 * Enqueue fresh delivery tasks for historical messages that match `endpoint`'s
 * subscription — the catch-up path for a newly-added or recovering endpoint.
 *
 * The tenant's message log is scanned newest-first (using the existing
 * {@link MessageStore.listByApp} pagination). For each message inside the optional
 * `[since, until)` time window, the endpoint's full routing rules are applied
 * ({@link selectFanoutTargets}: disabled check, event-type subscription, channel
 * match, payload filter). Matching messages get a fresh `pending` task enqueued;
 * no check for prior delivery history is performed — the caller's intent is to
 * (re-)deliver, and the stable `webhook-id` on each delivery lets the receiver
 * dedup if needed.
 *
 * The scan stops early once `limit` tasks have been enqueued (`hasMore: true`)
 * or the `since` boundary is crossed (`hasMore: false`).
 */
export async function replayEndpointMessages(
  endpoint: Endpoint,
  deps: ReplayDeps,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const since = options.since ?? null;
  const until = options.until ?? null;
  const limit = normalizeReplayLimit(options.limit);

  let enqueued = 0;
  let cursor: string | null = null;
  let limitHit = false;

  scan: while (true) {
    const page = await deps.messages.listByApp(endpoint.appId, {
      limit: SCAN_PAGE_SIZE,
      cursor,
    });

    for (const message of page.messages) {
      // Until bound: skip messages too new (scan is newest-first, so these appear first).
      if (until !== null && message.createdAt >= until) {
        continue;
      }
      // Since bound: messages are newest-first; the first message below `since` means
      // all remaining are also below it — the time window is exhausted.
      if (since !== null && message.createdAt < since) {
        break scan;
      }

      // Apply the endpoint's full routing rules (disabled, eventType, channel, filter).
      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(message.payload);
      } catch {
        parsedPayload = null;
      }
      const { matched } = selectFanoutTargets(
        [endpoint],
        message.eventType,
        message.channel ?? null,
        parsedPayload,
      );

      if (matched.length > 0) {
        if (enqueued >= limit) {
          // A match exists beyond the cap — there is more to replay.
          limitHit = true;
          break scan;
        }
        await deps.queue.enqueue({
          messageId: message.id,
          endpointId: endpoint.id,
          appId: endpoint.appId,
        });
        enqueued++;
      }
    }

    if (page.nextCursor === null) break; // Message log exhausted.
    cursor = page.nextCursor;
  }

  return { enqueued, hasMore: limitHit };
}
