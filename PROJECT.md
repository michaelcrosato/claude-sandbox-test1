# Project: Posthorn Diagnostics and Fixing

## Architecture
Posthorn is a Node.js/TypeScript webhook intake, deduplication, and retry delivery system.
- **Server Startup / Configuration**: `src/config.ts` loads configurations, including the listening port. `src/server.ts` or `src/gateway.ts` initializes and starts the HTTP server.
- **Frontend / Dashboards**: `src/dashboard.ts` generates HTML and embeds client-side JavaScript for the Admin and Tenant dashboards.
- **Tests & Verification**: `scripts/verify.sh` runs the test gate (linting, typechecking, vitest tests).

## Code Layout
- `src/config.ts` - Config parsing and default values
- `src/gateway.ts` - HTTP server entry point and server startup logic
- `src/dashboard.ts` - Admin and Tenant dashboards HTML and client script templates
- `tests/` - Unit, integration, and deployment tests
- `scripts/verify.sh` - Core verification script

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Iteration_1 | Run direct iteration loop (Explorer → Worker → Reviewer → Challenger → Auditor) to fix all issues | None | IN_PROGRESS |

## Interface Contracts
### Config ↔ Gateway
- Config file defines the listening `port`. If configured via env or argument, it must be validated and utilized.
- If the port is in use, the server must handle EADDRINUSE without crashing (either erroring cleanly or trying another port, let's verify requirements: "Fix the startup crash when the default port (3000) is in use. Ensure the server can be started on a configurable port via the POSTHORN_PORT env variable...").
