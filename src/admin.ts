import { randomBytes } from 'node:crypto';

import { createApiKeySecret, hashApiKey } from './auth';
import type { PosthornStorage } from './storage';

export type AdminValidationErrorCode = 'invalid_request';

export interface AdminAppRecord {
  readonly id: string;
  readonly name: string;
  readonly monthlyMessageQuota: number | null;
  readonly createdAt: string;
}

export interface AdminApiKeyRecord {
  readonly id: string;
  readonly appId: string;
  readonly name: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface CreateAdminAppResult {
  readonly app: AdminAppRecord;
}

export interface CreateAdminApiKeyResult {
  readonly apiKey: AdminApiKeyRecord;
  readonly secret: string;
}

export class AdminValidationError extends Error {
  readonly code: AdminValidationErrorCode = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'AdminValidationError';
  }
}

const APP_ID_PREFIX = 'app_';
const API_KEY_ID_PREFIX = 'ak_';
const MAX_NAME_LENGTH = 200;

export function createAdminApp(
  storage: PosthornStorage,
  input: unknown,
  now = new Date(),
): CreateAdminAppResult {
  const body = requireObject(input);
  const id = generateId(APP_ID_PREFIX);
  const name = parseName(body.name, 'name');
  const monthlyMessageQuota = parseMonthlyMessageQuota(body.monthlyMessageQuota);
  const createdAt = now.toISOString();

  storage.db
    .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name, monthlyMessageQuota, createdAt);

  const app = getAdminApp(storage, id);
  if (app === null) throw new Error('Created app could not be read back.');
  return { app };
}

export function listAdminApps(storage: PosthornStorage): readonly AdminAppRecord[] {
  const rows = storage.db
    .prepare(
      `
        SELECT id, name, monthly_message_quota, created_at
        FROM apps
        ORDER BY created_at DESC, id DESC
      `,
    )
    .all() as unknown as AdminAppRow[];

  return rows.map(adminAppFromRow);
}

export function getAdminApp(storage: PosthornStorage, appId: string): AdminAppRecord | null {
  const row = storage.db
    .prepare(
      `
        SELECT id, name, monthly_message_quota, created_at
        FROM apps
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(appId) as AdminAppRow | undefined;

  return row === undefined ? null : adminAppFromRow(row);
}

export function updateAdminApp(
  storage: PosthornStorage,
  appId: string,
  input: unknown,
): AdminAppRecord | null {
  const body = requireObject(input);
  const updates: string[] = [];
  const values: Array<string | number | null> = [];

  if (Object.hasOwn(body, 'name')) {
    updates.push('name = ?');
    values.push(parseName(body.name, 'name'));
  }
  if (Object.hasOwn(body, 'monthlyMessageQuota')) {
    updates.push('monthly_message_quota = ?');
    values.push(parseMonthlyMessageQuota(body.monthlyMessageQuota));
  }
  if (updates.length === 0) {
    throw new AdminValidationError('At least one app field must be supplied.');
  }

  values.push(appId);
  const result = storage.db.prepare(`UPDATE apps SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (result.changes === 0) return null;
  return getAdminApp(storage, appId);
}

export function deleteAdminApp(storage: PosthornStorage, appId: string): boolean {
  const result = storage.db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
  return result.changes > 0;
}

export function createAdminApiKey(
  storage: PosthornStorage,
  appId: string,
  input: unknown,
  now = new Date(),
): CreateAdminApiKeyResult | null {
  if (getAdminApp(storage, appId) === null) return null;
  const body = input === undefined ? {} : requireObject(input);
  const id = generateId(API_KEY_ID_PREFIX);
  const secret = createApiKeySecret();
  const name = parseOptionalName(body.name, 'name');
  const createdAt = now.toISOString();

  storage.db
    .prepare('INSERT INTO api_keys (id, app_id, key_hash, name, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, appId, hashApiKey(secret), name, null, createdAt);

  const apiKey = getAdminApiKey(storage, id);
  if (apiKey === null) throw new Error('Created API key could not be read back.');
  return { apiKey, secret };
}

export function listAdminApiKeys(storage: PosthornStorage, appId: string): readonly AdminApiKeyRecord[] | null {
  if (getAdminApp(storage, appId) === null) return null;
  const rows = storage.db
    .prepare(
      `
        SELECT id, app_id, name, revoked_at, created_at
        FROM api_keys
        WHERE app_id = ?
        ORDER BY created_at DESC, id DESC
      `,
    )
    .all(appId) as unknown as AdminApiKeyRow[];

  return rows.map(adminApiKeyFromRow);
}

export function revokeAdminApiKey(storage: PosthornStorage, apiKeyId: string, now = new Date()): boolean {
  const existing = getAdminApiKey(storage, apiKeyId);
  if (existing === null) return false;
  if (existing.revokedAt !== null) return true;

  storage.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now.toISOString(), apiKeyId);
  return true;
}

function getAdminApiKey(storage: PosthornStorage, apiKeyId: string): AdminApiKeyRecord | null {
  const row = storage.db
    .prepare(
      `
        SELECT id, app_id, name, revoked_at, created_at
        FROM api_keys
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(apiKeyId) as AdminApiKeyRow | undefined;

  return row === undefined ? null : adminApiKeyFromRow(row);
}

function requireObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AdminValidationError('Expected a JSON object.');
  }

  return input as Record<string, unknown>;
}

function parseName(input: unknown, fieldName: string): string {
  if (typeof input !== 'string') {
    throw new AdminValidationError(`${fieldName} must be a non-empty string up to 200 characters.`);
  }

  if (containsControlCharacter(input)) {
    throw new AdminValidationError(`${fieldName} must not contain control characters.`);
  }
  const value = input.trim();
  if (value === '' || value.length > MAX_NAME_LENGTH) {
    throw new AdminValidationError(`${fieldName} must be a non-empty string up to 200 characters.`);
  }

  return value;
}

function parseOptionalName(input: unknown, fieldName: string): string | null {
  if (input === undefined || input === null) return null;
  return parseName(input, fieldName);
}

function parseMonthlyMessageQuota(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new AdminValidationError('monthlyMessageQuota must be null or a non-negative safe integer.');
  }

  return input;
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

function adminAppFromRow(row: AdminAppRow): AdminAppRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    monthlyMessageQuota:
      row.monthly_message_quota === null || row.monthly_message_quota === undefined
        ? null
        : Number(row.monthly_message_quota),
    createdAt: String(row.created_at),
  };
}

function adminApiKeyFromRow(row: AdminApiKeyRow): AdminApiKeyRecord {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
    createdAt: String(row.created_at),
  };
}

interface AdminAppRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly monthly_message_quota: unknown;
  readonly created_at: unknown;
}

interface AdminApiKeyRow {
  readonly id: unknown;
  readonly app_id: unknown;
  readonly name: unknown;
  readonly revoked_at: unknown;
  readonly created_at: unknown;
}
