## What this does
Posthorn now automatically attempts to bind to the next available port (up to 100 ports higher) if the configured port is already in use, unless configured to port 0 or an invalid port. Additionally, the admin and tenant dashboard user interfaces are fixed to clear stale metrics, message details, and key tables when credentials are disconnected or reconnected, and to reload message status details upon hitting refresh.

## How to see it
1. Open the Admin dashboard at `/dashboard` and click submit on the connection form. The previous key lists and usage statistics are cleared instantly rather than lingering.
2. Open the Tenant dashboard at `/dashboard/tenant`, select a message to inspect its payload, then change the tenant API key or submit the connection form. The message details, deliveries, attempts, and payload views are cleared.
3. Click the refresh button on the Tenant dashboard with a message selected. The deliveries and attempts details are refreshed along with the message history.

## What could be risky
Minimal risk because fallback only triggers when the port is already in use (`EADDRINUSE`), and UI changes only affect client-side state cleanup.

## Machine checks
- [x] `bash scripts/verify.sh` green (189 tests passing, all lint and shellcheck gate stages passed)
- [x] Fresh-context evaluator: PASS
- [x] Security review: skipped per sensitivity rule (logged in DECISIONS.md)
- [x] State updated via `update-state.ts` only

<details><summary>Technical notes (optional reading)</summary>

- Catch `EADDRINUSE` in `src/gateway.ts` inside `startGateway()` and retry binding by incrementing the port up to `basePort + 100`.
- Fix css `.mono` white-space style in `src/dashboard.ts` using `white-space: pre-wrap`.
- Fix client-side js in `src/dashboard.ts` to clear stale data in `loadUsage`, `clearSelectedMessage`, and `clearSelectedTenantView`.
- Add visual verification assets snapshot script `scripts/generate-visual-snapshots.ts` and generated assets in `roadmap/evidence/frontend-visuals/`.

</details>
