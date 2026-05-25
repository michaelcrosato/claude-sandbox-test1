import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo, Server } from "node:net";
import { createHttpServer, type HttpServerOptions } from "./server.js";
import type { ApiHandler } from "./api.js";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { InMemoryDeliveryAttemptStore } from "../attempts/in-memory-attempt-store.js";
import { MetricsRegistry } from "../metrics/metrics.js";
import { InMemoryEventTypeStore } from "../event-types/in-memory-event-type-store.js";
import { createLogger, type LogEntry } from "../logging/logger.js";

// Track started servers so each test tears its listener down (no leaked ports).
let started: Server[] = [];

afterEach(async () => {
  await Promise.all(
    started.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  started = [];
});

/** Start a real `node:http` server on an ephemeral port; return its base URL + a key. */
async function startServer(
  options?: HttpServerOptions,
): Promise<{ base: string; secret: string }> {
  const apps = new InMemoryAppStore();
  const app = await apps.create({ name: "Acme" });
  const { secret } = await apps.createApiKey(app.id);
  const server = createHttpServer(
    {
      apps,
      endpoints: new InMemoryEndpointStore(),
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      metrics: new MetricsRegistry({ version: "test" }),
      eventTypes: new InMemoryEventTypeStore(),
    },
    options,
  );
  started.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return { base: `http://127.0.0.1:${port}`, secret };
}

describe("createHttpServer (node:http adapter)", () => {
  it("serves the health check over a real socket", async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 401 without an Authorization header", async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/v1/endpoints`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("round-trips an authenticated create + ingest end-to-end", async () => {
    const { base, secret } = await startServer();
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    };

    const createRes = await fetch(`${base}/v1/endpoints`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://acme.example/hook", eventTypes: ["user.created"] }),
    });
    expect(createRes.status).toBe(201);

    const ingestRes = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ eventType: "user.created", payload: { id: 1 } }),
    });
    expect(ingestRes.status).toBe(202);
    const ingested = (await ingestRes.json()) as { fanout: { matched: number } };
    expect(ingested.fanout.matched).toBe(1);
  });

  it("returns 404 for an unknown route", async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("serves /metrics as raw Prometheus text (not JSON-encoded) over a real socket", async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    // The adapter must write the body verbatim with the Prometheus content type,
    // not wrap it as application/json — proving the raw-body (contentType) path.
    expect(res.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
    const text = await res.text();
    expect(text.startsWith("# HELP posthorn_build_info")).toBe(true);
    expect(text).toContain('posthorn_build_info{version="test"} 1');
  });

  it("serves the OpenAPI document unauthenticated as JSON over a real socket", async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/messages"]).toBeDefined();
  });

  it("rejects an over-large body with 413", async () => {
    const { base, secret } = await startServer({ maxBodyBytes: 16 });
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ eventType: "user.created", payload: { lots: "x".repeat(1000) } }),
    });
    expect(res.status).toBe(413);
  });

  it("parses the query string so list pagination works over a real socket", async () => {
    const { base, secret } = await startServer();
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    };
    for (let i = 0; i < 2; i += 1) {
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ eventType: "e", payload: { i } }),
      });
    }

    const first = await fetch(`${base}/v1/messages?limit=1`, { headers });
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      data: { id: string }[];
      nextCursor: string | null;
    };
    expect(page1.data).toHaveLength(1); // ?limit=1 reached the handler
    expect(page1.nextCursor).not.toBeNull();

    const second = await fetch(
      `${base}/v1/messages?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      { headers },
    );
    const page2 = (await second.json()) as { data: { id: string }[] };
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id); // distinct page

    // A bad ?limit= surfaces as a 400 through the adapter.
    const bad = await fetch(`${base}/v1/messages?limit=999`, { headers });
    expect(bad.status).toBe(400);
  });
});

describe("createHttpServer — structured request logging", () => {
  /**
   * Start a server with a collecting logger at `level`, plus any extra options
   * (e.g. a throwing dashboard handler). Returns the captured entries array.
   */
  async function startWithLogger(
    level: "debug" | "info",
    extra: Partial<HttpServerOptions> = {},
  ): Promise<{ base: string; entries: LogEntry[] }> {
    const entries: LogEntry[] = [];
    const logger = createLogger({ level, sink: (e) => entries.push(e) });
    const server = createHttpServer(
      {
        apps: new InMemoryAppStore(),
        endpoints: new InMemoryEndpointStore(),
        messages: new InMemoryMessageStore(),
        queue: new InMemoryDeliveryQueue(),
        attempts: new InMemoryDeliveryAttemptStore(),
        metrics: new MetricsRegistry({ version: "test" }),
        eventTypes: new InMemoryEventTypeStore(),
      },
      { logger, ...extra },
    );
    started.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    return { base: `http://127.0.0.1:${port}`, entries };
  }

  const access = (entries: LogEntry[]): LogEntry[] => entries.filter((e) => e.msg === "request");

  it("logs an info access line for an API request (method, path, status, duration)", async () => {
    const { base, entries } = await startWithLogger("info");
    // Unauthenticated → 401; non-probe, <500 ⇒ info access line.
    const res = await fetch(`${base}/v1/messages`);
    expect(res.status).toBe(401);

    const lines = access(entries);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.fields).toMatchObject({
      method: "GET",
      path: "/v1/messages",
      status: 401,
    });
    expect(typeof lines[0]!.fields.durationMs).toBe("number");
    expect(lines[0]!.fields.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it("logs probe traffic (/healthz, /metrics) at debug — silent at the info default", async () => {
    const info = await startWithLogger("info");
    await fetch(`${info.base}/healthz`);
    await fetch(`${info.base}/metrics`);
    expect(access(info.entries)).toHaveLength(0); // debug suppressed at info

    const debug = await startWithLogger("debug");
    await fetch(`${debug.base}/healthz`);
    const lines = access(debug.entries);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("debug");
    expect(lines[0]!.fields).toMatchObject({ path: "/healthz", status: 200 });
  });

  it("does not leak the query string, headers, or body into the access line", async () => {
    const { base, entries } = await startWithLogger("info");
    await fetch(`${base}/v1/messages?cursor=secret-cursor`, {
      headers: { authorization: "Bearer super-secret-key" },
    });
    const line = access(entries)[0]!;
    expect(line.fields.path).toBe("/v1/messages"); // pathname only, no ?cursor=
    const serialized = JSON.stringify(line.fields);
    expect(serialized).not.toContain("super-secret-key");
    expect(serialized).not.toContain("secret-cursor");
  });

  it("logs the cause of an unhandled handler error AND answers 500 (no silent swallow)", async () => {
    const boom: ApiHandler = () => {
      throw new TypeError("handler defect");
    };
    const { base, entries } = await startWithLogger("info", { dashboardHandler: boom });
    const res = await fetch(`${base}/dashboard/anything`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "internal_error", message: "internal server error" },
    });

    const errorLine = entries.find((e) => e.msg === "unhandled request error");
    expect(errorLine).toBeDefined();
    expect(errorLine!.level).toBe("error");
    expect(errorLine!.fields).toMatchObject({ method: "GET", path: "/dashboard/anything" });
    const err = errorLine!.fields.err as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("handler defect");

    // The access line for the 500 is emitted at error level too.
    const accessLine = access(entries)[0]!;
    expect(accessLine.level).toBe("error");
    expect(accessLine.fields.status).toBe(500);
  });

  it("logs an access line for a 413 body-overflow rejection", async () => {
    const { base, entries } = await startWithLogger("info", { maxBodyBytes: 8 });
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: "x".repeat(64),
    });
    expect(res.status).toBe(413);
    const line = access(entries)[0]!;
    expect(line.fields).toMatchObject({ method: "POST", path: "/v1/messages", status: 413 });
  });
});

describe("createHttpServer — security response headers", () => {
  // A minimal HTML handler standing in for the dashboard/portal, so the adapter's
  // per-surface header stamping can be exercised over a real socket.
  const htmlOk: ApiHandler = async () => ({
    status: 200,
    body: "<!doctype html><title>ok</title>",
    contentType: "text/html; charset=utf-8",
  });

  it("stamps nosniff + no-referrer on a plain API response, with no CSP/framing", async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // JSON/text carries no markup — no Content-Security-Policy, no frame controls.
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBeNull();
    // Public health/openapi/docs share this surface — leave it cacheable.
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("locks the dashboard down, forbids framing, and forbids caching", async () => {
    const { base } = await startServer({ dashboardHandler: htmlOk });
    const res = await fetch(`${base}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("locks the portal's resources down, forbids caching, but leaves it embeddable", async () => {
    const { base } = await startServer({ portalHandler: htmlOk });
    const res = await fetch(`${base}/portal`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    // Embeddability is the portal's whole point — it must NOT block framing.
    expect(csp).not.toContain("frame-ancestors");
    expect(res.headers.get("x-frame-options")).toBeNull();
    // …but the tenant-scoped portal markup still must not be cached.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("classifies by URL space even when the dashboard handler is disabled (404 still anti-framed)", async () => {
    const { base } = await startServer(); // no dashboardHandler wired
    const res = await fetch(`${base}/dashboard/apps`);
    expect(res.status).toBe(404); // falls through to the API handler
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("emits no Strict-Transport-Security header by default", async () => {
    const { base } = await startServer({ dashboardHandler: htmlOk });
    const api = await fetch(`${base}/healthz`);
    const dash = await fetch(`${base}/dashboard`);
    expect(api.headers.get("strict-transport-security")).toBeNull();
    expect(dash.headers.get("strict-transport-security")).toBeNull();
  });

  it("emits the configured HSTS only on requests identified as HTTPS (X-Forwarded-Proto)", async () => {
    const sts = "max-age=31536000; includeSubDomains";
    const { base } = await startServer({
      dashboardHandler: htmlOk,
      portalHandler: htmlOk,
      strictTransportSecurity: sts,
    });
    // Plain HTTP with no proxy signal: HSTS is suppressed even though configured
    // (a browser would ignore an HSTS header received over HTTP anyway).
    for (const path of ["/healthz", "/dashboard", "/portal"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get("strict-transport-security")).toBeNull();
    }
    // X-Forwarded-Proto: https (from the TLS-terminating proxy) → stamped on every
    // surface, transport-level (present on the plain API surface as well as the HTML ones).
    for (const path of ["/healthz", "/dashboard", "/portal"]) {
      const res = await fetch(`${base}${path}`, {
        headers: { "x-forwarded-proto": "https" },
      });
      expect(res.headers.get("strict-transport-security")).toBe(sts);
    }
    // An explicit X-Forwarded-Proto: http stays suppressed.
    const httpRes = await fetch(`${base}/healthz`, {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(httpRes.headers.get("strict-transport-security")).toBeNull();
  });

  it("stamps the headers on an early body-overflow (413) rejection too", async () => {
    const { base, secret } = await startServer({ maxBodyBytes: 8 });
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: "x".repeat(64),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("connection")).toBe("close"); // preserved alongside
  });
});
