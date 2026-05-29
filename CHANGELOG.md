## Changelog

All notable changes to Posthorn are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Corrected the declared Node.js engine range to `>=22.13.0` (was `>=20`). The default SQLite
  datastore uses `node:sqlite`, which is flag-free only from Node 22.13, so the previous range
  advertised Node versions the default mode cannot run on.

## [1.0.0] - 2026-05-28

First public release. Posthorn is open-core, Standard Webhooks-compliant, reliable
outbound webhook-delivery infrastructure that runs as a single container with embedded
SQLite and no Redis or message broker.

### Added

#### Delivery core
- Standard Webhooks-compliant HMAC payload signing and a receiver-side verification helper.
- Durable at-least-once delivery: crash-safe SQLite message store, lease-based delivery
  queue with crash replay, and a transactional outbox so accept -> fan-out survives a crash.
- Delivery worker with bounded concurrency and a retry/backoff state machine; honors
  receiver `Retry-After`, supports non-retryable status codes and per-endpoint retry-policy overrides.
- Scheduled delivery (`sendAt`/`deliverAt`), message expiry (`expiresAt`), and message
  priority (high/normal/low) ordering.
- Manual retry/replay, app-wide and per-endpoint bulk retry, delivery cancellation, and
  endpoint message replay.
- Dead-letter handling with a `message.dead_lettered` system event.

#### Endpoints and fan-out
- Endpoint store and store-backed resolver; an event fans out to a tenant's subscribers.
- Custom delivery headers, payload filters (a small DSL), and channel-based routing.
- Zero-downtime endpoint secret rotation; endpoint health tracking with auto-disable and
  an `endpoint.disabled` system event.
- Per-endpoint delivery rate limiting and per-endpoint delivery statistics.

#### HTTP API and contracts
- HTTP API on `node:http` exposing the `/v1` surface (messages, deliveries, endpoints,
  event-types, usage).
- OpenAPI 3.1 contract at `GET /openapi.json`, guarded by bidirectional drift and
  orphan-schema tests; a closed, drift-guarded error-code enum.
- Message and delivery listing with `eventType`, `status`, and `failureReason` filters and
  keyset pagination.
- Per-attempt delivery audit log with request/response body capture and structured failure reasons.
- Event-type catalog (CRUD), test-event delivery, and batch message sending.

#### Multi-tenancy and control plane
- App/tenant entity with API-key authentication and per-key `lastUsedAt` activity tracking.
- Opt-in, token-gated admin/control-plane HTTP provisioning API and a typed admin SDK.
- Exact per-tenant usage metering (accepted messages and delivery operations), real-time
  monthly quota enforcement (HTTP 429 at the ceiling), and tenant self-service usage at `GET /v1/usage`.

#### SDKs, CLI, and UIs
- TypeScript/JavaScript SDK (typed client plus receiver verification) and an admin SDK over
  a shared, no-drift transport.
- `posthorn` admin CLI for bootstrapping a deployed gateway without code.
- Admin dashboard, tenant dashboard, and a consumer app portal (token-exchange) with a
  webhook signature-verification widget and delivery detail + manual retry.

#### Deployment, storage, and observability
- Single-container Dockerfile (the "no Redis" wedge), Docker Compose, and a GitHub Actions CI workflow.
- SQLite default with a 5s `busy_timeout`; optional PostgreSQL backend for all stores with
  active/active multi-replica support, a tunable pool, crash-safe pool recovery, and pool metrics.
- Prometheus `/metrics`, structured JSON logging with instance/version stamping, `/healthz`
  and `/readyz` probes, configurable HTTP socket timeouts, and a connect-vs-total delivery timeout split.
- Automatic data retention/pruning via `POSTHORN_RETENTION_DAYS`.
- Per-reason delivery-failure metrics and a point-in-time dead-letter backlog gauge by failure reason.

### Security
- SSRF guard blocking endpoint URLs that resolve to private/internal addresses, including
  IPv6 hex and NAT64 embedded-IPv4 bypasses, with a connection-time guard and a two-layer
  guard on tenant system-webhook URLs.
- Eliminated reflected XSS in the portal create-error path and made destructive-action
  confirmations CSP-safe.
- Per-surface defense-in-depth response headers, `no-store` cache-control on authenticated
  dashboard/portal HTML, and configurable HSTS emitted only on HTTPS-identified requests.

[Unreleased]: https://github.com/michaelcrosato/claude-sandbox-test1/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/michaelcrosato/claude-sandbox-test1/releases/tag/v1.0.0
