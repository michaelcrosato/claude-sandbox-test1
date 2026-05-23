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
  /** Per-attempt HTTP timeout, in ms. */
  readonly requestTimeoutMs: number;
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
 * Build a validated {@link GatewayConfig} from an environment record. Pure: it
 * never reads `process.env` directly (the caller passes it) and performs no I/O,
 * so every branch is unit-testable. Throws {@link ConfigError} on the first
 * malformed value.
 *
 * Recognized variables (all optional; sensible defaults otherwise):
 * `POSTHORN_HOST`, `POSTHORN_PORT`, `POSTHORN_DATA_DIR`, `POSTHORN_MAX_BODY_BYTES`,
 * `POSTHORN_WORKER_BATCH_SIZE`, `POSTHORN_WORKER_CONCURRENCY`,
 * `POSTHORN_WORKER_REQUEST_TIMEOUT_MS`,
 * `POSTHORN_WORKER_IDLE_POLL_MS`, `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS`,
 * `POSTHORN_FANOUT_GRACE_MS`, `POSTHORN_FANOUT_BATCH_SIZE`,
 * `POSTHORN_FANOUT_IDLE_POLL_MS`.
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
