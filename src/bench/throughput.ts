// In-process throughput benchmark for the Posthorn pipeline.
//
// Boots a real gateway (in-memory store, running delivery worker) and a loopback fake
// receiver, provisions a tenant + endpoint, then measures two rates over a single bounded
// run:
//
//   ingest   — accepted POST /v1/messages (the 202 path: validate, persist, fan out)
//   delivery — signed webhooks the worker actually POSTs to the receiver, end-to-end
//
// This is a *pipeline* benchmark on loopback, not a network or disk benchmark: the receiver
// is in the same process and the store is `:memory:`, so the numbers characterize Posthorn's
// own overhead (ingest validation + fan-out, queue drain, signing, HTTP client) rather than
// the network between a real producer and a real receiver. The harness is pure (no stdout) so
// it is both the engine for the `bench/throughput.mjs` CLI and assertable from the gate
// (`throughput.test.ts` runs a small bounded version and checks it completes non-flakily).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { loadConfig } from "../runtime/config.js";
import { createGateway } from "../runtime/gateway.js";

export interface BenchOptions {
  /** Number of messages to ingest (each fans out to the one subscribed endpoint). */
  readonly messages: number;
  /** Approximate JSON payload size per message, in bytes. */
  readonly payloadBytes?: number;
  /** Concurrent in-flight POST /v1/messages requests during the ingest phase. */
  readonly ingestConcurrency?: number;
  /** Delivery-worker concurrency (POSTHORN_WORKER_CONCURRENCY); default = config default. */
  readonly workerConcurrency?: number;
  /** Delivery-worker claim batch size (POSTHORN_WORKER_BATCH_SIZE); default = config default. */
  readonly workerBatchSize?: number;
  /** Fail the run if every delivery hasn't landed within this budget. */
  readonly settleTimeoutMs?: number;
  /** Gateway log level; "silent" by default so the run is quiet. */
  readonly logLevel?: string;
}

export interface PhaseResult {
  /** Events counted in this phase (202s for ingest, receiver hits for delivery). */
  readonly count: number;
  /** Wall-clock window for the phase, in milliseconds. */
  readonly elapsedMs: number;
  /** Throughput: count per second over the window. */
  readonly perSec: number;
}

export interface BenchResult {
  readonly messages: number;
  readonly payloadBytes: number;
  readonly ingestConcurrency: number;
  readonly workerConcurrency: number;
  /** Accepted POST /v1/messages over the ingest window (first send → last 202). */
  readonly ingest: PhaseResult;
  /** Webhooks the worker delivered, measured end-to-end (first send → last receiver hit). */
  readonly delivery: PhaseResult & { readonly succeeded: number };
}

export const DEFAULT_PAYLOAD_BYTES = 256;
export const DEFAULT_INGEST_CONCURRENCY = 50;
export const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;

const BENCH_EVENT_TYPE = "bench.event";

interface FakeReceiver {
  readonly url: string;
  /** Resolves once `expected` requests have been received. */
  readonly allReceived: Promise<void>;
  count(): number;
  firstAt(): number | null;
  lastAt(): number | null;
  close(): Promise<void>;
}

// A loopback receiver that 200s every request, drains the body, counts hits, and resolves
// `allReceived` when it has seen `expected` of them. Records first/last arrival so the
// caller can bound the delivery window precisely.
function startFakeReceiver(expected: number): Promise<FakeReceiver> {
  let count = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let resolveAll!: () => void;
  const allReceived = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  const server: Server = createServer((req, res) => {
    req.resume(); // drain the body so the socket frees cleanly
    req.on("end", () => {
      const now = performance.now();
      if (firstAt === null) firstAt = now;
      lastAt = now;
      count += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      if (count === expected) resolveAll();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        allReceived,
        count: () => count,
        firstAt: () => firstAt,
        lastAt: () => lastAt,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

// Run `count` tasks with at most `limit` in flight at once — a tiny worker-pool so the
// ingest phase exerts real concurrency without opening `count` sockets simultaneously.
async function runPool(count: number, limit: number, fn: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, count));
  const workers = Array.from({ length: lanes }, async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      await fn(index);
    }
  });
  await Promise.all(workers);
}

// A JSON payload of roughly `bytes` size: a fixed envelope plus a filler string. The `seq`
// keeps each message distinct (no idempotency key is sent, so nothing deduplicates).
function makePayload(seq: number, bytes: number): Record<string, unknown> {
  const envelope = { seq, ts: 0, data: "" };
  const overhead = JSON.stringify(envelope).length;
  const fillerLen = Math.max(0, bytes - overhead);
  return { seq, ts: Date.now(), data: "x".repeat(fillerLen) };
}

/**
 * Boot a gateway + receiver, ingest `messages`, wait for every delivery, and return the
 * measured ingest and delivery throughput. Always tears the gateway and receiver down.
 */
export async function runThroughputBench(options: BenchOptions): Promise<BenchResult> {
  const messages = options.messages;
  if (!Number.isInteger(messages) || messages <= 0) {
    throw new TypeError(`messages must be a positive integer, got ${messages}`);
  }
  const payloadBytes = options.payloadBytes ?? DEFAULT_PAYLOAD_BYTES;
  const ingestConcurrency = options.ingestConcurrency ?? DEFAULT_INGEST_CONCURRENCY;
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;

  const receiver = await startFakeReceiver(messages);

  const env: Record<string, string> = {
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
    POSTHORN_LOG_LEVEL: options.logLevel ?? "silent",
    // Poll the queue aggressively so the worker starts draining almost immediately —
    // we are measuring pipeline cost, not idle-poll latency.
    POSTHORN_WORKER_IDLE_POLL_MS: "2",
  };
  if (options.workerConcurrency !== undefined) {
    env["POSTHORN_WORKER_CONCURRENCY"] = String(options.workerConcurrency);
  }
  if (options.workerBatchSize !== undefined) {
    env["POSTHORN_WORKER_BATCH_SIZE"] = String(options.workerBatchSize);
  }

  const config = loadConfig(env);
  const gateway = createGateway(config);

  try {
    const { port } = await gateway.start();
    const base = `http://127.0.0.1:${port}`;

    // Provision directly on the store: a bare app has an unlimited quota, so a large run
    // is never throttled by the freemium cap.
    const app = await gateway.apps.create({ name: "throughput-bench" });
    const { secret: apiKey } = await gateway.apps.createApiKey(app.id);
    const authHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };

    const createRes = await fetch(`${base}/v1/endpoints`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: receiver.url, eventTypes: [BENCH_EVENT_TYPE] }),
    });
    if (createRes.status !== 201) {
      throw new Error(`endpoint creation failed: HTTP ${createRes.status}`);
    }

    // Arm the settle guard before ingest so worker delivery (which overlaps ingest) is
    // covered too. A pipeline that wedges fails loudly instead of hanging the gate.
    const settle = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `delivery did not settle within ${settleTimeoutMs}ms: ` +
              `${receiver.count()}/${messages} received`,
          ),
        );
      }, settleTimeoutMs);
      // Don't let the guard keep the loop alive once delivery wins the race.
      void receiver.allReceived.finally(() => clearTimeout(timer));
    });

    // ── Ingest phase ───────────────────────────────────────────────────────────────
    const ingestStart = performance.now();
    let accepted = 0;
    await runPool(messages, ingestConcurrency, async (i) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ eventType: BENCH_EVENT_TYPE, payload: makePayload(i, payloadBytes) }),
      });
      if (res.status !== 202) {
        throw new Error(`ingest #${i} returned HTTP ${res.status}`);
      }
      // Drain the response body so undici frees the connection promptly.
      await res.arrayBuffer();
      accepted += 1;
    });
    const ingestEnd = performance.now();

    // ── Delivery phase ──────────────────────────────────────────────────────────────
    // The worker has been draining the queue throughout ingest; wait for the last hit.
    await Promise.race([receiver.allReceived, settle]);
    const lastAt = receiver.lastAt() ?? performance.now();

    const ingestElapsed = Math.max(ingestEnd - ingestStart, 0.001);
    const deliveryElapsed = Math.max(lastAt - ingestStart, 0.001);

    return {
      messages,
      payloadBytes,
      ingestConcurrency,
      workerConcurrency: config.worker.concurrency,
      ingest: {
        count: accepted,
        elapsedMs: ingestElapsed,
        perSec: (accepted / ingestElapsed) * 1000,
      },
      delivery: {
        count: receiver.count(),
        succeeded: receiver.count(),
        elapsedMs: deliveryElapsed,
        perSec: (receiver.count() / deliveryElapsed) * 1000,
      },
    };
  } finally {
    await gateway.stop();
    await receiver.close();
  }
}
