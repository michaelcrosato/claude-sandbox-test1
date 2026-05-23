import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks-compliant message signing and verification.
 *
 * The signed content is the message id, timestamp, and payload joined by full
 * stops (`{id}.{timestamp}.{payload}`), HMAC-SHA256'd with the base64-decoded
 * secret, and emitted as a `v1,<base64>` token. Multiple space-delimited tokens
 * are supported in the `webhook-signature` header to allow zero-downtime key
 * rotation.
 *
 * @see https://www.standardwebhooks.com/
 */

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

/** Canonical header names defined by the Standard Webhooks spec. */
export const HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

/** Thrown for any signing/verification failure. Never leaks the expected value. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface SignInput {
  /** Unique message id; transmitted as the `webhook-id` header. */
  id: string;
  /** Unix timestamp in seconds; transmitted as the `webhook-timestamp` header. */
  timestamp: number;
  /** Exact serialized body that will be transmitted, byte-for-byte. */
  payload: string;
}

export interface VerifyHeaders {
  id: string;
  /** Accepts the raw header string or a number. */
  timestamp: string | number;
  /** The full `webhook-signature` header value (may contain several tokens). */
  signature: string;
}

export interface VerifyOptions {
  /** Allowed clock skew in seconds in either direction. Defaults to 300 (5 min). */
  toleranceInSeconds?: number;
  /** Override the current time (seconds since epoch); primarily for tests. */
  now?: number;
}

/**
 * Decode a `whsec_`-prefixed (or bare) base64 secret into raw key bytes.
 * The prefix is purely cosmetic per the spec and is stripped before decoding.
 */
function decodeSecret(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  const key = Buffer.from(raw, "base64");
  if (key.length === 0) {
    throw new WebhookVerificationError("secret is empty or not valid base64");
  }
  return key;
}

/** Compute the raw base64 HMAC digest for the signed content. */
function digest(secret: string, input: SignInput): string {
  if (!Number.isFinite(input.timestamp)) {
    throw new WebhookVerificationError("timestamp must be a finite number");
  }
  const key = decodeSecret(secret);
  const toSign = `${input.id}.${input.timestamp}.${input.payload}`;
  return createHmac("sha256", key).update(toSign, "utf8").digest("base64");
}

/**
 * Produce a `webhook-signature` header value (`v1,<base64>`) for a message.
 */
export function sign(secret: string, input: SignInput): string {
  return `${SIGNATURE_VERSION},${digest(secret, input)}`;
}

/** Constant-time comparison of two base64-encoded digests. */
function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "base64");
  const bb = Buffer.from(b, "base64");
  if (ab.length === 0 || ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a received webhook. Throws {@link WebhookVerificationError} on any
 * failure (bad timestamp, replay outside the tolerance window, or no matching
 * signature). Returns void on success.
 */
export function verify(
  secret: string,
  headers: VerifyHeaders,
  payload: string,
  options: VerifyOptions = {},
): void {
  const tolerance = options.toleranceInSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const ts =
    typeof headers.timestamp === "number"
      ? headers.timestamp
      : Number(headers.timestamp);
  if (!Number.isFinite(ts)) {
    throw new WebhookVerificationError("invalid webhook-timestamp header");
  }
  if (ts < now - tolerance) {
    throw new WebhookVerificationError("webhook timestamp is too old");
  }
  if (ts > now + tolerance) {
    throw new WebhookVerificationError("webhook timestamp is too new");
  }

  const expected = digest(secret, { id: headers.id, timestamp: ts, payload });

  // The header is a space-delimited list of `version,digest` tokens. A match on
  // any well-formed `v1` token passes (supports key rotation / multi-sign).
  const matched = headers.signature
    .split(" ")
    .filter((token) => token.length > 0)
    .some((token) => {
      const commaAt = token.indexOf(",");
      if (commaAt === -1) {
        return false;
      }
      const version = token.slice(0, commaAt);
      const value = token.slice(commaAt + 1);
      return version === SIGNATURE_VERSION && digestsEqual(value, expected);
    });

  if (!matched) {
    throw new WebhookVerificationError("no matching signature found");
  }
}

/**
 * Generate a fresh signing secret in `whsec_<base64>` form. Uses 24 bytes
 * (192 bits) of CSPRNG entropy by default.
 */
export function generateSecret(byteLength = 24): string {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new WebhookVerificationError("secret must be at least 16 bytes");
  }
  return SECRET_PREFIX + randomBytes(byteLength).toString("base64");
}
