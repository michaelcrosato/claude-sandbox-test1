import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createGateway, type Gateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { HEADERS, verify } from "../signing/webhook-signature.js";
import { createLogger, type LogEntry } from "../logging/logger.js";

// Track resources per test so each tears its sockets / temp files down cleanly.
const gateways: Gateway[] = [];
const receivers: Receiver[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(gateways.map((g) => g.stop()));
  await Promise.all(receivers.map((r) => r.close()));
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  gateways.length = 0;
  receivers.length = 0;
  tempDirs.length = 0;
});

interface ReceivedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface Receiver {
  readonly url: string;
  /** Resolves with the first delivery the receiver gets. */
  readonly received: Promise<ReceivedRequest>;
  close(): Promise<void>;
}

/** A real `node:http` webhook receiver on an ephemeral port that captures one delivery. */
function startReceiver(responseStatus = 200): Promise<Receiver> {
  let resolveReceived!: (req: ReceivedRequest) => void;
  const received = new Promise<ReceivedRequest>((resolve) => {
    resolveReceived = resolve;
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolveReceived({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(responseStatus);
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

/** A small ephemeral-port, in-memory gateway config with a fast idle poll for tests. */
function memoryConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_WORKER_IDLE_POLL_MS: "5",
    // Tests deliver to a loopback receiver, a trusted destination in-test; opt out
    // of the SSRF guard so endpoint creation to 127.0.0.1 is permitted.
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
    // Keep the default JSON-to-stdout logger quiet during tests; the logging-wiring
    // test injects its own collecting logger and is unaffected by this.
    POSTHORN_LOG_LEVEL: "silent",
    ...overrides,
  });
}

describe("createGateway", () => {
  it("boots, serves /healthz, and stops gracefully (idempotent)", async () => {
    const gateway = createGateway(memoryConfig());
    gateways.push(gateway);
    const address = await gateway.start();
    expect(address.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });

    await gateway.stop();
    await gateway.stop(); // second stop is a no-op, not an error
  });

  it("rejects an unauthenticated request with 401", async () => {
    const gateway = createGateway(memoryConfig());
    gateways.push(gateway);
    const address = await gateway.start();
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/endpoints`);
    expect(res.status).toBe(401);
  });

  it("refuses to start twice", async () => {
    const gateway = createGateway(memoryConfig());
    gateways.push(gateway);
    await gateway.start();
    await expect(gateway.start()).rejects.toThrow(/already started/);
  });

  it("routes HTTP requests through the injected logger, tagged component:http", async () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({ level: "info", sink: (e) => entries.push(e) });
    const gateway = createGateway(memoryConfig(), { logger });
    gateways.push(gateway);
    expect(gateway.logger).toBe(logger);
    const address = await gateway.start();

    const res = await fetch(`http://127.0.0.1:${address.port}/v1/endpoints`);
    expect(res.status).toBe(401);

    const accessLine = entries.find((e) => e.msg === "request");
    expect(accessLine).toBeDefined();
    expect(accessLine!.fields).toMatchObject({
      component: "http", // the gateway passes a child logger bound to the HTTP component
      method: "GET",
      path: "/v1/endpoints",
      status: 401,
    });
  });

  it(
    "delivers an ingested message end-to-end with a verifiable signature",
    async () => {
      const gateway = createGateway(memoryConfig());
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;

      // Provision an app + key programmatically — there is no HTTP route for this.
      const app = await gateway.apps.create({ name: "Acme" });
      const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
      const authHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };

      const receiver = await startReceiver();
      receivers.push(receiver);

      const createRes = await fetch(`${base}/v1/endpoints`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ url: receiver.url, eventTypes: ["user.created"] }),
      });
      expect(createRes.status).toBe(201);
      const { secret: endpointSecret } = (await createRes.json()) as { secret: string };

      const payload = { hello: "world", n: 42 };
      const ingestRes = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ eventType: "user.created", payload }),
      });
      expect(ingestRes.status).toBe(202);

      // The running worker claims the task and POSTs the signed webhook.
      const delivered = await receiver.received;
      expect(delivered.body).toBe(JSON.stringify(payload));
      expect(() =>
        verify(
          endpointSecret,
          {
            id: delivered.headers[HEADERS.id] as string,
            timestamp: delivered.headers[HEADERS.timestamp] as string,
            signature: delivered.headers[HEADERS.signature] as string,
          },
          delivered.body,
        ),
      ).not.toThrow();
    },
    15_000,
  );

  it(
    "exposes delivery status over HTTP after the worker delivers (GET /v1/messages/:id)",
    async () => {
      const gateway = createGateway(memoryConfig());
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;

      const app = await gateway.apps.create({ name: "Acme" });
      const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
      const authHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };

      const receiver = await startReceiver();
      receivers.push(receiver);

      await fetch(`${base}/v1/endpoints`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ url: receiver.url, eventTypes: ["user.created"] }),
      });

      const ingestRes = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ eventType: "user.created", payload: { n: 7 } }),
      });
      expect(ingestRes.status).toBe(202);
      const { message } = (await ingestRes.json()) as { message: { id: string } };

      // Wait until the receiver has the POST, then poll the status endpoint until
      // the running worker has settled the task (a tiny window after delivery).
      await receiver.received;
      const deadline = Date.now() + 10_000;
      let status: {
        id: string;
        eventType: string;
        deliveries: { status: string; attempts: number }[];
      };
      for (;;) {
        const res = await fetch(`${base}/v1/messages/${message.id}`, {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(res.status).toBe(200);
        status = (await res.json()) as typeof status;
        const d = status.deliveries[0];
        if (d && (d.status === "succeeded" || d.status === "dead_letter")) break;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for settle: ${JSON.stringify(status)}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(status.id).toBe(message.id);
      expect(status.eventType).toBe("user.created");
      expect(status.deliveries).toHaveLength(1);
      expect(status.deliveries[0]!.status).toBe("succeeded");
      expect(status.deliveries[0]!.attempts).toBe(1);

      // The per-attempt audit log was written by the worker and is readable over
      // HTTP — one succeeded attempt with a recorded 2xx.
      const attemptsRes = await fetch(`${base}/v1/messages/${message.id}/attempts`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(attemptsRes.status).toBe(200);
      const { data: attempts } = (await attemptsRes.json()) as {
        data: { attemptNumber: number; outcome: string; responseStatus: number | null }[];
      };
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.attemptNumber).toBe(1);
      expect(attempts[0]!.outcome).toBe("succeeded");
      expect(attempts[0]!.responseStatus).toBe(200);
    },
    15_000,
  );

  it(
    "recovers an orphaned (accepted-but-unfanned) message via the dispatcher, end-to-end",
    async () => {
      // grace 0 so the running dispatcher sweeps the orphan immediately (no
      // concurrent inline ingest to race in this test).
      const gateway = createGateway(
        memoryConfig({ POSTHORN_FANOUT_GRACE_MS: "0", POSTHORN_FANOUT_IDLE_POLL_MS: "5" }),
      );
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;

      const app = await gateway.apps.create({ name: "Acme" });
      const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
      const receiver = await startReceiver();
      receivers.push(receiver);

      const createRes = await fetch(`${base}/v1/endpoints`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ url: receiver.url, eventTypes: ["user.created"] }),
      });
      expect(createRes.status).toBe(201);
      const { secret: endpointSecret } = (await createRes.json()) as { secret: string };

      // Simulate a crash between accept and fan-out: a message accepted directly
      // in the store (so it is pending fan-out) with nothing enqueued. No producer
      // retry follows — only the dispatcher can save this delivery.
      const payload = JSON.stringify({ orphan: true });
      const accepted = await gateway.messages.create({
        appId: app.id,
        eventType: "user.created",
        payload,
      });
      expect(accepted.fanoutPending).toBe(true);

      const delivered = await receiver.received;
      expect(delivered.body).toBe(payload);
      expect(() =>
        verify(endpointSecret, {
          id: delivered.headers[HEADERS.id] as string,
          timestamp: delivered.headers[HEADERS.timestamp] as string,
          signature: delivered.headers[HEADERS.signature] as string,
        }, delivered.body),
      ).not.toThrow();
    },
    15_000,
  );

  it(
    "exposes Prometheus metrics reflecting a delivered message (GET /metrics)",
    async () => {
      const gateway = createGateway(memoryConfig());
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;

      const app = await gateway.apps.create({ name: "Acme" });
      const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
      const authHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };
      const receiver = await startReceiver();
      receivers.push(receiver);

      await fetch(`${base}/v1/endpoints`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ url: receiver.url, eventTypes: ["user.created"] }),
      });
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ eventType: "user.created", payload: { n: 1 } }),
      });
      await receiver.received;

      // /metrics is unauthenticated; poll until the worker has settled the success.
      const deadline = Date.now() + 10_000;
      let text = "";
      for (;;) {
        const res = await fetch(`${base}/metrics`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(
          "text/plain; version=0.0.4; charset=utf-8",
        );
        text = await res.text();
        if (text.includes('posthorn_deliveries_total{outcome="succeeded"} 1')) break;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for metrics to reflect success:\n${text}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(text).toContain("posthorn_messages_ingested_total 1");
      expect(text).toContain("# TYPE posthorn_build_info gauge");
    },
    15_000,
  );

  it("disables the admin API by default — /v1/admin/* is 404 (surface hidden)", async () => {
    const gateway = createGateway(memoryConfig());
    gateways.push(gateway);
    const address = await gateway.start();
    // Even with a plausible Bearer token, a disabled instance reveals nothing.
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/admin/apps`, {
      headers: { authorization: "Bearer anything-long-enough-here" },
    });
    expect(res.status).toBe(404);
  });

  it(
    "provisions a tenant + key over the admin API; the minted key works end-to-end and revocation takes effect",
    async () => {
      const ADMIN_TOKEN = "gateway-admin-token-1234567890";
      const gateway = createGateway(memoryConfig({ POSTHORN_ADMIN_TOKEN: ADMIN_TOKEN }));
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;
      const adminHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
      };

      // The surface now exists, but the admin credential is required.
      expect((await fetch(`${base}/v1/admin/apps`)).status).toBe(401);

      // Create a tenant over HTTP (no shelling into the box).
      const appRes = await fetch(`${base}/v1/admin/apps`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name: "Acme" }),
      });
      expect(appRes.status).toBe(201);
      const { id: appId } = (await appRes.json()) as { id: string };

      // Mint a key over HTTP — the secret is returned once here.
      const keyRes = await fetch(`${base}/v1/admin/apps/${appId}/keys`, {
        method: "POST",
        headers: adminHeaders,
      });
      expect(keyRes.status).toBe(201);
      const { apiKey: keyMeta, secret: apiKey } = (await keyRes.json()) as {
        apiKey: { id: string };
        secret: string;
      };
      expect(apiKey).toMatch(/^phk_/);

      // The minted key authenticates a tenant route and a delivered webhook verifies.
      const tenantHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };
      const receiver = await startReceiver();
      receivers.push(receiver);
      const epRes = await fetch(`${base}/v1/endpoints`, {
        method: "POST",
        headers: tenantHeaders,
        body: JSON.stringify({ url: receiver.url, eventTypes: ["user.created"] }),
      });
      expect(epRes.status).toBe(201);
      const { secret: endpointSecret } = (await epRes.json()) as { secret: string };

      const ingestRes = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: tenantHeaders,
        body: JSON.stringify({ eventType: "user.created", payload: { provisioned: true } }),
      });
      expect(ingestRes.status).toBe(202);

      const delivered = await receiver.received;
      expect(() =>
        verify(
          endpointSecret,
          {
            id: delivered.headers[HEADERS.id] as string,
            timestamp: delivered.headers[HEADERS.timestamp] as string,
            signature: delivered.headers[HEADERS.signature] as string,
          },
          delivered.body,
        ),
      ).not.toThrow();

      // Per-tenant usage is queryable over the admin API and reflects the sent message.
      const today = new Date().toISOString().slice(0, 10);
      const usageRes = await fetch(
        `${base}/v1/admin/apps/${appId}/usage?from=${today}&to=${today}`,
        { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
      );
      expect(usageRes.status).toBe(200);
      const usage = (await usageRes.json()) as {
        appId: string;
        total: number;
        daily: { date: string; messages: number }[];
      };
      expect(usage.appId).toBe(appId);
      expect(usage.total).toBe(1);
      expect(usage.daily).toEqual([{ date: today, messages: 1 }]);
      // A tenant key cannot reach the admin usage route (it is not the admin token).
      expect(
        (
          await fetch(`${base}/v1/admin/apps/${appId}/usage?from=${today}&to=${today}`, {
            headers: { authorization: `Bearer ${apiKey}` },
          })
        ).status,
      ).toBe(401);

      // Revoke the key over the admin API; it then stops authenticating immediately.
      const revokeRes = await fetch(`${base}/v1/admin/keys/${keyMeta.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(revokeRes.status).toBe(204);
      const afterRevoke = await fetch(`${base}/v1/endpoints`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(afterRevoke.status).toBe(401);
    },
    15_000,
  );

  it("persists durable state across a restart (file-backed, no Redis)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "posthorn-gw-"));
    tempDirs.push(dir);
    const env = { POSTHORN_DATA_DIR: dir };

    // First boot: provision a tenant + endpoint, then shut down.
    const first = createGateway(memoryConfig(env));
    gateways.push(first);
    const a1 = await first.start();
    const app = await first.apps.create({ name: "Acme" });
    const { secret: apiKey } = await first.apps.createApiKey(app.id);
    const createRes = await fetch(`http://127.0.0.1:${a1.port}/v1/endpoints`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url: "https://acme.example/hook", eventTypes: ["user.created"] }),
    });
    const { id: endpointId } = (await createRes.json()) as { id: string };
    await first.stop();

    // The SQLite files are on disk.
    expect(existsSync(join(dir, "apps.db"))).toBe(true);
    expect(existsSync(join(dir, "endpoints.db"))).toBe(true);

    // Second boot from the same dir: the key still authenticates and the endpoint survives.
    const second = createGateway(memoryConfig(env));
    gateways.push(second);
    const a2 = await second.start();
    const listRes = await fetch(`http://127.0.0.1:${a2.port}/v1/endpoints`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(listRes.status).toBe(200);
    const { data } = (await listRes.json()) as { data: { id: string }[] };
    expect(data.map((e) => e.id)).toContain(endpointId);
  });
});
