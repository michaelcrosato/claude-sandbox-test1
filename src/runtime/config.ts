/**
 * Gateway configuration — the typed, validated settings that turn the Posthorn
 * library into a runnable standalone service.
 *
 * {@link loadConfig} is a **pure** function of an environment-like record: it reads
 * the `POSTHORN_*` variables, applies defaults, validates, and returns a frozen
 * {@link GatewayConfig} — or throws {@link ConfigError} with an actionable message.
 * Keeping it pure means the entire configuration surface is exhaustively
 * unit-testable without touching `process.env`, a socket, or the filesystem;
 * `main.ts` is the only place that reads the real `process.env`. This mirrors the
 * codebase's pure-core/thin-I/O split (the HTTP handler, the delivery worker): all
 * decisions are pure, only the outermost shell does I/O.
 */

import {
  DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
  DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
} from "../http/server.js";
import {
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WORKER_BATCH_SIZE,
  DEFAULT_WORKER_CONCURRENCY,
} from "../worker/delivery-worker.js";
import {
  DEFAULT_FANOUT_BATCH_SIZE,
  DEFAULT_FANOUT_GRACE_MS,
  DEFAULT_FANOUT_IDLE_POLL_MS,
} from "../fanout/fanout-dispatcher.js";
import { DEFAULT_VISIBILITY_TIMEOUT_MS } from "../queue/delivery-queue.js";
import { DEFAULT_AUTO_DISABLE_AFTER_MS, MAX_RATE_LIMIT } from "../endpoints/endpoint.js";
import { DEFAULT_CONNECT_TIMEOUT_MS } from "../net/guarded-transport.js";
import { DEFAULT_PG_POOL_MAX } from "../db/postgres.js";
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  isLogThreshold,
  type LogThreshold,
} from "../logging/logger.js";
import type { HstsPolicy } from "../http/security-headers.js";
import type { BillingConfig, BillingProviderKind } from "../billing/index.js";

/**
 * Default bind host. `0.0.0.0` is the right default for the headline deployment
 * mode (a single container, where the port is published to the host) — a host
 * bound to loopback would be unreachable through the container boundary. Override
 * with `POSTHORN_HOST=127.0.0.1` to restrict to loopback on a shared machine.
 */
export const DEFAULT_HOST = "0.0.0.0";

/** Default TCP port the HTTP API listens on. */
export const DEFAULT_PORT = 3000;

/** Default data directory: durable SQLite files live here (the "no Redis" wedge). */
export const DEFAULT_DATA_DIR = "./posthorn-data";

/** Sentinel `dataDir` selecting an ephemeral, process-lifetime store (no files). */
export const MEMORY_DATA_DIR = ":memory:";

/** The `0`-port convention: bind an OS-assigned ephemeral port (used by tests). */
const EPHEMERAL_PORT = 0;

/** Highest valid TCP port. */
const MAX_PORT = 65_535;

/**
 * Default graceful-shutdown drain window: 10s. On `stop()` the gateway stops
 * accepting new connections and lets in-flight HTTP requests finish, force-closing
 * any still-active socket only after this window so a slow or stuck request cannot
 * delay shutdown past the orchestrator's termination grace. `0` disables the cutoff
 * (the drain is then bounded only by the per-request timeout). Size your
 * orchestrator's termination grace (Kubernetes `terminationGracePeriodSeconds`,
 * `docker stop -t`) at or above this value so the drain completes before SIGKILL.
 */
export const DEFAULT_HTTP_SHUTDOWN_GRACE_MS = 10_000;

/** Validated worker tunables. Mirrors the {@link DeliveryWorker}/queue option names. */
export interface WorkerConfig {
  /** Tasks claimed and delivered per tick. */
  readonly batchSize: number;
  /** Maximum deliveries in flight at once within a tick (`1` = sequential). */
  readonly concurrency: number;
  /** Total per-attempt HTTP timeout (DNS + connect + response), in ms. */
  readonly requestTimeoutMs: number;
  /**
   * Connect-only deadline (DNS + TCP connect), in ms. Shorter than
   * {@link requestTimeoutMs} so an unreachable endpoint fails fast instead of
   * consuming the whole budget. `0` disables it (the total deadline alone governs).
   */
  readonly connectTimeoutMs: number;
  /** Pause between idle polls, in ms. */
  readonly idlePollMs: number;
  /** A claimed task's lease lifetime before it may be reclaimed, in ms. */
  readonly visibilityTimeoutMs: number;
}

/** Validated fan-out dispatcher tunables. Mirrors the `FanoutDispatcher` options. */
export interface FanoutConfig {
  /** How old (ms) a pending message must be before the dispatcher treats it as an orphan. */
  readonly graceMs: number;
  /** Messages drained per dispatcher sweep. */
  readonly batchSize: number;
  /** Pause between idle dispatcher polls, in ms. */
  readonly idlePollMs: number;
}

/** The fully-resolved, validated configuration a {@link createGateway} consumes. */
export interface GatewayConfig {
  /** Interface to bind. See {@link DEFAULT_HOST}. */
  readonly host: string;
  /** TCP port to bind. `0` asks the OS for an ephemeral port (tests). */
  readonly port: number;
  /**
   * Where durable state lives: a directory path (one SQLite file per store), or
   * {@link MEMORY_DATA_DIR} for an ephemeral, process-lifetime store. Ignored when
   * {@link databaseUrl} selects the Postgres backend.
   */
  readonly dataDir: string;
  /**
   * Postgres connection string selecting the **PostgreSQL storage backend**, or
   * `null` (the default — `POSTHORN_DATABASE_URL` unset) to use the embedded SQLite
   * backend under {@link dataDir} (the "single process, no external database" wedge).
   * When set, all six stores (apps, endpoints, messages, queue, attempts, event
   * types) share the one Postgres database it names — the horizontally-scalable
   * backend enabling active/active deployments and the hosted cloud tier; {@link
   * dataDir} is then unused. Must be a `postgres:`/`postgresql:` URL.
   * See `POSTHORN_DATABASE_URL`.
   */
  readonly databaseUrl: string | null;
  /**
   * Maximum connections the shared Postgres pool opens (the PostgreSQL backend
   * only; ignored on SQLite). Defaults to {@link DEFAULT_PG_POOL_MAX}. Because
   * every replica's pool draws on the database's one server-side connection
   * budget, size it so `replicas × databasePoolMax` stays under the server's
   * `max_connections`. See `POSTHORN_PG_POOL_MAX` and {@link DEFAULT_PG_POOL_MAX}.
   */
  readonly databasePoolMax: number;
  /** Request-body cap, in bytes (`413` beyond it). */
  readonly maxBodyBytes: number;
  /**
   * Idle keep-alive socket timeout in ms (`server.keepAliveTimeout`). Defaults to
   * {@link DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS} (Node's own default). Behind a
   * connection-pooling reverse proxy / load balancer, set this **above** the LB's idle
   * timeout to avoid the upstream `502` reuse race. `0` disables it.
   * See `POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS`.
   */
  readonly httpKeepAliveTimeoutMs: number;
  /**
   * Complete-request-headers deadline in ms (`server.headersTimeout`) — the slow-headers
   * Slowloris bound. Defaults to {@link DEFAULT_HTTP_HEADERS_TIMEOUT_MS}. Must be
   * `<= httpRequestTimeoutMs` when both are non-zero. `0` disables it.
   * See `POSTHORN_HTTP_HEADERS_TIMEOUT_MS`.
   */
  readonly httpHeadersTimeoutMs: number;
  /**
   * Whole-request (headers + body) deadline in ms (`server.requestTimeout`) — the
   * slow-body Slowloris bound, independent of {@link maxBodyBytes}. Defaults to
   * {@link DEFAULT_HTTP_REQUEST_TIMEOUT_MS}. `0` disables it.
   * See `POSTHORN_HTTP_REQUEST_TIMEOUT_MS`.
   */
  readonly httpRequestTimeoutMs: number;
  /**
   * Graceful-shutdown drain window in ms. On {@link createGateway}'s `stop()` the
   * HTTP server stops accepting new connections and lets in-flight requests finish;
   * any socket still active after this window is force-closed so a slow or stuck
   * request cannot delay shutdown past the orchestrator's termination grace. Defaults
   * to {@link DEFAULT_HTTP_SHUTDOWN_GRACE_MS}. `0` disables the cutoff (the drain is
   * then bounded only by {@link httpRequestTimeoutMs}). Keep it at or below the
   * orchestrator's termination grace. See `POSTHORN_HTTP_SHUTDOWN_GRACE_MS`.
   */
  readonly httpShutdownGraceMs: number;
  /**
   * Canonical public base URL the portal-session links (`POST /v1/portal/sessions`
   * → `portalUrl`) are built from, or `null` to derive them from each request's
   * `Host` + `X-Forwarded-Proto` (the default — unchanged behavior). When set it is
   * the authoritative origin — the correct posture behind a host-rewriting proxy,
   * where the inbound `Host` header is the gateway's *internal* name rather than the
   * public one, and it never trusts a client-settable header to build an
   * operator-facing link. A bare `http`/`https` origin (scheme + host [+ port], no
   * path/query/fragment/credentials), normalized at load. See `POSTHORN_PUBLIC_BASE_URL`.
   */
  readonly publicBaseUrl: string | null;
  /**
   * Bootstrap token for the admin/control-plane HTTP API (`/v1/admin/*`), or
   * `null` to leave that API **disabled** (the default — `POSTHORN_ADMIN_TOKEN`
   * unset). While disabled the admin routes return `404`, indistinguishable from a
   * nonexistent path, so remote provisioning is an explicit opt-in and the default
   * attack surface is unchanged. When set, the token must be at least
   * {@link MIN_ADMIN_TOKEN_LENGTH} characters — a trivially weak root credential is
   * rejected at boot rather than left as an open door.
   */
  readonly adminToken: string | null;
  /**
   * How long (ms) an endpoint must be failing continuously before it is
   * automatically disabled. `0` turns auto-disabling off (health is still tracked).
   * See {@link DEFAULT_AUTO_DISABLE_AFTER_MS}.
   */
  readonly endpointAutoDisableAfterMs: number;
  /**
   * Data-retention window in days. Data older than this many days is deleted
   * by the {@link DataPruner} on its hourly sweep. `0` disables pruning (the
   * default — stores grow unbounded). When non-zero, must be >= 1.
   * See `POSTHORN_RETENTION_DAYS`.
   */
  readonly retentionDays: number;
  /**
   * Gateway-wide default rate limit (deliveries per minute) applied to any
   * endpoint whose per-endpoint `rateLimit` is `null`. `null` means no gateway
   * default — only explicitly-configured endpoints are rate-limited.
   * See `POSTHORN_DEFAULT_RATE_LIMIT`.
   */
  readonly defaultRateLimit: number | null;
  /**
   * Allow webhook endpoints to target private/internal addresses. `false` (the
   * default) is secure-by-default: registering an endpoint whose URL points at
   * loopback, an RFC 1918 / link-local / CGNAT range, the cloud-metadata address
   * (`169.254.169.254`), or a bare single-label/`.local`/`.internal` host is
   * rejected with `400 url_not_allowed` — the SSRF defense for a webhook *sender*.
   * Set `true` only when this instance legitimately delivers to trusted internal
   * services (a single-tenant self-host inside a private network).
   * See `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS` and `net/ssrf-guard.ts`.
   */
  readonly allowPrivateNetworks: boolean;
  /**
   * Minimum severity of operational log lines emitted to stdout (JSON Lines):
   * `debug` | `info` | `warn` | `error` | `silent`. `info` (the default) shows
   * request access lines and errors while keeping the `/healthz` and `/metrics`
   * probe traffic (logged at `debug`) quiet; `silent` disables logging entirely.
   * See `POSTHORN_LOG_LEVEL` and {@link import("../logging/logger.js").Logger}.
   */
  readonly logLevel: LogThreshold;
  /**
   * HTTP Strict Transport Security policy for the response edge. Disabled by
   * default (`maxAgeSeconds: 0` — no header emitted), because HSTS is only safe once
   * the origin is genuinely reached over HTTPS: an over-long `max-age` published
   * before a host/subdomain is TLS-ready locks it out of plain HTTP for that window.
   * Enable deliberately (this service terminates TLS at an upstream proxy).
   * See `POSTHORN_HSTS_MAX_AGE` / `_INCLUDE_SUBDOMAINS` / `_PRELOAD` and
   * {@link import("../http/security-headers.js").hstsHeaderValue}.
   */
  readonly hsts: HstsPolicy;
  /** Delivery-worker tunables. */
  readonly worker: WorkerConfig;
  /** Fan-out dispatcher (transactional-outbox relay) tunables. */
  readonly fanout: FanoutConfig;
  /**
   * Billing backend settings. Defaults to the `none` provider (the
   * {@link import("../billing/index.js").NoopBillingProvider} — billing disabled,
   * the webhook route `404`), so the open-core gateway carries no payment dependency
   * unless an operator opts in via `POSTHORN_BILLING_PROVIDER=stripe`.
   * See `POSTHORN_BILLING_PROVIDER` / `POSTHORN_STRIPE_*`.
   */
  readonly billing: BillingConfig;
}

/** A configuration value was missing-but-required or malformed. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** An environment-like record. `process.env` (`NodeJS.ProcessEnv`) satisfies this. */
export type Env = Readonly<Record<string, string | undefined>>;

interface IntBounds {
  readonly min: number;
  readonly max?: number;
}

/**
 * Read an integer env var, applying `fallback` when unset/blank and validating it
 * is an integer within `[min, max]`. Rejects non-integers and out-of-range values
 * with a {@link ConfigError} naming the offending key — fail fast and loud at boot
 * rather than mis-behaving later.
 */
function readInt(env: Env, key: string, fallback: number, bounds: IntBounds): number {
  const raw = env[key];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fallback;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (value < bounds.min || value > max) {
    throw new ConfigError(`${key} must be between ${bounds.min} and ${max}, got ${value}`);
  }
  return value;
}

/** Read a non-empty string env var, falling back when unset or blank. */
function readString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

/**
 * Read a boolean env var: `"true"`/`"1"` → `true`, `"false"`/`"0"` → `false`
 * (case-insensitive, surrounding whitespace ignored). Unset or blank yields
 * `fallback`; any other value is a {@link ConfigError} (fail fast rather than
 * silently coercing a typo like `"yes"` to `false`).
 */
function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") {
    return fallback;
  }
  if (trimmed === "true" || trimmed === "1") {
    return true;
  }
  if (trimmed === "false" || trimmed === "0") {
    return false;
  }
  throw new ConfigError(
    `${key} must be "true" or "false" (or 1/0), got ${JSON.stringify(raw)}`,
  );
}

/**
 * Minimum length of `POSTHORN_ADMIN_TOKEN` when the admin API is enabled. The token
 * is a root credential that provisions tenants and API keys, so a trivially short
 * one is rejected at boot (fail fast) rather than silently accepted. 16 characters
 * is a floor, not a recommendation — operators should use a long random value
 * (e.g. `openssl rand -hex 32`).
 */
export const MIN_ADMIN_TOKEN_LENGTH = 16;

/**
 * Read the optional gateway-wide default rate limit. Unset or blank yields `null`
 * (no default — endpoints without an explicit limit are unrestricted). When set,
 * must be a positive integer in `[1, MAX_RATE_LIMIT]`.
 */
function readDefaultRateLimit(env: Env): number | null {
  const raw = env["POSTHORN_DEFAULT_RATE_LIMIT"];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value)) {
    throw new ConfigError(
      `POSTHORN_DEFAULT_RATE_LIMIT must be an integer, got ${JSON.stringify(raw)}`,
    );
  }
  if (value < 1 || value > MAX_RATE_LIMIT) {
    throw new ConfigError(
      `POSTHORN_DEFAULT_RATE_LIMIT must be between 1 and ${MAX_RATE_LIMIT}, got ${value}`,
    );
  }
  return value;
}

/**
 * Read the minimum log level. Unset or blank yields {@link DEFAULT_LOG_LEVEL}
 * (`"info"`). Accepts `debug`/`info`/`warn`/`error`/`silent` (case-insensitive,
 * trimmed); any other value is a {@link ConfigError} (fail fast rather than
 * silently defaulting a typo like `"verbose"`).
 */
function readLogLevel(env: Env): LogThreshold {
  const raw = env["POSTHORN_LOG_LEVEL"];
  if (raw === undefined) {
    return DEFAULT_LOG_LEVEL;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") {
    return DEFAULT_LOG_LEVEL;
  }
  if (!isLogThreshold(trimmed)) {
    throw new ConfigError(
      `POSTHORN_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return trimmed;
}

/**
 * Read the optional admin-API bootstrap token. Unset or blank yields `null` (the
 * admin API stays disabled — every `/v1/admin/*` route is `404`). A present token
 * is trimmed and must be at least {@link MIN_ADMIN_TOKEN_LENGTH} characters, else
 * a {@link ConfigError} is thrown so a weak credential never reaches production.
 */
function readAdminToken(env: Env): string | null {
  const raw = env["POSTHORN_ADMIN_TOKEN"];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `POSTHORN_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters when set`,
    );
  }
  return trimmed;
}

/**
 * Read the optional canonical public base URL the portal-session links are built
 * from. Unset or blank yields `null` — the `portalUrl` then falls back to the
 * request's `Host` + `X-Forwarded-Proto` (today's behavior, unchanged).
 *
 * When set it is the authoritative origin for those operator-facing links, which is
 * the correct posture behind a host-rewriting proxy (where the inbound `Host` header
 * is the gateway's *internal* name, not the public one) and avoids ever trusting a
 * client-settable header to construct a link. The value must be an absolute
 * `http`/`https` URL that is a bare origin — scheme + host [+ port], with no path,
 * query, fragment, or embedded credentials — and is normalized to its origin form
 * (default port and any trailing slash dropped). Validated here so a malformed value
 * fails fast at boot rather than silently emitting broken links later.
 */
function readPublicBaseUrl(env: Env): string | null {
  const raw = env["POSTHORN_PUBLIC_BASE_URL"];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `POSTHORN_PUBLIC_BASE_URL must be an absolute http(s) URL, got ${JSON.stringify(raw)}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `POSTHORN_PUBLIC_BASE_URL must use the http or https scheme, got ${JSON.stringify(raw)}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("POSTHORN_PUBLIC_BASE_URL must not embed credentials");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      "POSTHORN_PUBLIC_BASE_URL must be a bare origin (scheme + host [+ port]) " +
        "with no path, query, or fragment",
    );
  }
  return url.origin;
}

/**
 * Read the optional Postgres connection string that selects the **PostgreSQL
 * storage backend**. Unset or blank yields `null` — the gateway then runs on the
 * default embedded SQLite backend (one file per store under `POSTHORN_DATA_DIR`,
 * the "single process, no external database" wedge).
 *
 * When set, every store (apps, endpoints, messages, queue, attempts, event types)
 * is backed by the one shared Postgres database this points at, enabling
 * horizontally-scaled / active-active deployments and the hosted cloud tier. The
 * value must be an absolute `postgres:` / `postgresql:` URL — the form the `pg`
 * driver accepts (e.g. `postgres://user:pass@host:5432/dbname`); it is validated
 * here so a malformed or wrong-scheme value fails fast at boot rather than on the
 * first query. The string is passed through **verbatim** (credentials and query
 * parameters such as `?sslmode=require` preserved) — only the scheme is checked.
 */
function readDatabaseUrl(env: Env): string | null {
  const raw = env["POSTHORN_DATABASE_URL"];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `POSTHORN_DATABASE_URL must be a valid postgres:// connection string, got ${JSON.stringify(raw)}`,
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError(
      `POSTHORN_DATABASE_URL must use the postgres or postgresql scheme, got ${JSON.stringify(raw)}`,
    );
  }
  return trimmed;
}

/** The three validated HTTP-server socket-lifetime timeouts, in ms. */
interface HttpServerTimeouts {
  readonly keepAliveTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

/**
 * Read the HTTP-server socket-lifetime timeouts. Each defaults to Node's own value
 * (so an un-tuned gateway is unchanged) and `0` disables that timeout. The one
 * cross-field rule: when both are enabled, `headersTimeout` must not exceed
 * `requestTimeout` — otherwise the whole-request deadline fires before the headers
 * deadline can, making the latter silently dead weight. Rejected at boot rather than
 * shipped as an ineffective config (the same fail-fast posture as {@link readHstsConfig}).
 */
function readHttpServerTimeouts(env: Env): HttpServerTimeouts {
  const keepAliveTimeoutMs = readInt(
    env,
    "POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS",
    DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS,
    { min: 0 },
  );
  const headersTimeoutMs = readInt(
    env,
    "POSTHORN_HTTP_HEADERS_TIMEOUT_MS",
    DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
    { min: 0 },
  );
  const requestTimeoutMs = readInt(
    env,
    "POSTHORN_HTTP_REQUEST_TIMEOUT_MS",
    DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
    { min: 0 },
  );
  if (headersTimeoutMs > 0 && requestTimeoutMs > 0 && headersTimeoutMs > requestTimeoutMs) {
    throw new ConfigError(
      `POSTHORN_HTTP_HEADERS_TIMEOUT_MS (${headersTimeoutMs}) must be <= ` +
        `POSTHORN_HTTP_REQUEST_TIMEOUT_MS (${requestTimeoutMs}) — the whole-request ` +
        "deadline cannot be shorter than the headers deadline",
    );
  }
  return { keepAliveTimeoutMs, headersTimeoutMs, requestTimeoutMs };
}

/**
 * The HSTS preload list's floor for `max-age`: one year in seconds. A `preload`
 * directive is rejected by the browser preload submission rules below this, so
 * configuring `preload` with a shorter `max-age` is a guaranteed no-op — rejected
 * at boot rather than silently shipped.
 */
export const HSTS_PRELOAD_MIN_MAX_AGE_SECONDS = 31_536_000;

/**
 * Read the optional HSTS policy. Disabled by default (`POSTHORN_HSTS_MAX_AGE` unset
 * or `0`), in which case the modifier flags must not be set on their own — a
 * `includeSubDomains`/`preload` with no `max-age` is a misconfiguration (nothing to
 * extend), rejected at boot. `preload` additionally requires `includeSubDomains` and
 * a `max-age >= 1 year`, mirroring the browser preload-list rules so an ineffective
 * `preload` directive never ships silently.
 */
function readHstsConfig(env: Env): HstsPolicy {
  const maxAgeSeconds = readInt(env, "POSTHORN_HSTS_MAX_AGE", 0, { min: 0 });
  const includeSubDomains = readBool(env, "POSTHORN_HSTS_INCLUDE_SUBDOMAINS", false);
  const preload = readBool(env, "POSTHORN_HSTS_PRELOAD", false);
  if (maxAgeSeconds === 0 && (includeSubDomains || preload)) {
    throw new ConfigError(
      "POSTHORN_HSTS_INCLUDE_SUBDOMAINS / POSTHORN_HSTS_PRELOAD require " +
        "POSTHORN_HSTS_MAX_AGE > 0 (there is no policy to extend while HSTS is disabled)",
    );
  }
  if (preload && !includeSubDomains) {
    throw new ConfigError(
      "POSTHORN_HSTS_PRELOAD requires POSTHORN_HSTS_INCLUDE_SUBDOMAINS=true " +
        "(the HSTS preload-list rules mandate includeSubDomains)",
    );
  }
  if (preload && maxAgeSeconds < HSTS_PRELOAD_MIN_MAX_AGE_SECONDS) {
    throw new ConfigError(
      `POSTHORN_HSTS_PRELOAD requires POSTHORN_HSTS_MAX_AGE >= ${HSTS_PRELOAD_MIN_MAX_AGE_SECONDS} ` +
        "(1 year, the HSTS preload-list minimum)",
    );
  }
  return Object.freeze<HstsPolicy>({ maxAgeSeconds, includeSubDomains, preload });
}

/** Default Stripe meter `event_name` a usage push is recorded under when unset. */
export const DEFAULT_STRIPE_METER_EVENT_NAME = "posthorn_messages";

/**
 * Read the optional billing settings. Disabled by default
 * (`POSTHORN_BILLING_PROVIDER` unset or `none`), in which case the gateway wires the
 * {@link import("../billing/index.js").NoopBillingProvider} and the Stripe fields are
 * inert. Selecting `stripe` **requires** `POSTHORN_STRIPE_SECRET_KEY` (rejected at
 * boot otherwise — fail fast rather than a runtime 401 on the first usage push); the
 * webhook signing secret stays optional even then — its absence keeps the inbound
 * `POST /v1/billing/webhook` route `404` (an opt-in surface, like the admin API).
 *
 * All four variables are read **unconditionally** (independent of the provider value)
 * so the whole billing configuration surface is enumerable by the doc-coverage test —
 * a var that is only conditionally read would escape that check.
 */
function readBillingConfig(env: Env): BillingConfig {
  const rawProvider = env["POSTHORN_BILLING_PROVIDER"];
  const providerText = (rawProvider ?? "").trim().toLowerCase();
  let provider: BillingProviderKind;
  if (providerText === "" || providerText === "none") {
    provider = "none";
  } else if (providerText === "stripe") {
    provider = "stripe";
  } else {
    throw new ConfigError(
      `POSTHORN_BILLING_PROVIDER must be "none" or "stripe", got ${JSON.stringify(rawProvider)}`,
    );
  }

  const rawSecret = env["POSTHORN_STRIPE_SECRET_KEY"];
  const stripeSecretKey =
    rawSecret === undefined || rawSecret.trim() === "" ? null : rawSecret.trim();
  const rawWebhook = env["POSTHORN_STRIPE_WEBHOOK_SECRET"];
  const stripeWebhookSecret =
    rawWebhook === undefined || rawWebhook.trim() === "" ? null : rawWebhook.trim();
  const stripeMeterEventName = readString(
    env,
    "POSTHORN_STRIPE_METER_EVENT_NAME",
    DEFAULT_STRIPE_METER_EVENT_NAME,
  );

  if (provider === "stripe" && stripeSecretKey === null) {
    throw new ConfigError(
      "POSTHORN_STRIPE_SECRET_KEY is required when POSTHORN_BILLING_PROVIDER=stripe",
    );
  }

  return Object.freeze<BillingConfig>({
    provider,
    stripeSecretKey,
    stripeWebhookSecret,
    stripeMeterEventName,
  });
}

/**
 * Build a validated {@link GatewayConfig} from an environment record. Pure: it
 * never reads `process.env` directly (the caller passes it) and performs no I/O,
 * so every branch is unit-testable. Throws {@link ConfigError} on the first
 * malformed value.
 *
 * Recognized variables (all optional; sensible defaults otherwise):
 * `POSTHORN_HOST`, `POSTHORN_PORT`, `POSTHORN_DATA_DIR`,
 * `POSTHORN_DATABASE_URL` (a `postgres://` URL selects the Postgres backend; unset = embedded SQLite),
 * `POSTHORN_PG_POOL_MAX` (max shared Postgres connections; Postgres backend only; default 10),
 * `POSTHORN_MAX_BODY_BYTES`,
 * `POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS` (idle keep-alive socket timeout; raise above the LB idle timeout; `0` = off),
 * `POSTHORN_HTTP_HEADERS_TIMEOUT_MS` / `POSTHORN_HTTP_REQUEST_TIMEOUT_MS` (Slowloris bounds; `0` = off; headers <= request),
 * `POSTHORN_HTTP_SHUTDOWN_GRACE_MS` (graceful-shutdown drain window before in-flight sockets are force-closed; `0` = off),
 * `POSTHORN_PUBLIC_BASE_URL` (canonical origin for portal links; unset = derive from the request Host),
 * `POSTHORN_ADMIN_TOKEN` (enables the admin/control-plane API when set),
 * `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` (`0` = off),
 * `POSTHORN_WORKER_BATCH_SIZE`, `POSTHORN_WORKER_CONCURRENCY`,
 * `POSTHORN_WORKER_REQUEST_TIMEOUT_MS`, `POSTHORN_WORKER_CONNECT_TIMEOUT_MS` (`0` = off),
 * `POSTHORN_WORKER_IDLE_POLL_MS`, `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS`,
 * `POSTHORN_FANOUT_GRACE_MS`, `POSTHORN_FANOUT_BATCH_SIZE`,
 * `POSTHORN_FANOUT_IDLE_POLL_MS`,
 * `POSTHORN_RETENTION_DAYS` (`0` = disabled, the default),
 * `POSTHORN_DEFAULT_RATE_LIMIT` (gateway-wide deliveries/min cap for endpoints without an explicit limit; unset = no default),
 * `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS` (`false` = block delivery to private/internal addresses, the SSRF default),
 * `POSTHORN_LOG_LEVEL` (`debug`/`info`/`warn`/`error`/`silent`; default `info`),
 * `POSTHORN_HSTS_MAX_AGE` (`Strict-Transport-Security max-age` in seconds; `0` = HSTS off, the default),
 * `POSTHORN_HSTS_INCLUDE_SUBDOMAINS` / `POSTHORN_HSTS_PRELOAD` (HSTS modifiers; require a non-zero max-age),
 * `POSTHORN_BILLING_PROVIDER` (`none` (default) | `stripe`; `stripe` enables metered usage + the webhook route),
 * `POSTHORN_STRIPE_SECRET_KEY` (Stripe `sk_…`; required when the provider is `stripe`),
 * `POSTHORN_STRIPE_WEBHOOK_SECRET` (Stripe `whsec_…`; optional — when unset the `POST /v1/billing/webhook` route stays `404`),
 * `POSTHORN_STRIPE_METER_EVENT_NAME` (Stripe meter `event_name` for usage pushes; default `posthorn_messages`).
 */
export function loadConfig(env: Env): GatewayConfig {
  const httpTimeouts = readHttpServerTimeouts(env);
  const config: GatewayConfig = {
    host: readString(env, "POSTHORN_HOST", DEFAULT_HOST),
    port: readInt(env, "POSTHORN_PORT", DEFAULT_PORT, {
      min: EPHEMERAL_PORT,
      max: MAX_PORT,
    }),
    dataDir: readString(env, "POSTHORN_DATA_DIR", DEFAULT_DATA_DIR),
    databaseUrl: readDatabaseUrl(env),
    databasePoolMax: readInt(env, "POSTHORN_PG_POOL_MAX", DEFAULT_PG_POOL_MAX, { min: 1 }),
    maxBodyBytes: readInt(env, "POSTHORN_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, {
      min: 1,
    }),
    httpKeepAliveTimeoutMs: httpTimeouts.keepAliveTimeoutMs,
    httpHeadersTimeoutMs: httpTimeouts.headersTimeoutMs,
    httpRequestTimeoutMs: httpTimeouts.requestTimeoutMs,
    httpShutdownGraceMs: readInt(
      env,
      "POSTHORN_HTTP_SHUTDOWN_GRACE_MS",
      DEFAULT_HTTP_SHUTDOWN_GRACE_MS,
      { min: 0 },
    ),
    publicBaseUrl: readPublicBaseUrl(env),
    adminToken: readAdminToken(env),
    endpointAutoDisableAfterMs: readInt(
      env,
      "POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS",
      DEFAULT_AUTO_DISABLE_AFTER_MS,
      { min: 0 },
    ),
    worker: Object.freeze<WorkerConfig>({
      batchSize: readInt(env, "POSTHORN_WORKER_BATCH_SIZE", DEFAULT_WORKER_BATCH_SIZE, {
        min: 1,
      }),
      concurrency: readInt(
        env,
        "POSTHORN_WORKER_CONCURRENCY",
        DEFAULT_WORKER_CONCURRENCY,
        { min: 1 },
      ),
      requestTimeoutMs: readInt(
        env,
        "POSTHORN_WORKER_REQUEST_TIMEOUT_MS",
        DEFAULT_REQUEST_TIMEOUT_MS,
        { min: 1 },
      ),
      connectTimeoutMs: readInt(
        env,
        "POSTHORN_WORKER_CONNECT_TIMEOUT_MS",
        DEFAULT_CONNECT_TIMEOUT_MS,
        { min: 0 },
      ),
      idlePollMs: readInt(env, "POSTHORN_WORKER_IDLE_POLL_MS", DEFAULT_IDLE_POLL_MS, {
        min: 0,
      }),
      visibilityTimeoutMs: readInt(
        env,
        "POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS",
        DEFAULT_VISIBILITY_TIMEOUT_MS,
        { min: 1 },
      ),
    }),
    retentionDays: readInt(env, "POSTHORN_RETENTION_DAYS", 0, { min: 0 }),
    defaultRateLimit: readDefaultRateLimit(env),
    allowPrivateNetworks: readBool(env, "POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS", false),
    logLevel: readLogLevel(env),
    hsts: readHstsConfig(env),
    fanout: Object.freeze<FanoutConfig>({
      graceMs: readInt(env, "POSTHORN_FANOUT_GRACE_MS", DEFAULT_FANOUT_GRACE_MS, {
        min: 0,
      }),
      batchSize: readInt(env, "POSTHORN_FANOUT_BATCH_SIZE", DEFAULT_FANOUT_BATCH_SIZE, {
        min: 1,
      }),
      idlePollMs: readInt(
        env,
        "POSTHORN_FANOUT_IDLE_POLL_MS",
        DEFAULT_FANOUT_IDLE_POLL_MS,
        { min: 0 },
      ),
    }),
    billing: readBillingConfig(env),
  };
  return Object.freeze(config);
}
