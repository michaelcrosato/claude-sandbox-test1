import { describe, expect, it } from "vitest";
import { fanOut, ingest, selectFanoutTargets } from "./fanout.js";
import {
  InMemoryEndpointStore,
  type InMemoryEndpointStoreOptions,
} from "../endpoints/in-memory-endpoint-store.js";
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import type { Endpoint, NewEndpoint } from "../endpoints/endpoint.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import {
  DeliveryWorker,
  type HttpDeliveryRequest,
  type Transport,
} from "../worker/delivery-worker.js";
import { HEADERS, verify } from "../signing/webhook-signature.js";

const APP = "app_1";

/** A bare {@link Endpoint} for the pure-selection tests (no store needed). */
function endpoint(overrides: Partial<Endpoint>): Endpoint {
  return {
    id: "ep_x",
    appId: APP,
    url: "https://x.test/hook",
    secret: "whsec_x",
    previousSecrets: [],
    description: "",
    eventTypes: null,
    headers: null,
    retryPolicy: null,
    filter: null,
    channel: null,
    disabled: false,
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("selectFanoutTargets", () => {
  it("matches a null-filter (subscribe-all) endpoint to any event", () => {
    const ep = endpoint({ eventTypes: null });
    const sel = selectFanoutTargets([ep], "anything.at.all");
    expect(sel.matched).toEqual([ep]);
    expect(sel.skippedDisabled).toEqual([]);
    expect(sel.skippedUnsubscribed).toEqual([]);
  });

  it("matches only endpoints whose filter includes the event type", () => {
    const subscribed = endpoint({ id: "ep_a", eventTypes: ["user.created"] });
    const other = endpoint({ id: "ep_b", eventTypes: ["order.paid"] });
    const sel = selectFanoutTargets([subscribed, other], "user.created");
    expect(sel.matched).toEqual([subscribed]);
    expect(sel.skippedUnsubscribed).toEqual([other]);
    expect(sel.skippedDisabled).toEqual([]);
  });

  it("skips a disabled endpoint even when it subscribes (disabled wins)", () => {
    const ep = endpoint({ disabled: true, eventTypes: null });
    const sel = selectFanoutTargets([ep], "user.created");
    expect(sel.matched).toEqual([]);
    expect(sel.skippedDisabled).toEqual([ep]);
    expect(sel.skippedUnsubscribed).toEqual([]);
  });

  it("treats an empty filter array as subscribing to nothing", () => {
    const ep = endpoint({ eventTypes: [] });
    const sel = selectFanoutTargets([ep], "user.created");
    expect(sel.matched).toEqual([]);
    expect(sel.skippedUnsubscribed).toEqual([ep]);
  });

  it("partitions a mix and preserves input order within each bucket", () => {
    const a = endpoint({ id: "ep_a", eventTypes: null });
    const b = endpoint({ id: "ep_b", eventTypes: ["user.created"] });
    const c = endpoint({ id: "ep_c", eventTypes: ["order.paid"] });
    const d = endpoint({ id: "ep_d", disabled: true });
    const e = endpoint({ id: "ep_e", eventTypes: ["user.created", "x"] });

    const sel = selectFanoutTargets([a, b, c, d, e], "user.created");
    expect(sel.matched.map((ep) => ep.id)).toEqual(["ep_a", "ep_b", "ep_e"]);
    expect(sel.skippedUnsubscribed.map((ep) => ep.id)).toEqual(["ep_c"]);
    expect(sel.skippedDisabled.map((ep) => ep.id)).toEqual(["ep_d"]);
  });

  it("returns all-empty buckets for no endpoints", () => {
    expect(selectFanoutTargets([], "e")).toEqual({
      matched: [],
      skippedDisabled: [],
      skippedUnsubscribed: [],
      skippedChannel: [],
      skippedFiltered: [],
    });
  });

  it("skips an enabled, subscribed endpoint whose payload filter does not match", () => {
    const filtered = endpoint({
      id: "ep_a",
      filter: { op: "eq", path: "env", value: "prod" },
    });
    const unfiltered = endpoint({ id: "ep_b" });
    const sel = selectFanoutTargets([filtered, unfiltered], "user.created", null, { env: "staging" });
    expect(sel.matched.map((e) => e.id)).toEqual(["ep_b"]);
    expect(sel.skippedFiltered.map((e) => e.id)).toEqual(["ep_a"]);
    expect(sel.skippedDisabled).toEqual([]);
    expect(sel.skippedUnsubscribed).toEqual([]);
  });

  it("matches an endpoint whose payload filter evaluates to true", () => {
    const filtered = endpoint({
      filter: { op: "eq", path: "env", value: "prod" },
    });
    const sel = selectFanoutTargets([filtered], "user.created", null, { env: "prod" });
    expect(sel.matched).toEqual([filtered]);
    expect(sel.skippedFiltered).toEqual([]);
  });

  it("disabled takes priority over filter mismatch", () => {
    const ep = endpoint({ disabled: true, filter: { op: "eq", path: "env", value: "prod" } });
    const sel = selectFanoutTargets([ep], "user.created", null, { env: "staging" });
    expect(sel.skippedDisabled).toEqual([ep]);
    expect(sel.skippedFiltered).toEqual([]);
  });

  // Channel routing tests
  it("global endpoint (channel=null) matches a message with any channel", () => {
    const ep = endpoint({ channel: null });
    const sel = selectFanoutTargets([ep], "user.created", "acme");
    expect(sel.matched).toEqual([ep]);
    expect(sel.skippedChannel).toEqual([]);
  });

  it("global endpoint (channel=null) matches an untagged message (channel=null)", () => {
    const ep = endpoint({ channel: null });
    const sel = selectFanoutTargets([ep], "user.created", null);
    expect(sel.matched).toEqual([ep]);
    expect(sel.skippedChannel).toEqual([]);
  });

  it("scoped endpoint skips an untagged message (channel=null)", () => {
    const ep = endpoint({ channel: "acme" });
    const sel = selectFanoutTargets([ep], "user.created", null);
    expect(sel.matched).toEqual([]);
    expect(sel.skippedChannel).toEqual([ep]);
  });

  it("scoped endpoint matches a message with the same channel", () => {
    const ep = endpoint({ channel: "acme" });
    const sel = selectFanoutTargets([ep], "user.created", "acme");
    expect(sel.matched).toEqual([ep]);
    expect(sel.skippedChannel).toEqual([]);
  });

  it("scoped endpoint skips a message with a different channel", () => {
    const epA = endpoint({ id: "ep_a", channel: "acme" });
    const epB = endpoint({ id: "ep_b", channel: "beta" });
    const global = endpoint({ id: "ep_g", channel: null });
    const sel = selectFanoutTargets([epA, epB, global], "user.created", "acme");
    expect(sel.matched.map((e) => e.id)).toEqual(["ep_a", "ep_g"]);
    expect(sel.skippedChannel.map((e) => e.id)).toEqual(["ep_b"]);
  });

  it("disabled takes priority over channel mismatch", () => {
    const ep = endpoint({ disabled: true, channel: "acme" });
    const sel = selectFanoutTargets([ep], "user.created", "other");
    expect(sel.skippedDisabled).toEqual([ep]);
    expect(sel.skippedChannel).toEqual([]);
  });

  it("unsubscribed takes priority over channel mismatch", () => {
    const ep = endpoint({ eventTypes: ["order.paid"], channel: "acme" });
    const sel = selectFanoutTargets([ep], "user.created", "other");
    expect(sel.skippedUnsubscribed).toEqual([ep]);
    expect(sel.skippedChannel).toEqual([]);
  });
});

/** A fan-out fixture: three stores sharing one deterministic clock. */
function setup(endpointOpts: InMemoryEndpointStoreOptions = {}) {
  let nowMs = 1_700_000_000_000;
  const now = () => nowMs;
  const setClock = (ms: number) => {
    nowMs = ms;
  };
  const endpoints = new InMemoryEndpointStore({ now, ...endpointOpts });
  const messages = new InMemoryMessageStore({ now });
  const queue = new InMemoryDeliveryQueue({ now });
  const addEndpoint = (input: Partial<NewEndpoint> = {}) =>
    endpoints.create({ appId: APP, url: "https://x.test/hook", ...input });
  return { endpoints, messages, queue, now, setClock, addEndpoint };
}

describe("fanOut", () => {
  it("enqueues one task per matched endpoint, tagged with message and endpoint", async () => {
    const env = setup();
    const all = await env.addEndpoint({ url: "https://a.test/h" }); // subscribe-all
    const subscribed = await env.addEndpoint({
      url: "https://b.test/h",
      eventTypes: ["user.created"],
    });
    await env.addEndpoint({
      url: "https://c.test/h",
      eventTypes: ["order.paid"],
    }); // unsubscribed
    await env.addEndpoint({ url: "https://d.test/h", disabled: true }); // disabled

    const result = await fanOut(
      { id: "msg_1", appId: APP, eventType: "user.created", payload: "{}", channel: null, deliverAt: null },
      { endpoints: env.endpoints, queue: env.queue },
    );

    expect(result).toMatchObject({
      messageId: "msg_1",
      matched: 2,
      skippedUnsubscribed: 1,
      skippedDisabled: 1,
    });
    // One task per match, in endpoint (oldest-first) order, all for our message.
    expect(result.tasks.map((t) => t.endpointId)).toEqual([
      all.id,
      subscribed.id,
    ]);
    expect(result.tasks.every((t) => t.messageId === "msg_1")).toBe(true);
    expect(result.tasks.every((t) => t.status === "pending")).toBe(true);
  });

  it("enqueues nothing when no endpoint matches", async () => {
    const env = setup();
    await env.addEndpoint({ eventTypes: ["order.paid"] });
    await env.addEndpoint({ disabled: true });

    const result = await fanOut(
      { id: "msg_1", appId: APP, eventType: "user.created", payload: "{}", channel: null, deliverAt: null },
      { endpoints: env.endpoints, queue: env.queue },
    );
    expect(result.matched).toBe(0);
    expect(result.tasks).toHaveLength(0);
    expect(result.skippedUnsubscribed).toBe(1);
    expect(result.skippedDisabled).toBe(1);
  });

  it("fans out only within the message's own tenant", async () => {
    const env = setup();
    const mine = await env.addEndpoint({ url: "https://mine.test/h" });
    // A subscribe-all endpoint in a *different* app must never be enqueued.
    await env.endpoints.create({ appId: "app_2", url: "https://other.test/h" });

    const result = await fanOut(
      { id: "msg_1", appId: APP, eventType: "user.created", payload: "{}", channel: null, deliverAt: null },
      { endpoints: env.endpoints, queue: env.queue },
    );
    expect(result.matched).toBe(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.endpointId).toBe(mine.id);
  });

  it("applies availableAt to every enqueued task", async () => {
    const env = setup();
    await env.addEndpoint({ url: "https://a.test/h" });
    await env.addEndpoint({ url: "https://b.test/h" });

    const result = await fanOut(
      { id: "msg_1", appId: APP, eventType: "e", payload: "{}", channel: null, deliverAt: null },
      { endpoints: env.endpoints, queue: env.queue },
      { availableAt: 5_000 },
    );
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.every((t) => t.nextAttemptAt === 5_000)).toBe(true);
  });

  it("uses message.deliverAt as availableAt when no explicit options are passed", async () => {
    const env = setup();
    await env.addEndpoint({ url: "https://a.test/h" });

    const result = await fanOut(
      { id: "msg_1", appId: APP, eventType: "e", payload: "{}", channel: null, deliverAt: 9_000 },
      { endpoints: env.endpoints, queue: env.queue },
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.nextAttemptAt).toBe(9_000);
  });

  it("explicit options.availableAt overrides message.deliverAt", async () => {
    const env = setup();
    await env.addEndpoint({ url: "https://a.test/h" });

    const result = await fanOut(
      { id: "msg_1", appId: APP, eventType: "e", payload: "{}", channel: null, deliverAt: 9_000 },
      { endpoints: env.endpoints, queue: env.queue },
      { availableAt: 1_000 },
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.nextAttemptAt).toBe(1_000);
  });
});

describe("ingest", () => {
  it("creates the message and fans it out in one call", async () => {
    const env = setup();
    const ep = await env.addEndpoint();

    const result = await ingest(
      { appId: APP, eventType: "user.created", payload: '{"id":1}' },
      { endpoints: env.endpoints, queue: env.queue, messages: env.messages },
    );

    expect(result.deduplicated).toBe(false);
    expect(result.message.appId).toBe(APP);
    expect(result.fanout).not.toBeNull();
    expect(result.fanout?.matched).toBe(1);
    expect(result.fanout?.tasks[0]?.endpointId).toBe(ep.id);
    expect(result.fanout?.tasks[0]?.messageId).toBe(result.message.id);
  });

  it("does not re-fan-out a deduplicated (retried) message", async () => {
    const env = setup();
    await env.addEndpoint();
    const input = {
      appId: APP,
      eventType: "user.created",
      payload: "{}",
      idempotencyKey: "k-1",
    };

    const first = await ingest(input, {
      endpoints: env.endpoints,
      queue: env.queue,
      messages: env.messages,
    });
    const second = await ingest(input, {
      endpoints: env.endpoints,
      queue: env.queue,
      messages: env.messages,
    });

    expect(first.deduplicated).toBe(false);
    expect(first.fanout?.matched).toBe(1);
    // The retry dedups to the same message and is NOT fanned out again.
    expect(second.deduplicated).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(second.fanout).toBeNull();
  });

  it("clears the outbox marker after a normal fan-out", async () => {
    const env = setup();
    await env.addEndpoint();
    await ingest(
      { appId: APP, eventType: "user.created", payload: "{}" },
      { endpoints: env.endpoints, queue: env.queue, messages: env.messages },
    );
    // ingest fanned out and recorded it done, so nothing is left for the dispatcher.
    expect(await env.messages.listPendingFanout()).toEqual([]);
  });

  it("re-fans a deduplicated retry whose original create never completed fan-out", async () => {
    const env = setup();
    const ep = await env.addEndpoint();
    const input = {
      appId: APP,
      eventType: "user.created",
      payload: "{}",
      idempotencyKey: "k-orphan",
    };

    // Simulate a crash between accept and fan-out: accept the message directly
    // via the store (which records it pending) with no fan-out performed.
    const accepted = await env.messages.create(input);
    expect(accepted.fanoutPending).toBe(true);
    expect(await env.queue.claimDue({ nowMs: env.now(), limit: 10 })).toEqual([]);

    // The producer retries the same key. ingest dedups *and* recovers the
    // fan-out the crash skipped — rather than dropping the deliveries.
    const retry = await ingest(input, {
      endpoints: env.endpoints,
      queue: env.queue,
      messages: env.messages,
    });
    expect(retry.deduplicated).toBe(true);
    expect(retry.message.id).toBe(accepted.message.id);
    expect(retry.fanout?.matched).toBe(1);
    expect(retry.fanout?.tasks[0]?.endpointId).toBe(ep.id);

    // The marker is now cleared: a further retry does not fan out a third time.
    const third = await ingest(input, {
      endpoints: env.endpoints,
      queue: env.queue,
      messages: env.messages,
    });
    expect(third.deduplicated).toBe(true);
    expect(third.fanout).toBeNull();
  });

  it("delivers an ingested message end-to-end with a verifiable signature", async () => {
    const env = setup();
    const ep = await env.addEndpoint({ url: "https://hook.test/in" });

    const { message, fanout } = await ingest(
      { appId: APP, eventType: "user.created", payload: '{"hello":"world"}' },
      { endpoints: env.endpoints, queue: env.queue, messages: env.messages },
    );
    expect(fanout?.tasks).toHaveLength(1);

    // Drain the queue with a real worker; capture the request it emits.
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

    const result = await worker.processOnce();
    expect(result).toMatchObject({ claimed: 1, succeeded: 1 });

    const request = captured as unknown as HttpDeliveryRequest;
    expect(request.url).toBe("https://hook.test/in");
    expect(request.body).toBe('{"hello":"world"}');
    // The whole pipeline — ingest → fan-out → queue → worker → sign — produces a
    // signature that verifies against the secret the endpoint store minted.
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
    expect(message.id).toBe(request.headers[HEADERS.id]);
  });
});
