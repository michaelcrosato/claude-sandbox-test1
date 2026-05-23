import { describe, expect, it } from "vitest";
import { fixedSchedule, maxAttempts } from "./retry-policy.js";
import {
  type DeliveryState,
  DeliveryStateError,
  initialDeliveryState,
  isDeliverable,
  isTerminal,
  reduce,
} from "./delivery-state.js";

const policy = fixedSchedule([1000, 2000, 4000]); // 3 retries -> 4 attempts max
const now = 1_700_000_000_000;

describe("initialDeliveryState", () => {
  it("starts pending with no attempts and immediate eligibility", () => {
    expect(initialDeliveryState()).toEqual({
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("can be scheduled for a future first attempt", () => {
    expect(initialDeliveryState(now + 500).nextAttemptAt).toBe(now + 500);
  });
});

describe("reduce — happy path", () => {
  it("pending -> delivering -> succeeded", () => {
    let s = initialDeliveryState();
    s = reduce(policy, s, { type: "attemptStarted" });
    expect(s.status).toBe("delivering");
    expect(s.attempts).toBe(1);
    expect(s.nextAttemptAt).toBeNull();

    s = reduce(policy, s, { type: "attemptSucceeded" });
    expect(s.status).toBe("succeeded");
    expect(s.attempts).toBe(1);
    expect(isTerminal(s)).toBe(true);
  });
});

describe("reduce — failure and retry", () => {
  it("schedules a retry through the policy and records the error", () => {
    let s = initialDeliveryState();
    s = reduce(policy, s, { type: "attemptStarted" });
    s = reduce(policy, s, { type: "attemptFailed", error: "503", nowMs: now });

    expect(s.status).toBe("pending");
    expect(s.attempts).toBe(1);
    expect(s.nextAttemptAt).toBe(now + 1000); // first delay
    expect(s.lastError).toBe("503");
    expect(isTerminal(s)).toBe(false);
  });

  it("uses successively larger delays as attempts accumulate", () => {
    let s = initialDeliveryState();
    s = reduce(policy, s, { type: "attemptStarted" });
    s = reduce(policy, s, { type: "attemptFailed", error: "e1", nowMs: now });
    s = reduce(policy, s, { type: "attemptStarted" });
    s = reduce(policy, s, { type: "attemptFailed", error: "e2", nowMs: now });
    expect(s.attempts).toBe(2);
    expect(s.nextAttemptAt).toBe(now + 2000); // second delay
  });

  it("applies injected jitter to the scheduled time", () => {
    let s = initialDeliveryState();
    s = reduce(policy, s, { type: "attemptStarted" });
    s = reduce(
      policy,
      s,
      { type: "attemptFailed", error: "e", nowMs: now },
      { jitterRatio: 0.2, random: () => 0 },
    );
    // 1000 * (1 - 0.2) = 800
    expect(s.nextAttemptAt).toBe(now + 800);
  });
});

describe("reduce — exhaustion to dead_letter", () => {
  it("dead-letters after the final retry fails, preserving the last error", () => {
    let s: DeliveryState = initialDeliveryState();
    // Drive every attempt to failure.
    for (let i = 0; i < maxAttempts(policy); i++) {
      s = reduce(policy, s, { type: "attemptStarted" });
      s = reduce(policy, s, {
        type: "attemptFailed",
        error: `fail-${i + 1}`,
        nowMs: now,
      });
    }
    expect(s.status).toBe("dead_letter");
    expect(s.attempts).toBe(maxAttempts(policy)); // 4
    expect(s.nextAttemptAt).toBeNull();
    expect(s.lastError).toBe(`fail-${maxAttempts(policy)}`);
    expect(isTerminal(s)).toBe(true);
  });

  it("dead-letters on the first failure when the policy has no retries", () => {
    const noRetry = fixedSchedule([]);
    let s = initialDeliveryState();
    s = reduce(noRetry, s, { type: "attemptStarted" });
    s = reduce(noRetry, s, { type: "attemptFailed", error: "boom", nowMs: now });
    expect(s.status).toBe("dead_letter");
    expect(s.attempts).toBe(1);
  });
});

describe("reduce — illegal transitions", () => {
  it("rejects success/failure before an attempt starts", () => {
    const s = initialDeliveryState();
    expect(() => reduce(policy, s, { type: "attemptSucceeded" })).toThrow(
      DeliveryStateError,
    );
    expect(() =>
      reduce(policy, s, { type: "attemptFailed", error: "x", nowMs: now }),
    ).toThrow(DeliveryStateError);
  });

  it("rejects starting a second attempt while one is in flight", () => {
    let s = initialDeliveryState();
    s = reduce(policy, s, { type: "attemptStarted" });
    expect(() => reduce(policy, s, { type: "attemptStarted" })).toThrow(
      DeliveryStateError,
    );
  });

  it("rejects every event once terminal", () => {
    let s = initialDeliveryState();
    s = reduce(policy, s, { type: "attemptStarted" });
    s = reduce(policy, s, { type: "attemptSucceeded" });
    for (const event of [
      { type: "attemptStarted" } as const,
      { type: "attemptSucceeded" } as const,
      { type: "attemptFailed", error: "x", nowMs: now } as const,
    ]) {
      expect(() => reduce(policy, s, event)).toThrow(DeliveryStateError);
    }
  });
});

describe("reduce — manualRetry (operator recovery)", () => {
  /** Drive a fresh delivery to dead_letter under a no-retry policy. */
  function deadLettered(): DeliveryState {
    const noRetry = fixedSchedule([]);
    let s = initialDeliveryState();
    s = reduce(noRetry, s, { type: "attemptStarted" });
    return reduce(noRetry, s, { type: "attemptFailed", error: "boom", nowMs: now });
  }

  it("revives a dead-lettered delivery as a fresh, immediately-deliverable one", () => {
    const dead = deadLettered();
    expect(dead.status).toBe("dead_letter");

    const revived = reduce(policy, dead, { type: "manualRetry" });
    expect(revived.status).toBe("pending");
    expect(revived.attempts).toBe(0); // fresh budget — the full schedule applies again
    expect(revived.nextAttemptAt).toBeNull(); // deliverable now
    expect(revived.lastError).toBeNull(); // clean slate
    expect(isTerminal(revived)).toBe(false);
    expect(isDeliverable(revived, now)).toBe(true);
  });

  it("also revives a succeeded delivery (a resend), resetting it", () => {
    let s = initialDeliveryState();
    s = reduce(policy, s, { type: "attemptStarted" });
    s = reduce(policy, s, { type: "attemptSucceeded" });
    expect(s.status).toBe("succeeded");

    const revived = reduce(policy, s, { type: "manualRetry" });
    expect(revived).toEqual({
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("rejects manualRetry on a non-terminal (pending/delivering) delivery", () => {
    const pending = initialDeliveryState();
    expect(() => reduce(policy, pending, { type: "manualRetry" })).toThrow(
      DeliveryStateError,
    );

    const delivering = reduce(policy, pending, { type: "attemptStarted" });
    expect(() => reduce(policy, delivering, { type: "manualRetry" })).toThrow(
      DeliveryStateError,
    );
  });
});

describe("isDeliverable", () => {
  it("is true for a pending message with no scheduled time", () => {
    expect(isDeliverable(initialDeliveryState(), now)).toBe(true);
  });

  it("respects a future scheduled time", () => {
    const s = initialDeliveryState(now + 1000);
    expect(isDeliverable(s, now)).toBe(false);
    expect(isDeliverable(s, now + 1000)).toBe(true);
    expect(isDeliverable(s, now + 2000)).toBe(true);
  });

  it("is false while delivering or terminal", () => {
    let s = initialDeliveryState();
    s = reduce(policy, s, { type: "attemptStarted" });
    expect(isDeliverable(s, now)).toBe(false);
    s = reduce(policy, s, { type: "attemptSucceeded" });
    expect(isDeliverable(s, now)).toBe(false);
  });
});
