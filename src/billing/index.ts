/**
 * The billing module barrel — the single import surface for Posthorn's optional,
 * flag-gated payment seam.
 *
 * The gateway only ever calls {@link createBillingProvider}: it turns the validated
 * {@link BillingConfig} slice (built by `loadConfig` from `POSTHORN_BILLING_*` /
 * `POSTHORN_STRIPE_*`) into a live {@link BillingProvider}, defaulting to the
 * {@link NoopBillingProvider} when billing is off (`provider: "none"`, the default).
 * Everything provider-specific stays behind this factory, so the open-core gateway
 * has zero payment dependency unless an operator opts in.
 */

import {
  type BillingConfig,
  type BillingProvider,
  NoopBillingProvider,
} from "./billing-provider.js";
import { StripeBillingProvider } from "./stripe-billing-provider.js";
import type { Transport } from "../worker/delivery-worker.js";

export {
  type BillingConfig,
  type BillingProviderKind,
  type BillingProvider,
  type BillingWebhookResult,
  type UsageReport,
  NoopBillingProvider,
  usageReportFromSummary,
} from "./billing-provider.js";
export {
  DEFAULT_STRIPE_API_BASE_URL,
  DEFAULT_STRIPE_TIMEOUT_MS,
  StripeBillingError,
  StripeBillingProvider,
  type StripeBillingProviderOptions,
} from "./stripe-billing-provider.js";
export {
  DEFAULT_STRIPE_TOLERANCE_SECONDS,
  STRIPE_SIGNATURE_HEADER,
  StripeSignatureError,
  signStripeSignatureHeader,
  verifyStripeSignature,
  type StripeSignInput,
  type StripeVerifyOptions,
} from "./stripe-signature.js";

/** Dependencies {@link createBillingProvider} injects into a live provider. */
export interface BillingProviderDeps {
  /**
   * The SSRF-guarded HTTP POST seam (shared with delivery). The Stripe provider
   * POSTs meter events over it; the Noop provider ignores it.
   */
  readonly transport: Transport;
}

/**
 * Build the live {@link BillingProvider} for a validated {@link BillingConfig}.
 * `none` (the default) → {@link NoopBillingProvider}; `stripe` →
 * {@link StripeBillingProvider} over the injected transport. The Stripe secret key is
 * guaranteed present by config validation when `provider` is `stripe`; the webhook
 * secret stays optional (its absence keeps the inbound route `404`).
 */
export function createBillingProvider(
  config: BillingConfig,
  deps: BillingProviderDeps,
): BillingProvider {
  switch (config.provider) {
    case "stripe":
      return new StripeBillingProvider({
        secretKey: config.stripeSecretKey ?? "",
        webhookSecret: config.stripeWebhookSecret,
        meterEventName: config.stripeMeterEventName,
        toleranceInSeconds: config.stripeWebhookToleranceSeconds,
        transport: deps.transport,
      });
    case "none":
      return new NoopBillingProvider();
  }
}
