/**
 * Delivery-failure classification — turning a single failed attempt into one stable,
 * operator-meaningful **reason code**.
 *
 * The delivery worker already records each attempt's free-text `error` for the
 * per-message audit log, and the metrics registry already tallies coarse *outcomes*
 * (`succeeded` / `failed` / `dead_lettered` / `stale`). Neither answers the question an
 * operator actually pages on: **why** are deliveries failing — is the endpoint
 * *unreachable* (a dead host, a black-holed IP), merely *slow* (responding past the
 * deadline), refusing the connection, presenting a bad certificate, or just returning
 * 5xx? The transport (see {@link import("../net/guarded-transport.js")}) deliberately
 * fails *unreachable* fast with a distinguishable `connect timeout after <ms>ms` error,
 * separate from the total-deadline `AbortError` a *slow* receiver triggers — but that
 * distinction was, until this classifier, lost the moment the worker flattened the
 * error to a string.
 *
 * This module is the pure, side-effect-free function that recovers it: a fixed,
 * closed set of {@link DeliveryFailureReason} codes and a total
 * {@link classifyDeliveryFailure} that maps the signals of one failed attempt — a
 * transport-level error object, a non-2xx HTTP status, or a pre-flight condition — to
 * exactly one code. It performs **no I/O and reads no clock**, so the entire taxonomy
 * is unit-tested in isolation, and the worker stays thin: it gathers the signals and
 * folds the returned code into the per-tick tally that becomes the
 * `posthorn_delivery_failures_total{reason="…"}` metric.
 *
 * Classification leans on robust, structured evidence — a Node system error's `.code`
 * / `.syscall`, an `AbortError`'s `.name`, the {@link BlockedUrlError} class, and the
 * transport's own one controlled message — rather than brittle substring matching of
 * arbitrary error text, so it stays stable across Node versions.
 */

import { BlockedUrlError } from "../net/ssrf-guard.js";

/**
 * The closed set of delivery-failure reason codes. Stable, lowercase snake_case
 * (safe as a Prometheus label value), and intended to be exhaustive: every failed
 * attempt maps to exactly one, with {@link "other"} as the explicit catch-all so the
 * domain never silently grows. The two timeout codes mirror the worker's two
 * deadlines — `connect_timeout` ↔ `POSTHORN_WORKER_CONNECT_TIMEOUT_MS` (unreachable),
 * `request_timeout` ↔ `POSTHORN_WORKER_REQUEST_TIMEOUT_MS` (slow once connected).
 */
export type DeliveryFailureReason =
  /** DNS + TCP-connect deadline elapsed before the socket connected: endpoint unreachable. */
  | "connect_timeout"
  /** The total per-attempt deadline aborted the request: endpoint connected but responded too slowly. */
  | "request_timeout"
  /** DNS resolution failed (e.g. `ENOTFOUND`, `EAI_AGAIN`) or returned no address. */
  | "dns_failure"
  /** The endpoint actively refused the TCP connection (`ECONNREFUSED`). */
  | "connection_refused"
  /** The connection was reset / broken mid-flight (`ECONNRESET`, `EPIPE`, `ECONNABORTED`). */
  | "connection_reset"
  /** TLS handshake / certificate validation failed (bad, expired, or self-signed cert). */
  | "tls_error"
  /** The destination resolved to a private/internal address and was blocked by the SSRF guard. */
  | "ssrf_blocked"
  /** The receiver returned a 4xx response (client error — often a bad signature or auth on their side). */
  | "http_4xx"
  /** The receiver returned a 5xx response (server error on the receiver). */
  | "http_5xx"
  /** A non-2xx response outside 4xx/5xx (e.g. an unfollowed 3xx redirect, or a 1xx). */
  | "http_other"
  /** No endpoint could be resolved for the task (e.g. the subscription was deleted). */
  | "no_endpoint"
  /** The message's TTL elapsed before it could be delivered; dead-lettered without a send. */
  | "expired"
  /** Anything not covered above (a vanished message, a signing error, an unexpected backend fault). */
  | "other";

/**
 * Every {@link DeliveryFailureReason} in a fixed presentation order, grouped
 * roughly by failure stage (connect → transport → TLS/security → HTTP → pre-flight →
 * catch-all). The metrics renderer iterates this so the
 * `posthorn_delivery_failures_total` series are emitted in a stable order with
 * **every** label present (zeros included), the same convention the other metric
 * families follow.
 */
export const DELIVERY_FAILURE_REASONS: readonly DeliveryFailureReason[] = [
  "connect_timeout",
  "request_timeout",
  "dns_failure",
  "connection_refused",
  "connection_reset",
  "tls_error",
  "ssrf_blocked",
  "http_4xx",
  "http_5xx",
  "http_other",
  "no_endpoint",
  "expired",
  "other",
];

/** O(1) membership set backing {@link isDeliveryFailureReason}. */
const DELIVERY_FAILURE_REASON_SET: ReadonlySet<string> = new Set(DELIVERY_FAILURE_REASONS);

/**
 * Whether `value` is one of the closed {@link DeliveryFailureReason} codes. The
 * single guard used wherever an untrusted string crosses into the reason domain —
 * a `?failureReason=` query value or a hand-edited database row — so the taxonomy
 * has exactly one source of truth and no caller hand-maintains a parallel list.
 */
export function isDeliveryFailureReason(value: unknown): value is DeliveryFailureReason {
  return typeof value === "string" && DELIVERY_FAILURE_REASON_SET.has(value);
}

/** A per-reason count, one entry per {@link DeliveryFailureReason}. */
export type DeliveryFailureReasonCounts = Readonly<Record<DeliveryFailureReason, number>>;

/**
 * A fresh, mutable, all-zero {@link DeliveryFailureReason} tally — every key present.
 * The starting accumulator for a tick's tally and for the metrics registry's
 * lifetime counters; a function (not a shared constant) so callers each own a copy.
 */
export function emptyDeliveryFailureCounts(): Record<DeliveryFailureReason, number> {
  const counts = {} as Record<DeliveryFailureReason, number>;
  for (const reason of DELIVERY_FAILURE_REASONS) {
    counts[reason] = 0;
  }
  return counts;
}

/**
 * The signals of one failed delivery attempt. They are mutually exclusive in
 * practice — a transport-level throw yields no response, an HTTP response yields no
 * throw, and a pre-flight failure yields neither — but {@link classifyDeliveryFailure}
 * applies a defined priority so an over-specified input still classifies deterministically.
 */
export interface DeliveryFailureSignal {
  /**
   * The error thrown by the transport (`#send`), if the failure was transport-level
   * (DNS, connect/total timeout, refused/reset connection, TLS, or an SSRF block).
   * Inspected by structured evidence (`.code`/`.syscall`/`.name`/{@link BlockedUrlError}),
   * not by message text. Absent/`null` when the attempt produced an HTTP response.
   */
  readonly transportError?: unknown;
  /**
   * The non-2xx HTTP status the receiver returned, if a response came back at all.
   * Absent/`null` for a transport-level or pre-flight failure.
   */
  readonly responseStatus?: number | null;
  /**
   * A failure determined *before* any send — no response and no transport error.
   * `expired` (message TTL elapsed), `no_endpoint` (resolver returned nothing), or
   * `other` (a vanished message, a signing/backend fault). Absent/`null` otherwise.
   */
  readonly preflight?: "expired" | "no_endpoint" | "other" | null;
}

/** Map a non-2xx HTTP status to its reason bucket. */
function classifyHttpStatus(status: number): DeliveryFailureReason {
  if (status >= 400 && status < 500) return "http_4xx";
  if (status >= 500 && status < 600) return "http_5xx";
  // Anything else non-2xx: a 1xx, or a 3xx the transport refused to follow.
  return "http_other";
}

/** Read a string `.code` / `.syscall` off a Node system error, if present. */
function stringProp(error: unknown, key: "code" | "syscall"): string | undefined {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** Node/OpenSSL error codes that denote a TLS handshake or certificate failure. */
const TLS_ERROR_CODES = new Set<string>([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Whether `code` denotes a TLS/certificate failure (prefix families + known codes). */
function isTlsErrorCode(code: string): boolean {
  return code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || TLS_ERROR_CODES.has(code);
}

/** Classify a transport-level error object into its reason, by structured evidence. */
function classifyTransportError(error: unknown): DeliveryFailureReason {
  // SSRF guard refusal — the connection-time lookup blocked the resolved IP, or DNS
  // returned no address (surfaced as a BlockedUrlError too, but it is really a DNS miss).
  if (error instanceof BlockedUrlError) {
    return error.reason === "dns_no_address" ? "dns_failure" : "ssrf_blocked";
  }

  const code = stringProp(error, "code");
  const name = error instanceof Error ? error.name : "";

  // The transport's own connect-deadline error (a plain Error with a controlled message):
  // the one place a message check is the right tool, as it carries no code.
  if (error instanceof Error && /^connect timeout after \d+ms$/.test(error.message)) {
    return "connect_timeout";
  }

  // The worker's total per-attempt AbortController fired (fetch → DOMException name
  // "AbortError"; node:http req.signal abort → code "ABORT_ERR"): connected but too slow.
  if (name === "AbortError" || code === "ABORT_ERR") {
    return "request_timeout";
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failure";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") {
    return "connection_reset";
  }
  // A kernel-level timeout (rare — our own timers fire first): connect-phase syscall →
  // unreachable, otherwise treat as a slow/total timeout.
  if (code === "ETIMEDOUT") {
    return stringProp(error, "syscall") === "connect" ? "connect_timeout" : "request_timeout";
  }
  if (code !== undefined && isTlsErrorCode(code)) return "tls_error";

  return "other";
}

/**
 * Classify one failed delivery attempt into exactly one {@link DeliveryFailureReason}.
 * Pure and total. Priority: an HTTP response (we reached the receiver) outranks a
 * transport error, which outranks a pre-flight condition; an empty signal is `other`.
 * Only ever called for a *non-successful* attempt — a 2xx has no reason.
 */
export function classifyDeliveryFailure(signal: DeliveryFailureSignal): DeliveryFailureReason {
  if (signal.responseStatus != null) {
    return classifyHttpStatus(signal.responseStatus);
  }
  if (signal.transportError != null) {
    return classifyTransportError(signal.transportError);
  }
  return signal.preflight ?? "other";
}
