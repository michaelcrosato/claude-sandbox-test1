import { beforeEach, describe, expect, it } from "vitest";
import { IdempotencyConflictError } from "./message-store.js";
import { InMemoryMessageStore } from "./in-memory-store.js";

/** A controllable clock + deterministic id generator for reproducible tests. */
function harness(startMs = 1_700_000_000_000) {
  let nowMs = startMs;
  let seq = 0;
  return {
    advance(ms: number): void {
      nowMs += ms;
    },
    now: () => nowMs,
    generateId: () => `msg_test_${++seq}`,
  };
}

let clock: ReturnType<typeof harness>;
let store: InMemoryMessageStore;

beforeEach(() => {
  clock = harness();
  store = new InMemoryMessageStore({
    now: clock.now,
    generateId: clock.generateId,
  });
});

describe("create — basics", () => {
  it("creates a message with assigned id, timestamp, and no dedup", async () => {
    const { message, deduplicated } = await store.create({
      eventType: "user.created",
      payload: '{"id":1}',
    });
    expect(deduplicated).toBe(false);
    expect(message.id).toBe("msg_test_1");
    expect(message.eventType).toBe("user.created");
    expect(message.payload).toBe('{"id":1}');
    expect(message.createdAt).toBe(clock.now());
    expect(message.idempotencyKey).toBeNull();
    expect(store.size).toBe(1);
  });

  it("retrieves a created message by id, and null for unknown ids", async () => {
    const { message } = await store.create({
      eventType: "e",
      payload: "{}",
    });
    expect(await store.get(message.id)).toEqual(message);
    expect(await store.get("msg_nope")).toBeNull();
  });

  it("creates distinct messages when no idempotency key is given", async () => {
    const a = await store.create({ eventType: "e", payload: "{}" });
    const b = await store.create({ eventType: "e", payload: "{}" });
    expect(a.message.id).not.toBe(b.message.id);
    expect(store.size).toBe(2);
  });

  it("accepts an empty-string payload", async () => {
    const { message } = await store.create({ eventType: "e", payload: "" });
    expect(message.payload).toBe("");
  });

  it("rejects an empty eventType, a non-string payload, and an empty key", async () => {
    await expect(store.create({ eventType: "", payload: "{}" })).rejects.toThrow(
      TypeError,
    );
    await expect(
      // @ts-expect-error — payload must be a string
      store.create({ eventType: "e", payload: 123 }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.create({ eventType: "e", payload: "{}", idempotencyKey: "" }),
    ).rejects.toThrow(TypeError);
  });
});

describe("create — idempotency", () => {
  it("collapses repeats with the same key onto the first message", async () => {
    const first = await store.create({
      eventType: "user.created",
      payload: '{"id":1}',
      idempotencyKey: "key-1",
    });
    expect(first.deduplicated).toBe(false);

    const repeat = await store.create({
      eventType: "user.created",
      payload: '{"id":1}',
      idempotencyKey: "key-1",
    });
    expect(repeat.deduplicated).toBe(true);
    expect(repeat.message).toEqual(first.message);
    expect(store.size).toBe(1); // no duplicate created
  });

  it("records the idempotency key on the stored message", async () => {
    const { message } = await store.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });
    expect(message.idempotencyKey).toBe("key-1");
  });

  it("looks a message up by its idempotency key", async () => {
    const { message } = await store.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });
    expect(await store.getByIdempotencyKey("key-1")).toEqual(message);
    expect(await store.getByIdempotencyKey("absent")).toBeNull();
  });

  it("treats different keys as different messages", async () => {
    const a = await store.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-a",
    });
    const b = await store.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-b",
    });
    expect(a.message.id).not.toBe(b.message.id);
    expect(store.size).toBe(2);
  });

  it("throws IdempotencyConflictError when a key is reused for a different request", async () => {
    await store.create({
      eventType: "user.created",
      payload: '{"id":1}',
      idempotencyKey: "key-1",
    });
    await expect(
      store.create({
        eventType: "user.created",
        payload: '{"id":2}', // same key, different payload
        idempotencyKey: "key-1",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    // A different eventType under the same key also conflicts.
    await expect(
      store.create({
        eventType: "user.updated",
        payload: '{"id":1}',
        idempotencyKey: "key-1",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(store.size).toBe(1); // nothing extra created on conflict
  });
});

describe("create — idempotency window (TTL)", () => {
  it("creates a fresh message once the key's window has elapsed", async () => {
    const ttl = 1_000;
    const ttlStore = new InMemoryMessageStore({
      now: clock.now,
      generateId: clock.generateId,
      idempotencyWindowMs: ttl,
    });

    const first = await ttlStore.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });

    clock.advance(ttl); // reach exactly the expiry boundary (>= window)
    const afterExpiry = await ttlStore.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });

    expect(afterExpiry.deduplicated).toBe(false);
    expect(afterExpiry.message.id).not.toBe(first.message.id);
    expect(ttlStore.size).toBe(2); // original is preserved, not overwritten
    expect(await ttlStore.get(first.message.id)).toEqual(first.message);
  });

  it("still dedups within the window", async () => {
    const ttlStore = new InMemoryMessageStore({
      now: clock.now,
      generateId: clock.generateId,
      idempotencyWindowMs: 1_000,
    });
    const first = await ttlStore.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });
    clock.advance(999); // still inside the window
    const repeat = await ttlStore.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });
    expect(repeat.deduplicated).toBe(true);
    expect(repeat.message.id).toBe(first.message.id);
  });

  it("reports an expired key as absent via getByIdempotencyKey", async () => {
    const ttlStore = new InMemoryMessageStore({
      now: clock.now,
      generateId: clock.generateId,
      idempotencyWindowMs: 1_000,
    });
    await ttlStore.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });
    clock.advance(1_000);
    expect(await ttlStore.getByIdempotencyKey("key-1")).toBeNull();
  });

  it("never expires keys when the window is Infinity", async () => {
    const foreverStore = new InMemoryMessageStore({
      now: clock.now,
      generateId: clock.generateId,
      idempotencyWindowMs: Number.POSITIVE_INFINITY,
    });
    const first = await foreverStore.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });
    clock.advance(10 * 365 * 24 * 60 * 60 * 1_000); // a decade later
    const repeat = await foreverStore.create({
      eventType: "e",
      payload: "{}",
      idempotencyKey: "key-1",
    });
    expect(repeat.deduplicated).toBe(true);
    expect(repeat.message.id).toBe(first.message.id);
  });

  it("rejects a non-positive idempotency window at construction", () => {
    expect(() => new InMemoryMessageStore({ idempotencyWindowMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new InMemoryMessageStore({ idempotencyWindowMs: -1 })).toThrow(
      RangeError,
    );
  });
});
