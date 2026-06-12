import { randomBytes } from 'node:crypto';

import type { PosthornStorage } from './storage';

export type MessageValidationErrorCode = 'invalid_request';
export type DeliveryStatus = 'pending';

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

export interface MessageFanout {
  readonly matched: number;
  readonly deliveryIds: readonly string[];
  readonly endpointIds: readonly string[];
}

export interface AcceptMessageResult {
  readonly message: MessageRecord;
  readonly fanout: MessageFanout;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class MessageValidationError extends Error {
  readonly code: MessageValidationErrorCode = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
  }
}

const MESSAGE_ID_PREFIX = 'msg_';
const DELIVERY_ID_PREFIX = 'del_';
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

export function acceptMessage(
  storage: PosthornStorage,
  appId: string,
  input: unknown,
  now = new Date(),
): AcceptMessageResult {
  const body = requireObject(input);
  const eventType = parseEventType(body.eventType);
  const payload = parsePayload(body);
  const payloadJson = JSON.stringify(payload);
  const messageId = generateId(MESSAGE_ID_PREFIX);
  const createdAt = now.toISOString();
  const matchingEndpoints = listMatchingEnabledEndpoints(storage, appId, eventType);
  const deliveryIds = matchingEndpoints.map(() => generateId(DELIVERY_ID_PREFIX));

  storage.db.exec('BEGIN IMMEDIATE');
  try {
    storage.db
      .prepare(`
        INSERT INTO messages (id, app_id, event_type, payload_json, idempotency_key, payload_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(messageId, appId, eventType, payloadJson, null, null, createdAt);

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
        ORDER BY deliveries.created_at ASC, deliveries.id ASC
      `,
    )
    .all(appId, messageId) as unknown as DeliveryRow[];

  return rows.map(deliveryFromRow);
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

function requireObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new MessageValidationError('Expected a JSON object.');
  }

  return input as Record<string, unknown>;
}

function parseEventType(value: unknown): string {
  if (typeof value !== 'string' || !EVENT_TYPE_PATTERN.test(value)) {
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function generateId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('base64url')}`;
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
    status: 'pending',
    attemptCount: Number(row.attempt_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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

interface DeliveryRow {
  readonly id: unknown;
  readonly message_id: unknown;
  readonly endpoint_id: unknown;
  readonly status: unknown;
  readonly attempt_count: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}
