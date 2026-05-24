import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  exponentialBackoff,
  fixedSchedule,
  isNonRetryableStatus,
  maxAttempts,
  planNextAttempt,
} from "./retry-policy.js";

describe("fixedSchedule", () => {
  it("captures the provided delays", () => {
    expect(fixedSchedule([1, 2, 3]).delaysMs).toEqual([1, 2, 3]);
  });

  it("accepts an empty schedule (no retries)", () => {
    const policy = fixedSchedule([]);
    expect(policy.delaysMs).toEqual([]);
    expect(maxAttempts(policy)).toBe(1);
  });

  it("copies the input so later mutation cannot corrupt the policy", () => {
    const input = [10, 20];
    const policy = fixedSchedule(input);
    input[0] = 999;
    expect(policy.delaysMs[0]).toBe(10);
  });

  it("rejects negative or non-finite delays", () => {
    expect(() => fixedSchedule([-1])).toThrow(RangeError);
    expect(() => fixedSchedule([Number.NaN])).toThrow(RangeError);
    expect(() => fixedSchedule([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});

describe("maxAttempts", () => {
  it("is the number of retries plus the initial attempt", () => {
    expect(maxAttempts(fixedSchedule([1, 2, 3]))).toBe(4);
  });
});

describe("exponentialBackoff", () => {
  it("produces a geometric sequence from the base and factor", () => {
    const policy = exponentialBackoff({ retries: 4, baseMs: 1000, factor: 2 });
    expect(policy.delaysMs).toEqual([1000, 2000, 4000, 8000]);
  });

  it("caps each delay at maxDelayMs", () => {
    const policy = exponentialBackoff({
      retries: 5,
      baseMs: 1000,
      factor: 10,
      maxDelayMs: 5000,
    });
    expect(policy.delaysMs).toEqual([1000, 5000, 5000, 5000, 5000]);
  });

  it("returns the requested number of retries", () => {
    expect(exponentialBackoff({ retries: 0 }).delaysMs).toEqual([]);
    expect(exponentialBackoff({ retries: 3 }).delaysMs).toHaveLength(3);
  });

  it("uses sane defaults (base 5s, factor 2)", () => {
    const policy = exponentialBackoff({ retries: 3 });
    expect(policy.delaysMs).toEqual([5000, 10000, 20000]);
  });

  it("rejects invalid configuration", () => {
    expect(() => exponentialBackoff({ retries: -1 })).toThrow(RangeError);
    expect(() => exponentialBackoff({ retries: 1.5 })).toThrow(RangeError);
    expect(() => exponentialBackoff({ retries: 1, baseMs: 0 })).toThrow(RangeError);
    expect(() => exponentialBackoff({ retries: 1, factor: 0.5 })).toThrow(RangeError);
    expect(() => exponentialBackoff({ retries: 1, maxDelayMs: 0 })).toThrow(RangeError);
  });
});

describe("DEFAULT_RETRY_POLICY", () => {
  it("is a 7-retry (8 attempt) schedule starting at 5s", () => {
    expect(DEFAULT_RETRY_POLICY.delaysMs).toHaveLength(7);
    expect(maxAttempts(DEFAULT_RETRY_POLICY)).toBe(8);
    expect(DEFAULT_RETRY_POLICY.delaysMs[0]).toBe(5_000);
  });

  it("is monotonically non-decreasing", () => {
    const d = DEFAULT_RETRY_POLICY.delaysMs;
    for (let i = 1; i < d.length; i++) {
      expect(d[i]!).toBeGreaterThanOrEqual(d[i - 1]!);
    }
  });
});

describe("isNonRetryableStatus", () => {
  it("returns false when nonRetryableStatuses is absent", () => {
    expect(isNonRetryableStatus(fixedSchedule([1000]), 401)).toBe(false);
  });

  it("returns true for a status that is in the list", () => {
    const policy = { delaysMs: [1000], nonRetryableStatuses: [400, 401, 410] };
    expect(isNonRetryableStatus(policy, 400)).toBe(true);
    expect(isNonRetryableStatus(policy, 401)).toBe(true);
    expect(isNonRetryableStatus(policy, 410)).toBe(true);
  });

  it("returns false for a status not in the list", () => {
    const policy = { delaysMs: [1000], nonRetryableStatuses: [400] };
    expect(isNonRetryableStatus(policy, 500)).toBe(false);
    expect(isNonRetryableStatus(policy, 503)).toBe(false);
  });

  it("returns false when the list is empty", () => {
    const policy = { delaysMs: [1000], nonRetryableStatuses: [] };
    expect(isNonRetryableStatus(policy, 400)).toBe(false);
  });
});

describe("planNextAttempt", () => {
  const policy = fixedSchedule([1000, 2000, 4000]); // 3 retries, 4 attempts max
  const now = 1_700_000_000_000;

  it("schedules the first retry using the first delay", () => {
    const plan = planNextAttempt(policy, 1, now);
    expect(plan).toEqual({
      retry: true,
      attempt: 2,
      nextAttemptAt: now + 1000,
      delayMs: 1000,
    });
  });

  it("advances through the schedule by attempt count", () => {
    expect(planNextAttempt(policy, 2, now).delayMs).toBe(2000);
    expect(planNextAttempt(policy, 2, now).attempt).toBe(3);
    expect(planNextAttempt(policy, 3, now).delayMs).toBe(4000);
    expect(planNextAttempt(policy, 3, now).attempt).toBe(4);
  });

  it("stops retrying once the schedule is exhausted (dead-letter)", () => {
    expect(planNextAttempt(policy, 4, now)).toEqual({ retry: false });
    expect(planNextAttempt(policy, 99, now)).toEqual({ retry: false });
  });

  it("never retries a policy with no delays", () => {
    expect(planNextAttempt(fixedSchedule([]), 1, now)).toEqual({ retry: false });
  });

  it("rejects a non-positive or non-integer attemptsMade", () => {
    expect(() => planNextAttempt(policy, 0, now)).toThrow(RangeError);
    expect(() => planNextAttempt(policy, -1, now)).toThrow(RangeError);
    expect(() => planNextAttempt(policy, 1.5, now)).toThrow(RangeError);
  });

  it("rejects a non-finite now", () => {
    expect(() => planNextAttempt(policy, 1, Number.NaN)).toThrow(RangeError);
  });

  describe("jitter", () => {
    it("leaves the delay unchanged when ratio is 0", () => {
      const plan = planNextAttempt(policy, 1, now, {
        jitterRatio: 0,
        random: () => 0,
      });
      expect(plan.delayMs).toBe(1000);
    });

    it("centers on the base delay when the RNG yields 0.5", () => {
      const plan = planNextAttempt(policy, 1, now, {
        jitterRatio: 0.5,
        random: () => 0.5,
      });
      expect(plan.delayMs).toBe(1000);
    });

    it("reaches the lower bound when the RNG yields 0", () => {
      const plan = planNextAttempt(policy, 1, now, {
        jitterRatio: 0.2,
        random: () => 0,
      });
      // 1000 * (1 - 0.2) = 800
      expect(plan.delayMs).toBe(800);
      expect(plan.nextAttemptAt).toBe(now + 800);
    });

    it("approaches the upper bound as the RNG approaches 1", () => {
      const plan = planNextAttempt(policy, 1, now, {
        jitterRatio: 0.2,
        random: () => 0.999999,
      });
      // 1000 * (1 + ~0.2) ~= 1200
      expect(plan.delayMs).toBeGreaterThan(1190);
      expect(plan.delayMs).toBeLessThanOrEqual(1200);
    });

    it("clamps a ratio above 1", () => {
      const plan = planNextAttempt(policy, 1, now, {
        jitterRatio: 5,
        random: () => 0,
      });
      // ratio clamped to 1 -> lower bound is 0, never negative.
      expect(plan.delayMs).toBe(0);
    });
  });
});
