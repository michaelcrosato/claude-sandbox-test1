import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe webhook signature signing and verification.
 *
 * Stripe signs an inbound webhook with a scheme that is *related to but distinct
 * from* the Standard Webhooks scheme Posthorn uses for its own tenant/system events
 * (see `src/signing/webhook-signature.ts`). The differences are deliberate and must
 * be matched exactly or verification silently fails:
 *
 * | aspect            | Standard Webhooks (`webhook-signature.ts`) | Stripe (this module)        |
 * | ----------------- | ------------------------------------------ | --------------------------- |
 * | signed content    | `{id}.{timestamp}.{payload}`               | `{timestamp}.{payload}`     |
 * | HMAC key          | base64-decoded secret (prefix stripped)    | the secret **string as-is** |
 * | digest encoding   | base64                                     | hex                         |
 * | header name       | `webhook-signature`                        | `Stripe-Signature`          |
 * | header format     | `v1,<base64>` (space-delimited tokens)     | `t=<ts>,v1=<hex>[,v1=…]`    |
 *
 * The single most error-prone point is the key: Stripe uses the endpoint's signing
 * secret (the `whsec_…` value) **verbatim as the UTF-8 HMAC key** — it is *not*
 * base64-decoded and the prefix is *not* stripped, unlike Standard Webhooks. This
 * mirrors Stripe's own libraries (`crypto.createHmac('sha256', secret)`).
 *
 * @see https://docs.stripe.com/webhooks/signature
 */

/**
 * The header Stripe sends the signature in, lowercased to match the normalized
 * `ApiRequest.headers` keys (HTTP header names are case-insensitive).
 */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/** The scheme prefix for the HMAC-SHA256 signatures Posthorn verifies. */
const SIGNATURE_SCHEME = "v1";

/** Default allowed clock skew (seconds) between the signed timestamp and now. */
export const DEFAULT_STRIPE_TOLERANCE_SECONDS = 5 * 60;

/** Thrown for any Stripe signature failure. Never leaks the expected digest. */
export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSignatureError";
  }
}

/** The two halves of a signed Stripe payload. */
export interface StripeSignInput {
  /** Unix timestamp in seconds; transmitted as the `t=` field. */
  readonly timestamp: number;
  /** The exact serialized body, byte-for-byte (what the receiver re-signs). */
  readonly payload: string;
}

/** Options for {@link verifyStripeSignature}. */
export interface StripeVerifyOptions {
  /** Allowed clock skew in seconds either direction. Defaults to 300 (5 min). */
  readonly toleranceInSeconds?: number;
  /** Override the current time (seconds since epoch); primarily for tests. */
  readonly now?: number;
}

/**
 * Compute the hex HMAC-SHA256 digest of `{timestamp}.{payload}` using the secret
 * **string verbatim** as the key (see the module docstring — this is the Stripe
 * convention, not the Standard Webhooks one).
 */
function digest(secret: string, input: StripeSignInput): string {
  if (!Number.isFinite(input.timestamp)) {
    throw new StripeSignatureError("timestamp must be a finite number");
  }
  const signedPayload = `${input.timestamp}.${input.payload}`;
  return createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
}

/**
 * Produce a `Stripe-Signature` header value (`t=<ts>,v1=<hex>`) for a payload.
 * Used to drive the inbound webhook route in tests and the compiled-dist smoke
 * without a live Stripe account — the production path only ever *verifies*.
 */
export function signStripeSignatureHeader(secret: string, input: StripeSignInput): string {
  return `t=${input.timestamp},${SIGNATURE_SCHEME}=${digest(secret, input)}`;
}

/** Constant-time comparison of two hex-encoded digests. */
function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length === 0 || ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Parse a `Stripe-Signature` header into its timestamp and `v1` signatures. */
function parseHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      timestamp = Number(value);
    } else if (key === SIGNATURE_SCHEME && value.length > 0) {
      signatures.push(value);
    }
  }
  return { timestamp, signatures };
}

/**
 * Verify an inbound Stripe webhook. Throws {@link StripeSignatureError} on any
 * failure (malformed header, timestamp outside the tolerance window, or no matching
 * signature); returns void on success. The `payload` must be the **raw request
 * body** exactly as received — re-serializing parsed JSON would change the bytes and
 * break verification.
 */
export function verifyStripeSignature(
  secret: string,
  header: string | undefined,
  payload: string,
  options: StripeVerifyOptions = {},
): void {
  if (secret.length === 0) {
    throw new StripeSignatureError("webhook signing secret is empty");
  }
  if (header === undefined || header.trim() === "") {
    throw new StripeSignatureError("missing Stripe-Signature header");
  }

  const { timestamp, signatures } = parseHeader(header);
  if (!Number.isFinite(timestamp)) {
    throw new StripeSignatureError("Stripe-Signature header has no valid timestamp");
  }
  if (signatures.length === 0) {
    throw new StripeSignatureError("Stripe-Signature header has no v1 signature");
  }

  const tolerance = options.toleranceInSeconds ?? DEFAULT_STRIPE_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (timestamp < now - tolerance) {
    throw new StripeSignatureError("webhook timestamp is too old");
  }
  if (timestamp > now + tolerance) {
    throw new StripeSignatureError("webhook timestamp is too new");
  }

  const expected = digest(secret, { timestamp, payload });
  // A match on any presented v1 token passes (Stripe sends multiple during a signing
  // secret roll), the same multi-signature tolerance the Standard Webhooks verifier has.
  if (!signatures.some((candidate) => digestsEqual(candidate, expected))) {
    throw new StripeSignatureError("no matching signature found");
  }
}
