import { createHash, randomBytes } from 'node:crypto';

import type { PosthornStorage } from './storage';

export type MessageValidationErrorCode = 'invalid_request';
export type MessageConflictErrorCode = 'idempotency_conflict';
export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'dead_letter';

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

export class MessageConflictError extends Error {
  readonly code: MessageConflictErrorCode = 'idempotency_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'MessageConflictError';
  }
}

const MESSAGE_ID_PREFIX = 'msg_';
const DELIVERY_ID_PREFIX = 'del_';
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PAYLOAD_DEPTH = 64;
const MAX_PAYLOAD_NODES = 10_000;

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
  const matchingEndpoints = listMatchingEnabledEndpoints(storage, appId, eventType);
  const deliveryIds = matchingEndpoints.map(() => generateId(DELIVERY_ID_PREFIX));

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
        ORDER BY deliveries.rowid ASC
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

function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES || current.depth > MAX_PAYLOAD_DEPTH) return false;

    const currentValue = current.value;
    if (currentValue === null || typeof currentValue === 'string' || typeof currentValue === 'boolean') {
      continue;
    }
    if (typeof currentValue === 'number') {
      if (!Number.isFinite(currentValue)) return false;
      continue;
    }
    if (Array.isArray(currentValue)) {
      for (const child of currentValue) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof currentValue === 'object') {
      for (const child of Object.values(currentValue)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }

    return false;
  }

  return true;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }

  return false;
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
