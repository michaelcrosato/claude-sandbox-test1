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
}

/** The reference to a message returned by {@link PosthornClient.sendMessage}. */
export interface MessageRef {
  readonly id: string;
  readonly appId: string;
  readonly eventType: string;
  readonly idempotencyKey: string | null;
  /** Creation time, epoch ms. */
  readonly createdAt: number;
}

/** The fan-out summary for an accepted message (how many endpoints it reached). */
export interface FanoutSummary {
  readonly matched: number;
  readonly skippedDisabled: number;
  readonly skippedUnsubscribed: number;
}

/** The result of {@link PosthornClient.sendMessage}. */
export interface SendMessageResult {
  readonly message: MessageRef;
  /** `true` when an idempotency key collapsed this onto an already-accepted message. */
  readonly deduplicated: boolean;
  /** The fan-out tally, or `null` when the message was a deduplicated replay. */
  readonly fanout: FanoutSummary | null;
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
  /** Wall-clock duration of the attempt, ms. */
  readonly durationMs: number;
  /** When the attempt started, epoch ms. */
  readonly attemptedAt: number;
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

/** The result of {@link PosthornClient.retryMessage}. */
export interface RetryMessageResponse {
  /** The message whose deliveries were replayed. */
  readonly id: string;
  /** How many dead-lettered deliveries were re-driven back to `pending`. */
  readonly retried: number;
  /** The refreshed per-endpoint delivery statuses (replayed ones now `pending`). */
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
  readonly createdAt: number;
  readonly deliveries: readonly DeliveryView[];
}

/** The non-secret view of an endpoint (list / get / update / create). */
export interface EndpointView {
  readonly id: string;
  readonly appId: string;
  readonly url: string;
  readonly description: string;
  /** Subscribed event types; `null` means *all* events. */
  readonly eventTypes: readonly string[] | null;
  readonly disabled: boolean;
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
}

/** A patch for {@link PosthornClient.updateEndpoint}; only provided fields change. */
export interface UpdateEndpointInput {
  readonly url?: string;
  /** Hard-swap the signing secret (no overlap). For zero-downtime use {@link PosthornClient.rotateEndpointSecret}. */
  readonly secret?: string;
  readonly description?: string;
  readonly eventTypes?: readonly string[] | null;
  readonly disabled?: boolean;
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
  /** Per-UTC-day breakdown, oldest day first; only days with at least one message. */
  readonly daily: readonly UsageDay[];
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
    if (input.idempotencyKey !== undefined) {
      body["idempotencyKey"] = input.idempotencyKey;
    }
    return this.#transport.request<SendMessageResult>("POST", "/v1/messages", body);
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
   */
  async listMessageAttempts(id: string): Promise<readonly DeliveryAttemptView[]> {
    const res = await this.#transport.request<{ data: readonly DeliveryAttemptView[] }>(
      "GET",
      `/v1/messages/${encodeURIComponent(id)}/attempts`,
    );
    return res.data;
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
}
