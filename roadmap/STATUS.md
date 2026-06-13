# Status

## Shipped this week

The product scaffold, SQLite storage foundation, health/readiness HTTP server, Standard Webhooks utilities, tenant endpoint CRUD, endpoint signing secret rotation, admin app system secret rotation, endpoint delivery throttling, endpoint delivery methods, endpoint payload formats including CloudEvents JSON, message deduplication windows, endpoint delivery history/stats, app-wide delivery listing, filtered message history, message intake, idempotent retries, crash-safe delivery worker, automatic endpoint disabling, per-attempt audit log, admin tenant/API-key provisioning, usage metering/quota enforcement, batch message intake, OpenAPI contract, expanded TypeScript SDK/CLI, admin CLI, Python SDK, TypeScript admin SDK, Prometheus metrics, monitoring dashboard and alerting artifacts, Docker deployment reference, Helm chart reference, code-verified parity matrix, event type catalog, endpoint test-send, portal sessions, and browser dashboards are complete. Posthorn now has the core path for accepting, signing, deduplicating, shaping, throttling, rotating, retrying, recording, provisioning, metering, batching, documenting, comparing, operating, deploying, and debugging webhook delivery flows.

The agent operations system also got a maintenance cleanup: the root getting-started docs now point at the current operating flow, and the automated checks can handle Windows Bash shells that expose Node as `node.exe`.

## Ready for your QA

Nothing yet.

## In progress

Nothing else is active.

## Blocked / needs you

Nothing needs you right now.

## Health

Automated checks are passing locally and on the latest completed pull request. The latest local product checks passed with 188 tests. No new automation-cost issue is recorded.
