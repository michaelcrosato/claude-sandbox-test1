import type { DeliveryStatus } from './messages';
import type { PosthornStorage } from './storage';
import { containsControlCharacter, isValidEventTypeIdentifier } from './validation';

export interface ListDeliveriesOptions {
  readonly limit?: unknown;
  readonly cursor?: unknown;
  readonly status?: unknown;
  readonly endpointId?: unknown;
  readonly eventType?: unknown;
  readonly failureReason?: unknown;
}

export interface DeliveryListRecord {
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

export interface DeliveryListPage {
  readonly data: readonly DeliveryListRecord[];
  readonly nextCursor: string | null;
}

export class DeliveryListingValidationError extends Error {
  readonly code = 'invalid_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeliveryListingValidationError';
  }
}

const DEFAULT_DELIVERIES_PAGE_LIMIT = 50;
const MAX_DELIVERIES_PAGE_LIMIT = 100;
const MAX_FILTER_VALUE_LENGTH = 200;
const MAX_FAILURE_REASON_LENGTH = 100;

export function listDeliveries(
  storage: PosthornStorage,
  appId: string,
  options: ListDeliveriesOptions = {},
): DeliveryListPage {
  const limit = parsePageLimit(options.limit);
  const cursor = parseDeliveriesCursor(options.cursor);
  const status = parseStatusFilter(options.status);
  const endpointId = parseStringFilter(options.endpointId, 'endpointId', MAX_FILTER_VALUE_LENGTH);
  const eventType = parseEventTypeFilter(options.eventType);
  const failureReason = parseStringFilter(options.failureReason, 'failureReason', MAX_FAILURE_REASON_LENGTH);

  const clauses = ['messages.app_id = ?'];
  const params: Array<string | number> = [appId];
  if (status !== null) {
    clauses.push('deliveries.status = ?');
    params.push(status);
  }
  if (endpointId !== null) {
    clauses.push('deliveries.endpoint_id = ?');
    params.push(endpointId);
  }
  if (eventType !== null) {
    clauses.push('messages.event_type = ?');
    params.push(eventType);
  }
  if (failureReason !== null) {
    clauses.push(`
      (
        deliveries.last_error = ?
        OR EXISTS (
          SELECT 1
          FROM delivery_attempts
          WHERE delivery_attempts.delivery_id = deliveries.id
            AND delivery_attempts.failure_reason = ?
        )
      )
    `);
    params.push(failureReason, failureReason);
  }
  if (cursor !== null) {
    clauses.push(`
      (
        deliveries.created_at < ?
        OR (deliveries.created_at = ? AND deliveries.id < ?)
      )
    `);
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
        WHERE ${clauses.join(' AND ')}
        ORDER BY deliveries.created_at DESC, deliveries.id DESC
        LIMIT ?
      `,
    )
    .all(...params) as unknown as DeliveryListRow[];

  const pageRows = rows.slice(0, limit);
  return {
    data: pageRows.map(deliveryListRecordFromRow),
    nextCursor: rows.length > limit ? encodeDeliveriesCursor(pageRows[pageRows.length - 1]) : null,
  };
}

function parsePageLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_DELIVERIES_PAGE_LIMIT;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new DeliveryListingValidationError(`limit must be an integer between 1 and ${MAX_DELIVERIES_PAGE_LIMIT}.`);
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DELIVERIES_PAGE_LIMIT) {
    throw new DeliveryListingValidationError(`limit must be an integer between 1 and ${MAX_DELIVERIES_PAGE_LIMIT}.`);
  }

  return limit;
}

function parseStatusFilter(value: unknown): DeliveryStatus | null {
  if (value === undefined || value === null) return null;
  if (value === 'pending' || value === 'delivering' || value === 'succeeded' || value === 'dead_letter') return value;
  throw new DeliveryListingValidationError('status must be one of pending, delivering, succeeded, or dead_letter.');
}

function parseStringFilter(value: unknown, name: 'endpointId' | 'failureReason', maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new DeliveryListingValidationError(`${name} must be a non-empty string.`);
  }

  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLength || containsControlCharacter(trimmed)) {
    throw new DeliveryListingValidationError(`${name} must be a non-empty string up to ${maxLength} characters.`);
  }

  return trimmed;
}

function parseEventTypeFilter(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isValidEventTypeIdentifier(value)) {
    throw new DeliveryListingValidationError('eventType must be a valid event type identifier.');
  }

  return value;
}

function parseDeliveriesCursor(value: unknown): DeliveriesCursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DeliveryListingValidationError('cursor is invalid.');
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
    throw new DeliveryListingValidationError('cursor is invalid.');
  }
}

function encodeDeliveriesCursor(row: Pick<DeliveryListRow, 'created_at' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: String(row.created_at),
      id: String(row.id),
    }),
    'utf8',
  ).toString('base64url');
}

function deliveryListRecordFromRow(row: DeliveryListRow): DeliveryListRecord {
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

interface DeliveriesCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface DeliveryListRow {
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
