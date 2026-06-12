# Status

## Shipped this week

The product scaffold, SQLite storage foundation, health/readiness HTTP server, Standard Webhooks utilities, tenant endpoint CRUD, endpoint signing secret rotation, endpoint delivery history/stats, app-wide delivery listing, message intake, idempotent retries, crash-safe delivery worker, per-attempt audit log, admin tenant/API-key provisioning, usage metering/quota enforcement, batch message intake, OpenAPI contract, TypeScript SDK/CLI, Python SDK, Prometheus metrics, Docker deployment reference, event type catalog, endpoint test-send, portal sessions, and browser dashboards are complete. Posthorn now has the core path for accepting, signing, rotating, retrying, recording, provisioning, metering, batching, documenting, operating, and debugging webhook delivery flows.

## Ready for your QA

F-0022 is ready in PR #51. It adds a dependency-free Python SDK for producer calls and receiver signature verification, with API redirects blocked so bearer tokens are not forwarded to redirected hosts.

## In progress

Nothing else is active.

## Blocked / needs you

Nothing needs you right now.

## Health

✅ Automated checks passed on PR #51. The latest local product checks passed with 141 tests.
