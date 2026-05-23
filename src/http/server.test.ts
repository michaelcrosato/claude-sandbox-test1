import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo, Server } from "node:net";
import { createHttpServer, type HttpServerOptions } from "./server.js";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { MetricsRegistry } from "../metrics/metrics.js";

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
      metrics: new MetricsRegistry({ version: "test" }),
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
