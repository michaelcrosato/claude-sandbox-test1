import { describe, expect, it } from "vitest";
import { InMemoryDeliveryQueue } from "./in-memory-queue.js";
import {
  describeDeliveryQueueContract,
  makeQueueConformanceClock,
} from "./conformance.js";

// The in-memory queue is the reference backend: it must satisfy the full shared
// contract that every durable backend is also held to.
describeDeliveryQueueContract(
  "InMemoryDeliveryQueue",
  (options) => new InMemoryDeliveryQueue(options),
);

describe("InMemoryDeliveryQueue — specifics", () => {
  it("rejects a non-positive visibility timeout at construction", () => {
    expect(() => new InMemoryDeliveryQueue({ visibilityTimeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new InMemoryDeliveryQueue({ visibilityTimeoutMs: -1 })).toThrow(
      RangeError,
    );
  });

  it("reports task count via size and never prunes terminal tasks", async () => {
    const clock = makeQueueConformanceClock();
    const queue = new InMemoryDeliveryQueue({
      now: clock.now,
      generateId: clock.generateId,
      generateLeaseToken: clock.generateLeaseToken,
    });
    expect(queue.size).toBe(0);
    await queue.enqueue({ messageId: "a" });
    await queue.enqueue({ messageId: "b" });
    expect(queue.size).toBe(2);

    const [task] = await queue.claimDue({ nowMs: clock.now() });
    await queue.complete(task!.id, task!.leaseToken!); // terminal
    expect(queue.size).toBe(2); // succeeded task is kept, not pruned
  });
});
