/**
 * The shared behavioural contract for any {@link DeliveryAttemptStore} backend.
 *
 * Every backend (in-memory reference, SQLite, and any future Postgres) runs this
 * one suite, so "the durable audit log behaves exactly like the reference" is a
 * fact the test run proves rather than a comment we hope holds. Backends supply a
 * factory; the suite drives it with an injected deterministic id generator so ids
 * are reproducible across engines.
 *
 * Not a `*.test.ts` file, so Vitest does not collect it directly — each backend
 * imports {@link describeDeliveryAttemptStoreContract} and calls it from its own
 * test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeNewAttempt,
  type DeliveryAttemptStore,
  type NewDeliveryAttempt,
} from "./delivery-attempt.js";

/** Deterministic id generator for the suite: sequential `datt_test_N`. */
export interface AttemptConformanceIds {
  generateId: () => string;
}

/** Build a fresh sequential `datt_test_N` id generator. */
export function makeAttemptConformanceIds(): AttemptConformanceIds {
  let seq = 0;
  return { generateId: () => `datt_test_${++seq}` };
}

/** The options every backend factory must honour for conformance. */
export interface ConformanceAttemptStoreOptions {
  generateId: () => string;
}

/** Constructs a backend under test from injected determinism options. */
export type DeliveryAttemptStoreFactory = (
  options: ConformanceAttemptStoreOptions,
) => DeliveryAttemptStore;

/** A complete, valid attempt input with the given overrides. */
function attemptInput(
  overrides: Partial<NewDeliveryAttempt> = {},
): NewDeliveryAttempt {
  return {
    taskId: "dtask_1",
    messageId: "msg_1",
    appId: "app_1",
    endpointId: "ep_1",
    attemptNumber: 1,
    outcome: "succeeded",
    responseStatus: 200,
    error: null,
    durationMs: 12,
    attemptedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Register the full {@link DeliveryAttemptStore} contract against one backend.
 *
 * @param label     Human-readable backend name, used in the describe block.
 * @param makeStore Factory that builds a fresh store from the given options.
 */
export function describeDeliveryAttemptStoreContract(
  label: string,
  makeStore: DeliveryAttemptStoreFactory,
): void {
  describe(`${label} — DeliveryAttemptStore contract`, () => {
    let ids: AttemptConformanceIds;
    /** Stores built during a test; closed afterwards if they expose close(). */
    const created: DeliveryAttemptStore[] = [];

    function make(): DeliveryAttemptStore {
      const store = makeStore({ generateId: ids.generateId });
      created.push(store);
      return store;
    }

    let store: DeliveryAttemptStore;
    beforeEach(() => {
      ids = makeAttemptConformanceIds();
      store = make();
    });

    afterEach(() => {
      for (const s of created) {
        const close = (s as { close?: () => void }).close;
        if (typeof close === "function") close.call(s);
      }
      created.length = 0;
    });

    describe("record", () => {
      it("stores an attempt with an assigned id and echoes every field", async () => {
        const input = attemptInput();
        const attempt = await store.record(input);
        expect(attempt).toEqual({ id: "datt_test_1", ...normalizeNewAttempt(input) });
      });

      it("defaults the optional fields to null", async () => {
        const attempt = await store.record({
          taskId: "dtask_1",
          messageId: "msg_1",
          attemptNumber: 1,
          outcome: "failed",
          durationMs: 0,
          attemptedAt: 1_700_000_000_000,
        });
        expect(attempt.appId).toBeNull();
        expect(attempt.endpointId).toBeNull();
        expect(attempt.responseStatus).toBeNull();
        expect(attempt.error).toBeNull();
      });

      it("records a failed attempt with its status and error", async () => {
        const attempt = await store.record(
          attemptInput({
            outcome: "failed",
            responseStatus: 503,
            error: "endpoint returned HTTP 503",
          }),
        );
        expect(attempt.outcome).toBe("failed");
        expect(attempt.responseStatus).toBe(503);
        expect(attempt.error).toBe("endpoint returned HTTP 503");
      });

      it("records a transport failure with a null status", async () => {
        const attempt = await store.record(
          attemptInput({
            outcome: "failed",
            responseStatus: null,
            error: "connection refused",
            durationMs: 0,
          }),
        );
        expect(attempt.responseStatus).toBeNull();
        expect(attempt.error).toBe("connection refused");
      });

      it("rejects malformed input with a TypeError", async () => {
        await expect(store.record(attemptInput({ taskId: "" }))).rejects.toThrow(TypeError);
        await expect(store.record(attemptInput({ messageId: "" }))).rejects.toThrow(TypeError);
        await expect(store.record(attemptInput({ appId: "" }))).rejects.toThrow(TypeError);
        await expect(store.record(attemptInput({ endpointId: "" }))).rejects.toThrow(TypeError);
        await expect(store.record(attemptInput({ attemptNumber: 0 }))).rejects.toThrow(TypeError);
        await expect(store.record(attemptInput({ attemptNumber: 1.5 }))).rejects.toThrow(TypeError);
        await expect(
          // @ts-expect-error — outcome must be a known literal
          store.record(attemptInput({ outcome: "maybe" })),
        ).rejects.toThrow(TypeError);
        await expect(store.record(attemptInput({ responseStatus: 1.5 }))).rejects.toThrow(TypeError);
        await expect(store.record(attemptInput({ durationMs: -1 }))).rejects.toThrow(TypeError);
        await expect(store.record(attemptInput({ attemptedAt: Number.NaN }))).rejects.toThrow(TypeError);
      });
    });

    describe("listByMessage", () => {
      it("returns an empty array for a message with no attempts", async () => {
        expect(await store.listByMessage("msg_unknown")).toEqual([]);
      });

      it("lists a message's attempts oldest-first, scoped to that message", async () => {
        // Two messages interleaved, as a busy worker would record them.
        const a1 = await store.record(
          attemptInput({ messageId: "m-a", attemptNumber: 1, attemptedAt: 100 }),
        );
        const b1 = await store.record(
          attemptInput({ messageId: "m-b", attemptNumber: 1, attemptedAt: 110 }),
        );
        const a2 = await store.record(
          attemptInput({
            messageId: "m-a",
            attemptNumber: 2,
            outcome: "failed",
            responseStatus: 500,
            error: "boom",
            attemptedAt: 200,
          }),
        );

        const aAttempts = await store.listByMessage("m-a");
        expect(aAttempts.map((a) => a.id)).toEqual([a1.id, a2.id]);
        expect(aAttempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
        expect(aAttempts.every((a) => a.messageId === "m-a")).toBe(true);

        // The other message's attempts are not mixed in.
        const bAttempts = await store.listByMessage("m-b");
        expect(bAttempts.map((a) => a.id)).toEqual([b1.id]);
      });

      it("preserves each recorded attempt verbatim", async () => {
        const input = attemptInput({
          messageId: "m-x",
          attemptNumber: 3,
          outcome: "failed",
          responseStatus: 429,
          error: "rate limited",
          durationMs: 87,
          attemptedAt: 1_700_000_123_456,
        });
        await store.record(input);
        const [listed] = await store.listByMessage("m-x");
        expect(listed).toEqual({ id: "datt_test_1", ...normalizeNewAttempt(input) });
      });
    });

    describe("summarizeAttemptsByApp", () => {
      const DAY_A = Date.UTC(2023, 10, 14); // 2023-11-14T00:00:00Z
      const DAY_B = Date.UTC(2023, 10, 15); // 2023-11-15T00:00:00Z
      const DAY_C = Date.UTC(2023, 10, 16); // 2023-11-16T00:00:00Z

      it("returns a zeroed summary for a tenant with no attempts in range", async () => {
        const summary = await store.summarizeAttemptsByApp("app_none", {
          fromMs: DAY_A,
          toMs: DAY_B,
        });
        expect(summary).toEqual({
          appId: "app_none",
          fromMs: DAY_A,
          toMs: DAY_B,
          total: 0,
          succeeded: 0,
          failed: 0,
          daily: [],
        });
      });

      it("counts a tenant's attempts per UTC day, split by outcome, oldest day first", async () => {
        // app_1: day A → 2 succeeded + 1 failed; day B → 1 failed.
        await store.record(attemptInput({ appId: "app_1", outcome: "succeeded", attemptedAt: DAY_A + 1 }));
        await store.record(attemptInput({ appId: "app_1", outcome: "succeeded", attemptedAt: DAY_A + 2 }));
        await store.record(
          attemptInput({ appId: "app_1", outcome: "failed", responseStatus: 500, error: "x", attemptedAt: DAY_A + 3 }),
        );
        await store.record(
          attemptInput({ appId: "app_1", outcome: "failed", responseStatus: 503, error: "y", attemptedAt: DAY_B + 1 }),
        );
        const summary = await store.summarizeAttemptsByApp("app_1", { fromMs: DAY_A, toMs: DAY_C });
        expect(summary.total).toBe(4);
        expect(summary.succeeded).toBe(2);
        expect(summary.failed).toBe(2);
        expect(summary.daily).toEqual([
          { date: "2023-11-14", attempts: 3, succeeded: 2, failed: 1 },
          { date: "2023-11-15", attempts: 1, succeeded: 0, failed: 1 },
        ]);
      });

      it("scopes to the tenant and never counts a null-tenant attempt", async () => {
        await store.record(attemptInput({ appId: "app_1", outcome: "succeeded", attemptedAt: DAY_A + 1 }));
        await store.record(attemptInput({ appId: "app_2", outcome: "succeeded", attemptedAt: DAY_A + 2 }));
        // A vanished-message attempt: belongs to no tenant.
        await store.record(
          attemptInput({ appId: null, outcome: "failed", responseStatus: null, error: "gone", attemptedAt: DAY_A + 3 }),
        );
        const range = { fromMs: DAY_A, toMs: DAY_B };
        expect((await store.summarizeAttemptsByApp("app_1", range)).total).toBe(1);
        expect((await store.summarizeAttemptsByApp("app_2", range)).total).toBe(1);
        // The null-tenant attempt is attributed to neither.
      });

      it("honours the half-open [from, to) range at the day boundary", async () => {
        await store.record(attemptInput({ appId: "app_1", attemptedAt: DAY_A })); // at fromMs → included
        await store.record(attemptInput({ appId: "app_1", attemptedAt: DAY_B })); // at toMs → excluded
        const summary = await store.summarizeAttemptsByApp("app_1", { fromMs: DAY_A, toMs: DAY_B });
        expect(summary.total).toBe(1);
        expect(summary.daily).toEqual([{ date: "2023-11-14", attempts: 1, succeeded: 1, failed: 0 }]);
      });

      it("rejects an inverted range", async () => {
        await expect(
          store.summarizeAttemptsByApp("app_1", { fromMs: DAY_B, toMs: DAY_A }),
        ).rejects.toThrow(RangeError);
      });
    });
  });
}
