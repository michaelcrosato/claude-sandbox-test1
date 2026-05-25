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
  MAX_CAPTURED_BODY_BYTES,
  normalizeNewAttempt,
  type DeliveryAttemptStore,
  type NewDeliveryAttempt,
} from "./delivery-attempt.js";
import {
  DELIVERY_FAILURE_REASONS,
  emptyDeliveryFailureCounts,
} from "../delivery/failure-reason.js";

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
        expect(attempt.failureReason).toBeNull();
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

      it("round-trips a failed attempt's structured failureReason", async () => {
        const attempt = await store.record(
          attemptInput({
            outcome: "failed",
            responseStatus: 503,
            error: "endpoint returned HTTP 503",
            failureReason: "http_5xx",
          }),
        );
        expect(attempt.failureReason).toBe("http_5xx");
        // It survives a read-back too (the durable path maps the column, not just `record`).
        const page = await store.listByMessage(attempt.messageId);
        expect(page.data[0]!.failureReason).toBe("http_5xx");
      });

      it("defaults failureReason to null and rejects an unknown reason or one on a success", async () => {
        // Omitted → null.
        expect((await store.record(attemptInput())).failureReason).toBeNull();
        // A non-member code is rejected.
        await expect(
          // @ts-expect-error — failureReason must be a known literal
          store.record(attemptInput({ outcome: "failed", responseStatus: 500, failureReason: "kaboom" })),
        ).rejects.toThrow(TypeError);
        // A 2xx attempt may not carry a failure cause.
        await expect(
          store.record(attemptInput({ outcome: "succeeded", failureReason: "http_5xx" })),
        ).rejects.toThrow(TypeError);
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

      it("stores requestBody and responseBody when provided", async () => {
        const attempt = await store.record(
          attemptInput({ requestBody: '{"event":"test"}', responseBody: "Service Unavailable" }),
        );
        expect(attempt.requestBody).toBe('{"event":"test"}');
        expect(attempt.responseBody).toBe("Service Unavailable");
      });

      it("defaults requestBody and responseBody to null when omitted", async () => {
        const attempt = await store.record(attemptInput());
        expect(attempt.requestBody).toBeNull();
        expect(attempt.responseBody).toBeNull();
      });

      it("stores bodies up to MAX_CAPTURED_BODY_BYTES without truncation", async () => {
        const body = "x".repeat(MAX_CAPTURED_BODY_BYTES);
        const attempt = await store.record(attemptInput({ requestBody: body, responseBody: body }));
        expect(attempt.requestBody).toHaveLength(MAX_CAPTURED_BODY_BYTES);
        expect(attempt.responseBody).toHaveLength(MAX_CAPTURED_BODY_BYTES);
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
      it("returns an empty page for a message with no attempts", async () => {
        const page = await store.listByMessage("msg_unknown");
        expect(page.data).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });

      it("lists attempts oldest-first, scoped to that message, nextCursor null when all fit", async () => {
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

        const aPage = await store.listByMessage("m-a");
        expect(aPage.data.map((a) => a.id)).toEqual([a1.id, a2.id]);
        expect(aPage.data.map((a) => a.attemptNumber)).toEqual([1, 2]);
        expect(aPage.data.every((a) => a.messageId === "m-a")).toBe(true);
        expect(aPage.nextCursor).toBeNull(); // all fit on one page

        // The other message's attempts are not mixed in.
        const bPage = await store.listByMessage("m-b");
        expect(bPage.data.map((a) => a.id)).toEqual([b1.id]);
        expect(bPage.nextCursor).toBeNull();
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
        const page = await store.listByMessage("m-x");
        expect(page.data[0]).toEqual({ id: "datt_test_1", ...normalizeNewAttempt(input) });
      });

      it("paginates forward through a message's attempts (limit=2)", async () => {
        // Record 3 attempts for the same message.
        await store.record(attemptInput({ messageId: "m-p", attemptNumber: 1, attemptedAt: 1_000 }));
        await store.record(attemptInput({ messageId: "m-p", attemptNumber: 2, attemptedAt: 2_000 }));
        await store.record(
          attemptInput({ messageId: "m-p", attemptNumber: 3, outcome: "failed", responseStatus: 503, error: "x", attemptedAt: 3_000 }),
        );

        const page1 = await store.listByMessage("m-p", { limit: 2 });
        expect(page1.data).toHaveLength(2);
        expect(page1.data[0]!.attemptNumber).toBe(1);
        expect(page1.data[1]!.attemptNumber).toBe(2);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await store.listByMessage("m-p", { limit: 2, cursor: page1.nextCursor });
        expect(page2.data).toHaveLength(1);
        expect(page2.data[0]!.attemptNumber).toBe(3);
        expect(page2.nextCursor).toBeNull();
      });

      it("covers all attempts when paginating through exactly (limit = 1)", async () => {
        const n = 4;
        for (let i = 1; i <= n; i++) {
          await store.record(attemptInput({ messageId: "m-q", attemptNumber: i, attemptedAt: i * 1_000 }));
        }

        const allAttempts: number[] = [];
        let cursor: string | null = null;
        for (;;) {
          const page = await store.listByMessage("m-q", { limit: 1, cursor });
          for (const a of page.data) allAttempts.push(a.attemptNumber);
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
        expect(allAttempts).toEqual([1, 2, 3, 4]);
      });

      it("handles a same-ms tiebreak by id ascending", async () => {
        // Two attempts at the same epoch-ms with different ids.
        const ts = 5_000;
        const a1 = await store.record(attemptInput({ messageId: "m-ts", attemptNumber: 1, attemptedAt: ts }));
        const a2 = await store.record(attemptInput({ messageId: "m-ts", attemptNumber: 2, attemptedAt: ts }));

        const page1 = await store.listByMessage("m-ts", { limit: 1 });
        expect(page1.data).toHaveLength(1);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await store.listByMessage("m-ts", { limit: 1, cursor: page1.nextCursor });
        expect(page2.data).toHaveLength(1);
        expect(page2.nextCursor).toBeNull();

        // Combined covers both; order is stable (the one with the smaller id comes first).
        const allIds = [page1.data[0]!.id, page2.data[0]!.id];
        expect(new Set(allIds)).toEqual(new Set([a1.id, a2.id]));
        expect(allIds[0]! < allIds[1]!).toBe(true); // id-ascending tiebreak
      });

      it("nextCursor is null on an exact-multiple last page", async () => {
        // 2 attempts, limit 2 → exactly one page, no next.
        await store.record(attemptInput({ messageId: "m-ex", attemptNumber: 1, attemptedAt: 1_000 }));
        await store.record(attemptInput({ messageId: "m-ex", attemptNumber: 2, attemptedAt: 2_000 }));
        const page = await store.listByMessage("m-ex", { limit: 2 });
        expect(page.data).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
      });

      it("rejects a limit of 0 with a RangeError", async () => {
        await expect(store.listByMessage("m-any", { limit: 0 })).rejects.toThrow(RangeError);
      });

      it("rejects a malformed cursor with a TypeError", async () => {
        await expect(
          store.listByMessage("m-any", { cursor: "not-valid-base64url!!" }),
        ).rejects.toThrow(TypeError);
      });
    });

    describe("listByTask", () => {
      it("returns an empty page for a task with no attempts", async () => {
        const page = await store.listByTask("dtask_unknown");
        expect(page.data).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });

      it("lists attempts oldest-first, scoped to that task, isolated from other tasks", async () => {
        // Two tasks interleaved — one message, two endpoints.
        const t1a1 = await store.record(
          attemptInput({ taskId: "dtask_A", messageId: "msg_1", attemptNumber: 1, attemptedAt: 100 }),
        );
        const t2a1 = await store.record(
          attemptInput({ taskId: "dtask_B", messageId: "msg_1", attemptNumber: 1, attemptedAt: 110 }),
        );
        const t1a2 = await store.record(
          attemptInput({
            taskId: "dtask_A",
            messageId: "msg_1",
            attemptNumber: 2,
            outcome: "failed",
            responseStatus: 500,
            error: "boom",
            attemptedAt: 200,
          }),
        );

        const pageA = await store.listByTask("dtask_A");
        expect(pageA.data.map((a) => a.id)).toEqual([t1a1.id, t1a2.id]);
        expect(pageA.data.every((a) => a.taskId === "dtask_A")).toBe(true);
        expect(pageA.nextCursor).toBeNull();

        const pageB = await store.listByTask("dtask_B");
        expect(pageB.data.map((a) => a.id)).toEqual([t2a1.id]);
        expect(pageB.nextCursor).toBeNull();
      });

      it("paginates forward through a task's attempts (limit=2)", async () => {
        for (let i = 1; i <= 3; i++) {
          await store.record(attemptInput({ taskId: "dtask_P", messageId: "msg_p", attemptNumber: i, attemptedAt: i * 1_000 }));
        }
        const page1 = await store.listByTask("dtask_P", { limit: 2 });
        expect(page1.data).toHaveLength(2);
        expect(page1.data[0]!.attemptNumber).toBe(1);
        expect(page1.data[1]!.attemptNumber).toBe(2);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await store.listByTask("dtask_P", { limit: 2, cursor: page1.nextCursor });
        expect(page2.data).toHaveLength(1);
        expect(page2.data[0]!.attemptNumber).toBe(3);
        expect(page2.nextCursor).toBeNull();
      });

      it("nextCursor is null when all attempts fit on one page", async () => {
        await store.record(attemptInput({ taskId: "dtask_Q", messageId: "msg_q", attemptNumber: 1, attemptedAt: 1_000 }));
        await store.record(attemptInput({ taskId: "dtask_Q", messageId: "msg_q", attemptNumber: 2, attemptedAt: 2_000 }));
        const page = await store.listByTask("dtask_Q", { limit: 5 });
        expect(page.data).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
      });

      it("rejects a limit of 0 with a RangeError", async () => {
        await expect(store.listByTask("dtask_any", { limit: 0 })).rejects.toThrow(RangeError);
      });

      it("rejects a malformed cursor with a TypeError", async () => {
        await expect(
          store.listByTask("dtask_any", { cursor: "not-valid-base64url!!" }),
        ).rejects.toThrow(TypeError);
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

    describe("statsByEndpoint", () => {
      const DAY_A = Date.UTC(2024, 2, 10); // 2024-03-10T00:00:00Z
      const DAY_B = Date.UTC(2024, 2, 11); // 2024-03-11T00:00:00Z
      const DAY_C = Date.UTC(2024, 2, 12); // 2024-03-12T00:00:00Z

      it("returns zeros and null rates when no attempts exist for the endpoint in range", async () => {
        const stats = await store.statsByEndpoint("ep_none", { fromMs: DAY_A, toMs: DAY_C });
        expect(stats).toEqual({
          endpointId: "ep_none",
          fromMs: DAY_A,
          toMs: DAY_C,
          total: 0,
          succeeded: 0,
          failed: 0,
          successRate: null,
          avgDurationMs: null,
          daily: [],
          failureReasons: emptyDeliveryFailureCounts(),
        });
      });

      it("counts attempts per day, computes successRate and avgDurationMs, oldest-day-first", async () => {
        // ep_1: day A → 2 succeeded (dur 100ms each) + 1 failed (dur 50ms)
        //        day B → 1 failed (dur 200ms)
        await store.record(attemptInput({ endpointId: "ep_1", outcome: "succeeded", durationMs: 100, attemptedAt: DAY_A + 1 }));
        await store.record(attemptInput({ endpointId: "ep_1", outcome: "succeeded", durationMs: 100, attemptedAt: DAY_A + 2 }));
        await store.record(
          attemptInput({ endpointId: "ep_1", outcome: "failed", responseStatus: 500, error: "x", durationMs: 50, attemptedAt: DAY_A + 3 }),
        );
        await store.record(
          attemptInput({ endpointId: "ep_1", outcome: "failed", responseStatus: 503, error: "y", durationMs: 200, attemptedAt: DAY_B + 1 }),
        );
        const stats = await store.statsByEndpoint("ep_1", { fromMs: DAY_A, toMs: DAY_C });
        expect(stats.total).toBe(4);
        expect(stats.succeeded).toBe(2);
        expect(stats.failed).toBe(2);
        expect(stats.successRate).toBe(0.5);
        // (100 + 100 + 50 + 200) / 4 = 112.5 → rounds to 113
        expect(stats.avgDurationMs).toBe(113);
        expect(stats.daily).toEqual([
          { date: "2024-03-10", attempts: 3, succeeded: 2, failed: 1 },
          { date: "2024-03-11", attempts: 1, succeeded: 0, failed: 1 },
        ]);
      });

      it("scopes to the endpoint — another endpoint's attempts are never counted", async () => {
        await store.record(attemptInput({ endpointId: "ep_A", outcome: "succeeded", attemptedAt: DAY_A + 1 }));
        await store.record(attemptInput({ endpointId: "ep_B", outcome: "failed", responseStatus: 500, error: "x", attemptedAt: DAY_A + 2 }));
        const range = { fromMs: DAY_A, toMs: DAY_B };
        const statsA = await store.statsByEndpoint("ep_A", range);
        expect(statsA.total).toBe(1);
        expect(statsA.succeeded).toBe(1);
        expect(statsA.successRate).toBe(1);
        const statsB = await store.statsByEndpoint("ep_B", range);
        expect(statsB.total).toBe(1);
        expect(statsB.succeeded).toBe(0);
        expect(statsB.successRate).toBe(0);
      });

      it("breaks the failures down by reason — every reason key present, classified reasons sum to the classified failures", async () => {
        // 2× http_5xx, 1× connection_refused (a transport failure, no response), a
        // succeeded attempt (no reason), and a legacy failed attempt with a null reason.
        await store.record(attemptInput({ endpointId: "ep_r", outcome: "failed", responseStatus: 500, error: "e", failureReason: "http_5xx", attemptedAt: DAY_A + 1 }));
        await store.record(attemptInput({ endpointId: "ep_r", outcome: "failed", responseStatus: 503, error: "e", failureReason: "http_5xx", attemptedAt: DAY_A + 2 }));
        await store.record(attemptInput({ endpointId: "ep_r", outcome: "failed", responseStatus: null, error: "e", failureReason: "connection_refused", attemptedAt: DAY_A + 3 }));
        await store.record(attemptInput({ endpointId: "ep_r", outcome: "succeeded", responseStatus: 200, attemptedAt: DAY_A + 4 }));
        await store.record(attemptInput({ endpointId: "ep_r", outcome: "failed", responseStatus: 500, error: "legacy", failureReason: null, attemptedAt: DAY_A + 5 }));

        const stats = await store.statsByEndpoint("ep_r", { fromMs: DAY_A, toMs: DAY_C });
        // All four failures (the legacy null-reason one included) are in `failed`.
        expect(stats.failed).toBe(4);
        expect(stats.failureReasons.http_5xx).toBe(2);
        expect(stats.failureReasons.connection_refused).toBe(1);
        // Closed domain: every reason key is present, zeros included (metric convention).
        expect(Object.keys(stats.failureReasons).sort()).toEqual([...DELIVERY_FAILURE_REASONS].sort());
        expect(stats.failureReasons.dns_failure).toBe(0);
        // The succeeded attempt never folds into any reason bucket; the legacy
        // null-reason failure has no cause to attribute, so the classified reasons
        // sum to `failed` minus that one unclassified attempt.
        const reasonSum = Object.values(stats.failureReasons).reduce((a, b) => a + b, 0);
        expect(reasonSum).toBe(3);
        expect(reasonSum).toBe(stats.failed - 1);
      });
    });

    describe("pruneOldAttempts", () => {
      it("deletes attempts older than the cutoff, returns deleted count", async () => {
        await store.record(attemptInput({ messageId: "msg_1", attemptedAt: 1_000 }));
        await store.record(attemptInput({ messageId: "msg_1", attemptedAt: 2_000 }));
        const recent = await store.record(attemptInput({ messageId: "msg_1", attemptedAt: 5_000 }));

        const deleted = await store.pruneOldAttempts(4_000);
        expect(deleted).toBe(2);

        const page = await store.listByMessage("msg_1");
        expect(page.data.map((a) => a.id)).toEqual([recent.id]);
      });

      it("honours the strict < boundary: an attempt exactly at the cutoff is kept", async () => {
        const boundary = await store.record(attemptInput({ messageId: "msg_1", attemptedAt: 3_000 }));
        expect(await store.pruneOldAttempts(3_000)).toBe(0);
        const page = await store.listByMessage("msg_1");
        expect(page.data.map((a) => a.id)).toEqual([boundary.id]);
      });

      it("returns 0 when there is nothing to prune", async () => {
        expect(await store.pruneOldAttempts(1_700_000_000_000)).toBe(0);
      });
    });
  });
}
