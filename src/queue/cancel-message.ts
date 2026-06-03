/**
 * Manual delivery cancellation — the operator's abort path for a message whose
 * deliveries are *pending* but should not fire.
 *
 * Cancellation is the symmetrical counterpart to retry: where retry revives
 * dead-lettered deliveries after a receiver is fixed, cancel aborts pending
 * deliveries before they fire — the escape hatch when an endpoint was disabled
 * or misconfigured after the message was enqueued but before any attempt ran.
 *
 * Like {@link retryMessageDeliveries}, it is thin **orchestration** over the
 * durable primitives: it lists a message's delivery tasks
 * ({@link DeliveryQueue.listByMessage}) and cancels the pending ones
 * ({@link DeliveryQueue.cancel}, which transitions a `pending` task to the
 * terminal `cancelled` state). It holds no state-transition logic of its own —
 * that lives in the pure FSM — so a future caller (the HTTP route today; perhaps
 * a CLI tomorrow) gets identical semantics.
 */

import {
  UnknownDeliveryTaskError,
  type DeliveryQueue,
  type DeliveryTask,
} from "./delivery-queue.js";
import { DeliveryStateError } from "../delivery/delivery-state.js";

/** The queue {@link cancelMessageDeliveries} reads from and cancels. */
export interface CancelMessageDeps {
  /** Where the message's delivery tasks live. */
  readonly queue: DeliveryQueue;
}

/** What a {@link cancelMessageDeliveries} call did. */
export interface CancelMessageResult {
  /** The message whose deliveries were considered. */
  readonly messageId: string;
  /** How many pending deliveries were cancelled. */
  readonly cancelled: number;
  /**
   * The message's delivery tasks after the cancellation, oldest-first — the
   * refreshed snapshots a caller renders back (the cancelled ones now
   * `cancelled`). Empty when the message has no deliveries (unknown id, or
   * fan-out matched nobody).
   */
  readonly tasks: readonly DeliveryTask[];
}

/**
 * Cancel a message's **pending** deliveries: each is transitioned to the
 * terminal `cancelled` state so the running worker never attempts it. Returns a
 * tally plus the refreshed task list.
 *
 * Only `pending` tasks are targeted — they are the deliveries that have not yet
 * fired and can still be aborted. `delivering` ones are in flight (aborting
 * mid-flight is not supported); `succeeded` and `dead_letter` ones are already
 * terminal; `cancelled` ones are already done. All non-pending tasks are left
 * untouched.
 *
 * Idempotent and concurrency-safe: a delivery already cancelled (or claimed by
 * the worker) by a concurrent call is no longer `pending`, so its `cancel`
 * throws {@link DeliveryStateError}, which is absorbed (not counted) rather than
 * surfaced — cancelling twice would otherwise be a spurious error.
 * (`UnknownDeliveryTaskError` is likewise absorbed defensively, though tasks are
 * never deleted.)
 */
export async function cancelMessageDeliveries(
  messageId: string,
  deps: CancelMessageDeps,
): Promise<CancelMessageResult> {
  const tasks = await deps.queue.listByMessage(messageId);
  const pendingTasks = tasks.filter(task => task.status === "pending");

  if (pendingTasks.length === 0) {
    return { messageId, cancelled: 0, tasks };
  }

  const results = await Promise.allSettled(
    pendingTasks.map(task => deps.queue.cancel(task.id))
  );

  let cancelled = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      cancelled += 1;
    } else {
      const err = result.reason;
      if (
        err instanceof DeliveryStateError ||
        err instanceof UnknownDeliveryTaskError
      ) {
        continue;
      }
      throw err;
    }
  }

  // Re-list so the returned snapshots reflect the cancelled tasks.
  const refreshed = cancelled > 0 ? await deps.queue.listByMessage(messageId) : tasks;
  return { messageId, cancelled, tasks: refreshed };
}
