import { createHash, randomBytes } from 'node:crypto';

import type { PosthornStorage } from './storage';

export const API_KEY_PREFIX = 'phk_';

const HASH_PREFIX = 'sha256:';
const DEFAULT_API_KEY_BYTES = 32;
const MIN_API_KEY_BYTES = 24;
const MAX_API_KEY_BYTES = 64;

export interface AuthenticatedTenant {
  readonly appId: string;
  readonly apiKeyId: string;
}

export function createApiKeySecret(byteLength = DEFAULT_API_KEY_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < MIN_API_KEY_BYTES || byteLength > MAX_API_KEY_BYTES) {
    throw new RangeError(`API keys must be between ${MIN_API_KEY_BYTES} and ${MAX_API_KEY_BYTES} bytes.`);
  }

  return `${API_KEY_PREFIX}${randomBytes(byteLength).toString('base64url')}`;
}

export function hashApiKey(apiKey: string): string {
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    throw new Error(`API keys must start with ${API_KEY_PREFIX}.`);
  }

  return `${HASH_PREFIX}${createHash('sha256').update(apiKey, 'utf8').digest('base64url')}`;
}

export function authenticateApiKey(
  storage: PosthornStorage,
  authorizationHeader: string | readonly string[] | undefined,
): AuthenticatedTenant | null {
  const apiKey = parseBearerToken(authorizationHeader);
  if (apiKey === null || !apiKey.startsWith(API_KEY_PREFIX)) {
    return null;
  }

  const row = storage.db
    .prepare(`
      SELECT api_keys.id AS api_key_id, api_keys.app_id AS app_id
      FROM api_keys
      INNER JOIN apps ON apps.id = api_keys.app_id
      WHERE api_keys.key_hash = ? AND api_keys.revoked_at IS NULL
      LIMIT 1
    `)
    .get(hashApiKey(apiKey)) as AuthRow | undefined;

  if (row === undefined) return null;
  return {
    appId: String(row.app_id),
    apiKeyId: String(row.api_key_id),
  };
}

function parseBearerToken(authorizationHeader: string | readonly string[] | undefined): string | null {
  if (authorizationHeader === undefined) return null;
  const value = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (value === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

interface AuthRow {
  readonly api_key_id: unknown;
  readonly app_id: unknown;
}
