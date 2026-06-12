import { createHash, randomBytes } from 'node:crypto';

import { getEndpoint } from './endpoints';
import type { PosthornStorage } from './storage';

export type PortalSessionScope = 'endpoint_management';
export type PortalSessionValidationErrorCode = 'invalid_request';

export interface PortalSessionRecord {
  readonly id: string;
  readonly appId: string;
  readonly scope: PortalSessionScope;
  readonly endpointId: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface CreatePortalSessionResult {
  readonly session: PortalSessionRecord & { readonly token: string };
}

export class PortalSessionValidationError extends Error {
  readonly code: PortalSessionValidationErrorCode = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'PortalSessionValidationError';
  }
}

const PORTAL_SESSION_ID_PREFIX = 'ps_';
const PORTAL_SESSION_TOKEN_PREFIX = 'phs_';
const HASH_PREFIX = 'sha256:';
const DEFAULT_TTL_SECONDS = 15 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

export function createPortalSession(
  storage: PosthornStorage,
  appId: string,
  input: unknown,
  now = new Date(),
): CreatePortalSessionResult | null {
  const body = input === undefined ? {} : requireObject(input);
  const endpointId = parseOptionalEndpointId(body.endpointId);
  if (endpointId !== null && getEndpoint(storage, appId, endpointId) === null) {
    return null;
  }

  const ttlSeconds = parseExpiresInSeconds(body.expiresInSeconds);
  const id = generateId(PORTAL_SESSION_ID_PREFIX);
  const token = createPortalSessionToken();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();

  storage.db
    .prepare(
      `
        INSERT INTO portal_sessions (
          id,
          app_id,
          token_hash,
          scope,
          endpoint_id,
          expires_at,
          created_at,
          revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(id, appId, hashPortalSessionToken(token), 'endpoint_management', endpointId, expiresAt, createdAt, null);

  return {
    session: {
      id,
      appId,
      token,
      scope: 'endpoint_management',
      endpointId,
      expiresAt,
      createdAt,
      revokedAt: null,
    },
  };
}

export function getPortalSessionByToken(
  storage: PosthornStorage,
  token: string,
  now = new Date(),
): PortalSessionRecord | null {
  if (!token.startsWith(PORTAL_SESSION_TOKEN_PREFIX)) return null;
  const row = storage.db
    .prepare(
      `
        SELECT id, app_id, scope, endpoint_id, expires_at, created_at, revoked_at
        FROM portal_sessions
        WHERE token_hash = ?
          AND revoked_at IS NULL
          AND expires_at > ?
        LIMIT 1
      `,
    )
    .get(hashPortalSessionToken(token), now.toISOString()) as PortalSessionRow | undefined;

  return row === undefined ? null : portalSessionFromRow(row);
}

export function hashPortalSessionToken(token: string): string {
  if (!token.startsWith(PORTAL_SESSION_TOKEN_PREFIX)) {
    throw new Error(`Portal session tokens must start with ${PORTAL_SESSION_TOKEN_PREFIX}.`);
  }

  return `${HASH_PREFIX}${createHash('sha256').update(token, 'utf8').digest('base64url')}`;
}

function requireObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PortalSessionValidationError('Expected a JSON object.');
  }

  return input as Record<string, unknown>;
}

function parseOptionalEndpointId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PortalSessionValidationError('endpointId must be a non-empty string when supplied.');
  }

  return value.trim();
}

function parseExpiresInSeconds(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TTL_SECONDS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PortalSessionValidationError('expiresInSeconds must be an integer between 60 and 86400.');
  }
  if (value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    throw new PortalSessionValidationError('expiresInSeconds must be an integer between 60 and 86400.');
  }

  return value;
}

function portalSessionFromRow(row: PortalSessionRow): PortalSessionRecord {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    scope: parseScope(row.scope),
    endpointId: row.endpoint_id === null || row.endpoint_id === undefined ? null : String(row.endpoint_id),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
  };
}

function parseScope(value: unknown): PortalSessionScope {
  return value === 'endpoint_management' ? 'endpoint_management' : 'endpoint_management';
}

function createPortalSessionToken(): string {
  return `${PORTAL_SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function generateId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('base64url')}`;
}

interface PortalSessionRow {
  readonly id: unknown;
  readonly app_id: unknown;
  readonly scope: unknown;
  readonly endpoint_id: unknown;
  readonly expires_at: unknown;
  readonly created_at: unknown;
  readonly revoked_at: unknown;
}
