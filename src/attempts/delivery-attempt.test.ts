import { describe, expect, it } from "vitest";
import {
  createAttemptId,
  normalizeNewAttempt,
  type NewDeliveryAttempt,
} from "./delivery-attempt.js";

/** A complete, valid input for the normalizer with overrides. */
function input(overrides: Partial<NewDeliveryAttempt> = {}): NewDeliveryAttempt {
  return {
    taskId: "dtask_1",
    messageId: "msg_1",
    attemptNumber: 1,
    outcome: "succeeded",
    durationMs: 5,
    attemptedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("createAttemptId", () => {
  it("produces a datt_-prefixed, unique, url-safe id", () => {
    const a = createAttemptId();
    const b = createAttemptId();
    expect(a).toMatch(/^datt_[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe("normalizeNewAttempt", () => {
  it("fills optional fields with null and passes the rest through", () => {
    expect(normalizeNewAttempt(input())).toEqual({
      taskId: "dtask_1",
      messageId: "msg_1",
      appId: null,
      endpointId: null,
      attemptNumber: 1,
      outcome: "succeeded",
      responseStatus: null,
      error: null,
      requestBody: null,
      responseBody: null,
      durationMs: 5,
      attemptedAt: 1_700_000_000_000,
    });
  });

  it("keeps provided optional fields", () => {
    const n = normalizeNewAttempt(
      input({ endpointId: "ep_9", responseStatus: 204, error: null }),
    );
    expect(n.endpointId).toBe("ep_9");
    expect(n.responseStatus).toBe(204);
  });

  it("rejects an empty/non-string taskId or messageId", () => {
    expect(() => normalizeNewAttempt(input({ taskId: "" }))).toThrow(TypeError);
    expect(() => normalizeNewAttempt(input({ messageId: "" }))).toThrow(TypeError);
    // @ts-expect-error — taskId must be a string
    expect(() => normalizeNewAttempt(input({ taskId: 1 }))).toThrow(TypeError);
  });

  it("rejects an empty endpointId but allows null", () => {
    expect(() => normalizeNewAttempt(input({ endpointId: "" }))).toThrow(TypeError);
    expect(normalizeNewAttempt(input({ endpointId: null })).endpointId).toBeNull();
  });

  it("rejects an empty appId but allows null or a value", () => {
    expect(() => normalizeNewAttempt(input({ appId: "" }))).toThrow(TypeError);
    expect(normalizeNewAttempt(input({ appId: null })).appId).toBeNull();
    expect(normalizeNewAttempt(input()).appId).toBeNull();
    expect(normalizeNewAttempt(input({ appId: "app_42" })).appId).toBe("app_42");
  });

  it("rejects a non-positive or non-integer attemptNumber", () => {
    expect(() => normalizeNewAttempt(input({ attemptNumber: 0 }))).toThrow(TypeError);
    expect(() => normalizeNewAttempt(input({ attemptNumber: -1 }))).toThrow(TypeError);
    expect(() => normalizeNewAttempt(input({ attemptNumber: 2.5 }))).toThrow(TypeError);
  });

  it("rejects an unknown outcome", () => {
    // @ts-expect-error — outcome must be a known literal
    expect(() => normalizeNewAttempt(input({ outcome: "pending" }))).toThrow(TypeError);
  });

  it("rejects a non-integer responseStatus but allows null", () => {
    expect(() => normalizeNewAttempt(input({ responseStatus: 1.5 }))).toThrow(TypeError);
    expect(normalizeNewAttempt(input({ responseStatus: null })).responseStatus).toBeNull();
  });

  it("rejects a non-string error but allows null", () => {
    // @ts-expect-error — error must be a string or null
    expect(() => normalizeNewAttempt(input({ error: 5 }))).toThrow(TypeError);
    expect(normalizeNewAttempt(input({ error: null })).error).toBeNull();
  });

  it("rejects a negative or non-integer durationMs", () => {
    expect(() => normalizeNewAttempt(input({ durationMs: -1 }))).toThrow(TypeError);
    expect(() => normalizeNewAttempt(input({ durationMs: 1.5 }))).toThrow(TypeError);
    expect(normalizeNewAttempt(input({ durationMs: 0 })).durationMs).toBe(0);
  });

  it("rejects a non-finite attemptedAt", () => {
    expect(() => normalizeNewAttempt(input({ attemptedAt: Number.NaN }))).toThrow(TypeError);
    expect(() => normalizeNewAttempt(input({ attemptedAt: Infinity }))).toThrow(TypeError);
  });
});
