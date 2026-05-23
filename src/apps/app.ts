/**
 * The app (tenant) store: how Posthorn persists *who* is sending events and
 * *authenticates* them.
 *
 * Endpoints and messages are scoped by an `appId`. Until now that id was an
 * opaque string any caller could assert — there was no entity that minted it or
 * proved a request belonged to it. An {@link App} is that entity: the tenant a
 * single Posthorn instance serves, and the unit the hosted control plane meters
 * and bills. Each app owns one or more {@link ApiKey}s; presenting a key's secret
 * is how an HTTP request proves it may act as that tenant ({@link
 * AppStore.authenticate}). This is the authentication + tenancy foundation the P3
 * HTTP API sits on.
 *
 * Like {@link MessageStore}, {@link DeliveryQueue}, and {@link EndpointStore},
 * this is a backend-agnostic contract (`in-memory` reference + durable `SQLite`,
 * one shared conformance suite), so the rest of the system never depends on the
 * storage engine.
 *
 * ## Why API-key secrets are SHA-256 hashed, not password-hashed
 *
 * A key secret is 256 bits of CSPRNG output, so it is not brute-forceable and
 * needs no slow, salted KDF (bcrypt/argon2 exist to defend *low-entropy*
 * passwords). The store keeps only `sha256(secret)`, which doubles as the O(1)
 * lookup index for {@link AppStore.authenticate} — the standard way high-entropy
 * API/session tokens are stored. The plaintext is returned exactly once at
 * creation ({@link CreatedApiKey.secret}) and is never recoverable afterward.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Prefix on generated system webhook secrets. */
export const SYSTEM_WEBHOOK_SECRET_PREFIX = "sws_";

/**
 * A tenant. Immutable snapshot; every mutation produces a new one with a bumped
 * `updatedAt`.
 */
export interface App {
  /** Server-assigned unique id (e.g. `app_…`). This is the `appId` endpoints and messages reference. */
  readonly id: string;
  /** Human-readable label. Empty string when none was given. */
  readonly name: string;
  /**
   * The tenant's message quota per UTC calendar month, or `null` for **no limit**
   * (the default). When set, `POST /v1/messages` rejects a *new* message with `429`
   * once the tenant has already accepted this many messages in the current month —
   * the enforcement half of the per-tenant metering the hosted control plane bills on
   * (see {@link isQuotaExceeded} and {@link import("../storage/message-store.js").utcMonthRange}).
   * A non-negative integer; `0` blocks all sends (a suspended tenant).
   */
  readonly monthlyMessageQuota: number | null;
  /**
   * The URL Posthorn POSTs system events (e.g. `endpoint.disabled`) to, or `null`
   * if system webhooks are not configured. Must be an http/https URL. The matching
   * signing secret is never included in the app snapshot; use
   * {@link AppStore.getSystemWebhookConfig} to read both together, or
   * {@link AppStore.rotateSystemWebhookSecret} to rotate the secret.
   */
  readonly systemWebhookUrl: string | null;
  /** Creation time, epoch ms. */
  readonly createdAt: number;
  /** Time of the last mutation, epoch ms. */
  readonly updatedAt: number;
}

/**
 * The result of {@link AppStore.create} — an {@link App} snapshot plus the
 * one-time plaintext system webhook secret (if a URL was configured). The
 * secret is returned exactly once here and never again retrievable (only its
 * stored form is kept for signing); the operator must persist it now, or call
 * {@link AppStore.rotateSystemWebhookSecret} to get a fresh one.
 */
export interface CreatedApp extends App {
  /**
   * The plaintext system webhook signing secret (`sws_…`), returned once on
   * creation when {@link App.systemWebhookUrl} was configured. `null` when no
   * URL was supplied, meaning there is nothing to sign with yet.
   */
  readonly systemWebhookSecret: string | null;
}

/** The fields a caller provides to create an app. */
export interface NewApp {
  /** Optional human-readable label. Defaults to `""`. */
  readonly name?: string;
  /**
   * Optional monthly message quota (a non-negative integer), or `null`/absent for no
   * limit (the default). See {@link App.monthlyMessageQuota}.
   */
  readonly monthlyMessageQuota?: number | null;
  /**
   * The URL to send system events (e.g. `endpoint.disabled`) to. Must be an
   * http/https URL, or `null`/absent to disable system webhooks. When set, a signing
   * secret is auto-generated and returned once in the {@link CreatedApp} response.
   */
  readonly systemWebhookUrl?: string | null;
}

/** A patch applied to an existing app. Only the provided fields change. */
export interface AppUpdate {
  /** Replace the human-readable label. */
  readonly name?: string;
  /**
   * Replace the monthly message quota (a non-negative integer), or set `null` to
   * remove the limit. Omit to leave it unchanged. See {@link App.monthlyMessageQuota}.
   */
  readonly monthlyMessageQuota?: number | null;
  /**
   * Replace the system webhook URL, or set `null` to disable system webhooks
   * (which also clears the stored signing secret). Omit to leave it unchanged.
   */
  readonly systemWebhookUrl?: string | null;
}

/**
 * The non-secret metadata of an API key. The secret itself is never stored or
 * returned after creation — only its hash lives in the store. A key
 * authenticates a request as its owning app until it is revoked.
 */
export interface ApiKey {
  /** Server-assigned unique id (e.g. `ak_…`). Used to revoke the key. */
  readonly id: string;
  /** The tenant this key authenticates as. */
  readonly appId: string;
  /**
   * A non-secret display prefix of the plaintext secret (e.g. `phk_a1b2c3d4`),
   * so operators can recognise a key in a list without it being recoverable.
   */
  readonly prefix: string;
  /** Creation time, epoch ms. */
  readonly createdAt: number;
  /** When the key was revoked (epoch ms), or `null` if it is still live. */
  readonly revokedAt: number | null;
  /**
   * The last time this key successfully authenticated a request (epoch ms), or
   * `null` if it has never been used. Updated by {@link AppStore.authenticate}
   * on each successful auth. Useful for identifying stale keys.
   */
  readonly lastUsedAt: number | null;
}

/**
 * The result of minting a key: its {@link ApiKey} metadata plus the one-time
 * plaintext `secret`. The secret is shown only here — the store keeps only its
 * hash — so the caller must persist it now; it can never be retrieved again.
 */
export interface CreatedApiKey {
  readonly apiKey: ApiKey;
  /** The plaintext key secret (`phk_…`). Returned once, never recoverable. */
  readonly secret: string;
}

/**
 * Durable storage for apps and their API keys, plus the authentication entry
 * point the HTTP layer calls on every request.
 *
 * Asynchronous so one contract spans synchronous engines (in-memory, SQLite via
 * `node:sqlite`) and asynchronous ones (Postgres) alike; sync backends resolve
 * eagerly.
 */
export interface AppStore {
  /** Create an app, returning the freshly created snapshot plus the one-time system webhook secret (if configured). */
  create(input?: NewApp): Promise<CreatedApp>;
  /** Fetch an app by id, or `null` if unknown. */
  get(id: string): Promise<App | null>;
  /** List all apps, oldest-first (the control-plane view). */
  list(): Promise<readonly App[]>;
  /**
   * Apply a patch to an app and return the updated snapshot. Throws
   * {@link UnknownAppError} if the id is unknown.
   */
  update(id: string, patch: AppUpdate): Promise<App>;
  /**
   * Delete an app and **cascade-delete its API keys**. Returns `true` if the app
   * existed, `false` otherwise. (Endpoints/messages are independent stores and
   * are not touched here; reaping them is a service-level concern.)
   */
  delete(id: string): Promise<boolean>;

  /**
   * Mint a new API key for an app, returning its one-time plaintext secret.
   * Throws {@link UnknownAppError} if the app does not exist.
   */
  createApiKey(appId: string): Promise<CreatedApiKey>;
  /** List an app's keys (metadata only — never the secret), oldest-first. */
  listApiKeys(appId: string): Promise<readonly ApiKey[]>;
  /**
   * Revoke a key by id. Returns `true` if a live key was revoked, `false` if the
   * id is unknown or the key was already revoked. A revoked key never again
   * authenticates.
   */
  revokeApiKey(keyId: string): Promise<boolean>;
  /**
   * Resolve a presented plaintext secret to its owning {@link App}, or `null` if
   * no live key matches. This is the authentication entry point: the HTTP layer
   * calls it once per request and scopes the request to the returned app. On a
   * successful match the matching key's {@link ApiKey.lastUsedAt} is updated to
   * the current time (a best-effort write; failed authentications produce no
   * side effect).
   */
  authenticate(presentedSecret: string): Promise<App | null>;

  /**
   * Fetch the system webhook URL and plaintext signing secret for an app, or `null`
   * if no URL is configured or the app is unknown. Used by the delivery gateway
   * immediately after an auto-disable to determine whether to emit the
   * `endpoint.disabled` system event.
   */
  getSystemWebhookConfig(appId: string): Promise<{ url: string; secret: string } | null>;

  /**
   * Generate a fresh system webhook signing secret for an app, store it (replacing
   * any existing one), and return the plaintext. Throws {@link UnknownAppError} if
   * the app does not exist. Use this to obtain (or rotate) the secret when the URL
   * was added via {@link update} rather than at create time.
   */
  rotateSystemWebhookSecret(appId: string): Promise<string>;
}

/** Thrown when an operation references an app id the store does not hold. */
export class UnknownAppError extends Error {
  /** The unknown app id. */
  readonly appId: string;
  constructor(appId: string) {
    super(`no app with id "${appId}"`);
    this.name = "UnknownAppError";
    this.appId = appId;
  }
}

/**
 * The default system webhook secret generator: a `sws_`-prefixed, URL-safe token
 * with 144 bits of CSPRNG entropy. Inject a deterministic generator in tests.
 */
export function generateSystemWebhookSecret(): string {
  return SYSTEM_WEBHOOK_SECRET_PREFIX + randomBytes(24).toString("base64url");
}

/**
 * Validate and normalize a `systemWebhookUrl` value. Accepts `undefined`/`null`
 * (returns `null`, meaning disabled). A non-null, non-empty string must parse as
 * a valid `http:` or `https:` URL; anything else throws {@link TypeError}.
 *
 * Shared by every backend so the intake contract is identical across stores and
 * the HTTP layer does not need to re-validate.
 */
export function normalizeSystemWebhookUrl(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("systemWebhookUrl must be an http/https URL or null");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`systemWebhookUrl is not a valid URL: "${value}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("systemWebhookUrl must use http or https");
  }
  return parsed.toString();
}

/** Prefix on generated app ids. */
const APP_ID_PREFIX = "app_";
/** Prefix on generated API-key (metadata) ids. */
const API_KEY_ID_PREFIX = "ak_";
/** Prefix on generated API-key plaintext secrets. */
export const API_KEY_SECRET_PREFIX = "phk_";

/**
 * The default app-id generator: an `app_`-prefixed, URL-safe token with 144 bits
 * of CSPRNG entropy. Inject a deterministic generator in tests.
 */
export function createAppId(): string {
  return APP_ID_PREFIX + randomBytes(18).toString("base64url");
}

/**
 * The default API-key-id generator: an `ak_`-prefixed, URL-safe token with 144
 * bits of CSPRNG entropy. Inject a deterministic generator in tests.
 */
export function createApiKeyId(): string {
  return API_KEY_ID_PREFIX + randomBytes(18).toString("base64url");
}

/**
 * The default API-key *secret* generator: a `phk_`-prefixed, URL-safe token with
 * 256 bits of CSPRNG entropy — the plaintext a caller presents to authenticate.
 * Inject a deterministic generator in tests.
 */
export function generateApiKeySecret(): string {
  return API_KEY_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Hash an API-key secret for storage and lookup: lowercase hex SHA-256. Pure and
 * shared so every backend stores byte-identical hashes and a key minted on one
 * backend authenticates on another. See the module docstring for why a fast hash
 * (not a password KDF) is the correct choice for a high-entropy secret.
 */
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Number of leading characters of the secret kept as the non-secret display prefix. */
const PREFIX_LENGTH = 12;

/**
 * The non-secret display prefix of a secret: its first {@link PREFIX_LENGTH}
 * characters (e.g. `phk_a1b2c3d4`). Revealing this many characters leaves the
 * remaining entropy far beyond brute force, matching how providers show
 * `ghp_…`/`sk_…` prefixes.
 */
export function apiKeyPrefix(secret: string): string {
  return secret.slice(0, PREFIX_LENGTH);
}

/**
 * Constant-time comparison of two hex SHA-256 hashes. Used as defense-in-depth on
 * the authenticate path: the indexed lookup already requires an exact hash match,
 * and this confirms it without a content-dependent early exit. Returns `false`
 * for any malformed (non-equal-length) input rather than throwing.
 */
export function apiKeyHashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length === 0 || ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Validate an optional app name, defaulting an absent one to `""`. */
function normalizeName(name: unknown): string {
  if (name === undefined) {
    return "";
  }
  if (typeof name !== "string") {
    throw new TypeError("name must be a string");
  }
  return name;
}

/**
 * Validate an optional monthly message quota, collapsing absent/`null` to `null`
 * (no limit). A present value must be a non-negative integer; anything else throws
 * {@link TypeError}. Shared by every backend so quota intake cannot drift, and the
 * single definition of what a valid quota is.
 */
export function normalizeQuota(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("monthlyMessageQuota must be a non-negative integer or null");
  }
  return value;
}

/**
 * The single rule for whether a tenant is over its monthly message quota: `true`
 * once `currentUsage` has reached `quota`. A `null` quota means **no limit** and is
 * never exceeded. The `>=` is deliberate — when usage equals the quota, the quota is
 * spent, so the *next* message is the one rejected (a quota of `N` admits exactly `N`
 * messages per month). Pure; the HTTP layer calls it before accepting a new message.
 */
export function isQuotaExceeded(currentUsage: number, quota: number | null): boolean {
  return quota !== null && currentUsage >= quota;
}

/**
 * How many more messages a tenant may accept this period under its quota:
 * `quota - currentUsage`, floored at `0` so the soft-limit overshoot (a burst that
 * crossed the ceiling concurrently) never reports a negative allowance. A `null`
 * quota means **no limit**, so the remaining allowance is `null` (unbounded). The
 * companion to {@link isQuotaExceeded}: where that decides *whether* the next send
 * is admitted, this reports *how much* headroom is left. Pure; the self-service
 * usage route (`GET /v1/usage`) surfaces it so a tenant sees how close it is to its
 * plan limit (and a freemium user sees when to upgrade).
 */
export function quotaRemaining(currentUsage: number, quota: number | null): number | null {
  return quota === null ? null : Math.max(0, quota - currentUsage);
}

/** The validated, normalized fields of a {@link NewApp}. */
export interface NormalizedNewApp {
  readonly name: string;
  readonly monthlyMessageQuota: number | null;
  /** Normalized system webhook URL (`null` = not configured). */
  readonly systemWebhookUrl: string | null;
  /**
   * Auto-generated system webhook signing secret (`sws_…`), or `null` when
   * `systemWebhookUrl` is `null`. Stored by backends; returned once to callers
   * via {@link CreatedApp.systemWebhookSecret}.
   */
  readonly systemWebhookSecret: string | null;
}

/**
 * Validate and normalize a create call, throwing {@link TypeError} on malformed
 * input. Shared by every backend so they enforce an identical intake contract.
 */
export function normalizeNewApp(input: NewApp = {}): NormalizedNewApp {
  const url = normalizeSystemWebhookUrl(input.systemWebhookUrl);
  return {
    name: normalizeName(input.name),
    monthlyMessageQuota: normalizeQuota(input.monthlyMessageQuota),
    systemWebhookUrl: url,
    systemWebhookSecret: url !== null ? generateSystemWebhookSecret() : null,
  };
}

/**
 * Apply a validated patch to an existing app, returning the next immutable
 * snapshot with `updatedAt` advanced to `nowMs`. Each provided field is run
 * through the same validators as create. Shared by every backend so update
 * semantics cannot drift. `id` and `createdAt` are preserved.
 */
export function applyAppUpdate(current: App, patch: AppUpdate, nowMs: number): App {
  return {
    id: current.id,
    name: "name" in patch ? normalizeName(patch.name) : current.name,
    monthlyMessageQuota:
      "monthlyMessageQuota" in patch
        ? normalizeQuota(patch.monthlyMessageQuota)
        : current.monthlyMessageQuota,
    systemWebhookUrl:
      "systemWebhookUrl" in patch
        ? normalizeSystemWebhookUrl(patch.systemWebhookUrl)
        : current.systemWebhookUrl,
    createdAt: current.createdAt,
    updatedAt: nowMs,
  };
}
