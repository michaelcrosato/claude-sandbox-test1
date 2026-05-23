import { describe, expect, it } from "vitest";
import {
  createMessageId,
  IdempotencyConflictError,
  messageFingerprint,
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
