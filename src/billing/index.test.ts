import { describe, expect, it } from "vitest";
import { createBillingProvider } from "./index.js";
import { NoopBillingProvider } from "./billing-provider.js";
import { StripeBillingProvider } from "./stripe-billing-provider.js";
import type { Transport } from "../worker/delivery-worker.js";

describe("createBillingProvider", () => {
  const dummyTransport: Transport = async () => {
    return { status: 200, headers: new Headers(), bodyText: "" };
  };

  it("returns NoopBillingProvider when provider is none", () => {
    const config = {
      provider: "none" as const,
      stripeSecretKey: null,
      stripeWebhookSecret: null,
      stripeMeterEventName: "test_meter",
      stripeWebhookToleranceSeconds: 300,
    };

    const provider = createBillingProvider(config, { transport: dummyTransport });

    expect(provider).toBeInstanceOf(NoopBillingProvider);
    expect(provider.name).toBe("noop");
  });

  it("returns StripeBillingProvider when provider is stripe", () => {
    const config = {
      provider: "stripe" as const,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_123",
      stripeMeterEventName: "test_meter",
      stripeWebhookToleranceSeconds: 300,
    };

    const provider = createBillingProvider(config, { transport: dummyTransport });

    expect(provider).toBeInstanceOf(StripeBillingProvider);
    expect(provider.name).toBe("stripe");
    // Verify it picks up the webhook secret config
    expect(provider.webhookConfigured).toBe(true);
  });
});
