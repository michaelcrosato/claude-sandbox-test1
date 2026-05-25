/**
 * A {@link Transport} that performs the webhook POST over Node's built-in
 * `http`/`https` with a connection-time SSRF guard ({@link createGuardedLookup}) on
 * DNS resolution — Posthorn's deeper SSRF defense, carrying **zero added
 * dependencies** (a hard product constraint: the single-container, no-deps wedge).
 *
 * It is a drop-in {@link Transport} alongside `fetchTransport`, with two deliberate
 * behavioral differences, both security improvements for a webhook *sender*:
 *
 *  1. **Connection-time IP check.** The destination hostname's resolved IP is
 *     verified at connect time and the connection is refused if it lands on a
 *     private/internal address — closing the DNS-rebinding / public-name-resolves-
 *     to-private-IP residual the registration-time guard cannot see. Governed by the
 *     same {@link SsrfPolicy.allowPrivateNetworks} opt-out as the registration guard
 *     (when set, the lookup is a transparent pass-through).
 *  2. **Redirects are not followed.** Node's `request` does not auto-follow, so a
 *     receiver that answers a delivery with a 3xx is recorded as a non-2xx *failed
 *     attempt* rather than chasing the `Location` header — which would be an
 *     unguarded SSRF hop. (`fetch`'s default redirect-following allowed that hop.)
 *
 * The {@link HttpDeliveryResponse} contract matches `fetchTransport` exactly: a
 * server response of any status is *returned* (the worker classifies 2xx as
 * success), while a transport-level failure — DNS error, refused connection,
 * timeout/abort, or an SSRF block — is *thrown*. `retry-after` and a truncated
 * response body are captured identically.
 */

import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

import { MAX_CAPTURED_BODY_BYTES } from "../attempts/delivery-attempt.js";
import type {
  HttpDeliveryRequest,
  HttpDeliveryResponse,
  Transport,
} from "../worker/delivery-worker.js";
import { createGuardedLookup } from "./guarded-lookup.js";
import type { SsrfPolicy } from "./ssrf-guard.js";

/**
 * Byte ceiling on buffered response bytes: enough UTF-8 bytes (≤4 per char) to
 * yield {@link MAX_CAPTURED_BODY_BYTES} characters. Past this the socket is still
 * drained but no further bytes are buffered, bounding memory on a hostile or
 * accidentally-huge response body.
 */
const MAX_BUFFERED_RESPONSE_BYTES = MAX_CAPTURED_BODY_BYTES * 4;

/** Construction options for {@link createGuardedTransport}. */
export interface GuardedTransportOptions {
  /**
   * Override the DNS lookup used per request. Defaults to a policy-bound
   * {@link createGuardedLookup}. Tests inject a guarded lookup over a fake resolver
   * so the connect-time decision is exercised deterministically, without real DNS.
   */
  readonly lookup?: LookupFunction;
}

/**
 * Build a {@link Transport} that delivers over `http`/`https` with the
 * connection-time SSRF guard derived from `policy`.
 */
export function createGuardedTransport(
  policy: SsrfPolicy,
  options: GuardedTransportOptions = {},
): Transport {
  const lookup = options.lookup ?? createGuardedLookup(policy);
  return (request, signal) => sendGuarded(request, signal, lookup);
}

function sendGuarded(
  request: HttpDeliveryRequest,
  signal: AbortSignal,
  lookup: LookupFunction,
): Promise<HttpDeliveryResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (response: HttpDeliveryResponse): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      fail(new Error(`invalid webhook URL: ${request.url}`));
      return;
    }
    const isHttps = url.protocol === "https:";
    if (!isHttps && url.protocol !== "http:") {
      fail(new Error(`unsupported webhook URL protocol "${url.protocol}"`));
      return;
    }
    // URL.hostname keeps an IPv6 literal in brackets; net/dns want the bare address.
    const hostname =
      url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;

    const agent = isHttps ? https : http;
    const req = agent.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: { ...request.headers },
        signal,
        lookup,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Capture Retry-After up front so it survives even if the body drain fails.
        const rawRetryAfter = res.headers["retry-after"];
        const retryAfter = typeof rawRetryAfter === "string" ? rawRetryAfter : null;

        const chunks: Buffer[] = [];
        let buffered = 0;
        res.on("data", (chunk: Buffer) => {
          if (buffered < MAX_BUFFERED_RESPONSE_BYTES) {
            chunks.push(chunk);
            buffered += chunk.length;
          }
          // Past the cap: keep consuming to drain the socket, but stop buffering.
        });
        const finish = (body: string | undefined): void => {
          ok({
            status,
            ...(retryAfter !== null ? { retryAfter } : {}),
            ...(body !== undefined ? { responseBody: body } : {}),
          });
        };
        res.on("end", () => {
          let body: string | undefined;
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            body =
              text.length > MAX_CAPTURED_BODY_BYTES
                ? text.slice(0, MAX_CAPTURED_BODY_BYTES)
                : text;
          } catch {
            // Decode failure — omit the body but keep the status we already have.
          }
          finish(body);
        });
        // A mid-stream body error must not mask the status: settle with the status
        // and no body, matching fetchTransport (whose response.text() reject is caught).
        res.on("error", () => finish(undefined));
      },
    );
    req.on("error", fail);
    req.end(request.body);
  });
}
