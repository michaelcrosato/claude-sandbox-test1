/**
 * Manual delivery retry — the operator's recovery path for a message whose
 * deliveries have *dead-lettered*.
 *
 * Posthorn's tagline is "signed, **retried**, observable" webhooks. Automatic
 * retries (the {@link RetryPolicy} + delivery FSM) handle transient receiver
 * blips, but a *sustained* outage eventually exhausts the schedule and the
 * delivery lands in the terminal `dead_letter` state. Until now that was a dead
 * end: once a receiver was fixed there was no way to make Posthorn try again.
 * This module is that escape hatch — the same feature every incumbent
 * (Svix/Convoy/Hookdeck) exposes as "replay" / "retry".
 *
 * Like {@link fanOut}, it is thin **orchestration** over the durable primitives:
 * it lists a message's delivery tasks ({@link DeliveryQueue.listByMessage}) and
 * re-drives the dead-lettered ones ({@link DeliveryQueue.retry}, which resets a
 * terminal task to a fresh, immediately-claimable `pending` state). It holds no
 * state-transition logic of its own — that lives in the pure FSM — so a future
 * caller (the HTTP route today; perhaps a CLI tomorrow) gets identical semantics.
 */

import {
  UnknownDeliveryTaskError,
  type DeliveryQueue,
  type DeliveryTask,
} from "./delivery-queue.js";
import { DeliveryStateError } from "../delivery/delivery-state.js";

/** The queue {@link retryMessageDeliveries} reads from and re-drives. */
export interface RetryMessageDeps {
  /** Where the message's delivery tasks live. */
  readonly queue: DeliveryQueue;
}

/** What a {@link retryMessageDeliveries} call did. */
export interface RetryMessageResult {
  /** The message whose deliveries were considered. */
  readonly messageId: string;
  /** How many dead-lettered deliveries were re-driven back to `pending`. */
  readonly retried: number;
  /**
   * The message's delivery tasks after the retry, oldest-first — the refreshed
   * snapshots a caller renders back (the re-driven ones now `pending`). Empty
   * when the message has no deliveries (unknown id, or fan-out matched nobody).
   */
  readonly tasks: readonly DeliveryTask[];
}

/**
 * Re-drive a message's **dead-lettered** deliveries: each is reset to a fresh
 * `pending` state, deliverable immediately, so the running worker re-attempts it
 * under the full retry schedule. Returns a tally plus the refreshed task list.
 *
 * Only `dead_letter` tasks are targeted — they are the deliveries that need
 * human intervention (their automatic retries are spent). `pending` deliveries
 * are still being retried on their own; `delivering` ones are in flight; and
 * `succeeded` ones are done — re-sending those to healthy receivers is not what
 * "retry the failed deliveries" should do, so they are left untouched.
 *
 * Idempotent and concurrency-safe: a delivery already revived by a concurrent
 * call is no longer terminal, so its `retry` throws {@link DeliveryStateError},
 * which is absorbed (not counted) rather than surfaced — re-driving twice would
 * otherwise be a spurious error. (`UnknownDeliveryTaskError` is likewise absorbed
 * defensively, though tasks are never deleted.)
 */
export async function retryMessageDeliveries(
  messageId: string,
  deps: RetryMessageDeps,
): Promise<RetryMessageResult> {
  const tasks = await deps.queue.listByMessage(messageId);
  const retryPromises = tasks
    .filter((task) => task.status === "dead_letter")
    .map(async (task) => {
      try {
        await deps.queue.retry(task.id);
        return true;
      } catch (err) {
        // Expected under a concurrent retry of the same message: the task was
        // revived (now pending) between the list and this call, so it is no longer
        // terminal. Treat as already-handled rather than an error.
        if (
          err instanceof DeliveryStateError ||
          err instanceof UnknownDeliveryTaskError
        ) {
          return false;
        }
        throw err;
      }
    });

  const results = await Promise.all(retryPromises);
  const retried = results.filter(Boolean).length;
  // Re-list so the returned snapshots reflect the revived (`pending`) tasks.
  const refreshed = retried > 0 ? await deps.queue.listByMessage(messageId) : tasks;
  return { messageId, retried, tasks: refreshed };
}
