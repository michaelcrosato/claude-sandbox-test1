# Status

## Shipped this week

The product scaffold, SQLite storage foundation, health/readiness HTTP server, Standard Webhooks utilities, tenant endpoint CRUD, endpoint signing secret rotation, admin app system secret rotation, endpoint delivery throttling, endpoint payload formats, endpoint delivery history/stats, app-wide delivery listing, filtered message history, message intake, idempotent retries, crash-safe delivery worker, automatic endpoint disabling, per-attempt audit log, admin tenant/API-key provisioning, usage metering/quota enforcement, batch message intake, OpenAPI contract, expanded TypeScript SDK/CLI, admin CLI, Python SDK, TypeScript admin SDK, Prometheus metrics, monitoring dashboard and alerting artifacts, Docker deployment reference, Helm chart reference, code-verified parity matrix, event type catalog, endpoint test-send, portal sessions, and browser dashboards are complete. Posthorn now has the core path for accepting, signing, shaping, throttling, rotating, retrying, recording, provisioning, metering, batching, documenting, comparing, operating, deploying, and debugging webhook delivery flows.

## Ready for your QA

F-0033 is ready in PR #62. It adds endpoint payload formats so receivers can choose Posthorn's default envelope or the original JSON payload body.

## In progress

Nothing else is active.

## Blocked / needs you

Nothing needs you right now.

## Health

The latest local product checks passed with 177 tests. GitHub CI for PR #62 is pending.
