import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_ID_HEADER = 'webhook-id';
export const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

const WEBHOOK_SECRET_PREFIX = 'whsec_';
const SIGNATURE_VERSION = 'v1';
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;

export type WebhookBody = string | Buffer | Uint8Array;
export type WebhookSecretInput = string | readonly string[];
export type WebhookVerificationErrorCode =
  | 'missing_header'
  | 'invalid_header'
  | 'invalid_timestamp'
  | 'timestamp_outside_tolerance'
  | 'invalid_secret'
  | 'signature_mismatch';

export interface WebhookHeadersLike {
  get(name: string): string | null;
}

export type WebhookHeaderValue = string | readonly string[] | number | null | undefined;
export interface WebhookHeaderRecord {
  readonly [name: string]: WebhookHeaderValue;
}
export type WebhookHeaderInput = WebhookHeadersLike | WebhookHeaderRecord;

export interface SignWebhookOptions {
  readonly id?: string;
  readonly timestampSeconds?: number;
}

export interface VerifyWebhookOptions {
  readonly toleranceSeconds?: number;
  readonly nowSeconds?: number;
}

export interface WebhookSignedHeaders extends WebhookHeaderRecord {
  readonly 'webhook-id': string;
  readonly 'webhook-timestamp': string;
  readonly 'webhook-signature': string;
}

export interface VerifiedWebhook {
  readonly id: string;
  readonly timestampSeconds: number;
}

export class WebhookVerificationError extends Error {
  readonly code: WebhookVerificationErrorCode;

  constructor(code: WebhookVerificationErrorCode, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

export function createWebhookSecret(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < MIN_SECRET_BYTES || byteLength > MAX_SECRET_BYTES) {
    throw new RangeError(`Webhook secrets must be between ${MIN_SECRET_BYTES} and ${MAX_SECRET_BYTES} bytes.`);
  }

  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(byteLength).toString('base64')}`;
}

export function signWebhook(
  secretOrSecrets: WebhookSecretInput,
  rawBody: WebhookBody,
  options: SignWebhookOptions = {},
): WebhookSignedHeaders {
  const secrets = normalizeSecrets(secretOrSecrets, 'sign');
  const id = options.id ?? generateWebhookId();
  const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  assertValidWebhookId(id);
  assertValidTimestamp(timestampSeconds);

  const bodyBytes = toBodyBytes(rawBody);
  const signatures = secrets.map((secret) => {
    const key = decodeWebhookSecret(secret, 'sign');
    return `${SIGNATURE_VERSION},${createSymmetricSignature(key, id, timestampSeconds, bodyBytes)}`;
  });

  return {
    [WEBHOOK_ID_HEADER]: id,
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestampSeconds),
    [WEBHOOK_SIGNATURE_HEADER]: signatures.join(' '),
  };
}

export function verifyWebhook(
  secretOrSecrets: WebhookSecretInput,
  headers: WebhookHeaderInput,
  rawBody: WebhookBody,
  options: VerifyWebhookOptions = {},
): VerifiedWebhook {
  const secrets = normalizeSecrets(secretOrSecrets, 'verify');
  const id = requiredHeader(headers, WEBHOOK_ID_HEADER);
  const timestampHeader = requiredHeader(headers, WEBHOOK_TIMESTAMP_HEADER);
  const signatureHeader = requiredHeader(headers, WEBHOOK_SIGNATURE_HEADER);
  const timestampSeconds = parseHeaderTimestamp(timestampHeader);
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  assertValidWebhookIdForVerification(id);
  assertValidTolerance(toleranceSeconds);
  assertValidNowSeconds(nowSeconds);

  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    throw new WebhookVerificationError(
      'timestamp_outside_tolerance',
      'Webhook timestamp is outside the allowed replay window.',
    );
  }

  const parsedSignatures = parseSignatureHeader(signatureHeader);
  const bodyBytes = toBodyBytes(rawBody);
  const keys = secrets.map((secret) => decodeWebhookSecret(secret, 'verify'));

  for (const key of keys) {
    const expected = createSymmetricSignatureBytes(key, id, timestampSeconds, bodyBytes);
    if (parsedSignatures.some((signature) => timingSafeEqualIfSameLength(expected, signature))) {
      return { id, timestampSeconds };
    }
  }

  throw new WebhookVerificationError('signature_mismatch', 'Webhook signature does not match.');
}

function normalizeSecrets(secretOrSecrets: WebhookSecretInput, mode: 'sign' | 'verify'): readonly string[] {
  const secrets = typeof secretOrSecrets === 'string' ? [secretOrSecrets] : [...secretOrSecrets];
  if (secrets.length === 0) {
    throw invalidSecret(mode, 'At least one webhook secret is required.');
  }
  if (secrets.some((secret) => typeof secret !== 'string' || secret.length === 0)) {
    throw invalidSecret(mode, 'Webhook secrets must be non-empty strings.');
  }

  return secrets;
}

function generateWebhookId(): string {
  return `msg_${randomBytes(16).toString('base64url')}`;
}

function assertValidWebhookId(id: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.includes('.') || /\s/.test(id)) {
    throw new Error('Webhook id must be a non-empty string without dots or whitespace.');
  }
}

function assertValidWebhookIdForVerification(id: string): void {
  try {
    assertValidWebhookId(id);
  } catch {
    throw new WebhookVerificationError('invalid_header', 'Webhook id header is invalid.');
  }
}

function assertValidTimestamp(timestampSeconds: number): void {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error('Webhook timestamp must be a non-negative safe integer.');
  }
}

function assertValidTolerance(toleranceSeconds: number): void {
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0) {
    throw new WebhookVerificationError('invalid_timestamp', 'Webhook tolerance must be a non-negative safe integer.');
  }
}

function assertValidNowSeconds(nowSeconds: number): void {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new WebhookVerificationError('invalid_timestamp', 'Current webhook time must be a non-negative safe integer.');
  }
}

function requiredHeader(headers: WebhookHeaderInput, name: string): string {
  const value = readHeader(headers, name);
  if (value === null || value === undefined || value.trim() === '') {
    throw new WebhookVerificationError('missing_header', `Missing required webhook header: ${name}.`);
  }

  return value.trim();
}

function readHeader(headers: WebhookHeaderInput, name: string): string | undefined {
  if (isHeadersLike(headers)) {
    return headers.get(name) ?? undefined;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return normalizeHeaderValue(value);
    }
  }

  return undefined;
}

function isHeadersLike(headers: WebhookHeaderInput): headers is WebhookHeadersLike {
  return typeof (headers as WebhookHeadersLike).get === 'function';
}

function normalizeHeaderValue(value: WebhookHeaderValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.join(' ');
  return String(value);
}

function parseHeaderTimestamp(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new WebhookVerificationError('invalid_timestamp', 'Webhook timestamp must be an integer Unix timestamp.');
  }

  const timestampSeconds = Number(value);
  if (!Number.isSafeInteger(timestampSeconds)) {
    throw new WebhookVerificationError('invalid_timestamp', 'Webhook timestamp must be a safe integer.');
  }

  return timestampSeconds;
}

function parseSignatureHeader(value: string): readonly Buffer[] {
  const signatures: Buffer[] = [];
  const tokens = value.trim().split(/\s+/);

  for (const token of tokens) {
    const commaIndex = token.indexOf(',');
    if (commaIndex <= 0 || commaIndex === token.length - 1) {
      throw new WebhookVerificationError('invalid_header', 'Webhook signature header is malformed.');
    }

    const version = token.slice(0, commaIndex);
    const signature = token.slice(commaIndex + 1);
    if (version !== SIGNATURE_VERSION) {
      continue;
    }

    signatures.push(decodeBase64(signature, 'invalid_header', 'Webhook signature must be base64 encoded.'));
  }

  if (signatures.length === 0) {
    throw new WebhookVerificationError('signature_mismatch', 'No supported webhook signatures were provided.');
  }

  return signatures;
}

function decodeWebhookSecret(secret: string, mode: 'sign' | 'verify'): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    throw invalidSecret(mode, `Webhook secret must start with ${WEBHOOK_SECRET_PREFIX}.`);
  }

  const encoded = secret.slice(WEBHOOK_SECRET_PREFIX.length);
  const decoded = decodeBase64(encoded, 'invalid_secret', 'Webhook secret must be base64 encoded.', mode);
  if (decoded.length < MIN_SECRET_BYTES || decoded.length > MAX_SECRET_BYTES) {
    throw invalidSecret(mode, `Webhook secret must decode to ${MIN_SECRET_BYTES}-${MAX_SECRET_BYTES} bytes.`);
  }

  return decoded;
}

function decodeBase64(
  encoded: string,
  verificationCode: WebhookVerificationErrorCode,
  message: string,
  mode: 'sign' | 'verify' = 'verify',
): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw mode === 'verify' ? new WebhookVerificationError(verificationCode, message) : new Error(message);
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw mode === 'verify' ? new WebhookVerificationError(verificationCode, message) : new Error(message);
  }

  return decoded;
}

function invalidSecret(mode: 'sign' | 'verify', message: string): Error {
  return mode === 'verify' ? new WebhookVerificationError('invalid_secret', message) : new Error(message);
}

function createSymmetricSignature(key: Buffer, id: string, timestampSeconds: number, bodyBytes: Buffer): string {
  return createSymmetricSignatureBytes(key, id, timestampSeconds, bodyBytes).toString('base64');
}

function createSymmetricSignatureBytes(key: Buffer, id: string, timestampSeconds: number, bodyBytes: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(`${id}.${timestampSeconds}.`, 'utf8')
    .update(bodyBytes)
    .digest();
}

function timingSafeEqualIfSameLength(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function toBodyBytes(rawBody: WebhookBody): Buffer {
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  if (Buffer.isBuffer(rawBody)) return rawBody;
  return Buffer.from(rawBody);
}
