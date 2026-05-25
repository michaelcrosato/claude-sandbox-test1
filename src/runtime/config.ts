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

import { DEFAULT_MAX_BODY_BYTES } from "../http/server.js";
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
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  isLogThreshold,
  type LogThreshold,
} from "../logging/logger.js";

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
   * {@link MEMORY_DATA_DIR} for an ephemeral, process-lifetime store.
   */
  readonly dataDir: string;
  /** Request-body cap, in bytes (`413` beyond it). */
  readonly maxBodyBytes: number;
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
  /** Delivery-worker tunables. */
  readonly worker: WorkerConfig;
  /** Fan-out dispatcher (transactional-outbox relay) tunables. */
  readonly fanout: FanoutConfig;
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
 * Build a validated {@link GatewayConfig} from an environment record. Pure: it
 * never reads `process.env` directly (the caller passes it) and performs no I/O,
 * so every branch is unit-testable. Throws {@link ConfigError} on the first
 * malformed value.
 *
 * Recognized variables (all optional; sensible defaults otherwise):
 * `POSTHORN_HOST`, `POSTHORN_PORT`, `POSTHORN_DATA_DIR`, `POSTHORN_MAX_BODY_BYTES`,
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
 * `POSTHORN_LOG_LEVEL` (`debug`/`info`/`warn`/`error`/`silent`; default `info`).
 */
export function loadConfig(env: Env): GatewayConfig {
  const config: GatewayConfig = {
    host: readString(env, "POSTHORN_HOST", DEFAULT_HOST),
    port: readInt(env, "POSTHORN_PORT", DEFAULT_PORT, {
      min: EPHEMERAL_PORT,
      max: MAX_PORT,
    }),
    dataDir: readString(env, "POSTHORN_DATA_DIR", DEFAULT_DATA_DIR),
    maxBodyBytes: readInt(env, "POSTHORN_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, {
      min: 1,
    }),
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
  };
  return Object.freeze(config);
}
