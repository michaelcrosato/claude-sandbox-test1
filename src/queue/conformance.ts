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
  StaleLeaseError,
  UnknownDeliveryTaskError,
  type DeliveryQueue,
} from "./delivery-queue.js";
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

      it("claims oldest-first (enqueue order)", async () => {
        const a = await queue.enqueue({ messageId: "a" });
        const b = await queue.enqueue({ messageId: "b" });
        const c = await queue.enqueue({ messageId: "c" });
        const claimed = await queue.claimDue({ nowMs: clock.now(), limit: 10 });
        expect(claimed.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
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
