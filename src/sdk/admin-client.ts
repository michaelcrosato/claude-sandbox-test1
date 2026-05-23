/**
 * The Posthorn **admin / control-plane** SDK client — the typed object an operator
 * (or a hosted dashboard) imports to *provision* a Posthorn deployment: create and
 * manage tenants (apps), mint and revoke their API keys, and read per-tenant usage.
 *
 * It is the control-plane counterpart to {@link import("./client.js").PosthornClient}
 * (the *tenant* client that sends events and manages endpoints). The two cover
 * disjoint route groups and authenticate with *different* credentials:
 *
 * - {@link PosthornClient} → the tenant routes (`/v1/messages`, `/v1/endpoints`,
 *   `/v1/usage`), authenticated by a **tenant API key**.
 * - {@link PosthornAdminClient} → the admin routes (`/v1/admin/*`), authenticated by
 *   the operator **admin token** (`POSTHORN_ADMIN_TOKEN`) — a distinct credential a
 *   tenant key never satisfies.
 *
 * The admin surface is **opt-in and disabled by default**: a gateway started without
 * an admin token returns `404` for every `/v1/admin/*` path (the surface is hidden,
 * not merely forbidden). Against such a gateway every method here rejects with a
 * {@link PosthornApiError} whose `status` is `404` — the same way a wrong/missing
 * token yields `401`.
 *
 * Faithful to the SDK's wedge: **zero runtime dependencies** (it speaks the wire over
 * the platform `fetch`, injectable for tests / exotic runtimes), and its wire types
 * are **SDK-owned views** of exactly what crosses the wire — an app/key carries no
 * secret material except the one-time plaintext returned by {@link createApiKey}. The
 * shared transport (`./http.ts`) means it cannot drift from the tenant client on
 * timeout handling, error mapping, or the Bearer envelope.
 */

import {
  DEFAULT_TIMEOUT_MS,
  HttpTransport,
  type PosthornFetch,
} from "./http.js";

/** Configuration for a {@link PosthornAdminClient}. */
export interface PosthornAdminClientOptions {
  /**
   * Base URL of the gateway, e.g. `"https://posthorn.example"`. A trailing slash is
   * tolerated and stripped.
   */
  readonly baseUrl: string;
  /**
   * The operator admin token, as configured via `POSTHORN_ADMIN_TOKEN` on the
   * gateway. Sent as `Authorization: Bearer <adminToken>` on every request. This is
   * **not** a tenant API key — it is the cross-tenant control-plane credential.
   */
  readonly adminToken: string;
  /**
   * Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}.
   * `0` disables the timeout. A timed-out request rejects with
   * {@link import("./http.js").PosthornTimeoutError}.
   */
  readonly timeoutMs?: number;
  /**
   * A custom `fetch` implementation (testing, or a runtime without a global
   * `fetch`). Defaults to the platform `fetch`.
   */
  readonly fetch?: PosthornFetch;
}

// ---------------------------------------------------------------------------
// Wire types — exactly what the /v1/admin/* surface accepts and returns. These
// mirror the server's `appView` / `apiKeyView` / `usageView`, never its domain
// types (which carry hashes and other internal state that never crosses the wire).
// ---------------------------------------------------------------------------

/** A tenant, as returned by the admin app routes. Carries no secret material. */
export interface AdminApp {
  /** Server-assigned id (e.g. `app_…`); the `appId` endpoints and messages reference. */
  readonly id: string;
  /** Human-readable label; `""` when none was given. */
  readonly name: string;
  /**
   * The tenant's message quota per UTC calendar month, or `null` for **no limit**.
   * `POST /v1/messages` rejects a new message with `429` once a capped tenant reaches
   * this many messages in the current month; `0` suspends the tenant.
   */
  readonly monthlyMessageQuota: number | null;
  /** Creation time, epoch ms. */
  readonly createdAt: number;
  /** Time of the last mutation, epoch ms. */
  readonly updatedAt: number;
}

/** Input to {@link PosthornAdminClient.createApp}; all fields optional. */
export interface CreateAppInput {
  /** Optional human-readable label. Defaults to `""`. */
  readonly name?: string;
  /**
   * Optional monthly message quota (a non-negative integer), or `null`/absent for no
   * limit (the default). See {@link AdminApp.monthlyMessageQuota}.
   */
  readonly monthlyMessageQuota?: number | null;
}

/** A patch for {@link PosthornAdminClient.updateApp}; only provided fields change. */
export interface UpdateAppInput {
  /** Replace the human-readable label. */
  readonly name?: string;
  /**
   * Replace the monthly message quota (a non-negative integer), or set `null` to
   * remove the limit. Omit to leave it unchanged — the plan upgrade/downgrade lever.
   */
  readonly monthlyMessageQuota?: number | null;
}

/** The non-secret metadata of an API key, as returned by the admin key routes. */
export interface AdminApiKey {
  /** Server-assigned id (e.g. `ak_…`). Pass to {@link PosthornAdminClient.revokeApiKey}. */
  readonly id: string;
  /** The tenant this key authenticates as. */
  readonly appId: string;
  /** Non-secret display prefix of the plaintext secret (e.g. `phk_a1b2c3d4`). */
  readonly prefix: string;
  /** Creation time, epoch ms. */
  readonly createdAt: number;
  /** When the key was revoked (epoch ms), or `null` if still live. */
  readonly revokedAt: number | null;
  /** Last time this key successfully authenticated a request (epoch ms), or `null` if unused. */
  readonly lastUsedAt: number | null;
}

/**
 * The result of {@link PosthornAdminClient.createApiKey}: the key's metadata plus its
 * one-time plaintext `secret`. The gateway returns the secret **exactly once** (it
 * stores only a hash) — hand it to the tenant now; it can never be retrieved again.
 */
export interface CreatedAdminApiKey {
  readonly apiKey: AdminApiKey;
  /** The plaintext key secret (`phk_…`) — the tenant's `apiKey` for {@link PosthornClient}. */
  readonly secret: string;
}

/** One UTC day's message count in an {@link AdminUsage} breakdown. */
export interface AdminUsageDay {
  /** The UTC day, `YYYY-MM-DD`. */
  readonly date: string;
  /** Messages accepted on this day (within the queried range). */
  readonly messages: number;
}

/** One UTC day's delivery-attempt counts in an {@link AdminDeliveryUsage} breakdown. */
export interface AdminDeliveryUsageDay {
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
 * A tenant's delivery-attempt (operations) usage over the queried range — the
 * delivery-side companion to the accepted-message counts of {@link AdminUsage}.
 */
export interface AdminDeliveryUsage {
  /** Total delivery attempts across the range (the billable operations count). */
  readonly total: number;
  /** Of `total`, attempts that succeeded. */
  readonly succeeded: number;
  /** Of `total`, attempts that failed. */
  readonly failed: number;
  /** Per-UTC-day breakdown, oldest day first; only days with at least one attempt. */
  readonly daily: readonly AdminDeliveryUsageDay[];
}

/**
 * A tenant's usage over a date range — the metering / billing read model returned by
 * {@link PosthornAdminClient.getAppUsage}: accepted messages (`total`/`daily`) plus
 * delivery-attempt operations (`deliveries`).
 */
export interface AdminUsage {
  readonly appId: string;
  /** Inclusive start day of the breakdown (UTC), `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive end day of the breakdown (UTC), `YYYY-MM-DD`. */
  readonly to: string;
  /** Total messages across the queried range. */
  readonly total: number;
  /** Per-UTC-day message breakdown, oldest day first; only days with at least one message. */
  readonly daily: readonly AdminUsageDay[];
  /** Delivery-attempt (operations) usage over the same range. */
  readonly deliveries: AdminDeliveryUsage;
}

/**
 * The date range for {@link PosthornAdminClient.getAppUsage}. Both bounds are
 * **required** inclusive `YYYY-MM-DD` UTC days (the admin metering route mandates an
 * explicit window — unlike the tenant `GET /v1/usage`, which defaults to the current
 * month). `to` must be on or after `from`, and the span is capped server-side.
 */
export interface GetAppUsageParams {
  /** Inclusive start day, `YYYY-MM-DD` (UTC). */
  readonly from: string;
  /** Inclusive end day, `YYYY-MM-DD` (UTC). Must be on or after `from`. */
  readonly to: string;
}

/**
 * A typed client for a Posthorn gateway's admin/control-plane API. Construct one per
 * `(baseUrl, adminToken)` pair and reuse it; it holds no per-request mutable state.
 */
export class PosthornAdminClient {
  readonly #transport: HttpTransport;

  constructor(options: PosthornAdminClientOptions) {
    if (typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
      throw new TypeError("PosthornAdminClient: baseUrl must be a non-empty string");
    }
    if (typeof options.adminToken !== "string" || options.adminToken.length === 0) {
      throw new TypeError("PosthornAdminClient: adminToken must be a non-empty string");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError(
        "PosthornAdminClient: timeoutMs must be a non-negative finite number",
      );
    }
    this.#transport = new HttpTransport({
      baseUrl: options.baseUrl,
      bearerToken: options.adminToken,
      timeoutMs,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
  }

  /**
   * Create a tenant — `POST /v1/admin/apps`. Omit `input` (or fields) for an unnamed,
   * unlimited tenant; set `monthlyMessageQuota` to provision it on a capped plan.
   */
  async createApp(input: CreateAppInput = {}): Promise<AdminApp> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body["name"] = input.name;
    if (input.monthlyMessageQuota !== undefined) {
      body["monthlyMessageQuota"] = input.monthlyMessageQuota;
    }
    return this.#transport.request<AdminApp>("POST", "/v1/admin/apps", body);
  }

  /** List all tenants, oldest-first — `GET /v1/admin/apps`. */
  async listApps(): Promise<readonly AdminApp[]> {
    const res = await this.#transport.request<{ data: readonly AdminApp[] }>(
      "GET",
      "/v1/admin/apps",
    );
    return res.data;
  }

  /** Fetch one tenant — `GET /v1/admin/apps/:id`. Rejects `404` if unknown. */
  async getApp(id: string): Promise<AdminApp> {
    return this.#transport.request<AdminApp>(
      "GET",
      `/v1/admin/apps/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Update a tenant — `PATCH /v1/admin/apps/:id`. Only provided fields change; set
   * `monthlyMessageQuota` to change the plan limit (or `null` to remove it). Rejects
   * `404` if the tenant is unknown.
   */
  async updateApp(id: string, patch: UpdateAppInput): Promise<AdminApp> {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body["name"] = patch.name;
    if (patch.monthlyMessageQuota !== undefined) {
      body["monthlyMessageQuota"] = patch.monthlyMessageQuota;
    }
    return this.#transport.request<AdminApp>(
      "PATCH",
      `/v1/admin/apps/${encodeURIComponent(id)}`,
      body,
    );
  }

  /**
   * Delete a tenant and **cascade-delete its API keys** — `DELETE /v1/admin/apps/:id`.
   * Rejects `404` if the tenant is unknown (a delete is never silently a no-op).
   * (Endpoints/messages are independent stores and are not reaped here.)
   */
  async deleteApp(id: string): Promise<void> {
    await this.#transport.request<void>(
      "DELETE",
      `/v1/admin/apps/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Mint an API key for a tenant — `POST /v1/admin/apps/:id/keys`. The returned
   * {@link CreatedAdminApiKey} carries the plaintext `secret` **once**; deliver it to
   * the tenant for use as their {@link PosthornClient} `apiKey`. Rejects `404` if the
   * tenant is unknown.
   */
  async createApiKey(appId: string): Promise<CreatedAdminApiKey> {
    return this.#transport.request<CreatedAdminApiKey>(
      "POST",
      `/v1/admin/apps/${encodeURIComponent(appId)}/keys`,
    );
  }

  /**
   * List a tenant's keys (metadata only — never the secret), oldest-first —
   * `GET /v1/admin/apps/:id/keys`. Rejects `404` if the tenant is unknown.
   */
  async listApiKeys(appId: string): Promise<readonly AdminApiKey[]> {
    const res = await this.#transport.request<{ data: readonly AdminApiKey[] }>(
      "GET",
      `/v1/admin/apps/${encodeURIComponent(appId)}/keys`,
    );
    return res.data;
  }

  /**
   * Revoke an API key by id — `DELETE /v1/admin/keys/:id`. A revoked key never again
   * authenticates. Rejects `404` if the id is unknown **or** the key was already
   * revoked (the surface reveals nothing about which keys ever existed).
   */
  async revokeApiKey(keyId: string): Promise<void> {
    await this.#transport.request<void>(
      "DELETE",
      `/v1/admin/keys/${encodeURIComponent(keyId)}`,
    );
  }

  /**
   * Read a tenant's message usage over a date range — `GET /v1/admin/apps/:id/usage`.
   * `range` is **required** (inclusive `YYYY-MM-DD` UTC days). Rejects `404` if the
   * tenant is unknown, `400` on a malformed/inverted/over-cap range. The control-plane
   * metering view a hosted billing/dashboard layer renders.
   */
  async getAppUsage(appId: string, range: GetAppUsageParams): Promise<AdminUsage> {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    return this.#transport.request<AdminUsage>(
      "GET",
      `/v1/admin/apps/${encodeURIComponent(appId)}/usage?${query.toString()}`,
    );
  }
}
