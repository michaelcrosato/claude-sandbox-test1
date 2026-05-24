/**
 * The shared behavioural contract for any {@link DeliveryQueue} backend.
 *
 * Every backend (in-memory, SQLite, and any future Postgres backend) runs this
 * one suite, so "the durable queue behaves exactly like the reference" is a fact
 * the test run proves rather than a comment we hope holds. Backends supply a
 * factory; the suite drives it with an injected deterministic clock, id
 * generator, and lease-token generator so timing, ids, and tokens are
 * reproducible across engines.
 *
 * Not a `*.test.ts` file, so Vitest does not collect it directly — each backend
 * imports {@link describeDeliveryQueueContract} and calls it from its own test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeDeliveryCursor,
  StaleLeaseError,
  UnknownDeliveryTaskError,
  type DeliveryQueue,
  type ListByAppOptions,
} from "./delivery-queue.js";
import { DeliveryStateError } from "../delivery/delivery-state.js";
import {
  fixedSchedule,
  type JitterOptions,
  type RetryPolicy,
} from "../delivery/retry-policy.js";

/** Controllable clock + deterministic id/lease-token generators. */
export interface QueueConformanceClock {
  advance(ms: number): void;
  now: () => number;
  generateId: () => string;
  generateLeaseToken: () => string;
}

/**
 * Build a fresh clock starting at `startMs` with sequential `dtask_test_N` ids
 * and `lease_test_N` lease tokens.
 */
export function makeQueueConformanceClock(
  startMs = 1_700_000_000_000,
): QueueConformanceClock {
  let nowMs = startMs;
  let idSeq = 0;
  let leaseSeq = 0;
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    generateId: () => `dtask_test_${++idSeq}`,
    generateLeaseToken: () => `lease_test_${++leaseSeq}`,
  };
}

/** The options every backend factory must honour for conformance. */
export interface ConformanceQueueOptions {
  now: () => number;
  generateId: () => string;
  generateLeaseToken: () => string;
  retryPolicy?: RetryPolicy;
  visibilityTimeoutMs?: number;
  jitter?: JitterOptions;
}

/** Constructs a backend under test from injected determinism options. */
export type DeliveryQueueFactory = (
  options: ConformanceQueueOptions,
) => DeliveryQueue;

/** A short, predictable schedule for the suite: 2 retries → 3 attempts max. */
const CONFORMANCE_POLICY: RetryPolicy = fixedSchedule([1_000, 2_000]);
/** A short visibility timeout so lease-expiry can be exercised deterministically. */
const CONFORMANCE_VISIBILITY_MS = 5_000;

/**
 * Register the full {@link DeliveryQueue} contract against one backend.
 *
 * @param label    Human-readable backend name, used in the describe block.
 * @param makeQueue Factory that builds a fresh queue from the given options.
 */
export function describeDeliveryQueueContract(
  label: string,
  makeQueue: DeliveryQueueFactory,
): void {
  describe(`${label} — DeliveryQueue contract`, () => {
    let clock: QueueConformanceClock;
    /** Queues built during a test; closed afterwards if they expose close(). */
    const created: DeliveryQueue[] = [];

    /** Build a queue (with the suite defaults) and register it for teardown. */
    function make(options?: Partial<ConformanceQueueOptions>): DeliveryQueue {
      const queue = makeQueue({
        now: clock.now,
        generateId: clock.generateId,
        generateLeaseToken: clock.generateLeaseToken,
        retryPolicy: CONFORMANCE_POLICY,
        visibilityTimeoutMs: CONFORMANCE_VISIBILITY_MS,
        ...options,
      });
      created.push(queue);
      return queue;
    }

    let queue: DeliveryQueue;
    beforeEach(() => {
      clock = makeQueueConformanceClock();
      queue = make();
    });

    afterEach(() => {
      for (const q of created) {
        const close = (q as { close?: () => void }).close;
        if (typeof close === "function") close.call(q);
      }
      created.length = 0;
    });

    describe("enqueue", () => {
      it("creates a pending task, claimable immediately, with assigned id+times", async () => {
        const task = await queue.enqueue({ messageId: "msg-1" });
        expect(task.id).toBe("dtask_test_1");
        expect(task.messageId).toBe("msg-1");
        expect(task.endpointId).toBeNull(); // unspecified by default
        expect(task.status).toBe("pending");
        expect(task.attempts).toBe(0);
        expect(task.nextAttemptAt).toBeNull();
        expect(task.leaseExpiresAt).toBeNull();
        expect(task.leaseToken).toBeNull();
        expect(task.lastError).toBeNull();
        expect(task.createdAt).toBe(clock.now());
        expect(task.updatedAt).toBe(clock.now());
        expect(await queue.get(task.id)).toEqual(task);
      });

      it("returns null from get for an unknown id", async () => {
        expect(await queue.get("dtask_nope")).toBeNull();
      });

      it("honours availableAt: not claimable until it arrives", async () => {
        const at = clock.now() + 1_000;
        const task = await queue.enqueue({ messageId: "m", availableAt: at });
        expect(task.nextAttemptAt).toBe(at);
        expect(await queue.claimDue({ nowMs: clock.now() })).toEqual([]);

        clock.advance(1_000);
        const claimed = await queue.claimDue({ nowMs: clock.now() });
        expect(claimed.map((t) => t.id)).toEqual([task.id]);
      });

      it("rejects a non-string / empty messageId", async () => {
        await expect(queue.enqueue({ messageId: "" })).rejects.toThrow(TypeError);
        await expect(
          // @ts-expect-error — messageId must be a string
          queue.enqueue({ messageId: 123 }),
        ).rejects.toThrow(TypeError);
      });

      it("carries an endpointId opaquely through enqueue, get, and claim", async () => {
        const enq = await queue.enqueue({
          messageId: "m",
          endpointId: "ep_1",
        });
        expect(enq.endpointId).toBe("ep_1");
        expect((await queue.get(enq.id))?.endpointId).toBe("ep_1");
        // The reference persists through a state transition (claim) unchanged.
        const [claimed] = await queue.claimDue({ nowMs: clock.now() });
        expect(claimed!.endpointId).toBe("ep_1");
      });

      it("rejects an empty endpointId", async () => {
        await expect(
          queue.enqueue({ messageId: "m", endpointId: "" }),
        ).rejects.toThrow(TypeError);
      });

      it("stores priority, defaulting to 0 when omitted", async () => {
        const normal = await queue.enqueue({ messageId: "m" });
        expect(normal.priority).toBe(0);
        const high = await queue.enqueue({ messageId: "h", priority: 1 });
        expect(high.priority).toBe(1);
        const low = await queue.enqueue({ messageId: "l", priority: -1 });
        expect(low.priority).toBe(-1);
        // Persisted value survives a round-trip through get().
        expect((await queue.get(high.id))?.priority).toBe(1);
        expect((await queue.get(low.id))?.priority).toBe(-1);
      });

      it("rejects an out-of-range priority", async () => {
        await expect(queue.enqueue({ messageId: "m", priority: 2 })).rejects.toThrow(RangeError);
        await expect(queue.enqueue({ messageId: "m", priority: -2 })).rejects.toThrow(RangeError);
      });
    });

    describe("claimDue", () => {
      it("leases a due task: delivering, attempt counted, lease + token set", async () => {
        const enq = await queue.enqueue({ messageId: "m" });
        const claimed = await queue.claimDue({ nowMs: clock.now() });
        expect(claimed).toHaveLength(1);
        const task = claimed[0]!;
        expect(task.id).toBe(enq.id);
        expect(task.status).toBe("delivering");
        expect(task.attempts).toBe(1);
        expect(task.nextAttemptAt).toBeNull();
        expect(task.leaseExpiresAt).toBe(clock.now() + CONFORMANCE_VISIBILITY_MS);
        expect(task.leaseToken).toBe("lease_test_1");
        expect(task.updatedAt).toBe(clock.now());
        // The persisted task reflects the lease.
        expect(await queue.get(task.id)).toEqual(task);
      });

      it("returns an empty batch when nothing is due", async () => {
        expect(await queue.claimDue({ nowMs: clock.now() })).toEqual([]);
      });

      it("claims oldest-first (enqueue order) when priorities are equal", async () => {
        const a = await queue.enqueue({ messageId: "a" });
        const b = await queue.enqueue({ messageId: "b" });
        const c = await queue.enqueue({ messageId: "c" });
        const claimed = await queue.claimDue({ nowMs: clock.now(), limit: 10 });
        expect(claimed.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
      });

      it("claims higher-priority tasks before lower-priority ones when due simultaneously", async () => {
        const low = await queue.enqueue({ messageId: "low", priority: -1 });
        const normal = await queue.enqueue({ messageId: "normal", priority: 0 });
        const high = await queue.enqueue({ messageId: "high", priority: 1 });
        const claimed = await queue.claimDue({ nowMs: clock.now(), limit: 3 });
        expect(claimed.map((t) => t.id)).toEqual([high.id, normal.id, low.id]);
        // Priority is preserved through the claim transition.
        expect(claimed.map((t) => t.priority)).toEqual([1, 0, -1]);
      });

      it("respects the batch limit and never re-leases a live claim", async () => {
        const a = await queue.enqueue({ messageId: "a" });
        const b = await queue.enqueue({ messageId: "b" });
        const c = await queue.enqueue({ messageId: "c" });

        const first = await queue.claimDue({ nowMs: clock.now(), limit: 2 });
        expect(first.map((t) => t.id)).toEqual([a.id, b.id]);

        // a and b are leased (lease still live), so only c is claimable now.
        const second = await queue.claimDue({ nowMs: clock.now(), limit: 2 });
        expect(second.map((t) => t.id)).toEqual([c.id]);

        // Everything is in flight; nothing left to claim.
        expect(await queue.claimDue({ nowMs: clock.now(), limit: 2 })).toEqual([]);
      });

      it("rejects a non-positive / non-integer limit and a non-finite now", async () => {
        await expect(
          queue.claimDue({ nowMs: clock.now(), limit: 0 }),
        ).rejects.toThrow(RangeError);
        await expect(
          queue.claimDue({ nowMs: clock.now(), limit: 1.5 }),
        ).rejects.toThrow(RangeError);
        await expect(
          queue.claimDue({ nowMs: Number.NaN }),
        ).rejects.toThrow(TypeError);
      });
    });

    describe("complete", () => {
      it("marks a leased task succeeded (terminal) and releases the lease", async () => {
        await queue.enqueue({ messageId: "m" });
        const [task] = await queue.claimDue({ nowMs: clock.now() });
        const done = await queue.complete(task!.id, task!.leaseToken!);
        expect(done.status).toBe("succeeded");
        expect(done.attempts).toBe(1);
        expect(done.leaseExpiresAt).toBeNull();
        expect(done.leaseToken).toBeNull();
        // Terminal: no longer claimable.
        expect(await queue.claimDue({ nowMs: clock.now() })).toEqual([]);
        expect(await queue.get(task!.id)).toEqual(done);
      });

      it("throws UnknownDeliveryTaskError for an unknown id", async () => {
        await expect(queue.complete("dtask_nope", "tok")).rejects.toBeInstanceOf(
          UnknownDeliveryTaskError,
        );
      });

      it("throws StaleLeaseError for a wrong token", async () => {
        await queue.enqueue({ messageId: "m" });
        const [task] = await queue.claimDue({ nowMs: clock.now() });
        await expect(
          queue.complete(task!.id, "not-the-token"),
        ).rejects.toBeInstanceOf(StaleLeaseError);
      });

      it("throws StaleLeaseError when the task is not currently leased", async () => {
        const task = await queue.enqueue({ messageId: "m" }); // pending, no lease
        await expect(
          queue.complete(task.id, "any"),
        ).rejects.toBeInstanceOf(StaleLeaseError);
      });
    });

    describe("fail", () => {
      it("reschedules within budget per the retry policy", async () => {
        await queue.enqueue({ messageId: "m" });
        const [task] = await queue.claimDue({ nowMs: clock.now() });
        const failed = await queue.fail(task!.id, task!.leaseToken!, {
          error: "boom",
          nowMs: clock.now(),
        });
        expect(failed.status).toBe("pending");
        expect(failed.attempts).toBe(1);
        expect(failed.lastError).toBe("boom");
        expect(failed.leaseToken).toBeNull();
        expect(failed.nextAttemptAt).toBe(clock.now() + 1_000); // first delay

        // Not due yet at the same instant…
        expect(await queue.claimDue({ nowMs: clock.now() })).toEqual([]);
        // …but claimable once the backoff elapses, as a fresh attempt.
        clock.advance(1_000);
        const reclaimed = await queue.claimDue({ nowMs: clock.now() });
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0]!.attempts).toBe(2);
        expect(reclaimed[0]!.status).toBe("delivering");
      });

      it("dead-letters once the retry budget is exhausted", async () => {
        await queue.enqueue({ messageId: "m" });

        // Attempt 1 fails → backoff 1s.
        let [t] = await queue.claimDue({ nowMs: clock.now() });
        await queue.fail(t!.id, t!.leaseToken!, { error: "e1", nowMs: clock.now() });

        // Attempt 2 fails → backoff 2s.
        clock.advance(1_000);
        [t] = await queue.claimDue({ nowMs: clock.now() });
        expect(t!.attempts).toBe(2);
        await queue.fail(t!.id, t!.leaseToken!, { error: "e2", nowMs: clock.now() });

        // Attempt 3 fails → schedule exhausted → dead_letter (terminal).
        clock.advance(2_000);
        [t] = await queue.claimDue({ nowMs: clock.now() });
        expect(t!.attempts).toBe(3);
        const dead = await queue.fail(t!.id, t!.leaseToken!, {
          error: "e3",
          nowMs: clock.now(),
        });
        expect(dead.status).toBe("dead_letter");
        expect(dead.lastError).toBe("e3");
        expect(dead.nextAttemptAt).toBeNull();
        expect(await queue.claimDue({ nowMs: clock.now() })).toEqual([]);
      });

      it("throws UnknownDeliveryTaskError / StaleLeaseError like complete", async () => {
        await expect(
          queue.fail("dtask_nope", "tok", { error: "e", nowMs: clock.now() }),
        ).rejects.toBeInstanceOf(UnknownDeliveryTaskError);

        await queue.enqueue({ messageId: "m" });
        const [task] = await queue.claimDue({ nowMs: clock.now() });
        await expect(
          queue.fail(task!.id, "wrong", { error: "e", nowMs: clock.now() }),
        ).rejects.toBeInstanceOf(StaleLeaseError);
      });

      describe("minDelayMs floor (Retry-After support)", () => {
        it("clamps nextAttemptAt when minDelayMs exceeds the policy delay", async () => {
          await queue.enqueue({ messageId: "m" });
          const [task] = await queue.claimDue({ nowMs: clock.now() });
          // Policy first delay is 1_000ms; minDelayMs is 5_000ms → floor wins.
          const failed = await queue.fail(task!.id, task!.leaseToken!, {
            error: "503",
            nowMs: clock.now(),
            minDelayMs: 5_000,
          });
          expect(failed.status).toBe("pending");
          expect(failed.nextAttemptAt).toBe(clock.now() + 5_000);
          // Not claimable at policy time, but claimable once minDelay elapses.
          clock.advance(1_000);
          expect(await queue.claimDue({ nowMs: clock.now() })).toHaveLength(0);
          clock.advance(4_000);
          expect(await queue.claimDue({ nowMs: clock.now() })).toHaveLength(1);
        });

        it("uses the policy delay when minDelayMs is smaller", async () => {
          await queue.enqueue({ messageId: "m" });
          const [task] = await queue.claimDue({ nowMs: clock.now() });
          // Policy first delay is 1_000ms; minDelayMs is 200ms → policy wins.
          const failed = await queue.fail(task!.id, task!.leaseToken!, {
            error: "429",
            nowMs: clock.now(),
            minDelayMs: 200,
          });
          expect(failed.status).toBe("pending");
          expect(failed.nextAttemptAt).toBe(clock.now() + 1_000);
        });

        it("has no effect when the task dead-letters (budget exhausted)", async () => {
          await queue.enqueue({ messageId: "m" });
          // Two retries allowed by CONFORMANCE_POLICY → exhaust both first.
          let [t] = await queue.claimDue({ nowMs: clock.now() });
          await queue.fail(t!.id, t!.leaseToken!, { error: "e", nowMs: clock.now() });
          clock.advance(1_000);
          [t] = await queue.claimDue({ nowMs: clock.now() });
          await queue.fail(t!.id, t!.leaseToken!, { error: "e", nowMs: clock.now() });
          clock.advance(2_000);
          [t] = await queue.claimDue({ nowMs: clock.now() });
          // Last attempt: budget spent → dead_letter regardless of minDelayMs.
          const dead = await queue.fail(t!.id, t!.leaseToken!, {
            error: "e",
            nowMs: clock.now(),
            minDelayMs: 60_000,
          });
          expect(dead.status).toBe("dead_letter");
          expect(dead.nextAttemptAt).toBeNull();
        });
      });
    });

    describe("per-task retryPolicy override in fail()", () => {
      it("uses the per-task policy when provided (overrides global)", async () => {
        const queue = make();
        await queue.enqueue({ messageId: "m" });
        const [task] = await queue.claimDue({ nowMs: clock.now() });
        // Override with a 3-delay schedule (4 total attempts); global is 2-delay.
        const custom = fixedSchedule([500, 1_500, 3_000]);
        const failed = await queue.fail(task!.id, task!.leaseToken!, {
          error: "err",
          nowMs: clock.now(),
          retryPolicy: custom,
        });
        expect(failed.status).toBe("pending");
        // Custom first delay is 500ms; global is 1_000ms — confirms custom won.
        expect(failed.nextAttemptAt).toBe(clock.now() + 500);
      });

      it("falls back to global policy when retryPolicy is absent in fail()", async () => {
        const queue = make();
        await queue.enqueue({ messageId: "m" });
        const [task] = await queue.claimDue({ nowMs: clock.now() });
        const failed = await queue.fail(task!.id, task!.leaseToken!, {
          error: "err",
          nowMs: clock.now(),
          // no retryPolicy — global CONFORMANCE_POLICY applies
        });
        expect(failed.status).toBe("pending");
        // CONFORMANCE_POLICY first delay is 1_000ms.
        expect(failed.nextAttemptAt).toBe(clock.now() + 1_000);
      });

      it("per-task policy controls dead-lettering (exhausts its own budget)", async () => {
        const queue = make();
        await queue.enqueue({ messageId: "m" });
        // Single-delay custom policy = 2 total attempts (1 retry).
        const singleRetry = fixedSchedule([1_000]);
        let [t] = await queue.claimDue({ nowMs: clock.now() });
        await queue.fail(t!.id, t!.leaseToken!, {
          error: "e",
          nowMs: clock.now(),
          retryPolicy: singleRetry,
        });
        clock.advance(1_000);
        [t] = await queue.claimDue({ nowMs: clock.now() });
        // Second (final) attempt under the custom policy → dead_letter.
        const dead = await queue.fail(t!.id, t!.leaseToken!, {
          error: "e",
          nowMs: clock.now(),
          retryPolicy: singleRetry,
        });
        expect(dead.status).toBe("dead_letter");
        // Global policy would allow one more retry; confirms custom budget was used.
      });
    });

    describe("retry (manual recovery)", () => {
      /** Enqueue a task and drive it to dead_letter (3 failed attempts). */
      async function deadLetter(messageId = "m"): Promise<string> {
        const enq = await queue.enqueue({ messageId, endpointId: "ep_1" });
        for (const delay of [0, 1_000, 2_000]) {
          clock.advance(delay);
          const [t] = await queue.claimDue({ nowMs: clock.now() });
          await queue.fail(t!.id, t!.leaseToken!, {
            error: "down",
            nowMs: clock.now(),
          });
        }
        expect((await queue.get(enq.id))?.status).toBe("dead_letter");
        return enq.id;
      }

      it("revives a dead-lettered task: fresh, immediately claimable, budget reset", async () => {
        const id = await deadLetter();

        const revived = await queue.retry(id);
        expect(revived.id).toBe(id);
        expect(revived.status).toBe("pending");
        expect(revived.attempts).toBe(0); // budget reset
        expect(revived.nextAttemptAt).toBeNull(); // deliverable now
        expect(revived.lastError).toBeNull(); // clean slate
        expect(revived.leaseToken).toBeNull();
        expect(revived.endpointId).toBe("ep_1"); // opaque reference preserved
        expect(revived.updatedAt).toBe(clock.now());
        expect(await queue.get(id)).toEqual(revived);

        // It is claimable again, as a fresh first attempt.
        const [claimed] = await queue.claimDue({ nowMs: clock.now() });
        expect(claimed!.id).toBe(id);
        expect(claimed!.attempts).toBe(1);
        expect(claimed!.status).toBe("delivering");
      });

      it("revives a succeeded task too (a resend)", async () => {
        await queue.enqueue({ messageId: "m" });
        const [task] = await queue.claimDue({ nowMs: clock.now() });
        const done = await queue.complete(task!.id, task!.leaseToken!);
        expect(done.status).toBe("succeeded");

        const revived = await queue.retry(done.id);
        expect(revived.status).toBe("pending");
        expect(revived.attempts).toBe(0);
        expect(await queue.claimDue({ nowMs: clock.now() })).toHaveLength(1);
      });

      it("throws UnknownDeliveryTaskError for an unknown id", async () => {
        await expect(queue.retry("dtask_nope")).rejects.toBeInstanceOf(
          UnknownDeliveryTaskError,
        );
      });

      it("rejects retrying a non-terminal (pending / delivering) task", async () => {
        const pending = await queue.enqueue({ messageId: "m" });
        await expect(queue.retry(pending.id)).rejects.toBeInstanceOf(
          DeliveryStateError,
        );

        const [delivering] = await queue.claimDue({ nowMs: clock.now() });
        await expect(queue.retry(delivering!.id)).rejects.toBeInstanceOf(
          DeliveryStateError,
        );
        // The rejected retry left the task untouched (still leased + delivering).
        const after = await queue.get(delivering!.id);
        expect(after?.status).toBe("delivering");
        expect(after?.leaseToken).toBe(delivering!.leaseToken);
      });
    });

    describe("cancel (operator abort)", () => {
      it("cancels a pending task: terminal, no lease, not claimable", async () => {
        const enq = await queue.enqueue({ messageId: "m" });

        const cancelled = await queue.cancel(enq.id);
        expect(cancelled.id).toBe(enq.id);
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.leaseToken).toBeNull();
        expect(cancelled.leaseExpiresAt).toBeNull();
        expect(cancelled.nextAttemptAt).toBeNull();
        expect(cancelled.attempts).toBe(0);
        expect(cancelled.updatedAt).toBe(clock.now());
        expect(await queue.get(enq.id)).toEqual(cancelled);

        // A cancelled task is terminal — the worker must not claim it.
        const claimed = await queue.claimDue({ nowMs: clock.now() });
        expect(claimed).toHaveLength(0);
      });

      it("cancelled task can be revived via retry (resend)", async () => {
        const enq = await queue.enqueue({ messageId: "m" });
        await queue.cancel(enq.id);

        const revived = await queue.retry(enq.id);
        expect(revived.status).toBe("pending");
        expect(revived.attempts).toBe(0);

        const [claimed] = await queue.claimDue({ nowMs: clock.now() });
        expect(claimed?.id).toBe(enq.id);
      });

      it("throws UnknownDeliveryTaskError for an unknown id", async () => {
        await expect(queue.cancel("dtask_nope")).rejects.toBeInstanceOf(
          UnknownDeliveryTaskError,
        );
      });

      it("rejects cancelling a non-pending task", async () => {
        // delivering — in-flight, cannot abort.
        await queue.enqueue({ messageId: "m" });
        const [delivering] = await queue.claimDue({ nowMs: clock.now() });
        await expect(queue.cancel(delivering!.id)).rejects.toBeInstanceOf(
          DeliveryStateError,
        );
        // Task is still delivering (untouched).
        expect((await queue.get(delivering!.id))?.status).toBe("delivering");

        // succeeded — already terminal, nothing to cancel.
        await queue.complete(delivering!.id, delivering!.leaseToken!);
        await expect(queue.cancel(delivering!.id)).rejects.toBeInstanceOf(
          DeliveryStateError,
        );
      });
    });

    describe("lease expiry (crash / stall recovery)", () => {
      it("reclaims a lapsed lease with a fresh token and invalidates the old one", async () => {
        await queue.enqueue({ messageId: "m" });
        const [first] = await queue.claimDue({ nowMs: clock.now() });
        const firstToken = first!.leaseToken!;

        // Worker "crashes": let the lease lapse, then a healthy worker reclaims.
        clock.advance(CONFORMANCE_VISIBILITY_MS);
        const [second] = await queue.claimDue({ nowMs: clock.now() });
        expect(second!.id).toBe(first!.id);
        expect(second!.attempts).toBe(2); // the dead attempt counted
        expect(second!.status).toBe("delivering");
        expect(second!.leaseToken).not.toBe(firstToken);

        // The crashed worker's stale token can no longer resolve the task.
        await expect(
          queue.complete(first!.id, firstToken),
        ).rejects.toBeInstanceOf(StaleLeaseError);
        // The new holder can.
        const done = await queue.complete(second!.id, second!.leaseToken!);
        expect(done.status).toBe("succeeded");
      });

      it("does not reclaim while the lease is still live", async () => {
        await queue.enqueue({ messageId: "m" });
        await queue.claimDue({ nowMs: clock.now() });
        clock.advance(CONFORMANCE_VISIBILITY_MS - 1);
        expect(await queue.claimDue({ nowMs: clock.now() })).toEqual([]);
      });
    });

    describe("listByMessage", () => {
      it("returns an empty array for a message with no tasks", async () => {
        expect(await queue.listByMessage("msg-unknown")).toEqual([]);
      });

      it("lists a message's tasks oldest-first, scoped to that message", async () => {
        // Two messages interleaved; fan-out enqueues one task per endpoint.
        const a1 = await queue.enqueue({ messageId: "m-a", endpointId: "ep_1" });
        const b1 = await queue.enqueue({ messageId: "m-b", endpointId: "ep_1" });
        const a2 = await queue.enqueue({ messageId: "m-a", endpointId: "ep_2" });

        const aTasks = await queue.listByMessage("m-a");
        expect(aTasks.map((t) => t.id)).toEqual([a1.id, a2.id]);
        expect(aTasks.every((t) => t.messageId === "m-a")).toBe(true);
        expect(aTasks.map((t) => t.endpointId)).toEqual(["ep_1", "ep_2"]);

        // The other message's tasks are not mixed in.
        const bTasks = await queue.listByMessage("m-b");
        expect(bTasks.map((t) => t.id)).toEqual([b1.id]);
      });

      it("reflects a task's current state after a transition", async () => {
        await queue.enqueue({ messageId: "m" });
        const [claimed] = await queue.claimDue({ nowMs: clock.now() });
        const done = await queue.complete(claimed!.id, claimed!.leaseToken!);

        const listed = await queue.listByMessage("m");
        expect(listed).toHaveLength(1);
        expect(listed[0]).toEqual(done);
        expect(listed[0]!.status).toBe("succeeded");
      });
    });

    describe("listByEndpoint", () => {
      it("returns empty page for an endpoint with no tasks", async () => {
        await queue.enqueue({ messageId: "m-other", endpointId: "ep_other" });
        const page = await queue.listByEndpoint("ep_unknown");
        expect(page.deliveries).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });

      it("returns tasks newest-first, scoped to the endpoint", async () => {
        // Three tasks: two for ep_1 (interleaved with ep_2), one for ep_2.
        const t1 = await queue.enqueue({ messageId: "m-a", endpointId: "ep_1" });
        clock.advance(1_000);
        await queue.enqueue({ messageId: "m-b", endpointId: "ep_2" });
        clock.advance(1_000);
        const t3 = await queue.enqueue({ messageId: "m-c", endpointId: "ep_1" });

        const page = await queue.listByEndpoint("ep_1");
        expect(page.deliveries.map((t) => t.id)).toEqual([t3.id, t1.id]); // newest-first
        expect(page.deliveries.every((t) => t.endpointId === "ep_1")).toBe(true);
        expect(page.nextCursor).toBeNull();
      });

      it("reflects a task's current state after a transition", async () => {
        await queue.enqueue({ messageId: "m", endpointId: "ep_1" });
        const [claimed] = await queue.claimDue({ nowMs: clock.now() });
        const done = await queue.complete(claimed!.id, claimed!.leaseToken!);

        const page = await queue.listByEndpoint("ep_1");
        expect(page.deliveries).toHaveLength(1);
        expect(page.deliveries[0]).toEqual(done);
        expect(page.deliveries[0]!.status).toBe("succeeded");
      });

      it("paginates correctly: cursor advances the page, nextCursor signals more", async () => {
        // Enqueue 3 tasks for ep_1 at distinct timestamps (newest = t3).
        const t1 = await queue.enqueue({ messageId: "m1", endpointId: "ep_1" });
        clock.advance(1_000);
        const t2 = await queue.enqueue({ messageId: "m2", endpointId: "ep_1" });
        clock.advance(1_000);
        const t3 = await queue.enqueue({ messageId: "m3", endpointId: "ep_1" });

        // First page (limit=2): should get t3, t2; nextCursor non-null.
        const first = await queue.listByEndpoint("ep_1", { limit: 2 });
        expect(first.deliveries.map((t) => t.id)).toEqual([t3.id, t2.id]);
        expect(first.nextCursor).not.toBeNull();

        // Second page using the cursor: should get t1; nextCursor null.
        const second = await queue.listByEndpoint("ep_1", {
          limit: 2,
          cursor: first.nextCursor!,
        });
        expect(second.deliveries.map((t) => t.id)).toEqual([t1.id]);
        expect(second.nextCursor).toBeNull();
      });

      it("rejects an invalid limit", async () => {
        await expect(queue.listByEndpoint("ep_1", { limit: 0 })).rejects.toThrow(RangeError);
        await expect(queue.listByEndpoint("ep_1", { limit: -1 })).rejects.toThrow(RangeError);
        await expect(queue.listByEndpoint("ep_1", { limit: 1.5 })).rejects.toThrow(RangeError);
        await expect(queue.listByEndpoint("ep_1", { limit: 201 })).rejects.toThrow(RangeError);
      });

      it("rejects a malformed cursor", async () => {
        await expect(
          queue.listByEndpoint("ep_1", { cursor: "not-valid!!" }),
        ).rejects.toThrow(TypeError);
        await expect(
          queue.listByEndpoint("ep_1", { cursor: "" }),
        ).rejects.toThrow(TypeError);
      });

      it("terminates cleanly on exact-multiple page boundary", async () => {
        const t1 = await queue.enqueue({ messageId: "m1", endpointId: "ep_1" });
        clock.advance(1_000);
        const t2 = await queue.enqueue({ messageId: "m2", endpointId: "ep_1" });

        const first = await queue.listByEndpoint("ep_1", { limit: 2 });
        expect(first.deliveries.map((t) => t.id)).toEqual([t2.id, t1.id]);
        expect(first.nextCursor).toBeNull(); // exact page → no further cursor

        // A continuation with the last cursor returns empty + null.
        const manualCursor = encodeDeliveryCursor(t1);
        const second = await queue.listByEndpoint("ep_1", {
          limit: 2,
          cursor: manualCursor,
        });
        expect(second.deliveries).toEqual([]);
        expect(second.nextCursor).toBeNull();
      });

      it("filters by status when provided — dead_letter only", async () => {
        // Enqueue two tasks for ep_1: complete one, dead-letter the other.
        const tOk = await queue.enqueue({ messageId: "m-ok", endpointId: "ep_1" });
        clock.advance(1_000);
        const tBad = await queue.enqueue({ messageId: "m-bad", endpointId: "ep_1" });
        // Succeed tOk.
        const [claimedOk] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
        await queue.complete(claimedOk!.id, claimedOk!.leaseToken!);
        // Dead-letter tBad (exhaust conformance policy: 2 retries = 3 fails).
        for (const delay of [0, 1_000, 2_000]) {
          clock.advance(delay);
          const [t] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
          await queue.fail(t!.id, t!.leaseToken!, { error: "x", nowMs: clock.now() });
        }

        // Filter by dead_letter → only tBad.
        const deadOnly = await queue.listByEndpoint("ep_1", { status: "dead_letter" });
        expect(deadOnly.deliveries).toHaveLength(1);
        expect(deadOnly.deliveries[0]!.id).toBe(tBad.id);
        expect(deadOnly.nextCursor).toBeNull();

        // Filter by succeeded → only tOk.
        const okOnly = await queue.listByEndpoint("ep_1", { status: "succeeded" });
        expect(okOnly.deliveries).toHaveLength(1);
        expect(okOnly.deliveries[0]!.id).toBe(tOk.id);
        expect(okOnly.nextCursor).toBeNull();
      });

      it("status filter paginates correctly across pages", async () => {
        // 3 dead-lettered tasks for ep_1, using zero-retry override for speed.
        for (let i = 0; i < 3; i++) {
          await queue.enqueue({ messageId: `m-dl-${i}`, endpointId: "ep_1" });
          clock.advance(1_000);
          const [c] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
          await queue.fail(c!.id, c!.leaseToken!, {
            error: "x",
            nowMs: clock.now(),
            retryPolicy: fixedSchedule([]),
          });
        }

        const opts = { status: "dead_letter" as const, limit: 2 };
        const first = await queue.listByEndpoint("ep_1", opts);
        expect(first.deliveries).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();

        const second = await queue.listByEndpoint("ep_1", { ...opts, cursor: first.nextCursor! });
        expect(second.deliveries).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
      });
    });

    describe("listByApp", () => {
      it("returns empty page for an app with no tasks", async () => {
        await queue.enqueue({ messageId: "m-other", appId: "app_other" });
        const page = await queue.listByApp("app_unknown");
        expect(page.deliveries).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });

      it("returns tasks newest-first, scoped to the app (cross-app isolation)", async () => {
        const t1 = await queue.enqueue({ messageId: "m-a", appId: "app_1" });
        clock.advance(1_000);
        await queue.enqueue({ messageId: "m-b", appId: "app_2" });
        clock.advance(1_000);
        const t3 = await queue.enqueue({ messageId: "m-c", appId: "app_1" });

        const page = await queue.listByApp("app_1");
        expect(page.deliveries.map((t) => t.id)).toEqual([t3.id, t1.id]);
        expect(page.deliveries.every((t) => t.appId === "app_1")).toBe(true);
        expect(page.nextCursor).toBeNull();
      });

      it("filters by status when requested", async () => {
        // Two tasks for app_1: one will succeed, one will dead-letter.
        const tOk = await queue.enqueue({ messageId: "m-ok", appId: "app_1" });
        clock.advance(1_000);
        const tBad = await queue.enqueue({ messageId: "m-bad", appId: "app_1" });
        // Succeed tOk.
        const [claimedOk] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
        await queue.complete(claimedOk!.id, claimedOk!.leaseToken!);
        // Dead-letter tBad (exhaust retries: 2-retry policy = 3 fails).
        for (const delay of [0, 1_000, 2_000]) {
          clock.advance(delay);
          const [t] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
          await queue.fail(t!.id, t!.leaseToken!, { error: "x", nowMs: clock.now() });
        }
        expect((await queue.get(tBad.id))?.status).toBe("dead_letter");

        // No filter → both tasks.
        const all = await queue.listByApp("app_1");
        expect(all.deliveries.map((t) => t.id).sort()).toEqual(
          [tOk.id, tBad.id].sort(),
        );

        // Filter by dead_letter → only tBad.
        const deadOnly = await queue.listByApp("app_1", { status: "dead_letter" });
        expect(deadOnly.deliveries).toHaveLength(1);
        expect(deadOnly.deliveries[0]!.id).toBe(tBad.id);
        expect(deadOnly.nextCursor).toBeNull();

        // Filter by succeeded → only tOk.
        const okOnly = await queue.listByApp("app_1", { status: "succeeded" });
        expect(okOnly.deliveries).toHaveLength(1);
        expect(okOnly.deliveries[0]!.id).toBe(tOk.id);
      });

      it("reflects a task's current state after a transition", async () => {
        await queue.enqueue({ messageId: "m", appId: "app_1" });
        const [claimed] = await queue.claimDue({ nowMs: clock.now() });
        const done = await queue.complete(claimed!.id, claimed!.leaseToken!);

        const page = await queue.listByApp("app_1");
        expect(page.deliveries).toHaveLength(1);
        expect(page.deliveries[0]).toEqual(done);
        expect(page.deliveries[0]!.status).toBe("succeeded");
      });

      it("paginates correctly: cursor advances the page, nextCursor signals more", async () => {
        const t1 = await queue.enqueue({ messageId: "m1", appId: "app_1" });
        clock.advance(1_000);
        const t2 = await queue.enqueue({ messageId: "m2", appId: "app_1" });
        clock.advance(1_000);
        const t3 = await queue.enqueue({ messageId: "m3", appId: "app_1" });

        const first = await queue.listByApp("app_1", { limit: 2 });
        expect(first.deliveries.map((t) => t.id)).toEqual([t3.id, t2.id]);
        expect(first.nextCursor).not.toBeNull();

        const second = await queue.listByApp("app_1", {
          limit: 2,
          cursor: first.nextCursor!,
        });
        expect(second.deliveries.map((t) => t.id)).toEqual([t1.id]);
        expect(second.nextCursor).toBeNull();
      });

      it("paginates a status-filtered result correctly", async () => {
        // Enqueue 3 tasks for app_1, dead-letter two of them.
        const t1 = await queue.enqueue({ messageId: "m1", appId: "app_1" });
        clock.advance(1_000);
        await queue.enqueue({ messageId: "m-ok", appId: "app_1" });
        clock.advance(1_000);
        const t3 = await queue.enqueue({ messageId: "m3", appId: "app_1" });
        // Succeed the middle task.
        const [mid] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
        await queue.complete(mid!.id, mid!.leaseToken!);
        // Dead-letter t1 and t3.
        for (const task of [t1, t3]) {
          for (const delay of [0, 1_000, 2_000]) {
            clock.advance(delay);
            const [cl] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
            if (!cl || cl.id !== task.id) continue;
            await queue.fail(cl.id, cl.leaseToken!, { error: "x", nowMs: clock.now() });
          }
        }
        // Drain any remaining claimable tasks in order for t3 to dead-letter too.
        // Use a broader loop to ensure both t1/t3 reach dead_letter.
        let safety = 0;
        while (safety++ < 10) {
          clock.advance(2_000);
          const batch = await queue.claimDue({ nowMs: clock.now(), limit: 10 });
          if (batch.length === 0) break;
          for (const t of batch) {
            await queue.fail(t.id, t.leaseToken!, { error: "x", nowMs: clock.now() });
          }
        }

        const opts: ListByAppOptions = { status: "dead_letter", limit: 1 };
        const first = await queue.listByApp("app_1", opts);
        expect(first.deliveries).toHaveLength(1);
        expect(first.nextCursor).not.toBeNull();

        const second = await queue.listByApp("app_1", {
          ...opts,
          cursor: first.nextCursor!,
        });
        expect(second.deliveries).toHaveLength(1);
        expect(second.nextCursor).toBeNull();

        const all = [...first.deliveries, ...second.deliveries];
        expect(all.map((t) => t.status).every((s) => s === "dead_letter")).toBe(true);
      });

      it("rejects an invalid limit", async () => {
        await expect(queue.listByApp("app_1", { limit: 0 })).rejects.toThrow(RangeError);
        await expect(queue.listByApp("app_1", { limit: -1 })).rejects.toThrow(RangeError);
        await expect(queue.listByApp("app_1", { limit: 1.5 })).rejects.toThrow(RangeError);
        await expect(queue.listByApp("app_1", { limit: 201 })).rejects.toThrow(RangeError);
      });

      it("rejects a malformed cursor", async () => {
        await expect(
          queue.listByApp("app_1", { cursor: "not-valid!!" }),
        ).rejects.toThrow(TypeError);
        await expect(
          queue.listByApp("app_1", { cursor: "" }),
        ).rejects.toThrow(TypeError);
      });

      it("terminates cleanly on exact-multiple page boundary", async () => {
        const t1 = await queue.enqueue({ messageId: "m1", appId: "app_1" });
        clock.advance(1_000);
        const t2 = await queue.enqueue({ messageId: "m2", appId: "app_1" });

        const first = await queue.listByApp("app_1", { limit: 2 });
        expect(first.deliveries.map((t) => t.id)).toEqual([t2.id, t1.id]);
        expect(first.nextCursor).toBeNull();

        const manualCursor = encodeDeliveryCursor(t1);
        const second = await queue.listByApp("app_1", {
          limit: 2,
          cursor: manualCursor,
        });
        expect(second.deliveries).toEqual([]);
        expect(second.nextCursor).toBeNull();
      });
    });

    describe("countByStatus", () => {
      it("returns all-zero counts for an empty queue", async () => {
        expect(await queue.countByStatus()).toEqual({
          pending: 0,
          delivering: 0,
          succeeded: 0,
          dead_letter: 0,
          cancelled: 0,
        });
      });

      it("counts tasks across each delivery status", async () => {
        // dead_letter: drive one task through the exhausted (2-retry) schedule.
        const dead = await queue.enqueue({ messageId: "m-dead" });
        for (const delay of [0, 1_000, 2_000]) {
          clock.advance(delay);
          const [t] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
          await queue.fail(t!.id, t!.leaseToken!, { error: "x", nowMs: clock.now() });
        }
        expect((await queue.get(dead.id))?.status).toBe("dead_letter");

        // succeeded: claim + complete the next task.
        await queue.enqueue({ messageId: "m-ok" });
        const [ok] = await queue.claimDue({ nowMs: clock.now(), limit: 1 });
        await queue.complete(ok!.id, ok!.leaseToken!);

        // delivering: claim and hold the lease (do not settle, do not advance time).
        await queue.enqueue({ messageId: "m-inflight" });
        await queue.claimDue({ nowMs: clock.now(), limit: 1 });

        // pending: enqueue with a future availableAt so it is never claimed.
        await queue.enqueue({ messageId: "m-pending", availableAt: clock.now() + 60_000 });

        expect(await queue.countByStatus()).toEqual({
          pending: 1,
          delivering: 1,
          succeeded: 1,
          dead_letter: 1,
          cancelled: 0,
        });
      });

      it("reflects a transition in the counts", async () => {
        await queue.enqueue({ messageId: "m" });
        expect(await queue.countByStatus()).toEqual({
          pending: 1,
          delivering: 0,
          succeeded: 0,
          dead_letter: 0,
          cancelled: 0,
        });

        const [claimed] = await queue.claimDue({ nowMs: clock.now() });
        let counts = await queue.countByStatus();
        expect(counts.pending).toBe(0);
        expect(counts.delivering).toBe(1);

        await queue.complete(claimed!.id, claimed!.leaseToken!);
        counts = await queue.countByStatus();
        expect(counts.delivering).toBe(0);
        expect(counts.succeeded).toBe(1);
      });
    });

    describe("pruneTerminalTasks", () => {
      it("deletes terminal tasks older than the cutoff, returns deleted count", async () => {
        // Drive one task to succeeded and another to dead_letter; both at the base clock.
        const tOk = await queue.enqueue({ messageId: "m-ok" });
        const [claimedOk] = await queue.claimDue({ nowMs: clock.now() });
        await queue.complete(claimedOk!.id, claimedOk!.leaseToken!);

        const tDead = await queue.enqueue({ messageId: "m-dead" });
        for (const delay of [0, 1_000, 2_000]) {
          clock.advance(delay);
          const [t] = await queue.claimDue({ nowMs: clock.now() });
          await queue.fail(t!.id, t!.leaseToken!, { error: "x", nowMs: clock.now() });
        }
        expect((await queue.get(tDead.id))?.status).toBe("dead_letter");

        // Cutoff is strictly after both tasks' updatedAt.
        clock.advance(1);
        const cutoff = clock.now();

        const deleted = await queue.pruneTerminalTasks(cutoff);
        expect(deleted).toBe(2);
        expect(await queue.get(tOk.id)).toBeNull();
        expect(await queue.get(tDead.id)).toBeNull();
      });

      it("never deletes pending or delivering tasks regardless of age", async () => {
        const pending = await queue.enqueue({ messageId: "m-pending" });
        await queue.enqueue({ messageId: "m-delivering" });
        const [delivering] = await queue.claimDue({ nowMs: clock.now() });

        // Far-future cutoff — active tasks must survive.
        clock.advance(100_000);
        const deleted = await queue.pruneTerminalTasks(clock.now());
        expect(deleted).toBe(0);
        expect(await queue.get(pending.id)).not.toBeNull();
        expect(await queue.get(delivering!.id)).not.toBeNull();
      });

      it("returns 0 when there is nothing to prune", async () => {
        expect(await queue.pruneTerminalTasks(clock.now())).toBe(0);
      });
    });

    describe("full lifecycle", () => {
      it("enqueue → claim → fail → reclaim → complete, counting attempts", async () => {
        const enq = await queue.enqueue({ messageId: "m" });

        const [a1] = await queue.claimDue({ nowMs: clock.now() });
        expect(a1!.attempts).toBe(1);
        await queue.fail(a1!.id, a1!.leaseToken!, {
          error: "transient",
          nowMs: clock.now(),
        });

        clock.advance(1_000);
        const [a2] = await queue.claimDue({ nowMs: clock.now() });
        expect(a2!.attempts).toBe(2);
        const done = await queue.complete(a2!.id, a2!.leaseToken!);

        expect(done.id).toBe(enq.id);
        expect(done.status).toBe("succeeded");
        expect(done.attempts).toBe(2);
      });
    });
  });
}
