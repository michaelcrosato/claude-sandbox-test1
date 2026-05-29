# SPEC-H3 — Live Stripe billing enablement (HUMAN-GATED)

- **Owner:** human · **Phase:** D · **Status:** not started
- **EXCLUSION:** a live Stripe account + live API keys are credential-gated.

## Description

Billing is fully built **behind flags**: a `BillingProvider` interface, a default
`NoopBillingProvider`, a `StripeBillingProvider` over an **injected** transport (tested against a
mock), metered usage push, and a `POST /v1/billing/webhook` verified with the same HMAC discipline as
the signer — with the verification tolerance now configurable (OPP-13 / `1c91e7b`). What remains is
**turning it on with real keys**, which is human-only.

## Acceptance criteria

- With flags off (default), `/v1/billing/*` behaves as today (Noop) and tests stay green.
- With a human's live keys + flags on: a real Stripe-signed webhook verifies; metered usage appears
  in the Stripe dashboard. (Validated by the human against a Stripe test-mode account first.)

## Implementation approach

1. **Agent:** keep the flag-gated provider + mock-transport tests green; ensure every billing
   `POSTHORN_*` var is documented in `.env.example` + `docs/DEPLOY.md` (config.test enforces).
2. **Human:** create the Stripe account, set test-mode keys, enable the flags, run the booted-gateway
   webhook round-trip, then promote to live keys.

## Deps / prereqs

Stripe account + keys + webhook secret (human). Pricing/metering unit decision (SPEC-H5 Q3).

## Test strategy

Existing mock-transport unit/integration tests; a human-run test-mode webhook round-trip; the
configurable-tolerance path.

## Out of scope

Real Stripe keys; enabling live billing; changing the billing interface or default (stays Noop).
