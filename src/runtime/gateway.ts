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
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SqliteAppStore } from "../apps/sqlite-app-store.js";
import { SqliteEndpointStore } from "../endpoints/sqlite-endpoint-store.js";
import { SqliteMessageStore } from "../storage/sqlite-store.js";
import { SqliteDeliveryQueue } from "../queue/sqlite-queue.js";
import { SqliteDeliveryAttemptStore } from "../attempts/sqlite-attempt-store.js";
import { SqliteEventTypeStore } from "../event-types/sqlite-event-type-store.js";
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import { DeliveryWorker } from "../worker/delivery-worker.js";
import { createGuardedTransport } from "../net/guarded-transport.js";
import { FanoutDispatcher } from "../fanout/fanout-dispatcher.js";
import { DataPruner } from "../pruner/data-pruner.js";
import { createHttpServer } from "../http/server.js";
import { createDashboardHandler } from "../dashboard/handler.js";
import { InMemorySessionStore } from "../dashboard/sessions.js";
import { createTenantDashboardHandler } from "../dashboard/tenant-handler.js";
import { InMemoryTenantSessionStore } from "../dashboard/tenant-sessions.js";
import { createPortalHandler } from "../portal/portal-handler.js";
import { InMemoryPortalSessionStore } from "../portal/portal-session.js";
import { MetricsRegistry } from "../metrics/metrics.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { POSTHORN_VERSION } from "../version.js";
import type { AppStore } from "../apps/app.js";
import type { EndpointStore } from "../endpoints/endpoint.js";
import type { MessageStore } from "../storage/message-store.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import type { DeliveryAttemptStore } from "../attempts/delivery-attempt.js";
import type { EventTypeStore } from "../event-types/event-type.js";
import { MEMORY_DATA_DIR, type GatewayConfig } from "./config.js";
import {
  emitEndpointDisabledEvent,
  emitMessageDeadLetteredEvent,
  systemEventTransportFrom,
  type SystemEventTransport,
} from "../system-events/index.js";

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
  /** Event type catalog store. */
  readonly eventTypes: EventTypeStore;
  /** The delivery loop (started by {@link Gateway.start}, halted by {@link Gateway.stop}). */
  readonly worker: DeliveryWorker;
  /**
   * The fan-out dispatcher: the transactional-outbox relay that recovers any
   * message accepted but not yet fanned out (e.g. a crash between the two).
   * Started/halted alongside the worker.
   */
  readonly dispatcher: FanoutDispatcher;
  /**
   * The data-retention pruner, or `null` when `POSTHORN_RETENTION_DAYS` is `0`
   * (the default — pruning disabled). When non-null, sweeps the stores hourly
   * and deletes data older than the retention window.
   */
  readonly pruner: DataPruner | null;
  /**
   * Operational metrics: counters fed by the worker + ingest, served as Prometheus
   * exposition at the unauthenticated `GET /metrics`.
   */
  readonly metrics: MetricsRegistry;
  /**
   * Structured logger (JSON Lines to stdout at `config.logLevel`). Exposed so an
   * embedder can emit lines into the same stream as the gateway. Wired into the
   * HTTP request lifecycle and the worker / dispatcher / pruner `onError` seams,
   * so a runtime failure that previously vanished is now surfaced.
   */
  readonly logger: Logger;
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

/** Optional overrides for {@link createGateway} beyond the validated config. */
export interface CreateGatewayOptions {
  /**
   * Replace the structured logger. Defaults to a JSON-Lines-to-stdout logger at
   * `config.logLevel`. A library embedder injects their own {@link Logger} (or a
   * custom sink) to route Posthorn's runtime logs into their logging stack; a test
   * injects a collecting logger to assert on emitted entries. Whatever is supplied,
   * the gateway binds `instance` + `version` onto it (see {@link instanceId}), so an
   * embedder's sink still receives those identity fields on every Posthorn line.
   */
  readonly logger?: Logger;
  /**
   * Identity stamped onto **every** log line this gateway emits, so lines from
   * different processes/replicas sharing one log stream stay distinguishable.
   * Defaults to a fresh random id per gateway instance. Inject a stable value for
   * deterministic tests, or to align the id with an external orchestrator's name.
   */
  readonly instanceId?: string;
}

/** Per-store SQLite locations resolved from a `dataDir`. */
export interface StoreLocations {
  readonly apps: string;
  readonly endpoints: string;
  readonly messages: string;
  readonly queue: string;
  readonly attempts: string;
  readonly eventTypes: string;
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
      eventTypes: MEMORY_DATA_DIR,
    };
  }
  mkdirSync(dataDir, { recursive: true });
  return {
    apps: join(dataDir, "apps.db"),
    endpoints: join(dataDir, "endpoints.db"),
    messages: join(dataDir, "messages.db"),
    queue: join(dataDir, "queue.db"),
    attempts: join(dataDir, "attempts.db"),
    eventTypes: join(dataDir, "event-types.db"),
  };
}

/**
 * Wire a complete Posthorn gateway from a validated {@link GatewayConfig}. The
 * returned {@link Gateway} is constructed but not yet listening — call
 * {@link Gateway.start}. All SQLite backends share the lifetime of the
 * gateway and are closed together by {@link Gateway.stop}.
 */
export function createGateway(
  config: GatewayConfig,
  options: CreateGatewayOptions = {},
): Gateway {
  const locations = resolveLocations(config.dataDir);

  const apps = new SqliteAppStore({ location: locations.apps });
  const endpoints = new SqliteEndpointStore({ location: locations.endpoints });
  const messages = new SqliteMessageStore({ location: locations.messages });
  const queue = new SqliteDeliveryQueue({
    location: locations.queue,
    visibilityTimeoutMs: config.worker.visibilityTimeoutMs,
  });
  const attempts = new SqliteDeliveryAttemptStore({ location: locations.attempts });
  const eventTypes = new SqliteEventTypeStore({ location: locations.eventTypes });

  const metrics = new MetricsRegistry({ version: POSTHORN_VERSION });

  // Structured operational logging (JSON Lines → stdout at the configured level,
  // unless an embedder/test injects its own). Bind this gateway's identity —
  // `instance` (unique per process/replica) and `version` (the running build) —
  // onto the root so it rides every line, making logs from multiple replicas in one
  // aggregated stream correlatable. Each runtime component additionally tags its
  // entries with a `component` so the unified stream stays filterable.
  const instanceId = options.instanceId ?? randomUUID();
  const logger = (options.logger ?? createLogger({ level: config.logLevel })).child({
    instance: instanceId,
    version: POSTHORN_VERSION,
  });

  // The webhook delivery transport for every tenant-URL send (the worker's
  // continuous delivery loop and the `POST /v1/endpoints/:id/test` one-shot). It
  // POSTs over Node's built-in http/https with a connection-time SSRF guard on DNS
  // resolution — the deeper defense that catches a hostname resolving (or rebinding)
  // to a private/internal IP, which the registration-time guard cannot see. Governed
  // by the same POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS opt-out: when set, the guard
  // is a transparent pass-through. A connect-only deadline
  // (POSTHORN_WORKER_CONNECT_TIMEOUT_MS) bounds DNS + TCP connect under the worker's
  // total per-attempt deadline, so an unreachable endpoint fails fast.
  const deliveryTransport = createGuardedTransport(
    { allowPrivateNetworks: config.allowPrivateNetworks },
    { connectTimeoutMs: config.worker.connectTimeoutMs },
  );

  // System webhook delivery rides the **same** guarded transport as every tenant send:
  // the app's system webhook URL is operator-configured but still a stored, mutable
  // destination, so it gets the connection-time resolved-IP SSRF check and the
  // no-redirect-following behavior (a compromised receiver can't 3xx-redirect a signed
  // system event toward an internal address). Governed by the same
  // POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS opt-out as the delivery path. It also
  // inherits the worker's per-attempt request timeout, so a system webhook receiver
  // that accepts the connection but never responds cannot hold a socket open
  // indefinitely (a system event is a webhook POST like any other — same deadline).
  const systemEventTransport: SystemEventTransport = systemEventTransportFrom(deliveryTransport, {
    timeoutMs: config.worker.requestTimeoutMs,
  });

  const worker = new DeliveryWorker({
    queue,
    store: messages,
    resolveEndpoint: storeBackedResolver(endpoints, {
      defaultRateLimit: config.defaultRateLimit,
    }),
    transport: deliveryTransport,
    batchSize: config.worker.batchSize,
    concurrency: config.worker.concurrency,
    requestTimeoutMs: config.worker.requestTimeoutMs,
    idlePollMs: config.worker.idlePollMs,
    // Surface unexpected delivery-loop failures — a backend hiccup while settling,
    // or a best-effort audit/health/system-event write that threw — instead of
    // swallowing them. The worker's resilience still keeps the loop running; this
    // only makes the failure visible.
    onError: (err) => logger.error("delivery worker error", { component: "worker", err }),
    // Fold each tick's tally into the metrics counters.
    onTick: metrics.recordTick,
    // Append every attempt to the durable audit log (best-effort: a failed write
    // is routed to the worker's onError and never blocks a delivery).
    recordAttempt: async (attempt) => {
      await attempts.record(attempt);
    },
    // Fold each terminal delivery outcome into the target endpoint's health, so an
    // endpoint that fails continuously is automatically disabled (capping wasted
    // attempts/operations). When an auto-disable occurs, emit an `endpoint.disabled`
    // system webhook event to the app's configured system webhook URL (if any).
    // Best-effort: a failed health write is routed to the worker's onError and never
    // blocks a delivery.
    onDeliveryOutcome: async (endpointId, outcome, nowMs) => {
      const result = await endpoints.recordDeliveryOutcome(
        endpointId,
        outcome,
        nowMs,
        config.endpointAutoDisableAfterMs,
      );
      if (result.autoDisabled && result.endpoint !== null) {
        const webhookConfig = await apps.getSystemWebhookConfig(result.endpoint.appId);
        if (webhookConfig !== null) {
          await emitEndpointDisabledEvent(webhookConfig, result.endpoint, {
            transport: systemEventTransport,
            now: () => nowMs,
          });
        }
      }
    },
    // Emit a `message.dead_lettered` system webhook event when a delivery exhausts
    // all retry attempts. Best-effort: a failed emit is routed to the worker's
    // onError and never blocks or changes the delivery outcome.
    onDeadLettered: async (_taskId, messageId, endpointId, appId, nowMs) => {
      if (appId === null) return;
      const webhookConfig = await apps.getSystemWebhookConfig(appId);
      if (webhookConfig !== null) {
        await emitMessageDeadLetteredEvent(
          webhookConfig,
          { messageId, endpointId, appId },
          { transport: systemEventTransport, now: () => nowMs },
        );
      }
    },
  });

  const dispatcher = new FanoutDispatcher({
    messages,
    endpoints,
    queue,
    graceMs: config.fanout.graceMs,
    batchSize: config.fanout.batchSize,
    idlePollMs: config.fanout.idlePollMs,
    onError: (err) =>
      logger.error("fanout dispatcher error", { component: "dispatcher", err }),
  });

  const pruner =
    config.retentionDays > 0
      ? new DataPruner({
          attempts,
          queue,
          messages,
          retentionDays: config.retentionDays,
          onError: (err) => logger.error("data pruner error", { component: "pruner", err }),
        })
      : null;

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

  // The tenant dashboard is always wired — it uses the existing API-key auth so it
  // adds no new credential surface. A tenant logs in with their phk_… key and gets
  // a scoped session to browse their messages, deliveries, and attempt logs.
  const tenantDashboardHandler = createTenantDashboardHandler({
    apps,
    endpoints,
    messages,
    queue,
    attempts,
    sessions: new InMemoryTenantSessionStore(),
  });

  // The portal session store is shared between the JSON API (`POST /v1/portal/sessions`
  // mints sessions) and the portal handler (which validates them from cookies). Both
  // must reference the same store instance so the token exchange works correctly.
  const portalSessions = new InMemoryPortalSessionStore();

  // The consumer portal is always enabled — it adds no new credential surface beyond
  // the existing JSON API: a portal session can only be minted with a valid tenant API
  // key, and the portal itself only manages endpoints for the session's tenant.
  const portalHandler = createPortalHandler({
    endpoints,
    queue,
    sessions: portalSessions,
    eventTypes,
    allowPrivateNetworks: config.allowPrivateNetworks,
  });

  const httpServer = createHttpServer(
    {
      apps,
      endpoints,
      messages,
      queue,
      attempts,
      metrics,
      eventTypes,
      // SSRF guard policy for endpoint create/update (block private/internal
      // targets unless the operator opts in via POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS).
      allowPrivateNetworks: config.allowPrivateNetworks,
      // The one-shot test-send (POST /v1/endpoints/:id/test) hits a tenant URL too,
      // so it uses the same connection-time SSRF-guarded transport as the worker.
      transport: deliveryTransport,
      // Enable the admin/control-plane routes only when a token is configured; when
      // null they stay disabled (every /v1/admin/* route is 404).
      ...(config.adminToken !== null ? { adminToken: config.adminToken } : {}),
      // Always wire the portal session store so POST /v1/portal/sessions works.
      portalSessions,
    },
    {
      maxBodyBytes: config.maxBodyBytes,
      ...(dashboardHandler !== undefined ? { dashboardHandler } : {}),
      tenantDashboardHandler,
      portalHandler,
      // Access lines + unhandled-error reporting, tagged with the HTTP component.
      logger: logger.child({ component: "http" }),
    },
  );

  let runPromise: Promise<void> | null = null;
  let dispatcherRunPromise: Promise<void> | null = null;
  let prunerRunPromise: Promise<void> | null = null;
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
    if (pruner !== null) prunerRunPromise = pruner.run();

    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("gateway HTTP server is not bound to a TCP address");
    }
    const info = address as AddressInfo;
    // The canonical "service is up" marker — a structured line carrying the bound
    // address and data location, so the single most operationally useful event is in
    // the same parseable JSON stream as everything else (it used to be a human-only
    // `console.log` in the process shell, which broke JSON log ingestion).
    logger.info("gateway started", {
      component: "gateway",
      host: info.address,
      port: info.port,
      dataDir: config.dataDir,
    });
    return { host: info.address, port: info.port };
  };

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    worker.stop();
    dispatcher.stop();
    pruner?.stop();
    // run() swallows errors via its onError path; guard anyway so a stray
    // rejection never masks the rest of shutdown.
    await Promise.all(
      [runPromise, dispatcherRunPromise, prunerRunPromise].map((p) =>
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
    eventTypes.close();
    // The clean-shutdown marker. Guarded by `stopped`, so it fires exactly once even
    // though `stop()` is idempotent.
    logger.info("gateway stopped", { component: "gateway" });
  };

  return {
    apps,
    endpoints,
    messages,
    queue,
    attempts,
    eventTypes,
    worker,
    dispatcher,
    pruner,
    metrics,
    logger,
    httpServer,
    start,
    stop,
  };
}
