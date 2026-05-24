import { describe, expect, it, vi } from "vitest";
import {
  DeliveryWorker,
  MAX_RETRY_AFTER_MS,
  buildSignedRequest,
  isSuccessStatus,
  type DeliveryWorkerOptions,
  type EndpointResolver,
  type HttpDeliveryRequest,
  type HttpDeliveryResponse,
  type TickResult,
  type Transport,
} from "./delivery-worker.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import {
  StaleLeaseError,
  type DeliveryQueue,
  type DeliveryTask,
} from "../queue/delivery-queue.js";
import { fixedSchedule, type RetryPolicy } from "../delivery/retry-policy.js";
import { HEADERS, verify } from "../signing/webhook-signature.js";
import { type Message } from "../storage/message-store.js";
import { MAX_CAPTURED_BODY_BYTES, type NewDeliveryAttempt } from "../attempts/delivery-attempt.js";

// A fixed, valid base64 secret reused across the suite so signature round-trips
// against the real verifier are deterministic.
const SECRET = "whsec_dGVzdHNlY3JldGtleWZvcndlYmhvb2tzaWduaW5n";
// A second valid secret, standing in for one retired during a rotation overlap.
const OLD_SECRET = "whsec_b2xkc2VjcmV0a2V5cmV0aXJlZGR1cmluZ3JvdGF0aW9u";

const TARGET_URL = "https://example.test/hook";

/** The default resolver used by most tests: one fixed endpoint + secret. */
const resolveEndpoint: EndpointResolver = () => ({
  url: TARGET_URL,
  secret: SECRET,
});

/** A transport that records every request and returns a fixed status. */
function recordingTransport(status = 200): {
  transport: Transport;
  requests: { request: HttpDeliveryRequest; signal: AbortSignal }[];
} {
  const requests: { request: HttpDeliveryRequest; signal: AbortSignal }[] = [];
  const transport: Transport = async (request, signal) => {
    requests.push({ request, signal });
    return { status };
  };
  return { transport, requests };
}

interface EnvOptions {
  readonly retryPolicy?: RetryPolicy;
  readonly visibilityTimeoutMs?: number;
  readonly startMs?: number;
}

/** Wire a real in-memory store + queue sharing a single controllable clock. */
function setup(options: EnvOptions = {}) {
  let clock = options.startMs ?? 0;
  const now = (): number => clock;
  const setClock = (ms: number): void => {
    clock = ms;
  };

  let taskSeq = 0;
  let leaseSeq = 0;
  let msgSeq = 0;

  const store = new InMemoryMessageStore({
    now,
    generateId: () => `msg_${msgSeq++}`,
  });
  const queue = new InMemoryDeliveryQueue({
    now,
    generateId: () => `dtask_${taskSeq++}`,
    generateLeaseToken: () => `lease_${leaseSeq++}`,
    retryPolicy: options.retryPolicy ?? fixedSchedule([60_000]),
    visibilityTimeoutMs: options.visibilityTimeoutMs ?? 30_000,
  });

  return { now, setClock, store, queue };
}

function makeWorker(
  env: ReturnType<typeof setup>,
  overrides: Partial<DeliveryWorkerOptions> = {},
): DeliveryWorker {
  return new DeliveryWorker({
    queue: env.queue,
    store: env.store,
    resolveEndpoint,
    now: env.now,
    transport: recordingTransport().transport,
    ...overrides,
  });
}

describe("isSuccessStatus", () => {
  it("treats 2xx as success and everything else as failure", () => {
    for (const s of [200, 201, 202, 204, 299]) {
      expect(isSuccessStatus(s)).toBe(true);
    }
    for (const s of [100, 199, 300, 301, 400, 404, 500, 503]) {
      expect(isSuccessStatus(s)).toBe(false);
    }
  });
});

describe("buildSignedRequest", () => {
  const message: Message = {
    id: "msg_1",
    appId: "app_1",
    idempotencyKey: null,
    eventType: "user.created",
    payload: "BODY",
    channel: null,
    deliverAt: null,
    expiresAt: null,
    createdAt: 1_000,
  };

  it("produces Standard Webhooks headers and a receiver-verifiable signature", () => {
    const request = buildSignedRequest(
      message,
      { url: TARGET_URL, secret: SECRET },
      1_700_000_000_000,
    );
    expect(request.method).toBe("POST");
    expect(request.url).toBe(TARGET_URL);
    expect(request.body).toBe("BODY");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers[HEADERS.id]).toBe("msg_1");
    expect(request.headers[HEADERS.timestamp]).toBe("1700000000");
    expect(request.headers[HEADERS.signature]).toMatch(/^v1,/);

    expect(() =>
      verify(
        SECRET,
        {
          id: request.headers[HEADERS.id]!,
          timestamp: request.headers[HEADERS.timestamp]!,
          signature: request.headers[HEADERS.signature]!,
        },
        request.body,
        { now: 1_700_000_000 },
      ),
    ).not.toThrow();
  });

  it("uses the send time, not the message createdAt, for the timestamp", () => {
    const request = buildSignedRequest(
      message,
      { url: TARGET_URL, secret: SECRET },
      5_000,
    );
    expect(request.headers[HEADERS.timestamp]).toBe("5");
  });

  it("merges caller headers but never lets them override the webhook-* headers", () => {
    const request = buildSignedRequest(
      message,
      {
        url: TARGET_URL,
        secret: SECRET,
        headers: {
          "content-type": "text/plain",
          "x-custom": "1",
          [HEADERS.id]: "EVIL",
        },
      },
      1_000,
    );
    expect(request.headers["x-custom"]).toBe("1");
    expect(request.headers["content-type"]).toBe("text/plain");
    // The signed id cannot be spoofed by a caller-supplied header.
    expect(request.headers[HEADERS.id]).toBe("msg_1");
  });

  it("signs with every additionalSecret so the header verifies against the new AND old secret", () => {
    const request = buildSignedRequest(
      message,
      { url: TARGET_URL, secret: SECRET, additionalSecrets: [OLD_SECRET] },
      1_700_000_000_000,
    );
    // Two space-delimited v1 tokens — the Standard Webhooks multi-sign form.
    const header = request.headers[HEADERS.signature]!;
    expect(header.split(" ")).toHaveLength(2);
    expect(header.split(" ").every((t) => t.startsWith("v1,"))).toBe(true);

    const headers = {
      id: request.headers[HEADERS.id]!,
      timestamp: request.headers[HEADERS.timestamp]!,
      signature: header,
    };
    // The headline zero-downtime guarantee: a receiver on the NEW secret verifies…
    expect(() => verify(SECRET, headers, request.body, { now: 1_700_000_000 })).not.toThrow();
    // …and a receiver still on the OLD secret (mid-migration) also verifies.
    expect(() => verify(OLD_SECRET, headers, request.body, { now: 1_700_000_000 })).not.toThrow();
  });
});

describe("DeliveryWorker — construction", () => {
  const base = (): DeliveryWorkerOptions => ({
    queue: new InMemoryDeliveryQueue(),
    store: new InMemoryMessageStore(),
    resolveEndpoint,
  });

  it("rejects an invalid batchSize", () => {
    expect(() => new DeliveryWorker({ ...base(), batchSize: 0 })).toThrow(
      RangeError,
    );
    expect(() => new DeliveryWorker({ ...base(), batchSize: 1.5 })).toThrow(
      RangeError,
    );
  });

  it("rejects an invalid concurrency", () => {
    expect(() => new DeliveryWorker({ ...base(), concurrency: 0 })).toThrow(
      RangeError,
    );
    expect(() => new DeliveryWorker({ ...base(), concurrency: 2.5 })).toThrow(
      RangeError,
    );
  });

  it("rejects a non-positive requestTimeoutMs", () => {
    expect(
      () => new DeliveryWorker({ ...base(), requestTimeoutMs: 0 }),
    ).toThrow(RangeError);
  });

  it("rejects a negative idlePollMs", () => {
    expect(() => new DeliveryWorker({ ...base(), idlePollMs: -1 })).toThrow(
      RangeError,
    );
  });
});

describe("DeliveryWorker.processOnce", () => {
  it("does nothing on an empty queue", async () => {
    const env = setup();
    const { transport, requests } = recordingTransport(200);
    const worker = makeWorker(env, { transport });

    const result = await worker.processOnce();
    expect(result).toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
      stale: 0,
    });
    expect(requests).toHaveLength(0);
  });

  it("delivers a message end-to-end and the receiver can verify the signature", async () => {
    const env = setup();
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "user.created",
      payload: '{"hello":"world"}',
    });
    await env.queue.enqueue({ messageId: message.id });

    const { transport, requests } = recordingTransport(200);
    const worker = makeWorker(env, { transport });

    const result = await worker.processOnce();
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("succeeded");

    expect(requests).toHaveLength(1);
    const { request } = requests[0]!;
    expect(request.url).toBe(TARGET_URL);
    expect(request.body).toBe('{"hello":"world"}');

    // The crown jewel: the bytes the worker emits verify against the real
    // verifier using the endpoint secret — the full sign→deliver→verify loop.
    const ts = Number(request.headers[HEADERS.timestamp]);
    expect(() =>
      verify(
        SECRET,
        {
          id: request.headers[HEADERS.id]!,
          timestamp: request.headers[HEADERS.timestamp]!,
          signature: request.headers[HEADERS.signature]!,
        },
        request.body,
        { now: ts },
      ),
    ).not.toThrow();
    expect(request.headers[HEADERS.id]).toBe(message.id);
  });

  it("passes a live (un-aborted) AbortSignal to the transport", async () => {
    const env = setup();
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    let seen: AbortSignal | null = null;
    const transport: Transport = async (_request, signal) => {
      seen = signal;
      return { status: 200 };
    };
    await makeWorker(env, { transport }).processOnce();
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
  });

  it("reschedules a failed (non-2xx) attempt for a future retry", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    const { transport } = recordingTransport(500);
    const worker = makeWorker(env, { transport });

    const result = await worker.processOnce();
    expect(result).toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      deadLettered: 0,
    });

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    expect(task?.attempts).toBe(1);
    expect(task?.nextAttemptAt).toBe(60_000); // now(0) + 60s delay
    expect(task?.lastError).toContain("HTTP 500");
  });

  it("dead-letters once the retry schedule is exhausted", async () => {
    const env = setup({ retryPolicy: fixedSchedule([]) }); // 1 attempt, no retries
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    const { transport } = recordingTransport(503);
    const worker = makeWorker(env, { transport });

    const result = await worker.processOnce();
    expect(result).toMatchObject({ claimed: 1, deadLettered: 1, failed: 0 });

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("dead_letter");
    expect(task?.lastError).toContain("HTTP 503");
  });

  it("treats a thrown transport error as a failed attempt", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    const transport: Transport = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await makeWorker(env, { transport }).processOnce();
    expect(result.failed).toBe(1);

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    expect(task?.lastError).toContain("ECONNREFUSED");
  });

  it("fails the attempt (no HTTP call) when the message is missing", async () => {
    const env = setup({ retryPolicy: fixedSchedule([]) });
    await env.queue.enqueue({ messageId: "msg_nonexistent" });

    const { transport, requests } = recordingTransport(200);
    const result = await makeWorker(env, { transport }).processOnce();

    expect(requests).toHaveLength(0);
    expect(result.deadLettered).toBe(1);
    const task = await env.queue.get("dtask_0");
    expect(task?.lastError).toContain("not found");
  });

  it("fails the attempt (no HTTP call) when no endpoint resolves", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    const { transport, requests } = recordingTransport(200);
    const result = await makeWorker(env, {
      transport,
      resolveEndpoint: () => null,
    }).processOnce();

    expect(requests).toHaveLength(0);
    expect(result.failed).toBe(1);
    const task = await env.queue.get("dtask_0");
    expect(task?.lastError).toContain("no endpoint");
  });

  it("dead-letters immediately (no HTTP call) when the message has expired", async () => {
    // expiresAt is in the past (1_000ms), worker tick is at 2_000ms.
    const env = setup({ startMs: 2_000, retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
      expiresAt: 1_000,
    });
    await env.queue.enqueue({ messageId: message.id });

    const { transport, requests } = recordingTransport(200);
    const result = await makeWorker(env, { transport }).processOnce();

    expect(requests).toHaveLength(0); // no HTTP call
    expect(result.deadLettered).toBe(1); // dead-lettered without retry
    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("dead_letter");
    expect(task?.lastError).toContain("expired");
  });

  it("delivers normally when expiresAt is in the future", async () => {
    const env = setup({ startMs: 1_000, retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
      expiresAt: 9_000, // expires well in the future
    });
    await env.queue.enqueue({ messageId: message.id });

    const { transport, requests } = recordingTransport(200);
    const result = await makeWorker(env, { transport }).processOnce();

    expect(requests).toHaveLength(1); // HTTP call was made
    expect(result.succeeded).toBe(1);
  });

  it("supports an async endpoint resolver", async () => {
    const env = setup();
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    const { transport, requests } = recordingTransport(200);
    const result = await makeWorker(env, {
      transport,
      resolveEndpoint: async () => ({ url: TARGET_URL, secret: SECRET }),
    }).processOnce();

    expect(result.succeeded).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("claims at most batchSize tasks per tick", async () => {
    const env = setup();
    for (let i = 0; i < 5; i++) {
      const { message } = await env.store.create({
        appId: "app_1",
        eventType: "e",
        payload: String(i),
      });
      await env.queue.enqueue({ messageId: message.id });
    }
    const { transport, requests } = recordingTransport(200);
    const worker = makeWorker(env, { transport, batchSize: 2 });

    expect((await worker.processOnce()).claimed).toBe(2);
    expect((await worker.processOnce()).claimed).toBe(2);
    expect((await worker.processOnce()).claimed).toBe(1);
    expect((await worker.processOnce()).claimed).toBe(0);
    expect(requests).toHaveLength(5);
  });

  it("absorbs a lapsed-lease reclaim as 'stale' and does not double-settle", async () => {
    const env = setup({ visibilityTimeoutMs: 1_000 });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    // The attempt runs long: time passes the lease and a second worker reclaims
    // the task (minting a fresh lease) before this attempt returns success.
    const transport: Transport = async () => {
      env.setClock(5_000); // past the 1s lease
      const reclaimed = await env.queue.claimDue({ nowMs: env.now() });
      expect(reclaimed).toHaveLength(1);
      return { status: 200 };
    };

    const result = await makeWorker(env, { transport }).processOnce();
    expect(result).toMatchObject({ claimed: 1, succeeded: 0, stale: 1 });

    // Still delivering under the reclaiming worker's lease — not completed.
    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("delivering");
  });

  it("propagates an unexpected (non-stale) settle error", async () => {
    const env = setup();
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    const claimedTask: DeliveryTask = {
      id: "dtask_x",
      messageId: message.id,
      endpointId: null,
      appId: null,
      status: "delivering",
      attempts: 1,
      nextAttemptAt: null,
      leaseExpiresAt: 30_000,
      leaseToken: "tok",
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const boom = new Error("backend on fire");
    const stubQueue: DeliveryQueue = {
      enqueue: async () => claimedTask,
      claimDue: async () => [claimedTask],
      complete: async () => {
        throw boom;
      },
      fail: async () => {
        throw boom;
      },
      retry: async () => claimedTask,
      cancel: async () => claimedTask,
      get: async () => claimedTask,
      listByMessage: async () => [claimedTask],
      listByEndpoint: async () => ({ deliveries: [], nextCursor: null }),
      listByApp: async () => ({ deliveries: [], nextCursor: null }),
      pruneTerminalTasks: async () => 0,
      countByStatus: async () => ({
        pending: 0,
        delivering: 1,
        succeeded: 0,
        dead_letter: 0,
        cancelled: 0,
      }),
    };
    const worker = new DeliveryWorker({
      queue: stubQueue,
      store: env.store,
      resolveEndpoint,
      now: env.now,
      transport: recordingTransport(200).transport,
    });
    await expect(worker.processOnce()).rejects.toThrow("backend on fire");
  });

  it("aborts an attempt that exceeds requestTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const env = setup({ retryPolicy: fixedSchedule([]) });
      const { message } = await env.store.create({
        appId: "app_1",
        eventType: "e",
        payload: "{}",
      });
      await env.queue.enqueue({ messageId: message.id });

      // Never resolves on its own — only the timeout abort ends it.
      const transport: Transport = (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("request aborted by timeout"));
          });
        });

      const worker = makeWorker(env, { transport, requestTimeoutMs: 5_000 });
      const pending = worker.processOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toMatchObject({ claimed: 1, deadLettered: 1 });
      const task = await env.queue.get("dtask_0");
      expect(task?.status).toBe("dead_letter");
      expect(task?.lastError).toContain("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports each tick's tally to onTick (the metrics seam)", async () => {
    const env = setup();
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    const ticks: TickResult[] = [];
    const worker = makeWorker(env, {
      transport: recordingTransport(200).transport,
      onTick: (result) => ticks.push(result),
    });

    const result = await worker.processOnce();
    expect(ticks).toEqual([result]);
    expect(ticks[0]).toMatchObject({ claimed: 1, succeeded: 1 });

    // An idle tick is still reported (claimed 0), so a liveness counter advances.
    await worker.processOnce();
    expect(ticks).toHaveLength(2);
    expect(ticks[1]).toMatchObject({ claimed: 0, succeeded: 0 });
  });
});

describe("DeliveryWorker — bounded concurrency", () => {
  /** A macrotask boundary that drains all pending microtasks (and the in-memory
   * store's resolved promises), so the pumps advance to their next transport call. */
  const drain = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  async function enqueueN(env: ReturnType<typeof setup>, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const { message } = await env.store.create({
        appId: "app_1",
        eventType: "e",
        payload: String(i),
      });
      await env.queue.enqueue({ messageId: message.id });
    }
  }

  /** A transport that parks each send until its stored `release` is called, while
   * tracking the number of concurrently in-flight sends. */
  function gatedTransport(): {
    transport: Transport;
    releases: (() => void)[];
    maxInFlight: () => number;
  } {
    let inFlight = 0;
    let max = 0;
    const releases: (() => void)[] = [];
    const transport: Transport = () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      return new Promise<HttpDeliveryResponse>((resolve) => {
        releases.push(() => {
          inFlight -= 1;
          resolve({ status: 200 });
        });
      });
    };
    return { transport, releases, maxInFlight: () => max };
  }

  it("delivers a batch in parallel but never exceeds the concurrency limit", async () => {
    const env = setup();
    await enqueueN(env, 5);
    const { transport, releases, maxInFlight } = gatedTransport();
    const worker = makeWorker(env, { transport, batchSize: 5, concurrency: 2 });

    const pending = worker.processOnce();

    // First wave: exactly `concurrency` sends are in flight; the rest wait a slot.
    await drain();
    expect(releases).toHaveLength(2);

    // Free one slot at a time; each completion pulls the next task, so the pool
    // stays saturated at the limit until the whole batch drains.
    for (let i = 0; i < releases.length; i++) {
      releases[i]!();
      await drain();
    }

    const result = await pending;
    expect(result).toMatchObject({ claimed: 5, succeeded: 5, failed: 0 });
    expect(releases).toHaveLength(5); // all five eventually sent
    expect(maxInFlight()).toBe(2); // but never more than two at once
  });

  it("with concurrency 1 delivers strictly sequentially (one in flight at a time)", async () => {
    const env = setup();
    await enqueueN(env, 3);
    const { transport, releases, maxInFlight } = gatedTransport();
    const worker = makeWorker(env, { transport, batchSize: 3, concurrency: 1 });

    const pending = worker.processOnce();
    await drain();
    expect(releases).toHaveLength(1); // only one ever in flight

    for (let i = 0; i < releases.length; i++) {
      releases[i]!();
      await drain();
    }

    const result = await pending;
    expect(result).toMatchObject({ claimed: 3, succeeded: 3 });
    expect(maxInFlight()).toBe(1);
  });

  it("does not let one slow receiver block the rest of the batch (no head-of-line blocking)", async () => {
    const env = setup();
    // Task 0 targets a receiver that hangs; tasks 1 and 2 respond immediately.
    const { message: m0 } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "SLOW",
    });
    await env.queue.enqueue({ messageId: m0.id });
    for (let i = 0; i < 2; i++) {
      const { message } = await env.store.create({
        appId: "app_1",
        eventType: "e",
        payload: "FAST",
      });
      await env.queue.enqueue({ messageId: message.id });
    }

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let fastCompleted = 0;
    const transport: Transport = async (request) => {
      if (request.body === "SLOW") {
        await slowGate;
      } else {
        fastCompleted += 1;
      }
      return { status: 200 };
    };

    const worker = makeWorker(env, { transport, batchSize: 3, concurrency: 3 });
    const pending = worker.processOnce();

    // Both FAST deliveries finish while SLOW is still hanging — the proof that a
    // stuck receiver no longer stalls the deliveries behind it.
    await drain();
    expect(fastCompleted).toBe(2);

    releaseSlow();
    const result = await pending;
    expect(result).toMatchObject({ claimed: 3, succeeded: 3 });
  });

  it("caps in-flight sends at the concurrency limit even when the batch is larger", async () => {
    const env = setup();
    await enqueueN(env, 6);
    const { transport, releases, maxInFlight } = gatedTransport();
    const worker = makeWorker(env, { transport, batchSize: 6, concurrency: 3 });

    const pending = worker.processOnce();
    await drain();
    expect(releases).toHaveLength(3);

    for (let i = 0; i < releases.length; i++) {
      releases[i]!();
      await drain();
    }

    const result = await pending;
    expect(result).toMatchObject({ claimed: 6, succeeded: 6 });
    expect(maxInFlight()).toBe(3);
  });
});

describe("DeliveryWorker — recordAttempt (audit log)", () => {
  /** A sink that captures every attempt the worker reports. */
  function collector(): {
    recordAttempt: (a: NewDeliveryAttempt) => void;
    attempts: NewDeliveryAttempt[];
  } {
    const attempts: NewDeliveryAttempt[] = [];
    return {
      recordAttempt: (a) => {
        attempts.push(a);
      },
      attempts,
    };
  }

  async function enqueueOne(env: ReturnType<typeof setup>): Promise<Message> {
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id, endpointId: "ep_1" });
    return message;
  }

  it("records a succeeded attempt with its status, number, and endpoint", async () => {
    const env = setup({ startMs: 1_700_000_000_000 });
    const message = await enqueueOne(env);
    const { recordAttempt, attempts } = collector();

    await makeWorker(env, {
      transport: recordingTransport(200).transport,
      recordAttempt,
    }).processOnce();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      taskId: "dtask_0",
      messageId: message.id,
      appId: "app_1",
      endpointId: "ep_1",
      attemptNumber: 1,
      outcome: "succeeded",
      responseStatus: 200,
      error: null,
      attemptedAt: 1_700_000_000_000,
    });
    expect(attempts[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records the delivered message's tenant (appId) on the attempt", async () => {
    const env = setup();
    // A message owned by a specific tenant.
    const { message } = await env.store.create({
      appId: "app_tenant_7",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id, endpointId: "ep_1" });
    const { recordAttempt, attempts } = collector();

    await makeWorker(env, {
      transport: recordingTransport(200).transport,
      recordAttempt,
    }).processOnce();

    expect(attempts[0]!.appId).toBe("app_tenant_7");
  });

  it("records a null tenant when the message has vanished (no appId to attribute)", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    // A task whose message was never stored: #deliver loads null, so the attempt
    // belongs to no tenant (and is excluded from per-tenant delivery usage).
    await env.queue.enqueue({ messageId: "msg_gone", endpointId: "ep_1" });
    const { recordAttempt, attempts } = collector();

    await makeWorker(env, {
      transport: recordingTransport(200).transport,
      recordAttempt,
    }).processOnce();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ appId: null, outcome: "failed" });
    expect(attempts[0]!.error).toContain("not found");
  });

  it("records a failed (non-2xx) attempt with the status and error", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);
    const { recordAttempt, attempts } = collector();

    await makeWorker(env, {
      transport: recordingTransport(503).transport,
      recordAttempt,
    }).processOnce();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: "failed",
      responseStatus: 503,
    });
    expect(attempts[0]!.error).toContain("HTTP 503");
  });

  it("records a transport throw as a failed attempt with a null status", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);
    const { recordAttempt, attempts } = collector();

    const transport: Transport = async () => {
      throw new Error("ECONNREFUSED");
    };
    await makeWorker(env, { transport, recordAttempt }).processOnce();

    expect(attempts[0]).toMatchObject({ outcome: "failed", responseStatus: null });
    expect(attempts[0]!.error).toContain("ECONNREFUSED");
  });

  it("records a pre-flight failure (no endpoint resolved) with no send and zero duration", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);
    const { recordAttempt, attempts } = collector();

    await makeWorker(env, {
      transport: recordingTransport(200).transport,
      resolveEndpoint: () => null,
      recordAttempt,
    }).processOnce();

    expect(attempts[0]).toMatchObject({
      outcome: "failed",
      responseStatus: null,
      durationMs: 0,
    });
    expect(attempts[0]!.error).toContain("no endpoint");
  });

  it("captures attempt latency from the clock around the send", async () => {
    const env = setup({ startMs: 1_000, visibilityTimeoutMs: 1_000_000 });
    await enqueueOne(env);
    const { recordAttempt, attempts } = collector();

    // The transport "takes" 250ms of wall-clock before returning.
    const transport: Transport = async () => {
      env.setClock(1_250);
      return { status: 200 };
    };
    await makeWorker(env, { transport, recordAttempt }).processOnce();

    expect(attempts[0]!.durationMs).toBe(250);
    // attemptedAt stays the tick instant, not the post-send time.
    expect(attempts[0]!.attemptedAt).toBe(1_000);
  });

  it("numbers attempts 1, 2, … across retries", async () => {
    const env = setup({ startMs: 0, retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);
    const { recordAttempt, attempts } = collector();
    const worker = makeWorker(env, {
      transport: recordingTransport(500).transport,
      recordAttempt,
    });

    await worker.processOnce(); // attempt 1 fails → retry scheduled at 60_000
    env.setClock(60_000);
    await worker.processOnce(); // attempt 2

    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
  });

  it("treats recording as best-effort: a thrown record never breaks delivery", async () => {
    const env = setup();
    await enqueueOne(env);
    const errors: unknown[] = [];
    const boom = new Error("audit store down");

    const result = await makeWorker(env, {
      transport: recordingTransport(200).transport,
      recordAttempt: () => {
        throw boom;
      },
      onError: (e) => errors.push(e),
    }).processOnce();

    // The delivery still succeeded; the audit failure was routed to onError.
    expect(result).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await env.queue.get("dtask_0")).toMatchObject({ status: "succeeded" });
    expect(errors).toEqual([boom]);
  });

  it("records nothing (and does not fail) when no recordAttempt seam is wired", async () => {
    const env = setup();
    await enqueueOne(env);
    const result = await makeWorker(env, {
      transport: recordingTransport(200).transport,
    }).processOnce();
    expect(result).toMatchObject({ claimed: 1, succeeded: 1 });
  });
});

describe("DeliveryWorker — body capture", () => {
  function collector(): {
    recordAttempt: (a: NewDeliveryAttempt) => void;
    attempts: NewDeliveryAttempt[];
  } {
    const attempts: NewDeliveryAttempt[] = [];
    return {
      recordAttempt: (a) => {
        attempts.push(a);
      },
      attempts,
    };
  }

  async function enqueueOne(
    env: ReturnType<typeof setup>,
    payload = "{}",
  ): Promise<Message> {
    const { message } = await env.store.create({ appId: "app_1", eventType: "e", payload });
    await env.queue.enqueue({ messageId: message.id, endpointId: "ep_1" });
    return message;
  }

  it("captures the request body (signed payload) on a successful delivery", async () => {
    const env = setup();
    const message = await enqueueOne(env, '{"hello":"world"}');
    const { recordAttempt, attempts } = collector();
    await makeWorker(env, {
      transport: async () => ({ status: 200 }),
      recordAttempt,
    }).processOnce();
    expect(attempts[0]!.requestBody).toBe(message.payload);
  });

  it("captures the response body returned by the transport", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);
    const { recordAttempt, attempts } = collector();
    await makeWorker(env, {
      transport: async () => ({ status: 503, responseBody: "Service Unavailable" }),
      recordAttempt,
    }).processOnce();
    expect(attempts[0]!.responseBody).toBe("Service Unavailable");
  });

  it("records null requestBody and null responseBody on a pre-flight failure (no send)", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);
    const { recordAttempt, attempts } = collector();
    await makeWorker(env, {
      transport: async () => ({ status: 200 }),
      resolveEndpoint: () => null,
      recordAttempt,
    }).processOnce();
    expect(attempts[0]!.requestBody).toBeNull();
    expect(attempts[0]!.responseBody).toBeNull();
  });

  it("records null responseBody on a transport error (no response object)", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env, '{"key":"val"}');
    const { recordAttempt, attempts } = collector();
    const transport: Transport = async () => {
      throw new Error("ECONNREFUSED");
    };
    await makeWorker(env, { transport, recordAttempt }).processOnce();
    // Request was built (and signed) before the send threw — payload is captured.
    expect(attempts[0]!.requestBody).toBe('{"key":"val"}');
    // No response arrived — responseBody is null.
    expect(attempts[0]!.responseBody).toBeNull();
  });

  it("truncates requestBody at MAX_CAPTURED_BODY_BYTES", async () => {
    const env = setup();
    const longPayload = "x".repeat(MAX_CAPTURED_BODY_BYTES + 100);
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: longPayload,
    });
    await env.queue.enqueue({ messageId: message.id, endpointId: "ep_1" });
    const { recordAttempt, attempts } = collector();
    await makeWorker(env, {
      transport: async () => ({ status: 200 }),
      recordAttempt,
    }).processOnce();
    expect(attempts[0]!.requestBody).toHaveLength(MAX_CAPTURED_BODY_BYTES);
  });

  it("truncates responseBody longer than MAX_CAPTURED_BODY_BYTES", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);
    const { recordAttempt, attempts } = collector();
    const longBody = "y".repeat(MAX_CAPTURED_BODY_BYTES + 50);
    await makeWorker(env, {
      transport: async () => ({ status: 503, responseBody: longBody }),
      recordAttempt,
    }).processOnce();
    expect(attempts[0]!.responseBody).toHaveLength(MAX_CAPTURED_BODY_BYTES);
  });
});

describe("DeliveryWorker — onDeliveryOutcome (endpoint health)", () => {
  /** A sink capturing every terminal outcome the worker reports. */
  function collector(): {
    onDeliveryOutcome: (id: string, outcome: "succeeded" | "failed", now: number) => void;
    reports: { id: string; outcome: "succeeded" | "failed"; now: number }[];
  } {
    const reports: { id: string; outcome: "succeeded" | "failed"; now: number }[] = [];
    return {
      onDeliveryOutcome: (id, outcome, now) => {
        reports.push({ id, outcome, now });
      },
      reports,
    };
  }

  async function enqueueFor(env: ReturnType<typeof setup>, endpointId: string | null): Promise<void> {
    const { message } = await env.store.create({ appId: "app_1", eventType: "e", payload: "{}" });
    await env.queue.enqueue({ messageId: message.id, endpointId });
  }

  it("reports a 2xx delivery as a succeeded terminal outcome (with endpoint + tick instant)", async () => {
    const env = setup({ startMs: 1_700_000_000_000 });
    await enqueueFor(env, "ep_1");
    const { onDeliveryOutcome, reports } = collector();

    await makeWorker(env, {
      transport: recordingTransport(200).transport,
      onDeliveryOutcome,
    }).processOnce();

    expect(reports).toEqual([
      { id: "ep_1", outcome: "succeeded", now: 1_700_000_000_000 },
    ]);
  });

  it("reports a dead-letter as a failed terminal outcome", async () => {
    const env = setup({ startMs: 5_000, retryPolicy: fixedSchedule([]) }); // 1 attempt → dead-letter
    await enqueueFor(env, "ep_1");
    const { onDeliveryOutcome, reports } = collector();

    const result = await makeWorker(env, {
      transport: recordingTransport(503).transport,
      onDeliveryOutcome,
    }).processOnce();

    expect(result).toMatchObject({ deadLettered: 1 });
    expect(reports).toEqual([{ id: "ep_1", outcome: "failed", now: 5_000 }]);
  });

  it("does NOT report a failed attempt that will be retried (not yet terminal)", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) }); // a retry is scheduled
    await enqueueFor(env, "ep_1");
    const { onDeliveryOutcome, reports } = collector();

    const result = await makeWorker(env, {
      transport: recordingTransport(503).transport,
      onDeliveryOutcome,
    }).processOnce();

    expect(result).toMatchObject({ failed: 1, deadLettered: 0 });
    expect(reports).toEqual([]); // nothing terminal happened
  });

  it("does NOT report when the task carries no endpointId", async () => {
    const env = setup();
    await enqueueFor(env, null);
    const { onDeliveryOutcome, reports } = collector();

    await makeWorker(env, {
      transport: recordingTransport(200).transport,
      onDeliveryOutcome,
    }).processOnce();

    expect(reports).toEqual([]);
  });

  it("is best-effort: a thrown report never breaks the delivery", async () => {
    const env = setup();
    await enqueueFor(env, "ep_1");
    const errors: unknown[] = [];
    const boom = new Error("endpoint store down");

    const result = await makeWorker(env, {
      transport: recordingTransport(200).transport,
      onDeliveryOutcome: () => {
        throw boom;
      },
      onError: (e) => errors.push(e),
    }).processOnce();

    expect(result).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await env.queue.get("dtask_0")).toMatchObject({ status: "succeeded" });
    expect(errors).toEqual([boom]);
  });

  it("auto-disables a continuously-failing endpoint end-to-end (worker → store → resolver declines)", async () => {
    // Wire a real endpoint store + the store-backed resolver, sharing the worker's clock,
    // so the whole loop (deliver → dead-letter → record health → auto-disable → resolver
    // then declines) runs through the production seams.
    const env = setup({ startMs: 0, retryPolicy: fixedSchedule([]) }); // each delivery dead-letters in one attempt
    const endpoints = new InMemoryEndpointStore({ now: env.now });
    const ep = await endpoints.create({ appId: "app_1", url: "https://dead.test/hook" });
    const window = 100_000;

    const worker = makeWorker(env, {
      transport: recordingTransport(500).transport, // the receiver is dead
      resolveEndpoint: storeBackedResolver(endpoints, { now: env.now }),
      onDeliveryOutcome: async (id, outcome, now) => {
        await endpoints.recordDeliveryOutcome(id, outcome, now, window);
      },
    });

    // Helper: enqueue a fresh message to this endpoint and run one tick.
    const sendOne = async (): Promise<void> => {
      const { message } = await env.store.create({ appId: "app_1", eventType: "e", payload: "{}" });
      await env.queue.enqueue({ messageId: message.id, endpointId: ep.id });
      await worker.processOnce();
    };

    // First failed delivery opens the streak; not yet disabled.
    await sendOne();
    expect((await endpoints.get(ep.id))!.disabled).toBe(false);
    expect((await endpoints.get(ep.id))!.consecutiveFailures).toBe(1);

    // After the window has elapsed, the next dead-letter auto-disables the endpoint.
    env.setClock(window);
    await sendOne();
    const disabled = (await endpoints.get(ep.id))!;
    expect(disabled.disabled).toBe(true);
    expect(disabled.consecutiveFailures).toBe(2);

    // The store-backed resolver now declines the disabled endpoint, so a subsequent
    // delivery makes no HTTP attempt — runaway delivery to the dead endpoint has stopped.
    const { message } = await env.store.create({ appId: "app_1", eventType: "e", payload: "{}" });
    await env.queue.enqueue({ messageId: message.id, endpointId: ep.id });
    const { transport, requests } = recordingTransport(500);
    env.setClock(window + 1);
    await makeWorker(env, {
      transport,
      resolveEndpoint: storeBackedResolver(endpoints, { now: env.now }),
    }).processOnce();
    expect(requests).toHaveLength(0); // resolver declined → no POST sent
  });
});

describe("DeliveryWorker — onDeadLettered seam", () => {
  /** Enqueue a fresh message for an optional endpointId; returns the message id. */
  async function enqueueMsg(
    env: ReturnType<typeof setup>,
    endpointId: string | null = null,
    appId = "app_1",
  ): Promise<string> {
    const { message } = await env.store.create({ appId, eventType: "e", payload: "{}" });
    await env.queue.enqueue({ messageId: message.id, endpointId, appId });
    return message.id;
  }

  it("is called with taskId/messageId/endpointId/appId/nowMs on dead-letter", async () => {
    const env = setup({ startMs: 5_000, retryPolicy: fixedSchedule([]) }); // 1 attempt → dead-letter
    const messageId = await enqueueMsg(env, "ep_1", "app_abc");

    const calls: unknown[] = [];
    const result = await makeWorker(env, {
      transport: recordingTransport(503).transport,
      onDeadLettered: (taskId, mid, eid, aid, nowMs) => {
        calls.push({ taskId, mid, eid, aid, nowMs });
      },
    }).processOnce();

    expect(result).toMatchObject({ deadLettered: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      mid: messageId,
      eid: "ep_1",
      aid: "app_abc",
      nowMs: 5_000,
    });
    expect(typeof (calls[0] as { taskId: string }).taskId).toBe("string");
  });

  it("is NOT called on a successful delivery", async () => {
    const env = setup();
    await enqueueMsg(env, "ep_1");

    const calls: unknown[] = [];
    await makeWorker(env, {
      transport: recordingTransport(200).transport,
      onDeadLettered: (...args) => { calls.push(args); },
    }).processOnce();

    expect(calls).toHaveLength(0);
  });

  it("is NOT called for a retryable failed attempt (not yet terminal)", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) }); // a retry is scheduled
    await enqueueMsg(env, "ep_1");

    const calls: unknown[] = [];
    const result = await makeWorker(env, {
      transport: recordingTransport(503).transport,
      onDeadLettered: (...args) => { calls.push(args); },
    }).processOnce();

    expect(result).toMatchObject({ failed: 1, deadLettered: 0 });
    expect(calls).toHaveLength(0);
  });

  it("is best-effort: a thrown call never breaks the delivery", async () => {
    const env = setup({ retryPolicy: fixedSchedule([]) }); // 1 attempt → dead-letter
    await enqueueMsg(env, "ep_1");
    const errors: unknown[] = [];
    const boom = new Error("system event transport down");

    const result = await makeWorker(env, {
      transport: recordingTransport(503).transport,
      onDeadLettered: () => { throw boom; },
      onError: (e) => errors.push(e),
    }).processOnce();

    expect(result).toMatchObject({ deadLettered: 1 });
    expect(errors).toEqual([boom]);
  });
});

describe("DeliveryWorker — Retry-After support", () => {
  /** Build a transport that returns the given status + optional Retry-After header. */
  function retryAfterTransport(
    status: number,
    retryAfter?: string,
  ): Transport {
    return async () => ({
      status,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    });
  }

  it("clamps nextAttemptAt when Retry-After (seconds) exceeds the policy delay", async () => {
    // Policy: one retry at 1_000ms. Retry-After: 30s > 1s → floor wins.
    const env = setup({ retryPolicy: fixedSchedule([1_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    await makeWorker(env, {
      transport: retryAfterTransport(503, "30"),
    }).processOnce();

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    // nowMs = 0; Retry-After = 30s = 30_000ms > policy 1_000ms.
    expect(task?.nextAttemptAt).toBe(30_000);
  });

  it("uses the policy delay when Retry-After is smaller", async () => {
    // Policy: one retry at 60_000ms. Retry-After: 5s < 60s → policy wins.
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    await makeWorker(env, {
      transport: retryAfterTransport(503, "5"),
    }).processOnce();

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    // Policy 60_000ms > Retry-After 5_000ms → policy wins.
    expect(task?.nextAttemptAt).toBe(60_000);
  });

  it("ignores a malformed Retry-After header", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    await makeWorker(env, {
      transport: retryAfterTransport(503, "not-a-number"),
    }).processOnce();

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    // Malformed → no floor → pure policy delay.
    expect(task?.nextAttemptAt).toBe(60_000);
  });

  it("ignores Retry-After on a successful (2xx) response", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    await makeWorker(env, {
      transport: retryAfterTransport(200, "30"),
    }).processOnce();

    const task = await env.queue.get("dtask_0");
    // Success → succeeded, Retry-After irrelevant.
    expect(task?.status).toBe("succeeded");
  });

  it("caps Retry-After at MAX_RETRY_AFTER_MS", async () => {
    const env = setup({ retryPolicy: fixedSchedule([1_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    // Receiver asks for 2 days (172_800s > MAX of 86_400s).
    await makeWorker(env, {
      transport: retryAfterTransport(429, "172800"),
    }).processOnce();

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    expect(task?.nextAttemptAt).toBe(MAX_RETRY_AFTER_MS); // capped at 24h from nowMs=0
  });

  it("dead-letters even when Retry-After is present (budget exhausted)", async () => {
    // Only one attempt allowed (no retries). Retry-After cannot prevent dead-lettering.
    const env = setup({ retryPolicy: fixedSchedule([]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    await makeWorker(env, {
      transport: retryAfterTransport(503, "30"),
    }).processOnce();

    const task = await env.queue.get("dtask_0");
    // Budget exhausted → dead_letter regardless of Retry-After.
    expect(task?.status).toBe("dead_letter");
    expect(task?.nextAttemptAt).toBeNull();
  });

  it("accepts an HTTP-date Retry-After and computes the correct delay", async () => {
    // Worker clock is fixed at nowMs = 1_700_000_000_000 (the setup default is 0,
    // so we override it to a concrete epoch that a Date string can represent).
    const startMs = 1_700_000_000_000;
    const env = setup({ startMs, retryPolicy: fixedSchedule([1_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "e",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    // Target date = startMs + 45_000ms.
    const targetDate = new Date(startMs + 45_000).toUTCString();
    await makeWorker(env, {
      transport: retryAfterTransport(503, targetDate),
    }).processOnce();

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    // HTTP-date 45s from nowMs; policy = 1s → floor wins.
    expect(task?.nextAttemptAt).toBeCloseTo(startMs + 45_000, -1);
  });
});

describe("DeliveryWorker — per-endpoint retryPolicy", () => {
  it("uses the endpoint's retryPolicy when present, overriding the global policy", async () => {
    // Global: 60s delay. Endpoint: 500ms delay. After failure, nextAttemptAt should
    // reflect the endpoint's 500ms, proving the per-endpoint policy won.
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "test",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    // Resolver returns a target with a custom per-endpoint policy.
    const endpointPolicy = fixedSchedule([500]);
    const worker = new DeliveryWorker({
      queue: env.queue,
      store: env.store,
      resolveEndpoint: () => ({ url: TARGET_URL, secret: SECRET, retryPolicy: endpointPolicy }),
      now: env.now,
      transport: recordingTransport(503).transport,
    });
    await worker.processOnce();

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    // Custom delay is 500ms; global would be 60_000ms.
    expect(task?.nextAttemptAt).toBe(500);
  });

  it("falls back to the global policy when the endpoint has no retryPolicy", async () => {
    // Global: 1_000ms delay. Endpoint: no retryPolicy. Should use global.
    const env = setup({ retryPolicy: fixedSchedule([1_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "test",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    // Resolver has no retryPolicy.
    const worker = new DeliveryWorker({
      queue: env.queue,
      store: env.store,
      resolveEndpoint: () => ({ url: TARGET_URL, secret: SECRET }),
      now: env.now,
      transport: recordingTransport(503).transport,
    });
    await worker.processOnce();

    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
    // Global delay is 1_000ms.
    expect(task?.nextAttemptAt).toBe(1_000);
  });

  it("per-endpoint policy dead-letters when its own budget is exhausted", async () => {
    // Endpoint policy: 1 retry (2 total attempts). Global: 60s (many retries).
    const env = setup({ retryPolicy: fixedSchedule([60_000, 60_000, 60_000]) });
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "test",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });

    const singleRetryPolicy = fixedSchedule([200]);
    const resolver: EndpointResolver = () => ({
      url: TARGET_URL,
      secret: SECRET,
      retryPolicy: singleRetryPolicy,
    });
    const failTransport = recordingTransport(500).transport;
    const worker = new DeliveryWorker({
      queue: env.queue,
      store: env.store,
      resolveEndpoint: resolver,
      now: env.now,
      transport: failTransport,
    });

    // First attempt → fails → pending (1 retry left per custom policy).
    await worker.processOnce();
    let task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");

    // Advance clock past the 200ms delay so the retry is claimable.
    env.setClock(200);

    // Second attempt → fails → dead_letter (budget exhausted per custom policy).
    await worker.processOnce();
    task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("dead_letter");
  });
});

describe("DeliveryWorker — nonRetryableStatuses", () => {
  async function enqueueOne(env: ReturnType<typeof setup>): Promise<void> {
    const { message } = await env.store.create({
      appId: "app_1",
      eventType: "test",
      payload: "{}",
    });
    await env.queue.enqueue({ messageId: message.id });
  }

  it("immediately dead-letters when the response status is in nonRetryableStatuses", async () => {
    // Global policy allows many retries; endpoint overrides with nonRetryableStatuses.
    const env = setup({ retryPolicy: fixedSchedule([60_000, 60_000]) });
    await enqueueOne(env);

    const endpointPolicy = { delaysMs: [60_000], nonRetryableStatuses: [401] };
    const worker = new DeliveryWorker({
      queue: env.queue,
      store: env.store,
      resolveEndpoint: () => ({ url: TARGET_URL, secret: SECRET, retryPolicy: endpointPolicy }),
      now: env.now,
      transport: recordingTransport(401).transport,
    });
    const result = await worker.processOnce();

    // Should dead-letter immediately, not schedule a retry.
    expect(result).toMatchObject({ claimed: 1, deadLettered: 1, failed: 0 });
    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("dead_letter");
  });

  it("retries normally when the status is NOT in nonRetryableStatuses", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);

    // 503 is not in the list, so it should retry.
    const endpointPolicy = { delaysMs: [100], nonRetryableStatuses: [401, 403] };
    const worker = new DeliveryWorker({
      queue: env.queue,
      store: env.store,
      resolveEndpoint: () => ({ url: TARGET_URL, secret: SECRET, retryPolicy: endpointPolicy }),
      now: env.now,
      transport: recordingTransport(503).transport,
    });
    const result = await worker.processOnce();

    expect(result).toMatchObject({ claimed: 1, failed: 1, deadLettered: 0 });
    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
  });

  it("retries normally when the endpoint has no retryPolicy (nonRetryableStatuses is undefined)", async () => {
    const env = setup({ retryPolicy: fixedSchedule([60_000]) });
    await enqueueOne(env);

    // Resolver returns no retryPolicy at all → nonRetryableStatuses check is skipped.
    const worker = new DeliveryWorker({
      queue: env.queue,
      store: env.store,
      resolveEndpoint: () => ({ url: TARGET_URL, secret: SECRET }),
      now: env.now,
      transport: recordingTransport(401).transport,
    });
    const result = await worker.processOnce();

    expect(result).toMatchObject({ claimed: 1, failed: 1, deadLettered: 0 });
    const task = await env.queue.get("dtask_0");
    expect(task?.status).toBe("pending");
  });
});

describe("DeliveryWorker.run", () => {
  it("drains pending work back-to-back, then stops on the first idle poll", async () => {
    const env = setup();
    for (let i = 0; i < 3; i++) {
      const { message } = await env.store.create({
        appId: "app_1",
        eventType: "e",
        payload: String(i),
      });
      await env.queue.enqueue({ messageId: message.id });
    }
    const { transport, requests } = recordingTransport(200);

    let worker!: DeliveryWorker;
    // The first idle poll (claimed 0) stops the loop deterministically.
    const sleep = async (): Promise<void> => {
      worker.stop();
    };
    worker = makeWorker(env, { transport, batchSize: 1, sleep });

    await worker.run();

    expect(requests).toHaveLength(3);
    expect(worker.running).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect((await env.queue.get(`dtask_${i}`))?.status).toBe("succeeded");
    }
  });

  it("survives an unexpected tick error via onError and keeps looping", async () => {
    const boom = new Error("claim exploded");
    const stubQueue: DeliveryQueue = {
      enqueue: async () => {
        throw boom;
      },
      claimDue: async () => {
        throw boom;
      },
      complete: async () => {
        throw boom;
      },
      fail: async () => {
        throw boom;
      },
      retry: async () => {
        throw boom;
      },
      cancel: async () => {
        throw boom;
      },
      get: async () => null,
      listByMessage: async () => [],
      listByEndpoint: async () => ({ deliveries: [], nextCursor: null }),
      listByApp: async () => ({ deliveries: [], nextCursor: null }),
      pruneTerminalTasks: async () => 0,
      countByStatus: async () => ({
        pending: 0,
        delivering: 0,
        succeeded: 0,
        dead_letter: 0,
        cancelled: 0,
      }),
    };
    const errors: unknown[] = [];
    let worker!: DeliveryWorker;
    const sleep = async (): Promise<void> => {
      worker.stop();
    };
    worker = new DeliveryWorker({
      queue: stubQueue,
      store: new InMemoryMessageStore(),
      resolveEndpoint,
      transport: recordingTransport().transport,
      sleep,
      onError: (error) => errors.push(error),
    });

    await worker.run();
    expect(errors).toEqual([boom]);
    expect(worker.running).toBe(false);
  });

  it("rejects a concurrent run()", async () => {
    const env = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sleep = (): Promise<void> => gate; // blocks the loop while idle

    const worker = makeWorker(env, { sleep });
    const first = worker.run();
    // Let the loop reach its (blocking) idle sleep.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.running).toBe(true);

    await expect(worker.run()).rejects.toThrow(/already running/);

    worker.stop();
    release();
    await first;
    expect(worker.running).toBe(false);
  });
});
