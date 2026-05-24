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
  matchesFilter,
  type Endpoint,
  type EndpointStore,
} from "../endpoints/endpoint.js";
import type { DeliveryQueue, DeliveryTask } from "../queue/delivery-queue.js";
import type {
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
  /** Enabled, subscribed endpoints skipped because their payload filter did not match. */
  readonly skippedFiltered: readonly Endpoint[];
  /** Enabled, subscribed endpoints skipped because their channel does not match the message's channel. */
  readonly skippedChannel: readonly Endpoint[];
}

/**
 * Whether an endpoint's channel setting matches the message's channel.
 * - A `null` endpoint channel is **global**: matches any message channel.
 * - A string endpoint channel matches only when `messageChannel` is exactly equal.
 */
function channelMatchesEndpoint(
  endpoint: Endpoint,
  messageChannel: string | null,
): boolean {
  return endpoint.channel === null || endpoint.channel === messageChannel;
}

/**
 * Partition `endpoints` for delivery of `eventType` + `channel` + `payload`: an
 * endpoint is `matched` only when it is **enabled**, **subscribes** to the type (see
 * {@link endpointSubscribesTo}), its **channel** matches (see {@link channelMatchesEndpoint}),
 * and its payload filter matches (see {@link matchesFilter}). Otherwise it is
 * skipped, with the reason recorded.
 * Pure and order-preserving (within each bucket, input order holds), so
 * fan-out routing is fully deterministic and unit-testable in isolation.
 *
 * Priority: disabled > unsubscribed > channel-mismatch > filter-mismatch > matched.
 * A disabled endpoint is always `skippedDisabled` regardless of subscription or channel.
 */
export function selectFanoutTargets(
  endpoints: readonly Endpoint[],
  eventType: string,
  channel: string | null = null,
  payload?: unknown,
): FanoutSelection {
  const matched: Endpoint[] = [];
  const skippedDisabled: Endpoint[] = [];
  const skippedUnsubscribed: Endpoint[] = [];
  const skippedChannel: Endpoint[] = [];
  const skippedFiltered: Endpoint[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.disabled) {
      skippedDisabled.push(endpoint);
    } else if (!endpointSubscribesTo(endpoint, eventType)) {
      skippedUnsubscribed.push(endpoint);
    } else if (!channelMatchesEndpoint(endpoint, channel)) {
      skippedChannel.push(endpoint);
    } else if (!matchesFilter(endpoint.filter, payload)) {
      skippedFiltered.push(endpoint);
    } else {
      matched.push(endpoint);
    }
  }
  return { matched, skippedDisabled, skippedUnsubscribed, skippedChannel, skippedFiltered };
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
  /** Number of enabled, subscribed endpoints skipped because their channel did not match. */
  readonly skippedChannel: number;
  /** Number of enabled, subscribed endpoints skipped because their payload filter did not match. */
  readonly skippedFiltered: number;
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
  message: Pick<Message, "id" | "appId" | "eventType" | "payload" | "channel" | "deliverAt" | "expiresAt">,
  deps: FanoutDeps,
  options: FanoutOptions = {},
): Promise<FanoutResult> {
  const all = await deps.endpoints.listByApp(message.appId);
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(message.payload);
  } catch {
    parsedPayload = null;
  }
  const selection = selectFanoutTargets(all, message.eventType, message.channel, parsedPayload);

  // Explicit FanoutOptions.availableAt wins; otherwise fall back to the message's
  // stored deliverAt so the outbox dispatcher honours the scheduled time too.
  const availableAt = options.availableAt ?? message.deliverAt ?? null;
  const tasks: DeliveryTask[] = [];
  for (const endpoint of selection.matched) {
    tasks.push(
      await deps.queue.enqueue({
        messageId: message.id,
        endpointId: endpoint.id,
        appId: message.appId,
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
    skippedChannel: selection.skippedChannel.length,
    skippedFiltered: selection.skippedFiltered.length,
  };
}

/** The stores {@link ingest} needs: fan-out's, plus where messages are accepted. */
export interface IngestDeps extends FanoutDeps {
  /** Where the message is accepted (and idempotently deduplicated). */
  readonly messages: MessageStore;
}

/** The outcome of {@link ingest}: the accepted message and what fan-out did. */
export interface IngestResult {
  /** The stored message — freshly created, or the one a prior call created. */
  readonly message: Message;
  /** `true` when an existing message was returned for a repeated idempotency key. */
  readonly deduplicated: boolean;
  /**
   * What this call's fan-out did, or `null` when no fan-out was performed —
   * which happens only for a deduplicated replay of a message that was *already*
   * fanned out (re-fanning would double-deliver). A first create always fans
   * out; a deduplicated replay of an **orphaned** create (accepted but never
   * fanned out, e.g. a crash struck between the two) is fanned out here too, so
   * `fanout` is non-`null` even though `deduplicated` is `true`.
   */
  readonly fanout: FanoutResult | null;
}

/**
 * Accept a message and fan it out — the product's headline operation, and the
 * call HTTP `POST /messages` sits on. Creates the message via the store (so
 * caller idempotency keys dedup as usual), then fans it out exactly when the
 * store reports the fan-out is **still owed** (`fanoutPending`): always for a
 * fresh create, and for a deduplicated retry whose original was accepted but
 * never completed its fan-out. A deduplicated retry of an already-fanned message
 * is *not* re-fanned (that would double-deliver).
 *
 * ## Crash consistency (the transactional outbox)
 *
 * Accepting the message and recording that it *owes a fan-out* is a single
 * atomic step inside the store (the message row carries the outbox marker,
 * written in the same transaction). So the old crash window — message stored,
 * but its retry dedups and skips fan-out, stranding deliveries — is closed: the
 * marker survives the crash. It is drained two ways: (1) a producer's retry sees
 * `fanoutPending` and re-drives fan-out here; (2) a {@link FanoutDispatcher}
 * sweeps any message left pending (the path for fire-and-forget producers that
 * never retry). After a successful fan-out the marker is cleared via
 * {@link MessageStore.markFannedOut}.
 *
 * Residual (inherent, not a regression): fan-out enqueues into the queue and
 * then clears the marker in the store — two different databases, so a crash
 * *between* them re-fans on recovery and can enqueue a duplicate delivery. That
 * is the queue's existing **at-least-once** contract, which is exactly why every
 * message carries a stable id for the receiver to dedup on (Standard Webhooks).
 * What is now guaranteed is *at-least*-once; the previous gap allowed
 * *zero*-once.
 */
export async function ingest(
  input: NewMessage,
  deps: IngestDeps,
  options: FanoutOptions = {},
): Promise<IngestResult> {
  const { message, deduplicated, fanoutPending } =
    await deps.messages.create(input);
  if (!fanoutPending) {
    return { message, deduplicated, fanout: null };
  }
  const fanout = await fanOut(message, deps, options);
  await deps.messages.markFannedOut(message.id);
  return { message, deduplicated, fanout };
}
