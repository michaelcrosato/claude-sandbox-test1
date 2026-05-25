/**
 * The Posthorn TypeScript/JavaScript SDK client — the first-class object a
 * *producer* imports to talk to a running Posthorn gateway.
 *
 * It is a thin, fully-typed wrapper over the v1 HTTP surface (`src/http/api.ts`):
 * authenticate once with an API key, then send events, manage endpoints, and read
 * delivery status without hand-rolling `fetch`, header construction, or error
 * parsing. Two deliberate design choices keep it faithful to the product's wedge:
 *
 * - **Zero runtime dependencies.** It speaks the wire over the platform `fetch`
 *   (Node ≥ 18 / browsers / edge runtimes), so importing the SDK pulls in nothing.
 *   The `fetch` implementation is injectable for tests and exotic runtimes.
 * - **The wire types are SDK-owned views, not the server's domain types.** The
 *   HTTP API returns deliberately reduced shapes (an endpoint's `secret` is
 *   write-only; a delivery's internal `leaseToken` is never exposed), so the SDK
 *   models exactly what crosses the wire — no more, no less.
 *
 * Receiver-side verification of delivered webhooks lives in `./verify.ts`
 * ({@link import("./verify.js").verifyWebhook}); this file is the sending side.
 */

import type { DeliveryStatus } from "../delivery/delivery-state.js";
import type { DeliveryFailureReason } from "../delivery/failure-reason.js";
import { DEFAULT_TIMEOUT_MS, HttpTransport, type PosthornFetch } from "./http.js";

// The transport mechanics (the `fetch` contract, the error model, the request/timeout
// logic) live in `./http.js`, shared with the admin client so the two cannot drift.
// Re-export the public surface here so existing import paths (`from "posthorn"` / the
// package barrel, which re-exports these from `./client.js`) stay stable.
export {
  DEFAULT_TIMEOUT_MS,
  PosthornError,
  PosthornApiError,
  PosthornTimeoutError,
} from "./http.js";
export type {
  PosthornFetch,
  PosthornRequestInit,
  PosthornResponse,
} from "./http.js";

/** Configuration for a {@link PosthornClient}. */
export interface PosthornClientOptions {
  /**
   * Base URL of the gateway, e.g. `"https://posthorn.example"`. A trailing slash
   * is tolerated and stripped.
   */
  readonly baseUrl: string;
  /**
   * The API key to authenticate with, as minted by `posthorn admin create-key`.
   * Sent as `Authorization: Bearer <apiKey>` on every request.
   */
  readonly apiKey: string;
  /**
   * Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}.
   * `0` disables the timeout. A timed-out request rejects with
   * {@link PosthornTimeoutError}.
   */
  readonly timeoutMs?: number;
  /**
   * A custom `fetch` implementation (testing, or a runtime without a global
   * `fetch`). Defaults to the platform `fetch`.
   */
  readonly fetch?: PosthornFetch;
}

// ---------------------------------------------------------------------------
// Wire types — exactly what the v1 HTTP surface accepts and returns.
// ---------------------------------------------------------------------------

/** Input to {@link PosthornClient.sendMessage}. */
export interface SendMessageInput {
  /** The event type / topic, e.g. `"user.created"`. */
  readonly eventType: string;
  /**
   * The event body — any JSON-serializable value. It is sent as-is and the
   * gateway signs and delivers its exact JSON serialization.
   */
  readonly payload: unknown;
  /**
   * Optional idempotency key. A repeat send with the same key (within the
   * gateway's idempotency window) returns the original message and does not
   * re-deliver — safe to retry a failed send.
   */
  readonly idempotencyKey?: string | null;
  /**
   * ISO 8601 timestamp before which no delivery attempt is made. Omit or pass
   * `null` for immediate delivery. Past timestamps are treated as immediate.
   * Applied uniformly to every endpoint in the fan-out.
   */
  readonly sendAt?: string | null;
  /**
   * ISO 8601 timestamp after which the message must not be delivered. Omit or
   * pass `null` for no expiry. If the delivery worker picks up a task past this
   * time, it dead-letters the delivery immediately without retrying.
   */
  readonly expiresAt?: string | null;
  /**
   * Channel tag for scoped delivery. An endpoint with a matching channel
   * receives this message; a global endpoint (channel `null`) always receives it.
   * Omit or pass `null` for an untagged message (only global endpoints receive it).
   */
  readonly channel?: string | null;
  /**
   * Delivery priority. Higher-priority messages are claimed from the queue before
   * lower-priority ones when multiple tasks are due at the same time. Defaults to
   * `"normal"` when omitted.
   */
  readonly priority?: "high" | "normal" | "low";
}

/** The reference to a message returned by {@link PosthornClient.sendMessage}. */
export interface MessageRef {
  readonly id: string;
  readonly appId: string;
  readonly eventType: string;
  readonly idempotencyKey: string | null;
  /** Channel tag, or `null` for an untagged message. */
  readonly channel: string | null;
  /** Delivery priority (`"high"`, `"normal"`, or `"low"`). */
  readonly priority: "high" | "normal" | "low";
  /**
   * Epoch-ms before which no delivery is attempted, or `null` for immediate
   * delivery. Mirrors the `sendAt` field from the create request.
   */
  readonly deliverAt: number | null;
  /** Epoch-ms after which the message must not be delivered, or `null` for no expiry. */
  readonly expiresAt: number | null;
  /** Creation time, epoch ms. */
  readonly createdAt: number;
}

/** The fan-out summary for an accepted message (how many endpoints it reached). */
export interface FanoutSummary {
  readonly matched: number;
  readonly skippedDisabled: number;
  readonly skippedUnsubscribed: number;
  /** Endpoints skipped because their channel did not match the message channel. */
  readonly skippedChannel: number;
  readonly skippedFiltered: number;
}

/** The result of {@link PosthornClient.sendMessage}. */
export interface SendMessageResult {
  readonly message: MessageRef;
  /** `true` when an idempotency key collapsed this onto an already-accepted message. */
  readonly deduplicated: boolean;
  /** The fan-out tally, or `null` when the message was a deduplicated replay. */
  readonly fanout: FanoutSummary | null;
}

/** One item in a {@link PosthornClient.sendMessageBatch} response — success. */
export interface BatchMessageOk {
  readonly ok: true;
  readonly message: MessageRef;
  readonly deduplicated: boolean;
  readonly fanout: FanoutSummary | null;
}

/** One item in a {@link PosthornClient.sendMessageBatch} response — failure. */
export interface BatchMessageError {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

/** One item in a {@link PosthornClient.sendMessageBatch} response. */
export type BatchMessageResult = BatchMessageOk | BatchMessageError;

/** The result of {@link PosthornClient.sendMessageBatch}. */
export interface BatchResults {
  readonly results: readonly BatchMessageResult[];
}

/** One delivery's current state, as returned by {@link PosthornClient.getMessage}. */
export interface DeliveryView {
  readonly id: string;
  readonly endpointId: string | null;
  readonly status: DeliveryStatus;
  /** Attempts started so far. */
  readonly attempts: number;
  /** While pending, epoch-ms of the next retry; `null` if immediate or settled. */
  readonly nextAttemptAt: number | null;
  /** Detail of the most recent failure, if any. */
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * One recorded delivery attempt, as returned by
 * {@link PosthornClient.listMessageAttempts}. An append-only audit record: the
 * HTTP status, error, and latency of one attempt the worker made.
 */
export interface DeliveryAttemptView {
  readonly id: string;
  /** The delivery (message×endpoint) this attempt belongs to. */
  readonly taskId: string;
  readonly endpointId: string | null;
  /** Which attempt this was for its delivery, 1-based (1 = first try). */
  readonly attemptNumber: number;
  readonly outcome: "succeeded" | "failed";
  /** The receiver's HTTP status, or `null` when no response arrived (transport/pre-flight failure). */
  readonly responseStatus: number | null;
  /** Failure detail when `outcome` is `failed`; `null` on success. */
  readonly error: string | null;
  /**
   * The structured, machine-readable cause of a `failed` attempt — one stable code
   * (`connect_timeout`, `http_5xx`, `dns_failure`, …) you can group or filter by, the
   * queryable companion to the free-text `error`. `null` on a `succeeded` attempt, and
   * on attempts recorded before this field shipped.
   */
  readonly failureReason: DeliveryFailureReason | null;
  /** The signed payload sent to the receiver, truncated to 4096 bytes; null on pre-flight failure. */
  readonly requestBody: string | null;
  /** The HTTP response body, truncated to 4096 bytes; null when no response arrived. */
  readonly responseBody: string | null;
  /** Wall-clock duration of the attempt, ms. */
  readonly durationMs: number;
  /** When the attempt started, epoch ms. */
  readonly attemptedAt: number;
}

/** Options for {@link PosthornClient.listMessageAttempts}. */
export interface ListAttemptsParams {
  /** Page size, 1..200. Defaults to the gateway's default (50). */
  readonly limit?: number;
  /**
   * Opaque cursor from a prior page's {@link AttemptListPage.nextCursor}; omit
   * (or `null`) for the first page.
   */
  readonly cursor?: string | null;
}

/**
 * One page of {@link PosthornClient.listMessageAttempts}: an oldest-first slice of
 * the message's delivery attempts plus the cursor to fetch the next page.
 */
export interface AttemptListPage {
  readonly data: readonly DeliveryAttemptView[];
  /** Pass back as {@link ListAttemptsParams.cursor}; `null` on the last page. */
  readonly nextCursor: string | null;
}

/** Options for {@link PosthornClient.listEndpointDeliveries}. */
export interface ListEndpointDeliveriesParams {
  /** Page size, 1..200. Defaults to the gateway's default (50). */
  readonly limit?: number;
  /**
   * Opaque cursor from a prior page's {@link EndpointDeliveryListPage.nextCursor};
   * omit (or `null`) for the first page.
   */
  readonly cursor?: string | null;
}

/**
 * One delivery in an endpoint's history — the current state of one (message, endpoint)
 * delivery. Extends {@link DeliveryView} with `messageId` so you can navigate to the
 * full message detail.
 */
export interface EndpointDeliveryView {
  readonly id: string;
  readonly messageId: string;
  readonly endpointId: string | null;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * One page of {@link PosthornClient.listEndpointDeliveries}: a newest-first slice
 * of the endpoint's deliveries plus the cursor to fetch the next page.
 */
export interface EndpointDeliveryListPage {
  readonly data: readonly EndpointDeliveryView[];
  /** Pass back as {@link ListEndpointDeliveriesParams.cursor}; `null` on the last page. */
  readonly nextCursor: string | null;
}

/** Options for {@link PosthornClient.getEndpointStats}. */
export interface GetEndpointStatsParams {
  /**
   * Trailing window in calendar days (1–30). Defaults to 7. Larger windows give
   * a longer trend line at the cost of a slightly heavier query.
   */
  readonly days?: number;
}

/** One UTC calendar day's delivery-attempt counts, as returned by {@link PosthornClient.getEndpointStats}. */
export interface EndpointStatsDayView {
  /** UTC day, ISO `YYYY-MM-DD`. */
  readonly date: string;
  /** Total delivery attempts on this day. */
  readonly attempts: number;
  /** Attempts that reached the receiver with a 2xx. */
  readonly succeeded: number;
  /** Attempts that failed (non-2xx, transport, or pre-flight). */
  readonly failed: number;
}

/**
 * Aggregate delivery-attempt statistics for an endpoint, as returned by
 * {@link PosthornClient.getEndpointStats}.
 */
export interface EndpointStatsView {
  readonly endpointId: string;
  /** Inclusive start of the window (epoch ms). */
  readonly fromMs: number;
  /** Exclusive end of the window (epoch ms). */
  readonly toMs: number;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  /** `succeeded / total` (0–1), or `null` when `total` is 0. */
  readonly successRate: number | null;
  /** Mean attempt duration in ms, or `null` when `total` is 0. */
  readonly avgDurationMs: number | null;
  /** Per-UTC-day breakdown, oldest day first. */
  readonly daily: readonly EndpointStatsDayView[];
}

/** Options for {@link PosthornClient.listDeliveries}. */
export interface ListDeliveriesParams {
  /** Page size, 1..200. Defaults to the gateway's default (50). */
  readonly limit?: number;
  /**
   * Opaque cursor from a prior page's {@link AppDeliveryListPage.nextCursor};
   * omit (or `null`) for the first page.
   */
  readonly cursor?: string | null;
  /**
   * Filter to deliveries with this status. Omit (or `null`) to return all
   * statuses. Common debugging use: `"dead_letter"` to surface failed deliveries.
   */
  readonly status?: "pending" | "delivering" | "succeeded" | "dead_letter" | null;
}

/**
 * One delivery in the tenant's app-wide list — the current state of one
 * (message, endpoint) delivery, with both `messageId` and `endpointId` so you
 * can navigate to either detail view.
 */
export interface AppDeliveryView {
  readonly id: string;
  readonly messageId: string;
  readonly endpointId: string | null;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * One page of {@link PosthornClient.listDeliveries}: a newest-first slice of
 * the tenant's deliveries across all messages and endpoints.
 */
export interface AppDeliveryListPage {
  readonly data: readonly AppDeliveryView[];
  /** Pass back as {@link ListDeliveriesParams.cursor}; `null` on the last page. */
  readonly nextCursor: string | null;
}

/** Options for {@link PosthornClient.listMessages}. */
export interface ListMessagesParams {
  /** Page size, 1..200. Defaults to the gateway's default (50). */
  readonly limit?: number;
  /**
   * Opaque cursor from a prior page's {@link MessageListPage.nextCursor}; omit
   * (or `null`) for the first page.
   */
  readonly cursor?: string | null;
  /**
   * Filter to messages whose `eventType` exactly matches this value. Omit (or
   * pass `null`) to return all event types.
   */
  readonly eventType?: string | null;
  /**
   * Filter to messages whose `channel` exactly matches this value. Omit (or
   * pass `null`) to return messages from all channels.
   */
  readonly channel?: string | null;
}

/**
 * One page of {@link PosthornClient.listMessages}: a newest-first slice of the
 * tenant's messages (each a lightweight {@link MessageRef} — no payload or
 * deliveries; fetch {@link PosthornClient.getMessage} for those) plus the cursor
 * to fetch the next page.
 */
export interface MessageListPage {
  readonly data: readonly MessageRef[];
  /** Pass back as {@link ListMessagesParams.cursor}; `null` on the last page. */
  readonly nextCursor: string | null;
}

/** The result of {@link PosthornClient.retryAllDeliveries}. */
export interface BulkRetryResponse {
  /** Dead-lettered deliveries reset to `pending` this call. */
  readonly retried: number;
  /**
   * `true` when more dead-lettered deliveries remain. Re-invoke
   * {@link PosthornClient.retryAllDeliveries} until `false` to fully drain.
   */
  readonly hasMore: boolean;
}

/** Optional input for {@link PosthornClient.replayEndpoint}. */
export interface ReplayEndpointInput {
  /**
   * Inclusive epoch-ms lower bound. Only messages created at or after this timestamp
   * are replayed. Absent means no lower bound (scan from the most recent message back).
   */
  readonly since?: number | null;
  /**
   * Exclusive epoch-ms upper bound. Only messages created strictly before this timestamp
   * are replayed. Absent means no upper bound.
   */
  readonly until?: number | null;
  /**
   * Maximum delivery tasks to enqueue this call (1–1000). Defaults to 100.
   * When `hasMore` is `true`, re-invoke to continue the replay.
   */
  readonly limit?: number;
}

/** The result of {@link PosthornClient.replayEndpoint}. */
export interface ReplayEndpointResponse {
  /** Fresh delivery tasks enqueued this call. */
  readonly enqueued: number;
  /**
   * `true` when the scan was truncated by `limit`. Re-invoke until `false` to
   * fully replay the window.
   */
  readonly hasMore: boolean;
}

/** The result of {@link PosthornClient.retryMessage}. */
export interface RetryMessageResponse {
  /** The message whose deliveries were replayed. */
  readonly id: string;
  /** How many dead-lettered deliveries were re-driven back to `pending`. */
  readonly retried: number;
  /** The refreshed per-endpoint delivery statuses (replayed ones now `pending`). */
  readonly deliveries: readonly DeliveryView[];
}

/** The result of {@link PosthornClient.cancelMessage}. */
export interface CancelMessageResponse {
  /** The message whose pending deliveries were cancelled. */
  readonly id: string;
  /** How many pending deliveries were cancelled. */
  readonly cancelled: number;
  /** The refreshed per-endpoint delivery statuses (cancelled ones now `cancelled`). */
  readonly deliveries: readonly DeliveryView[];
}

/** A message plus its per-endpoint delivery statuses ({@link PosthornClient.getMessage}). */
export interface MessageWithDeliveries {
  readonly id: string;
  readonly appId: string;
  readonly eventType: string;
  readonly idempotencyKey: string | null;
  /**
   * The exact serialized payload bytes that were signed and delivered. This is a
   * JSON **string**; `JSON.parse` it to recover the value you sent.
   */
  readonly payload: string;
  /** Channel tag, or `null` for an untagged message. */
  readonly channel: string | null;
  /** Delivery priority (`"high"`, `"normal"`, or `"low"`). */
  readonly priority: "high" | "normal" | "low";
  /**
   * Epoch-ms before which no delivery is attempted, or `null` for immediate
   * delivery. Mirrors the `sendAt` field from the create request.
   */
  readonly deliverAt: number | null;
  /** Epoch-ms after which the message must not be delivered, or `null` for no expiry. */
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly deliveries: readonly DeliveryView[];
}

/**
 * A custom retry schedule, as stored on an endpoint. `delaysMs[i]` is the wait
 * after the `(i+1)`-th attempt; the total attempts = `delaysMs.length + 1`.
 */
export interface RetryPolicyView {
  /** Ordered inter-attempt delays in milliseconds. */
  readonly delaysMs: readonly number[];
  /**
   * HTTP status codes that bypass the retry schedule and immediately
   * dead-letter the delivery (e.g. 400, 401, 410). Absent when none are set.
   */
  readonly nonRetryableStatuses?: readonly number[];
}

/**
 * A payload filter expression on an endpoint. Field filters compare a dot-path
 * value against a scalar; logical combinators compose them. `null` means no
 * filter — deliver all matching event types.
 */
export type EndpointFilterView =
  | { readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith"; readonly path: string; readonly value: string | number | boolean | null }
  | { readonly op: "and" | "or"; readonly filters: readonly EndpointFilterView[] }
  | { readonly op: "not"; readonly filter: EndpointFilterView };

/** The non-secret view of an endpoint (list / get / update / create). */
export interface EndpointView {
  readonly id: string;
  readonly appId: string;
  readonly url: string;
  readonly description: string;
  /** Subscribed event types; `null` means *all* events. */
  readonly eventTypes: readonly string[] | null;
  /**
   * Custom HTTP headers added to every delivery (e.g. `X-API-Key`, `Authorization`).
   * `null` means no custom headers.
   */
  readonly headers: Record<string, string> | null;
  /**
   * Per-endpoint retry schedule. `null` means the system-wide default applies.
   * When set, `delaysMs` replaces the global schedule for deliveries to this endpoint.
   */
  readonly retryPolicy: RetryPolicyView | null;
  /**
   * Payload filter expression. When set, only messages whose parsed JSON payload
   * matches the filter are delivered. `null` means no filter — all matching event
   * types are delivered regardless of payload content.
   */
  readonly filter: EndpointFilterView | null;
  /**
   * Channel scope. `null` (global) means this endpoint receives all messages
   * regardless of channel. A non-null value means only messages tagged with the
   * same channel are delivered here.
   */
  readonly channel: string | null;
  /**
   * Maximum deliveries per 60-second sliding window. The worker postpones tasks that
   * exceed the limit without consuming a retry attempt. `null` means no limit.
   */
  readonly rateLimit: number | null;
  /**
   * Whether the endpoint is paused (skipped by fan-out) — set manually, or set
   * automatically once it has been failing continuously (see
   * {@link EndpointView.consecutiveFailures}). Re-enable with
   * `updateEndpoint(id, { disabled: false })`, which also clears the failure streak.
   */
  readonly disabled: boolean;
  /** Consecutive dead-lettered deliveries since the last success; `0` when healthy. */
  readonly consecutiveFailures: number;
  /** Epoch ms the current failure streak began; `null` when healthy. */
  readonly firstFailureAt: number | null;
  /** Epoch ms of the most recent dead-lettered delivery; `null` when healthy. */
  readonly lastFailureAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The endpoint returned by {@link PosthornClient.createEndpoint} — an
 * {@link EndpointView} plus the signing `secret`, which the gateway returns
 * **exactly once**. Store it now; you need it to verify received webhooks
 * (see {@link import("./verify.js").verifyWebhook}).
 */
export interface CreatedEndpoint extends EndpointView {
  readonly secret: string;
}

/** Input to {@link PosthornClient.createEndpoint}. */
export interface CreateEndpointInput {
  /** Absolute `http`/`https` URL to deliver to. */
  readonly url: string;
  /** Subscription filter; omit (or `null`) to subscribe to all events. */
  readonly eventTypes?: readonly string[] | null;
  /** Optional human-readable label. */
  readonly description?: string;
  /** Whether the endpoint starts paused. Defaults to `false`. */
  readonly disabled?: boolean;
  /** Provide your own signing secret; omit to have a secure one generated. */
  readonly secret?: string;
  /**
   * Custom HTTP headers to add to every delivery (e.g. `{ "X-API-Key": "..." }`).
   * Omit or pass `null` for none. Standard Webhooks headers and `content-type` are
   * controlled by Posthorn and cannot be set here.
   */
  readonly headers?: Record<string, string> | null;
  /**
   * Custom retry schedule. Omit or pass `null` to use the system-wide default policy.
   */
  readonly retryPolicy?: RetryPolicyView | null;
  /**
   * Payload filter expression. Omit or pass `null` for no filter (deliver all
   * matching event types regardless of payload content).
   */
  readonly filter?: EndpointFilterView | null;
  /**
   * Channel scope. `null` (or omit) for a global endpoint that receives all
   * messages. A string value scopes delivery to messages tagged with the same channel.
   */
  readonly channel?: string | null;
  /**
   * Max deliveries per 60-second window. Omit or pass `null` for no limit.
   */
  readonly rateLimit?: number | null;
}

/** A patch for {@link PosthornClient.updateEndpoint}; only provided fields change. */
export interface UpdateEndpointInput {
  readonly url?: string;
  /** Hard-swap the signing secret (no overlap). For zero-downtime use {@link PosthornClient.rotateEndpointSecret}. */
  readonly secret?: string;
  readonly description?: string;
  readonly eventTypes?: readonly string[] | null;
  readonly disabled?: boolean;
  /** Replace custom delivery headers. Pass `null` to clear all custom headers. */
  readonly headers?: Record<string, string> | null;
  /**
   * Replace the retry schedule. Pass `null` to revert to the system-wide default policy.
   */
  readonly retryPolicy?: RetryPolicyView | null;
  /**
   * Replace the payload filter expression. Pass `null` to clear the filter (deliver
   * all matching event types regardless of payload content).
   */
  readonly filter?: EndpointFilterView | null;
  /**
   * Replace the channel scope. `null` makes the endpoint global (receives all
   * messages); a string scopes it to messages with that channel.
   */
  readonly channel?: string | null;
  /**
   * Replace the delivery rate limit. Pass `null` to remove the limit.
   */
  readonly rateLimit?: number | null;
}

/** Optional body of {@link PosthornClient.testEndpoint}. */
export interface TestEndpointInput {
  /** The event type to send (e.g. `"user.created"`). Defaults to `"test"`. */
  readonly eventType?: string;
  /** The event body — any JSON-serializable value. Defaults to `{"test":true}`. */
  readonly payload?: unknown;
}

/** Result of {@link PosthornClient.testEndpoint}. */
export interface TestEndpointResult {
  /** Whether the endpoint responded with a 2xx status. */
  readonly success: boolean;
  /** The HTTP status the endpoint returned, if a response was received. */
  readonly httpStatus?: number;
  /** Transport-level error message when no response was received. */
  readonly error?: string;
  /** Round-trip latency in milliseconds. */
  readonly durationMs: number;
}

/** Options for {@link PosthornClient.rotateEndpointSecret}; all fields optional. */
export interface RotateEndpointSecretInput {
  /** The new primary secret. Omit to have the gateway generate a secure one (the common case). */
  readonly secret?: string;
  /**
   * How long (ms) the *old* secret keeps signing after the rotation, so receivers
   * mid-migration still verify. Defaults to the gateway's window (24h). `0` is an
   * instant hard swap with no overlap.
   */
  readonly overlapMs?: number;
}

/** One UTC day's message count in a {@link TenantUsage} breakdown. */
export interface UsageDay {
  /** The UTC day, `YYYY-MM-DD`. */
  readonly date: string;
  /** Messages accepted on this day (within the queried range). */
  readonly messages: number;
}

/** One UTC day's delivery-attempt counts in a {@link DeliveryUsage} breakdown. */
export interface DeliveryUsageDay {
  /** The UTC day, `YYYY-MM-DD`. */
  readonly date: string;
  /** Total delivery attempts on this day (within the queried range). */
  readonly attempts: number;
  /** Of those, attempts that reached the receiver with a 2xx. */
  readonly succeeded: number;
  /** Of those, attempts that failed. */
  readonly failed: number;
}

/**
 * A tenant's delivery-attempt (operations) usage over the queried range — every HTTP
 * delivery attempt Posthorn made on the tenant's behalf, retries included, the
 * delivery-side companion to the accepted-message `total`/`daily` of {@link TenantUsage}.
 */
export interface DeliveryUsage {
  /** Total delivery attempts across the range (the billable operations count). */
  readonly total: number;
  /** Of `total`, attempts that succeeded. */
  readonly succeeded: number;
  /** Of `total`, attempts that failed. */
  readonly failed: number;
  /** Per-UTC-day breakdown, oldest day first; only days with at least one attempt. */
  readonly daily: readonly DeliveryUsageDay[];
}

/**
 * The current-month quota status block of {@link TenantUsage} — the window the
 * gateway enforces a monthly message quota over (`POST /v1/messages` → `429`).
 */
export interface QuotaStatus {
  /** The plan's monthly message cap, or `null` for no limit. */
  readonly monthlyMessageQuota: number | null;
  /** Messages accepted so far this UTC month. */
  readonly used: number;
  /** Messages still allowed this month (floored at 0), or `null` when unlimited. */
  readonly remaining: number | null;
  /** First day of the current UTC month, `YYYY-MM-DD`. */
  readonly periodStart: string;
  /** First day of next UTC month — when the allowance resets, `YYYY-MM-DD`. */
  readonly resetsAt: string;
}

/** The result of {@link PosthornClient.getUsage}. */
export interface TenantUsage {
  readonly appId: string;
  /** Inclusive start day of the breakdown (UTC), `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive end day of the breakdown (UTC), `YYYY-MM-DD`. */
  readonly to: string;
  /** Total messages across the queried range. */
  readonly total: number;
  /** Per-UTC-day message breakdown, oldest day first; only days with at least one message. */
  readonly daily: readonly UsageDay[];
  /** Delivery-attempt (operations) usage over the same range. */
  readonly deliveries: DeliveryUsage;
  /** Live current-month quota status (independent of the queried range). */
  readonly quota: QuotaStatus;
}

/** Options for {@link PosthornClient.getUsage}; omit both for the current UTC month. */
export interface GetUsageParams {
  /** Inclusive start day, `YYYY-MM-DD` (UTC). */
  readonly from?: string;
  /** Inclusive end day, `YYYY-MM-DD` (UTC). Must be on or after `from`. */
  readonly to?: string;
}

/** The view of an event type returned by the catalog routes. */
export interface EventTypeView {
  readonly id: string;
  readonly appId: string;
  readonly name: string;
  readonly description: string | null;
  readonly schemaExample: string | null;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input to {@link PosthornClient.createEventType}. */
export interface CreateEventTypeInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly schemaExample?: string | null;
}

/** A patch for {@link PosthornClient.updateEventType}; only provided fields change. */
export interface UpdateEventTypeInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly schemaExample?: string | null;
}

/** A page of event types returned by {@link PosthornClient.listEventTypes}. */
export interface EventTypeListPage {
  readonly data: readonly EventTypeView[];
}

/** Options for {@link PosthornClient.listEventTypes}. */
export interface ListEventTypesParams {
  readonly includeArchived?: boolean;
}

/** Input to {@link PosthornClient.createPortalSession}. */
export interface CreatePortalSessionInput {
  /**
   * Your identifier for the customer gaining portal access (opaque to Posthorn —
   * used for auditing). Must be a non-empty string.
   */
  readonly externalUserId: string;
  /**
   * How long the session remains valid, in seconds. Defaults to 86400 (24 h).
   * Maximum 604800 (7 days).
   */
  readonly expiresIn?: number;
}

/**
 * A minted consumer portal session — the result of
 * {@link PosthornClient.createPortalSession}.
 */
export interface PortalSessionResult {
  /** The opaque session token (embedded in `portalUrl` — no need to handle separately). */
  readonly token: string;
  /**
   * The full URL to redirect your customer to. It exchanges the token for a session
   * cookie and lands the customer at the portal endpoint management page.
   */
  readonly portalUrl: string;
  /** When the session expires, epoch ms. */
  readonly expiresAt: number;
}

/**
 * A typed client for a Posthorn gateway. Construct one per `(baseUrl, apiKey)`
 * pair and reuse it; it holds no per-request mutable state.
 */
export class PosthornClient {
  readonly #transport: HttpTransport;

  constructor(options: PosthornClientOptions) {
    if (typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
      throw new TypeError("PosthornClient: baseUrl must be a non-empty string");
    }
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new TypeError("PosthornClient: apiKey must be a non-empty string");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("PosthornClient: timeoutMs must be a non-negative finite number");
    }
    this.#transport = new HttpTransport({
      baseUrl: options.baseUrl,
      bearerToken: options.apiKey,
      timeoutMs,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
  }

  /** Liveness probe — `GET /healthz`. Resolves with `{ status: "ok" }`. */
  async health(): Promise<{ status: string }> {
    return this.#transport.request<{ status: string }>("GET", "/healthz");
  }

  /** Accept an event and fan it out to the tenant's subscribed endpoints — `POST /v1/messages`. */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      eventType: input.eventType,
      payload: input.payload,
    };
    if (input.idempotencyKey !== undefined) body["idempotencyKey"] = input.idempotencyKey;
    if (input.sendAt !== undefined) body["sendAt"] = input.sendAt;
    if (input.expiresAt !== undefined) body["expiresAt"] = input.expiresAt;
    if (input.channel !== undefined) body["channel"] = input.channel;
    if (input.priority !== undefined) body["priority"] = input.priority;
    return this.#transport.request<SendMessageResult>("POST", "/v1/messages", body);
  }

  /**
   * Accept up to 100 messages in a single call — `POST /v1/messages/batch`.
   * Each item is processed independently; inspect `result.ok` on each element
   * to detect per-item failures (e.g. `quota_exceeded`, `idempotency_conflict`).
   */
  async sendMessageBatch(messages: readonly SendMessageInput[]): Promise<BatchResults> {
    const items = messages.map((m) => {
      const item: Record<string, unknown> = { eventType: m.eventType, payload: m.payload };
      if (m.idempotencyKey !== undefined) item["idempotencyKey"] = m.idempotencyKey;
      if (m.sendAt !== undefined) item["sendAt"] = m.sendAt;
      if (m.expiresAt !== undefined) item["expiresAt"] = m.expiresAt;
      if (m.channel !== undefined) item["channel"] = m.channel;
      if (m.priority !== undefined) item["priority"] = m.priority;
      return item;
    });
    return this.#transport.request<BatchResults>("POST", "/v1/messages/batch", { messages: items });
  }

  /**
   * List the tenant's messages, newest-first — `GET /v1/messages`. Keyset-paginated:
   * pass the returned {@link MessageListPage.nextCursor} back as
   * {@link ListMessagesParams.cursor} to fetch the next page (it is `null` on the
   * last page).
   */
  async listMessages(params: ListMessagesParams = {}): Promise<MessageListPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) {
      query.set("limit", String(params.limit));
    }
    if (params.cursor !== undefined && params.cursor !== null) {
      query.set("cursor", params.cursor);
    }
    if (params.eventType !== undefined && params.eventType !== null) {
      query.set("eventType", params.eventType);
    }
    if (params.channel !== undefined && params.channel !== null) {
      query.set("channel", params.channel);
    }
    const qs = query.toString();
    return this.#transport.request<MessageListPage>(
      "GET",
      `/v1/messages${qs.length > 0 ? `?${qs}` : ""}`,
    );
  }

  /** Read a message and its per-endpoint delivery statuses — `GET /v1/messages/:id`. */
  async getMessage(id: string): Promise<MessageWithDeliveries> {
    return this.#transport.request<MessageWithDeliveries>(
      "GET",
      `/v1/messages/${encodeURIComponent(id)}`,
    );
  }

  /**
   * List a message's per-attempt delivery audit log — `GET /v1/messages/:id/attempts`.
   * One record per HTTP attempt the worker made (across every endpoint it fanned out
   * to), oldest-first, each carrying the response status, error, and latency — the
   * *history* behind {@link PosthornClient.getMessage}'s current-state view.
   * Keyset-paginated: pass the returned {@link AttemptListPage.nextCursor} back as
   * {@link ListAttemptsParams.cursor} to fetch the next page (`null` = last page).
   */
  async listMessageAttempts(
    id: string,
    params: ListAttemptsParams = {},
  ): Promise<AttemptListPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined && params.cursor !== null) query.set("cursor", params.cursor);
    const qs = query.toString();
    return this.#transport.request<AttemptListPage>(
      "GET",
      `/v1/messages/${encodeURIComponent(id)}/attempts${qs.length > 0 ? `?${qs}` : ""}`,
    );
  }

  /**
   * Replay a message's **dead-lettered** deliveries — `POST /v1/messages/:id/retry`.
   * Each delivery that exhausted its automatic retries is reset to `pending` and
   * re-attempted by the gateway's worker (use this after fixing a broken receiver).
   * Resolves with the count re-driven and the refreshed per-endpoint statuses;
   * deliveries still pending/in-flight/succeeded are left untouched.
   */
  async retryMessage(id: string): Promise<RetryMessageResponse> {
    return this.#transport.request<RetryMessageResponse>(
      "POST",
      `/v1/messages/${encodeURIComponent(id)}/retry`,
    );
  }

  /**
   * Cancel a message's **pending** deliveries — `POST /v1/messages/:id/cancel`.
   * Aborts scheduled/queued deliveries that have not fired yet. In-flight,
   * succeeded, and dead-lettered deliveries are left untouched. Returns the
   * count cancelled and the refreshed per-endpoint statuses.
   */
  async cancelMessage(id: string): Promise<CancelMessageResponse> {
    return this.#transport.request<CancelMessageResponse>(
      "POST",
      `/v1/messages/${encodeURIComponent(id)}/cancel`,
    );
  }

  /**
   * Bulk-retry the tenant's dead-lettered deliveries — `POST /v1/deliveries/retry`.
   * Re-drives up to 200 dead-lettered deliveries back to `pending` in one call.
   * When `hasMore` is `true` in the response, re-invoke until `false` to fully
   * drain the backlog (each call retries the next batch of dead-letter tasks).
   * Use this after fixing a broken receiver that caused widespread failures.
   */
  async retryAllDeliveries(): Promise<BulkRetryResponse> {
    return this.#transport.request<BulkRetryResponse>("POST", "/v1/deliveries/retry");
  }

  /**
   * Bulk-retry dead-lettered deliveries for one endpoint — the per-endpoint
   * recovery path once a specific failing receiver is fixed. Returns the count
   * retried and `hasMore` (re-invoke until `false` to drain a large backlog).
   */
  async retryEndpointDeliveries(endpointId: string): Promise<BulkRetryResponse> {
    return this.#transport.request<BulkRetryResponse>(
      "POST",
      `/v1/endpoints/${encodeURIComponent(endpointId)}/deliveries/retry`,
    );
  }

  /**
   * Replay historical messages to one endpoint — `POST /v1/endpoints/:id/replay`.
   * Scans the tenant's message history and enqueues fresh delivery tasks for messages
   * matching the endpoint's subscription (event type, channel, filter). Use `since`/`until`
   * to narrow to a time window; re-invoke until `hasMore` is `false` to fully replay.
   */
  async replayEndpoint(
    endpointId: string,
    input?: ReplayEndpointInput,
  ): Promise<ReplayEndpointResponse> {
    const body: Record<string, unknown> = {};
    if (input?.since !== undefined) body["since"] = input.since;
    if (input?.until !== undefined) body["until"] = input.until;
    if (input?.limit !== undefined) body["limit"] = input.limit;
    return this.#transport.request<ReplayEndpointResponse>(
      "POST",
      `/v1/endpoints/${encodeURIComponent(endpointId)}/replay`,
      Object.keys(body).length > 0 ? body : undefined,
    );
  }

  /** List the tenant's endpoints — `GET /v1/endpoints`. */
  async listEndpoints(): Promise<readonly EndpointView[]> {
    const res = await this.#transport.request<{ data: readonly EndpointView[] }>(
      "GET",
      "/v1/endpoints",
    );
    return res.data;
  }

  /**
   * Create an endpoint — `POST /v1/endpoints`. The returned {@link CreatedEndpoint}
   * carries the signing `secret` **once**; persist it for receiver-side verification.
   */
  async createEndpoint(input: CreateEndpointInput): Promise<CreatedEndpoint> {
    const body: Record<string, unknown> = { url: input.url };
    if (input.secret !== undefined) body["secret"] = input.secret;
    if (input.description !== undefined) body["description"] = input.description;
    if (input.eventTypes !== undefined) body["eventTypes"] = input.eventTypes;
    if (input.disabled !== undefined) body["disabled"] = input.disabled;
    if (input.headers !== undefined) body["headers"] = input.headers;
    if (input.retryPolicy !== undefined) body["retryPolicy"] = input.retryPolicy;
    if (input.filter !== undefined) body["filter"] = input.filter;
    if (input.channel !== undefined) body["channel"] = input.channel;
    if (input.rateLimit !== undefined) body["rateLimit"] = input.rateLimit;
    return this.#transport.request<CreatedEndpoint>("POST", "/v1/endpoints", body);
  }

  /** Fetch one endpoint — `GET /v1/endpoints/:id`. */
  async getEndpoint(id: string): Promise<EndpointView> {
    return this.#transport.request<EndpointView>(
      "GET",
      `/v1/endpoints/${encodeURIComponent(id)}`,
    );
  }

  /** Update an endpoint — `PATCH /v1/endpoints/:id`. Only provided fields change. */
  async updateEndpoint(id: string, patch: UpdateEndpointInput): Promise<EndpointView> {
    const body: Record<string, unknown> = {};
    if (patch.url !== undefined) body["url"] = patch.url;
    if (patch.secret !== undefined) body["secret"] = patch.secret;
    if (patch.description !== undefined) body["description"] = patch.description;
    if (patch.eventTypes !== undefined) body["eventTypes"] = patch.eventTypes;
    if (patch.disabled !== undefined) body["disabled"] = patch.disabled;
    if (patch.headers !== undefined) body["headers"] = patch.headers;
    if (patch.retryPolicy !== undefined) body["retryPolicy"] = patch.retryPolicy;
    if (patch.filter !== undefined) body["filter"] = patch.filter;
    if (patch.channel !== undefined) body["channel"] = patch.channel;
    if (patch.rateLimit !== undefined) body["rateLimit"] = patch.rateLimit;
    return this.#transport.request<EndpointView>(
      "PATCH",
      `/v1/endpoints/${encodeURIComponent(id)}`,
      body,
    );
  }

  /** Delete an endpoint — `DELETE /v1/endpoints/:id`. */
  async deleteEndpoint(id: string): Promise<void> {
    await this.#transport.request<void>(
      "DELETE",
      `/v1/endpoints/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Rotate an endpoint's signing secret with **zero downtime** —
   * `POST /v1/endpoints/:id/rotate-secret`. A fresh secret is installed while the
   * old one keeps signing for an overlap window, so deliveries carry both
   * signatures until your receivers switch — no webhook is dropped mid-rotation.
   * The returned {@link CreatedEndpoint} carries the **new** signing `secret`
   * **once**; persist it and configure your receivers, then let the old one expire.
   * Omit `input` to auto-generate the secret with the default overlap.
   */
  async rotateEndpointSecret(
    id: string,
    input: RotateEndpointSecretInput = {},
  ): Promise<CreatedEndpoint> {
    const body: Record<string, unknown> = {};
    if (input.secret !== undefined) body["secret"] = input.secret;
    if (input.overlapMs !== undefined) body["overlapMs"] = input.overlapMs;
    return this.#transport.request<CreatedEndpoint>(
      "POST",
      `/v1/endpoints/${encodeURIComponent(id)}/rotate-secret`,
      body,
    );
  }

  /**
   * Send a one-shot test webhook to the endpoint and return the result
   * synchronously — `POST /v1/endpoints/:id/test`. The delivery is not stored,
   * not queued, and does not count against the tenant's monthly quota.
   * Useful to verify that an endpoint is reachable and configured correctly
   * after creation or a configuration change. Omit `input` for a generic test
   * event (`eventType: "test"`, `payload: {"test":true}`).
   */
  async testEndpoint(id: string, input: TestEndpointInput = {}): Promise<TestEndpointResult> {
    const body: Record<string, unknown> = {};
    if (input.eventType !== undefined) body["eventType"] = input.eventType;
    if (input.payload !== undefined) body["payload"] = input.payload;
    return this.#transport.request<TestEndpointResult>(
      "POST",
      `/v1/endpoints/${encodeURIComponent(id)}/test`,
      body,
    );
  }

  /**
   * List an endpoint's delivery history, newest-first —
   * `GET /v1/endpoints/:id/deliveries`. Each item is the current state of one
   * (message, endpoint) delivery — status, attempts, last error, and the source
   * `messageId` so you can navigate to the full message detail. Keyset-paginated:
   * pass the returned {@link EndpointDeliveryListPage.nextCursor} back as
   * {@link ListEndpointDeliveriesParams.cursor} to fetch the next page (`null` = last page).
   */
  async listEndpointDeliveries(
    id: string,
    params: ListEndpointDeliveriesParams = {},
  ): Promise<EndpointDeliveryListPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined && params.cursor !== null) query.set("cursor", params.cursor);
    const qs = query.toString();
    return this.#transport.request<EndpointDeliveryListPage>(
      "GET",
      `/v1/endpoints/${encodeURIComponent(id)}/deliveries${qs.length > 0 ? `?${qs}` : ""}`,
    );
  }

  /**
   * Get delivery statistics for an endpoint — `GET /v1/endpoints/{id}/stats`.
   * Returns totals (total, succeeded, failed), the overall success rate and mean
   * attempt duration, and a per-UTC-day breakdown over a trailing window of up to
   * 30 calendar days (default 7). Use the `daily` array to spot failure trends; use
   * `successRate` for a quick health gauge. Another tenant's (or an unknown) endpoint
   * is `404`.
   */
  async getEndpointStats(
    id: string,
    params: GetEndpointStatsParams = {},
  ): Promise<EndpointStatsView> {
    const query = new URLSearchParams();
    if (params.days !== undefined) query.set("days", String(params.days));
    const qs = query.toString();
    return this.#transport.request<EndpointStatsView>(
      "GET",
      `/v1/endpoints/${encodeURIComponent(id)}/stats${qs.length > 0 ? `?${qs}` : ""}`,
    );
  }

  /**
   * List all deliveries for the authenticated tenant, newest-first —
   * `GET /v1/deliveries`. The app-wide cross-endpoint view: every (message,
   * endpoint) delivery pair with `status`, `attempts`, `lastError`, `messageId`,
   * and `endpointId`. Filter by `?status=dead_letter` to surface all failed
   * deliveries at a glance — the canonical "what broke?" debugging view.
   * Keyset-paginated: pass the returned {@link AppDeliveryListPage.nextCursor}
   * back as {@link ListDeliveriesParams.cursor} (`null` = last page).
   */
  async listDeliveries(params: ListDeliveriesParams = {}): Promise<AppDeliveryListPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined && params.cursor !== null) query.set("cursor", params.cursor);
    if (params.status !== undefined && params.status !== null) query.set("status", params.status);
    const qs = query.toString();
    return this.#transport.request<AppDeliveryListPage>(
      "GET",
      `/v1/deliveries${qs.length > 0 ? `?${qs}` : ""}`,
    );
  }

  /**
   * Fetch a single delivery by ID — `GET /v1/deliveries/:id`. Returns the current
   * state of the `(message, endpoint)` delivery: status, attempts, next-retry time,
   * last error, `messageId`, and `endpointId`. Another tenant's (or unknown) delivery
   * is a `404` {@link PosthornApiError}.
   */
  async getDelivery(id: string): Promise<AppDeliveryView> {
    return this.#transport.request<AppDeliveryView>(
      "GET",
      `/v1/deliveries/${encodeURIComponent(id)}`,
    );
  }

  /**
   * List the attempt history for a single delivery — `GET /v1/deliveries/:id/attempts`.
   * Returns the same per-attempt records as {@link listMessageAttempts} but scoped to
   * one `(message, endpoint)` pair. Oldest-first, keyset-paginated: pass
   * {@link AttemptListPage.nextCursor} back as `cursor` (`null` = last page).
   */
  async listDeliveryAttempts(
    id: string,
    params: ListAttemptsParams = {},
  ): Promise<AttemptListPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined && params.cursor !== null) query.set("cursor", params.cursor);
    const qs = query.toString();
    return this.#transport.request<AttemptListPage>(
      "GET",
      `/v1/deliveries/${encodeURIComponent(id)}/attempts${qs.length > 0 ? `?${qs}` : ""}`,
    );
  }

  /**
   * Read your own message usage and current-month quota status — `GET /v1/usage`.
   * Defaults to the current UTC month; pass `{ from, to }` (inclusive `YYYY-MM-DD`
   * UTC days) to pull a historical window. The returned {@link TenantUsage.quota}
   * always reports the current month (used / remaining / when it resets), so you can
   * track your plan limit regardless of the queried range — surface it to warn a user
   * before they hit a `429`.
   */
  async getUsage(params: GetUsageParams = {}): Promise<TenantUsage> {
    const query = new URLSearchParams();
    if (params.from !== undefined) query.set("from", params.from);
    if (params.to !== undefined) query.set("to", params.to);
    const qs = query.toString();
    return this.#transport.request<TenantUsage>(
      "GET",
      `/v1/usage${qs.length > 0 ? `?${qs}` : ""}`,
    );
  }

  /** List the tenant's event type catalog — `GET /v1/event-types`. */
  async listEventTypes(params: ListEventTypesParams = {}): Promise<EventTypeListPage> {
    const query = new URLSearchParams();
    if (params.includeArchived === true) {
      query.set("includeArchived", "true");
    }
    const qs = query.toString();
    return this.#transport.request<EventTypeListPage>(
      "GET",
      `/v1/event-types${qs.length > 0 ? `?${qs}` : ""}`,
    );
  }

  /** Create an event type — `POST /v1/event-types`. */
  async createEventType(input: CreateEventTypeInput): Promise<EventTypeView> {
    const body: Record<string, unknown> = { id: input.id, name: input.name };
    if (input.description !== undefined) body["description"] = input.description;
    if (input.schemaExample !== undefined) body["schemaExample"] = input.schemaExample;
    return this.#transport.request<EventTypeView>("POST", "/v1/event-types", body);
  }

  /** Fetch one event type — `GET /v1/event-types/:id`. */
  async getEventType(id: string): Promise<EventTypeView> {
    return this.#transport.request<EventTypeView>(
      "GET",
      `/v1/event-types/${encodeURIComponent(id)}`,
    );
  }

  /** Update an event type — `PATCH /v1/event-types/:id`. Only provided fields change. */
  async updateEventType(id: string, patch: UpdateEventTypeInput): Promise<EventTypeView> {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body["name"] = patch.name;
    if (patch.description !== undefined) body["description"] = patch.description;
    if (patch.schemaExample !== undefined) body["schemaExample"] = patch.schemaExample;
    return this.#transport.request<EventTypeView>(
      "PATCH",
      `/v1/event-types/${encodeURIComponent(id)}`,
      body,
    );
  }

  /** Archive an event type — `DELETE /v1/event-types/:id`. */
  async archiveEventType(id: string): Promise<void> {
    await this.#transport.request<void>(
      "DELETE",
      `/v1/event-types/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Mint a consumer portal session for one of your customers —
   * `POST /v1/portal/sessions`. Returns a `token` and a `portalUrl`; redirect
   * your customer to `portalUrl` and they will be able to manage their webhook
   * endpoints without seeing your API key. The session is scoped to your tenant.
   */
  async createPortalSession(input: CreatePortalSessionInput): Promise<PortalSessionResult> {
    const body: Record<string, unknown> = { externalUserId: input.externalUserId };
    if (input.expiresIn !== undefined) {
      body["expiresIn"] = input.expiresIn;
    }
    return this.#transport.request<PortalSessionResult>("POST", "/v1/portal/sessions", body);
  }
}
