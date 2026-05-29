import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRIPE_TOLERANCE_SECONDS,
  signStripeSignatureHeader,
  StripeSignatureError,
  verifyStripeSignature,
} from "./stripe-signature.js";

const SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
const PAYLOAD = '{"id":"evt_1","type":"invoice.paid"}';
const TS = 1_700_000_000;

describe("signStripeSignatureHeader", () => {
  it("produces the t=<ts>,v1=<hex> wire format", () => {
    const header = signStripeSignatureHeader(SECRET, { timestamp: TS, payload: PAYLOAD });
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it("uses the secret verbatim as the HMAC key over `{ts}.{payload}` (Stripe convention)", () => {
    // The single most error-prone divergence from Standard Webhooks: the secret string
    // is the UTF-8 HMAC key as-is (NOT base64-decoded, prefix NOT stripped), hex digest.
    const expected = createHmac("sha256", SECRET).update(`${TS}.${PAYLOAD}`, "utf8").digest("hex");
    const header = signStripeSignatureHeader(SECRET, { timestamp: TS, payload: PAYLOAD });
    expect(header).toBe(`t=${TS},v1=${expected}`);
  });

  it("is deterministic for identical inputs", () => {
    const input = { timestamp: TS, payload: PAYLOAD };
    expect(signStripeSignatureHeader(SECRET, input)).toBe(signStripeSignatureHeader(SECRET, input));
  });
});

describe("verifyStripeSignature", () => {
  it("accepts a freshly signed header at the same clock", () => {
    const header = signStripeSignatureHeader(SECRET, { timestamp: TS, payload: PAYLOAD });
    expect(() => verifyStripeSignature(SECRET, header, PAYLOAD, { now: TS })).not.toThrow();
  });

  it("rejects a body that does not match the signed payload (tamper)", () => {
    const header = signStripeSignatureHeader(SECRET, { timestamp: TS, payload: PAYLOAD });
    expect(() => verifyStripeSignature(SECRET, header, PAYLOAD + " ", { now: TS })).toThrow(
      StripeSignatureError,
    );
  });

  it("rejects a header signed with a different secret", () => {
    const header = signStripeSignatureHeader("whsec_other_secret_value_here_padding", {
      timestamp: TS,
      payload: PAYLOAD,
    });
    expect(() => verifyStripeSignature(SECRET, header, PAYLOAD, { now: TS })).toThrow(
      StripeSignatureError,
    );
  });

  it("rejects a missing header", () => {
    expect(() => verifyStripeSignature(SECRET, undefined, PAYLOAD, { now: TS })).toThrow(
      /missing Stripe-Signature header/,
    );
  });

  it("rejects an empty signing secret", () => {
    const header = signStripeSignatureHeader(SECRET, { timestamp: TS, payload: PAYLOAD });
    expect(() => verifyStripeSignature("", header, PAYLOAD, { now: TS })).toThrow(
      /signing secret is empty/,
    );
  });

  it("rejects a header with no v1 signature token", () => {
    expect(() => verifyStripeSignature(SECRET, `t=${TS}`, PAYLOAD, { now: TS })).toThrow(
      /no v1 signature/,
    );
  });

  it("rejects a header with no valid timestamp", () => {
    const digest = createHmac("sha256", SECRET).update(`${TS}.${PAYLOAD}`, "utf8").digest("hex");
    expect(() => verifyStripeSignature(SECRET, `v1=${digest}`, PAYLOAD, { now: TS })).toThrow(
      /no valid timestamp/,
    );
  });

  it("rejects a timestamp older than the tolerance window", () => {
    const header = signStripeSignatureHeader(SECRET, { timestamp: TS, payload: PAYLOAD });
    const now = TS + DEFAULT_STRIPE_TOLERANCE_SECONDS + 1;
    expect(() => verifyStripeSignature(SECRET, header, PAYLOAD, { now })).toThrow(/too old/);
  });

  it("rejects a timestamp newer than the tolerance window", () => {
    const header = signStripeSignatureHeader(SECRET, { timestamp: TS, payload: PAYLOAD });
    const now = TS - DEFAULT_STRIPE_TOLERANCE_SECONDS - 1;
    expect(() => verifyStripeSignature(SECRET, header, PAYLOAD, { now })).toThrow(/too new/);
  });

  it("accepts within a custom tolerance and rejects just outside it", () => {
    const header = signStripeSignatureHeader(SECRET, { timestamp: TS, payload: PAYLOAD });
    expect(() =>
      verifyStripeSignature(SECRET, header, PAYLOAD, { now: TS + 10, toleranceInSeconds: 10 }),
    ).not.toThrow();
    expect(() =>
      verifyStripeSignature(SECRET, header, PAYLOAD, { now: TS + 11, toleranceInSeconds: 10 }),
    ).toThrow(/too old/);
  });

  it("accepts when any one of multiple v1 tokens matches (secret roll)", () => {
    const good = createHmac("sha256", SECRET).update(`${TS}.${PAYLOAD}`, "utf8").digest("hex");
    const header = `t=${TS},v1=${"0".repeat(64)},v1=${good}`;
    expect(() => verifyStripeSignature(SECRET, header, PAYLOAD, { now: TS })).not.toThrow();
  });
});
