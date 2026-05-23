import { describe, expect, it } from "vitest";
import { InMemoryMessageStore } from "./in-memory-store.js";
import {
  describeMessageStoreContract,
  makeConformanceClock,
} from "./conformance.js";

// The in-memory store is the reference backend: it must satisfy the full
// shared contract that every other backend is also held to.
describeMessageStoreContract(
  "InMemoryMessageStore",
  (options) => new InMemoryMessageStore(options),
);

describe("InMemoryMessageStore — specifics", () => {
  it("rejects a non-positive idempotency window at construction", () => {
    expect(() => new InMemoryMessageStore({ idempotencyWindowMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new InMemoryMessageStore({ idempotencyWindowMs: -1 })).toThrow(
      RangeError,
    );
  });

  it("reports the number of messages held via size", async () => {
    const clock = makeConformanceClock();
    const store = new InMemoryMessageStore({
      now: clock.now,
      generateId: clock.generateId,
    });
    expect(store.size).toBe(0);
    await store.create({ eventType: "e", payload: "{}" });
    await store.create({ eventType: "e", payload: "{}" });
    expect(store.size).toBe(2);
    // A deduplicated create does not grow the store.
    await store.create({ eventType: "e", payload: "{}", idempotencyKey: "k" });
    await store.create({ eventType: "e", payload: "{}", idempotencyKey: "k" });
    expect(store.size).toBe(3);
  });
});
