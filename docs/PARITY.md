# Posthorn Parity Matrix

This is a source-backed comparison of Posthorn against adjacent webhook products as of
2026-06-12. Posthorn rows are checked against this repository's implemented code, tests, and
operator docs; competitor rows are based on the official sources linked below.

Legend: **Implemented** means the current Posthorn checkout has code, tests, and docs for the
capability, or that a competitor's official source clearly describes the capability. **Partial**
means the current product covers the core path but not the full breadth shown by one or more
comparable products. **Not yet** means the capability is a codeable product gap. **Not verified**
means the selected official sources for that vendor do not support a stronger claim. **Out of
scope** means the capability belongs to another product category or a human-only commercial
release task.

## Matrix

| Capability | Posthorn | Svix | Convoy | Hookdeck | Stripe |
| --- | --- | --- | --- | --- | --- |
| Outbound webhook delivery | Implemented | Implemented | Implemented | Implemented | Implemented |
| Durable retry queue / at-least-once delivery | Implemented | Implemented | Implemented | Implemented | Implemented |
| Message intake idempotency | Implemented | Not verified | Not verified | Not verified | Implemented |
| Endpoint CRUD and event filtering | Implemented | Implemented | Implemented | Implemented | Implemented |
| Endpoint signing secrets and rotation | Implemented | Not verified | Partial | Partial | Implemented |
| Manual retry / replay | Implemented | Implemented | Implemented | Implemented | Implemented |
| Per-attempt logs and delivery search | Implemented | Implemented | Implemented | Implemented | Implemented |
| Event type catalog | Implemented | Implemented | Not verified | Partial | Implemented |
| Customer or tenant portal | Implemented | Implemented | Implemented | Partial | Partial |
| Endpoint test-send | Implemented | Not verified | Partial | Not verified | Implemented |
| Endpoint delivery throttling / rate limiting | Implemented | Implemented | Implemented | Implemented | Not verified |
| Metrics, alerts, and operator artifacts | Implemented | Partial | Partial | Implemented | Partial |
| Self-hosted single-container mode | Implemented | Not verified | Partial | Not verified | Out of scope |
| Kubernetes reference | Implemented | Not verified | Not verified | Not verified | Out of scope |
| PostgreSQL/HA scale-out | Not yet | Not verified | Not verified | Not verified | Out of scope |
| Payload transformations | Partial | Implemented | Not verified | Implemented | Out of scope |
| Deduplication rules beyond intake idempotency | Not yet | Not verified | Not verified | Implemented | Partial |
| Non-webhook destination connectors | Not yet | Not verified | Not verified | Implemented | Implemented |

## Posthorn Evidence

The Posthorn column is intentionally narrower than a marketing checklist. It counts a capability
only when this checkout has product code plus a guard test or source-backed operator doc.

- Single-container SQLite and no Redis runtime path: `README.md`, `Dockerfile`,
  `docker-compose.yml`, and `tests/deployment-artifacts.test.ts`.
- Standard Webhooks signing and verification: `README.md` and `tests/webhooks.test.ts`.
- Endpoint management, one-time endpoint secrets, endpoint secret rotation, and admin provisioning:
  `README.md`, `tests/endpoints-http.test.ts`, and `tests/admin-http.test.ts`.
- Message intake, batch intake, producer idempotency, endpoint payload-only delivery, retry
  delivery, dead-lettering, and manual retry: `README.md`, `tests/messages-http.test.ts`,
  and `tests/worker.test.ts`.
- Delivery auditability: `tests/deliveries-http.test.ts`,
  `tests/endpoint-observability-http.test.ts`, `tests/messages-http.test.ts`, and
  `tests/openapi-contract.test.ts`.
- Event type catalog, endpoint test-send, and portal sessions:
  `tests/event-types-http.test.ts`, `tests/endpoint-test-http.test.ts`, and
  `tests/portal-sessions-http.test.ts`.
- Metrics, alerting, Grafana dashboard, Docker, and Helm references: `docs/DEPLOY.md`,
  `tests/monitoring-artifacts.test.ts`, `tests/deployment-artifacts.test.ts`, and
  `tests/helm-chart.test.ts`.

## Posthorn Gaps

These are the codeable gaps this matrix exposes. They are product work, not release operations.

- **PostgreSQL/HA scale-out**: Posthorn has a deliberately simple single-pod SQLite deployment
  model today. A PostgreSQL-backed store and safe multi-worker deployment model are the next
  scale-out step.
- **Arbitrary payload transformations**: Posthorn can send either its default delivery envelope
  or the original JSON payload body per endpoint. It does not yet offer arbitrary body templates,
  method changes, URL rewriting, header mutation rules, or routing-data transformations.
- **Deduplication rules beyond intake idempotency**: Posthorn deduplicates producer retries with an
  idempotency key, but it does not yet offer configurable field/window deduplication rules.
- **Non-webhook destination connectors**: Posthorn targets HTTP webhooks. Queue, stream, storage,
  and event-bus destinations are not implemented.

## Not Counted As Code Gaps

Hosted billing, public domains, production credentials, package publishing, trademark work, and
live demo operations are human-only release tasks. They are not counted as product parity gaps in
this repository.

## Sources

Posthorn:

- README and tests in this repository.
- `docs/DEPLOY.md`, `docs/prometheus-alerts.yml`, and `docs/grafana-dashboard.json`.

Svix:

- https://docs.svix.com/quickstart
- https://docs.svix.com/retries
- https://docs.svix.com/throttling
- https://docs.svix.com/app-portal
- https://docs.svix.com/event-types
- https://docs.svix.com/transformations

Convoy:

- https://www.getconvoy.io/
- https://www.getconvoy.io/product-manual/endpoints
- https://www.getconvoy.io/product-manual/webhooks-documentation
- https://www.getconvoy.io/product-manual/portal-links
- https://github.com/frain-dev/convoy

Hookdeck:

- https://hookdeck.com/docs/hookdeck-basics
- https://hookdeck.com/docs/connections
- https://hookdeck.com/docs/retries
- https://hookdeck.com/docs/use-cases/receive-webhooks
- https://hookdeck.com/docs/outpost/concepts

Stripe:

- https://docs.stripe.com/webhooks
- https://docs.stripe.com/workbench/event-destinations
- https://docs.stripe.com/api/webhook_endpoints/object
- https://docs.stripe.com/api/idempotent_requests
