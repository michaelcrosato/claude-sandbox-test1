import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createGateway, type Gateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createPostgresPool } from "../db/postgres.js";
import { PostgresAppStore } from "../apps/postgres-app-store.js";
import { PostgresEndpointStore } from "../endpoints/postgres-endpoint-store.js";
import { PostgresMessageStore } from "../storage/postgres-store.js";
import { PostgresDeliveryQueue } from "../queue/postgres-queue.js";
import { PostgresDeliveryAttemptStore } from "../attempts/postgres-attempt-store.js";
import { PostgresEventTypeStore } from "../event-types/postgres-event-type-store.js";
import { HEADERS, verify } from "../signing/webhook-signature.js";
import { createLogger, type LogEntry } from "../logging/logger.js";
import { POSTHORN_VERSION } from "../version.js";

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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A receiver whose response is held until {@link ControllableReceiver.release} is
 * called. Used to pin an inbound gateway request *in flight* (the gateway blocks on
 * this receiver while serving `POST /v1/endpoints/:id/test`), so a test can trigger
 * `stop()` while a request is mid-processing and observe whether it drains or is
 * force-closed.
 */
interface ControllableReceiver {
  readonly url: string;
  /** Resolves when the receiver has received a request (the gateway request is now in flight). */
  readonly hit: Promise<void>;
  /** Make the receiver send its `200` response, completing the in-flight gateway request. */
  release(): void;
  close(): Promise<void>;
}

function startControllableReceiver(): Promise<ControllableReceiver> {
  let resolveHit!: () => void;
  const hit = new Promise<void>((resolve) => {
    resolveHit = resolve;
  });
  let releaseFn!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const server = createServer((req, res) => {
    req.resume(); // drain the request body
    req.on("end", () => {
      resolveHit();
      void released.then(() => {
        res.writeHead(200);
        res.end();
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        hit,
        release: releaseFn,
        close: () =>
          new Promise<void>((done) => {
            releaseFn(); // let any still-pending handler finish so the server can close
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

/** Like {@link memoryConfig} but backed by the Postgres database at `pgUrl`. */
function pgConfig(pgUrl: string, overrides: Record<string, string> = {}) {
  return loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATABASE_URL: pgUrl,
    POSTHORN_WORKER_IDLE_POLL_MS: "5",
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
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

  it("drains an in-flight request during stop() instead of force-closing it", async () => {
    // Fast worker AND dispatcher idle polls so stop() reaches the HTTP-close phase
    // promptly (the dispatcher's default poll is 1s — without this override stop()
    // would not begin draining the socket until the dispatcher loop next wakes).
    const gateway = createGateway(memoryConfig({ POSTHORN_FANOUT_IDLE_POLL_MS: "5" }));
    gateways.push(gateway);
    const address = await gateway.start();
    const base = `http://127.0.0.1:${address.port}`;
    const app = await gateway.apps.create({ name: "Drain" });
    const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
    const auth = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };

    const receiver = await startControllableReceiver();
    try {
      const createRes = await fetch(`${base}/v1/endpoints`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: receiver.url, eventTypes: ["test"] }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      // The test-send holds this inbound request open while the gateway POSTs to the
      // (not-yet-responding) receiver. Don't await — it must stay in flight.
      const testP = fetch(`${base}/v1/endpoints/${id}/test`, { method: "POST", headers: auth });
      await receiver.hit; // the gateway's inbound request is now in flight

      // Begin shutdown while the request is in flight, give stop() time to reach
      // close() + closeIdleConnections(), then let the receiver respond.
      const stopP = gateway.stop();
      await delay(80);
      receiver.release();

      // The in-flight request drained to completion rather than being reset — the
      // regression guard for the closeAllConnections()→closeIdleConnections() fix.
      const res = await testP;
      expect(res.status).toBe(200);
      expect((await res.json() as { success: boolean }).success).toBe(true);
      await stopP;
    } finally {
      await receiver.close();
    }
  });

  it("force-closes an in-flight request that outlasts the shutdown grace window", async () => {
    const gateway = createGateway(
      memoryConfig({ POSTHORN_FANOUT_IDLE_POLL_MS: "5", POSTHORN_HTTP_SHUTDOWN_GRACE_MS: "40" }),
    );
    gateways.push(gateway);
    const address = await gateway.start();
    const base = `http://127.0.0.1:${address.port}`;
    const app = await gateway.apps.create({ name: "Grace" });
    const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
    const auth = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };

    const receiver = await startControllableReceiver(); // never released until cleanup
    try {
      const createRes = await fetch(`${base}/v1/endpoints`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: receiver.url, eventTypes: ["test"] }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const testP = fetch(`${base}/v1/endpoints/${id}/test`, { method: "POST", headers: auth });
      // testP may reject once the socket is force-closed; attach a catch now so the
      // rejection is never unhandled while stop() is in progress.
      const settled = testP.then(
        () => ({ ok: true }) as const,
        () => ({ ok: false }) as const,
      );
      await receiver.hit; // the request is in flight, and the receiver will never respond

      // stop() drains for the 40ms grace, then force-closes the still-active socket.
      // stop() resolving at all proves the cutoff fired — without it, close() would
      // wait on the never-completing request forever.
      await gateway.stop();
      expect((await settled).ok).toBe(false);
    } finally {
      await receiver.close();
    }
  });

  it("serves /readyz as 200 ready while the backend is reachable", async () => {
    const gateway = createGateway(memoryConfig());
    gateways.push(gateway);
    const address = await gateway.start();

    const res = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });

    await gateway.stop();
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

  it("threads the configured HTTP socket timeouts onto the live listener", async () => {
    const gateway = createGateway(
      memoryConfig({
        POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS: "65000",
        POSTHORN_HTTP_HEADERS_TIMEOUT_MS: "66000",
        POSTHORN_HTTP_REQUEST_TIMEOUT_MS: "120000",
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    expect(gateway.httpServer.keepAliveTimeout).toBe(65_000);
    expect(gateway.httpServer.headersTimeout).toBe(66_000);
    expect(gateway.httpServer.requestTimeout).toBe(120_000);
  });

  it("routes HTTP requests through the injected logger, tagged component:http", async () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({ level: "info", sink: (e) => entries.push(e) });
    const gateway = createGateway(memoryConfig(), { logger, instanceId: "inst-test" });
    gateways.push(gateway);
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
      // The gateway binds its identity onto the injected logger, so every line —
      // even ones emitted by a sub-component — carries instance + version.
      instance: "inst-test",
      version: POSTHORN_VERSION,
    });
  });

  it("emits structured gateway started / stopped lifecycle lines", async () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({ level: "info", sink: (e) => entries.push(e) });
    const gateway = createGateway(memoryConfig(), { logger, instanceId: "inst-life" });
    const address = await gateway.start();

    const started = entries.find((e) => e.msg === "gateway started");
    expect(started).toBeDefined();
    expect(started!.level).toBe("info");
    expect(started!.fields).toMatchObject({
      component: "gateway",
      host: "127.0.0.1",
      port: address.port,
      dataDir: ":memory:",
      instance: "inst-life",
      version: POSTHORN_VERSION,
    });
    expect(typeof started!.fields.port).toBe("number");

    await gateway.stop();
    const stopped = entries.filter((e) => e.msg === "gateway stopped");
    expect(stopped).toHaveLength(1); // fires exactly once despite stop() being idempotent
    expect(stopped[0]!.fields).toMatchObject({ component: "gateway", instance: "inst-life" });

    await gateway.stop(); // second stop must not emit a second line
    expect(entries.filter((e) => e.msg === "gateway stopped")).toHaveLength(1);
  });

  it("stamps a distinct instance id onto each gateway by default", async () => {
    const collect = (): { logger: ReturnType<typeof createLogger>; entries: LogEntry[] } => {
      const entries: LogEntry[] = [];
      return { logger: createLogger({ level: "info", sink: (e) => entries.push(e) }), entries };
    };
    const a = collect();
    const b = collect();
    const ga = createGateway(memoryConfig(), { logger: a.logger });
    const gb = createGateway(memoryConfig(), { logger: b.logger });
    gateways.push(ga, gb);
    await ga.start();
    await gb.start();

    const instA = a.entries.find((e) => e.msg === "gateway started")!.fields.instance;
    const instB = b.entries.find((e) => e.msg === "gateway started")!.fields.instance;
    expect(typeof instA).toBe("string");
    expect((instA as string).length).toBeGreaterThan(0);
    expect(instA).not.toBe(instB); // a fresh random id per gateway, no collision
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

  it(
    "SSRF-guards the consumer-portal test-send (DNS-rebinding parity with the JSON API)",
    async () => {
      // Default SSRF policy (block private networks) — NOT the loopback-permitting
      // memoryConfig default, since this test asserts the guard *fires*.
      const gateway = createGateway(
        memoryConfig({ POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "false" }),
      );
      gateways.push(gateway);
      const address = await gateway.start();
      const base = `http://127.0.0.1:${address.port}`;

      const app = await gateway.apps.create({ name: "Acme" });
      const { secret: apiKey } = await gateway.apps.createApiKey(app.id);

      // Store an endpoint whose host is a *hostname* resolving to loopback. Inserted
      // through the store (not the API) to model a destination that passed the
      // registration-time static guard but resolves to a private address at send time
      // — the DNS-rebinding case the connection-time guard exists to catch. (A literal
      // private IP would never reach the lookup hook; Node skips DNS for literal IPs.)
      const endpoint = await gateway.endpoints.create({
        appId: app.id,
        url: "http://localhost/hook",
        eventTypes: ["test"],
      });

      // Mint a portal session for this tenant. The session cookie value *is* the token,
      // so we can present it directly without the GET /portal/login redirect dance.
      const sessionRes = await fetch(`${base}/v1/portal/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ externalUserId: "customer_1" }),
      });
      expect(sessionRes.status).toBe(201);
      const { token } = (await sessionRes.json()) as { token: string };

      const testRes = await fetch(`${base}/portal/endpoints/${endpoint.id}/test`, {
        method: "POST",
        headers: { cookie: `ph_portal_session=${token}` },
      });
      // The page renders (200); the test-send itself must have been *blocked* by the
      // connection-time guard rather than connecting to loopback. Before the gateway
      // wired `deliveryTransport` into the portal handler this fell back to the
      // unguarded fetchTransport, which would have connected (or failed with a plain
      // connection error) — never reporting the SSRF block.
      expect(testRes.status).toBe(200);
      const body = await testRes.text();
      expect(body).toContain("Test failed");
      expect(body).toContain("private or internal address");
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Postgres-backed gateway. Proves the composition root actually *deploys* on the
// optional Postgres backend — not merely that the PG stores conform in isolation
// (the store conformance suites cover that). Gated on POSTHORN_TEST_PG_URL, like the
// per-store Postgres suites; skipped when no live Postgres is available.
// Run locally with a throwaway container:
//   docker run -d --rm -e POSTGRES_PASSWORD=p -e POSTGRES_USER=u -e POSTGRES_DB=posthorn_test -p 5433:5432 postgres:16-alpine
//   POSTHORN_TEST_PG_URL=postgres://u:p@127.0.0.1:5433/posthorn_test npx vitest run src/runtime/gateway.test.ts
// ---------------------------------------------------------------------------
const pgUrl = process.env.POSTHORN_TEST_PG_URL;

if (!pgUrl) {
  describe.skip("createGateway on Postgres — skipped (POSTHORN_TEST_PG_URL not set)", () => {});
} else {
  describe("createGateway on Postgres", () => {
    // The gateway shares one Postgres database across these tests, and the worker
    // claims queue work app-agnostically, so wipe any state left by a prior run to
    // keep the worker from chasing dead receivers and to make assertions isolated.
    beforeAll(async () => {
      const pool = createPostgresPool(pgUrl);
      const stores = [
        new PostgresAppStore(pool),
        new PostgresEndpointStore(pool),
        new PostgresMessageStore(pool),
        new PostgresDeliveryQueue(pool),
        new PostgresDeliveryAttemptStore(pool),
        new PostgresEventTypeStore(pool),
      ];
      try {
        for (const store of stores) {
          await store.initialize();
          await store.truncate();
        }
      } finally {
        await pool.end();
      }
    });

    it(
      "boots, creates its schema, and delivers an ingested message with a verifiable signature",
      async () => {
        const gateway = createGateway(pgConfig(pgUrl));
        gateways.push(gateway);
        const address = await gateway.start();
        const base = `http://127.0.0.1:${address.port}`;

        // Readiness against a live Postgres: /readyz runs the backend's SELECT 1
        // round-trip through the real pool, so a 200 ready proves the probe actually
        // reaches the database (not just the static /healthz liveness signal).
        const readyRes = await fetch(`${base}/readyz`);
        expect(readyRes.status).toBe(200);
        expect(await readyRes.json()).toEqual({ status: "ready" });

        const app = await gateway.apps.create({ name: "Acme PG" });
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

        const payload = { hello: "postgres", n: 7 };
        const ingestRes = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ eventType: "user.created", payload }),
        });
        expect(ingestRes.status).toBe(202);

        // The running worker claims the task from the Postgres queue and POSTs it.
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
      20_000,
    );

    it(
      "persists durable state across a restart — the shared Postgres DB, no local files",
      async () => {
        // First boot: provision a tenant + endpoint against Postgres, then shut down
        // (which drains the connection pool).
        const first = createGateway(pgConfig(pgUrl));
        gateways.push(first);
        const a1 = await first.start();
        const app = await first.apps.create({ name: "Acme PG Restart" });
        const { secret: apiKey } = await first.apps.createApiKey(app.id);
        const createRes = await fetch(`http://127.0.0.1:${a1.port}/v1/endpoints`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            url: "https://acme.example/hook",
            eventTypes: ["user.created"],
          }),
        });
        expect(createRes.status).toBe(201);
        const { id: endpointId } = (await createRes.json()) as { id: string };
        await first.stop();

        // Second boot against the same database: the key still authenticates (durable
        // in Postgres, not a local file) and the endpoint survives.
        const second = createGateway(pgConfig(pgUrl));
        gateways.push(second);
        const a2 = await second.start();
        const listRes = await fetch(`http://127.0.0.1:${a2.port}/v1/endpoints`, {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(listRes.status).toBe(200);
        const { data } = (await listRes.json()) as { data: { id: string }[] };
        expect(data.map((e) => e.id)).toContain(endpointId);
      },
      20_000,
    );
  });
}
