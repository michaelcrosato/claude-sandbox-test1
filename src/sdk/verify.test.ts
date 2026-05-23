import { describe, expect, it } from "vitest";
import { HEADERS, sign, generateSecret } from "../signing/webhook-signature.js";
import { isValidWebhook, verifyWebhook, type IncomingHeaders } from "./verify.js";

// A fixed instant so signing + verification share one clock (no real-time flake).
const TS = 1_700_000_000;
const ID = "msg_abc123";
const PAYLOAD = JSON.stringify({ hello: "world", n: 42 });

/** Build a header bag carrying a valid signature over `(ID, ts, payload)`. */
function signed(secret: string, payload = PAYLOAD, ts = TS): IncomingHeaders {
  return {
    [HEADERS.id]: ID,
    [HEADERS.timestamp]: String(ts),
    [HEADERS.signature]: sign(secret, { id: ID, timestamp: ts, payload }),
  };
}

describe("verifyWebhook", () => {
  it("accepts an authentic webhook", () => {
    const secret = generateSecret();
    expect(() =>
      verifyWebhook(secret, signed(secret), PAYLOAD, { now: TS }),
    ).not.toThrow();
  });

  it("rejects a tampered body", () => {
    const secret = generateSecret();
    expect(() =>
      verifyWebhook(secret, signed(secret), PAYLOAD + " ", { now: TS }),
    ).toThrow(/no matching signature/);
  });

  it("rejects a signature made with a different secret", () => {
    const realSecret = generateSecret();
    const headers = signed(generateSecret()); // signed by an impostor
    expect(() => verifyWebhook(realSecret, headers, PAYLOAD, { now: TS })).toThrow();
  });

  it("rejects when a required header is missing", () => {
    const secret = generateSecret();
    const headers = signed(secret);
    const { [HEADERS.signature]: _omitted, ...withoutSignature } = headers;
    expect(() =>
      verifyWebhook(secret, withoutSignature, PAYLOAD, { now: TS }),
    ).toThrow(/missing one or more required webhook headers/);
  });

  it("reads headers case-insensitively (framework-normalized or not)", () => {
    const secret = generateSecret();
    const sig = sign(secret, { id: ID, timestamp: TS, payload: PAYLOAD });
    const headers: IncomingHeaders = {
      "Webhook-Id": ID,
      "Webhook-Timestamp": String(TS),
      "Webhook-Signature": sig,
    };
    expect(() => verifyWebhook(secret, headers, PAYLOAD, { now: TS })).not.toThrow();
  });

  it("collapses an array-valued header to its first entry (node style)", () => {
    const secret = generateSecret();
    const sig = sign(secret, { id: ID, timestamp: TS, payload: PAYLOAD });
    const headers: IncomingHeaders = {
      [HEADERS.id]: [ID],
      [HEADERS.timestamp]: [String(TS)],
      [HEADERS.signature]: [sig],
    };
    expect(() => verifyWebhook(secret, headers, PAYLOAD, { now: TS })).not.toThrow();
  });

  it("enforces the replay window (a too-old timestamp fails)", () => {
    const secret = generateSecret();
    // Verify 10 minutes after signing, with the default 5-minute tolerance.
    expect(() =>
      verifyWebhook(secret, signed(secret), PAYLOAD, { now: TS + 10 * 60 }),
    ).toThrow(/too old/);
  });
});

describe("isValidWebhook", () => {
  it("returns true for an authentic webhook", () => {
    const secret = generateSecret();
    expect(isValidWebhook(secret, signed(secret), PAYLOAD, { now: TS })).toBe(true);
  });

  it("returns false (no throw) for a tampered body", () => {
    const secret = generateSecret();
    expect(isValidWebhook(secret, signed(secret), "tampered", { now: TS })).toBe(false);
  });

  it("returns false when a header is missing", () => {
    const secret = generateSecret();
    expect(isValidWebhook(secret, {}, PAYLOAD, { now: TS })).toBe(false);
  });
});
