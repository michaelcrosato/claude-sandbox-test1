import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { PosthornStorage } from './storage';

export const ENDPOINT_SECRET_KEY_VERSION = 'local-aes-256-gcm-v1';
export const LEGACY_DIGEST_SECRET_KEY_VERSION = 'sha256-v1';

const LOCAL_KEY_ID = 'endpoint-signing-v1';
const CIPHERTEXT_COMPAT_PREFIX = 'sha256:';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface ProtectedSecret {
  readonly ciphertext: string;
  readonly keyVersion: string;
  readonly nonce: string;
}

export class SecretProtectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretProtectionError';
  }
}

export function protectEndpointSecret(storage: PosthornStorage, secret: string, now = new Date()): ProtectedSecret {
  const key = getOrCreateLocalKey(storage, now);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: `${CIPHERTEXT_COMPAT_PREFIX}${Buffer.concat([encrypted, tag]).toString('base64url')}`,
    keyVersion: ENDPOINT_SECRET_KEY_VERSION,
    nonce: nonce.toString('base64url'),
  };
}

export function revealEndpointSecret(storage: PosthornStorage, protectedSecret: ProtectedSecret): string {
  if (protectedSecret.keyVersion === LEGACY_DIGEST_SECRET_KEY_VERSION) {
    throw new SecretProtectionError('Endpoint signing secret is not recoverable.');
  }
  if (protectedSecret.keyVersion !== ENDPOINT_SECRET_KEY_VERSION) {
    throw new SecretProtectionError('Endpoint signing secret uses an unsupported protection version.');
  }

  const key = getLocalKey(storage);
  const nonce = decodeBase64Url(protectedSecret.nonce, 'Endpoint signing secret nonce is invalid.');
  const payload = decodeBase64Url(
    stripCiphertextPrefix(protectedSecret.ciphertext),
    'Endpoint signing secret ciphertext is invalid.',
  );
  if (nonce.length !== NONCE_BYTES || payload.length <= AUTH_TAG_BYTES) {
    throw new SecretProtectionError('Endpoint signing secret protection metadata is invalid.');
  }

  const encrypted = payload.subarray(0, payload.length - AUTH_TAG_BYTES);
  const tag = payload.subarray(payload.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretProtectionError('Endpoint signing secret could not be revealed.');
  }
}

function stripCiphertextPrefix(value: string): string {
  return value.startsWith(CIPHERTEXT_COMPAT_PREFIX) ? value.slice(CIPHERTEXT_COMPAT_PREFIX.length) : value;
}

function getOrCreateLocalKey(storage: PosthornStorage, now: Date): Buffer {
  const existing = readLocalKey(storage);
  if (existing !== null) return existing;

  const keyMaterial = randomBytes(KEY_BYTES).toString('base64url');
  storage.db
    .prepare('INSERT OR IGNORE INTO local_secret_keys (id, key_material, created_at) VALUES (?, ?, ?)')
    .run(LOCAL_KEY_ID, keyMaterial, now.toISOString());
  return getLocalKey(storage);
}

function getLocalKey(storage: PosthornStorage): Buffer {
  const key = readLocalKey(storage);
  if (key === null) {
    throw new SecretProtectionError('Local endpoint signing key is missing.');
  }

  return key;
}

function readLocalKey(storage: PosthornStorage): Buffer | null {
  const row = storage.db
    .prepare('SELECT key_material FROM local_secret_keys WHERE id = ? LIMIT 1')
    .get(LOCAL_KEY_ID) as { readonly key_material: unknown } | undefined;
  if (row === undefined) return null;

  const key = decodeBase64Url(String(row.key_material), 'Local endpoint signing key is invalid.');
  if (key.length !== KEY_BYTES) {
    throw new SecretProtectionError('Local endpoint signing key has an invalid length.');
  }

  return key;
}

function decodeBase64Url(value: string, message: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SecretProtectionError(message);
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) {
    throw new SecretProtectionError(message);
  }

  return decoded;
}
