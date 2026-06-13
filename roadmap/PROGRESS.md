# Progress Log

> Newest entry first. Each session **prepends** a block: date, feature id, what was done, what was verified (evidence paths), surprises, exact next step. The SessionStart hook injects the top ~50 lines into every new session.

---

## 2026-06-12 — F-0033 done (Endpoint payload delivery formats)

**What:** Added endpoint-level `payloadFormat` support. Endpoints now default to the existing `envelope` body and can opt into `payload_only` so the worker and endpoint test-send POST only the original JSON payload while signing that exact raw body. The field is exposed through endpoint create/update/read/list, OpenAPI, the TypeScript SDK, tenant CLI, Python SDK, README, and the parity matrix.

**Verified:** Evidence saved at `roadmap/evidence/F-0033/verify.log`. Evaluator returned NEEDS_WORK only because the evidence log had not been created yet, then PASS after the log was added. Security reviewer returned APPROVE. Local checks passed: `npx vitest run tests/storage.test.ts tests/endpoints-http.test.ts tests/worker.test.ts tests/endpoint-test-http.test.ts tests/client.test.ts tests/cli.test.ts tests/python-client.test.ts tests/openapi-contract.test.ts tests/parity-doc.test.ts` (69 tests), `npm run typecheck`, `npm run lint`, `npm test` (177 tests), `npm run build`, `npx ts-node scripts/update-state.ts --validate`, `git diff --check`, and `npx ts-node scripts/assertion-shield.ts`.

**Surprises:** The first evaluator pass caught a process gap rather than a code gap: green checks are not enough without the durable verify log. The payload-format scope stayed intentionally narrow: no templates, user code, JSONPath, method changes, URL rewrites, header mutation rules, or content-type customization.

**Next step:** Push the CI evidence record, wait for PR #62 checks again, then mark it ready and merge on green.

---

## 2026-06-12 — F-0032 done (Code-verified parity matrix)

**What:** Added `docs/PARITY.md`, the README-promised comparison of Posthorn against Svix, Convoy, Hookdeck, and Stripe. The matrix is source-backed, ties Posthorn claims to implemented docs/tests, and keeps unsupported Posthorn gaps explicit: PostgreSQL/HA scale-out, payload transformations, deduplication rules beyond intake idempotency, and non-webhook destination connectors.

**Verified:** Evidence saved at `roadmap/evidence/F-0032/verify.log`. Evaluator returned NEEDS_WORK for unsupported competitor deployment/operator claims and an incomplete README competitor list, then NEEDS_WORK again for an incorrect Stripe non-webhook destination cell, then PASS after both source-backed corrections. Security review was skipped because the final diff is docs/test/state only. Local checks passed: `npx vitest run tests/parity-doc.test.ts` (6 tests), `npm run typecheck`, `npm run lint`, `npm test` (174 tests), `npm run build`, `npx ts-node scripts/update-state.ts --validate`, `git diff --check`, and `npx ts-node scripts/assertion-shield.ts`.

**Surprises:** The first safe-looking fix overcorrected competitor cells to `Not verified`; Stripe's own event-destination docs support non-webhook destinations, so the final matrix marks that row as implemented for Stripe.

**Next step:** Push F-0032, open the PR, wait for CI, then add the PR-number/CI record and merge on green.

---

## 2026-06-12 — F-0031 done (Helm chart deployment reference)

**What:** Added a starter Helm chart under `charts/posthorn` for the current single-pod SQLite deployment model. The chart includes a deployment, service, PVC, optional chart-created admin-token secret, support for an existing admin-token secret, health/readiness probes, and hardened pod defaults without claiming PostgreSQL, Redis, ingress, ServiceMonitor, or horizontal scaling support.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0031/verify.log`. Evaluator returned NEEDS_WORK for exposing `replicaCount` and under-documenting the README boundary, then PASS after the chart was pinned to one pod and the README clarified starter single-pod SQLite scope. Security reviewer returned NEEDS_WORK for service-account token automount, replica exposure, and writable root filesystem defaults, then APPROVE after hardening. Local checks passed: `npx vitest run tests/helm-chart.test.ts tests/deployment-artifacts.test.ts` (9 tests), `npm run typecheck`, `npm test` (168 tests), `npm run lint`, `npm run build`, `npx ts-node scripts/update-state.ts --validate`, `git diff --check`, and `npx ts-node scripts/assertion-shield.ts`.

**Surprises:** A chart value as innocent as `replicaCount` would imply unsupported scale-out against SQLite. The final chart hard-codes one replica until the product has a PostgreSQL backend. Helm CLI is not installed in this local environment, so chart verification here is static artifact coverage plus Ubuntu CI.

**Next step:** Push the final evidence/state record, wait for PR #60 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0030 done (Endpoint delivery throttling)

**What:** Added optional `rateLimitPerSecond` on tenant endpoints. Tenants can set, update, clear, and read a per-endpoint delivery throttle through the HTTP API, TypeScript SDK, tenant CLI, and Python SDK; the worker keeps excess deliveries pending while other endpoints continue normally.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0030/verify.log`. Evaluator returned PASS. Security reviewer returned NEEDS_WORK twice for worker-claim DoS risks, then APPROVE after the throttle moved to durable per-endpoint claim-window state with indexes and a starvation regression. Local checks passed: `npx vitest run tests/storage.test.ts tests/worker.test.ts tests/endpoints-http.test.ts tests/client.test.ts tests/cli.test.ts tests/python-client.test.ts tests/openapi-contract.test.ts` (56 tests), `npm run typecheck`, `npm test` (163 tests), `npm run lint`, `npm run build`, `npx ts-node scripts/update-state.ts --validate`, `git diff --check`, and `npx ts-node scripts/assertion-shield.ts`.

**Surprises:** A naive throttle based on recent `delivery_attempts` history can become a denial-of-service vector because it scans historical rows while holding SQLite's write lock. The final design stores only the current per-endpoint claim window on `endpoints`, filters exhausted endpoints before candidate selection, and updates the counter in the same transaction as delivery leases. Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the final evidence/state record, wait for PR #59 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0029 done (Prometheus alerting and Grafana dashboard pack)

**What:** Added operator monitoring artifacts for the existing `/metrics` endpoint: `docs/prometheus-alerts.yml` and `docs/grafana-dashboard.json`. The alert pack covers scrape health, dead-letter backlog, new dead letters, stuck deliveries, and retry spikes; the dashboard covers accepted messages, delivery outcomes, task backlog, dead-letter reasons, uptime, and build info.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0029/verify.log`. Evaluator returned PASS. Security review was skipped because this was a docs/artifact-only change with no runtime, auth, API, data, dependency, or workflow changes. Local checks passed: `npx vitest run tests/monitoring-artifacts.test.ts tests/deployment-artifacts.test.ts` (7 tests), `npm run typecheck`, `npm test` (160 tests), `npm run lint`, `npm run build`, `npx ts-node scripts/update-state.ts --validate`, `git diff --check`, and `npx ts-node scripts/assertion-shield.ts`.

**Surprises:** The artifact tests are useful guardrails even for docs: they parse the Grafana JSON and reject unknown `posthorn_*` metric names so dashboards and alerts cannot drift ahead of the product metrics. Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the evidence/state record, mark PR #58 ready, then merge.

---

## 2026-06-12 — F-0028 done (Admin command-line client)

**What:** Added the `posthorn admin` command-line namespace for common control-plane work. Operators can now create/list/read/update/delete tenant apps, create/list/revoke API keys, read app usage, and rotate app system signing secrets from shell or CI with JSON output.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0028/verify.log`. Evaluator returned NEEDS_WORK for `create-key app --bogus` being treated as an API-key name and minting a secret, then PASS after option-like names were rejected before API calls. Security reviewer returned NEEDS_WORK for malformed CLI errors echoing raw argv values, then APPROVE after unknown command/option errors stopped reflecting tokens or one-time secrets. Local checks passed: `npx vitest run tests/cli.test.ts tests/deployment-artifacts.test.ts` (11 tests), `npm run typecheck`, `npm test` (157 tests), `npm run lint`, `npm run build`, `npx ts-node scripts/update-state.ts --validate`, `git diff --check`, and `npx ts-node scripts/assertion-shield.ts`.

**Surprises:** CLI usage errors are a credential surface because operators may paste tokens or one-time secrets into the wrong position. The admin CLI now avoids echoing unknown commands/options, and tests pass both admin tokens and generated API keys through malformed argv to prove stderr stays clean. Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the evidence/state record, mark PR #57 ready, then merge.

---

## 2026-06-12 — F-0027 done (Admin app system secret rotation)

**What:** Added admin-controlled app system signing secret rotation. Operators can rotate an app-level `whsec_` secret through the HTTP API and TypeScript admin client; the raw secret is returned only once, protected storage metadata stays out of read/list/update responses, and previous secret metadata is retained for a bounded overlap window.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0027/verify.log`. Evaluator returned NEEDS_WORK for displaced admin key auth/method assertions, then PASS after those assertions were restored and separate rotate-route checks were added. Security reviewer returned NEEDS_WORK for non-atomic rotation, then APPROVE after the rotation read/protect/update path moved into an immediate transaction with rollback regression coverage. Local checks passed: `npx vitest run tests/admin-http.test.ts tests/client.test.ts tests/storage.test.ts tests/openapi-contract.test.ts` (22 tests), `npm run typecheck`, `npm test` (154 tests), `npm run lint`, `npm run build`, `npx ts-node scripts/update-state.ts --validate`, and `git diff --check`.

**Surprises:** App system secret rotation has the same one-time secret loss risk as endpoint rotation if the old/current secret read and new secret write are not atomic. The regression uses a temporary SQLite trigger to abort the app update after local key creation and proves both app secret fields and generated key material roll back. Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the evidence/state record, mark PR #56 ready, then merge.

---

## 2026-06-12 — F-0026 done (Message history filters)

**What:** Added server-side message history filters for `GET /v1/messages`. Tenants can now combine `eventType`, `after`, `before`, `limit`, and `cursor`, with newest-first keyset pagination preserved. The TypeScript SDK allowlist, OpenAPI parameter docs, and README now reflect the implemented filter surface.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0026/verify.log`. Evaluator returned NEEDS_WORK for permissive date parsing and an OpenAPI query-parameter invariant, then PASS after strict timestamp validation and contract assertions were added. Security reviewer returned APPROVE. Local checks passed: `npx vitest run tests/messages-http.test.ts tests/client.test.ts tests/openapi-contract.test.ts` (34 tests), `npm run typecheck`, `npm test` (151 tests), `npm run lint`, `npm run build`, `npm run state:validate`, and `git diff --check`.

**Surprises:** JavaScript `Date.parse()` accepts impossible calendar dates and local-time strings, so message history filters now use strict calendar-aware timestamp validation with explicit `Z` or numeric offset. Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the evidence/state record, wait for PR #55 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0025 done (Auto-disable persistently failing endpoints)

**What:** Implemented the documented endpoint auto-disable behavior. The delivery worker now disables an endpoint after a configured window of historical failed or dead-letter attempts with no recent success, and normal server startup passes `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` into the background worker. Disabled endpoints already fall out of new message fanout and worker claims.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0025/verify.log`. Evaluator returned PASS. Security reviewer returned NEEDS_WORK for a small-window single-dead-letter DoS edge case, then APPROVE after the current attempt was excluded from historical-failure evidence and regression-covered. Local checks passed: `npx vitest run tests/worker.test.ts` (18 tests), `npm run typecheck`, `npm test` (150 tests), `npm run lint`, `npm run build`, `npm run state:validate`, and `git diff --check`.

**Surprises:** A tiny auto-disable window could let the current dead-letter count as the old failure if record time moved far enough past attempt start; the fix requires the qualifying historical failure to predate the current attempt. Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the evidence/state record, wait for PR #54 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0024 done (TypeScript admin client)

**What:** Added the README-promised TypeScript admin/control-plane client. Operators can now create/list/read/update/delete tenant apps, read current-month app usage, and create/list/revoke tenant API keys through exported package helpers. Admin client route coverage pins the helper surface to implemented OpenAPI admin routes.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0024/verify.log`. Evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/client.test.ts` (7 tests), `npm run lint`, `npm test` (145 tests), `npm run build`, `npm run state:validate`, and `git diff --check`.

**Surprises:** Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the evidence/state record, wait for PR #53 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0023 done (TypeScript SDK parity for implemented tenant routes)

**What:** Expanded the TypeScript tenant SDK so implemented routes no longer require raw HTTP: message listing, endpoint secret rotation, endpoint delivery history/stats, app-wide delivery listing, event type CRUD, endpoint test-send, and portal session creation. SDK route coverage now pins every helper to an implemented OpenAPI route.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0023/verify.log`. Evaluator returned NEEDS_WORK for two `unknown`-typed SDK option inputs, then PASS after client-facing types and compile-time assertions were added. Security reviewer returned NEEDS_WORK for generic query serialization of unexpected option keys, then APPROVE after per-helper query allowlists and regression coverage. Local checks passed: `npx vitest run tests/client.test.ts`, `npm run typecheck`, `npm test` (143 tests), `npm run lint`, `npm run build`, `npm run state:validate`, and `git diff --check`.

**Surprises:** Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the evidence/state record, wait for PR #52 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0022 done (Python SDK and webhook verification helper)

**What:** Added the README-promised dependency-free Python SDK in `clients/python`. Python producers can create/list endpoints, send single and batch messages, read message status, retry messages, list attempts, read usage, inspect endpoint delivery history/stats, and list app-wide deliveries with filters. Python receivers can verify Posthorn Standard Webhooks signatures with replay-window and multi-signature checks.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0022/verify.log`. Evaluator returned PASS. Security reviewer returned NEEDS_WORK for Python redirect auth leakage, then APPROVE after redirects were disabled and regression-covered. Local checks passed: `python -m py_compile clients/python/posthorn/__init__.py clients/python/posthorn/client.py clients/python/posthorn/webhooks.py`, `npx vitest run tests/python-client.test.ts`, `npm run typecheck`, `npm test` (141 tests), `npm run lint`, `npm run build`, `npm run state:validate`, and `git diff --check`.

**Surprises:** The first CI verify attempt failed because the shellcheck package download hit a transient `403 rate limit exceeded`; rerunning the failed job passed. Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable.

**Next step:** Push the evidence/state record, wait for PR #51 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0021 done (App-wide delivery listing and filters)

**What:** Added tenant-scoped `GET /v1/deliveries` for app-wide delivery search. Operators can list recent deliveries across endpoints with keyset pagination and filter by status, endpoint id, event type, or failure reason. Responses are metadata-only and omit payloads, endpoint URLs, headers, API keys, signing secrets, protected secret metadata, request bodies, and response bodies.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0021/verify.log`. Evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/deliveries-http.test.ts tests/openapi-contract.test.ts`, `npm test` (138 tests), `npm run lint`, `npm run build`, `npm run state:validate`, and `git diff --check`.

**Surprises:** Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is authoritative and passed.

**Next step:** Push the evidence/state record, wait for PR #50 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0020 done (Endpoint delivery history and stats)

**What:** Added endpoint-scoped observability routes. Tenants can now list one endpoint's delivery history with keyset pagination and read trailing-window endpoint stats with status counts, success rate, average successful duration, daily trend, and failure-reason breakdowns. Responses intentionally omit payloads, endpoint URLs, headers, API keys, signing secrets, protected secret metadata, and response bodies.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0020/verify.log`. Evaluator returned NEEDS_WORK, then PASS after aligning `byStatus.dead_letter` with the brief. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/endpoint-observability-http.test.ts tests/openapi-contract.test.ts`, `npm test` (135 tests), `npm run lint`, `npm run build`, `npm run state:validate`, and `git diff --check`.

**Surprises:** The stats response initially used camel-case `deadLetter`, but the brief and existing delivery status enum use `dead_letter`; the API, OpenAPI schema, and tests now use the snake-case key.

**Next step:** Push the evidence/state record, wait for PR #49 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0019 done (Endpoint signing secret rotation)

**What:** Added zero-downtime endpoint signing secret rotation. Tenants can call `POST /v1/endpoints/:id/rotate-secret` to receive a new one-time `whsec_` secret, while the previous encrypted endpoint secret remains usable for a bounded overlap window. Delivery worker and endpoint test-send signatures now include both current and previous secrets during overlap and current-only after expiry.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0019/verify.log`. Evaluator returned NEEDS_WORK, then PASS after fixes for endpoint test-send rotation signatures and JSON `null` validation. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/endpoint-test-http.test.ts tests/endpoints-http.test.ts tests/worker.test.ts tests/storage.test.ts tests/openapi-contract.test.ts`, `npm test` (131 tests), `npm run lint`, `npm run build`, `npm run state:validate`, and `git diff --check`.

**Surprises:** The raw GitHub Actions log prefixes every line, while the state gate requires exact standalone verify markers, so the evidence file keeps the full CI log and prefixes normalized `VERIFY-COMMIT:` and `VERIFY: PASS (exit 0)` lines extracted from that run.

**Next step:** Push the evidence/state record, wait for PR #48 checks again, then mark the PR ready and merge.

---

## 2026-06-12 — F-0018 done (Admin and tenant dashboard)

**What:** Added the browser dashboard served by the gateway. The admin panel can list tenants, create tenants, view usage, mint API keys, list keys, and revoke keys. The tenant panel can load usage, endpoints, message history, delivery status, and per-attempt audit logs. To make tenant history real, `GET /v1/messages` is now implemented as a tenant-scoped newest-first keyset-paginated API, with README/OpenAPI sync and focused HTTP coverage.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0018/verify.log`. UI screenshot evidence is saved at `roadmap/evidence/F-0018/admin-dashboard.png` and `roadmap/evidence/F-0018/tenant-dashboard.png`, with browser state checks in `roadmap/evidence/F-0018/browser-screenshots.log`. Evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/messages-http.test.ts tests/dashboard-http.test.ts tests/openapi-contract.test.ts`, `npm test` (123 tests), `npm run lint`, `npm run build`, and `npm run state:validate`.

**Surprises:** The in-app browser target could interact with the local dashboard but its screenshot command timed out in this session, so final PNG evidence was captured with a one-off headless Chrome DevTools run against the same local server and seeded synthetic data. F-0018 also made the planned `GET /v1/messages` route necessary because browser-local history would not satisfy real tenant debugging.

**Next step:** Push this final evidence/state record, wait for PR #47 checks again, then merge. After merge, the planned backlog is complete.

---

## 2026-06-12 — F-0017 done (Event type catalog and consumer portal sessions)

**What:** Added tenant-scoped event type catalog routes, active-name conflict handling, archive semantics, synchronous endpoint test sends with explicit or `schemaExample` payloads, and short-lived portal session tokens stored only as hashes. OpenAPI and README route/error tables now mark event types, endpoint test-send, portal sessions, `conflict`, and `endpoint_disabled` as implemented.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0017/verify.log`. Evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/event-types-http.test.ts tests/endpoint-test-http.test.ts tests/portal-sessions-http.test.ts tests/openapi-contract.test.ts tests/storage.test.ts`, `npm test` (118 tests), `npm run lint`, `npm run build`, and `npm run state:validate`.

**Surprises:** Endpoint test-send needed a gateway-level injectable delivery fetch so tests could verify signing, headers, manual redirects, and failure results without real outbound network calls. README route rows also had to split the combined event-types row so the existing OpenAPI sync parser could match implemented operations exactly.

**Next step:** Merge PR #46 after the final evidence/state commit goes green, then start the last unblocked feature.

---

## 2026-06-12 — F-0016 done (Docker and production compose reference)

**What:** Added the single-container Docker deployment path: a compiled `node dist/src/server.js` production entrypoint, non-root runtime image with `/data` persistence, in-process gateway plus delivery worker, loopback-bound Docker Compose reference, and Prometheus scrape config. README and deployment docs now use implemented HTTP admin routes and register an endpoint before sending the first message.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0016/verify.log`. Docker build/run/health/SQLite-volume and `docker compose config --quiet` evidence saved at `roadmap/evidence/F-0016/docker-smoke.log`. Evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/deployment-artifacts.test.ts tests/server.test.ts`, `npm test` (111 tests), `npm run lint`, `npm run build`, and `npm run state:validate`.

**Surprises:** Docker caught a real build-context issue: TypeScript 6 inferred a narrower project root when only `src/` was copied, so the Docker build stage now copies the same compile-time project shape while the runtime image receives only `dist/src`. Security review also tightened defaults so Compose binds Posthorn and Prometheus to `127.0.0.1` and `.dockerignore` excludes local SQLite/database files.

**Next step:** Merge PR #45 after the final evidence/state commit goes green, then start the next unblocked feature.

---

## 2026-06-12 — F-0015 done (Prometheus metrics endpoint)

**What:** Added unauthenticated `GET /metrics` Prometheus text exposition for accepted messages, delivery outcomes, delivery task statuses, dead-letter reasons, uptime, and build info. Metrics are derived from durable SQLite state, use only bounded labels, and avoid tenant IDs, endpoint URLs, event types, message IDs, API keys, signing secrets, hashes, headers, and payload fields.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0015/verify.log`. Evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/metrics-http.test.ts tests/openapi-contract.test.ts`, `npm test` (106 tests), `npm run lint`, `npm run build`, and `npm run state:validate`.

**Surprises:** The README sample used `connection_refused`, but the worker emits bounded failure reasons such as `http_503`, `timeout`, and `network_error`. The metrics endpoint normalizes HTTP status-specific reasons into `http_###` to avoid high-cardinality labels.

**Next step:** Merge PR #44 after the final evidence/state commit goes green, then start the next unblocked feature.

---

## 2026-06-12 — F-0014 done (TypeScript SDK and command-line client)

**What:** Added `PosthornClient`, `PosthornApiError`, and the `posthorn client` CLI for tenant endpoint, message, attempt, retry, and usage workflows. To keep the client honest, the feature also added implemented message status and retry HTTP routes, updated OpenAPI/README route status, and packaged runtime SDK/CLI outputs with declaration files.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0014/verify.log`. Evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/client.test.ts tests/cli.test.ts tests/messages-http.test.ts tests/openapi-contract.test.ts`, `npm test` (104 tests), `npm run lint`, `npm run build`, `npm run state:validate`, compiled CLI help smoke, and `npm pack --dry-run --json`.

**Surprises:** F-0014 acceptance required message status and retry methods, but the backend routes were still planned. The route implementations were added in this feature so the SDK and CLI do not expose dead client methods.

**Next step:** Merge PR #43 after the final evidence/state commit goes green, then start the next unblocked feature.

---

## 2026-06-12 — F-0013 done (OpenAPI contract and closed error codes)

**What:** Added deterministic `GET /openapi.json` OpenAPI 3.1 output for every implemented public and admin route, centralized the runtime `Error.code` enum, exported the OpenAPI helpers, and changed readiness failures to return the standard error envelope. README route and error-code tables now mark implemented vs planned surfaces so docs and spec can be tested without documenting future routes as live.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0013/verify.log`. Evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/openapi-contract.test.ts tests/gateway-http.test.ts`, `npm test` (95 tests), `npm run lint`, `npm run build`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is the authoritative full gate and passed.

**Next step:** Merge PR #42 after the final evidence/state commit goes green, then start the next unblocked feature.

---

## 2026-06-12 — F-0012 done (batch message intake)

**What:** Added `POST /v1/messages/batch` for authenticated producers to send 1 to 100 messages in one request. The route returns per-item `ok` results, reuses single-message validation/idempotency/quota/fanout behavior, supports mixed success and failure, and keeps idempotent batch retries from creating duplicate delivery work.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0012/verify.log`. Security reviewer returned APPROVE. The first evaluator found implementation behavior correct but asked for CI evidence; after evidence was added, the follow-up evaluator returned PASS. Local checks passed: `npm run typecheck`, `npx vitest run tests/messages-http.test.ts tests/usage-http.test.ts`, `npm test` (91 tests), `npm run lint`, `npm run build`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is the authoritative full gate and passed.

**Next step:** Merge PR #41 after the final evidence/state commit goes green, then continue to the next unblocked feature.

---

## 2026-06-12 — F-0011 done (usage metering and quota enforcement)

**What:** Added current-month usage metering for accepted messages and delivery attempts. Tenants can read `GET /v1/usage`, admins can read `GET /v1/admin/apps/:id/usage`, and capped tenants receive `429 quota_exceeded` before new message fanout work is created. Idempotent retries return the original send without double-counting usage.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0011/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/usage-http.test.ts tests/storage.test.ts`, `npm test` (85 tests), `npm run lint`, `npm run build`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is the authoritative full gate and passed.

**Next step:** Merge PR #40 after the final evidence/state commit goes green, then start F-0012 (batch message intake).

---

## 2026-06-12 — F-0010 done (admin tenant and API-key management)

**What:** Added the disabled-by-default admin control plane for tenant provisioning. With `POSTHORN_ADMIN_TOKEN` configured, operators can create, list, read, update, and delete tenant apps; mint tenant `phk_` API keys; list key records without secrets or hashes; and revoke keys so they stop authenticating.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0010/verify.log`. Fresh-context evaluator returned PASS. Security reviewer initially BLOCKed method dispatch before admin auth; the route now authenticates enabled admin requests before returning `405`, and security re-review returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/admin-http.test.ts`, `npm test` (81 tests), `npm run lint`, `npm run build`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** The first admin route pass returned `405` before token validation on unsupported methods, which leaked route shape to invalid admin tokens. The fix authenticates once after the disabled-admin `404` check and before any method-specific response.

**Next step:** Merge PR #39 after the final evidence/state commit goes green, then start F-0011 (usage metering and quota enforcement), which is now unblocked by F-0010.

---

## 2026-06-12 — F-0009 done (per-attempt audit log)

**What:** Added `GET /v1/messages/:id/attempts` for tenant-authenticated delivery attempt history. The route returns newest-first attempt rows with attempt number, outcome, timestamp, duration, response status, failure reason, delivery ID, message ID, and endpoint ID; missing and other-tenant messages both return `404`.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0009/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/messages-http.test.ts`, `npx vitest run tests/messages-http.test.ts tests/worker.test.ts`, `npm test` (77 tests), `npm run lint`, `npm run build`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is the authoritative full gate and passed.

**Next step:** Merge PR #38 after the final evidence/state commit goes green, then start F-0010 (admin tenant and API-key management) unless a higher-priority unblocked feature appears.

---

## 2026-06-12 — F-0008 done (idempotent message intake)

**What:** Added optional `idempotencyKey` support for `POST /v1/messages`. Same-tenant retries with the same canonical request now return the original accepted message and delivery IDs without creating new fanout; changed retries return `409 idempotency_conflict`. Idempotency keys are tenant-scoped through the existing SQLite uniqueness constraint.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0008/verify.log`. Fresh-context evaluator returned NEEDS_WORK for a raw control-character validation gap, then PASS after the fix and regression test. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npm test` (73 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Trimming before validation would have allowed leading/trailing control characters in idempotency keys; the parser now rejects control characters in the raw supplied string before trimming.

**Next step:** Merge PR #37 after the final evidence commit goes green, then start F-0009 (per-attempt audit log) or F-0010 if admin provisioning is higher leverage.

---

## 2026-06-12 — F-0007 done (crash-safe retry delivery worker)

**What:** Added the importable delivery worker with SQLite lease claiming, Standard Webhooks signing, success/failure attempt recording, exponential retry scheduling, dead-lettering, timeout handling, and lease reclaim. Endpoint signing-secret persistence now stores recoverable protected material for new endpoints while legacy digest-only rows fail closed instead of sending unsigned traffic. Security review blocked redirect-following and response-body buffering; the worker now sends with redirects disabled and cancels response bodies.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0007/verify.log`. Fresh-context evaluator returned NEEDS_WORK only until CI evidence existed; focused checks were green. Security reviewer returned BLOCK then APPROVE after outbound HTTP hardening. Local checks passed: `npm run typecheck`, `npm test` (69 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** The assertion shield correctly blocked replacing a persisted-secret assertion; the implementation kept the historical `sha256:` compatibility prefix while using key-version metadata to distinguish recoverable protected secrets from legacy digest-only rows.

**Next step:** Merge PR #36 after the final evidence commit goes green, then start F-0008 (idempotent message intake).

---

## 2026-06-12 — F-0006 done (message intake and fanout queue)

**What:** Added `POST /v1/messages`, tenant-authenticated message persistence, pending delivery task creation for enabled matching endpoints, and store helpers for message/delivery readback. Security review approved and suggested payload-depth hardening; the JSON validator is now iterative with depth/node caps and regression coverage for deeply nested payloads.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0006/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npm test` (58 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** CI exposed nondeterministic ordering in fanout tests where random endpoint IDs tied on timestamps; the tests now seed deterministic endpoint timestamps and delivery readback uses insertion order.

**Next step:** Merge PR #35 after the final state commit goes green, then start F-0007 (crash-safe retry delivery worker).

---

## 2026-06-12 — F-0004 done (tenant endpoint management CRUD)

**What:** Added bearer-authenticated endpoint create/list/read/update/delete routes, tenant-scoped API-key auth helpers, endpoint validation, one-time `whsec_` create responses, and protected signing-secret persistence. Security review found SSRF edge cases in trailing-dot hostnames and IPv6 internal literals plus delayed oversized-body responses; all were fixed with regression tests.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0004/verify.log`. Fresh-context evaluator returned NEEDS_WORK then PASS after URL/body hardening. Security reviewer returned BLOCK then APPROVE after the same hardening fixes. Local checks passed: `npm run typecheck`, `npm test` (53 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** URL policy needed DNS root-dot normalization and numeric IPv6 range checks; prefix checks alone were not enough.

**Next step:** Merge PR #34 after the final state commit goes green, then start F-0010 (admin tenant and API-key management).

---

## 2026-06-12 — F-0005 done (Standard Webhooks utilities)

**What:** Added dependency-free Standard Webhooks signing and verification utilities with `whsec_` HMAC-SHA256 secrets, raw-body signing, replay-window enforcement, case-insensitive header parsing, and multi-signature rotation support.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0005/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npm test` (47 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Local `bash scripts/verify.sh` still fails in Windows Git Bash for the known native-`node` hook-fixture issue, so Ubuntu CI remains the authoritative full-gate evidence.

**Next step:** Merge PR #33 after the final state commit goes green, then start F-0004 (tenant endpoint management CRUD).

---

## 2026-06-12 — F-0003 done (health/readiness HTTP server)

**What:** Added a zero-dependency Node HTTP gateway with `start()`/`stop()`, unauthenticated `/healthz`, storage-backed `/readyz`, and in-memory HTTP integration tests. Security review blocked the first version for malformed request crashes and concurrent-start listener leaks; both were fixed with regression tests. A later review noted failed-listen cleanup, which was also fixed before merge.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0003/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE after the lifecycle hardening fixes. Local checks passed: `npm run typecheck`, `npm test` (26 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Raw malformed request targets can bypass normal `fetch`-level assumptions, so the server now catches URL parse failures and keeps running.

**Next step:** Merge PR #32 after the final state commit goes green, then start F-0005 (Standard Webhooks signing and verification utilities).

---

## 2026-06-12 — F-0002 done (configuration and SQLite storage)

**What:** Added `loadConfig`, documented POSTHORN_* defaults, built the first `node:sqlite` storage layer, and initialized the initial Posthorn tables idempotently. Security review blocked the first endpoint-secret schema, so the schema now separates non-secret headers from secret references and stores signing secrets as protected recoverable fields with key metadata.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0002/verify.log`. Fresh-context evaluator returned PASS after evidence was committed. Security reviewer returned APPROVE after the schema hardening fix. Local checks passed: `npm run typecheck`, `npm test` (18 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** The reviewer also spotted two non-blocking quality issues; both were fixed before merge: port values now cap at 65535, and `createGateway(loadConfig(...))` preserves loaded config fields.

**Next step:** Merge PR #31 after the final state commit goes green, then start F-0005 (Standard Webhooks signing and verification utilities) or F-0003 if HTTP serving is the higher leverage next foundation.

---

## 2026-06-12 — F-0001 done (product scaffold)

**What:** Groomed the empty roadmap into 18 machine backlog items, selected F-0001, and added the first Posthorn TypeScript product scaffold with a minimal gateway factory, Vitest test, build script, and README status wording.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0001/verify.log`. Fresh-context evaluator returned PASS, and dependency/security review returned APPROVE. Local product checks also passed: `npm run typecheck`, `npm test`, `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** `bash scripts/verify.sh` reaches the existing hook contract tests but fails locally because Git Bash can see Windows `npm`/`npx` without a native Bash `node`; CI on Ubuntu is the authoritative full-gate lane for this branch.

**Next step:** Merge PR #30 after the final evidence commit goes green, then start F-0002 (configuration and SQLite storage foundation).

---

## 2026-06-11 — Engine installed (department bootstrap)

**What:** AI operations engine (ai-operations-template drop-in) installed into claude-sandbox-test1 (Posthorn — webhook relay). Engine files copied, placeholders filled, roadmap seeded, PROGRESS/DECISIONS/ROADMAP initialized.

**Verified:** `bash scripts/init.sh` and `bash scripts/verify.sh` both passed — VERIFY: PASS confirmed. Branch `develop` pushed to GitHub with engine commit. Default branch set to `develop`; branch protection applied to `develop` and `main`.

**Next step:** Run `/groom` against the charter (README.md + GOAL.md + roadmap/ROADMAP.md) to decompose the Now/Next/Later bullets into `features.json` entries with acceptance criteria.
