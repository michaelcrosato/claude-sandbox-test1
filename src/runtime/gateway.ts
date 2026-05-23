/**
 * The composition root — the single place that wires every Posthorn module into a
 * **running, deployable webhook gateway**.
 *
 * Until now Posthorn was a library: correct, well-tested modules (signer, stores,
 * queue, worker, fan-out, HTTP handler) plus a `createHttpServer` *factory*, but
 * nothing that actually instantiated the durable stores, joined them, opened a
 * socket, and started the delivery loop. {@link createGateway} is that wiring, and
 * it realizes the standalone-gateway half of the product's wedge ("use it as a
 * library *or* a standalone gateway"). It holds no domain logic of its own — every
 * decision still lives in the pure modules it composes; this file is pure plumbing.
 *
 * Backed by SQLite-on-disk (or `:memory:` for an ephemeral run): one file per store
 * under `dataDir`, no external Redis or Postgres — the "single process, no Redis"
 * operational wedge, made runnable.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SqliteAppStore } from "../apps/sqlite-app-store.js";
import { SqliteEndpointStore } from "../endpoints/sqlite-endpoint-store.js";
import { SqliteMessageStore } from "../storage/sqlite-store.js";
import { SqliteDeliveryQueue } from "../queue/sqlite-queue.js";
import { SqliteDeliveryAttemptStore } from "../attempts/sqlite-attempt-store.js";
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import { DeliveryWorker } from "../worker/delivery-worker.js";
import { FanoutDispatcher } from "../fanout/fanout-dispatcher.js";
import { createHttpServer } from "../http/server.js";
import { createDashboardHandler } from "../dashboard/handler.js";
import { InMemorySessionStore } from "../dashboard/sessions.js";
import { MetricsRegistry } from "../metrics/metrics.js";
import { POSTHORN_VERSION } from "../version.js";
import type { AppStore } from "../apps/app.js";
import type { EndpointStore } from "../endpoints/endpoint.js";
import type { MessageStore } from "../storage/message-store.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import type { DeliveryAttemptStore } from "../attempts/delivery-attempt.js";
import { MEMORY_DATA_DIR, type GatewayConfig } from "./config.js";

/** The address the gateway's HTTP server actually bound to (after `start`). */
export interface GatewayAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * A wired, runnable Posthorn instance. The stores are exposed deliberately: minting
 * an app and an API key is a privileged operation done either programmatically
 * against {@link Gateway.apps} (an admin script or seeding step), via the keyless
 * `posthorn admin` CLI on the host, or — when `POSTHORN_ADMIN_TOKEN` is configured —
 * over the admin-token-gated `/v1/admin/*` control-plane routes for remote/hosted
 * operation. There is deliberately no *tenant-key*-authenticated provisioning route.
 */
export interface Gateway {
  /** Tenant + API-key store. Use this to provision the first app/key (no HTTP route). */
  readonly apps: AppStore;
  /** Endpoint (subscription) store. */
  readonly endpoints: EndpointStore;
  /** Message store. */
  readonly messages: MessageStore;
  /** Durable delivery queue. */
  readonly queue: DeliveryQueue;
  /** Per-attempt delivery audit log (written by the worker, read at `GET /v1/messages/:id/attempts`). */
  readonly attempts: DeliveryAttemptStore;
  /** The delivery loop (started by {@link Gateway.start}, halted by {@link Gateway.stop}). */
  readonly worker: DeliveryWorker;
  /**
   * The fan-out dispatcher: the transactional-outbox relay that recovers any
   * message accepted but not yet fanned out (e.g. a crash between the two).
   * Started/halted alongside the worker.
   */
  readonly dispatcher: FanoutDispatcher;
  /**
   * Operational metrics: counters fed by the worker + ingest, served as Prometheus
   * exposition at the unauthenticated `GET /metrics`.
   */
  readonly metrics: MetricsRegistry;
  /** The `node:http` server (already constructed; {@link Gateway.start} makes it listen). */
  readonly httpServer: Server;
  /**
   * Bind the HTTP server and start the delivery worker. Resolves with the bound
   * address once listening (use `port: 0` in config for an OS-assigned port).
   * @throws if already started.
   */
  start(): Promise<GatewayAddress>;
  /**
   * Stop accepting requests, drain the worker loop, and release all SQLite handles.
   * Idempotent and safe to call after a failed/partial `start`.
   */
  stop(): Promise<void>;
}

/** Per-store SQLite locations resolved from a `dataDir`. */
export interface StoreLocations {
  readonly apps: string;
  readonly endpoints: string;
  readonly messages: string;
  readonly queue: string;
  readonly attempts: string;
}

/**
 * Resolve where each store's SQLite database lives. For `:memory:` all are
 * ephemeral (each its own independent in-memory db, matching the per-store
 * architecture). For a directory, one file per store is created under it; the
 * directory is created if absent.
 *
 * Exported because it is the single source of truth for the on-disk store layout:
 * the `posthorn admin` CLI (`admin.ts`) opens the *same* `apps.db` this resolves,
 * so sharing the function guarantees the admin path and the running gateway can
 * never disagree on where a tenant's credentials live.
 */
export function resolveLocations(dataDir: string): StoreLocations {
  if (dataDir === MEMORY_DATA_DIR) {
    return {
      apps: MEMORY_DATA_DIR,
      endpoints: MEMORY_DATA_DIR,
      messages: MEMORY_DATA_DIR,
      queue: MEMORY_DATA_DIR,
      attempts: MEMORY_DATA_DIR,
    };
  }
  mkdirSync(dataDir, { recursive: true });
  return {
    apps: join(dataDir, "apps.db"),
    endpoints: join(dataDir, "endpoints.db"),
    messages: join(dataDir, "messages.db"),
    queue: join(dataDir, "queue.db"),
    attempts: join(dataDir, "attempts.db"),
  };
}

/**
 * Wire a complete Posthorn gateway from a validated {@link GatewayConfig}. The
 * returned {@link Gateway} is constructed but not yet listening — call
 * {@link Gateway.start}. All SQLite backends share the lifetime of the
 * gateway and are closed together by {@link Gateway.stop}.
 */
export function createGateway(config: GatewayConfig): Gateway {
  const locations = resolveLocations(config.dataDir);

  const apps = new SqliteAppStore({ location: locations.apps });
  const endpoints = new SqliteEndpointStore({ location: locations.endpoints });
  const messages = new SqliteMessageStore({ location: locations.messages });
  const queue = new SqliteDeliveryQueue({
    location: locations.queue,
    visibilityTimeoutMs: config.worker.visibilityTimeoutMs,
  });
  const attempts = new SqliteDeliveryAttemptStore({ location: locations.attempts });

  const metrics = new MetricsRegistry({ version: POSTHORN_VERSION });

  const worker = new DeliveryWorker({
    queue,
    store: messages,
    resolveEndpoint: storeBackedResolver(endpoints),
    batchSize: config.worker.batchSize,
    concurrency: config.worker.concurrency,
    requestTimeoutMs: config.worker.requestTimeoutMs,
    idlePollMs: config.worker.idlePollMs,
    // Fold each tick's tally into the metrics counters.
    onTick: metrics.recordTick,
    // Append every attempt to the durable audit log (best-effort: a failed write
    // is routed to the worker's onError and never blocks a delivery).
    recordAttempt: async (attempt) => {
      await attempts.record(attempt);
    },
    // Fold each terminal delivery outcome into the target endpoint's health, so an
    // endpoint that fails continuously is automatically disabled (capping wasted
    // attempts/operations). Best-effort: a failed health write is routed to the
    // worker's onError and never blocks a delivery.
    onDeliveryOutcome: async (endpointId, outcome, nowMs) => {
      await endpoints.recordDeliveryOutcome(
        endpointId,
        outcome,
        nowMs,
        config.endpointAutoDisableAfterMs,
      );
    },
  });

  const dispatcher = new FanoutDispatcher({
    messages,
    endpoints,
    queue,
    graceMs: config.fanout.graceMs,
    batchSize: config.fanout.batchSize,
    idlePollMs: config.fanout.idlePollMs,
  });

  // The admin dashboard reuses POSTHORN_ADMIN_TOKEN as its login password, so it is
  // also disabled by default (no token = no dashboard). Sessions are ephemeral.
  const dashboardHandler =
    config.adminToken !== null
      ? createDashboardHandler({
          apps,
          sessions: new InMemorySessionStore(),
          adminToken: config.adminToken,
        })
      : undefined;

  const httpServer = createHttpServer(
    {
      apps,
      endpoints,
      messages,
      queue,
      attempts,
      metrics,
      // Enable the admin/control-plane routes only when a token is configured; when
      // null they stay disabled (every /v1/admin/* route is 404).
      ...(config.adminToken !== null ? { adminToken: config.adminToken } : {}),
    },
    {
      maxBodyBytes: config.maxBodyBytes,
      ...(dashboardHandler !== undefined ? { dashboardHandler } : {}),
    },
  );

  let runPromise: Promise<void> | null = null;
  let dispatcherRunPromise: Promise<void> | null = null;
  let started = false;
  let stopped = false;

  const start = async (): Promise<GatewayAddress> => {
    if (started) {
      throw new Error("gateway already started");
    }
    started = true;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      httpServer.once("error", onError);
      httpServer.listen(config.port, config.host, () => {
        httpServer.removeListener("error", onError);
        resolve();
      });
    });
    // Start the delivery loop and the outbox dispatcher. Each run() resolves only
    // when its stop() is called; hold the promises so stop() can await a clean
    // drain. Their resilience routes errors to onError, so they never reject under
    // normal operation.
    runPromise = worker.run();
    dispatcherRunPromise = dispatcher.run();

    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("gateway HTTP server is not bound to a TCP address");
    }
    const info = address as AddressInfo;
    return { host: info.address, port: info.port };
  };

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    worker.stop();
    dispatcher.stop();
    // run() swallows errors via its onError path; guard anyway so a stray
    // rejection never masks the rest of shutdown.
    await Promise.all(
      [runPromise, dispatcherRunPromise].map((p) =>
        p === null ? Promise.resolve() : p.catch(() => undefined),
      ),
    );
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Force-close idle keep-alive sockets so close() does not hang waiting on them.
      httpServer.closeAllConnections();
    });
    // Release the SQLite handles so the files can be reopened (e.g. a restart) and
    // temp dirs can be cleaned up.
    apps.close();
    endpoints.close();
    messages.close();
    queue.close();
    attempts.close();
  };

  return {
    apps,
    endpoints,
    messages,
    queue,
    attempts,
    worker,
    dispatcher,
    metrics,
    httpServer,
    start,
    stop,
  };
}
