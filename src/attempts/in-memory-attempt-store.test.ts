import { describe, expect, it } from "vitest";
import { InMemoryDeliveryAttemptStore } from "./in-memory-attempt-store.js";
import {
  describeDeliveryAttemptStoreContract,
  makeAttemptConformanceIds,
} from "./conformance.js";

// The reference backend defines the contract every other backend must match.
describeDeliveryAttemptStoreContract(
  "InMemoryDeliveryAttemptStore",
  (options) => new InMemoryDeliveryAttemptStore(options),
);

describe("InMemoryDeliveryAttemptStore — specifics", () => {
  it("counts recorded attempts via size and never prunes them", async () => {
    const ids = makeAttemptConformanceIds();
    const store = new InMemoryDeliveryAttemptStore({ generateId: ids.generateId });
    expect(store.size).toBe(0);
    await store.record({
      taskId: "t1",
      messageId: "m1",
      attemptNumber: 1,
      outcome: "failed",
      durationMs: 0,
      attemptedAt: 1,
    });
    await store.record({
      taskId: "t1",
      messageId: "m1",
      attemptNumber: 2,
      outcome: "succeeded",
      durationMs: 3,
      attemptedAt: 2,
    });
    expect(store.size).toBe(2);
  });

  it("throws if the id generator collides", async () => {
    const store = new InMemoryDeliveryAttemptStore({ generateId: () => "datt_fixed" });
    await store.record({
      taskId: "t1",
      messageId: "m1",
      attemptNumber: 1,
      outcome: "succeeded",
      durationMs: 0,
      attemptedAt: 1,
    });
    await expect(
      store.record({
        taskId: "t1",
        messageId: "m1",
        attemptNumber: 2,
        outcome: "succeeded",
        durationMs: 0,
        attemptedAt: 2,
      }),
    ).rejects.toThrow(/collides/);
  });
});
