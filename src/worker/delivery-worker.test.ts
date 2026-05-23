import { describe, expect, it, vi } from "vitest";
import {
  DeliveryWorker,
  buildSignedRequest,
  isSuccessStatus,
  type DeliveryWorkerOptions,
  type EndpointResolver,
  type HttpDeliveryRequest,
  type Transport,
} from "./delivery-worker.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import {
  StaleLeaseError,
  type DeliveryQueue,
  type DeliveryTask,
} from "../queue/delivery-queue.js";
import { fixedSchedule, type RetryPolicy } from "../delivery/retry-policy.js";
import { HEADERS, verify } from "../signing/webhook-signature.js";
import { type Message } from "../storage/message-store.js";

// A fixed, valid base64 secret reused across the suite so signature round-trips
// against the real verifier are deterministic.
const SECRET = "whsec_dGVzdHNlY3JldGtleWZvcndlYmhvb2tzaWduaW5n";

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
      get: async () => claimedTask,
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
      get: async () => null,
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
