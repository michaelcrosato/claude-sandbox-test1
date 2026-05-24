import { describe, expect, it } from "vitest";
import { InMemoryDeliveryQueue } from "./in-memory-queue.js";
import {
  retryAppDeliveries,
  DEFAULT_BULK_RETRY_LIMIT,
} from "./retry-app.js";
import { fixedSchedule } from "../delivery/retry-policy.js";
import { MAX_LIST_DELIVERIES_LIMIT } from "./delivery-queue.js";

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  let idSeq = 0;
  let leaseSeq = 0;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    id: () => `dtask_${++idSeq}`,
    lease: () => `lease_${++leaseSeq}`,
  };
}

/** A queue that dead-letters on the first failure (no retries). */
function makeQueue(clock: ReturnType<typeof makeClock>): InMemoryDeliveryQueue {
  return new InMemoryDeliveryQueue({
    now: clock.now,
    generateId: clock.id,
    generateLeaseToken: clock.lease,
    retryPolicy: fixedSchedule([]),
  });
}

/** Dead-letter a freshly-enqueued task in one round-trip. */
async function deadLetter(
  queue: InMemoryDeliveryQueue,
  clock: ReturnType<typeof makeClock>,
  messageId: string,
  appId: string,
  endpointId = "ep_1",
) {
  await queue.enqueue({ messageId, endpointId, appId });
  const [t] = await queue.claimDue({ nowMs: clock.now() });
  return queue.fail(t!.id, t!.leaseToken!, { error: "down", nowMs: clock.now() });
}

describe("retryAppDeliveries", () => {
  it("returns { retried: 0, hasMore: false } when there are no dead-lettered tasks", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const result = await retryAppDeliveries("app_1", { queue });
    expect(result).toEqual({ retried: 0, hasMore: false });
  });

  it("returns { retried: 0, hasMore: false } for an app with only pending tasks", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    await queue.enqueue({ messageId: "m1", endpointId: "ep_1", appId: "app_1" });
    const result = await retryAppDeliveries("app_1", { queue });
    expect(result).toEqual({ retried: 0, hasMore: false });
  });

  it("revives dead-lettered tasks and returns the correct count", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    await deadLetter(queue, clock, "m1", "app_1", "ep_1");
    await deadLetter(queue, clock, "m2", "app_1", "ep_2");

    const result = await retryAppDeliveries("app_1", { queue });
    expect(result.retried).toBe(2);
    expect(result.hasMore).toBe(false);

    // Both tasks are now pending.
    const tasks = (await queue.listByApp("app_1", { status: "pending" })).deliveries;
    expect(tasks).toHaveLength(2);
  });

  it("does not touch tasks belonging to a different app", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    await deadLetter(queue, clock, "m1", "app_a", "ep_1");
    await deadLetter(queue, clock, "m2", "app_b", "ep_2");

    const result = await retryAppDeliveries("app_a", { queue });
    expect(result.retried).toBe(1);

    // app_b's task is still dead_letter.
    const bPage = await queue.listByApp("app_b", { status: "dead_letter" });
    expect(bPage.deliveries).toHaveLength(1);
  });

  it("skips non-dead-letter tasks (pending / succeeded) in the same app", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    // Pending task (never claimed)
    await queue.enqueue({ messageId: "m_pending", endpointId: "ep_1", appId: "app_1" });
    // Dead-lettered task
    await deadLetter(queue, clock, "m_dead", "app_1", "ep_2");

    const result = await retryAppDeliveries("app_1", { queue });
    expect(result.retried).toBe(1);

    // The pending task is still pending (untouched).
    const pendingPage = await queue.listByApp("app_1", { status: "pending" });
    const ids = pendingPage.deliveries.map((t) => t.messageId);
    expect(ids).toContain("m_pending");
  });

  it("signals hasMore: true when the dead-letter backlog exceeds limit", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    // Create 3 dead-lettered tasks.
    await deadLetter(queue, clock, "m1", "app_1");
    await deadLetter(queue, clock, "m2", "app_1");
    await deadLetter(queue, clock, "m3", "app_1");

    // Limit to 2: hasMore should be true (there is 1 more).
    const result = await retryAppDeliveries("app_1", { queue }, { limit: 2 });
    expect(result.retried).toBe(2);
    expect(result.hasMore).toBe(true);

    // Second call drains the rest.
    const result2 = await retryAppDeliveries("app_1", { queue });
    expect(result2.retried).toBe(1);
    expect(result2.hasMore).toBe(false);
  });

  it("absorbs a concurrent revive (DeliveryStateError) without counting it", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const t = await deadLetter(queue, clock, "m1", "app_1");

    // Concurrently revive the task before retryAppDeliveries processes it.
    await queue.retry(t.id);
    // Task is now pending — retryAppDeliveries should silently skip it.
    const result = await retryAppDeliveries("app_1", { queue });
    expect(result.retried).toBe(0);
  });

  it("rejects a limit outside [1, MAX_LIST_DELIVERIES_LIMIT]", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    await expect(
      retryAppDeliveries("app_1", { queue }, { limit: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      retryAppDeliveries("app_1", { queue }, { limit: MAX_LIST_DELIVERIES_LIMIT + 1 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("exports DEFAULT_BULK_RETRY_LIMIT equal to MAX_LIST_DELIVERIES_LIMIT", () => {
    expect(DEFAULT_BULK_RETRY_LIMIT).toBe(MAX_LIST_DELIVERIES_LIMIT);
  });
});
