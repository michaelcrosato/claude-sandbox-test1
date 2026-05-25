/**
 * System webhook events — Posthorn's operator notification surface.
 *
 * Posthorn fires signed system events to the app's configured system webhook URL:
 *
 * - `endpoint.disabled` — an endpoint was auto-disabled after continuous failures
 *   exceeding the configured window. Named for parity with Svix's system event.
 * - `message.dead_lettered` — a delivery exhausted all retry attempts and
 *   permanently moved to `dead_letter`. Lets operators react (alert, page, etc.)
 *   without polling `/v1/deliveries?status=dead_letter`.
 *
 * All payloads are signed with Standard Webhooks (the same algorithm used for
 * tenant webhooks), so the receiver can verify authenticity with the app's
 * system webhook secret.
 */

import { randomBytes } from "node:crypto";
import { sign, HEADERS } from "../signing/webhook-signature.js";
import { SYSTEM_WEBHOOK_SECRET_PREFIX } from "../apps/app.js";
import type { Endpoint } from "../endpoints/endpoint.js";
import type { Transport } from "../worker/delivery-worker.js";

/** The wire payload for a `message.dead_lettered` system event. */
export interface MessageDeadLetteredPayload {
  readonly event: "message.dead_lettered";
  readonly data: {
    readonly messageId: string;
    readonly endpointId: string | null;
    readonly appId: string | null;
    readonly deadLetteredAt: number;
  };
}

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
 * Adapt a delivery {@link Transport} into a {@link SystemEventTransport}, so a system
 * webhook delivery rides the **same** connection-time SSRF guard (the resolved-IP
 * check in {@link import("../net/guarded-transport.js").createGuardedTransport}) and
 * no-redirect-following policy as a tenant webhook delivery.
 *
 * The app's system webhook URL is operator-configured, but it is still a stored,
 * mutable destination: a public hostname that resolves (or rebinds) to a private IP,
 * or a compromised receiver that answers a signed system event with a 3xx toward an
 * internal address, are the same SSRF vectors the tenant delivery path already
 * defends against. Routing system events through the guarded transport closes that
 * gap and keeps the two delivery paths consistent (one `allowPrivateNetworks` opt-out
 * governs both).
 *
 * System events are always `POST` and are fire-and-forget — they carry no abort
 * deadline of their own — so a never-aborting signal is supplied when the caller
 * passes none. A transport-level failure, **including an SSRF block**, rejects; the
 * emit helpers' caller treats that as a best-effort failure that never blocks or
 * changes a delivery (see the worker's `onError` seam).
 */
export function systemEventTransportFrom(transport: Transport): SystemEventTransport {
  return async (url, init) => {
    const response = await transport(
      { url, method: "POST", headers: init.headers, body: init.body },
      init.signal ?? new AbortController().signal,
    );
    return { status: response.status };
  };
}

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

/**
 * Fire-and-forget the `message.dead_lettered` system event to the configured
 * system webhook URL. Emitted when a delivery exhausts all retry attempts and
 * permanently moves to `dead_letter`, giving operators an observable push signal
 * without requiring them to poll `/v1/deliveries?status=dead_letter`.
 *
 * Signed with Standard Webhooks so the receiver can verify authenticity.
 *
 * @param config  The system webhook URL and plaintext signing secret.
 * @param info    The dead-lettered task's identifiers.
 * @param opts    Clock and transport injection (for testability).
 */
export async function emitMessageDeadLetteredEvent(
  config: SystemWebhookConfig,
  info: { readonly messageId: string; readonly endpointId: string | null; readonly appId: string | null },
  opts: { transport: SystemEventTransport; now: () => number },
): Promise<void> {
  const nowMs = opts.now();
  const payload: MessageDeadLetteredPayload = {
    event: "message.dead_lettered",
    data: {
      messageId: info.messageId,
      endpointId: info.endpointId,
      appId: info.appId,
      deadLetteredAt: nowMs,
    },
  };
  const req = buildSystemEventRequest(config, payload, nowMs);
  await opts.transport(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
}
