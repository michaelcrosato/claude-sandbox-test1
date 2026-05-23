import { describe, expect, it } from "vitest";
import {
  DEFAULT_FANOUT_GRACE_MS,
  FanoutDispatcher,
} from "./fanout-dispatcher.js";
import {
  InMemoryEndpointStore,
  type InMemoryEndpointStoreOptions,
} from "../endpoints/in-memory-endpoint-store.js";
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import type { NewEndpoint } from "../endpoints/endpoint.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import {
  DeliveryWorker,
  type HttpDeliveryRequest,
  type Transport,
} from "../worker/delivery-worker.js";
import { HEADERS, verify } from "../signing/webhook-signature.js";

const APP = "app_1";
const START = 1_700_000_000_000;

/** Three stores sharing one controllable clock — mirrors the fan-out fixture. */
function setup(endpointOpts: InMemoryEndpointStoreOptions = {}) {
  let nowMs = START;
  const now = () => nowMs;
  const advance = (ms: number) => {
    nowMs += ms;
  };
  const endpoints = new InMemoryEndpointStore({ now, ...endpointOpts });
  const messages = new InMemoryMessageStore({ now });
  const queue = new InMemoryDeliveryQueue({ now });
  const addEndpoint = (input: Partial<NewEndpoint> = {}) =>
    endpoints.create({ appId: APP, url: "https://x.test/hook", ...input });
  /** Accept a message *without* fanning it out — an orphan, as a crash would leave. */
  const orphan = (payload = "{}") =>
    messages.create({ appId: APP, eventType: "user.created", payload });
  return { endpoints, messages, queue, now, advance, addEndpoint, orphan };
}

describe("FanoutDispatcher — construction", () => {
  it("rejects a non-positive batch size and a negative/non-finite grace or idle poll", () => {
    const env = setup();
    const deps = { messages: env.messages, endpoints: env.endpoints, queue: env.queue };
    expect(() => new FanoutDispatcher({ ...deps, batchSize: 0 })).toThrow(RangeError);
    expect(() => new FanoutDispatcher({ ...deps, batchSize: 1.5 })).toThrow(RangeError);
    expect(() => new FanoutDispatcher({ ...deps, graceMs: -1 })).toThrow(RangeError);
    expect(
      () => new FanoutDispatcher({ ...deps, graceMs: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
    expect(() => new FanoutDispatcher({ ...deps, idlePollMs: -1 })).toThrow(RangeError);
  });
});

describe("FanoutDispatcher — sweepOnce", () => {
  it("fans out an orphaned message and clears its marker", async () => {
    const env = setup();
    const ep = await env.addEndpoint();
    const { message } = await env.orphan();
    // Precondition: pending in the outbox, and nothing enqueued yet.
    expect((await env.messages.listPendingFanout()).map((m) => m.id)).toEqual([
      message.id,
    ]);

    const dispatcher = new FanoutDispatcher({
      messages: env.messages,
      endpoints: env.endpoints,
      queue: env.queue,
      now: env.now,
      graceMs: 0, // no concurrent inline ingest to race in this test
    });

    const result = await dispatcher.sweepOnce();
    expect(result).toEqual({ pending: 1, fannedOut: 1, failed: 0 });
    // The delivery was enqueued for the matched endpoint, and the marker cleared.
    const task = await env.queue.claimDue({ nowMs: env.now(), limit: 10 });
    expect(task.map((t) => t.endpointId)).toEqual([ep.id]);
    expect(await env.messages.listPendingFanout()).toEqual([]);

    // A second sweep finds nothing and does no work.
    expect(await dispatcher.sweepOnce()).toEqual({
      pending: 0,
      fannedOut: 0,
      failed: 0,
    });
  });

  it("does not sweep a message younger than the grace period, but does once it ages out", async () => {
    const env = setup();
    await env.addEndpoint();
    await env.orphan();

    const dispatcher = new FanoutDispatcher({
      messages: env.messages,
      endpoints: env.endpoints,
      queue: env.queue,
      now: env.now,
      graceMs: DEFAULT_FANOUT_GRACE_MS,
    });

    // Too fresh: skipped (a healthy inline ingest would clear it any moment).
    expect(await dispatcher.sweepOnce()).toEqual({
      pending: 0,
      fannedOut: 0,
      failed: 0,
    });

    // Older than the grace window: now treated as a genuine orphan.
    env.advance(DEFAULT_FANOUT_GRACE_MS);
    expect(await dispatcher.sweepOnce()).toEqual({
      pending: 1,
      fannedOut: 1,
      failed: 0,
    });
  });

  it("ignores a message whose fan-out was already marked done", async () => {
    const env = setup();
    await env.addEndpoint();
    const { message } = await env.orphan();
    await env.messages.markFannedOut(message.id); // ingest's inline path already ran

    const dispatcher = new FanoutDispatcher({
      messages: env.messages,
      endpoints: env.endpoints,
      queue: env.queue,
      now: env.now,
      graceMs: 0,
    });
    expect(await dispatcher.sweepOnce()).toEqual({
      pending: 0,
      fannedOut: 0,
      failed: 0,
    });
    // Nothing was enqueued.
    expect(await env.queue.claimDue({ nowMs: env.now(), limit: 10 })).toEqual([]);
  });

  it("drains oldest-first, bounded by the batch size", async () => {
    const env = setup();
    await env.addEndpoint();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { message } = await env.orphan();
      ids.push(message.id);
      env.advance(1);
    }
    const dispatcher = new FanoutDispatcher({
      messages: env.messages,
      endpoints: env.endpoints,
      queue: env.queue,
      now: env.now,
      graceMs: 0,
      batchSize: 2,
    });
    // First sweep takes the two oldest.
    expect(await dispatcher.sweepOnce()).toEqual({
      pending: 2,
      fannedOut: 2,
      failed: 0,
    });
    expect((await env.messages.listPendingFanout()).map((m) => m.id)).toEqual([
      ids[2],
    ]);
    // Second sweep takes the last one.
    expect(await dispatcher.sweepOnce()).toMatchObject({ fannedOut: 1 });
  });

  it("isolates a per-message failure: reports it, leaves it pending, keeps going", async () => {
    const env = setup();
    await env.addEndpoint();
    const { message } = await env.orphan();

    // A queue whose enqueue always throws makes this message's fan-out fail.
    const throwingQueue = {
      enqueue: async () => {
        throw new Error("enqueue boom");
      },
    } as unknown as DeliveryQueue;

    const errors: unknown[] = [];
    const dispatcher = new FanoutDispatcher({
      messages: env.messages,
      endpoints: env.endpoints,
      queue: throwingQueue,
      now: env.now,
      graceMs: 0,
      onError: (e) => errors.push(e),
    });

    const result = await dispatcher.sweepOnce();
    expect(result).toEqual({ pending: 1, fannedOut: 0, failed: 1 });
    expect((errors[0] as Error).message).toBe("enqueue boom");
    // The message is preserved for a later sweep — never silently dropped.
    expect((await env.messages.listPendingFanout()).map((m) => m.id)).toEqual([
      message.id,
    ]);
  });
});

describe("FanoutDispatcher — run/stop", () => {
  it("recovers a pending orphan while looping, then stops", async () => {
    const env = setup();
    await env.addEndpoint();
    const { message } = await env.orphan();

    const dispatcher = new FanoutDispatcher({
      messages: env.messages,
      endpoints: env.endpoints,
      queue: env.queue,
      now: env.now,
      graceMs: 0,
      idlePollMs: 0,
      sleep: async () => {}, // no real delay
    });

    const running = dispatcher.run();
    // Poll (cooperatively) until the orphan is drained.
    for (let i = 0; i < 100 && (await env.messages.listPendingFanout()).length > 0; i += 1) {
      await Promise.resolve();
    }
    dispatcher.stop();
    await running;

    expect(dispatcher.running).toBe(false);
    expect(await env.messages.listPendingFanout()).toEqual([]);
    const tasks = await env.queue.claimDue({ nowMs: env.now(), limit: 10 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.messageId).toBe(message.id);
  });

  it("refuses to run twice concurrently", async () => {
    const env = setup();
    const dispatcher = new FanoutDispatcher({
      messages: env.messages,
      endpoints: env.endpoints,
      queue: env.queue,
      now: env.now,
      idlePollMs: 0,
      sleep: async () => {},
    });
    const running = dispatcher.run();
    await expect(dispatcher.run()).rejects.toThrow(/already running/);
    dispatcher.stop();
    await running;
  });
});

describe("FanoutDispatcher — end-to-end recovery", () => {
  it("a swept orphan is delivered with a signature that verifies", async () => {
    const env = setup();
    const ep = await env.addEndpoint({ url: "https://hook.test/in" });
    // Simulate a crash after accept but before fan-out: a pending, un-fanned message.
    const { message } = await env.messages.create({
      appId: APP,
      eventType: "user.created",
      payload: '{"recovered":true}',
    });

    // The dispatcher recovers it.
    const dispatcher = new FanoutDispatcher({
      messages: env.messages,
      endpoints: env.endpoints,
      queue: env.queue,
      now: env.now,
      graceMs: 0,
    });
    await dispatcher.sweepOnce();

    // A real worker then drains the queue; capture the request it emits.
    let captured: HttpDeliveryRequest | null = null;
    const transport: Transport = async (request) => {
      captured = request;
      return { status: 200 };
    };
    const worker = new DeliveryWorker({
      queue: env.queue,
      store: env.messages,
      resolveEndpoint: storeBackedResolver(env.endpoints),
      transport,
      now: env.now,
    });
    expect(await worker.processOnce()).toMatchObject({ claimed: 1, succeeded: 1 });

    const request = captured as unknown as HttpDeliveryRequest;
    expect(request.url).toBe("https://hook.test/in");
    expect(request.body).toBe('{"recovered":true}');
    expect(() =>
      verify(
        ep.secret,
        {
          id: request.headers[HEADERS.id]!,
          timestamp: request.headers[HEADERS.timestamp]!,
          signature: request.headers[HEADERS.signature]!,
        },
        request.body,
        { now: Math.floor(env.now() / 1000) },
      ),
    ).not.toThrow();
    expect(request.headers[HEADERS.id]).toBe(message.id);
  });
});
