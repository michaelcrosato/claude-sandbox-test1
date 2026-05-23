import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";

import { createHttpServer } from "../http/server.js";
import { createGateway, type Gateway } from "../runtime/gateway.js";
import { loadConfig } from "../runtime/config.js";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import {
  PosthornApiError,
  PosthornClient,
  PosthornError,
  PosthornTimeoutError,
  type PosthornFetch,
  type PosthornResponse,
} from "./client.js";
import { verifyWebhook } from "./verify.js";

// Track resources so each test tears its listeners / gateways down cleanly.
const servers: Server[] = [];
const gateways: Gateway[] = [];
const receivers: Receiver[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((done) => s.close(() => done()))),
  );
  await Promise.all(gateways.map((g) => g.stop()));
  await Promise.all(receivers.map((r) => r.close()));
  servers.length = 0;
  gateways.length = 0;
  receivers.length = 0;
});

/** Listen on an ephemeral loopback port; resolve the assigned port. */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

interface Harness {
  readonly client: PosthornClient;
  readonly base: string;
  readonly apiKey: string;
}

/** A real `node:http` Posthorn server backed by in-memory stores, plus a client. */
async function startServer(): Promise<Harness> {
  const apps = new InMemoryAppStore();
  const app = await apps.create({ name: "Acme" });
  const { secret: apiKey } = await apps.createApiKey(app.id);
  const server = createHttpServer({
    apps,
    endpoints: new InMemoryEndpointStore(),
    messages: new InMemoryMessageStore(),
    queue: new InMemoryDeliveryQueue(),
  });
  servers.push(server);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  return { client: new PosthornClient({ baseUrl: base, apiKey }), base, apiKey };
}

/** Build a client over an injected fake `fetch` (no real socket). */
function fakeClient(fetchImpl: PosthornFetch, timeoutMs?: number): PosthornClient {
  return new PosthornClient({
    baseUrl: "http://example.test",
    apiKey: "phk_test_key",
    fetch: fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/** A fake `PosthornResponse` with a fixed status + body text. */
function fakeResponse(status: number, body: string): PosthornResponse {
  return { status, text: () => Promise.resolve(body) };
}

interface ReceivedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface Receiver {
  readonly url: string;
  readonly received: Promise<ReceivedRequest>;
  close(): Promise<void>;
}

/** A real webhook receiver on an ephemeral port that captures one delivery. */
function startReceiver(): Promise<Receiver> {
  let resolveReceived!: (req: ReceivedRequest) => void;
  const received = new Promise<ReceivedRequest>((resolve) => {
    resolveReceived = resolve;
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolveReceived({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function memoryConfig() {
  return loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_WORKER_IDLE_POLL_MS: "5",
  });
}

describe("PosthornClient (against the in-process HTTP server)", () => {
  it("reports health", async () => {
    const { client } = await startServer();
    expect(await client.health()).toEqual({ status: "ok" });
  });

  it("creates an endpoint, returning the signing secret exactly once", async () => {
    const { client } = await startServer();
    const created = await client.createEndpoint({
      url: "https://acme.example/hook",
      eventTypes: ["user.created"],
      description: "primary",
    });
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.url).toBe("https://acme.example/hook");
    expect(created.eventTypes).toEqual(["user.created"]);
    expect(created.description).toBe("primary");
    expect(created.disabled).toBe(false);
  });

  it("lists endpoints without ever exposing the secret", async () => {
    const { client } = await startServer();
    const created = await client.createEndpoint({ url: "https://acme.example/hook" });
    const list = await client.listEndpoints();
    expect(list.map((e) => e.id)).toContain(created.id);
    for (const ep of list) {
      expect(ep).not.toHaveProperty("secret");
    }
  });

  it("gets an endpoint (no secret) and updates it", async () => {
    const { client } = await startServer();
    const created = await client.createEndpoint({ url: "https://acme.example/hook" });

    const fetched = await client.getEndpoint(created.id);
    expect(fetched).not.toHaveProperty("secret");
    expect(fetched.id).toBe(created.id);

    const updated = await client.updateEndpoint(created.id, {
      description: "renamed",
      disabled: true,
    });
    expect(updated.description).toBe("renamed");
    expect(updated.disabled).toBe(true);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("deletes an endpoint, after which it is 404", async () => {
    const { client } = await startServer();
    const created = await client.createEndpoint({ url: "https://acme.example/hook" });
    await expect(client.deleteEndpoint(created.id)).resolves.toBeUndefined();

    const err = await client.getEndpoint(created.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(404);
    expect((err as PosthornApiError).code).toBe("not_found");
  });

  it("sends a message, fans it out, and reads back its delivery status", async () => {
    const { client } = await startServer();
    const endpoint = await client.createEndpoint({
      url: "https://acme.example/hook",
      eventTypes: ["user.created"],
    });

    const payload = { id: 1, email: "a@b.test" };
    const sent = await client.sendMessage({ eventType: "user.created", payload });
    expect(sent.deduplicated).toBe(false);
    expect(sent.fanout?.matched).toBe(1);
    expect(sent.message.id).toBeTruthy();

    const msg = await client.getMessage(sent.message.id);
    expect(msg.eventType).toBe("user.created");
    // The payload comes back as the exact signed bytes.
    expect(msg.payload).toBe(JSON.stringify(payload));
    expect(JSON.parse(msg.payload)).toEqual(payload);
    expect(msg.deliveries).toHaveLength(1);
    const delivery = msg.deliveries[0]!;
    expect(delivery.endpointId).toBe(endpoint.id);
    expect(delivery.status).toBe("pending"); // no worker running in this harness
    expect(delivery.attempts).toBe(0);
  });

  it("deduplicates a resent message sharing an idempotency key", async () => {
    const { client } = await startServer();
    await client.createEndpoint({ url: "https://acme.example/hook" });
    const first = await client.sendMessage({
      eventType: "user.created",
      payload: { n: 1 },
      idempotencyKey: "evt-1",
    });
    const second = await client.sendMessage({
      eventType: "user.created",
      payload: { n: 1 },
      idempotencyKey: "evt-1",
    });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(second.fanout).toBeNull();
  });

  it("surfaces an auth failure as a 401 PosthornApiError", async () => {
    const { base } = await startServer();
    const client = new PosthornClient({ baseUrl: base, apiKey: "phk_not_a_real_key" });
    const err = await client.listEndpoints().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(401);
    expect((err as PosthornApiError).code).toBe("unauthorized");
  });

  it("surfaces an unknown message id as a 404 PosthornApiError", async () => {
    const { client } = await startServer();
    const err = await client.getMessage("msg_does_not_exist").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(404);
  });

  it("tolerates a trailing slash in baseUrl", async () => {
    const { base, apiKey } = await startServer();
    const client = new PosthornClient({ baseUrl: `${base}///`, apiKey });
    expect(await client.health()).toEqual({ status: "ok" });
  });
});

describe("PosthornClient construction", () => {
  it("rejects an empty baseUrl", () => {
    expect(() => new PosthornClient({ baseUrl: "  ", apiKey: "k" })).toThrow(TypeError);
  });
  it("rejects an empty apiKey", () => {
    expect(() => new PosthornClient({ baseUrl: "http://x", apiKey: "" })).toThrow(TypeError);
  });
  it("rejects a negative timeout", () => {
    expect(
      () => new PosthornClient({ baseUrl: "http://x", apiKey: "k", timeoutMs: -1 }),
    ).toThrow(TypeError);
  });
});

describe("PosthornClient error + response mapping (injected fetch)", () => {
  it("maps the error envelope to status + code + message", async () => {
    const client = fakeClient(() =>
      Promise.resolve(
        fakeResponse(
          409,
          JSON.stringify({ error: { code: "idempotency_conflict", message: "key reused" } }),
        ),
      ),
    );
    const err = await client.sendMessage({ eventType: "x", payload: {} }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(409);
    expect((err as PosthornApiError).code).toBe("idempotency_conflict");
    expect((err as PosthornApiError).message).toBe("key reused");
  });

  it("falls back to http_<status> when the body is not the JSON envelope", async () => {
    const client = fakeClient(() => Promise.resolve(fakeResponse(502, "bad gateway")));
    const err = await client.health().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(502);
    expect((err as PosthornApiError).code).toBe("http_502");
    expect((err as PosthornApiError).message).toBe("bad gateway");
  });

  it("returns undefined for a 204 (no content)", async () => {
    const client = fakeClient(() => Promise.resolve(fakeResponse(204, "")));
    await expect(client.deleteEndpoint("ep_1")).resolves.toBeUndefined();
  });

  it("throws PosthornError on an unparseable 2xx body", async () => {
    const client = fakeClient(() => Promise.resolve(fakeResponse(200, "{not json")));
    const err = await client.health().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornError);
    expect(err).not.toBeInstanceOf(PosthornApiError);
  });

  it("wraps a transport failure as PosthornError (with cause)", async () => {
    const boom = new Error("connection refused");
    const client = fakeClient(() => Promise.reject(boom));
    const err = await client.health().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornError);
    expect(err).not.toBeInstanceOf(PosthornTimeoutError);
    expect((err as PosthornError).cause).toBe(boom);
  });

  it("raises PosthornTimeoutError when a request exceeds the timeout", async () => {
    // A fetch that never settles until its abort signal fires.
    const hanging: PosthornFetch = (_url, init) =>
      new Promise<PosthornResponse>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = fakeClient(hanging, 20);
    await expect(client.health()).rejects.toBeInstanceOf(PosthornTimeoutError);
  });
});

describe("PosthornClient end-to-end via a running gateway", () => {
  it(
    "sends, delivers a verifiable webhook, and observes succeeded — all via the SDK",
    async () => {
      const gateway = createGateway(memoryConfig());
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;

      // Bootstrap a tenant + key (no HTTP route for this — the admin path).
      const app = await gateway.apps.create({ name: "Acme" });
      const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
      const client = new PosthornClient({ baseUrl: base, apiKey });

      const receiver = await startReceiver();
      receivers.push(receiver);

      const endpoint = await client.createEndpoint({
        url: receiver.url,
        eventTypes: ["user.created"],
      });
      expect(endpoint.secret).toMatch(/^whsec_/);

      const payload = { hello: "world", n: 7 };
      const sent = await client.sendMessage({ eventType: "user.created", payload });
      expect(sent.deduplicated).toBe(false);
      expect(sent.fanout?.matched).toBe(1);

      // The running worker delivers; the receiver verifies with the SDK's own helper.
      const delivered = await receiver.received;
      expect(delivered.body).toBe(JSON.stringify(payload));
      expect(() =>
        verifyWebhook(endpoint.secret, delivered.headers, delivered.body),
      ).not.toThrow();

      // And the SDK observes the delivery settle to succeeded.
      const deadline = Date.now() + 10_000;
      let msg = await client.getMessage(sent.message.id);
      for (;;) {
        const d = msg.deliveries[0];
        if (d && (d.status === "succeeded" || d.status === "dead_letter")) break;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for settle: ${JSON.stringify(msg)}`);
        }
        await new Promise((r) => setTimeout(r, 10));
        msg = await client.getMessage(sent.message.id);
      }
      expect(msg.deliveries[0]!.status).toBe("succeeded");
      expect(msg.deliveries[0]!.attempts).toBe(1);
      expect(JSON.parse(msg.payload)).toEqual(payload);
    },
    15_000,
  );
});
