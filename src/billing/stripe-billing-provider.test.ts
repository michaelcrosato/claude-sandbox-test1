import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRIPE_API_BASE_URL,
  StripeBillingError,
  StripeBillingProvider,
} from "./stripe-billing-provider.js";
import { StripeSignatureError, signStripeSignatureHeader } from "./stripe-signature.js";
import type { UsageReport } from "./billing-provider.js";
import type {
  HttpDeliveryRequest,
  HttpDeliveryResponse,
  Transport,
} from "../worker/delivery-worker.js";

const WEBHOOK_SECRET = "whsec_test_0123456789abcdef0123456789abcdef";

const REPORT: UsageReport = {
  appId: "app_123",
  customerId: "cus_456",
  quantity: 42,
  periodStart: 1_700_000_000_000,
  periodEnd: 1_702_592_000_000,
  timestamp: 1_702_592_000_000,
};

/** A recording fake {@link Transport}: captures each request and returns a scripted result. */
function recordingTransport(
  respond: (req: HttpDeliveryRequest) => HttpDeliveryResponse | Promise<HttpDeliveryResponse>,
): { transport: Transport; calls: { req: HttpDeliveryRequest; signal: AbortSignal }[] } {
  const calls: { req: HttpDeliveryRequest; signal: AbortSignal }[] = [];
  const transport: Transport = async (req, signal) => {
    calls.push({ req, signal });
    return respond(req);
  };
  return { transport, calls };
}

function provider(transport: Transport, opts?: { webhookSecret?: string | null; apiBaseUrl?: string }) {
  return new StripeBillingProvider({
    secretKey: "sk_test_secret",
    // Only an absent key defaults; an explicit null/"" must pass through (??: would
    // collapse null back to the default, masking the unconfigured-secret cases).
    webhookSecret: opts?.webhookSecret === undefined ? WEBHOOK_SECRET : opts.webhookSecret,
    meterEventName: "posthorn_messages",
    transport,
    ...(opts?.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
  });
}

describe("StripeBillingProvider — identity", () => {
  it('reports name "stripe"', () => {
    const { transport } = recordingTransport(() => ({ status: 200 }));
    expect(provider(transport).name).toBe("stripe");
  });

  it("is webhookConfigured only when a non-empty webhook secret is set", () => {
    const { transport } = recordingTransport(() => ({ status: 200 }));
    expect(provider(transport, { webhookSecret: WEBHOOK_SECRET }).webhookConfigured).toBe(true);
    expect(provider(transport, { webhookSecret: null }).webhookConfigured).toBe(false);
    expect(provider(transport, { webhookSecret: "" }).webhookConfigured).toBe(false);
  });
});

describe("StripeBillingProvider.reportUsage", () => {
  it("POSTs a form-encoded meter event to the Stripe Meter Events endpoint", async () => {
    const { transport, calls } = recordingTransport(() => ({ status: 200 }));
    await provider(transport).reportUsage(REPORT);

    expect(calls).toHaveLength(1);
    const { req } = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${DEFAULT_STRIPE_API_BASE_URL}/v1/billing/meter_events`);
    expect(req.headers["authorization"]).toBe("Bearer sk_test_secret");
    expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    // Idempotent over (tenant, period) so a re-pushed closed period never double-charges.
    expect(req.headers["idempotency-key"]).toBe(
      `posthorn-usage-${REPORT.appId}-${REPORT.periodStart}-${REPORT.periodEnd}`,
    );

    const form = new URLSearchParams(req.body);
    expect(form.get("event_name")).toBe("posthorn_messages");
    // epoch ms → unix seconds.
    expect(form.get("timestamp")).toBe(String(Math.floor(REPORT.timestamp / 1000)));
    expect(form.get("identifier")).toBe(REPORT.appId);
    expect(form.get("payload[stripe_customer_id]")).toBe(REPORT.customerId);
    expect(form.get("payload[value]")).toBe(String(REPORT.quantity));
  });

  it("accepts any 2xx as success", async () => {
    const { transport } = recordingTransport(() => ({ status: 202 }));
    await expect(provider(transport).reportUsage(REPORT)).resolves.toBeUndefined();
  });

  it("throws StripeBillingError carrying the status on a non-2xx response", async () => {
    const { transport } = recordingTransport(() => ({ status: 401 }));
    await expect(provider(transport).reportUsage(REPORT)).rejects.toMatchObject({
      name: "StripeBillingError",
      status: 401,
    });
  });

  it("wraps a transport-level failure as a StripeBillingError with null status", async () => {
    const transport: Transport = async () => {
      throw new Error("connection refused");
    };
    const err = await provider(transport)
      .reportUsage(REPORT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeBillingError);
    expect((err as StripeBillingError).status).toBeNull();
  });

  it("strips a trailing slash from a custom apiBaseUrl", async () => {
    const { transport, calls } = recordingTransport(() => ({ status: 200 }));
    await provider(transport, { apiBaseUrl: "https://mock.test/" }).reportUsage(REPORT);
    expect(calls[0]!.req.url).toBe("https://mock.test/v1/billing/meter_events");
  });

  it("passes an AbortSignal so the attempt is time-bounded", async () => {
    const { transport, calls } = recordingTransport(() => ({ status: 200 }));
    await provider(transport).reportUsage(REPORT);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("StripeBillingProvider.handleWebhook", () => {
  const NOW_MS = 1_702_592_000_000;
  const NOW_S = Math.floor(NOW_MS / 1000);
  const noopTransport: Transport = async (): Promise<HttpDeliveryResponse> => ({ status: 200 });

  function signedHeaders(payload: string, secret = WEBHOOK_SECRET) {
    return { "stripe-signature": signStripeSignatureHeader(secret, { timestamp: NOW_S, payload }) };
  }

  it("verifies the signature and reports a recognized event as handled", async () => {
    const body = '{"id":"evt_1","type":"invoice.paid"}';
    const result = await provider(noopTransport).handleWebhook(body, signedHeaders(body), NOW_MS);
    expect(result).toEqual({ handled: true, type: "invoice.paid" });
  });

  it("returns handled:false for a verified event with no string type", async () => {
    const body = '{"id":"evt_2"}';
    const result = await provider(noopTransport).handleWebhook(body, signedHeaders(body), NOW_MS);
    expect(result).toEqual({ handled: false, type: null });
  });

  it("returns handled:false for a verified-but-unparseable body", async () => {
    const body = "not json";
    const result = await provider(noopTransport).handleWebhook(body, signedHeaders(body), NOW_MS);
    expect(result).toEqual({ handled: false, type: null });
  });

  it("throws StripeSignatureError when the signature does not match the body", async () => {
    const body = '{"type":"invoice.paid"}';
    const headers = signedHeaders(body);
    await expect(
      provider(noopTransport).handleWebhook(body + " ", headers, NOW_MS),
    ).rejects.toBeInstanceOf(StripeSignatureError);
  });

  it("throws StripeSignatureError when the Stripe-Signature header is absent", async () => {
    await expect(
      provider(noopTransport).handleWebhook("{}", {}, NOW_MS),
    ).rejects.toBeInstanceOf(StripeSignatureError);
  });

  it("throws (defensively) when no webhook secret is configured", async () => {
    const body = '{"type":"invoice.paid"}';
    await expect(
      provider(noopTransport, { webhookSecret: null }).handleWebhook(body, signedHeaders(body), NOW_MS),
    ).rejects.toThrow(/not configured/);
  });
});
