import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import type { PosthornStorage } from './storage';
import { createWebhookSecret } from './webhooks';

export type EndpointValidationErrorCode = 'invalid_request' | 'url_not_allowed';

export interface EndpointRecord {
  readonly id: string;
  readonly url: string;
  readonly eventTypes: readonly string[] | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateEndpointResult {
  readonly endpoint: EndpointRecord;
  readonly secret: string;
}

export class EndpointValidationError extends Error {
  readonly code: EndpointValidationErrorCode;

  constructor(code: EndpointValidationErrorCode, message: string) {
    super(message);
    this.name = 'EndpointValidationError';
    this.code = code;
  }
}

const ENDPOINT_ID_PREFIX = 'ep_';
const SECRET_DIGEST_PREFIX = 'sha256:';
const ENDPOINT_SECRET_KEY_VERSION = 'sha256-v1';
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_HEADER_NAMES = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
  'x-api-key',
]);

export function createEndpoint(
  storage: PosthornStorage,
  appId: string,
  input: unknown,
  now = new Date(),
): CreateEndpointResult {
  const body = requireObject(input);
  const url = parseEndpointUrl(requireString(body.url, 'url'));
  const eventTypes = parseEventTypes(body.eventTypes);
  const headers = parseHeaders(body.headers);
  const id = generateEndpointId();
  const createdAt = now.toISOString();
  const secret = createWebhookSecret();

  storage.db
    .prepare(`
      INSERT INTO endpoints (
        id,
        app_id,
        url,
        event_types_json,
        non_secret_headers_json,
        secret_header_refs_json,
        signing_secret_ciphertext,
        signing_secret_key_version,
        signing_secret_nonce,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      appId,
      url,
      serializeEventTypes(eventTypes),
      JSON.stringify(headers),
      JSON.stringify({}),
      hashEndpointSecret(secret),
      ENDPOINT_SECRET_KEY_VERSION,
      '',
      1,
      createdAt,
      createdAt,
    );

  const endpoint = getEndpoint(storage, appId, id);
  if (endpoint === null) {
    throw new Error('Created endpoint could not be read back.');
  }

  return { endpoint, secret };
}

export function listEndpoints(storage: PosthornStorage, appId: string): readonly EndpointRecord[] {
  const rows = storage.db
    .prepare(
      `
        SELECT id, url, event_types_json, non_secret_headers_json, enabled, created_at, updated_at
        FROM endpoints
        WHERE app_id = ?
        ORDER BY created_at DESC, id DESC
      `,
    )
    .all(appId) as unknown as EndpointRow[];
  return rows.map(endpointFromRow);
}

export function getEndpoint(storage: PosthornStorage, appId: string, endpointId: string): EndpointRecord | null {
  const row = storage.db
    .prepare(
      `
        SELECT id, url, event_types_json, non_secret_headers_json, enabled, created_at, updated_at
        FROM endpoints
        WHERE app_id = ? AND id = ?
        LIMIT 1
      `,
    )
    .get(appId, endpointId) as EndpointRow | undefined;

  return row === undefined ? null : endpointFromRow(row);
}

export function updateEndpoint(
  storage: PosthornStorage,
  appId: string,
  endpointId: string,
  input: unknown,
  now = new Date(),
): EndpointRecord | null {
  const body = requireObject(input);
  const updates: string[] = [];
  const values: Array<string | number | null> = [];

  if (Object.hasOwn(body, 'url')) {
    updates.push('url = ?');
    values.push(parseEndpointUrl(requireString(body.url, 'url')));
  }
  if (Object.hasOwn(body, 'eventTypes')) {
    updates.push('event_types_json = ?');
    values.push(serializeEventTypes(parseEventTypes(body.eventTypes)));
  }
  if (Object.hasOwn(body, 'headers')) {
    updates.push('non_secret_headers_json = ?');
    values.push(JSON.stringify(parseHeaders(body.headers)));
  }
  if (Object.hasOwn(body, 'enabled')) {
    updates.push('enabled = ?');
    values.push(parseEnabled(body.enabled) ? 1 : 0);
  }
  if (updates.length === 0) {
    throw new EndpointValidationError('invalid_request', 'At least one endpoint field must be supplied.');
  }

  const updatedAt = now.toISOString();
  updates.push('updated_at = ?');
  values.push(updatedAt, appId, endpointId);

  const result = storage.db
    .prepare(`UPDATE endpoints SET ${updates.join(', ')} WHERE app_id = ? AND id = ?`)
    .run(...values);

  if (result.changes === 0) return null;
  return getEndpoint(storage, appId, endpointId);
}

export function deleteEndpoint(storage: PosthornStorage, appId: string, endpointId: string): boolean {
  const result = storage.db.prepare('DELETE FROM endpoints WHERE app_id = ? AND id = ?').run(appId, endpointId);
  return result.changes > 0;
}

function generateEndpointId(): string {
  return `${ENDPOINT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
}

function hashEndpointSecret(secret: string): string {
  return `${SECRET_DIGEST_PREFIX}${createHash('sha256').update(secret, 'utf8').digest('base64url')}`;
}

function requireObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EndpointValidationError('invalid_request', 'Expected a JSON object.');
  }

  return input as Record<string, unknown>;
}

function requireString(input: unknown, fieldName: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new EndpointValidationError('invalid_request', `${fieldName} must be a non-empty string.`);
  }

  return input.trim();
}

function parseEndpointUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new EndpointValidationError('invalid_request', 'url must be an absolute URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EndpointValidationError('invalid_request', 'url must use http or https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new EndpointValidationError('invalid_request', 'url must not include credentials.');
  }
  if (isInternalHostname(url.hostname)) {
    throw new EndpointValidationError('url_not_allowed', 'url must not target localhost or private networks.');
  }

  return url.toString();
}

function isInternalHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, '');
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) return isPrivateIpv6(hostname);

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    !hostname.includes('.')
  ) {
    return true;
  }

  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  const [first, second] = parts;
  if (first === undefined || second === undefined) return true;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51) ||
    (first === 203 && second === 0)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (hostname === '::' || hostname === '::1') return true;
  if (hostname.startsWith('::ffff:')) {
    const mappedIpv4 = hostname.slice('::ffff:'.length);
    return isIP(mappedIpv4) === 4 ? isPrivateIpv4(mappedIpv4) : true;
  }

  const firstHextet = parseInt(hostname.split(':')[0] ?? '', 16);
  if (!Number.isFinite(firstHextet)) return true;

  return (
    (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00
  );
}

function parseEventTypes(input: unknown): readonly string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) {
    throw new EndpointValidationError('invalid_request', 'eventTypes must be an array or null.');
  }

  const seen = new Set<string>();
  const eventTypes: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string' || !EVENT_TYPE_PATTERN.test(value)) {
      throw new EndpointValidationError('invalid_request', 'eventTypes must contain valid event type identifiers.');
    }
    if (!seen.has(value)) {
      seen.add(value);
      eventTypes.push(value);
    }
  }

  return eventTypes.length === 0 ? null : eventTypes;
}

function parseHeaders(input: unknown): Readonly<Record<string, string>> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new EndpointValidationError('invalid_request', 'headers must be an object.');
  }

  const normalizedNames = new Set<string>();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const normalizedName = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name) || RESERVED_HEADER_NAMES.has(normalizedName)) {
      throw new EndpointValidationError('invalid_request', 'headers contains an invalid or reserved header name.');
    }
    if (normalizedNames.has(normalizedName)) {
      throw new EndpointValidationError('invalid_request', 'headers contains duplicate header names.');
    }
    if (typeof value !== 'string' || containsControlCharacter(value)) {
      throw new EndpointValidationError('invalid_request', 'headers values must be strings without control characters.');
    }
    normalizedNames.add(normalizedName);
    headers[name] = value;
  }

  return Object.freeze(headers);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }

  return false;
}

function parseEnabled(input: unknown): boolean {
  if (typeof input !== 'boolean') {
    throw new EndpointValidationError('invalid_request', 'enabled must be a boolean.');
  }

  return input;
}

function serializeEventTypes(eventTypes: readonly string[] | null): string | null {
  return eventTypes === null ? null : JSON.stringify(eventTypes);
}

function endpointFromRow(row: EndpointRow): EndpointRecord {
  return {
    id: String(row.id),
    url: String(row.url),
    eventTypes: parseStoredEventTypes(row.event_types_json),
    headers: parseStoredHeaders(row.non_secret_headers_json),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseStoredEventTypes(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  const parsed = JSON.parse(String(value)) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : null;
}

function parseStoredHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === null || value === undefined) return {};
  const parsed = JSON.parse(String(value)) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    headers[name] = String(headerValue);
  }

  return Object.freeze(headers);
}

interface EndpointRow {
  readonly id: unknown;
  readonly url: unknown;
  readonly event_types_json: unknown;
  readonly non_secret_headers_json: unknown;
  readonly enabled: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}
