/**
 * The Stripe {@link BillingProvider} — the one concrete payment backend, wired only
 * when an operator opts in via `POSTHORN_BILLING_PROVIDER=stripe`.
 *
 * It talks to Stripe over the **same injected {@link Transport}** the delivery worker
 * uses (the SSRF-guarded, no-redirect HTTP POST seam), so the whole surface is
 * exercised against a mock in tests — no live account, keys, or network. Two
 * directions, mirroring {@link BillingProvider}:
 *
 *  - **outbound** {@link StripeBillingProvider.reportUsage} form-encodes a
 *    {@link UsageReport} into a Stripe **Meter Events** call
 *    (`POST /v1/billing/meter_events`) and pushes it, keyed by the tenant `appId`
 *    for idempotency.
 *  - **inbound** {@link StripeBillingProvider.handleWebhook} verifies the
 *    `Stripe-Signature` header (see {@link verifyStripeSignature}) against the raw
 *    body, then parses the event and reports whether it was a recognized shape.
 *
 * Failure isolation (the {@link BillingProvider} contract): a non-2xx usage push or a
 * transport error throws a {@link StripeBillingError}, but the gateway's internal
 * caller treats a usage-report failure as best-effort — it never blocks or corrupts
 * message delivery.
 */

import type {
  BillingProvider,
  BillingWebhookResult,
  UsageReport,
} from "./billing-provider.js";
import {
  STRIPE_SIGNATURE_HEADER,
  verifyStripeSignature,
} from "./stripe-signature.js";
import type { Transport } from "../worker/delivery-worker.js";

/** Stripe's production API origin; overridable in tests to point at a mock. */
export const DEFAULT_STRIPE_API_BASE_URL = "https://api.stripe.com";

/** Default per-request timeout (ms) for the outbound usage push. */
export const DEFAULT_STRIPE_TIMEOUT_MS = 10_000;

/**
 * Thrown when the Stripe API rejects an outbound call (non-2xx) or the transport
 * fails. Distinct from a signature failure ({@link StripeSignatureError}), which is an
 * *inbound* verification problem mapped to a `400`.
 */
export class StripeBillingError extends Error {
  /** The HTTP status Stripe returned, or `null` for a transport-level failure. */
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "StripeBillingError";
    this.status = status;
  }
}

/** Construction options for {@link StripeBillingProvider}. */
export interface StripeBillingProviderOptions {
  /** Stripe secret API key (`sk_…`); sent as the bearer credential. */
  readonly secretKey: string;
  /**
   * Stripe webhook signing secret (`whsec_…`). When `null`/empty the inbound webhook
   * route stays `404` ({@link BillingProvider.webhookConfigured} is `false`).
   */
  readonly webhookSecret: string | null;
  /** The Stripe meter `event_name` a usage push is recorded under. */
  readonly meterEventName: string;
  /** The SSRF-guarded HTTP POST seam (shared with delivery); mocked in tests. */
  readonly transport: Transport;
  /** Stripe API origin. Defaults to {@link DEFAULT_STRIPE_API_BASE_URL}. */
  readonly apiBaseUrl?: string;
  /** Allowed signature clock skew (seconds); forwarded to {@link verifyStripeSignature}. */
  readonly toleranceInSeconds?: number;
  /** Per-request timeout (ms) for the usage push. Defaults to {@link DEFAULT_STRIPE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Form-encode a {@link UsageReport} into the body of a Stripe Meter Events call.
 * The meter event records `value` units against a customer at a Unix-seconds
 * timestamp; `identifier` is the tenant `appId` so a re-pushed period is idempotent
 * on Stripe's side.
 */
function encodeMeterEvent(eventName: string, report: UsageReport): string {
  const params = new URLSearchParams();
  params.set("event_name", eventName);
  params.set("timestamp", String(Math.floor(report.timestamp / 1000)));
  params.set("identifier", report.appId);
  params.set("payload[stripe_customer_id]", report.customerId);
  params.set("payload[value]", String(report.quantity));
  return params.toString();
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe";
  readonly webhookConfigured: boolean;

  readonly #secretKey: string;
  readonly #webhookSecret: string | null;
  readonly #meterEventName: string;
  readonly #transport: Transport;
  readonly #apiBaseUrl: string;
  readonly #toleranceInSeconds: number | undefined;
  readonly #timeoutMs: number;

  constructor(options: StripeBillingProviderOptions) {
    this.#secretKey = options.secretKey;
    this.#webhookSecret = options.webhookSecret;
    this.#meterEventName = options.meterEventName;
    this.#transport = options.transport;
    this.#apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_STRIPE_API_BASE_URL).replace(/\/+$/, "");
    this.#toleranceInSeconds = options.toleranceInSeconds;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_STRIPE_TIMEOUT_MS;
    this.webhookConfigured = options.webhookSecret != null && options.webhookSecret.length > 0;
  }

  async reportUsage(report: UsageReport): Promise<void> {
    const body = encodeMeterEvent(this.#meterEventName, report);
    const request = {
      url: `${this.#apiBaseUrl}/v1/billing/meter_events`,
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        // Idempotency over (tenant, period): a re-push of the same closed period is a
        // no-op on Stripe's side rather than a double charge.
        "idempotency-key": `posthorn-usage-${report.appId}-${report.periodStart}-${report.periodEnd}`,
      },
      body,
    } as const;

    // Bound the attempt with an AbortController + a timer cleared on settle (the same
    // per-attempt-timeout pattern the delivery worker and system-event transport use),
    // so a hung Stripe connection cannot pin the call open forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response;
    try {
      response = await this.#transport(request, controller.signal);
    } catch (err) {
      throw new StripeBillingError(
        `Stripe usage report transport failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new StripeBillingError(
        `Stripe usage report rejected with status ${response.status}`,
        response.status,
      );
    }
  }

  async handleWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
    nowMs: number,
  ): Promise<BillingWebhookResult> {
    if (this.#webhookSecret == null || this.#webhookSecret.length === 0) {
      // Defensive: the route is 404 when unconfigured, so this is unreachable in
      // practice — but never verify against an empty secret.
      throw new Error("stripe webhook secret is not configured");
    }
    // Throws StripeSignatureError on any verification failure; the route maps that to
    // a 400. The clock is injected (nowMs) for deterministic tests.
    verifyStripeSignature(this.#webhookSecret, headers[STRIPE_SIGNATURE_HEADER], rawBody, {
      now: Math.floor(nowMs / 1000),
      ...(this.#toleranceInSeconds !== undefined
        ? { toleranceInSeconds: this.#toleranceInSeconds }
        : {}),
    });

    // Signature verified: parse the event. A syntactically valid but unrecognized
    // event still returns 200 (handled:false) so Stripe stops retrying — only the
    // signature gate above is fatal.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { handled: false, type: null };
    }
    const type =
      typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string"
        ? (parsed as { type: string }).type
        : null;
    return { handled: type !== null, type };
  }
}
