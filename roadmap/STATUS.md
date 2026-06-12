# Status

## Shipped this week

The product scaffold, SQLite storage foundation, health/readiness HTTP server, Standard Webhooks utilities, tenant endpoint CRUD, message intake, idempotent retries, and crash-safe delivery worker are merged. Posthorn now has the core path for accepting, signing, retrying, and recording webhook deliveries.

## Ready for your QA

F-0009 is ready in PR #38. It adds a bearer-authenticated message attempt audit endpoint so a tenant can inspect webhook send attempts, newest first, without seeing another tenant's data.

## In progress

Nothing else is active.

## Blocked / needs you

Nothing needs you right now.

## Health

✅ Automated checks passed on PR #38. The latest local product checks passed with 77 tests.
