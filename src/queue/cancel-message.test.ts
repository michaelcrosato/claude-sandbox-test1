import { describe, expect, it } from "vitest";
import { InMemoryDeliveryQueue } from "./in-memory-queue.js";
import { cancelMessageDeliveries } from "./cancel-message.js";
import type { DeliveryTask } from "./delivery-queue.js";
import { fixedSchedule } from "../delivery/retry-policy.js";

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

describe("cancelMessageDeliveries", () => {
  it("cancels a pending delivery (status becomes 'cancelled')", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    await queue.enqueue({ messageId: "m", endpointId: "ep" });

    const result = await cancelMessageDeliveries("m", { queue });
    expect(result.messageId).toBe("m");
    expect(result.cancelled).toBe(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.status).toBe("cancelled");
  });

  it("only cancels pending — succeeded/dead_letter left alone", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const a = await queue.enqueue({ messageId: "m", endpointId: "epA" });
    const b = await queue.enqueue({ messageId: "m", endpointId: "epB" });
    const c = await queue.enqueue({ messageId: "m", endpointId: "epC" });

    // Claim a and b (oldest-first); c is never claimed → stays pending.
    const claimed = await queue.claimDue({ nowMs: clock.now(), limit: 2 });
    await queue.fail(claimed[0]!.id, claimed[0]!.leaseToken!, {
      error: "down",
      nowMs: clock.now(),
    }); // a → dead_letter
    await queue.complete(claimed[1]!.id, claimed[1]!.leaseToken!); // b → succeeded

    const result = await cancelMessageDeliveries("m", { queue });
    expect(result.cancelled).toBe(1); // only c

    const after = byId(result.tasks);
    expect(after[a.id]!.status).toBe("dead_letter"); // untouched
    expect(after[b.id]!.status).toBe("succeeded"); // untouched
    expect(after[c.id]!.status).toBe("cancelled"); // cancelled
  });

  it("is a no-op when nothing is pending", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const enq = await queue.enqueue({ messageId: "m", endpointId: "ep" });

    // Claim and complete → succeeded
    const claimed = await queue.claimDue({ nowMs: clock.now() });
    await queue.complete(claimed[0]!.id, claimed[0]!.leaseToken!);

    const result = await cancelMessageDeliveries("m", { queue });
    expect(result.cancelled).toBe(0);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe(enq.id);
    expect(result.tasks[0]!.status).toBe("succeeded");
  });

  it("returns cancelled:0 and no tasks for a message with no deliveries", async () => {
    const clock = makeClock();
    const queue = makeQueue(clock);
    const result = await cancelMessageDeliveries("msg_unknown", { queue });
    expect(result).toEqual({ messageId: "msg_unknown", cancelled: 0, tasks: [] });
  });
});
