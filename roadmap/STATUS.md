# Status

## Shipped this week

The product scaffold, SQLite storage foundation, health/readiness HTTP server, Standard Webhooks utilities, tenant endpoint CRUD, endpoint signing secret rotation, endpoint delivery history/stats, app-wide delivery listing, message intake, idempotent retries, crash-safe delivery worker, per-attempt audit log, admin tenant/API-key provisioning, usage metering/quota enforcement, batch message intake, OpenAPI contract, TypeScript SDK/CLI, Prometheus metrics, Docker deployment reference, event type catalog, endpoint test-send, portal sessions, and browser dashboards are complete. Posthorn now has the core path for accepting, signing, rotating, retrying, recording, provisioning, metering, batching, documenting, operating, and debugging webhook delivery flows.

## Ready for your QA

F-0021 is ready in PR #50. It adds app-wide delivery listing and filters without exposing payloads, endpoint URLs, headers, API keys, signing secrets, protected secret metadata, request bodies, or response bodies.

## In progress

Nothing else is active.

## Blocked / needs you

Nothing needs you right now.

## Health

✅ Automated checks passed on PR #50. The latest local product checks passed with 138 tests.
