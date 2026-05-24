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
import {
  IdempotencyConflictError,
  utcDayKey,
  type MessageStore,
} from "./message-store.js";

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

    describe("outbox — fan-out tracking", () => {
      it("marks a new message as pending fan-out and lists it (oldest-first)", async () => {
        const { message, fanoutPending } = await store.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
        });
        expect(fanoutPending).toBe(true);
        const pending = await store.listPendingFanout();
        expect(pending.map((m) => m.id)).toEqual([message.id]);
        expect(pending[0]).toEqual(message); // the full message, not a marker view
      });

      it("clears the marker on markFannedOut, idempotently and safely on unknown ids", async () => {
        const { message } = await store.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
        });
        await store.markFannedOut(message.id);
        expect(await store.listPendingFanout()).toEqual([]);
        // A repeat call, and an unknown id, are harmless no-ops.
        await store.markFannedOut(message.id);
        await store.markFannedOut("msg_does_not_exist");
        expect(await store.listPendingFanout()).toEqual([]);
      });

      it("reports a deduplicated retry as still pending until fan-out is marked done", async () => {
        const input = {
          appId: APP,
          eventType: "e",
          payload: "{}",
          idempotencyKey: "k",
        };
        const first = await store.create(input);
        expect(first.fanoutPending).toBe(true);

        // A retry before the original's fan-out completed still owes one — this
        // is the crash-window recovery signal ingest acts on.
        const retry = await store.create(input);
        expect(retry.deduplicated).toBe(true);
        expect(retry.fanoutPending).toBe(true);

        // Once the fan-out is recorded done, a further retry reports it settled
        // and the message leaves the outbox.
        await store.markFannedOut(first.message.id);
        const afterDone = await store.create(input);
        expect(afterDone.deduplicated).toBe(true);
        expect(afterDone.fanoutPending).toBe(false);
        expect(await store.listPendingFanout()).toEqual([]);
      });

      it("tracks messages with no idempotency key too", async () => {
        const { message } = await store.create({
          appId: APP,
          eventType: "e",
          payload: "{}",
        });
        expect((await store.listPendingFanout()).map((m) => m.id)).toContain(
          message.id,
        );
        await store.markFannedOut(message.id);
        expect(await store.listPendingFanout()).toEqual([]);
      });

      it("honours the limit, returning the oldest pending first", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const { message } = await store.create({
            appId: APP,
            eventType: "e",
            payload: "{}",
          });
          ids.push(message.id);
          clock.advance(1);
        }
        expect((await store.listPendingFanout()).map((m) => m.id)).toEqual(ids);
        expect(
          (await store.listPendingFanout({ limit: 2 })).map((m) => m.id),
        ).toEqual(ids.slice(0, 2));
      });

      it("filters by createdAtOrBefore so a dispatcher can skip too-fresh messages", async () => {
        const old = await store.create({ appId: APP, eventType: "e", payload: "{}" });
        clock.advance(10_000);
        const fresh = await store.create({ appId: APP, eventType: "e", payload: "{}" });

        // Cutoff at the older message's creation time excludes the fresher one.
        expect(
          (
            await store.listPendingFanout({
              createdAtOrBefore: old.message.createdAt,
            })
          ).map((m) => m.id),
        ).toEqual([old.message.id]);
        // No cutoff: both, oldest-first.
        expect((await store.listPendingFanout()).map((m) => m.id)).toEqual([
          old.message.id,
          fresh.message.id,
        ]);
      });

      it("rejects a non-positive limit", async () => {
        await expect(store.listPendingFanout({ limit: 0 })).rejects.toThrow(
          RangeError,
        );
      });
    });

    describe("listByApp — pagination", () => {
      /** Create `n` messages under `appId`, one ms apart, returning their ids. */
      async function seed(n: number, appId = APP): Promise<string[]> {
        const ids: string[] = [];
        for (let i = 0; i < n; i += 1) {
          const { message } = await store.create({
            appId,
            eventType: "e",
            payload: `{"i":${i}}`,
          });
          ids.push(message.id);
          clock.advance(1);
        }
        return ids;
      }

      it("returns an empty page for an empty store or unknown app", async () => {
        expect(await store.listByApp(APP)).toEqual({
          messages: [],
          nextCursor: null,
        });
        await seed(2);
        expect(await store.listByApp("app_with_nothing")).toEqual({
          messages: [],
          nextCursor: null,
        });
      });

      it("lists a tenant's messages newest-first", async () => {
        const ids = await seed(3); // oldest → newest
        const page = await store.listByApp(APP);
        expect(page.messages.map((m) => m.id)).toEqual([...ids].reverse());
        expect(page.nextCursor).toBeNull(); // fits in one default page
        expect(page.messages[0]).toEqual(await store.get(ids[2]!)); // full message
      });

      it("scopes the listing to the app, never leaking another tenant's", async () => {
        const aIds = await seed(2, "app_a");
        const bIds = await seed(3, "app_b");
        expect((await store.listByApp("app_a")).messages.map((m) => m.id)).toEqual(
          [...aIds].reverse(),
        );
        expect((await store.listByApp("app_b")).messages.map((m) => m.id)).toEqual(
          [...bIds].reverse(),
        );
      });

      it("pages through with a cursor, in order and without overlap or gaps", async () => {
        const ids = await seed(5);
        const newestFirst = [...ids].reverse();

        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await store.listByApp(APP, {
            limit: 2,
            ...(cursor !== null ? { cursor } : {}),
          });
          seen.push(...page.messages.map((m) => m.id));
          cursor = page.nextCursor;
          pages += 1;
          expect(pages).toBeLessThanOrEqual(5); // guard against a paging loop
        } while (cursor !== null);

        expect(pages).toBe(3); // [5,4] [3,2] [1]
        expect(seen).toEqual(newestFirst); // exact, ordered coverage
      });

      it("ends cleanly when the total is an exact multiple of the limit", async () => {
        const ids = await seed(4);
        const first = await store.listByApp(APP, { limit: 2 });
        expect(first.messages.map((m) => m.id)).toEqual([ids[3], ids[2]]);
        expect(first.nextCursor).not.toBeNull();

        const second = await store.listByApp(APP, {
          limit: 2,
          cursor: first.nextCursor!,
        });
        expect(second.messages.map((m) => m.id)).toEqual([ids[1], ids[0]]);
        // No phantom empty trailing page: the last full page reports no cursor.
        expect(second.nextCursor).toBeNull();
      });

      it("breaks createdAt ties by id (descending) and pages stably across the tie", async () => {
        // Three messages sharing one createdAt (clock never advanced).
        const ids: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const { message } = await store.create({
            appId: APP,
            eventType: "e",
            payload: "{}",
          });
          ids.push(message.id);
        }
        const byIdDesc = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        expect((await store.listByApp(APP)).messages.map((m) => m.id)).toEqual(
          byIdDesc,
        );

        const first = await store.listByApp(APP, { limit: 2 });
        expect(first.messages.map((m) => m.id)).toEqual(byIdDesc.slice(0, 2));
        const second = await store.listByApp(APP, {
          limit: 2,
          cursor: first.nextCursor!,
        });
        expect(second.messages.map((m) => m.id)).toEqual(byIdDesc.slice(2));
        expect(second.nextCursor).toBeNull();
      });

      it("rejects an out-of-range or non-integer limit", async () => {
        await expect(store.listByApp(APP, { limit: 0 })).rejects.toThrow(RangeError);
        await expect(store.listByApp(APP, { limit: -1 })).rejects.toThrow(RangeError);
        await expect(store.listByApp(APP, { limit: 1.5 })).rejects.toThrow(RangeError);
        await expect(store.listByApp(APP, { limit: 201 })).rejects.toThrow(RangeError);
      });

      it("rejects a malformed cursor", async () => {
        await expect(
          store.listByApp(APP, { cursor: "not-a-real-cursor!!" }),
        ).rejects.toThrow(TypeError);
        await expect(store.listByApp(APP, { cursor: "" })).rejects.toThrow(
          TypeError,
        );
      });

      it("round-trips a real nextCursor as the next page's cursor", async () => {
        const ids = await seed(3);
        const first = await store.listByApp(APP, { limit: 1 });
        expect(first.messages.map((m) => m.id)).toEqual([ids[2]]);
        expect(first.nextCursor).toBeTypeOf("string");
        const second = await store.listByApp(APP, {
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(second.messages.map((m) => m.id)).toEqual([ids[1]]);
      });

      it("filters by eventType, returning only matching messages newest-first", async () => {
        const a1 = await store.create({ appId: APP, eventType: "user.created", payload: "{}" });
        clock.advance(1);
        const _b = await store.create({ appId: APP, eventType: "order.placed", payload: "{}" });
        clock.advance(1);
        const a2 = await store.create({ appId: APP, eventType: "user.created", payload: "{}" });

        const page = await store.listByApp(APP, { eventType: "user.created" });
        expect(page.messages.map((m) => m.id)).toEqual([a2.message.id, a1.message.id]);
        expect(page.nextCursor).toBeNull();
      });

      it("returns an empty page when no messages match the eventType filter", async () => {
        await seed(3); // all have eventType "e"
        const page = await store.listByApp(APP, { eventType: "does.not.exist" });
        expect(page.messages).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });

      it("pages through a filtered result with a cursor", async () => {
        // 3 "user.created" interleaved with 2 "order.placed"
        const ucIds: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const { message } = await store.create({ appId: APP, eventType: "user.created", payload: `{"i":${i}}` });
          ucIds.push(message.id);
          clock.advance(1);
          await store.create({ appId: APP, eventType: "order.placed", payload: "{}" });
          clock.advance(1);
        }
        // Newest-first within the filter: ucIds[2], ucIds[1], ucIds[0]
        const expected = [...ucIds].reverse();

        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page = await store.listByApp(APP, {
            eventType: "user.created",
            limit: 2,
            ...(cursor !== null ? { cursor } : {}),
          });
          seen.push(...page.messages.map((m) => m.id));
          cursor = page.nextCursor;
        } while (cursor !== null);

        expect(seen).toEqual(expected);
      });

      it("null or omitted eventType returns all messages (no filter)", async () => {
        const a = await store.create({ appId: APP, eventType: "a", payload: "{}" });
        clock.advance(1);
        const b = await store.create({ appId: APP, eventType: "b", payload: "{}" });

        const pageOmitted = await store.listByApp(APP);
        expect(pageOmitted.messages.map((m) => m.id)).toEqual([b.message.id, a.message.id]);

        const pageNull = await store.listByApp(APP, { eventType: null });
        expect(pageNull.messages.map((m) => m.id)).toEqual([b.message.id, a.message.id]);
      });
    });

    describe("summarizeUsageByApp — per-tenant usage", () => {
      const DAY_MS = 86_400_000;
      const fullRange = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER };

      it("returns a zero summary for a tenant with no messages in range", async () => {
        expect(await store.summarizeUsageByApp(APP, fullRange)).toEqual({
          appId: APP,
          fromMs: 0,
          toMs: Number.MAX_SAFE_INTEGER,
          total: 0,
          daily: [],
        });
        // A message outside the half-open range is excluded too (toMs is exclusive).
        const { message } = await store.create({ appId: APP, eventType: "e", payload: "{}" });
        const before = await store.summarizeUsageByApp(APP, {
          fromMs: 0,
          toMs: message.createdAt,
        });
        expect(before.total).toBe(0);
        expect(before.daily).toEqual([]);
      });

      it("counts messages grouped by UTC day, oldest-day-first, with a running total", async () => {
        const d0 = await store.create({ appId: APP, eventType: "e", payload: "{}" });
        clock.advance(DAY_MS);
        const d1 = await store.create({ appId: APP, eventType: "e", payload: "{}" });
        clock.advance(DAY_MS);
        const d2a = await store.create({ appId: APP, eventType: "e", payload: "{}" });
        const d2b = await store.create({ appId: APP, eventType: "e", payload: "{}" });

        const summary = await store.summarizeUsageByApp(APP, fullRange);
        expect(summary.total).toBe(4);
        // Three distinct, ascending UTC days; the last has two messages.
        expect(utcDayKey(d2b.message.createdAt)).toBe(utcDayKey(d2a.message.createdAt));
        expect(summary.daily).toEqual([
          { date: utcDayKey(d0.message.createdAt), messages: 1 },
          { date: utcDayKey(d1.message.createdAt), messages: 1 },
          { date: utcDayKey(d2a.message.createdAt), messages: 2 },
        ]);
      });

      it("scopes to the tenant — another app's messages are never counted", async () => {
        await store.create({ appId: "app_a", eventType: "e", payload: "{}" });
        await store.create({ appId: "app_a", eventType: "e", payload: "{}" });
        await store.create({ appId: "app_b", eventType: "e", payload: "{}" });
        expect((await store.summarizeUsageByApp("app_a", fullRange)).total).toBe(2);
        expect((await store.summarizeUsageByApp("app_b", fullRange)).total).toBe(1);
        expect((await store.summarizeUsageByApp("app_c", fullRange)).total).toBe(0);
      });

      it("applies the range half-open: includes fromMs, excludes toMs", async () => {
        const { message } = await store.create({ appId: APP, eventType: "e", payload: "{}" });
        const at = message.createdAt;
        // [at, at+1) includes the message…
        expect((await store.summarizeUsageByApp(APP, { fromMs: at, toMs: at + 1 })).total).toBe(1);
        // …[at+1, at+2) is entirely after it…
        expect((await store.summarizeUsageByApp(APP, { fromMs: at + 1, toMs: at + 2 })).total).toBe(0);
        // …and the upper bound is exclusive: [at-10, at) excludes a message at exactly `at`.
        expect((await store.summarizeUsageByApp(APP, { fromMs: at - 10, toMs: at })).total).toBe(0);
      });

      it("counts a deduplicated retry only once (one stored message)", async () => {
        const input = { appId: APP, eventType: "e", payload: "{}", idempotencyKey: "k" };
        await store.create(input);
        const retry = await store.create(input);
        expect(retry.deduplicated).toBe(true);
        const summary = await store.summarizeUsageByApp(APP, fullRange);
        expect(summary.total).toBe(1);
        expect(summary.daily).toEqual([
          { date: utcDayKey(retry.message.createdAt), messages: 1 },
        ]);
      });

      it("rejects an inverted range (fromMs > toMs)", async () => {
        await expect(
          store.summarizeUsageByApp(APP, { fromMs: 10, toMs: 5 }),
        ).rejects.toThrow(RangeError);
      });
    });
  });
}
