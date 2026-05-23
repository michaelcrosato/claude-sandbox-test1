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
import { PosthornAdminClient } from "./admin-client.js";
import { PosthornClient } from "./client.js";
import {
  PosthornApiError,
  PosthornTimeoutError,
  type PosthornFetch,
  type PosthornResponse,
} from "./http.js";
import { verifyWebhook } from "./verify.js";

/** A valid admin token (≥ MIN_ADMIN_TOKEN_LENGTH = 16 chars). */
const ADMIN_TOKEN = "admin-token-abcdef-0123456789";

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

/** Today as a UTC `YYYY-MM-DD` day — the required `from`/`to` for a usage query covering "now". */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

interface AdminHarness {
  readonly admin: PosthornAdminClient;
  readonly base: string;
  readonly apps: InMemoryAppStore;
}

/**
 * A real `node:http` Posthorn server backed by in-memory stores, plus an admin
 * client. Pass `adminToken: null` to start the server with the admin API **disabled**
 * (every `/v1/admin/*` route is then `404`); the returned client still presents a
 * token so we can prove a disabled surface is hidden rather than merely forbidden.
 */
async function startAdminServer(
  opts: { adminToken?: string | null } = {},
): Promise<AdminHarness> {
  const adminToken = opts.adminToken === undefined ? ADMIN_TOKEN : opts.adminToken;
  const apps = new InMemoryAppStore();
  const server = createHttpServer({
    apps,
    endpoints: new InMemoryEndpointStore(),
    messages: new InMemoryMessageStore(),
    queue: new InMemoryDeliveryQueue(),
    attempts: new InMemoryDeliveryAttemptStore(),
    ...(adminToken !== null ? { adminToken } : {}),
  });
  servers.push(server);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const admin = new PosthornAdminClient({ baseUrl: base, adminToken: ADMIN_TOKEN });
  return { admin, base, apps };
}

/** Build an admin client over an injected fake `fetch` (no real socket). */
function fakeAdmin(fetchImpl: PosthornFetch, timeoutMs?: number): PosthornAdminClient {
  return new PosthornAdminClient({
    baseUrl: "http://example.test",
    adminToken: ADMIN_TOKEN,
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

function memoryConfigWithAdmin(adminToken: string) {
  return loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_WORKER_IDLE_POLL_MS: "5",
    POSTHORN_ADMIN_TOKEN: adminToken,
  });
}

describe("PosthornAdminClient (against the in-process HTTP server)", () => {
  it("creates an unnamed, unlimited tenant when given no input", async () => {
    const { admin } = await startAdminServer();
    const app = await admin.createApp();
    expect(app.id).toMatch(/^app_/);
    expect(app.name).toBe("");
    expect(app.monthlyMessageQuota).toBeNull();
    expect(app.createdAt).toBeGreaterThan(0);
  });

  it("creates, gets, and lists a tenant", async () => {
    const { admin } = await startAdminServer();
    const created = await admin.createApp({ name: "Acme", monthlyMessageQuota: 100 });
    expect(created.name).toBe("Acme");
    expect(created.monthlyMessageQuota).toBe(100);

    const fetched = await admin.getApp(created.id);
    expect(fetched).toEqual(created);

    const list = await admin.listApps();
    expect(list.map((a) => a.id)).toContain(created.id);
  });

  it("updates a tenant's quota (plan change) and clears it", async () => {
    const { admin } = await startAdminServer();
    const app = await admin.createApp({ name: "Acme", monthlyMessageQuota: 100 });

    const upgraded = await admin.updateApp(app.id, { monthlyMessageQuota: 500 });
    expect(upgraded.monthlyMessageQuota).toBe(500);
    expect(upgraded.updatedAt).toBeGreaterThanOrEqual(app.updatedAt);

    const unlimited = await admin.updateApp(app.id, { monthlyMessageQuota: null });
    expect(unlimited.monthlyMessageQuota).toBeNull();
  });

  it("getApp on an unknown id rejects with a 404 PosthornApiError", async () => {
    const { admin } = await startAdminServer();
    const err = await admin.getApp("app_nope").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(404);
    expect((err as PosthornApiError).code).toBe("not_found");
  });

  it("mints a key (secret once) that authenticates a tenant client", async () => {
    const { admin, base } = await startAdminServer();
    const app = await admin.createApp({ name: "Acme" });

    const created = await admin.createApiKey(app.id);
    expect(created.secret).toMatch(/^phk_/);
    expect(created.apiKey.appId).toBe(app.id);
    expect(created.apiKey.prefix).toBe(created.secret.slice(0, created.apiKey.prefix.length));
    expect(created.apiKey.revokedAt).toBeNull();

    // The minted secret authenticates the tenant surface.
    const tenant = new PosthornClient({ baseUrl: base, apiKey: created.secret });
    await expect(tenant.listEndpoints()).resolves.toEqual([]);
  });

  it("lists keys without ever exposing the secret", async () => {
    const { admin } = await startAdminServer();
    const app = await admin.createApp({ name: "Acme" });
    await admin.createApiKey(app.id);
    await admin.createApiKey(app.id);

    const keys = await admin.listApiKeys(app.id);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).not.toHaveProperty("secret");
      expect(key.appId).toBe(app.id);
      expect(key.prefix).toMatch(/^phk_/);
    }
  });

  it("revokes a key, after which it no longer authenticates; re-revoke is 404", async () => {
    const { admin, base } = await startAdminServer();
    const app = await admin.createApp({ name: "Acme" });
    const created = await admin.createApiKey(app.id);
    const tenant = new PosthornClient({ baseUrl: base, apiKey: created.secret });
    await expect(tenant.listEndpoints()).resolves.toEqual([]);

    await expect(admin.revokeApiKey(created.apiKey.id)).resolves.toBeUndefined();

    const authErr = await tenant.listEndpoints().then(
      () => null,
      (e: unknown) => e,
    );
    expect(authErr).toBeInstanceOf(PosthornApiError);
    expect((authErr as PosthornApiError).status).toBe(401);

    // Revoking an already-revoked (or unknown) key is a 404 — the surface reveals
    // nothing about which keys ever existed.
    const reErr = await admin.revokeApiKey(created.apiKey.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(reErr).toBeInstanceOf(PosthornApiError);
    expect((reErr as PosthornApiError).status).toBe(404);
  });

  it("reads per-tenant message usage over a required date range", async () => {
    const { admin, base } = await startAdminServer();
    const app = await admin.createApp({ name: "Acme" });
    const { secret } = await admin.createApiKey(app.id);
    const tenant = new PosthornClient({ baseUrl: base, apiKey: secret });

    await tenant.sendMessage({ eventType: "user.created", payload: { n: 1 } });
    await tenant.sendMessage({ eventType: "user.created", payload: { n: 2 } });

    const today = utcToday();
    const usage = await admin.getAppUsage(app.id, { from: today, to: today });
    expect(usage.appId).toBe(app.id);
    expect(usage.total).toBe(2);
    expect(usage.from).toBe(today);
    expect(usage.to).toBe(today);
    expect(usage.daily.reduce((sum, d) => sum + d.messages, 0)).toBe(2);
  });

  it("getAppUsage rejects an inverted range with a 400", async () => {
    const { admin } = await startAdminServer();
    const app = await admin.createApp({ name: "Acme" });
    const err = await admin
      .getAppUsage(app.id, { from: "2026-02-01", to: "2026-01-01" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(400);
  });

  it("deletes a tenant, cascading its keys; subsequent reads are 404", async () => {
    const { admin, base } = await startAdminServer();
    const app = await admin.createApp({ name: "Acme" });
    const { secret } = await admin.createApiKey(app.id);
    const tenant = new PosthornClient({ baseUrl: base, apiKey: secret });
    await expect(tenant.listEndpoints()).resolves.toEqual([]);

    await expect(admin.deleteApp(app.id)).resolves.toBeUndefined();

    // The tenant is gone...
    const getErr = await admin.getApp(app.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(getErr).toBeInstanceOf(PosthornApiError);
    expect((getErr as PosthornApiError).status).toBe(404);
    expect((await admin.listApps()).map((a) => a.id)).not.toContain(app.id);

    // ...and its key was cascaded, so it no longer authenticates.
    const authErr = await tenant.listEndpoints().then(
      () => null,
      (e: unknown) => e,
    );
    expect(authErr).toBeInstanceOf(PosthornApiError);
    expect((authErr as PosthornApiError).status).toBe(401);

    // Deleting an unknown tenant is a 404, never a silent no-op.
    const delErr = await admin.deleteApp(app.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(delErr).toBeInstanceOf(PosthornApiError);
    expect((delErr as PosthornApiError).status).toBe(404);
  });
});

describe("PosthornAdminClient — surface gating & auth", () => {
  it("every admin call is 404 when the admin API is disabled (surface hidden)", async () => {
    const { admin } = await startAdminServer({ adminToken: null });
    for (const call of [
      () => admin.listApps(),
      () => admin.createApp({ name: "x" }),
      () => admin.getApp("app_1"),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PosthornApiError);
      expect((err as PosthornApiError).status).toBe(404);
    }
  });

  it("rejects a wrong admin token with 401", async () => {
    const { base } = await startAdminServer();
    const wrong = new PosthornAdminClient({
      baseUrl: base,
      adminToken: "wrong-admin-token-9999999",
    });
    const err = await wrong.listApps().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(401);
  });

  it("does not accept a tenant API key as an admin token (401)", async () => {
    const { base, apps } = await startAdminServer();
    const app = await apps.create({ name: "Acme" });
    const { secret: tenantKey } = await apps.createApiKey(app.id);

    const impostor = new PosthornAdminClient({ baseUrl: base, adminToken: tenantKey });
    const err = await impostor.listApps().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(401);
  });
});

describe("PosthornAdminClient — transport (injected fetch)", () => {
  it("rejects an empty baseUrl / adminToken / negative timeout", () => {
    expect(() => new PosthornAdminClient({ baseUrl: "  ", adminToken: "k" })).toThrow(TypeError);
    expect(() => new PosthornAdminClient({ baseUrl: "http://x", adminToken: "" })).toThrow(
      TypeError,
    );
    expect(
      () => new PosthornAdminClient({ baseUrl: "http://x", adminToken: "k", timeoutMs: -1 }),
    ).toThrow(TypeError);
  });

  it("sends Authorization: Bearer <adminToken> and tolerates a trailing slash", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    const admin = new PosthornAdminClient({
      baseUrl: "http://example.test///",
      adminToken: ADMIN_TOKEN,
      fetch: (url, init) => {
        seenUrl = url;
        seenAuth = init.headers["authorization"];
        return Promise.resolve(fakeResponse(200, JSON.stringify({ data: [] })));
      },
    });
    await admin.listApps();
    expect(seenUrl).toBe("http://example.test/v1/admin/apps");
    expect(seenAuth).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it("builds the from/to query string for getAppUsage", async () => {
    let seenUrl = "";
    const admin = fakeAdmin((url) => {
      seenUrl = url;
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ appId: "app_1", from: "x", to: "y", total: 0, daily: [] })),
      );
    });
    await admin.getAppUsage("app_1", { from: "2026-01-01", to: "2026-01-31" });
    expect(seenUrl).toBe(
      "http://example.test/v1/admin/apps/app_1/usage?from=2026-01-01&to=2026-01-31",
    );
  });

  it("url-encodes path params", async () => {
    let seenUrl = "";
    const admin = fakeAdmin((url) => {
      seenUrl = url;
      return Promise.resolve(fakeResponse(204, ""));
    });
    await admin.revokeApiKey("ak/with space");
    expect(seenUrl).toBe("http://example.test/v1/admin/keys/ak%2Fwith%20space");
  });

  it("maps a non-2xx error envelope to a PosthornApiError carrying status + code", async () => {
    const admin = fakeAdmin(() =>
      Promise.resolve(
        fakeResponse(404, JSON.stringify({ error: { code: "not_found", message: "no app" } })),
      ),
    );
    const err = await admin.getApp("app_x").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PosthornApiError);
    expect((err as PosthornApiError).status).toBe(404);
    expect((err as PosthornApiError).code).toBe("not_found");
    expect((err as PosthornApiError).message).toBe("no app");
  });

  it("resolves void for a 204 (delete / revoke)", async () => {
    const admin = fakeAdmin(() => Promise.resolve(fakeResponse(204, "")));
    await expect(admin.deleteApp("app_1")).resolves.toBeUndefined();
    await expect(admin.revokeApiKey("ak_1")).resolves.toBeUndefined();
  });

  it("raises PosthornTimeoutError when a request exceeds the timeout", async () => {
    const hanging: PosthornFetch = (_url, init) =>
      new Promise<PosthornResponse>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const admin = fakeAdmin(hanging, 20);
    await expect(admin.listApps()).rejects.toBeInstanceOf(PosthornTimeoutError);
  });
});

describe("PosthornAdminClient end-to-end via a running gateway", () => {
  it(
    "provisions a tenant + key over HTTP; the minted key delivers a verifiable webhook, and usage/revoke work",
    async () => {
      const gateway = createGateway(memoryConfigWithAdmin(ADMIN_TOKEN));
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;

      // Provision entirely over HTTP via the admin SDK (no programmatic store access).
      const admin = new PosthornAdminClient({ baseUrl: base, adminToken: ADMIN_TOKEN });
      const app = await admin.createApp({ name: "Acme", monthlyMessageQuota: 100 });
      const created = await admin.createApiKey(app.id);
      expect(created.secret).toMatch(/^phk_/);

      // The tenant then drives the data plane with the minted key.
      const client = new PosthornClient({ baseUrl: base, apiKey: created.secret });
      const receiver = await startReceiver();
      receivers.push(receiver);
      const endpoint = await client.createEndpoint({
        url: receiver.url,
        eventTypes: ["user.created"],
      });

      const payload = { hello: "admin-sdk", n: 7 };
      const sent = await client.sendMessage({ eventType: "user.created", payload });
      expect(sent.fanout?.matched).toBe(1);

      // The running worker delivers; verified with the SDK's own receiver helper.
      const delivered = await receiver.received;
      expect(delivered.body).toBe(JSON.stringify(payload));
      expect(() =>
        verifyWebhook(endpoint.secret, delivered.headers, delivered.body),
      ).not.toThrow();

      // The admin SDK observes the tenant's metered usage over HTTP.
      const today = utcToday();
      const usage = await admin.getAppUsage(app.id, { from: today, to: today });
      expect(usage.appId).toBe(app.id);
      expect(usage.total).toBe(1);

      // Revoking the minted key over the admin SDK locks the tenant out.
      const keys = await admin.listApiKeys(app.id);
      expect(keys).toHaveLength(1);
      await admin.revokeApiKey(keys[0]!.id);
      const err = await client.listEndpoints().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PosthornApiError);
      expect((err as PosthornApiError).status).toBe(401);
    },
    15_000,
  );
});
