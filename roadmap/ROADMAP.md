# Roadmap

> **Operator: this is your file.** Plain-English bullets; reorder to change priorities. Agents only ever mark items "✅ shipped (PR #n)" — they never rewrite your words. Sections mean: **Now** = working on it, **Next** = queued, **Later** = someday, **Ideas** = unscoped thoughts.

## Now

- Stand up the Node.js/TypeScript skeleton: project structure, build pipeline (tsc), test harness (vitest), and a passing `bash scripts/verify.sh` — the "empty but healthy" baseline every feature builds on top of.
- Health and readiness endpoints (`GET /healthz` and `GET /readyz`) — the first real API surface; confirms the HTTP server, SQLite store wiring, and Docker container all work together.
- Core webhook intake: `POST /v1/messages` accepts an event and fans it out to registered endpoints with HMAC-SHA256 signing (`whsec_` secrets, Standard Webhooks spec) — the single most important thing Posthorn does.

## Next

- Endpoint management CRUD (`GET/POST /v1/endpoints`, `GET/PATCH/DELETE /v1/endpoints/:id`) — lets tenants register and manage their webhook destinations.
- Delivery worker: exponential-backoff retry queue (8 attempts over ~28h), lease-based at-least-once delivery, no Redis — backed entirely by the built-in SQLite store.
- Idempotent intake: deduplicate on producer-supplied `idempotencyKey` so retried sends never double-fan-out.
- Per-attempt audit log (`GET /v1/messages/:id/attempts`) — the data you actually debug a flaky receiver from.
- Admin API: tenant provisioning, API-key mint/revoke, quota enforcement (`POST /v1/admin/apps`, `GET/PATCH/DELETE /v1/admin/apps/:id`, key routes) — disabled when `POSTHORN_ADMIN_TOKEN` is unset.

## Later

- Zero-downtime secret rotation (`POST /v1/endpoints/:id/rotate-secret`) with configurable overlap window.
- Auto-disable dead endpoints after a configurable failure window; endpoint stats and delivery history routes.
- Usage metering and quota enforcement (`GET /v1/usage`, `429` on breach, monthly auto-reset).
- Batch intake (`POST /v1/messages/batch`, up to 100 events, per-item results).
- Consumer portal session minting (`POST /v1/portal/sessions`) and event-type catalog (`/v1/event-types`).
- OpenAPI 3.1 contract (`GET /openapi.json`) — machine-readable spec for client codegen.
- TypeScript SDK (`PosthornClient`) and Python SDK (`clients/python`) — both tested against the live `/openapi.json` so they cannot drift.
- ✅ shipped (PR #57) CLI clients (`posthorn client` and `posthorn admin`) — no-code equivalents for shell/CI use.
- ✅ shipped (PR #58) Prometheus metrics endpoint (`GET /metrics`) and Grafana dashboard / alerting rules.
- Browser dashboard (`/dashboard`) for admin panel and tenant panel (message history, delivery statuses, audit log).
- Helm chart, Docker Compose production reference, and PostgreSQL backend for scale-out.

## Ideas

- The v1.0-complete implementation is preserved in this repo's git history at the tag `pre-purge-20260609`. It is available as a reference quarry — read patterns, tests, or design decisions from it — but must never be bulk-restored. Mine it surgically when building a specific feature.
