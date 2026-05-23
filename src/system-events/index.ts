/**
 * System webhook events — Posthorn's operator notification surface.
 *
 * When Posthorn auto-disables an endpoint (after continuous failures exceeding
 * the configured window), it POSTs a signed `endpoint.disabled` event to the
 * app's configured system webhook URL. This gives operators/admins an
 * observable signal to investigate and re-enable the endpoint.
 *
 * The payload is signed with Standard Webhooks (the same algorithm used for
 * tenant webhooks), so the receiver can verify authenticity with the app's
 * system webhook secret.
 *
 * Named for parity with Svix's `endpoint.disabled` system event.
 */

import { randomBytes } from "node:crypto";
import { sign, HEADERS } from "../signing/webhook-signature.js";
import { SYSTEM_WEBHOOK_SECRET_PREFIX } from "../apps/app.js";
import type { Endpoint } from "../endpoints/endpoint.js";

/** Prefix for system event ids. */
const SYSTEM_EVENT_ID_PREFIX = "sys_";

/** The URL + signing secret pair for a system webhook. */
export interface SystemWebhookConfig {
  readonly url: string;
  readonly secret: string;
}

/** The wire payload for an `endpoint.disabled` system event. */
export interface EndpointDisabledPayload {
  readonly event: "endpoint.disabled";
  readonly data: {
    readonly endpointId: string;
    readonly appId: string;
    readonly url: string;
    readonly disabled: boolean;
    readonly consecutiveFailures: number;
    readonly firstFailureAt: number | null;
    readonly disabledAt: number;
  };
}

/**
 * A minimal HTTP transport for system event delivery. Injected so callers can
 * provide any `fetch`-compatible implementation (testability, exotic runtimes).
 */
export type SystemEventTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number }>;

/**
 * Normalize a system webhook secret for use with the Standard Webhooks signing
 * function: strip the `sws_` prefix (which the standard signer doesn't know
 * about) and convert base64url to standard base64 so the HMAC key decodes
 * correctly. If the secret already starts with `whsec_` it is passed through.
 */
function normalizeSecretForSigning(secret: string): string {
  if (secret.startsWith(SYSTEM_WEBHOOK_SECRET_PREFIX)) {
    // Strip the sws_ prefix; the remaining base64url bytes are the raw key.
    // Convert base64url → standard base64 so the signer can decode it.
    const raw = secret.slice(SYSTEM_WEBHOOK_SECRET_PREFIX.length);
    // base64url uses - and _ instead of + and /; convert back for Buffer.from("base64").
    return raw.replace(/-/g, "+").replace(/_/g, "/");
  }
  // Already in whsec_<base64> form or raw base64 — pass through.
  return secret;
}

/**
 * Build the Standard Webhooks-signed request for a system event payload.
 * The id, timestamp, and signature headers are added; the body is the exact
 * JSON serialization that was signed.
 */
function buildSystemEventRequest(
  config: SystemWebhookConfig,
  payload: unknown,
  nowMs: number,
): { url: string; method: string; headers: Record<string, string>; body: string } {
  const id = SYSTEM_EVENT_ID_PREFIX + randomBytes(18).toString("base64url");
  const timestampSec = Math.floor(nowMs / 1000);
  const body = JSON.stringify(payload);
  // Normalize the secret so the standard signer can decode it.
  const signingSecret = normalizeSecretForSigning(config.secret);
  const signature = sign(signingSecret, { id, timestamp: timestampSec, payload: body });
  return {
    url: config.url,
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADERS.id]: id,
      [HEADERS.timestamp]: String(timestampSec),
      [HEADERS.signature]: signature,
    },
    body,
  };
}

/**
 * Fire-and-forget the `endpoint.disabled` system event to the configured
 * system webhook URL. Signs the payload using Standard Webhooks so the
 * receiver can verify it. The promise resolves once the transport call
 * resolves; the caller decides whether to await or discard the result.
 *
 * @param config   The system webhook URL and plaintext signing secret.
 * @param endpoint The auto-disabled endpoint snapshot (the relevant fields).
 * @param opts     Clock and transport injection (for testability).
 */
export async function emitEndpointDisabledEvent(
  config: SystemWebhookConfig,
  endpoint: Pick<
    Endpoint,
    "id" | "appId" | "url" | "disabled" | "consecutiveFailures" | "firstFailureAt"
  >,
  opts: { transport: SystemEventTransport; now: () => number },
): Promise<void> {
  const nowMs = opts.now();
  const payload: EndpointDisabledPayload = {
    event: "endpoint.disabled",
    data: {
      endpointId: endpoint.id,
      appId: endpoint.appId,
      url: endpoint.url,
      disabled: endpoint.disabled,
      consecutiveFailures: endpoint.consecutiveFailures,
      firstFailureAt: endpoint.firstFailureAt,
      disabledAt: nowMs,
    },
  };
  const req = buildSystemEventRequest(config, payload, nowMs);
  await opts.transport(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
}
