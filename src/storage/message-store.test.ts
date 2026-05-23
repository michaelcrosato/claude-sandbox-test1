import { describe, expect, it } from "vitest";
import {
  createMessageId,
  IdempotencyConflictError,
  messageFingerprint,
  utcMonthRange,
} from "./message-store.js";

describe("messageFingerprint", () => {
  it("is deterministic for identical inputs", () => {
    expect(messageFingerprint("user.created", '{"a":1}')).toBe(
      messageFingerprint("user.created", '{"a":1}'),
    );
  });

  it("differs when eventType or payload differs", () => {
    const base = messageFingerprint("user.created", '{"a":1}');
    expect(messageFingerprint("user.updated", '{"a":1}')).not.toBe(base);
    expect(messageFingerprint("user.created", '{"a":2}')).not.toBe(base);
  });

  it("does not collide when the eventType/payload boundary shifts", () => {
    // Without length-prefixing, a naive `eventType + payload` join would make
    // these two distinct inputs hash identically.
    expect(messageFingerprint("ab", "c")).not.toBe(messageFingerprint("a", "bc"));
  });

  it("returns a 64-char hex sha256 digest", () => {
    expect(messageFingerprint("x", "y")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createMessageId", () => {
  it("produces prefixed, unique, URL-safe ids", () => {
    const a = createMessageId();
    const b = createMessageId();
    expect(a).toMatch(/^msg_[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe("IdempotencyConflictError", () => {
  it("carries the conflicting key and a stable name", () => {
    const err = new IdempotencyConflictError("key-123");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IdempotencyConflictError");
    expect(err.key).toBe("key-123");
  });
});

describe("utcMonthRange", () => {
  it("spans [first-of-month, first-of-next-month) in UTC for a mid-month instant", () => {
    const range = utcMonthRange(Date.UTC(2026, 4, 15, 12, 34, 56)); // 2026-05-15
    expect(range.fromMs).toBe(Date.UTC(2026, 4, 1, 0, 0, 0));
    expect(range.toMs).toBe(Date.UTC(2026, 5, 1, 0, 0, 0));
  });

  it("rolls December over into the next January", () => {
    const range = utcMonthRange(Date.UTC(2026, 11, 31, 23, 59, 59)); // 2026-12-31
    expect(range.fromMs).toBe(Date.UTC(2026, 11, 1, 0, 0, 0));
    expect(range.toMs).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });

  it("includes the first instant of the month and excludes the first of the next", () => {
    const first = Date.UTC(2026, 4, 1, 0, 0, 0);
    const range = utcMonthRange(first);
    expect(range.fromMs).toBe(first);
    // Half-open: the upper bound is the next month's first instant, never counted.
    expect(range.toMs).toBeGreaterThan(range.fromMs);
  });
});
