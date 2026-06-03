import { describe, expect, it } from "vitest";
import { createBillingProvider } from "./index.js";
import { NoopBillingProvider } from "./billing-provider.js";
import { StripeBillingProvider } from "./stripe-billing-provider.js";
import type { Transport } from "../worker/delivery-worker.js";

const dummyTransport: Transport = async () => ({ status: 200 });

describe("createBillingProvider", () => {
  it("returns NoopBillingProvider when provider is 'none'", () => {
    const provider = createBillingProvider(
      {
        provider: "none",
        stripeSecretKey: null,
        stripeWebhookSecret: null,
        stripeMeterEventName: "",
        stripeWebhookToleranceSeconds: 300,
      },
      { transport: dummyTransport }
    );
    expect(provider).toBeInstanceOf(NoopBillingProvider);
    expect(provider.name).toBe("noop");
  });

  it("returns StripeBillingProvider when provider is 'stripe'", () => {
    const provider = createBillingProvider(
      {
        provider: "stripe",
        stripeSecretKey: "sk_test_123",
        stripeWebhookSecret: "whsec_test_123",
        stripeMeterEventName: "meter_event",
        stripeWebhookToleranceSeconds: 300,
      },
      { transport: dummyTransport }
    );
    expect(provider).toBeInstanceOf(StripeBillingProvider);
    expect(provider.name).toBe("stripe");
  });

  it("returns StripeBillingProvider with empty string secret key when it is null", () => {
    const provider = createBillingProvider(
      {
        provider: "stripe",
        stripeSecretKey: null,
        stripeWebhookSecret: null,
        stripeMeterEventName: "meter_event",
        stripeWebhookToleranceSeconds: 300,
      },
      { transport: dummyTransport }
    );
    expect(provider).toBeInstanceOf(StripeBillingProvider);
    expect(provider.name).toBe("stripe");
  });
});
