/**
 * The billing seam — how Posthorn meters usage and reacts to a payment provider,
 * kept entirely behind a flag so the open-core gateway has zero payment dependency
 * by default.
 *
 * A {@link BillingProvider} abstracts the two directions a usage-based SaaS talks to
 * its payment processor:
 *
 *  - **outbound** {@link BillingProvider.reportUsage} pushes a tenant's metered
 *    message count (the {@link import("../storage/message-store.js").UsageSummary}
 *    read model) up to the processor, and
 *  - **inbound** {@link BillingProvider.handleWebhook} verifies and accepts a signed
 *    event from the processor (e.g. a subscription/payment state change).
 *
 * The default {@link NoopBillingProvider} does neither — it is what runs unless an
 * operator opts in via `POSTHORN_BILLING_PROVIDER`. A concrete provider (the Stripe
 * one) talks to its processor over an **injected HTTP transport**, so the whole
 * surface is exercised against a mock in tests without a live account or keys.
 *
 * Pure abstraction: this module has no I/O and no provider-specific code — the Stripe
 * implementation lives in `stripe-billing-provider.ts`.
 */

import type { UsageSummary } from "../storage/message-store.js";

/** The named billing backends. `none` (the default) wires {@link NoopBillingProvider}. */
export type BillingProviderKind = "none" | "stripe";

/**
 * The validated billing settings, a slice of the gateway config (read from
 * `POSTHORN_BILLING_*` / `POSTHORN_STRIPE_*` by `loadConfig`). When {@link provider}
 * is `none` the Stripe fields are inert. {@link createBillingProvider} turns this
 * into a live {@link BillingProvider}.
 */
export interface BillingConfig {
  /** Which backend to wire. `none` (default) = {@link NoopBillingProvider}. */
  readonly provider: BillingProviderKind;
  /** Stripe secret API key (`sk_…`). Required when {@link provider} is `stripe`. */
  readonly stripeSecretKey: string | null;
  /**
   * Stripe webhook signing secret (`whsec_…`). Optional even under the Stripe
   * provider: when unset, `reportUsage` still works but `POST /v1/billing/webhook`
   * stays `404` (the inbound surface is opt-in, like the admin API).
   */
  readonly stripeWebhookSecret: string | null;
  /** The Stripe meter `event_name` a usage push is recorded under. */
  readonly stripeMeterEventName: string;
}

/**
 * One tenant's metered usage to report to the billing processor — the shape derived
 * from a {@link UsageSummary} via {@link usageReportFromSummary}. Carries the
 * processor's customer reference (resolving `appId` → customer is an operator
 * concern, out of scope for the gateway) alongside the billable quantity and the
 * period it covers.
 */
export interface UsageReport {
  /** The Posthorn tenant the usage is for (traceability + the idempotency key). */
  readonly appId: string;
  /** The billing processor's customer identifier this usage is charged to. */
  readonly customerId: string;
  /** The billable message count over the period. */
  readonly quantity: number;
  /** Inclusive period start (epoch ms) — echoes the usage range's `fromMs`. */
  readonly periodStart: number;
  /** Exclusive period end (epoch ms) — echoes the usage range's `toMs`. */
  readonly periodEnd: number;
  /** When the report was generated (epoch ms); the processor's event timestamp. */
  readonly timestamp: number;
}

/** The outcome of accepting an inbound provider webhook. */
export interface BillingWebhookResult {
  /**
   * Whether the verified event was a well-formed, recognized event the provider
   * acted on. `false` for a syntactically valid but unrecognized event (still a
   * `200` to the processor so it stops retrying — only the signature gate is fatal).
   */
  readonly handled: boolean;
  /** The provider event `type` (e.g. `invoice.paid`), or `null` when absent. */
  readonly type: string | null;
}

/**
 * The pluggable billing backend. Implementations must keep both methods
 * **best-effort and side-effect-isolated**: a billing failure must never block or
 * corrupt message delivery (the gateway's reason for being).
 */
export interface BillingProvider {
  /** Stable backend label (`noop` | `stripe`), surfaced in logs/diagnostics. */
  readonly name: string;
  /**
   * Whether the inbound `POST /v1/billing/webhook` route is live. `false` hides it
   * behind a `404` (the same opt-in posture as the admin API): the route exists only
   * when a provider with a configured webhook secret is wired.
   */
  readonly webhookConfigured: boolean;
  /** Push a tenant's metered usage to the processor. */
  reportUsage(report: UsageReport): Promise<void>;
  /**
   * Verify and accept an inbound provider webhook. `rawBody` MUST be the exact bytes
   * received (signature verification re-hashes them); `headers` are the lowercased
   * request headers; `nowMs` is the verification clock (injected for deterministic
   * tests). Rejects (throws) only on a signature/verification failure — the route
   * maps that to `400`.
   */
  handleWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
    nowMs: number,
  ): Promise<BillingWebhookResult>;
}

/**
 * Build a {@link UsageReport} from a tenant's {@link UsageSummary} (the metering read
 * model `MessageStore.summarizeUsageByApp` returns) and the processor customer it
 * maps to. Pure: the billable quantity is the summary's `total`, and the period is
 * the summary's `[fromMs, toMs)` window. The report timestamp defaults to the period
 * end (when the period closed), overridable for a mid-period push.
 */
export function usageReportFromSummary(
  summary: UsageSummary,
  opts: { readonly customerId: string; readonly timestamp?: number },
): UsageReport {
  return {
    appId: summary.appId,
    customerId: opts.customerId,
    quantity: summary.total,
    periodStart: summary.fromMs,
    periodEnd: summary.toMs,
    timestamp: opts.timestamp ?? summary.toMs,
  };
}

/**
 * The default provider when billing is disabled (`POSTHORN_BILLING_PROVIDER=none`,
 * the default). `reportUsage` silently drops — so an internal caller can report usage
 * unconditionally without checking whether billing is on — and the webhook route is
 * hidden (`webhookConfigured` is `false`), so `handleWebhook` is never reached; it
 * throws if called directly, as a defensive backstop.
 */
export class NoopBillingProvider implements BillingProvider {
  readonly name = "noop";
  readonly webhookConfigured = false;

  async reportUsage(): Promise<void> {
    // Intentionally a no-op: billing is disabled.
  }

  async handleWebhook(): Promise<BillingWebhookResult> {
    throw new Error("billing webhook is not configured");
  }
}
