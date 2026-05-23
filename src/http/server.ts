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

/** Default request-body cap: 1 MiB. Generous for webhook payloads, bounded against abuse. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/** Tunables for the HTTP server. */
export interface HttpServerOptions {
  /** Reject a request body larger than this many bytes with `413`. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number;
  /**
   * When provided, requests whose pathname begins with `/dashboard` are forwarded
   * to this handler instead of the JSON API handler. Omit to disable the dashboard
   * (all `/dashboard/*` paths fall through to the API, which returns `404`).
   */
  readonly dashboardHandler?: ApiHandler;
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

/** Serve one request: read body, dispatch, respond. Never throws to the caller. */
async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  handle: ApiHandler,
  maxBodyBytes: number,
  dashboardHandler: ApiHandler | undefined,
): Promise<void> {
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
        { connection: "close" },
      );
    } else {
      writeResponse(res, {
        status: 400,
        body: { error: { code: "invalid_request", message: "could not read request body" } },
      });
    }
    req.destroy();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  // Route to the dashboard handler when the path starts with /dashboard and a
  // dashboard handler has been configured; otherwise use the JSON API handler.
  const isDashboard =
    dashboardHandler !== undefined &&
    (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/"));
  const activeHandle = isDashboard ? dashboardHandler : handle;
  let response: ApiResponse;
  try {
    response = await activeHandle({
      method: req.method ?? "GET",
      path: url.pathname,
      headers: normalizeHeaders(req.headers),
      query: normalizeQuery(url.searchParams),
      rawBody,
    });
  } catch {
    // createApi already maps known errors; this guards against a defect in the
    // handler itself so a single bad request never crashes the server.
    response = {
      status: 500,
      body: { error: { code: "internal_error", message: "internal server error" } },
    };
  }
  writeResponse(res, response);
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
  const { dashboardHandler } = options;
  return createServer((req, res) => {
    void serve(req, res, handle, maxBodyBytes, dashboardHandler);
  });
}
