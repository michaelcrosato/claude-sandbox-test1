import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo, Server } from "node:net";
import { createHttpServer, type HttpServerOptions } from "./server.js";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";

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

  it("rejects an over-large body with 413", async () => {
    const { base, secret } = await startServer({ maxBodyBytes: 16 });
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ eventType: "user.created", payload: { lots: "x".repeat(1000) } }),
    });
    expect(res.status).toBe(413);
  });
});
