# Status

## Shipped this week

The product scaffold, SQLite storage foundation, health/readiness HTTP server, Standard Webhooks utilities, tenant endpoint CRUD, endpoint signing secret rotation, endpoint delivery history/stats, message intake, idempotent retries, crash-safe delivery worker, per-attempt audit log, admin tenant/API-key provisioning, usage metering/quota enforcement, batch message intake, OpenAPI contract, TypeScript SDK/CLI, Prometheus metrics, Docker deployment reference, event type catalog, endpoint test-send, portal sessions, and browser dashboards are complete. Posthorn now has the core path for accepting, signing, rotating, retrying, recording, provisioning, metering, batching, documenting, operating, and debugging webhook delivery flows.

## Ready for your QA

F-0020 is ready in PR #49. It adds endpoint delivery history and endpoint health stats without exposing payloads or secret-bearing endpoint fields.

## In progress

Nothing else is active.

## Blocked / needs you

Nothing needs you right now.

## Health

✅ Automated checks passed on PR #49. The latest local product checks passed with 135 tests.
