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
import { InMemoryDeliveryAttemptStore } from "../attempts/in-memory-attempt-store.js";
import { InMemoryPortalSessionStore } from "../portal/portal-session.js";
import { InMemoryEventTypeStore } from "../event-types/in-memory-event-type-store.js";
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
    attempts: new InMemoryDeliveryAttemptStore(),
    eventTypes: new InMemoryEventTypeStore(),
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
    // Loopback receiver is a trusted destination in-test; opt out of the SSRF guard.
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
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

  it("creates and updates a custom retryPolicy on an endpoint", async () => {
    const { client } = await startServer();
    // Defaults to null.
    const created = await client.createEndpoint({ url: "https://acme.example/hook" });
    expect(created.retryPolicy).toBeNull();
    // Set a custom policy.
    const policy = { delaysMs: [1000, 5000] };
    const updated = await client.createEndpoint({
      url: "https://acme.example/hook",
      retryPolicy: policy,
    });
    expect(updated.retryPolicy).toEqual(policy);
    // Update to a different policy.
    const patched = await client.updateEndpoint(updated.id, { retryPolicy: { delaysMs: [500] } });
    expect(patched.retryPolicy).toEqual({ delaysMs: [500] });
    // Clear.
    const cleared = await client.updateEndpoint(patched.id, { retryPolicy: null });
    expect(cleared.retryPolicy).toBeNull();
  });

  it("creates and updates a retryPolicy with nonRetryableStatuses on an endpoint", async () => {
    const { client } = await startServer();
    const policy = { delaysMs: [1000, 5000], nonRetryableStatuses: [400, 401, 410] };
    const created = await client.createEndpoint({
      url: "https://acme.example/hook",
      retryPolicy: policy,
    });
    expect(created.retryPolicy).toEqual(policy);
    // Update to change the non-retryable list.
    const patched = await client.updateEndpoint(created.id, {
      retryPolicy: { delaysMs: [500], nonRetryableStatuses: [403] },
    });
    expect(patched.retryPolicy).toEqual({ delaysMs: [500], nonRetryableStatuses: [403] });
  });

  it("creates and updates custom delivery headers on an endpoint", async () => {
    const { client } = await startServer();
    // Create with headers.
    const created = await client.createEndpoint({
      url: "https://acme.example/hook",
      headers: { "X-API-Key": "tok123", "X-Tenant": "t1" },
    });
    expect(created.headers).toEqual({ "X-API-Key": "tok123", "X-Tenant": "t1" });
    // Update (replace).
    const replaced = await client.updateEndpoint(created.id, { headers: { "X-New": "val" } });
    expect(replaced.headers).toEqual({ "X-New": "val" });
    // Clear.
    const cleared = await client.updateEndpoint(created.id, { headers: null });
    expect(cleared.headers).toBeNull();
    // Verify via get.
    const fetched = await client.getEndpoint(created.id);
    expect(fetched.headers).toBeNull();
  });

  it("creates and updates a payload filter on an endpoint", async () => {
    const { client } = await startServer();
    // Defaults to null.
    const created = await client.createEndpoint({ url: "https://acme.example/hook" });
    expect(created.filter).toBeNull();
    // Set a filter.
    const filter = { op: "eq" as const, path: "env", value: "prod" };
    const withFilter = await client.createEndpoint({
      url: "https://acme.example/hook",
      filter,
    });
    expect(withFilter.filter).toEqual(filter);
    // Update to a different filter.
    const updFilter = { op: "neq" as const, path: "env", value: "staging" };
    const patched = await client.updateEndpoint(withFilter.id, { filter: updFilter });
    expect(patched.filter).toEqual(updFilter);
    // Clear.
    const cleared = await client.updateEndpoint(patched.id, { filter: null });
    expect(cleared.filter).toBeNull();
  });

  it("rotates an endpoint's secret, returning the new one once", async () => {
    const { client } = await startServer();
    const created = await client.createEndpoint({ url: "https://acme.example/hook" });

    const rotated = await client.rotateEndpointSecret(created.id, { overlapMs: 60_000 });
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.id).toBe(created.id);
    // The retired-secret machinery is never sent over the wire.
    expect(rotated).not.toHaveProperty("previousSecrets");

    // A subsequent read still never exposes the secret.
    const fetched = await client.getEndpoint(created.id);
    expect(fetched).not.toHaveProperty("secret");
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

  it("retryMessage round-trips against the server (no-op when nothing dead-lettered)", async () => {
    const { client } = await startServer();
    await client.createEndpoint({ url: "https://acme.example/hook" });
    const sent = await client.sendMessage({ eventType: "user.created", payload: { id: 1 } });

    const res = await client.retryMessage(sent.message.id);
    expect(res.id).toBe(sent.message.id);
    // No worker runs in this harness, so the delivery is still pending — nothing
    // has dead-lettered, so the replay is a no-op that reports the live status.
    expect(res.retried).toBe(0);
    expect(res.deliveries).toHaveLength(1);
    expect(res.deliveries[0]!.status).toBe("pending");
  });

  it("surfaces retrying an unknown message id as a 404 PosthornApiError", async () => {
    const { client } = await startServer();
    const err = await client.retryMessage("msg_does_not_exist").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(404);
  });

  it("lists messages newest-first and pages through with the cursor", async () => {
    const { client } = await startServer();
    const refs: { id: string; createdAt: number }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const sent = await client.sendMessage({ eventType: "e", payload: { i } });
      refs.push({ id: sent.message.id, createdAt: sent.message.createdAt });
    }
    const expected = [...refs]
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((m) => m.id);

    const all = await client.listMessages();
    expect(all.data.map((m) => m.id)).toEqual(expected);
    expect(all.nextCursor).toBeNull();
    // A list item is a lightweight ref — no payload or deliveries on it.
    expect(all.data[0]).not.toHaveProperty("payload");
    expect(all.data[0]).not.toHaveProperty("deliveries");

    const first = await client.listMessages({ limit: 2 });
    expect(first.data.map((m) => m.id)).toEqual(expected.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await client.listMessages({ limit: 2, cursor: first.nextCursor });
    expect(second.data.map((m) => m.id)).toEqual(expected.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  it("reads the tenant's usage and current-month quota status", async () => {
    const { client } = await startServer();
    // This tenant has no quota configured → unlimited.
    await client.sendMessage({ eventType: "e", payload: { i: 1 } });
    await client.sendMessage({ eventType: "e", payload: { i: 2 } });
    const usage = await client.getUsage();
    expect(usage.appId).toMatch(/^app_/);
    // Both sends are in the current UTC month (the default window).
    expect(usage.total).toBe(2);
    expect(usage.quota.monthlyMessageQuota).toBeNull();
    expect(usage.quota.used).toBe(2);
    expect(usage.quota.remaining).toBeNull();
    expect(usage.quota.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(usage.quota.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(usage.daily)).toBe(true);
    // No endpoint is configured, so nothing was delivered → an all-zero operations block,
    // surfaced through the SDK's typed `deliveries` field.
    expect(usage.deliveries).toEqual({ total: 0, succeeded: 0, failed: 0, daily: [] });
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

  it("builds the list query string from limit + cursor (url-encoded)", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listMessages({ limit: 2, cursor: "c2=" });
    expect(seenUrl).toContain("/v1/messages?");
    expect(seenUrl).toContain("limit=2");
    expect(seenUrl).toContain("cursor=c2%3D"); // '=' is percent-encoded
  });

  it("includes eventType in the list query string when provided", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listMessages({ eventType: "user.created" });
    expect(seenUrl).toContain("eventType=user.created");
  });

  it("omits eventType from the query string when null or absent", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listMessages({ eventType: null });
    expect(seenUrl.endsWith("/v1/messages")).toBe(true);
  });

  it("includes after and before created-at bounds in the list query string", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listMessages({ after: 1000, before: 2000 });
    expect(seenUrl).toContain("after=1000");
    expect(seenUrl).toContain("before=2000");
  });

  it("omits after and before from the query string when null or absent", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listMessages({ after: null, before: null });
    expect(seenUrl.endsWith("/v1/messages")).toBe(true);
  });

  it("omits the query string when listMessages gets no params", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listMessages();
    expect(seenUrl.endsWith("/v1/messages")).toBe(true);
  });

  it("posts retryMessage to the right path with the id url-encoded", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const client = fakeClient((url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ id: "m/1", retried: 2, deliveries: [] })),
      );
    });
    const res = await client.retryMessage("m/1");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://example.test/v1/messages/m%2F1/retry");
    expect(res.retried).toBe(2);
  });

  it("retryAllDeliveries POSTs to /v1/deliveries/retry and returns the tally", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const client = fakeClient((url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ retried: 5, hasMore: false })),
      );
    });
    const res = await client.retryAllDeliveries();
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://example.test/v1/deliveries/retry");
    expect(res.retried).toBe(5);
    expect(res.hasMore).toBe(false);
  });

  it("retryEndpointDeliveries POSTs to /v1/endpoints/:id/deliveries/retry and returns the tally", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const client = fakeClient((url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ retried: 3, hasMore: true })),
      );
    });
    const res = await client.retryEndpointDeliveries("ep/1");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://example.test/v1/endpoints/ep%2F1/deliveries/retry");
    expect(res.retried).toBe(3);
    expect(res.hasMore).toBe(true);
  });

  it("replayEndpoint POSTs to /v1/endpoints/:id/replay and returns the tally", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    const client = fakeClient((url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      seenBody = init.body ? JSON.parse(init.body as string) : undefined;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ enqueued: 7, hasMore: true })),
      );
    });
    const res = await client.replayEndpoint("ep/1", { since: 1_000_000, until: 2_000_000, limit: 50 });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://example.test/v1/endpoints/ep%2F1/replay");
    expect(seenBody).toEqual({ since: 1_000_000, until: 2_000_000, limit: 50 });
    expect(res.enqueued).toBe(7);
    expect(res.hasMore).toBe(true);
  });

  it("replayEndpoint omits the body when no input is provided", async () => {
    let seenBody: unknown = "not-checked";
    const client = fakeClient((url, init) => {
      seenBody = init.body;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ enqueued: 0, hasMore: false })),
      );
    });
    await client.replayEndpoint("ep_1");
    expect(seenBody).toBeUndefined();
  });

  it("cancelMessage sends POST /v1/messages/:id/cancel and returns { id, cancelled, deliveries }", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const client = fakeClient((url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ id: "m/1", cancelled: 1, deliveries: [] })),
      );
    });
    const res = await client.cancelMessage("m/1");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://example.test/v1/messages/m%2F1/cancel");
    expect(res.id).toBe("m/1");
    expect(res.cancelled).toBe(1);
    expect(res.deliveries).toEqual([]);
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

  it("includes limit and cursor in listEndpointDeliveries query string", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listEndpointDeliveries("ep_1", { limit: 10, cursor: "c/2" });
    expect(seenUrl).toContain("/v1/endpoints/ep_1/deliveries");
    expect(seenUrl).toContain("limit=10");
    expect(seenUrl).toContain("cursor=c%2F2");
  });

  it("omits query string from listEndpointDeliveries when no params given", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listEndpointDeliveries("ep_1");
    expect(seenUrl.endsWith("/v1/endpoints/ep_1/deliveries")).toBe(true);
  });

  it("getEndpointStats GETs /v1/endpoints/{id}/stats and returns the stats payload", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const statsPayload = {
      endpointId: "ep_1",
      fromMs: 1_000,
      toMs: 2_000,
      total: 10,
      succeeded: 9,
      failed: 1,
      successRate: 0.9,
      avgDurationMs: 123,
      daily: [{ date: "2026-05-17", attempts: 10, succeeded: 9, failed: 1 }],
      failureReasons: { http_5xx: 1, connection_refused: 0 },
    };
    const client = fakeClient((url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      return Promise.resolve(fakeResponse(200, JSON.stringify(statsPayload)));
    });
    const res = await client.getEndpointStats("ep_1");
    expect(seenMethod).toBe("GET");
    expect(seenUrl.endsWith("/v1/endpoints/ep_1/stats")).toBe(true);
    expect(res.endpointId).toBe("ep_1");
    expect(res.total).toBe(10);
    expect(res.successRate).toBe(0.9);
    expect(res.avgDurationMs).toBe(123);
    expect(res.daily).toHaveLength(1);
    expect(res.failureReasons.http_5xx).toBe(1);
  });

  it("includes days in getEndpointStats query string when provided", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({
          endpointId: "ep_1", fromMs: 0, toMs: 1, total: 0, succeeded: 0, failed: 0,
          successRate: null, avgDurationMs: null, daily: [],
        })),
      );
    });
    await client.getEndpointStats("ep_1", { days: 14 });
    expect(seenUrl).toContain("days=14");
  });

  it("includes limit, cursor, and status in listDeliveries query string", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listDeliveries({ limit: 5, cursor: "c/1", status: "dead_letter" });
    expect(seenUrl).toContain("/v1/deliveries");
    expect(seenUrl).toContain("limit=5");
    expect(seenUrl).toContain("cursor=c%2F1");
    expect(seenUrl).toContain("status=dead_letter");
  });

  it("includes failureReason in listDeliveries query string (composes with status)", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listDeliveries({ status: "dead_letter", failureReason: "connection_refused" });
    expect(seenUrl).toContain("/v1/deliveries");
    expect(seenUrl).toContain("status=dead_letter");
    expect(seenUrl).toContain("failureReason=connection_refused");
  });

  it("listMessageAttempts returns requestBody and responseBody from the server payload", async () => {
    const attempt = {
      id: "datt_1",
      taskId: "dtask_1",
      endpointId: "ep_1",
      attemptNumber: 1,
      outcome: "failed",
      responseStatus: 503,
      error: "endpoint returned HTTP 503",
      failureReason: "http_5xx",
      requestBody: '{"eventType":"test"}',
      responseBody: "Service Unavailable",
      durationMs: 120,
      attemptedAt: 1_700_000_000_000,
    };
    const client = fakeClient(() =>
      Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [attempt], nextCursor: null })),
      ),
    );
    const page = await client.listMessageAttempts("msg_1");
    expect(page.data[0]!.requestBody).toBe('{"eventType":"test"}');
    expect(page.data[0]!.responseBody).toBe("Service Unavailable");
    expect(page.data[0]!.failureReason).toBe("http_5xx");
  });

  it("omits query string from listDeliveries when no params given", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })),
      );
    });
    await client.listDeliveries();
    expect(seenUrl.endsWith("/v1/deliveries")).toBe(true);
  });

  it("sendMessageBatch posts to /v1/messages/batch with the messages array", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const result = {
      results: [
        { ok: true, message: { id: "m1", appId: "a1", eventType: "e", idempotencyKey: null, createdAt: 1 }, deduplicated: false, fanout: null },
      ],
    };
    const client = fakeClient((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body as string);
      return Promise.resolve(fakeResponse(200, JSON.stringify(result)));
    });
    const res = await client.sendMessageBatch([
      { eventType: "e", payload: { n: 1 }, idempotencyKey: "k1" },
      { eventType: "e2", payload: null },
    ]);
    expect(seenUrl.endsWith("/v1/messages/batch")).toBe(true);
    const msgs = (seenBody as any).messages as unknown[];
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as any).idempotencyKey).toBe("k1");
    expect(Object.prototype.hasOwnProperty.call(msgs[1], "idempotencyKey")).toBe(false);
    expect(res.results).toHaveLength(1);
    expect((res.results[0] as any).ok).toBe(true);
  });

  it("sendMessage serializes sendAt into the request body", async () => {
    let seenBody: unknown;
    const stub = {
      id: "m1", appId: "a1", eventType: "e", idempotencyKey: null, createdAt: 1,
    };
    const client = fakeClient((_, init) => {
      seenBody = JSON.parse(init.body as string);
      return Promise.resolve(
        fakeResponse(202, JSON.stringify({ message: stub, deduplicated: false, fanout: null })),
      );
    });
    await client.sendMessage({ eventType: "e", payload: {}, sendAt: "2026-06-01T09:00:00Z" });
    expect((seenBody as any).sendAt).toBe("2026-06-01T09:00:00Z");
  });

  it("sendMessage omits sendAt when not provided", async () => {
    let seenBody: unknown;
    const stub = {
      id: "m1", appId: "a1", eventType: "e", idempotencyKey: null, createdAt: 1,
    };
    const client = fakeClient((_, init) => {
      seenBody = JSON.parse(init.body as string);
      return Promise.resolve(
        fakeResponse(202, JSON.stringify({ message: stub, deduplicated: false, fanout: null })),
      );
    });
    await client.sendMessage({ eventType: "e", payload: {} });
    expect(Object.prototype.hasOwnProperty.call(seenBody, "sendAt")).toBe(false);
  });

  it("sendMessageBatch serializes per-item sendAt", async () => {
    let seenBody: unknown;
    const result = {
      results: [
        { ok: true, message: { id: "m1", appId: "a1", eventType: "e", idempotencyKey: null, createdAt: 1 }, deduplicated: false, fanout: null },
      ],
    };
    const client = fakeClient((_, init) => {
      seenBody = JSON.parse(init.body as string);
      return Promise.resolve(fakeResponse(200, JSON.stringify(result)));
    });
    await client.sendMessageBatch([
      { eventType: "e", payload: {}, sendAt: "2026-06-01T09:00:00Z" },
      { eventType: "f", payload: {} },
    ]);
    const msgs = (seenBody as any).messages as unknown[];
    expect((msgs[0] as any).sendAt).toBe("2026-06-01T09:00:00Z");
    expect(Object.prototype.hasOwnProperty.call(msgs[1], "sendAt")).toBe(false);
  });

  it("sendMessage serializes expiresAt into the request body", async () => {
    let seenBody: unknown;
    const stub = {
      id: "m1", appId: "a1", eventType: "e", idempotencyKey: null, createdAt: 1,
    };
    const client = fakeClient((_, init) => {
      seenBody = JSON.parse(init.body as string);
      return Promise.resolve(
        fakeResponse(202, JSON.stringify({ message: stub, deduplicated: false, fanout: null })),
      );
    });
    await client.sendMessage({ eventType: "e", payload: {}, expiresAt: "2026-06-01T09:05:00Z" });
    expect((seenBody as any).expiresAt).toBe("2026-06-01T09:05:00Z");
  });

  it("sendMessage omits expiresAt when not provided", async () => {
    let seenBody: unknown;
    const stub = {
      id: "m1", appId: "a1", eventType: "e", idempotencyKey: null, createdAt: 1,
    };
    const client = fakeClient((_, init) => {
      seenBody = JSON.parse(init.body as string);
      return Promise.resolve(
        fakeResponse(202, JSON.stringify({ message: stub, deduplicated: false, fanout: null })),
      );
    });
    await client.sendMessage({ eventType: "e", payload: {} });
    expect(Object.prototype.hasOwnProperty.call(seenBody, "expiresAt")).toBe(false);
  });

  it("sendMessage serializes priority into the request body", async () => {
    let seenBody: unknown;
    const stub = {
      id: "m1", appId: "a1", eventType: "e", idempotencyKey: null, createdAt: 1,
    };
    const client = fakeClient((_, init) => {
      seenBody = JSON.parse(init.body as string);
      return Promise.resolve(
        fakeResponse(202, JSON.stringify({ message: stub, deduplicated: false, fanout: null })),
      );
    });
    await client.sendMessage({ eventType: "e", payload: {}, priority: "high" });
    expect((seenBody as any).priority).toBe("high");
  });

  it("sendMessage omits priority when not provided", async () => {
    let seenBody: unknown;
    const stub = {
      id: "m1", appId: "a1", eventType: "e", idempotencyKey: null, createdAt: 1,
    };
    const client = fakeClient((_, init) => {
      seenBody = JSON.parse(init.body as string);
      return Promise.resolve(
        fakeResponse(202, JSON.stringify({ message: stub, deduplicated: false, fanout: null })),
      );
    });
    await client.sendMessage({ eventType: "e", payload: {} });
    expect(Object.prototype.hasOwnProperty.call(seenBody, "priority")).toBe(false);
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

      // The per-attempt audit log records that one succeeded attempt (HTTP 2xx),
      // observed all the way through the SDK.
      const attemptsPage = await client.listMessageAttempts(sent.message.id);
      expect(attemptsPage.data).toHaveLength(1);
      expect(attemptsPage.nextCursor).toBeNull();
      expect(attemptsPage.data[0]).toMatchObject({
        endpointId: endpoint.id,
        attemptNumber: 1,
        outcome: "succeeded",
        error: null,
        failureReason: null,
      });
      expect(attemptsPage.data[0]!.responseStatus).toBeGreaterThanOrEqual(200);
      expect(attemptsPage.data[0]!.responseStatus).toBeLessThan(300);
    },
    15_000,
  );

  it(
    "rotates a secret with zero downtime — the delivery verifies against BOTH old and new",
    async () => {
      const gateway = createGateway(memoryConfig());
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;

      const app = await gateway.apps.create({ name: "Acme" });
      const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
      const client = new PosthornClient({ baseUrl: base, apiKey });

      const receiver = await startReceiver();
      receivers.push(receiver);

      // Create an endpoint (old secret), then rotate to a new secret with a
      // generous overlap so the old one is still active when the message ships.
      const created = await client.createEndpoint({
        url: receiver.url,
        eventTypes: ["user.created"],
      });
      const oldSecret = created.secret;
      const rotated = await client.rotateEndpointSecret(created.id, {
        overlapMs: 3_600_000, // 1h — comfortably covers the sub-second delivery
      });
      const newSecret = rotated.secret;
      expect(newSecret).not.toBe(oldSecret);

      const payload = { event: "rotation", n: 42 };
      await client.sendMessage({ eventType: "user.created", payload });

      // The single delivered request carries one signature token per active secret,
      // so a receiver still on the OLD secret AND one already on the NEW secret both
      // verify — no webhook is dropped while receivers migrate.
      const delivered = await receiver.received;
      expect(delivered.body).toBe(JSON.stringify(payload));
      expect(() =>
        verifyWebhook(oldSecret, delivered.headers, delivered.body),
      ).not.toThrow();
      expect(() =>
        verifyWebhook(newSecret, delivered.headers, delivered.body),
      ).not.toThrow();
    },
    15_000,
  );
});

describe("PosthornClient — createPortalSession", () => {
  async function startPortalServer(): Promise<Harness> {
    const apps = new InMemoryAppStore();
    const app = await apps.create({ name: "Acme" });
    const { secret: apiKey } = await apps.createApiKey(app.id);
    const portalSessions = new InMemoryPortalSessionStore();
    const server = createHttpServer({
      apps,
      endpoints: new InMemoryEndpointStore(),
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      portalSessions,
      eventTypes: new InMemoryEventTypeStore(),
    });
    servers.push(server);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    return { client: new PosthornClient({ baseUrl: base, apiKey }), base, apiKey };
  }

  it("mints a portal session and returns token, portalUrl, and expiresAt", async () => {
    const { client } = await startPortalServer();
    const result = await client.createPortalSession({ externalUserId: "user-abc" });
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.portalUrl).toContain("/portal/login?token=");
    expect(result.portalUrl).toContain(result.token);
    expect(typeof result.expiresAt).toBe("number");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("sends expiresIn when provided", async () => {
    let capturedBody: string | null = null;
    const client = fakeClient(async (url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return fakeResponse(
        201,
        JSON.stringify({ token: "tok", portalUrl: "http://h/portal/login?token=tok", expiresAt: 9999 }),
      );
    });
    await client.createPortalSession({ externalUserId: "u", expiresIn: 3600 });
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.externalUserId).toBe("u");
    expect(parsed.expiresIn).toBe(3600);
  });

  it("omits expiresIn from the request body when not provided", async () => {
    let capturedBody: string | null = null;
    const client = fakeClient(async (url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return fakeResponse(
        201,
        JSON.stringify({ token: "tok", portalUrl: "http://h/portal/login?token=tok", expiresAt: 9999 }),
      );
    });
    await client.createPortalSession({ externalUserId: "u" });
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).not.toHaveProperty("expiresIn");
  });
});

describe("PosthornClient — event types", () => {
  it("listEventTypes sends no query string when no params provided", async () => {
    let capturedUrl: string | null = null;
    const client = fakeClient(async (url) => {
      capturedUrl = url;
      return fakeResponse(200, JSON.stringify({ data: [] }));
    });
    const result = await client.listEventTypes();
    expect(result.data).toEqual([]);
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!).not.toContain("includeArchived");
  });

  it("listEventTypes adds includeArchived=true to query string when requested", async () => {
    let capturedUrl: string | null = null;
    const client = fakeClient(async (url) => {
      capturedUrl = url;
      return fakeResponse(200, JSON.stringify({ data: [] }));
    });
    await client.listEventTypes({ includeArchived: true });
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!).toContain("includeArchived=true");
  });
});

describe("PosthornClient — testEndpoint", () => {
  it("sends POST to /v1/endpoints/:id/test with the provided body", async () => {
    let capturedUrl: string | null = null;
    let capturedBody: string | null = null;
    const result = { success: true, httpStatus: 200, durationMs: 42, payloadSource: "catalog" };
    const client = fakeClient(async (url, init) => {
      capturedUrl = url;
      capturedBody = init?.body as string ?? null;
      return fakeResponse(200, JSON.stringify(result));
    });
    const res = await client.testEndpoint("ep_1", { eventType: "user.created", payload: { id: 1 } });
    expect(res.success).toBe(true);
    expect(res.httpStatus).toBe(200);
    expect(res.durationMs).toBe(42);
    expect(res.payloadSource).toBe("catalog");
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!).toContain("/v1/endpoints/ep_1/test");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.eventType).toBe("user.created");
    expect(parsed.payload).toEqual({ id: 1 });
  });

  it("sends POST with empty body when no input is provided", async () => {
    let capturedBody: string | null = null;
    const result = { success: false, httpStatus: 500, durationMs: 10 };
    const client = fakeClient(async (_url, init) => {
      capturedBody = init?.body as string ?? null;
      return fakeResponse(200, JSON.stringify(result));
    });
    const res = await client.testEndpoint("ep_2");
    expect(res.success).toBe(false);
    // An empty input object serializes to "{}" — no eventType or payload keys.
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).not.toHaveProperty("eventType");
    expect(parsed).not.toHaveProperty("payload");
  });

  it("getDelivery GETs /v1/deliveries/{id} and returns the delivery", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const deliveryPayload = {
      id: "dtask_1",
      messageId: "msg_1",
      endpointId: "ep_1",
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const client = fakeClient((url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      return Promise.resolve(fakeResponse(200, JSON.stringify(deliveryPayload)));
    });
    const res = await client.getDelivery("dtask_1");
    expect(seenMethod).toBe("GET");
    expect(seenUrl.endsWith("/v1/deliveries/dtask_1")).toBe(true);
    expect(res.id).toBe("dtask_1");
    expect(res.messageId).toBe("msg_1");
    expect(res.status).toBe("pending");
  });

  it("getDelivery URL-encodes the delivery id", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(fakeResponse(200, JSON.stringify({ id: "dtask_x/y", messageId: "m", endpointId: null, status: "pending", attempts: 0, nextAttemptAt: null, lastError: null, createdAt: 0, updatedAt: 0 })));
    });
    await client.getDelivery("dtask_x/y");
    expect(seenUrl).toContain("/v1/deliveries/dtask_x%2Fy");
  });

  it("listDeliveryAttempts GETs /v1/deliveries/{id}/attempts and returns the page", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })));
    });
    const res = await client.listDeliveryAttempts("dtask_1");
    expect(seenUrl.endsWith("/v1/deliveries/dtask_1/attempts")).toBe(true);
    expect(res.data).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  it("listDeliveryAttempts includes limit and cursor in the query string", async () => {
    let seenUrl = "";
    const client = fakeClient((url) => {
      seenUrl = url;
      return Promise.resolve(fakeResponse(200, JSON.stringify({ data: [], nextCursor: null })));
    });
    await client.listDeliveryAttempts("dtask_1", { limit: 10, cursor: "c/3" });
    expect(seenUrl).toContain("limit=10");
    expect(seenUrl).toContain("cursor=c%2F3");
  });
});
