import { randomBytes } from 'node:crypto';

import type { PosthornStorage } from './storage';
import { containsControlCharacter, isJsonValue, isValidEventTypeIdentifier, type JsonValue } from './validation';

export type EventTypeValidationErrorCode = 'invalid_request';
export type EventTypeConflictErrorCode = 'conflict';

export interface EventTypeRecord {
  readonly id: string;
  readonly eventType: string;
  readonly description: string | null;
  readonly schemaExample: JsonValue | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateEventTypeResult {
  readonly eventType: EventTypeRecord;
}

export class EventTypeValidationError extends Error {
  readonly code: EventTypeValidationErrorCode = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'EventTypeValidationError';
  }
}

export class EventTypeConflictError extends Error {
  readonly code: EventTypeConflictErrorCode = 'conflict';

  constructor(message: string) {
    super(message);
    this.name = 'EventTypeConflictError';
  }
}

const EVENT_TYPE_ID_PREFIX = 'evt_';
const MAX_DESCRIPTION_LENGTH = 500;

export function createEventType(
  storage: PosthornStorage,
  appId: string,
  input: unknown,
  now = new Date(),
): CreateEventTypeResult {
  const body = requireObject(input);
  const eventType = parseEventType(body.eventType);
  if (getActiveEventTypeByName(storage, appId, eventType) !== null) {
    throw new EventTypeConflictError('An active event type with this name already exists.');
  }

  const id = generateEventTypeId();
  const createdAt = now.toISOString();
  storage.db
    .prepare(
      `
        INSERT INTO event_types (
          id,
          app_id,
          event_type,
          description,
          schema_example_json,
          archived_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      appId,
      eventType,
      parseDescription(body.description),
      serializeSchemaExample(parseSchemaExample(body.schemaExample)),
      null,
      createdAt,
      createdAt,
    );

  const record = getEventType(storage, appId, id);
  if (record === null) throw new Error('Created event type could not be read back.');
  return { eventType: record };
}

export function listEventTypes(storage: PosthornStorage, appId: string): readonly EventTypeRecord[] {
  const rows = storage.db
    .prepare(
      `
        SELECT id, event_type, description, schema_example_json, archived_at, created_at, updated_at
        FROM event_types
        WHERE app_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC, id DESC
      `,
    )
    .all(appId) as unknown as EventTypeRow[];

  return rows.map(eventTypeFromRow);
}

export function getEventType(storage: PosthornStorage, appId: string, eventTypeId: string): EventTypeRecord | null {
  const row = storage.db
    .prepare(
      `
        SELECT id, event_type, description, schema_example_json, archived_at, created_at, updated_at
        FROM event_types
        WHERE app_id = ? AND id = ? AND archived_at IS NULL
        LIMIT 1
      `,
    )
    .get(appId, eventTypeId) as EventTypeRow | undefined;

  return row === undefined ? null : eventTypeFromRow(row);
}

export function getActiveEventTypeByName(
  storage: PosthornStorage,
  appId: string,
  eventType: string,
): EventTypeRecord | null {
  const row = storage.db
    .prepare(
      `
        SELECT id, event_type, description, schema_example_json, archived_at, created_at, updated_at
        FROM event_types
        WHERE app_id = ? AND event_type = ? AND archived_at IS NULL
        LIMIT 1
      `,
    )
    .get(appId, eventType) as EventTypeRow | undefined;

  return row === undefined ? null : eventTypeFromRow(row);
}

export function updateEventType(
  storage: PosthornStorage,
  appId: string,
  eventTypeId: string,
  input: unknown,
  now = new Date(),
): EventTypeRecord | null {
  const body = requireObject(input);
  const updates: string[] = [];
  const values: Array<string | null> = [];

  if (Object.hasOwn(body, 'description')) {
    updates.push('description = ?');
    values.push(parseDescription(body.description));
  }
  if (Object.hasOwn(body, 'schemaExample')) {
    updates.push('schema_example_json = ?');
    values.push(serializeSchemaExample(parseSchemaExample(body.schemaExample)));
  }
  if (updates.length === 0) {
    throw new EventTypeValidationError('At least one event type field must be supplied.');
  }

  const updatedAt = now.toISOString();
  updates.push('updated_at = ?');
  values.push(updatedAt, appId, eventTypeId);

  const result = storage.db
    .prepare(`UPDATE event_types SET ${updates.join(', ')} WHERE app_id = ? AND id = ? AND archived_at IS NULL`)
    .run(...values);

  if (result.changes === 0) return null;
  return getEventType(storage, appId, eventTypeId);
}

export function archiveEventType(
  storage: PosthornStorage,
  appId: string,
  eventTypeId: string,
  now = new Date(),
): boolean {
  const archivedAt = now.toISOString();
  const result = storage.db
    .prepare(
      `
        UPDATE event_types
        SET archived_at = ?, updated_at = ?
        WHERE app_id = ? AND id = ? AND archived_at IS NULL
      `,
    )
    .run(archivedAt, archivedAt, appId, eventTypeId);

  return result.changes > 0;
}

export function parseEventType(value: unknown): string {
  if (typeof value !== 'string' || !isValidEventTypeIdentifier(value)) {
    throw new EventTypeValidationError('eventType must be a valid event type identifier.');
  }

  return value;
}

function requireObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EventTypeValidationError('Expected a JSON object.');
  }

  return input as Record<string, unknown>;
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || containsControlCharacter(value)) {
    throw new EventTypeValidationError('description must be a string up to 500 characters.');
  }
  const description = value.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new EventTypeValidationError('description must be a string up to 500 characters.');
  }

  return description === '' ? null : description;
}

function parseSchemaExample(value: unknown): JsonValue | null {
  if (value === undefined) return null;
  if (value === null || !isJsonValue(value)) {
    throw new EventTypeValidationError('schemaExample must be a non-null JSON value.');
  }

  return value;
}

function serializeSchemaExample(value: JsonValue | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function eventTypeFromRow(row: EventTypeRow): EventTypeRecord {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    schemaExample: parseStoredSchemaExample(row.schema_example_json),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseStoredSchemaExample(value: unknown): JsonValue | null {
  if (value === null || value === undefined) return null;
  const parsed = JSON.parse(String(value)) as unknown;
  return isJsonValue(parsed) ? parsed : null;
}

function generateEventTypeId(): string {
  return `${EVENT_TYPE_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
}

interface EventTypeRow {
  readonly id: unknown;
  readonly event_type: unknown;
  readonly description: unknown;
  readonly schema_example_json: unknown;
  readonly archived_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}
