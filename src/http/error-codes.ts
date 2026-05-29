/**
 * The closed set of machine-readable API error codes — the single source of truth
 * for the `code` field of Posthorn's standard `{ error: { code, message } }` envelope.
 *
 * Every non-2xx JSON response (from the route handlers in `api.ts` *and* the
 * `node:http` adapter in `server.ts`) carries one of these stable, lowercase
 * snake_case codes. They are the machine-facing contract an SDK or a generated client
 * branches on — `PosthornApiError.code === "quota_exceeded"` — so, like the delivery
 * {@link import("../delivery/failure-reason.js").DeliveryFailureReason} taxonomy and
 * the `priority`/`status` enums, the set is **pinned to one declaration** rather than
 * re-typed at each emission site.
 *
 * Two mechanisms keep the contract from drifting:
 *  1. **Compile-time closure.** {@link errorEnvelope} (the only constructor of an error
 *     body, used by both `api.ts` and `server.ts`) and the `HttpError` class both type
 *     their `code` as {@link ApiErrorCode}, so a typo or an undeclared code is a
 *     *compile* error — the API can only ever emit a member of this set.
 *  2. **Spec drift guard.** `openapi.ts` builds the `Error.code` schema's `enum`
 *     straight from {@link API_ERROR_CODES}, and a bidirectional test in
 *     `openapi.test.ts` asserts the published enum equals this array — so the OpenAPI
 *     document (and every codegen client derived from it) can never advertise a code
 *     the API does not emit, nor omit one it does. This closes the gap where the spec
 *     listed only a handful of codes as loose `examples` while the API emitted more.
 *
 * The array order is the canonical presentation order (by HTTP status, ascending),
 * mirrored by the OpenAPI enum and the README error-code table.
 */

/**
 * Every API error code, in canonical presentation order (HTTP status ascending).
 * `as const` so the literal members form the {@link ApiErrorCode} union and the
 * OpenAPI enum is sourced verbatim — the array *is* the contract.
 *
 * | code | HTTP | when it is returned |
 * | --- | --- | --- |
 * | `invalid_request` | 400 | Malformed request: a validation failure, a bad query parameter, a missing/non-object JSON body, or an unreadable body. |
 * | `invalid_json` | 400 | The request body was present but is not syntactically valid JSON. |
 * | `url_not_allowed` | 400 | An endpoint URL targets a private/internal address and the SSRF guard rejected it. |
 * | `endpoint_disabled` | 400 | The operation requires an enabled endpoint, but the target endpoint is disabled (e.g. a test-send). |
 * | `unauthorized` | 401 | A missing, malformed, invalid, or revoked credential (a tenant API key, or the admin token on a control-plane route). |
 * | `not_found` | 404 | No such resource for the authenticated tenant, no route for the path, or a feature surface (admin/portal/metrics) that is disabled and therefore hidden. |
 * | `method_not_allowed` | 405 | The path exists but not for the request's HTTP method. |
 * | `conflict` | 409 | A uniqueness/state conflict (e.g. creating an event type that already exists). |
 * | `idempotency_conflict` | 409 | An idempotency key was reused with a different payload. |
 * | `payload_too_large` | 413 | The request body exceeded the configured maximum size. |
 * | `quota_exceeded` | 429 | The tenant's monthly message quota is reached. |
 * | `rate_limited` | 429 | A request-rate limit was exceeded (e.g. the self-serve signup endpoint). A `Retry-After` header gives the back-off in seconds. |
 * | `internal_error` | 500 | An unexpected server-side fault. The only code a client should never need to branch on. |
 */
export const API_ERROR_CODES = [
  "invalid_request",
  "invalid_json",
  "url_not_allowed",
  "endpoint_disabled",
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "conflict",
  "idempotency_conflict",
  "payload_too_large",
  "quota_exceeded",
  "rate_limited",
  "internal_error",
] as const;

/**
 * One stable, machine-readable API error code. The union is derived from
 * {@link API_ERROR_CODES} so the two can never disagree: adding a code to the array
 * widens the type, and there is no way to name a code the array does not contain.
 */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** O(1) membership set backing {@link isApiErrorCode}. */
const API_ERROR_CODE_SET: ReadonlySet<string> = new Set(API_ERROR_CODES);

/**
 * Whether `value` is one of the closed {@link ApiErrorCode} codes. The single guard
 * used wherever an untrusted string crosses into the error-code domain (a parsed
 * response body in a consumer, a hand-edited fixture), so the taxonomy has exactly
 * one source of truth — mirroring `isDeliveryFailureReason`.
 */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && API_ERROR_CODE_SET.has(value);
}

/** The standard error response body: `{ error: { code, message } }`. */
export interface ApiErrorEnvelope {
  readonly error: { readonly code: ApiErrorCode; readonly message: string };
}

/**
 * Build the standard error envelope with a **compile-checked** code. The single
 * constructor of an error body across the HTTP layer (the route handlers and the
 * `node:http` adapter), so every emitted code is, by the type system, a member of
 * {@link API_ERROR_CODES}. A `message` is free human-readable detail.
 */
export function errorEnvelope(code: ApiErrorCode, message: string): ApiErrorEnvelope {
  return { error: { code, message } };
}
