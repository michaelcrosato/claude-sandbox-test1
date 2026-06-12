import { randomBytes } from 'node:crypto';

import type { WorkerConfig } from './config';
import { revealEndpointSecret, SecretProtectionError } from './secret-protection';
import type { PosthornStorage } from './storage';
import { incrementDeliveryAttemptsForDelivery } from './usage';
import { signWebhook } from './webhooks';

export type DeliveryAttemptOutcome = 'succeeded' | 'failed' | 'dead_letter';
export type DeliveryFailureReason =
  | 'signing_secret_unavailable'
  | 'timeout'
  | 'network_error'
  | 'invalid_payload'
  | `http_${number}`;

export interface DeliveryWorkerOptions {
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly requestTimeoutMs?: number;
  readonly visibilityTimeoutMs?: number;
  readonly attemptBudget?: number;
  readonly endpointAutoDisableAfterMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly now?: () => Date;
  readonly fetch?: DeliveryFetch;
}

export interface DeliveryWorkerTickSummary {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLettered: number;
}

export interface DeliveryWorker {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<DeliveryWorkerTickSummary>;
}

interface DeliveryFetchInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: 'manual';
  readonly signal: AbortSignal;
}

export interface DeliveryFetchResponse {
  readonly status: number;
  readonly body?: ReadableStream<Uint8Array> | null;
}

export type DeliveryFetch = (url: string, init: DeliveryFetchInit) => Promise<DeliveryFetchResponse>;

type DeliveryResult =
  | {
      readonly outcome: 'succeeded';
      readonly responseStatus: number;
      readonly durationMs: number;
    }
  | {
      readonly outcome: 'failed';
      readonly failureReason: DeliveryFailureReason;
      readonly responseStatus: number | null;
      readonly durationMs: number;
    };

interface ResolvedWorkerOptions {
  readonly batchSize: number;
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
  readonly visibilityTimeoutMs: number;
  readonly attemptBudget: number;
  readonly endpointAutoDisableAfterMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly idlePollMs: number;
  readonly now: () => Date;
  readonly fetch: DeliveryFetch;
}

const DEFAULT_WORKER_OPTIONS = {
  batchSize: 16,
  concurrency: 8,
  requestTimeoutMs: 10_000,
  visibilityTimeoutMs: 30_000,
  attemptBudget: 8,
  endpointAutoDisableAfterMs: 432_000_000,
  baseBackoffMs: 60_000,
  maxBackoffMs: 3_600_000,
  idlePollMs: 1_000,
} as const;

const DELIVERY_ATTEMPT_ID_PREFIX = 'datt_';
const USER_AGENT = 'posthorn-delivery-worker';
const MANAGED_HEADER_NAMES = new Set([
  'content-length',
  'content-type',
  'host',
  'user-agent',
  'webhook-id',
  'webhook-signature',
  'webhook-timestamp',
]);

export function createDeliveryWorker(
  storage: PosthornStorage,
  options: DeliveryWorkerOptions & Partial<Pick<WorkerConfig, 'idlePollMs'>> = {},
): DeliveryWorker {
  const resolved = resolveWorkerOptions(options);
  let stopped = true;
  let activeTick: Promise<DeliveryWorkerTickSummary> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      activeTick = runDeliveryWorkerTick(storage, options)
        .catch((): DeliveryWorkerTickSummary => ({ claimed: 0, succeeded: 0, failed: 0, deadLettered: 0 }))
        .finally(() => {
          activeTick = null;
          schedule(resolved.idlePollMs);
        });
    }, delayMs);
  };

  return Object.freeze({
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (activeTick !== null) {
        await activeTick;
      }
    },
    tick() {
      return runDeliveryWorkerTick(storage, options);
    },
  });
}

export async function runDeliveryWorkerTick(
  storage: PosthornStorage,
  options: DeliveryWorkerOptions = {},
): Promise<DeliveryWorkerTickSummary> {
  const resolved = resolveWorkerOptions(options);
  const claimed = claimDeliveries(storage, resolved);
  const results = await mapWithConcurrency(claimed, resolved.concurrency, (task) =>
    deliverClaimedTask(storage, task, resolved),
  );

  return {
    claimed: claimed.length,
    succeeded: results.filter((result) => result === 'succeeded').length,
    failed: results.filter((result) => result === 'failed' || result === 'dead_letter').length,
    deadLettered: results.filter((result) => result === 'dead_letter').length,
  };
}

export function calculateRetryBackoffMs(
  attemptNumber: number,
  options: { readonly baseBackoffMs?: number; readonly maxBackoffMs?: number } = {},
): number {
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_WORKER_OPTIONS.baseBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_WORKER_OPTIONS.maxBackoffMs;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new RangeError('attemptNumber must be a positive integer.');
  }
  if (!Number.isSafeInteger(baseBackoffMs) || baseBackoffMs < 1) {
    throw new RangeError('baseBackoffMs must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < baseBackoffMs) {
    throw new RangeError('maxBackoffMs must be greater than or equal to baseBackoffMs.');
  }

  const exponent = Math.min(attemptNumber - 1, 30);
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** exponent);
}

function claimDeliveries(storage: PosthornStorage, options: ResolvedWorkerOptions): readonly ClaimedDelivery[] {
  const now = options.now();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + options.visibilityTimeoutMs).toISOString();
  const selectedIds: string[] = [];

  storage.db.exec('BEGIN IMMEDIATE');
  try {
    const rows = storage.db
      .prepare(`
        SELECT deliveries.id
        FROM deliveries
        INNER JOIN messages ON messages.id = deliveries.message_id
        INNER JOIN endpoints ON endpoints.id = deliveries.endpoint_id
        WHERE endpoints.enabled = 1
          AND (
            (
              deliveries.status = 'pending'
              AND (deliveries.next_attempt_at IS NULL OR deliveries.next_attempt_at <= ?)
            )
            OR (
              deliveries.status = 'delivering'
              AND deliveries.lease_expires_at IS NOT NULL
              AND deliveries.lease_expires_at <= ?
            )
          )
        ORDER BY COALESCE(deliveries.next_attempt_at, deliveries.created_at) ASC, deliveries.rowid ASC
        LIMIT ?
      `)
      .all(nowIso, nowIso, options.batchSize) as unknown as Array<{ readonly id: unknown }>;

    const update = storage.db.prepare(`
      UPDATE deliveries
      SET status = 'delivering', lease_expires_at = ?, updated_at = ?
      WHERE id = ?
        AND (
          (
            status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          )
          OR (
            status = 'delivering'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
          )
        )
    `);

    for (const row of rows) {
      const id = String(row.id);
      const result = update.run(leaseExpiresAt, nowIso, id, nowIso, nowIso);
      if (result.changes > 0) selectedIds.push(id);
    }

    storage.db.exec('COMMIT');
  } catch (error) {
    storage.db.exec('ROLLBACK');
    throw error;
  }

  if (selectedIds.length === 0) return [];
  const placeholders = selectedIds.map(() => '?').join(', ');
  const rows = storage.db
    .prepare(`
      SELECT deliveries.id,
             endpoints.id AS endpoint_id,
             deliveries.attempt_count,
             deliveries.lease_expires_at,
             endpoints.url,
             endpoints.non_secret_headers_json,
             endpoints.signing_secret_ciphertext,
             endpoints.signing_secret_key_version,
             endpoints.signing_secret_nonce,
             endpoints.previous_signing_secret_ciphertext,
             endpoints.previous_signing_secret_key_version,
             endpoints.previous_signing_secret_nonce,
             endpoints.previous_signing_secret_expires_at,
             messages.id AS message_id,
             messages.event_type,
             messages.payload_json
      FROM deliveries
      INNER JOIN endpoints ON endpoints.id = deliveries.endpoint_id
      INNER JOIN messages ON messages.id = deliveries.message_id
      WHERE deliveries.id IN (${placeholders})
    `)
    .all(...selectedIds) as unknown as ClaimedDeliveryRow[];
  const byId = new Map(rows.map((row) => [String(row.id), deliveryFromRow(row)]));

  return selectedIds.map((id) => byId.get(id)).filter((task): task is ClaimedDelivery => task !== undefined);
}

async function deliverClaimedTask(
  storage: PosthornStorage,
  task: ClaimedDelivery,
  options: ResolvedWorkerOptions,
): Promise<DeliveryAttemptOutcome | 'stale'> {
  const attemptNumber = task.attemptCount + 1;
  const attemptedAt = options.now();
  const result = await sendDelivery(storage, task, options, attemptedAt);

  if (result.outcome === 'succeeded') {
    return recordSuccess(storage, task, attemptNumber, attemptedAt, result, options) ? 'succeeded' : 'stale';
  }

  const finalOutcome = attemptNumber >= options.attemptBudget ? 'dead_letter' : 'failed';
  return recordFailure(storage, task, attemptNumber, attemptedAt, result, finalOutcome, options) ? finalOutcome : 'stale';
}

async function sendDelivery(
  storage: PosthornStorage,
  task: ClaimedDelivery,
  options: ResolvedWorkerOptions,
  attemptedAt: Date,
): Promise<DeliveryResult> {
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | null = null;
  const abortController = new AbortController();

  try {
    const rawBody = buildDeliveryBody(task);
    const secrets = resolveSigningSecrets(storage, task, attemptedAt);
    const signedHeaders = signWebhook(secrets, rawBody, {
      id: task.messageId,
      timestampSeconds: Math.floor(attemptedAt.getTime() / 1000),
    });
    const headers = buildDeliveryHeaders(task.headers, signedHeaders);

    timeout = setTimeout(() => {
      abortController.abort();
    }, options.requestTimeoutMs);

    const response = await options.fetch(task.url, {
      method: 'POST',
      headers,
      body: rawBody,
      redirect: 'manual',
      signal: abortController.signal,
    });
    await discardResponseBody(response);

    const durationMs = elapsedMs(startedAt);
    if (response.status >= 200 && response.status <= 299) {
      return { outcome: 'succeeded', responseStatus: response.status, durationMs };
    }

    return {
      outcome: 'failed',
      responseStatus: response.status,
      durationMs,
      failureReason: `http_${response.status}`,
    };
  } catch (error) {
    return {
      outcome: 'failed',
      responseStatus: null,
      durationMs: elapsedMs(startedAt),
      failureReason: classifyFailureReason(error),
    };
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function recordSuccess(
  storage: PosthornStorage,
  task: ClaimedDelivery,
  attemptNumber: number,
  attemptedAt: Date,
  result: Extract<DeliveryResult, { readonly outcome: 'succeeded' }>,
  options: ResolvedWorkerOptions,
): boolean {
  const updatedAt = options.now().toISOString();
  storage.db.exec('BEGIN IMMEDIATE');
  try {
    const update = storage.db
      .prepare(`
        UPDATE deliveries
        SET status = 'succeeded',
            attempt_count = ?,
            next_attempt_at = NULL,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'delivering' AND lease_expires_at = ?
      `)
      .run(attemptNumber, updatedAt, task.id, task.leaseExpiresAt);
    if (update.changes === 0) {
      storage.db.exec('ROLLBACK');
      return false;
    }

    insertDeliveryAttempt(storage, {
      deliveryId: task.id,
      attemptNumber,
      outcome: 'succeeded',
      responseStatus: result.responseStatus,
      durationMs: result.durationMs,
      failureReason: null,
      attemptedAt,
    });
    storage.db.exec('COMMIT');
    return true;
  } catch (error) {
    storage.db.exec('ROLLBACK');
    throw error;
  }
}

function recordFailure(
  storage: PosthornStorage,
  task: ClaimedDelivery,
  attemptNumber: number,
  attemptedAt: Date,
  result: Extract<DeliveryResult, { readonly outcome: 'failed' }>,
  outcome: 'failed' | 'dead_letter',
  options: ResolvedWorkerOptions,
): boolean {
  const now = options.now();
  const updatedAt = now.toISOString();
  const nextAttemptAt =
    outcome === 'failed'
      ? new Date(now.getTime() + calculateRetryBackoffMs(attemptNumber, options)).toISOString()
      : null;
  const nextStatus = outcome === 'failed' ? 'pending' : 'dead_letter';

  storage.db.exec('BEGIN IMMEDIATE');
  try {
    const update = storage.db
      .prepare(`
        UPDATE deliveries
        SET status = ?,
            attempt_count = ?,
            next_attempt_at = ?,
            lease_expires_at = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ? AND status = 'delivering' AND lease_expires_at = ?
      `)
      .run(nextStatus, attemptNumber, nextAttemptAt, result.failureReason, updatedAt, task.id, task.leaseExpiresAt);
    if (update.changes === 0) {
      storage.db.exec('ROLLBACK');
      return false;
    }

    insertDeliveryAttempt(storage, {
      deliveryId: task.id,
      attemptNumber,
      outcome,
      responseStatus: result.responseStatus,
      durationMs: result.durationMs,
      failureReason: result.failureReason,
      attemptedAt,
    });
    if (outcome === 'dead_letter') {
      disableEndpointAfterFailureWindow(storage, task.endpointId, now, updatedAt, options.endpointAutoDisableAfterMs);
    }
    storage.db.exec('COMMIT');
    return true;
  } catch (error) {
    storage.db.exec('ROLLBACK');
    throw error;
  }
}

function insertDeliveryAttempt(storage: PosthornStorage, attempt: DeliveryAttemptInsert): void {
  storage.db
    .prepare(`
      INSERT INTO delivery_attempts (
        id,
        delivery_id,
        attempt_number,
        outcome,
        response_status,
        duration_ms,
        failure_reason,
        attempted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      generateDeliveryAttemptId(),
      attempt.deliveryId,
      attempt.attemptNumber,
      attempt.outcome,
      attempt.responseStatus,
      attempt.durationMs,
      attempt.failureReason,
      attempt.attemptedAt.toISOString(),
    );
  incrementDeliveryAttemptsForDelivery(storage, attempt.deliveryId, attempt.attemptedAt);
}

function disableEndpointAfterFailureWindow(
  storage: PosthornStorage,
  endpointId: string,
  now: Date,
  updatedAt: string,
  endpointAutoDisableAfterMs: number,
): void {
  if (endpointAutoDisableAfterMs === 0) return;
  const cutoff = new Date(now.getTime() - endpointAutoDisableAfterMs).toISOString();

  storage.db
    .prepare(
      `
        UPDATE endpoints
        SET enabled = 0, updated_at = ?
        WHERE id = ?
          AND enabled = 1
          AND EXISTS (
            SELECT 1
            FROM delivery_attempts
            INNER JOIN deliveries ON deliveries.id = delivery_attempts.delivery_id
            WHERE deliveries.endpoint_id = endpoints.id
              AND delivery_attempts.outcome IN ('failed', 'dead_letter')
              AND delivery_attempts.attempted_at <= ?
            LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM delivery_attempts
            INNER JOIN deliveries ON deliveries.id = delivery_attempts.delivery_id
            WHERE deliveries.endpoint_id = endpoints.id
              AND delivery_attempts.outcome = 'succeeded'
              AND delivery_attempts.attempted_at > ?
            LIMIT 1
          )
      `,
    )
    .run(updatedAt, endpointId, cutoff, cutoff);
}

function buildDeliveryBody(task: ClaimedDelivery): string {
  let payload: unknown;
  try {
    payload = JSON.parse(task.payloadJson) as unknown;
  } catch {
    throw new InvalidPayloadError();
  }

  return JSON.stringify({
    id: task.messageId,
    eventType: task.eventType,
    payload,
  });
}

function resolveSigningSecrets(storage: PosthornStorage, task: ClaimedDelivery, attemptedAt: Date): string | readonly string[] {
  const currentSecret = revealEndpointSecret(storage, {
    ciphertext: task.signingSecretCiphertext,
    keyVersion: task.signingSecretKeyVersion,
    nonce: task.signingSecretNonce,
  });
  if (!isPreviousSigningSecretActive(task, attemptedAt)) {
    return currentSecret;
  }

  if (
    task.previousSigningSecretCiphertext === null ||
    task.previousSigningSecretKeyVersion === null ||
    task.previousSigningSecretNonce === null
  ) {
    throw new SecretProtectionError('Previous endpoint signing secret metadata is incomplete.');
  }

  const previousSecret = revealEndpointSecret(storage, {
    ciphertext: task.previousSigningSecretCiphertext,
    keyVersion: task.previousSigningSecretKeyVersion,
    nonce: task.previousSigningSecretNonce,
  });
  return [currentSecret, previousSecret];
}

function isPreviousSigningSecretActive(task: ClaimedDelivery, attemptedAt: Date): boolean {
  if (task.previousSigningSecretExpiresAt === null) return false;
  const expiresAtMs = Date.parse(task.previousSigningSecretExpiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new SecretProtectionError('Previous endpoint signing secret expiry is invalid.');
  }

  return expiresAtMs >= attemptedAt.getTime();
}

function buildDeliveryHeaders(
  endpointHeaders: Readonly<Record<string, string>>,
  signedHeaders: Readonly<Record<string, string | number | readonly string[] | null | undefined>>,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(endpointHeaders)) {
    if (!MANAGED_HEADER_NAMES.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }

  headers['content-type'] = 'application/json; charset=utf-8';
  headers['user-agent'] = USER_AGENT;
  for (const [name, value] of Object.entries(signedHeaders)) {
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }

  return headers;
}

async function discardResponseBody(response: DeliveryFetchResponse): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  callback: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function resolveWorkerOptions(options: DeliveryWorkerOptions & Partial<Pick<WorkerConfig, 'idlePollMs'>>): ResolvedWorkerOptions {
  return Object.freeze({
    batchSize: positiveInteger(options.batchSize, 'batchSize', DEFAULT_WORKER_OPTIONS.batchSize),
    concurrency: positiveInteger(options.concurrency, 'concurrency', DEFAULT_WORKER_OPTIONS.concurrency),
    requestTimeoutMs: positiveInteger(
      options.requestTimeoutMs,
      'requestTimeoutMs',
      DEFAULT_WORKER_OPTIONS.requestTimeoutMs,
    ),
    visibilityTimeoutMs: positiveInteger(
      options.visibilityTimeoutMs,
      'visibilityTimeoutMs',
      DEFAULT_WORKER_OPTIONS.visibilityTimeoutMs,
    ),
    attemptBudget: positiveInteger(options.attemptBudget, 'attemptBudget', DEFAULT_WORKER_OPTIONS.attemptBudget),
    endpointAutoDisableAfterMs: nonNegativeInteger(
      options.endpointAutoDisableAfterMs,
      'endpointAutoDisableAfterMs',
      DEFAULT_WORKER_OPTIONS.endpointAutoDisableAfterMs,
    ),
    baseBackoffMs: positiveInteger(options.baseBackoffMs, 'baseBackoffMs', DEFAULT_WORKER_OPTIONS.baseBackoffMs),
    maxBackoffMs: positiveInteger(options.maxBackoffMs, 'maxBackoffMs', DEFAULT_WORKER_OPTIONS.maxBackoffMs),
    idlePollMs: positiveInteger(options.idlePollMs, 'idlePollMs', DEFAULT_WORKER_OPTIONS.idlePollMs),
    now: options.now ?? (() => new Date()),
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
  });
}

function positiveInteger(value: number | undefined, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }

  return value;
}

function nonNegativeInteger(value: number | undefined, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }

  return value;
}

function deliveryFromRow(row: ClaimedDeliveryRow): ClaimedDelivery {
  return {
    id: String(row.id),
    endpointId: String(row.endpoint_id),
    attemptCount: Number(row.attempt_count),
    leaseExpiresAt: String(row.lease_expires_at),
    url: String(row.url),
    headers: parseStoredHeaders(row.non_secret_headers_json),
    signingSecretCiphertext: String(row.signing_secret_ciphertext),
    signingSecretKeyVersion: String(row.signing_secret_key_version),
    signingSecretNonce: String(row.signing_secret_nonce),
    previousSigningSecretCiphertext: nullableString(row.previous_signing_secret_ciphertext),
    previousSigningSecretKeyVersion: nullableString(row.previous_signing_secret_key_version),
    previousSigningSecretNonce: nullableString(row.previous_signing_secret_nonce),
    previousSigningSecretExpiresAt: nullableString(row.previous_signing_secret_expires_at),
    messageId: String(row.message_id),
    eventType: String(row.event_type),
    payloadJson: String(row.payload_json),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseStoredHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === null || value === undefined) return {};
  const parsed = JSON.parse(String(value)) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    headers[name] = String(headerValue);
  }

  return headers;
}

function classifyFailureReason(error: unknown): DeliveryFailureReason {
  if (error instanceof SecretProtectionError) return 'signing_secret_unavailable';
  if (error instanceof InvalidPayloadError) return 'invalid_payload';
  if (isAbortError(error)) return 'timeout';
  return 'network_error';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.toLowerCase().includes('operation was aborted'))
  );
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function generateDeliveryAttemptId(): string {
  return `${DELIVERY_ATTEMPT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
}

class InvalidPayloadError extends Error {
  constructor() {
    super('Stored message payload is invalid.');
    this.name = 'InvalidPayloadError';
  }
}

interface ClaimedDelivery {
  readonly id: string;
  readonly endpointId: string;
  readonly attemptCount: number;
  readonly leaseExpiresAt: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signingSecretCiphertext: string;
  readonly signingSecretKeyVersion: string;
  readonly signingSecretNonce: string;
  readonly previousSigningSecretCiphertext: string | null;
  readonly previousSigningSecretKeyVersion: string | null;
  readonly previousSigningSecretNonce: string | null;
  readonly previousSigningSecretExpiresAt: string | null;
  readonly messageId: string;
  readonly eventType: string;
  readonly payloadJson: string;
}

interface ClaimedDeliveryRow {
  readonly id: unknown;
  readonly endpoint_id: unknown;
  readonly attempt_count: unknown;
  readonly lease_expires_at: unknown;
  readonly url: unknown;
  readonly non_secret_headers_json: unknown;
  readonly signing_secret_ciphertext: unknown;
  readonly signing_secret_key_version: unknown;
  readonly signing_secret_nonce: unknown;
  readonly previous_signing_secret_ciphertext: unknown;
  readonly previous_signing_secret_key_version: unknown;
  readonly previous_signing_secret_nonce: unknown;
  readonly previous_signing_secret_expires_at: unknown;
  readonly message_id: unknown;
  readonly event_type: unknown;
  readonly payload_json: unknown;
}

interface DeliveryAttemptInsert {
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly outcome: DeliveryAttemptOutcome;
  readonly responseStatus: number | null;
  readonly durationMs: number;
  readonly failureReason: string | null;
  readonly attemptedAt: Date;
}
