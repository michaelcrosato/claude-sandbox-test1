export interface WorkerConfig {
  readonly batchSize: number;
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
  readonly idlePollMs: number;
  readonly visibilityTimeoutMs: number;
}

export interface PosthornConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly maxBodyBytes: number;
  readonly adminToken: string | null;
  readonly worker: WorkerConfig;
  readonly endpointAutoDisableAfterMs: number;
}

type Env = Pick<NodeJS.ProcessEnv, string>;

const DEFAULTS = {
  host: '0.0.0.0',
  port: 3000,
  dataDir: './posthorn-data',
  maxBodyBytes: 1_000_000,
  workerBatchSize: 16,
  workerConcurrency: 8,
  workerRequestTimeoutMs: 10_000,
  workerIdlePollMs: 1_000,
  workerVisibilityTimeoutMs: 30_000,
  endpointAutoDisableAfterMs: 432_000_000,
} as const;

export function loadConfig(env: Env = process.env): PosthornConfig {
  const adminToken = optionalString(env.POSTHORN_ADMIN_TOKEN);
  if (adminToken !== null && adminToken.length < 16) {
    throw new Error('POSTHORN_ADMIN_TOKEN must be at least 16 characters when set.');
  }

  return Object.freeze({
    host: optionalString(env.POSTHORN_HOST) ?? DEFAULTS.host,
    port: integerEnv(env.POSTHORN_PORT, 'POSTHORN_PORT', DEFAULTS.port, { min: 1 }),
    dataDir: optionalString(env.POSTHORN_DATA_DIR) ?? DEFAULTS.dataDir,
    maxBodyBytes: integerEnv(env.POSTHORN_MAX_BODY_BYTES, 'POSTHORN_MAX_BODY_BYTES', DEFAULTS.maxBodyBytes, {
      min: 1,
    }),
    adminToken,
    worker: Object.freeze({
      batchSize: integerEnv(env.POSTHORN_WORKER_BATCH_SIZE, 'POSTHORN_WORKER_BATCH_SIZE', DEFAULTS.workerBatchSize, {
        min: 1,
      }),
      concurrency: integerEnv(env.POSTHORN_WORKER_CONCURRENCY, 'POSTHORN_WORKER_CONCURRENCY', DEFAULTS.workerConcurrency, {
        min: 1,
      }),
      requestTimeoutMs: integerEnv(
        env.POSTHORN_WORKER_REQUEST_TIMEOUT_MS,
        'POSTHORN_WORKER_REQUEST_TIMEOUT_MS',
        DEFAULTS.workerRequestTimeoutMs,
        { min: 1 },
      ),
      idlePollMs: integerEnv(env.POSTHORN_WORKER_IDLE_POLL_MS, 'POSTHORN_WORKER_IDLE_POLL_MS', DEFAULTS.workerIdlePollMs, {
        min: 1,
      }),
      visibilityTimeoutMs: integerEnv(
        env.POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS,
        'POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS',
        DEFAULTS.workerVisibilityTimeoutMs,
        { min: 1 },
      ),
    }),
    endpointAutoDisableAfterMs: integerEnv(
      env.POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS,
      'POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS',
      DEFAULTS.endpointAutoDisableAfterMs,
      { min: 0 },
    ),
  });
}

function optionalString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function integerEnv(
  value: string | undefined,
  name: string,
  defaultValue: number,
  options: { readonly min: number },
): number {
  if (value === undefined) return defaultValue;
  const raw = value.trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer.`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  if (parsed < options.min) {
    throw new Error(`${name} must be >= ${options.min}.`);
  }

  return parsed;
}
