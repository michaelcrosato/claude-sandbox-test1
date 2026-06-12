import { createHash, randomBytes } from 'node:crypto';

import type { PosthornStorage } from './storage';
import { assertMessageQuotaAvailable, incrementAcceptedMessages, UsageQuotaExceededError } from './usage';
import { containsControlCharacter, isJsonValue, isValidEventTypeIdentifier, type JsonValue } from './validation';

export type { JsonValue } from './validation';

export type MessageValidationErrorCode = 'invalid_request';
export type MessageConflictErrorCode = 'idempotency_conflict';
export type BatchMessageErrorCode = MessageValidationErrorCode | MessageConflictErrorCode | 'quota_exceeded';
export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'dead_letter';
export type DeliveryAttemptAuditOutcome = 'succeeded' | 'failed' | 'dead_letter';

export interface MessageRecord {
  readonly id: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface DeliveryTaskRecord {
  readonly id: string;
  readonly messageId: string;
  readonly endpointId: string;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessageStatusResult {
  readonly message: MessageRecord;
  readonly deliveries: readonly DeliveryTaskRecord[];
}

export interface MessageListPage {
  readonly data: readonly MessageRecord[];
  readonly nextCursor: string | null;
}

export interface RetryMessageResult {
  readonly retried: number;
}

export interface DeliveryAttemptAuditRecord {
  readonly id: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly endpointId: string;
  readonly attemptNumber: number;
  readonly outcome: DeliveryAttemptAuditOutcome;
  readonly attemptedAt: string;
  readonly durationMs: number | null;
  readonly responseStatus: number | null;
  readonly failureReason: string | null;
}

export interface MessageAttemptsPage {
  readonly data: readonly DeliveryAttemptAuditRecord[];
  readonly nextCursor: string | null;
}

export interface ListMessageAttemptsOptions {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

export interface ListMessagesOptions {
  readonly limit?: unknown;
  readonly cursor?: unknown;
  readonly eventType?: unknown;
  readonly after?: unknown;
  readonly before?: unknown;
}

export interface MessageFanout {
  readonly matched: number;
  readonly deliveryIds: readonly string[];
  readonly endpointIds: readonly string[];
}

export interface AcceptMessageResult {
  readonly message: MessageRecord;
  readonly fanout: MessageFanout;
}

export type BatchMessageItemResult =
  | ({ readonly ok: true } & AcceptMessageResult)
  | {
      readonly ok: false;
      readonly error: {
        readonly code: BatchMessageErrorCode;
        readonly message: string;
      };
    };

export interface AcceptMessageBatchResult {
  readonly results: readonly BatchMessageItemResult[];
}

export class MessageValidationError extends Error {
  readonly code: MessageValidationErrorCode = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
  }
}

export class MessageConflictError extends Error {
  readonly code: MessageConflictErrorCode = 'idempotency_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'MessageConflictError';
  }
}

const MESSAGE_ID_PREFIX = 'msg_';
const DELIVERY_ID_PREFIX = 'del_';
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const DEFAULT_MESSAGES_PAGE_LIMIT = 25;
const MAX_MESSAGES_PAGE_LIMIT = 100;
const DEFAULT_ATTEMPTS_PAGE_LIMIT = 50;
const MAX_ATTEMPTS_PAGE_LIMIT = 100;

export function acceptMessage(
  storage: PosthornStorage,
  appId: string,
  input: unknown,
  now = new Date(),
): AcceptMessageResult {
  const body = requireObject(input);
  const eventType = parseEventType(body.eventType);
  const payload = parsePayload(body);
  const idempotencyKey = parseIdempotencyKey(body.idempotencyKey);
  const payloadJson = JSON.stringify(payload);
  const requestHash = idempotencyKey === null ? null : hashMessageRequest(eventType, payload);
  const messageId = generateId(MESSAGE_ID_PREFIX);
  const createdAt = now.toISOString();
  let matchingEndpoints: readonly MatchingEndpoint[] = [];
  let deliveryIds: string[] = [];

  storage.db.exec('BEGIN IMMEDIATE');
  try {
    if (idempotencyKey !== null) {
      const existing = getMessageByIdempotencyKey(storage, appId, idempotencyKey);
      if (existing !== null) {
        if (existing.payloadHash !== requestHash) {
          throw new MessageConflictError('idempotencyKey was reused with a different request body.');
        }
        const existingResult = acceptResultForExistingMessage(storage, appId, existing);
        storage.db.exec('COMMIT');
        return existingResult;
      }
    }

    assertMessageQuotaAvailable(storage, appId, now);
    matchingEndpoints = listMatchingEnabledEndpoints(storage, appId, eventType);
    deliveryIds = matchingEndpoints.map(() => generateId(DELIVERY_ID_PREFIX));

    storage.db
      .prepare(`
        INSERT INTO messages (id, app_id, event_type, payload_json, idempotency_key, payload_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(messageId, appId, eventType, payloadJson, idempotencyKey, requestHash, createdAt);

    const insertDelivery = storage.db.prepare(`
      INSERT INTO deliveries (
        id,
        message_id,
        endpoint_id,
        status,
        attempt_count,
        next_attempt_at,
        lease_expires_at,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    matchingEndpoints.forEach((endpoint, index) => {
      insertDelivery.run(deliveryIds[index], messageId, endpoint.id, 'pending', 0, null, null, null, createdAt, createdAt);
    });

    incrementAcceptedMessages(storage, appId, now);
    storage.db.exec('COMMIT');
  } catch (error) {
    storage.db.exec('ROLLBACK');
    throw error;
  }

  return {
    message: {
      id: messageId,
      eventType,
      payload,
      createdAt,
    },
    fanout: {
      matched: matchingEndpoints.length,
      deliveryIds,
      endpointIds: matchingEndpoints.map((endpoint) => endpoint.id),
    },
  };
}

export function acceptMessageBatch(
  storage: PosthornStorage,
  appId: string,
  input: unknown,
  now = new Date(),
): AcceptMessageBatchResult {
  const items = parseBatchItems(input);
  const results = items.map((item): BatchMessageItemResult => {
    try {
      return {
        ok: true,
        ...acceptMessage(storage, appId, item, now),
      };
    } catch (error) {
      if (
        error instanceof MessageValidationError ||
        error instanceof MessageConflictError ||
        error instanceof UsageQuotaExceededError
      ) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }

      throw error;
    }
  });

  return { results };
}

export function getMessage(storage: PosthornStorage, appId: string, messageId: string): MessageRecord | null {
  const row = storage.db
    .prepare(
      `
        SELECT id, event_type, payload_json, created_at
        FROM messages
        WHERE app_id = ? AND id = ?
        LIMIT 1
      `,
    )
    .get(appId, messageId) as MessageRow | undefined;

  return row === undefined ? null : messageFromRow(row);
}

export function getMessageStatus(
  storage: PosthornStorage,
  appId: string,
  messageId: string,
): MessageStatusResult | null {
  const message = getMessage(storage, appId, messageId);
  if (message === null) return null;

  return {
    message,
    deliveries: listDeliveriesForMessage(storage, appId, messageId),
  };
}

export function listMessages(
  storage: PosthornStorage,
  appId: string,
  options: ListMessagesOptions = {},
): MessageListPage {
  const limit = parsePageLimit(options.limit, DEFAULT_MESSAGES_PAGE_LIMIT, MAX_MESSAGES_PAGE_LIMIT);
  const cursor = parseMessagesCursor(options.cursor);
  const eventType = parseEventTypeFilter(options.eventType);
  const after = parseDateTimeFilter(options.after, 'after');
  const before = parseDateTimeFilter(options.before, 'before');
  if (after !== null && before !== null && after >= before) {
    throw new MessageValidationError('after must be earlier than before.');
  }
  const cursorClause =
    cursor === null
      ? ''
      : `
        AND (
          created_at < ?
          OR (created_at = ? AND id < ?)
        )
      `;
  const whereClauses = ['app_id = ?'];
  const params: Array<string | number> = [appId];
  if (eventType !== null) {
    whereClauses.push('event_type = ?');
    params.push(eventType);
  }
  if (after !== null) {
    whereClauses.push('created_at >= ?');
    params.push(after);
  }
  if (before !== null) {
    whereClauses.push('created_at < ?');
    params.push(before);
  }
  if (cursor !== null) {
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  params.push(limit + 1);

  const rows = storage.db
    .prepare(
      `
        SELECT id, event_type, payload_json, created_at
        FROM messages
        WHERE ${whereClauses.join('\n          AND ')}
          ${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
    )
    .all(...params) as unknown as MessageRow[];

  const pageRows = rows.slice(0, limit);
  return {
    data: pageRows.map(messageFromRow),
    nextCursor: rows.length > limit ? encodeMessagesCursor(pageRows[pageRows.length - 1]) : null,
  };
}

export function listDeliveriesForMessage(
  storage: PosthornStorage,
  appId: string,
  messageId: string,
): readonly DeliveryTaskRecord[] {
  const rows = storage.db
    .prepare(
      `
        SELECT deliveries.id,
               deliveries.message_id,
               deliveries.endpoint_id,
               deliveries.status,
               deliveries.attempt_count,
               deliveries.created_at,
               deliveries.updated_at
        FROM deliveries
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ? AND deliveries.message_id = ?
        ORDER BY deliveries.rowid ASC
      `,
    )
    .all(appId, messageId) as unknown as DeliveryRow[];

  return rows.map(deliveryFromRow);
}

export function retryMessage(storage: PosthornStorage, appId: string, messageId: string, now = new Date()): RetryMessageResult | null {
  if (!messageBelongsToTenant(storage, appId, messageId)) return null;

  const updatedAt = now.toISOString();
  const result = storage.db
    .prepare(
      `
        UPDATE deliveries
        SET status = 'pending',
            attempt_count = 0,
            next_attempt_at = NULL,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE message_id = ?
          AND status = 'dead_letter'
          AND EXISTS (
            SELECT 1
            FROM messages
            WHERE messages.id = deliveries.message_id
              AND messages.app_id = ?
          )
      `,
    )
    .run(updatedAt, messageId, appId);

  return { retried: Number(result.changes) };
}

export function listMessageAttempts(
  storage: PosthornStorage,
  appId: string,
  messageId: string,
  options: ListMessageAttemptsOptions = {},
): MessageAttemptsPage | null {
  if (!messageBelongsToTenant(storage, appId, messageId)) return null;

  const limit = parsePageLimit(options.limit, DEFAULT_ATTEMPTS_PAGE_LIMIT, MAX_ATTEMPTS_PAGE_LIMIT);
  const cursor = parseAttemptsCursor(options.cursor);
  const cursorClause =
    cursor === null
      ? ''
      : `
        AND (
          delivery_attempts.attempted_at < ?
          OR (delivery_attempts.attempted_at = ? AND delivery_attempts.id < ?)
        )
      `;
  const params: Array<string | number> = [appId, messageId];
  if (cursor !== null) {
    params.push(cursor.attemptedAt, cursor.attemptedAt, cursor.id);
  }
  params.push(limit + 1);

  const rows = storage.db
    .prepare(
      `
        SELECT delivery_attempts.id,
               delivery_attempts.delivery_id,
               deliveries.message_id,
               deliveries.endpoint_id,
               delivery_attempts.attempt_number,
               delivery_attempts.outcome,
               delivery_attempts.response_status,
               delivery_attempts.duration_ms,
               delivery_attempts.failure_reason,
               delivery_attempts.attempted_at
        FROM delivery_attempts
        INNER JOIN deliveries ON deliveries.id = delivery_attempts.delivery_id
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ?
          AND messages.id = ?
          ${cursorClause}
        ORDER BY delivery_attempts.attempted_at DESC, delivery_attempts.id DESC
        LIMIT ?
      `,
    )
    .all(...params) as unknown as DeliveryAttemptAuditRow[];

  const pageRows = rows.slice(0, limit);
  return {
    data: pageRows.map(deliveryAttemptAuditFromRow),
    nextCursor: rows.length > limit ? encodeAttemptsCursor(pageRows[pageRows.length - 1]) : null,
  };
}

function listMatchingEnabledEndpoints(
  storage: PosthornStorage,
  appId: string,
  eventType: string,
): readonly MatchingEndpoint[] {
  const rows = storage.db
    .prepare(
      `
        SELECT id, event_types_json
        FROM endpoints
        WHERE app_id = ? AND enabled = 1
        ORDER BY created_at ASC, id ASC
      `,
    )
    .all(appId) as unknown as EndpointFanoutRow[];

  return rows.filter((row) => endpointMatchesEventType(row, eventType)).map((row) => ({ id: String(row.id) }));
}

function endpointMatchesEventType(row: EndpointFanoutRow, eventType: string): boolean {
  if (row.event_types_json === null || row.event_types_json === undefined) return true;
  const parsed = JSON.parse(String(row.event_types_json)) as unknown;
  return Array.isArray(parsed) && parsed.includes(eventType);
}

function parseBatchItems(input: unknown): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new MessageValidationError('Expected a JSON array of 1 to 100 message objects.');
  }
  if (input.length < 1 || input.length > 100) {
    throw new MessageValidationError('Batch must contain between 1 and 100 messages.');
  }

  return input;
}

function requireObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new MessageValidationError('Expected a JSON object.');
  }

  return input as Record<string, unknown>;
}

function parseEventType(value: unknown): string {
  if (typeof value !== 'string' || !isValidEventTypeIdentifier(value)) {
    throw new MessageValidationError('eventType must be a valid event type identifier.');
  }

  return value;
}

function parsePayload(body: Record<string, unknown>): JsonValue {
  if (!Object.hasOwn(body, 'payload')) {
    throw new MessageValidationError('payload is required.');
  }
  if (body.payload === null) {
    throw new MessageValidationError('payload must not be null.');
  }
  if (!isJsonValue(body.payload)) {
    throw new MessageValidationError('payload must be JSON serializable.');
  }

  return body.payload;
}

function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new MessageValidationError('idempotencyKey must be a string when supplied.');
  }

  if (containsControlCharacter(value)) {
    throw new MessageValidationError('idempotencyKey must not contain control characters.');
  }
  const idempotencyKey = value.trim();
  if (idempotencyKey === '' || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new MessageValidationError('idempotencyKey must be a non-empty string up to 200 characters.');
  }

  return idempotencyKey;
}

function parseEventTypeFilter(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isValidEventTypeIdentifier(value)) {
    throw new MessageValidationError('eventType must be a valid event type identifier.');
  }

  return value;
}

function parseDateTimeFilter(value: unknown, name: 'after' | 'before'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isStrictDateTime(value)) {
    throw new MessageValidationError(`${name} must be a valid date-time string.`);
  }

  const timestamp = Date.parse(value);
  return new Date(timestamp).toISOString();
}

function isStrictDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offset !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }

  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function generateId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('base64url')}`;
}

function hashMessageRequest(eventType: string, payload: JsonValue): string {
  return createHash('sha256')
    .update(canonicalJson({ eventType, payload }), 'utf8')
    .digest('base64url');
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const objectValue = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`)
    .join(',')}}`;
}

function getMessageByIdempotencyKey(
  storage: PosthornStorage,
  appId: string,
  idempotencyKey: string,
): StoredIdempotentMessage | null {
  const row = storage.db
    .prepare(
      `
        SELECT id, event_type, payload_json, payload_hash, created_at
        FROM messages
        WHERE app_id = ? AND idempotency_key = ?
        LIMIT 1
      `,
    )
    .get(appId, idempotencyKey) as StoredIdempotentMessageRow | undefined;
  if (row === undefined) return null;

  return {
    id: String(row.id),
    eventType: String(row.event_type),
    payload: JSON.parse(String(row.payload_json)) as JsonValue,
    payloadHash: row.payload_hash === null || row.payload_hash === undefined ? null : String(row.payload_hash),
    createdAt: String(row.created_at),
  };
}

function acceptResultForExistingMessage(
  storage: PosthornStorage,
  appId: string,
  message: StoredIdempotentMessage,
): AcceptMessageResult {
  const deliveries = listDeliveriesForMessage(storage, appId, message.id);
  return {
    message: {
      id: message.id,
      eventType: message.eventType,
      payload: message.payload,
      createdAt: message.createdAt,
    },
    fanout: {
      matched: deliveries.length,
      deliveryIds: deliveries.map((delivery) => delivery.id),
      endpointIds: deliveries.map((delivery) => delivery.endpointId),
    },
  };
}

function messageFromRow(row: MessageRow): MessageRecord {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    payload: JSON.parse(String(row.payload_json)) as JsonValue,
    createdAt: String(row.created_at),
  };
}

function deliveryFromRow(row: DeliveryRow): DeliveryTaskRecord {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    endpointId: String(row.endpoint_id),
    status: parseDeliveryStatus(row.status),
    attemptCount: Number(row.attempt_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseDeliveryStatus(value: unknown): DeliveryStatus {
  const status = String(value);
  if (status === 'pending' || status === 'delivering' || status === 'succeeded' || status === 'dead_letter') {
    return status;
  }

  return 'pending';
}

function parseDeliveryAttemptOutcome(value: unknown): DeliveryAttemptAuditOutcome {
  const outcome = String(value);
  if (outcome === 'succeeded' || outcome === 'failed' || outcome === 'dead_letter') {
    return outcome;
  }

  return 'failed';
}

function parsePageLimit(value: unknown, defaultLimit: number, maxLimit: number): number {
  if (value === undefined || value === null) return defaultLimit;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new MessageValidationError(`limit must be an integer between 1 and ${maxLimit}.`);
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new MessageValidationError(`limit must be an integer between 1 and ${maxLimit}.`);
  }

  return limit;
}

function parseMessagesCursor(value: unknown): MessagesCursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MessageValidationError('cursor is invalid.');
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('cursor payload must be an object.');
    }
    const cursor = parsed as Partial<MessagesCursor>;
    if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') {
      throw new Error('cursor fields are invalid.');
    }
    if (Number.isNaN(Date.parse(cursor.createdAt)) || cursor.id.trim() === '') {
      throw new Error('cursor values are invalid.');
    }

    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new MessageValidationError('cursor is invalid.');
  }
}

function parseAttemptsCursor(value: unknown): AttemptsCursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MessageValidationError('cursor is invalid.');
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('cursor payload must be an object.');
    }
    const cursor = parsed as Partial<AttemptsCursor>;
    if (typeof cursor.attemptedAt !== 'string' || typeof cursor.id !== 'string') {
      throw new Error('cursor fields are invalid.');
    }
    if (Number.isNaN(Date.parse(cursor.attemptedAt)) || cursor.id.trim() === '') {
      throw new Error('cursor values are invalid.');
    }

    return { attemptedAt: cursor.attemptedAt, id: cursor.id };
  } catch {
    throw new MessageValidationError('cursor is invalid.');
  }
}

function encodeMessagesCursor(row: Pick<MessageRow, 'created_at' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: String(row.created_at),
      id: String(row.id),
    }),
    'utf8',
  ).toString('base64url');
}

function encodeAttemptsCursor(row: Pick<DeliveryAttemptAuditRow, 'attempted_at' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({
      attemptedAt: String(row.attempted_at),
      id: String(row.id),
    }),
    'utf8',
  ).toString('base64url');
}

function messageBelongsToTenant(storage: PosthornStorage, appId: string, messageId: string): boolean {
  const row = storage.db
    .prepare(
      `
        SELECT 1
        FROM messages
        WHERE app_id = ? AND id = ?
        LIMIT 1
      `,
    )
    .get(appId, messageId) as { readonly 1: unknown } | undefined;

  return row !== undefined;
}

function deliveryAttemptAuditFromRow(row: DeliveryAttemptAuditRow): DeliveryAttemptAuditRecord {
  return {
    id: String(row.id),
    deliveryId: String(row.delivery_id),
    messageId: String(row.message_id),
    endpointId: String(row.endpoint_id),
    attemptNumber: Number(row.attempt_number),
    outcome: parseDeliveryAttemptOutcome(row.outcome),
    attemptedAt: String(row.attempted_at),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    responseStatus:
      row.response_status === null || row.response_status === undefined ? null : Number(row.response_status),
    failureReason: row.failure_reason === null || row.failure_reason === undefined ? null : String(row.failure_reason),
  };
}

interface MatchingEndpoint {
  readonly id: string;
}

interface EndpointFanoutRow {
  readonly id: unknown;
  readonly event_types_json: unknown;
}

interface MessageRow {
  readonly id: unknown;
  readonly event_type: unknown;
  readonly payload_json: unknown;
  readonly created_at: unknown;
}

interface StoredIdempotentMessage {
  readonly id: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly payloadHash: string | null;
  readonly createdAt: string;
}

interface StoredIdempotentMessageRow {
  readonly id: unknown;
  readonly event_type: unknown;
  readonly payload_json: unknown;
  readonly payload_hash: unknown;
  readonly created_at: unknown;
}

interface DeliveryRow {
  readonly id: unknown;
  readonly message_id: unknown;
  readonly endpoint_id: unknown;
  readonly status: unknown;
  readonly attempt_count: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface AttemptsCursor {
  readonly attemptedAt: string;
  readonly id: string;
}

interface MessagesCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface DeliveryAttemptAuditRow {
  readonly id: unknown;
  readonly delivery_id: unknown;
  readonly message_id: unknown;
  readonly endpoint_id: unknown;
  readonly attempt_number: unknown;
  readonly outcome: unknown;
  readonly response_status: unknown;
  readonly duration_ms: unknown;
  readonly failure_reason: unknown;
  readonly attempted_at: unknown;
}
