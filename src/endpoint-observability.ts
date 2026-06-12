import { getEndpoint } from './endpoints';
import type { DeliveryStatus } from './messages';
import type { PosthornStorage } from './storage';

export interface ListEndpointDeliveriesOptions {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

export interface EndpointDeliveryHistoryRecord {
  readonly id: string;
  readonly messageId: string;
  readonly endpointId: string;
  readonly eventType: string;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EndpointDeliveriesPage {
  readonly data: readonly EndpointDeliveryHistoryRecord[];
  readonly nextCursor: string | null;
}

export interface EndpointStatusCounts {
  readonly pending: number;
  readonly delivering: number;
  readonly succeeded: number;
  readonly dead_letter: number;
}

export interface EndpointDailyStats {
  readonly date: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLettered: number;
}

export interface EndpointFailureReasonStats {
  readonly reason: string;
  readonly count: number;
}

export interface EndpointDeliveryStats {
  readonly endpointId: string;
  readonly windowDays: number;
  readonly since: string;
  readonly until: string;
  readonly total: number;
  readonly byStatus: EndpointStatusCounts;
  readonly successRate: number | null;
  readonly averageDurationMs: number | null;
  readonly daily: readonly EndpointDailyStats[];
  readonly failureReasons: readonly EndpointFailureReasonStats[];
}

export interface EndpointStatsOptions {
  readonly days?: unknown;
}

export class EndpointObservabilityValidationError extends Error {
  readonly code = 'invalid_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EndpointObservabilityValidationError';
  }
}

const DEFAULT_DELIVERIES_PAGE_LIMIT = 50;
const MAX_DELIVERIES_PAGE_LIMIT = 100;
const DEFAULT_STATS_WINDOW_DAYS = 7;
const MAX_STATS_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function listEndpointDeliveries(
  storage: PosthornStorage,
  appId: string,
  endpointId: string,
  options: ListEndpointDeliveriesOptions = {},
): EndpointDeliveriesPage | null {
  if (getEndpoint(storage, appId, endpointId) === null) return null;

  const limit = parsePageLimit(options.limit);
  const cursor = parseDeliveriesCursor(options.cursor);
  const cursorClause =
    cursor === null
      ? ''
      : `
        AND (
          deliveries.created_at < ?
          OR (deliveries.created_at = ? AND deliveries.id < ?)
        )
      `;
  const params: Array<string | number> = [appId, endpointId];
  if (cursor !== null) {
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  params.push(limit + 1);

  const rows = storage.db
    .prepare(
      `
        SELECT deliveries.id,
               deliveries.message_id,
               deliveries.endpoint_id,
               messages.event_type,
               deliveries.status,
               deliveries.attempt_count,
               deliveries.next_attempt_at,
               deliveries.last_error,
               deliveries.created_at,
               deliveries.updated_at
        FROM deliveries
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ?
          AND deliveries.endpoint_id = ?
          ${cursorClause}
        ORDER BY deliveries.created_at DESC, deliveries.id DESC
        LIMIT ?
      `,
    )
    .all(...params) as unknown as EndpointDeliveryHistoryRow[];

  const pageRows = rows.slice(0, limit);
  return {
    data: pageRows.map(endpointDeliveryHistoryFromRow),
    nextCursor: rows.length > limit ? encodeDeliveriesCursor(pageRows[pageRows.length - 1]) : null,
  };
}

export function getEndpointDeliveryStats(
  storage: PosthornStorage,
  appId: string,
  endpointId: string,
  options: EndpointStatsOptions = {},
  now = new Date(),
): EndpointDeliveryStats | null {
  if (getEndpoint(storage, appId, endpointId) === null) return null;

  const windowDays = parseWindowDays(options.days);
  const until = now.toISOString();
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const byStatus = readStatusCounts(storage, appId, endpointId, since, until);
  const total = byStatus.pending + byStatus.delivering + byStatus.succeeded + byStatus.dead_letter;
  const averageDurationMs = readAverageSuccessfulDuration(storage, appId, endpointId, since, until);

  return {
    endpointId,
    windowDays,
    since,
    until,
    total,
    byStatus,
    successRate: total === 0 ? null : byStatus.succeeded / total,
    averageDurationMs,
    daily: readDailyStats(storage, appId, endpointId, since, until),
    failureReasons: readFailureReasons(storage, appId, endpointId, since, until),
  };
}

function readStatusCounts(
  storage: PosthornStorage,
  appId: string,
  endpointId: string,
  since: string,
  until: string,
): EndpointStatusCounts {
  const rows = storage.db
    .prepare(
      `
        SELECT deliveries.status, COUNT(*) AS count
        FROM deliveries
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ?
          AND deliveries.endpoint_id = ?
          AND deliveries.created_at >= ?
          AND deliveries.created_at <= ?
        GROUP BY deliveries.status
      `,
    )
    .all(appId, endpointId, since, until) as unknown as Array<{ readonly status: unknown; readonly count: unknown }>;

  const counts: Record<DeliveryStatus, number> = {
    pending: 0,
    delivering: 0,
    succeeded: 0,
    dead_letter: 0,
  };
  for (const row of rows) {
    const status = parseDeliveryStatus(row.status);
    counts[status] = Number(row.count);
  }

  return {
    pending: counts.pending,
    delivering: counts.delivering,
    succeeded: counts.succeeded,
    dead_letter: counts.dead_letter,
  };
}

function readAverageSuccessfulDuration(
  storage: PosthornStorage,
  appId: string,
  endpointId: string,
  since: string,
  until: string,
): number | null {
  const row = storage.db
    .prepare(
      `
        SELECT AVG(delivery_attempts.duration_ms) AS average_duration_ms
        FROM delivery_attempts
        INNER JOIN deliveries ON deliveries.id = delivery_attempts.delivery_id
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ?
          AND deliveries.endpoint_id = ?
          AND deliveries.created_at >= ?
          AND deliveries.created_at <= ?
          AND delivery_attempts.outcome = 'succeeded'
          AND delivery_attempts.duration_ms IS NOT NULL
      `,
    )
    .get(appId, endpointId, since, until) as { readonly average_duration_ms: unknown } | undefined;
  if (row === undefined || row.average_duration_ms === null || row.average_duration_ms === undefined) return null;
  return Number(row.average_duration_ms);
}

function readDailyStats(
  storage: PosthornStorage,
  appId: string,
  endpointId: string,
  since: string,
  until: string,
): readonly EndpointDailyStats[] {
  const byDate = new Map<string, MutableDailyStats>();
  const deliveryRows = storage.db
    .prepare(
      `
        SELECT substr(deliveries.created_at, 1, 10) AS date,
               deliveries.status,
               COUNT(*) AS count
        FROM deliveries
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ?
          AND deliveries.endpoint_id = ?
          AND deliveries.created_at >= ?
          AND deliveries.created_at <= ?
        GROUP BY date, deliveries.status
      `,
    )
    .all(appId, endpointId, since, until) as unknown as Array<{
    readonly date: unknown;
    readonly status: unknown;
    readonly count: unknown;
  }>;

  for (const row of deliveryRows) {
    const day = dailyStatsForDate(byDate, String(row.date));
    const count = Number(row.count);
    const status = parseDeliveryStatus(row.status);
    day.total += count;
    if (status === 'succeeded') day.succeeded += count;
  }

  const attemptRows = storage.db
    .prepare(
      `
        SELECT substr(delivery_attempts.attempted_at, 1, 10) AS date,
               delivery_attempts.outcome,
               COUNT(*) AS count
        FROM delivery_attempts
        INNER JOIN deliveries ON deliveries.id = delivery_attempts.delivery_id
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ?
          AND deliveries.endpoint_id = ?
          AND deliveries.created_at >= ?
          AND deliveries.created_at <= ?
          AND delivery_attempts.attempted_at >= ?
          AND delivery_attempts.attempted_at <= ?
          AND delivery_attempts.outcome IN ('failed', 'dead_letter')
        GROUP BY date, delivery_attempts.outcome
      `,
    )
    .all(appId, endpointId, since, until, since, until) as unknown as Array<{
    readonly date: unknown;
    readonly outcome: unknown;
    readonly count: unknown;
  }>;

  for (const row of attemptRows) {
    const day = dailyStatsForDate(byDate, String(row.date));
    const count = Number(row.count);
    if (row.outcome === 'failed') day.failed += count;
    if (row.outcome === 'dead_letter') day.deadLettered += count;
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function readFailureReasons(
  storage: PosthornStorage,
  appId: string,
  endpointId: string,
  since: string,
  until: string,
): readonly EndpointFailureReasonStats[] {
  const rows = storage.db
    .prepare(
      `
        SELECT delivery_attempts.failure_reason, COUNT(*) AS count
        FROM delivery_attempts
        INNER JOIN deliveries ON deliveries.id = delivery_attempts.delivery_id
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ?
          AND deliveries.endpoint_id = ?
          AND deliveries.created_at >= ?
          AND deliveries.created_at <= ?
          AND delivery_attempts.attempted_at >= ?
          AND delivery_attempts.attempted_at <= ?
          AND delivery_attempts.failure_reason IS NOT NULL
        GROUP BY delivery_attempts.failure_reason
        ORDER BY count DESC, delivery_attempts.failure_reason ASC
      `,
    )
    .all(appId, endpointId, since, until, since, until) as unknown as Array<{
    readonly failure_reason: unknown;
    readonly count: unknown;
  }>;

  return rows.map((row) => ({
    reason: String(row.failure_reason),
    count: Number(row.count),
  }));
}

function parsePageLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_DELIVERIES_PAGE_LIMIT;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new EndpointObservabilityValidationError(`limit must be an integer between 1 and ${MAX_DELIVERIES_PAGE_LIMIT}.`);
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DELIVERIES_PAGE_LIMIT) {
    throw new EndpointObservabilityValidationError(`limit must be an integer between 1 and ${MAX_DELIVERIES_PAGE_LIMIT}.`);
  }

  return limit;
}

function parseWindowDays(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_STATS_WINDOW_DAYS;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new EndpointObservabilityValidationError(`days must be an integer between 1 and ${MAX_STATS_WINDOW_DAYS}.`);
  }

  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_STATS_WINDOW_DAYS) {
    throw new EndpointObservabilityValidationError(`days must be an integer between 1 and ${MAX_STATS_WINDOW_DAYS}.`);
  }

  return days;
}

function parseDeliveriesCursor(value: unknown): DeliveriesCursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EndpointObservabilityValidationError('cursor is invalid.');
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('cursor payload must be an object.');
    }
    const cursor = parsed as Partial<DeliveriesCursor>;
    if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') {
      throw new Error('cursor fields are invalid.');
    }
    if (Number.isNaN(Date.parse(cursor.createdAt)) || cursor.id.trim() === '') {
      throw new Error('cursor values are invalid.');
    }

    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new EndpointObservabilityValidationError('cursor is invalid.');
  }
}

function encodeDeliveriesCursor(row: Pick<EndpointDeliveryHistoryRow, 'created_at' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: String(row.created_at),
      id: String(row.id),
    }),
    'utf8',
  ).toString('base64url');
}

function endpointDeliveryHistoryFromRow(row: EndpointDeliveryHistoryRow): EndpointDeliveryHistoryRecord {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    endpointId: String(row.endpoint_id),
    eventType: String(row.event_type),
    status: parseDeliveryStatus(row.status),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: nullableString(row.next_attempt_at),
    lastError: nullableString(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseDeliveryStatus(value: unknown): DeliveryStatus {
  if (value === 'pending' || value === 'delivering' || value === 'succeeded' || value === 'dead_letter') {
    return value;
  }

  return 'pending';
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function dailyStatsForDate(byDate: Map<string, MutableDailyStats>, date: string): MutableDailyStats {
  const existing = byDate.get(date);
  if (existing !== undefined) return existing;
  const created = {
    date,
    total: 0,
    succeeded: 0,
    failed: 0,
    deadLettered: 0,
  };
  byDate.set(date, created);
  return created;
}

interface DeliveriesCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface MutableDailyStats {
  readonly date: string;
  total: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
}

interface EndpointDeliveryHistoryRow {
  readonly id: unknown;
  readonly message_id: unknown;
  readonly endpoint_id: unknown;
  readonly event_type: unknown;
  readonly status: unknown;
  readonly attempt_count: unknown;
  readonly next_attempt_at: unknown;
  readonly last_error: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}
