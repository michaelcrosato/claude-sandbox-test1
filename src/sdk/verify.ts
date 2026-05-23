/**
 * Receiver-side webhook verification — the half of the SDK a *consumer* runs on
 * the endpoint that **receives** Posthorn-delivered webhooks.
 *
 * The cryptographic verification itself lives in the library's signer
 * ({@link verify} in `../signing/webhook-signature.ts`); this module adds the
 * one ergonomic thing a receiver actually needs and routinely gets wrong:
 * pulling the three Standard Webhooks headers (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature`) out of a raw HTTP header bag,
 * case-insensitively, and handling node's `string | string[]` header values.
 *
 * It deliberately holds **no** crypto of its own — it is a thin, well-typed
 * adapter onto the proven verifier, so the two can never drift.
 *
 * ## The one rule that matters
 *
 * Verify against the **raw request body bytes, exactly as received** — before any
 * `JSON.parse` + re-serialize. The signature covers the bytes on the wire; a
 * round-trip through `JSON.parse`/`JSON.stringify` can reorder keys or change
 * whitespace and will make a valid signature fail.
 *
 * @example
 * ```ts
 * import { verifyWebhook } from "posthorn";
 * // inside an http handler, with the raw body string already read:
 * try {
 *   verifyWebhook(endpointSecret, req.headers, rawBody);
 *   // trusted: handle the event
 * } catch (err) {
 *   res.writeHead(400).end("invalid signature");
 * }
 * ```
 */

import {
  HEADERS,
  verify,
  WebhookVerificationError,
  type VerifyOptions,
} from "../signing/webhook-signature.js";

/**
 * A bag of received HTTP headers, as produced by `node:http`
 * (`IncomingMessage.headers`) and most frameworks: keys are header names,
 * values are a single string, an array of strings, or `undefined` when absent.
 * Lookups here are case-insensitive, so either raw or normalized keys work.
 */
export type IncomingHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** Case-insensitively read a single header value, collapsing an array to its first entry. */
function pickHeader(headers: IncomingHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) {
      continue;
    }
    const value = headers[key];
    if (value === undefined) {
      return undefined;
    }
    return Array.isArray(value) ? value[0] : (value as string);
  }
  return undefined;
}

/**
 * Verify a received webhook from a raw HTTP header bag and the **raw request
 * body string**. Extracts the three Standard Webhooks headers and delegates to
 * the library {@link verify}.
 *
 * Throws {@link WebhookVerificationError} on any failure — a missing header, a
 * timestamp outside the tolerance window (replay protection), or no matching
 * signature — and returns `void` on success. See {@link VerifyOptions} to widen
 * the tolerance or pin `now` (tests).
 *
 * @param secret  The endpoint's signing secret (`whsec_…`), as returned once by
 *                {@link import("./client.js").PosthornClient.createEndpoint}.
 * @param headers The received request headers (case-insensitive).
 * @param rawBody The exact received body bytes — do not re-serialize.
 */
export function verifyWebhook(
  secret: string,
  headers: IncomingHeaders,
  rawBody: string,
  options?: VerifyOptions,
): void {
  const id = pickHeader(headers, HEADERS.id);
  const timestamp = pickHeader(headers, HEADERS.timestamp);
  const signature = pickHeader(headers, HEADERS.signature);
  if (id === undefined || timestamp === undefined || signature === undefined) {
    throw new WebhookVerificationError(
      `missing one or more required webhook headers (${HEADERS.id}, ${HEADERS.timestamp}, ${HEADERS.signature})`,
    );
  }
  verify(secret, { id, timestamp, signature }, rawBody, options);
}

/**
 * Boolean variant of {@link verifyWebhook}: returns `true` when the webhook is
 * authentic and `false` when verification fails, never throwing for an ordinary
 * verification failure. Any non-verification error (a programming bug) still
 * propagates.
 */
export function isValidWebhook(
  secret: string,
  headers: IncomingHeaders,
  rawBody: string,
  options?: VerifyOptions,
): boolean {
  try {
    verifyWebhook(secret, headers, rawBody, options);
    return true;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return false;
    }
    throw err;
  }
}
