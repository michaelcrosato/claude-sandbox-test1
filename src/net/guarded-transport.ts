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
 * ## Two-stage timeout (connect vs. total)
 *
 * The worker carries a single *total* per-attempt deadline as the `signal` (DNS +
 * connect + the receiver's full response). On top of it this transport enforces a
 * shorter, independent **connect deadline** ({@link GuardedTransportOptions.connectTimeoutMs},
 * default {@link DEFAULT_CONNECT_TIMEOUT_MS}) bounding only DNS resolution + TCP
 * connect. A down or unreachable endpoint (dropped SYN, black-holed IP) then *fails
 * fast* on connect rather than burning the whole total budget, while a reachable but
 * slow-to-respond receiver keeps the full total budget once connected — the same
 * split Svix and other senders expose. The connect timer is cleared the moment the
 * socket connects; `0` disables it (total deadline alone governs). The connect-timeout
 * failure carries a distinct `connect timeout after <ms>ms` message, so the audit log
 * tells "endpoint unreachable" apart from "endpoint slow" (an aborted total deadline).
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

/**
 * Default connect deadline (ms): the maximum time for DNS resolution + TCP connect
 * before a delivery fails fast as unreachable. Shorter than the worker's 10 s total
 * deadline so a dead endpoint is detected quickly without consuming the whole budget.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** Construction options for {@link createGuardedTransport}. */
export interface GuardedTransportOptions {
  /**
   * Override the DNS lookup used per request. Defaults to a policy-bound
   * {@link createGuardedLookup}. Tests inject a guarded lookup over a fake resolver
   * so the connect-time decision is exercised deterministically, without real DNS.
   */
  readonly lookup?: LookupFunction;
  /**
   * Connect deadline in ms — bounds DNS resolution + TCP connect only, independently
   * of the total per-attempt deadline carried by the request `signal`. When it
   * elapses *before the socket connects*, the attempt fails with a distinguishable
   * `connect timeout after <ms>ms` error; once connected the timer is cleared and the
   * total deadline governs the response. Defaults to {@link DEFAULT_CONNECT_TIMEOUT_MS};
   * `0` disables the connect deadline (total deadline alone governs). To have any
   * effect it should be ≤ the worker's `requestTimeoutMs`, else the total fires first.
   */
  readonly connectTimeoutMs?: number;
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
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 0) {
    throw new RangeError("connectTimeoutMs must be a non-negative, finite number");
  }
  return (request, signal) => sendGuarded(request, signal, lookup, connectTimeoutMs);
}

function sendGuarded(
  request: HttpDeliveryRequest,
  signal: AbortSignal,
  lookup: LookupFunction,
  connectTimeoutMs: number,
): Promise<HttpDeliveryResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const clearConnectTimer = (): void => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };
    const ok = (response: HttpDeliveryResponse): void => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      resolve(response);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
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

    // Connect deadline: bound DNS + TCP connect on its own, shorter than the total
    // per-attempt deadline carried by `signal`, so an unreachable endpoint fails fast.
    // Cleared the instant the socket connects — a reachable but slow-to-respond
    // receiver then keeps the full total budget. `0` disables it entirely.
    if (connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        // Still not connected when this fires: destroy with a distinguishable error
        // (req 'error' → fail). Distinct from the total deadline's AbortError, so the
        // audit log separates "unreachable" from "slow".
        req.destroy(new Error(`connect timeout after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      req.on("socket", (socket) => {
        // A reused, already-connected socket has nothing left to wait for.
        if (!socket.connecting) {
          clearConnectTimer();
          return;
        }
        // `connect` = TCP established (http + https); `secureConnect` = TLS done.
        // Either means the connect phase is over and the total deadline takes over.
        socket.once("connect", clearConnectTimer);
        socket.once("secureConnect", clearConnectTimer);
      });
    }

    req.end(request.body);
  });
}
