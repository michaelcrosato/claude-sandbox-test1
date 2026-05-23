/**
 * Fan-out — the step that turns *one accepted message* into *delivery work for
 * every endpoint that should hear about it*.
 *
 * Until now Posthorn's pieces were disconnected: a {@link MessageStore} accepts
 * messages, an {@link EndpointStore} holds the subscriptions, a
 * {@link DeliveryQueue} carries per-(message, endpoint) work, and a worker
 * drains that queue. Nothing joined "a message arrived" to "enqueue a delivery
 * for each subscribed endpoint." That join is fan-out, and it is the functional
 * heart of a webhook service: ingest an event, and it reliably reaches all of a
 * tenant's relevant destinations.
 *
 * The logic splits cleanly into a **pure selection** ({@link selectFanoutTargets},
 * "which endpoints does this event go to?") and a thin **orchestration** that
 * does the I/O ({@link fanOut} lists + enqueues; {@link ingest} also accepts the
 * message first). Keeping selection pure makes the routing rules exhaustively
 * unit-testable without any store or queue.
 */

import {
  endpointSubscribesTo,
  type Endpoint,
  type EndpointStore,
} from "../endpoints/endpoint.js";
import type { DeliveryQueue, DeliveryTask } from "../queue/delivery-queue.js";
import type {
  CreateMessageResult,
  Message,
  MessageStore,
  NewMessage,
} from "../storage/message-store.js";

/**
 * The result of partitioning a tenant's endpoints against one event type. Every
 * endpoint lands in exactly one bucket, so `matched + skipped*` accounts for the
 * whole input — useful both for enqueueing (`matched`) and for explaining to an
 * operator *why* an endpoint did not receive an event (the `skipped*` buckets).
 */
export interface FanoutSelection {
  /** Enabled endpoints subscribed to the event type — these receive a delivery. */
  readonly matched: readonly Endpoint[];
  /** Endpoints skipped because they are administratively disabled. */
  readonly skippedDisabled: readonly Endpoint[];
  /** Enabled endpoints skipped because they do not subscribe to this event type. */
  readonly skippedUnsubscribed: readonly Endpoint[];
}

/**
 * Partition `endpoints` for delivery of `eventType`: an endpoint is `matched`
 * only when it is **enabled** *and* **subscribes** to the type (see
 * {@link endpointSubscribesTo}); otherwise it is skipped, with the reason
 * recorded. Pure and order-preserving (within each bucket, input order holds),
 * so fan-out routing is fully deterministic and unit-testable in isolation.
 *
 * A disabled endpoint is reported as `skippedDisabled` regardless of its filter,
 * so "disabled" always wins over "subscribed" — fan-out never enqueues work for
 * a paused endpoint.
 */
export function selectFanoutTargets(
  endpoints: readonly Endpoint[],
  eventType: string,
): FanoutSelection {
  const matched: Endpoint[] = [];
  const skippedDisabled: Endpoint[] = [];
  const skippedUnsubscribed: Endpoint[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.disabled) {
      skippedDisabled.push(endpoint);
    } else if (!endpointSubscribesTo(endpoint, eventType)) {
      skippedUnsubscribed.push(endpoint);
    } else {
      matched.push(endpoint);
    }
  }
  return { matched, skippedDisabled, skippedUnsubscribed };
}

/** The stores fan-out reads from and writes to. */
export interface FanoutDeps {
  /** Where the tenant's subscriptions live. */
  readonly endpoints: EndpointStore;
  /** Where the resulting delivery work is enqueued. */
  readonly queue: DeliveryQueue;
}

/** Tunables for a fan-out / ingest call. */
export interface FanoutOptions {
  /**
   * Epoch-ms before which the enqueued deliveries are not claimable. Omit (or
   * pass `null`) for immediate delivery. Applied uniformly to every task in the
   * fan-out — e.g. to schedule a batch for a future send window.
   */
  readonly availableAt?: number | null;
}

/** What a fan-out did: the enqueued tasks plus a per-bucket accounting. */
export interface FanoutResult {
  /** The message that was fanned out. */
  readonly messageId: string;
  /** The enqueued tasks, one per matched endpoint, in endpoint (oldest-first) order. */
  readonly tasks: readonly DeliveryTask[];
  /** Number of endpoints that received a delivery (`tasks.length`). */
  readonly matched: number;
  /** Number of endpoints skipped because they are disabled. */
  readonly skippedDisabled: number;
  /** Number of endpoints skipped because they do not subscribe to the event type. */
  readonly skippedUnsubscribed: number;
}

/**
 * Fan a message out to its tenant's endpoints: list the endpoints in
 * `message.appId`, select the enabled subscribers for `message.eventType`, and
 * enqueue one {@link DeliveryTask} per match (carrying the opaque `endpointId`
 * the worker's resolver later turns into a URL + signing secret).
 *
 * The message is referenced by `id` only — fan-out never copies its payload; the
 * worker loads it from the store at send time. Endpoints are enqueued
 * sequentially in list order, so task ids and queue order mirror endpoint order
 * deterministically (matching the worker's own sequential model; bounded
 * concurrency is a later throughput optimization).
 *
 * Fan-out is **at-least-once**, like the queue it feeds: calling it twice for the
 * same message enqueues a second set of tasks, so a duplicate delivery is
 * possible — which is exactly why every message carries a stable id for the
 * receiver to dedup on (Standard Webhooks). {@link ingest} suppresses the common
 * source of a re-fan-out (a producer's idempotent retry).
 */
export async function fanOut(
  message: Pick<Message, "id" | "appId" | "eventType">,
  deps: FanoutDeps,
  options: FanoutOptions = {},
): Promise<FanoutResult> {
  const all = await deps.endpoints.listByApp(message.appId);
  const selection = selectFanoutTargets(all, message.eventType);

  const availableAt = options.availableAt ?? null;
  const tasks: DeliveryTask[] = [];
  for (const endpoint of selection.matched) {
    tasks.push(
      await deps.queue.enqueue({
        messageId: message.id,
        endpointId: endpoint.id,
        ...(availableAt !== null ? { availableAt } : {}),
      }),
    );
  }

  return {
    messageId: message.id,
    tasks,
    matched: selection.matched.length,
    skippedDisabled: selection.skippedDisabled.length,
    skippedUnsubscribed: selection.skippedUnsubscribed.length,
  };
}

/** The stores {@link ingest} needs: fan-out's, plus where messages are accepted. */
export interface IngestDeps extends FanoutDeps {
  /** Where the message is accepted (and idempotently deduplicated). */
  readonly messages: MessageStore;
}

/** The outcome of {@link ingest}: the accepted message and what fan-out did. */
export interface IngestResult extends CreateMessageResult {
  /**
   * The fan-out result, or `null` when the create was a **deduplicated** replay
   * — in that case the message was already fanned out by the original create, so
   * it is deliberately *not* fanned out again (re-fanning would double-deliver).
   */
  readonly fanout: FanoutResult | null;
}

/**
 * Accept a message and fan it out — the product's headline operation, and the
 * single call a future HTTP `POST /messages` sits on. Creates the message via
 * the store (so caller idempotency keys dedup as usual), then fans it out **only
 * when the create was new**: a deduplicated create is a producer retry of an
 * already-accepted message, and the first create already fanned it out, so
 * re-fanning would double-deliver.
 *
 * Honest limitation (v1): the create and the fan-out are not a single atomic
 * unit. A crash *after* the message is stored but *before* fan-out finishes
 * leaves a message whose retry will dedup and skip fan-out — i.e. some of its
 * deliveries are never enqueued. The robust fix is a transactional outbox
 * (enqueue within the create's transaction); it is deferred. Until then, fan-out
 * is best-effort-after-accept, which is the right default for the common path
 * (no crash) and never *double*-creates a message.
 */
export async function ingest(
  input: NewMessage,
  deps: IngestDeps,
  options: FanoutOptions = {},
): Promise<IngestResult> {
  const { message, deduplicated } = await deps.messages.create(input);
  const fanout = deduplicated ? null : await fanOut(message, deps, options);
  return { message, deduplicated, fanout };
}
