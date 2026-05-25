/**
 * Shared transport core for the Posthorn SDK clients.
 *
 * Both the tenant client ({@link import("./client.js").PosthornClient}) and the
 * admin/control-plane client ({@link import("./admin-client.js").PosthornAdminClient})
 * speak the *same* v1 HTTP envelope — `Authorization: Bearer <secret>`, JSON request
 * bodies, a `{ error: { code, message } }` failure shape, and a per-request timeout —
 * differing only in *which* secret authenticates (a tenant API key vs. the operator
 * admin token) and *which* routes they call. This module is that common envelope: the
 * `fetch` contract, the error model, and the one {@link HttpTransport.request} mechanic
 * both clients delegate to. Keeping it in one place means a fix to timeout handling or
 * error mapping lands once and the two clients can never drift — the same
 * one-shared-rule discipline the storage backends get from their conformance suites.
 *
 * The error classes and fetch types are re-exported from `./client.js` so the public
 * import paths (`from "posthorn"` / the package barrel) stay stable.
 */

import type { ApiErrorCode } from "../http/error-codes.js";

/** Default per-request timeout (ms). Override per client via its `timeoutMs` option. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The minimal `fetch` contract the SDK depends on — a structural subset of the
 * platform `fetch` so the global satisfies it, while remaining trivial to fake in
 * tests. The clients only ever issue string URLs with an explicit init.
 */
export type PosthornFetch = (
  url: string,
  init: PosthornRequestInit,
) => Promise<PosthornResponse>;

/** The request shape a client passes to {@link PosthornFetch}. */
export interface PosthornRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** The minimal response shape a client reads back from {@link PosthornFetch}. */
export interface PosthornResponse {
  readonly status: number;
  text(): Promise<string>;
}

/** Base class for every error the SDK throws, for a single `instanceof` check. */
export class PosthornError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PosthornError";
  }
}

/**
 * Thrown when the gateway returns a non-2xx response. Carries the HTTP `status`
 * and the machine-readable `code` from the API's `{ error: { code, message } }`
 * envelope (falling back to `http_<status>` when the body is not that envelope).
 *
 * `code` is typed as {@link ApiErrorCode} (the server's closed set) widened with
 * `(string & {})`: a consumer's `switch (err.code)` gets autocomplete and exhaustiveness
 * hints on the known codes, while the type still accepts the `http_<status>` fallback —
 * and a non-conforming gateway response — so it never lies about the value being closed.
 */
export class PosthornApiError extends PosthornError {
  readonly status: number;
  readonly code: ApiErrorCode | (string & {});
  constructor(status: number, code: ApiErrorCode | (string & {}), message: string) {
    super(message);
    this.name = "PosthornApiError";
    this.status = status;
    this.code = code;
  }
}

/** Thrown when a request exceeds the client's configured `timeoutMs`. */
export class PosthornTimeoutError extends PosthornError {
  constructor(message: string) {
    super(message);
    this.name = "PosthornTimeoutError";
  }
}

/** Default `fetch`, bound to the platform global, adapting it to {@link PosthornFetch}. */
const defaultFetch: PosthornFetch = (url, init) => fetch(url, init);

/**
 * Construction inputs for an {@link HttpTransport}. All values are already validated
 * by the owning client's constructor (which throws `TypeError` with a client-specific
 * message on bad input) — the transport is internal and trusts them, doing only the
 * mechanical normalization (trailing-slash strip, default `fetch`).
 */
export interface HttpTransportOptions {
  /** Base URL of the gateway. A trailing slash is tolerated and stripped. */
  readonly baseUrl: string;
  /** The secret sent as `Authorization: Bearer <bearerToken>` on every request. */
  readonly bearerToken: string;
  /** Per-request timeout in ms; `0` disables it. A timeout rejects with {@link PosthornTimeoutError}. */
  readonly timeoutMs: number;
  /** Custom `fetch` (tests / a runtime without a global `fetch`). Defaults to the platform `fetch`. */
  readonly fetch?: PosthornFetch;
}

/**
 * The shared HTTP request mechanic. Holds a base URL, a bearer secret, a timeout, and
 * a `fetch`, and issues one request at a time via {@link request}: build headers, apply
 * the timeout via an `AbortController`, dispatch, then map the response — JSON-parse a
 * 2xx body (or `undefined` for an empty/`204`), and turn a non-2xx into a
 * {@link PosthornApiError}. Stateless per request; construct once per client and reuse.
 */
export class HttpTransport {
  readonly #baseUrl: string;
  readonly #bearerToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: PosthornFetch;

  constructor(options: HttpTransportOptions) {
    // Strip trailing slashes so `${base}${path}` never doubles a separator.
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#bearerToken = options.bearerToken;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? defaultFetch;
  }

  /**
   * Issue one request: build headers, apply the timeout, dispatch via the injected
   * `fetch`, then map the response — JSON-parse a 2xx body (or `undefined` for an
   * empty/`204`), and turn a non-2xx into a {@link PosthornApiError}.
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#bearerToken}`,
      accept: "application/json",
    };
    const init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    } = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const controller = this.#timeoutMs > 0 ? new AbortController() : null;
    const timer =
      controller !== null
        ? setTimeout(() => controller.abort(), this.#timeoutMs)
        : null;
    if (controller !== null) {
      init.signal = controller.signal;
    }

    let res: PosthornResponse;
    try {
      res = await this.#fetch(this.#baseUrl + path, init);
    } catch (err) {
      if (controller?.signal.aborted === true) {
        throw new PosthornTimeoutError(
          `request ${method} ${path} timed out after ${this.#timeoutMs}ms`,
        );
      }
      throw new PosthornError(
        `network error issuing ${method} ${path}: ${errorMessage(err)}`,
        { cause: err },
      );
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }

    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      if (res.status === 204 || text.length === 0) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new PosthornError(
          `failed to parse ${method} ${path} response as JSON: ${errorMessage(err)}`,
          { cause: err },
        );
      }
    }
    throw toApiError(res.status, text);
  }
}

/** Best-effort message extraction from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a non-2xx response into a {@link PosthornApiError}, reading the standard envelope. */
function toApiError(status: number, text: string): PosthornApiError {
  let code = `http_${status}`;
  let message = text.length > 0 ? text : `request failed with status ${status}`;
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
        const error = (parsed as { error: unknown }).error;
        if (error !== null && typeof error === "object") {
          const e = error as { code?: unknown; message?: unknown };
          if (typeof e.code === "string") code = e.code;
          if (typeof e.message === "string") message = e.message;
        }
      }
    } catch {
      // Not the JSON envelope (e.g. a proxy's HTML 502); keep the fallbacks.
    }
  }
  return new PosthornApiError(status, code, message);
}
