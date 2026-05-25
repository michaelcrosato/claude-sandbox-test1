/**
 * The `node:http` adapter — the thin I/O edge that binds the pure {@link createApi}
 * handler to a real socket.
 *
 * It does only what a transport must: read the request body (with a hard size cap),
 * normalize the request into an {@link ApiRequest}, hand it to the handler, and
 * write the {@link ApiResponse} back as JSON. All routing, auth, and domain logic
 * lives in `api.ts`; all decisions there are pure and tested without a port. This
 * mirrors the delivery worker, whose decisions are pure and whose only socket I/O
 * is the injectable `fetchTransport`. Built on Node's **built-in** `node:http`, so
 * the service adds zero runtime dependencies — the same zero-dependency wedge as
 * the `node:sqlite` storage and `node:crypto` signing.
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createApi, type ApiDeps, type ApiHandler, type ApiResponse } from "./api.js";
import { isRequestSecure, securityHeadersForPath } from "./security-headers.js";
import { SILENT_LOGGER, type Logger } from "../logging/logger.js";

/** Default request-body cap: 1 MiB. Generous for webhook payloads, bounded against abuse. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/**
 * Default keep-alive socket timeout (ms): how long an idle persistent connection is
 * held open between requests before the server closes it. Matches Node's own default
 * (`5_000`), so the out-of-the-box behavior is unchanged; the value is made explicit
 * and tunable here for **one** load-balancer correctness reason. A reverse proxy / LB
 * pools upstream connections and may reuse a socket the very instant the gateway has
 * decided to close it (the classic race that surfaces as sporadic upstream `502`s). The
 * fix is to set this *above* the LB's own idle timeout (AWS ALB 60 s, nginx 75 s, …) —
 * see `docs/DEPLOY.md`. `0` disables the timeout (sockets stay open until the client or
 * an OS-level timeout closes them).
 */
export const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;

/**
 * Default headers timeout (ms): the deadline from connection-open to the *complete*
 * request headers being received. Bounds a slow-headers (Slowloris) client that dribbles
 * header bytes to pin a connection open indefinitely. Matches Node's default (`60_000`);
 * explicit + tunable here so it can be coordinated with the keep-alive and request
 * timeouts. Must be `<= ` {@link DEFAULT_HTTP_REQUEST_TIMEOUT_MS} (the loader enforces
 * the analogous relation on the configured values). `0` disables it.
 */
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 60_000;

/**
 * Default request timeout (ms): the deadline from connection-open to the *entire*
 * request (headers **and** body) being received; the server answers `408` and closes
 * the socket past it. Bounds a slow-body client that trickles the payload to hold a
 * connection — the body twin of the headers Slowloris — independently of the
 * {@link DEFAULT_MAX_BODY_BYTES} size cap (a within-cap body sent one byte at a time
 * still hits this). Matches Node's default (`300_000`, i.e. 5 min); explicit + tunable
 * so a webhook-ingest deployment can tighten it (a normal POST completes in well under a
 * second). `0` disables it.
 */
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 300_000;

/** Tunables for the HTTP server. */
export interface HttpServerOptions {
  /** Reject a request body larger than this many bytes with `413`. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number;
  /**
   * Idle keep-alive socket timeout in ms (`server.keepAliveTimeout`). Defaults to
   * {@link DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS}. Raise above the upstream LB's idle
   * timeout to avoid the connection-reuse race; `0` disables it.
   */
  readonly keepAliveTimeoutMs?: number;
  /**
   * Complete-headers deadline in ms (`server.headersTimeout`), bounding a slow-headers
   * Slowloris. Defaults to {@link DEFAULT_HTTP_HEADERS_TIMEOUT_MS}; `0` disables it.
   */
  readonly headersTimeoutMs?: number;
  /**
   * Whole-request (headers + body) deadline in ms (`server.requestTimeout`), bounding a
   * slow-body Slowloris. Defaults to {@link DEFAULT_HTTP_REQUEST_TIMEOUT_MS}; `0` disables it.
   */
  readonly requestTimeoutMs?: number;
  /**
   * When provided, requests whose pathname begins with `/dashboard` (but not
   * `/dashboard/tenant`) are forwarded to this handler. Omit to disable the admin
   * dashboard (all `/dashboard/*` paths except the tenant sub-tree fall through to
   * the API, which returns `404`).
   */
  readonly dashboardHandler?: ApiHandler;
  /**
   * When provided, requests whose pathname begins with `/dashboard/tenant` are
   * forwarded to this handler. Omit to disable the tenant dashboard (those paths
   * return `404`).
   */
  readonly tenantDashboardHandler?: ApiHandler;
  /**
   * When provided, requests whose pathname begins with `/portal` are forwarded
   * to this handler. Omit to disable the consumer portal (those paths return
   * `404`). The portal is always enabled when the gateway creates it.
   */
  readonly portalHandler?: ApiHandler;
  /**
   * Structured logger for request access lines and unhandled-error reporting.
   * Defaults to {@link SILENT_LOGGER} (no output), so a caller that does not opt
   * into logging — or an existing test — sees no behavior change. The gateway
   * passes a level-configured logger bound to `component: "http"`.
   */
  readonly logger?: Logger;
  /**
   * Precomputed `Strict-Transport-Security` header value (see
   * {@link import("./security-headers.js").hstsHeaderValue}). When set, it is
   * stamped — across every surface — on each response the adapter identifies as
   * HTTPS (a direct TLS socket, or `X-Forwarded-Proto: https` from the upstream
   * proxy; see {@link import("./security-headers.js").isRequestSecure}). Omit to
   * emit no HSTS header — the default, since HSTS is only safe over HTTPS.
   */
  readonly strictTransportSecurity?: string;
}

/** Signals that a request body exceeded the configured cap. */
class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read the full request body as a UTF-8 string, rejecting with
 * {@link BodyTooLargeError} as soon as the byte cap is exceeded (rather than
 * buffering an unbounded amount first).
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
  });
}

/**
 * Whether the request arrived on a TLS socket. `tls.TLSSocket` exposes
 * `encrypted: true`; a plain `net.Socket` has no such field. This service usually
 * sits behind a TLS-terminating proxy (so this is `false` and `X-Forwarded-Proto`
 * decides), but a direct-HTTPS deployment reports `true`.
 */
function isEncryptedSocket(req: IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

/** Collapse Node's `string | string[]` header values to a single string per key (keys are already lower-cased). */
function normalizeHeaders(
  raw: IncomingHttpHeaders,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Flatten a URL's query string to a single value per key (first wins for repeats). */
function normalizeQuery(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!(key in out)) {
      out[key] = value;
    }
  }
  return out;
}

/** Write an {@link ApiResponse} (and any extra `close` headers) to the socket. */
function writeResponse(
  res: ServerResponse,
  response: ApiResponse,
  extraHeaders?: Record<string, string>,
): void {
  const hasBody = response.body !== undefined;
  // A `contentType` opts out of JSON encoding: `body` is an already-serialized
  // string written verbatim (e.g. the Prometheus text at /metrics). Otherwise the
  // body is JSON-encoded as application/json — the shape every other route uses.
  const isRaw = response.contentType !== undefined;
  const payload = hasBody ? (isRaw ? String(response.body) : JSON.stringify(response.body)) : "";
  const headers: Record<string, string> = {
    ...(response.headers ?? {}),
    ...(extraHeaders ?? {}),
    "content-length": String(Buffer.byteLength(payload)),
  };
  if (hasBody) {
    headers["content-type"] = isRaw
      ? response.contentType!
      : "application/json; charset=utf-8";
  }
  res.writeHead(response.status, headers);
  res.end(payload);
}

/**
 * Emit one structured access line for a finished request. Health/readiness/metrics
 * probes are logged at `debug` (kept out of the default `info` stream — no scrape/
 * health-check spam, even at a k8s readiness probe's ~10s cadence); a `5xx` is logged
 * at `error` — which includes a `/readyz` `503`, so a not-ready replica is visible at
 * the default level even though a ready `200` stays quiet. Carries only method,
 * pathname, status, and latency — never headers, body, or query string — so the
 * access log can never leak a secret.
 */
function logAccess(
  logger: Logger,
  method: string,
  path: string,
  status: number,
  startedAt: number,
): void {
  const fields = { method, path, status, durationMs: Date.now() - startedAt };
  if (status >= 500) {
    logger.error("request", fields);
  } else if (path === "/healthz" || path === "/readyz" || path === "/metrics") {
    logger.debug("request", fields);
  } else {
    logger.info("request", fields);
  }
}

/** Serve one request: read body, dispatch, respond. Never throws to the caller. */
async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  handle: ApiHandler,
  maxBodyBytes: number,
  dashboardHandler: ApiHandler | undefined,
  tenantDashboardHandler: ApiHandler | undefined,
  portalHandler: ApiHandler | undefined,
  logger: Logger,
  strictTransportSecurity: string | undefined,
): Promise<void> {
  const startedAt = Date.now();
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  // HSTS is a transport assertion about the whole origin, so emit it only on a
  // request we identify as HTTPS — a direct TLS socket, or `X-Forwarded-Proto:
  // https` from the TLS-terminating proxy (the same signal the portal-URL builder
  // trusts). On a plain-HTTP request it is suppressed: a browser ignores an HSTS
  // header received over HTTP anyway (RFC 6797 §8.1) and emitting one is only a
  // needless security-scanner finding. `undefined` whenever HSTS is unconfigured.
  const xForwardedProto = req.headers["x-forwarded-proto"];
  const hsts =
    strictTransportSecurity !== undefined &&
    isRequestSecure({
      encrypted: isEncryptedSocket(req),
      forwardedProto: Array.isArray(xForwardedProto) ? xForwardedProto[0] : xForwardedProto,
    })
      ? strictTransportSecurity
      : undefined;
  // Defense-in-depth response headers, keyed purely off the URL surface (API vs
  // dashboard vs the embeddable portal). Computed once here so every exit path
  // below — including the early body-read failures — stamps them. HSTS (gated
  // above) rides on top of every surface when present.
  const securityHeaders = securityHeadersForPath(path, hsts);

  let rawBody: string;
  try {
    rawBody = await readBody(req, maxBodyBytes);
  } catch (err) {
    // On overflow, answer 413 and close the connection rather than draining an
    // attacker-controlled stream; any other read error is a malformed request.
    if (err instanceof BodyTooLargeError) {
      writeResponse(
        res,
        {
          status: 413,
          body: {
            error: {
              code: "payload_too_large",
              message: `request body exceeds ${maxBodyBytes} bytes`,
            },
          },
        },
        { ...securityHeaders, connection: "close" },
      );
      logAccess(logger, method, path, 413, startedAt);
    } else {
      writeResponse(
        res,
        {
          status: 400,
          body: { error: { code: "invalid_request", message: "could not read request body" } },
        },
        securityHeaders,
      );
      logAccess(logger, method, path, 400, startedAt);
    }
    req.destroy();
    return;
  }

  // Route: tenant dashboard takes priority over admin dashboard (its prefix is longer).
  const isTenantDashboard =
    tenantDashboardHandler !== undefined &&
    (path === "/dashboard/tenant" || path.startsWith("/dashboard/tenant/"));
  const isAdminDashboard =
    !isTenantDashboard &&
    dashboardHandler !== undefined &&
    (path === "/dashboard" || path.startsWith("/dashboard/"));
  const isPortal =
    portalHandler !== undefined &&
    (path === "/portal" || path.startsWith("/portal/"));
  const activeHandle = isTenantDashboard
    ? tenantDashboardHandler
    : isAdminDashboard
      ? dashboardHandler
      : isPortal
        ? portalHandler
        : handle;
  let response: ApiResponse;
  try {
    response = await activeHandle({
      method,
      path,
      headers: normalizeHeaders(req.headers),
      query: normalizeQuery(url.searchParams),
      rawBody,
    });
  } catch (err) {
    // createApi already maps known errors; this guards against a defect in the
    // handler itself so a single bad request never crashes the server. Logging the
    // cause here is the difference between a debuggable 500 and a silent black hole.
    logger.error("unhandled request error", { method, path, err });
    response = {
      status: 500,
      body: { error: { code: "internal_error", message: "internal server error" } },
    };
  }
  writeResponse(res, response, securityHeaders);
  logAccess(logger, method, path, response.status, startedAt);
}

/**
 * Create an HTTP {@link Server} for a Posthorn service. The returned server is not
 * yet listening — call `.listen(port)` (use port `0` in tests for an ephemeral
 * port) and `.close()` to stop it. Zero runtime dependencies: it is `node:http`
 * over the pure {@link createApi} handler.
 */
export function createHttpServer(deps: ApiDeps, options: HttpServerOptions = {}): Server {
  const handle = createApi(deps);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const { dashboardHandler, tenantDashboardHandler, portalHandler } = options;
  const logger = options.logger ?? SILENT_LOGGER;
  const { strictTransportSecurity } = options;
  const server = createServer((req, res) => {
    void serve(
      req,
      res,
      handle,
      maxBodyBytes,
      dashboardHandler,
      tenantDashboardHandler,
      portalHandler,
      logger,
      strictTransportSecurity,
    );
  });
  // Make the socket-lifetime timeouts explicit and tunable rather than implicitly
  // inheriting Node's defaults: keeps the Slowloris bounds (headers/request) under
  // operator control and exposes `keepAliveTimeout` so it can be lifted above an
  // upstream LB's idle timeout (the connection-reuse `502` race). Defaults equal
  // Node's own, so an un-tuned deployment behaves exactly as before.
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = options.headersTimeoutMs ?? DEFAULT_HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = options.requestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  return server;
}
