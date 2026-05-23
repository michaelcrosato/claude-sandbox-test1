/**
 * The shared behavioural contract for any {@link MessageStore} backend.
 *
 * Every backend (in-memory, SQLite, and the Postgres backend to come) must
 * pass this one suite, so "matches the reference semantics" is a fact the test
 * run proves rather than a comment we hope holds. Backends supply a factory;
 * the suite drives it with an injected deterministic clock + id generator so
 * timing and ids are reproducible across engines.
 *
 * Not a `*.test.ts` file, so Vitest does not collect it directly — each backend
 * imports {@link describeMessageStoreContract} and calls it from its own test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdempotencyConflictError, type MessageStore } from "./message-store.js";

/** A controllable clock + deterministic id generator for reproducible tests. */
export interface ConformanceClock {
  advance(ms: number): void;
  now: () => number;
  generateId: () => string;
}

/** Build a fresh clock starting at `startMs` with sequential `msg_test_N` ids. */
export function makeConformanceClock(
  startMs = 1_700_000_000_000,
): ConformanceClock {
  let nowMs = startMs;
  let seq = 0;
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    generateId: () => `msg_test_${++seq}`,
  };
}

/** The options every backend factory must honour for conformance. */
export interface ConformanceStoreOptions {
  now: () => number;
  generateId: () => string;
  idempotencyWindowMs?: number;
}

/** Constructs a backend under test from injected determinism options. */
export type MessageStoreFactory = (
  options: ConformanceStoreOptions,
) => MessageStore;

/** The tenant the bulk of the contract operates within. */
const APP = "app_1";

/**
 * Register the full {@link MessageStore} contract against one backend.
 *
 * @param label    Human-readable backend name, used in the describe block.
 * @param makeStore Factory that builds a fresh store from the given options.
 */
export function describeMessageStoreContract(
  label: string,
  makeStore: MessageStoreFactory,
): void {
  describe(`${label} — MessageStore contract`, () => {
    let clock: ConformanceClock;
    /** Stores built during a test; closed afterwards if they expose close(). */
    const created: MessageStore[] = [];

    /** Build a store and register it for teardown. */
    function make(
      options?: Partial<ConformanceStoreOptions> & {
        idempotencyWindowMs?: number;
      },
    ): MessageStore {
      const store = makeStore({
        now: clock.now,
        generateId: clock.generateId,
        ...options,
      });
      created.push(store);
      return store;
    }

    let store: MessageStore;
    beforeEach(() => {
      clock = makeConformanceClock();
      store = make();
    });

    afterEach(() => {
      for (const s of created) {
        const close = (s as { close?: () => void }).close;
        if (typeof close === "function") close.call(s);
      }
      created.length = 0;
    });

    describe("create — basics", () => {
      it("creates a message with assigned id, timestamp, and no dedup", async () => {
        const { message, deduplicated } = await store.create({
          appId: APP,
          eventType: "user.created",
          payload: '{"id":1}',
        });
        expect(deduplicated).toBe(false);
        expect(message.id).toBe("msg_test_1");
        expect(message.appId).toBe(APP);
        expect(message.eventType).toBe("user.created");
        expect(message.payload).toBe('{"id":1}');
        expect(message.createdAt).toBe(clock.now());
        expect(message.idempotencyKey).toBeNull();
        expect(await store.get(message.id)).toEqual(message);
      });

      it("retrieves a created message by id, and null for unknown ids", async () => {
        const { message } = await store.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
        });
        expect(await store.get(message.id)).toEqual(message);
        expect(await store.get("msg_nope")).toBeNull();
      });

      it("creates distinct messages when no idempotency key is given", async () => {
        const a = await store.create({ appId: APP, eventType: "e", payload: "{}" });
        const b = await store.create({ appId: APP, eventType: "e", payload: "{}" });
        expect(a.message.id).not.toBe(b.message.id);
        expect(await store.get(a.message.id)).toEqual(a.message);
        expect(await store.get(b.message.id)).toEqual(b.message);
      });

      it("accepts an empty-string payload", async () => {
        const { message } = await store.create({
          appId: APP,
          eventType: "e",
          payload: "",
        });
        expect(message.payload).toBe("");
      });

      it("rejects an empty appId, eventType, a non-string payload, and an empty key", async () => {
        await expect(
          store.create({ appId: "", eventType: "e", payload: "{}" }),
        ).rejects.toThrow(TypeError);
        await expect(
          store.create({ appId: APP, eventType: "", payload: "{}" }),
        ).rejects.toThrow(TypeError);
        await expect(
          // @ts-expect-error — payload must be a string
          store.create({ appId: APP, eventType: "e", payload: 123 }),
        ).rejects.toThrow(TypeError);
        await expect(
          store.create({
            appId: APP,
            eventType: "e",
            payload: "{}",
            idempotencyKey: "",
          }),
        ).rejects.toThrow(TypeError);
      });
    });

    describe("create — idempotency", () => {
      it("collapses repeats with the same key onto the first message", async () => {
        const first = await store.create({
          appId: APP,
          eventType: "user.created",
          payload: '{"id":1}',
          idempotencyKey: "key-1",
        });
        expect(first.deduplicated).toBe(false);

        const repeat = await store.create({
          appId: APP,
          eventType: "user.created",
          payload: '{"id":1}',
          idempotencyKey: "key-1",
        });
        expect(repeat.deduplicated).toBe(true);
        expect(repeat.message).toEqual(first.message);
      });

      it("records the idempotency key on the stored message", async () => {
        const { message } = await store.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });
        expect(message.idempotencyKey).toBe("key-1");
      });

      it("looks a message up by its idempotency key", async () => {
        const { message } = await store.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });
        expect(await store.getByIdempotencyKey(APP, "key-1")).toEqual(message);
        expect(await store.getByIdempotencyKey(APP, "absent")).toBeNull();
      });

      it("treats different keys as different messages", async () => {
        const a = await store.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-a",
        });
        const b = await store.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-b",
        });
        expect(a.message.id).not.toBe(b.message.id);
        expect(await store.get(a.message.id)).toEqual(a.message);
        expect(await store.get(b.message.id)).toEqual(b.message);
      });

      it("throws IdempotencyConflictError when a key is reused for a different request", async () => {
        const first = await store.create({
          appId: APP,
          eventType: "user.created",
          payload: '{"id":1}',
          idempotencyKey: "key-1",
        });
        await expect(
          store.create({
            appId: APP,
            eventType: "user.created",
            payload: '{"id":2}', // same key, different payload
            idempotencyKey: "key-1",
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
        // A different eventType under the same key also conflicts.
        await expect(
          store.create({
            appId: APP,
            eventType: "user.updated",
            payload: '{"id":1}',
            idempotencyKey: "key-1",
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
        // Nothing extra was stored: the key still resolves to the original.
        expect(await store.getByIdempotencyKey(APP, "key-1")).toEqual(
          first.message,
        );
      });
    });

    describe("create — idempotency is scoped per tenant", () => {
      it("does not dedup, conflict, or leak across apps for the same key", async () => {
        const a = await store.create({
          appId: "app_a",
          eventType: "user.created",
          payload: '{"id":1}',
          idempotencyKey: "shared-key",
        });
        // Same key, different app, even a *different* payload: no conflict, a
        // brand-new message — the key namespaces are independent.
        const b = await store.create({
          appId: "app_b",
          eventType: "user.created",
          payload: '{"id":2}',
          idempotencyKey: "shared-key",
        });
        expect(b.deduplicated).toBe(false);
        expect(b.message.id).not.toBe(a.message.id);

        // Each app's lookup resolves only its own message — no cross-tenant leak.
        expect(await store.getByIdempotencyKey("app_a", "shared-key")).toEqual(
          a.message,
        );
        expect(await store.getByIdempotencyKey("app_b", "shared-key")).toEqual(
          b.message,
        );
        // An app that never used the key sees nothing.
        expect(
          await store.getByIdempotencyKey("app_c", "shared-key"),
        ).toBeNull();
      });

      it("still dedups a repeat within the same app", async () => {
        const first = await store.create({
          appId: "app_a",
          eventType: "e",
          payload: "{}",
          idempotencyKey: "k",
        });
        await store.create({
          appId: "app_b",
          eventType: "e",
          payload: "{}",
          idempotencyKey: "k",
        });
        const repeat = await store.create({
          appId: "app_a",
          eventType: "e",
          payload: "{}",
          idempotencyKey: "k",
        });
        expect(repeat.deduplicated).toBe(true);
        expect(repeat.message.id).toBe(first.message.id);
      });
    });

    describe("create — idempotency window (TTL)", () => {
      it("creates a fresh message once the key's window has elapsed", async () => {
        const ttl = 1_000;
        const ttlStore = make({ idempotencyWindowMs: ttl });

        const first = await ttlStore.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });

        clock.advance(ttl); // reach exactly the expiry boundary (>= window)
        const afterExpiry = await ttlStore.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });

        expect(afterExpiry.deduplicated).toBe(false);
        expect(afterExpiry.message.id).not.toBe(first.message.id);
        // The original is preserved, not overwritten.
        expect(await ttlStore.get(first.message.id)).toEqual(first.message);
      });

      it("still dedups within the window", async () => {
        const ttlStore = make({ idempotencyWindowMs: 1_000 });
        const first = await ttlStore.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });
        clock.advance(999); // still inside the window
        const repeat = await ttlStore.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });
        expect(repeat.deduplicated).toBe(true);
        expect(repeat.message.id).toBe(first.message.id);
      });

      it("reports an expired key as absent via getByIdempotencyKey", async () => {
        const ttlStore = make({ idempotencyWindowMs: 1_000 });
        await ttlStore.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });
        clock.advance(1_000);
        expect(await ttlStore.getByIdempotencyKey(APP, "key-1")).toBeNull();
      });

      it("never expires keys when the window is Infinity", async () => {
        const foreverStore = make({
          idempotencyWindowMs: Number.POSITIVE_INFINITY,
        });
        const first = await foreverStore.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });
        clock.advance(10 * 365 * 24 * 60 * 60 * 1_000); // a decade later
        const repeat = await foreverStore.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "key-1",
        });
        expect(repeat.deduplicated).toBe(true);
        expect(repeat.message.id).toBe(first.message.id);
      });
    });
  });
}
