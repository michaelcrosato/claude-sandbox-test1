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
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import { DeliveryWorker } from "../worker/delivery-worker.js";
import { createHttpServer } from "../http/server.js";
import type { AppStore } from "../apps/app.js";
import type { EndpointStore } from "../endpoints/endpoint.js";
import type { MessageStore } from "../storage/message-store.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import { MEMORY_DATA_DIR, type GatewayConfig } from "./config.js";

/** The address the gateway's HTTP server actually bound to (after `start`). */
export interface GatewayAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * A wired, runnable Posthorn instance. The stores are exposed deliberately: minting
 * an app and an API key is a privileged bootstrap operation with no HTTP route (a
 * caller would need a key to authenticate the call that creates the first key), so
 * provisioning is done programmatically against {@link Gateway.apps} — by an admin
 * script, a seeding step, or a future control-plane route.
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
  /** The delivery loop (started by {@link Gateway.start}, halted by {@link Gateway.stop}). */
  readonly worker: DeliveryWorker;
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
interface StoreLocations {
  readonly apps: string;
  readonly endpoints: string;
  readonly messages: string;
  readonly queue: string;
}

/**
 * Resolve where each store's SQLite database lives. For `:memory:` all four are
 * ephemeral (each its own independent in-memory db, matching the per-store
 * architecture). For a directory, one file per store is created under it; the
 * directory is created if absent.
 */
function resolveLocations(dataDir: string): StoreLocations {
  if (dataDir === MEMORY_DATA_DIR) {
    return {
      apps: MEMORY_DATA_DIR,
      endpoints: MEMORY_DATA_DIR,
      messages: MEMORY_DATA_DIR,
      queue: MEMORY_DATA_DIR,
    };
  }
  mkdirSync(dataDir, { recursive: true });
  return {
    apps: join(dataDir, "apps.db"),
    endpoints: join(dataDir, "endpoints.db"),
    messages: join(dataDir, "messages.db"),
    queue: join(dataDir, "queue.db"),
  };
}

/**
 * Wire a complete Posthorn gateway from a validated {@link GatewayConfig}. The
 * returned {@link Gateway} is constructed but not yet listening — call
 * {@link Gateway.start}. All four SQLite backends share the lifetime of the
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

  const worker = new DeliveryWorker({
    queue,
    store: messages,
    resolveEndpoint: storeBackedResolver(endpoints),
    batchSize: config.worker.batchSize,
    requestTimeoutMs: config.worker.requestTimeoutMs,
    idlePollMs: config.worker.idlePollMs,
  });

  const httpServer = createHttpServer(
    { apps, endpoints, messages, queue },
    { maxBodyBytes: config.maxBodyBytes },
  );

  let runPromise: Promise<void> | null = null;
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
    // Start the delivery loop. run() resolves only when stop() is called; hold the
    // promise so stop() can await a clean drain. Its own resilience routes tick
    // errors to onError, so this never rejects under normal operation.
    runPromise = worker.run();

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
    if (runPromise !== null) {
      // run() swallows tick errors via its onError path; guard anyway so a stray
      // rejection never masks the rest of shutdown.
      await runPromise.catch(() => undefined);
    }
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
  };

  return { apps, endpoints, messages, queue, worker, httpServer, start, stop };
}
