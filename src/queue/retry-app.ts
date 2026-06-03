/**
 * Bulk delivery retry — the tenant-wide recovery path for dead-lettered deliveries.
 *
 * {@link retryMessageDeliveries} (in `retry-message.ts`) revives dead-lettered
 * deliveries for a **single message**. This module is its tenant-wide counterpart:
 * when a receiver is fixed after an outage that dead-lettered many deliveries across
 * many messages, the operator should not have to list every affected message and call
 * `POST /v1/messages/:id/retry` for each one. One call to
 * `POST /v1/deliveries/retry` drains the tenant's dead-letter backlog.
 *
 * Like {@link retryMessageDeliveries}, this is thin orchestration over the durable
 * primitives: it lists dead-lettered tasks ({@link DeliveryQueue.listByApp} with
 * `status: "dead_letter"`) and re-drives each one ({@link DeliveryQueue.retry}).
 * Pagination bounds the work per call; `hasMore` signals when another call is needed.
 */

import { DeliveryStateError } from "../delivery/delivery-state.js";
import {
  MAX_LIST_DELIVERIES_LIMIT,
  UnknownDeliveryTaskError,
  type DeliveryQueue,
} from "./delivery-queue.js";

/**
 * Re-drive up to `limit` **dead-lettered** deliveries for `endpointId` — the
 * per-endpoint recovery path once a specific failing receiver is fixed.
 *
 * Complements {@link retryAppDeliveries} (tenant-wide) and
 * `retryMessageDeliveries` (per-message): an operator whose Stripe endpoint
 * was down for hours now targets exactly those dead-lettered deliveries without
 * touching healthy endpoints.
 *
 * Like {@link retryAppDeliveries}, revived tasks are no longer `dead_letter` on
 * the next call, so re-invocation naturally fetches the next batch. Concurrent
 * revives and unknown ids are absorbed silently.
 */
export async function retryEndpointDeliveries(
  endpointId: string,
  deps: RetryAppDeps,
  options: { readonly limit?: number } = {},
): Promise<BulkRetryResult> {
  const limit = options.limit ?? DEFAULT_BULK_RETRY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_DELIVERIES_LIMIT) {
    throw new RangeError(
      `limit must be an integer in [1, ${MAX_LIST_DELIVERIES_LIMIT}]`,
    );
  }

  const page = await deps.queue.listByEndpoint(endpointId, {
    status: "dead_letter",
    limit,
  });

  const promises = page.deliveries.map(async (task) => {
    try {
      await deps.queue.retry(task.id);
      return 1;
    } catch (err) {
      if (
        err instanceof DeliveryStateError ||
        err instanceof UnknownDeliveryTaskError
      ) {
        return 0;
      }
      throw err;
    }
  });
  const counts = await Promise.all(promises);
  let retried = 0; for (const c of counts) retried += c;

  return { retried, hasMore: page.nextCursor !== null };
}

/**
 * Maximum tasks {@link retryAppDeliveries} can revive per call — equal to the
 * queue's max page size so one list + N retries is the worst case per call.
 * Operators drain a large backlog by calling the route repeatedly until
 * `hasMore` is `false`.
 */
export const DEFAULT_BULK_RETRY_LIMIT = MAX_LIST_DELIVERIES_LIMIT;

/** The result of a {@link retryAppDeliveries} call. */
export interface BulkRetryResult {
  /** Dead-lettered deliveries reset to a fresh `pending` state this call. */
  readonly retried: number;
  /**
   * `true` when there are more dead-lettered deliveries beyond this call's
   * `limit`. Re-invoke until `false` to fully drain the tenant's backlog.
   */
  readonly hasMore: boolean;
}

/** The queue {@link retryAppDeliveries} reads from and re-drives. */
export interface RetryAppDeps {
  readonly queue: DeliveryQueue;
}

/**
 * Re-drive up to `limit` **dead-lettered** deliveries for `appId` — the
 * tenant-wide recovery path once a failing receiver is fixed.
 *
 * Fetches the `limit` most-recently-created dead-lettered tasks for `appId`,
 * resets each to a fresh `pending` state (attempt budget reset, deliverable
 * immediately), and returns a tally. When {@link BulkRetryResult.hasMore} is
 * `true` there are more dead-lettered tasks not addressed this call; re-invoke
 * until `false` to fully drain. On subsequent calls the next batch of dead-letter
 * tasks is returned (the previously revived ones are now `pending`, no longer
 * filtered as `dead_letter`).
 *
 * Only `dead_letter` tasks are targeted. Concurrent revives of the same task
 * (racing callers) are absorbed silently — a {@link DeliveryStateError} means the
 * task was already revived and is not counted again.
 */
export async function retryAppDeliveries(
  appId: string,
  deps: RetryAppDeps,
  options: { readonly limit?: number } = {},
): Promise<BulkRetryResult> {
  const limit = options.limit ?? DEFAULT_BULK_RETRY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_DELIVERIES_LIMIT) {
    throw new RangeError(
      `limit must be an integer in [1, ${MAX_LIST_DELIVERIES_LIMIT}]`,
    );
  }

  const page = await deps.queue.listByApp(appId, {
    status: "dead_letter",
    limit,
  });

  const promises = page.deliveries.map(async (task) => {
    try {
      await deps.queue.retry(task.id);
      return 1;
    } catch (err) {
      // The task was already revived by a concurrent caller — treat as handled.
      if (
        err instanceof DeliveryStateError ||
        err instanceof UnknownDeliveryTaskError
      ) {
        return 0;
      }
      throw err;
    }
  });
  const counts = await Promise.all(promises);
  let retried = 0; for (const c of counts) retried += c;

  return { retried, hasMore: page.nextCursor !== null };
}
