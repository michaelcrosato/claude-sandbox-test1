import { describe, expect, it } from "vitest";
import {
  generateSecret,
  HEADERS,
  sign,
  verify,
  WebhookVerificationError,
} from "./webhook-signature.js";

// Canonical Standard Webhooks / Svix reference vector. Proves byte-for-byte
// spec compliance and interoperability with existing receivers.
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  payload: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

describe("sign", () => {
  it("matches the canonical Standard Webhooks reference vector", () => {
    expect(
      sign(VECTOR.secret, {
        id: VECTOR.id,
        timestamp: VECTOR.timestamp,
        payload: VECTOR.payload,
      }),
    ).toBe(VECTOR.signature);
  });

  it("is deterministic for identical inputs", () => {
    const input = { id: "msg_1", timestamp: 1700000000, payload: "{}" };
    expect(sign(VECTOR.secret, input)).toBe(sign(VECTOR.secret, input));
  });

  it("produces the v1, prefixed format", () => {
    const sig = sign(VECTOR.secret, { id: "a", timestamp: 1, payload: "b" });
    expect(sig.startsWith("v1,")).toBe(true);
  });

  it("treats the whsec_ prefix as cosmetic (bare secret yields same digest)", () => {
    const input = { id: "x", timestamp: 1700000000, payload: "p" };
    const bare = VECTOR.secret.slice("whsec_".length);
    expect(sign(bare, input)).toBe(sign(VECTOR.secret, input));
  });

  it("changes the signature when any signed field changes", () => {
    const base = { id: "id1", timestamp: 1700000000, payload: "payload" };
    const sig = sign(VECTOR.secret, base);
    expect(sign(VECTOR.secret, { ...base, id: "id2" })).not.toBe(sig);
    expect(sign(VECTOR.secret, { ...base, timestamp: 1700000001 })).not.toBe(sig);
    expect(sign(VECTOR.secret, { ...base, payload: "payload!" })).not.toBe(sig);
  });

  it("rejects a non-finite timestamp", () => {
    expect(() =>
      sign(VECTOR.secret, { id: "a", timestamp: Number.NaN, payload: "b" }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects an empty / invalid secret", () => {
    expect(() => sign("whsec_", { id: "a", timestamp: 1, payload: "b" })).toThrow(
      WebhookVerificationError,
    );
  });
});

describe("verify", () => {
  const now = 1614265330; // pin to the vector's timestamp for replay-window tests

  it("accepts the canonical reference vector", () => {
    expect(() =>
      verify(
        VECTOR.secret,
        { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature },
        VECTOR.payload,
        { now },
      ),
    ).not.toThrow();
  });

  it("round-trips sign -> verify", () => {
    const input = { id: "msg_rt", timestamp: now, payload: '{"a":1}' };
    const signature = sign(VECTOR.secret, input);
    expect(() =>
      verify(VECTOR.secret, { ...input, signature }, input.payload, { now }),
    ).not.toThrow();
  });

  it("accepts a string timestamp header", () => {
    const input = { id: "msg_s", timestamp: now, payload: "{}" };
    const signature = sign(VECTOR.secret, input);
    expect(() =>
      verify(
        VECTOR.secret,
        { id: input.id, timestamp: String(now), signature },
        input.payload,
        { now },
      ),
    ).not.toThrow();
  });

  it("rejects a tampered payload", () => {
    const input = { id: "msg_t", timestamp: now, payload: '{"amount":1}' };
    const signature = sign(VECTOR.secret, input);
    expect(() =>
      verify(VECTOR.secret, { ...input, signature }, '{"amount":1000000}', { now }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects a signature made with a different secret", () => {
    const input = { id: "msg_w", timestamp: now, payload: "{}" };
    const signature = sign(generateSecret(), input);
    expect(() =>
      verify(VECTOR.secret, { ...input, signature }, input.payload, { now }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects a timestamp older than the tolerance window", () => {
    const input = { id: "msg_old", timestamp: now - 3600, payload: "{}" };
    const signature = sign(VECTOR.secret, input);
    expect(() =>
      verify(VECTOR.secret, { ...input, signature }, input.payload, { now }),
    ).toThrow(/too old/);
  });

  it("rejects a timestamp further in the future than the tolerance window", () => {
    const input = { id: "msg_new", timestamp: now + 3600, payload: "{}" };
    const signature = sign(VECTOR.secret, input);
    expect(() =>
      verify(VECTOR.secret, { ...input, signature }, input.payload, { now }),
    ).toThrow(/too new/);
  });

  it("honors a custom tolerance window", () => {
    const input = { id: "msg_tol", timestamp: now - 120, payload: "{}" };
    const signature = sign(VECTOR.secret, input);
    // Default 300s tolerance accepts it; a tight 60s window rejects it.
    expect(() =>
      verify(VECTOR.secret, { ...input, signature }, input.payload, { now }),
    ).not.toThrow();
    expect(() =>
      verify(VECTOR.secret, { ...input, signature }, input.payload, {
        now,
        toleranceInSeconds: 60,
      }),
    ).toThrow(/too old/);
  });

  it("accepts when one of several space-delimited signatures matches (key rotation)", () => {
    const input = { id: "msg_rot", timestamp: now, payload: "{}" };
    const good = sign(VECTOR.secret, input);
    const stale = sign(generateSecret(), input);
    const header = `${stale} ${good}`;
    expect(() =>
      verify(VECTOR.secret, { ...input, signature: header }, input.payload, { now }),
    ).not.toThrow();
  });

  it("ignores malformed and non-v1 tokens", () => {
    const input = { id: "msg_mal", timestamp: now, payload: "{}" };
    const good = sign(VECTOR.secret, input);
    const header = `garbage v2,abc ${good}`;
    expect(() =>
      verify(VECTOR.secret, { ...input, signature: header }, input.payload, { now }),
    ).not.toThrow();
  });

  it("rejects an invalid timestamp header", () => {
    expect(() =>
      verify(
        VECTOR.secret,
        { id: "a", timestamp: "not-a-number", signature: "v1,x" },
        "{}",
        { now },
      ),
    ).toThrow(/invalid webhook-timestamp/);
  });

  it("rejects when no signature token is present", () => {
    const input = { id: "msg_empty", timestamp: now, payload: "{}" };
    expect(() =>
      verify(VECTOR.secret, { ...input, signature: "" }, input.payload, { now }),
    ).toThrow(/no matching signature/);
  });
});

describe("generateSecret", () => {
  it("returns a whsec_-prefixed base64 secret usable for round-trip signing", () => {
    const secret = generateSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    const input = { id: "msg_g", timestamp: 1700000000, payload: "{}" };
    const signature = sign(secret, input);
    expect(() =>
      verify(secret, { ...input, signature }, input.payload, { now: 1700000000 }),
    ).not.toThrow();
  });

  it("produces unique secrets", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });

  it("rejects an entropy budget below 16 bytes", () => {
    expect(() => generateSecret(8)).toThrow(WebhookVerificationError);
  });
});

describe("HEADERS", () => {
  it("exposes the canonical Standard Webhooks header names", () => {
    expect(HEADERS).toEqual({
      id: "webhook-id",
      timestamp: "webhook-timestamp",
      signature: "webhook-signature",
    });
  });
});
