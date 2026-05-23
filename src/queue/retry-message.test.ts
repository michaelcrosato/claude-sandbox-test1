import { describe, expect, it } from "vitest";
import { InMemoryDeliveryQueue } from "./in-memory-queue.js";
import { retryMessageDeliveries } from "./retry-message.js";
import type { DeliveryTask } from "./delivery-queue.js";
import { fixedSchedule } from "../delivery/retry-policy.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import { ingest } from "../fanout/fanout.js";
import { DeliveryWorker } from "../worker/delivery-worker.js";

/** Controllable clock + deterministic id/lease-token generators. */
function makeClock(start = 1_700_000_000_000) {
  let now = start;
  let idSeq = 0;
  let leaseSeq = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    id: () => `dtask_${++idSeq}`,
    lease: () => `lease_${++leaseSeq}`,
  };
}

/** A queue whose policy dead-letters on the first failure (no retries). */
function makeQueue(clock: ReturnType<typeof makeClock>): InMemoryDeliveryQueue {
  return new InMemoryDeliveryQueue({
    now: clock.now,
    generateId: clock.id,
    generateLeaseToken: clock.lease,
    retryPolicy: fixedSchedule([]), // 1 attempt → dead_letter on failure
  });
}

function byId(tasks: readonly DeliveryTask[]): Record<string, DeliveryTask> {
  return Object.fromEntries(tasks.map((t) => [t.id, t]));
}

describe("retryMessageDeliveries", () => {
  it("revives a dead-lettered delivery to a fresh, deliverable pending state", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    await queue.enqueue({ messageId: "m", endpointId: "ep" });
    const [t] = await queue.claimDue({ nowMs: clock.now() });
    const dead = await queue.fail(t!.id, t!.leaseToken!, {
      error: "down",
      nowMs: clock.now(),
    });
    expect(dead.status).toBe("dead_letter");

    const result = await retryMessageDeliveries("m", { queue });
    expect(result.messageId).toBe("m");
    expect(result.retried).toBe(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.status).toBe("pending");
    expect(result.tasks[0]!.attempts).toBe(0);
    expect(result.tasks[0]!.lastError).toBeNull();
  });

  it("only re-drives dead-lettered deliveries — succeeded/pending are left alone", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const a = await queue.enqueue({ messageId: "m", endpointId: "epA" });
    const b = await queue.enqueue({ messageId: "m", endpointId: "epB" });
    const c = await queue.enqueue({ messageId: "m", endpointId: "epC" });

    // Claim only a and b (oldest-first); c is never claimed → stays pending.
    const claimed = await queue.claimDue({ nowMs: clock.now(), limit: 2 });
    await queue.fail(claimed[0]!.id, claimed[0]!.leaseToken!, {
      error: "down",
      nowMs: clock.now(),
    }); // a → dead_letter
    await queue.complete(claimed[1]!.id, claimed[1]!.leaseToken!); // b → succeeded

    const result = await retryMessageDeliveries("m", { queue });
    expect(result.retried).toBe(1); // only a

    const after = byId(result.tasks);
    expect(after[a.id]!.status).toBe("pending"); // revived
    expect(after[a.id]!.attempts).toBe(0);
    expect(after[b.id]!.status).toBe("succeeded"); // untouched
    expect(after[c.id]!.status).toBe("pending"); // untouched, still its original pending
    expect(after[c.id]!.attempts).toBe(0);
  });

  it("is a no-op when nothing is dead-lettered", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const enq = await queue.enqueue({ messageId: "m", endpointId: "ep" });

    const result = await retryMessageDeliveries("m", { queue });
    expect(result.retried).toBe(0);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe(enq.id);
    expect(result.tasks[0]!.status).toBe("pending");
  });

  it("returns retried 0 and no tasks for a message with no deliveries", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const result = await retryMessageDeliveries("msg_unknown", { queue });
    expect(result).toEqual({ messageId: "msg_unknown", retried: 0, tasks: [] });
  });

  it("recovers a dead-lettered message end-to-end once the receiver is fixed", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    await endpoints.create({ appId: "app_1", url: "https://acme.example/hook" });
    const { message } = await ingest(
      {
        appId: "app_1",
        eventType: "user.created",
        payload: JSON.stringify({ id: 1 }),
      },
      { messages, endpoints, queue },
    );

    let receiverUp = false;
    const worker = new DeliveryWorker({
      queue,
      store: messages,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport: async () => ({ status: receiverUp ? 200 : 500 }),
      now: clock.now,
    });

    // Receiver down: the single attempt fails and the delivery dead-letters.
    const tick1 = await worker.processOnce();
    expect(tick1.deadLettered).toBe(1);
    expect((await queue.listByMessage(message.id))[0]!.status).toBe("dead_letter");

    // The operator fixes the receiver and replays the dead-lettered delivery.
    receiverUp = true;
    const result = await retryMessageDeliveries(message.id, { queue });
    expect(result.retried).toBe(1);

    // The worker now delivers it successfully — fully recovered.
    const tick2 = await worker.processOnce();
    expect(tick2.succeeded).toBe(1);
    expect((await queue.listByMessage(message.id))[0]!.status).toBe("succeeded");
  });
});
