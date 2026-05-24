import { describe, expect, it } from "vitest";
import {
  replayEndpointMessages,
  normalizeReplayLimit,
  DEFAULT_REPLAY_LIMIT,
  MAX_REPLAY_LIMIT,
} from "./replay-endpoint.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "./in-memory-queue.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { fixedSchedule } from "../delivery/retry-policy.js";

// ---- Clock / ID helpers ----

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  let msgSeq = 0;
  let taskSeq = 0;
  let epSeq = 0;
  return {
    now: () => now,
    set: (ms: number) => { now = ms; },
    advance: (ms: number) => { now += ms; },
    msgId: () => `msg_${++msgSeq}`,
    taskId: () => `dtask_${++taskSeq}`,
    leaseToken: () => `lease_${taskSeq}`,
    epId: () => `ep_${++epSeq}`,
  };
}

function makeStores(clock: ReturnType<typeof makeClock>) {
  const messages = new InMemoryMessageStore({
    now: clock.now,
    generateId: clock.msgId,
    idempotencyWindowMs: Infinity,
  });
  const queue = new InMemoryDeliveryQueue({
    now: clock.now,
    generateId: clock.taskId,
    generateLeaseToken: clock.leaseToken,
    retryPolicy: fixedSchedule([]),
  });
  const endpoints = new InMemoryEndpointStore({
    now: clock.now,
    generateId: clock.epId,
  });
  return { messages, queue, endpoints };
}

async function sendMessage(
  messages: InMemoryMessageStore,
  appId: string,
  eventType: string,
  payload = "{}",
  channel: string | null = null,
) {
  const { message } = await messages.create({ appId, eventType, payload, channel });
  return message;
}

async function makeEndpoint(
  endpoints: InMemoryEndpointStore,
  appId: string,
  opts: { eventTypes?: readonly string[] | null; channel?: string | null; disabled?: boolean } = {},
) {
  return endpoints.create({
    appId,
    url: "https://example.com/hook",
    eventTypes: opts.eventTypes ?? null,
    channel: opts.channel ?? null,
    disabled: opts.disabled ?? false,
  });
}

// ---- normalizeReplayLimit ----

describe("normalizeReplayLimit", () => {
  it("defaults to DEFAULT_REPLAY_LIMIT when undefined", () => {
    expect(normalizeReplayLimit(undefined)).toBe(DEFAULT_REPLAY_LIMIT);
  });

  it("accepts valid limits", () => {
    expect(normalizeReplayLimit(1)).toBe(1);
    expect(normalizeReplayLimit(MAX_REPLAY_LIMIT)).toBe(MAX_REPLAY_LIMIT);
  });

  it("throws RangeError on 0", () => {
    expect(() => normalizeReplayLimit(0)).toThrow(RangeError);
  });

  it("throws RangeError on values above MAX_REPLAY_LIMIT", () => {
    expect(() => normalizeReplayLimit(MAX_REPLAY_LIMIT + 1)).toThrow(RangeError);
  });

  it("throws RangeError on non-integer", () => {
    expect(() => normalizeReplayLimit(1.5)).toThrow(RangeError);
  });
});

// ---- replayEndpointMessages ----

describe("replayEndpointMessages", () => {
  it("returns {enqueued:0, hasMore:false} when the app has no messages", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    const ep = await makeEndpoint(endpoints, "app_1");
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result).toEqual({ enqueued: 0, hasMore: false });
  });

  it("returns {enqueued:0, hasMore:false} when messages don't match the subscription", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_1", "user.created");
    const ep = await makeEndpoint(endpoints, "app_1", { eventTypes: ["payment.created"] });
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result).toEqual({ enqueued: 0, hasMore: false });
  });

  it("enqueues a task for each matching message", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_1", "user.created");
    await sendMessage(messages, "app_1", "user.created");
    const ep = await makeEndpoint(endpoints, "app_1");
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result).toEqual({ enqueued: 2, hasMore: false });
    const tasks = (await queue.listByApp("app_1")).deliveries;
    expect(tasks).toHaveLength(2);
  });

  it("enqueues tasks with the correct messageId and endpointId", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    const msg = await sendMessage(messages, "app_1", "order.placed");
    const ep = await makeEndpoint(endpoints, "app_1");
    await replayEndpointMessages(ep, { messages, queue });
    const [task] = (await queue.listByApp("app_1")).deliveries;
    expect(task!.messageId).toBe(msg.id);
    expect(task!.endpointId).toBe(ep.id);
    expect(task!.appId).toBe("app_1");
  });

  it("skips messages from other tenants", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_other", "user.created");
    const ep = await makeEndpoint(endpoints, "app_1"); // different app
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result).toEqual({ enqueued: 0, hasMore: false });
  });

  it("skips disabled endpoint (skippedDisabled)", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_1", "user.created");
    const ep = await makeEndpoint(endpoints, "app_1", { disabled: true });
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result).toEqual({ enqueued: 0, hasMore: false });
  });

  it("respects event-type subscription filter", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_1", "user.created");
    await sendMessage(messages, "app_1", "payment.created");
    const ep = await makeEndpoint(endpoints, "app_1", { eventTypes: ["user.created"] });
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result.enqueued).toBe(1);
    const [task] = (await queue.listByApp("app_1")).deliveries;
    const msg = await messages.get(task!.messageId);
    expect(msg!.eventType).toBe("user.created");
  });

  it("respects channel filter", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_1", "order.placed", "{}", "customer/alice");
    await sendMessage(messages, "app_1", "order.placed", "{}", "customer/bob");
    await sendMessage(messages, "app_1", "order.placed");  // null channel
    // Channel-scoped endpoint for alice only
    const ep = await makeEndpoint(endpoints, "app_1", { channel: "customer/alice" });
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result.enqueued).toBe(1);
    const [task] = (await queue.listByApp("app_1")).deliveries;
    const msg = await messages.get(task!.messageId);
    expect(msg!.channel).toBe("customer/alice");
  });

  it("global endpoint (null channel) receives all messages", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_1", "order.placed", "{}", "customer/alice");
    await sendMessage(messages, "app_1", "order.placed");
    const ep = await makeEndpoint(endpoints, "app_1", { channel: null }); // global
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result.enqueued).toBe(2);
  });

  it("respects `since` lower bound — skips messages older than since", async () => {
    const clock = makeClock(1_000_000);
    const { messages, queue, endpoints } = makeStores(clock);
    // old message at t=1_000_000
    await sendMessage(messages, "app_1", "ping");
    clock.advance(10_000);
    // newer message at t=1_010_000
    const sinceMs = clock.now();
    clock.advance(1_000);
    await sendMessage(messages, "app_1", "ping");  // at t=1_011_000, inside window
    const ep = await makeEndpoint(endpoints, "app_1");
    const result = await replayEndpointMessages(ep, { messages, queue }, { since: sinceMs });
    expect(result.enqueued).toBe(1); // only the newer one
  });

  it("respects `until` upper bound — skips messages at or after until", async () => {
    const clock = makeClock(1_000_000);
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_1", "ping"); // at t=1_000_000, inside window
    clock.advance(5_000);
    const untilMs = clock.now(); // t=1_005_000
    clock.advance(1_000);
    await sendMessage(messages, "app_1", "ping"); // at t=1_006_000, outside window
    const ep = await makeEndpoint(endpoints, "app_1");
    const result = await replayEndpointMessages(ep, { messages, queue }, { until: untilMs });
    expect(result.enqueued).toBe(1); // only the older one (inside window)
  });

  it("respects combined since + until window", async () => {
    const clock = makeClock(1_000_000);
    const { messages, queue, endpoints } = makeStores(clock);
    await sendMessage(messages, "app_1", "ping"); // t=1_000_000 — before window
    clock.advance(2_000);
    const sinceMs = clock.now(); // window starts at t=1_002_000
    clock.advance(1_000);
    await sendMessage(messages, "app_1", "ping"); // t=1_003_000 — inside
    clock.advance(1_000);
    await sendMessage(messages, "app_1", "ping"); // t=1_004_000 — inside
    clock.advance(1_000);
    const untilMs = clock.now(); // window ends at t=1_005_000
    clock.advance(1_000);
    await sendMessage(messages, "app_1", "ping"); // t=1_006_000 — after window
    const ep = await makeEndpoint(endpoints, "app_1");
    const result = await replayEndpointMessages(ep, { messages, queue }, { since: sinceMs, until: untilMs });
    expect(result.enqueued).toBe(2);
  });

  it("stops at limit and returns hasMore:true", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    for (let i = 0; i < 5; i++) {
      await sendMessage(messages, "app_1", "tick");
    }
    const ep = await makeEndpoint(endpoints, "app_1");
    const result = await replayEndpointMessages(ep, { messages, queue }, { limit: 3 });
    expect(result).toEqual({ enqueued: 3, hasMore: true });
    expect((await queue.listByApp("app_1")).deliveries).toHaveLength(3);
  });

  it("returns hasMore:false when limit equals total matching messages", async () => {
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    for (let i = 0; i < 4; i++) {
      await sendMessage(messages, "app_1", "tick");
    }
    const ep = await makeEndpoint(endpoints, "app_1");
    const result = await replayEndpointMessages(ep, { messages, queue }, { limit: 4 });
    expect(result).toEqual({ enqueued: 4, hasMore: false });
  });

  it("uses DEFAULT_REPLAY_LIMIT when limit is omitted", async () => {
    // Create exactly DEFAULT_REPLAY_LIMIT + 1 messages
    const clock = makeClock();
    const { messages, queue, endpoints } = makeStores(clock);
    for (let i = 0; i <= DEFAULT_REPLAY_LIMIT; i++) {
      await sendMessage(messages, "app_1", "tick");
    }
    const ep = await makeEndpoint(endpoints, "app_1");
    const result = await replayEndpointMessages(ep, { messages, queue });
    expect(result.enqueued).toBe(DEFAULT_REPLAY_LIMIT);
    expect(result.hasMore).toBe(true);
  });
});
