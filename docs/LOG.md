# Operational Log & System Ledger

## Page 1: Rules of the Log (Specification v1.0)

### 1. Conformance Tier Matrix
- **MUST / REQUIRED**: Mandatory. Failing this item makes the file non-compliant.
- **SHOULD / RECOMMENDED**: Strong recommendation. Valid exceptions can exist, but implications must be understood and noted.
- **MAY / OPTIONAL**: Permissive. Truly optional fields or sections.
- **MUST NOT / SHALL NOT**: Absolute prohibition. Doing this breaks compliance or forensic safety.

### 2. File and Ordering Constraints
- This file (`docs/LOG.md`) **MUST** be the single source of truth for repository history.
- Root-level log files or duplicate files (like `LOOP_LOG.md`) **MUST NOT** exist in the workspace.
- Entries **MUST** be written in **newest-first (reverse-chronological)** order. 
- New entries **MUST** be programmatically prepended immediately below the `== LOG-ANCHOR ==` line.
- Agents and humans **MUST NOT** free-hand rewrite or hand-edit older historical entries.

### 3. Entry Content & Structure Rules
- An entry **MUST** be generated only when product code changes, gate status transitions, or a material architecture decision is made.
- Relational or no-op loop triggers that result in no codebase modification **MUST NOT** log an entry.
- Every entry **MUST** use this strict multiline markdown schema:
  `## YYYY-MM-DDThh:mm · iter-NNNN · STATUS · lowercase-kebab-slug`
  * `- **Baseline:**` (Git SHA and starting state)
  * `- **Move:**` (One sentence defining the loop iteration objective)
  * `- **Changed:**` (Bulleted changes list)
  * `- **Decisions:**` (tradeoffs made, or "none")
  * `- **Validation:**` (Command executed and its precise exit/response text)
  * `- **Notes:**` (**OPTIONAL / MAY** — Sandbox area for agent/human thoughts, commentary, or context)
  * `- **Next:**` (1-3 subsequent engineering paths)

### 4. Status Vocabulary
The `STATUS` token in the header line **MUST** be exactly one of: 
`GREEN` (Passed) | `AMBER` (Caveats) | `RED` (Failed) | `BLOCKED` (Waiting) | `INCIDENT` (System Error) | `ROLLBACK` (Reset).

### 5. Size Hard Boundaries
- Individual text lines **MUST NOT** exceed 2,000 characters (guards against single-line data dumps).
- Lines **SHOULD** wrap at or under 120 characters for clean terminal and diff presentation where practical.
- Entries **SHOULD** target 150–350 words, and **MUST NOT** exceed 500 words unless labeled an `INCIDENT` or `ROLLBACK`.
- This file **MUST** be rotated into monthly archives (`docs/log/YYYY-MM.md`) once it crosses 1,000 lines or 250 KB.

---
== LOG-ANCHOR ==

## 2026-05-25T09:55 · iter-0114 · GREEN · graceful-shutdown-drains-in-flight-http-requests

- **Baseline:** clean main @ `99ee820` (iter-0113 per-endpoint failure-reason stats). Verified
  green first: `tsc` 0, `vitest run` 1876 no-PG (6 PG-skipped), `build` 0.
- **Move:** Off the saturated PG-pool/observability tunnels onto the **shutdown-correctness** axis.
  `gateway.stop()` closed the HTTP server with `httpServer.closeAllConnections()`, which destroys
  **in-flight** request sockets, not just idle keep-alives — so a `POST /v1/messages` in flight when
  `SIGTERM` arrives (rolling deploy, the exact case the multi-replica DEPLOY guide covers) is reset
  mid-response. A producer without an idempotency key then cannot tell if the event landed, and
  retries → duplicate or lost. DEPLOY.md even promised "no draining beyond your LB's grace" — the
  code contradicted it.
- **Changed:**
  - `gateway.ts` `stop()`: `close()` (in-flight responses get `Connection: close`, so keep-alive
    sockets end after their current response) + `closeIdleConnections()` (drop only currently-idle
    sockets) replaces the blanket `closeAllConnections()`. A bounded force-close timer
    (`unref()`'d) then aborts any still-active socket after the grace, so a stuck request can't hang
    shutdown past the orchestrator's termination window. `0`/omitted = no cutoff (drain bounded only
    by the per-request timeout).
  - New `POSTHORN_HTTP_SHUTDOWN_GRACE_MS` knob (default `DEFAULT_HTTP_SHUTDOWN_GRACE_MS` = 10_000,
    `min: 0`), mirroring the existing `http*Timeout` flat fields. Documented in the `loadConfig`
    JSDoc, `.env.example`, and DEPLOY.md (new "Graceful shutdown and the drain window" section +
    rolling-deploys bullet corrected); config↔docs drift guard auto-covers it.
  - Tests: `config.test.ts` default/parse/0/negative/non-integer + the full-object default; two
    real-socket `gateway.test.ts` integration tests — an in-flight test-send **drains to its `200`**
    during `stop()` (the regression guard), and one outlasting a 40 ms grace is **force-closed**
    (client rejects, `stop()` still returns).
- **Decisions:** Made the grace configurable (operators must align it with
  `terminationGracePeriodSeconds`/`docker stop -t`) rather than a fixed constant; default 10 s fits
  k8s's 30 s default and matches Docker's stop grace. Kept the existing stop ordering (worker →
  HTTP → backend). Guarded the field read with `typeof === "number"` so a hand-built (non-`loadConfig`)
  config degrades to unbounded-drain instead of crashing. Logged to LOG.md only (PROJECT.md is the
  frozen roadmap; this is runtime hardening).
- **Validation:** `tsc` 0; `vitest run` **1885** (+9; 6 PG-skipped, no flaky exit) incl. the two new
  booted-gateway drain tests over real sockets; `build` 0; `assert-gate-integrity.ps1` 0 (zero
  substrate edits); working tree = the 6 intended files.
- **Notes:** The drain test forces `POSTHORN_FANOUT_IDLE_POLL_MS=5` so `stop()` reaches the HTTP-close
  phase fast (the dispatcher's 1 s default poll would otherwise delay it), then releases the receiver
  after an 80 ms beat so the request is provably in flight when `closeIdleConnections()` runs — under
  the old `closeAllConnections()` it would have been reset. No bespoke dist smoke: the new tests boot
  the real composition over real sockets, which is what a smoke would add.
- **Next:** Audit dashboard/portal HTML error rendering against the `error-codes.ts` vocabulary
  (iter-0113 Next #2); or export a typed `narrowApiError` SDK helper; or expose
  `connectionsCheckingInterval` so sub-second header/request deadlines aren't coarsened by the 30 s sweep.

## 2026-05-25T04:15 · iter-0113 · GREEN · per-endpoint-failure-reason-breakdown-on-stats

- **Baseline:** clean main @ `9d88937` (iter-0112 error-code enum). Verified green first:
  `tsc` 0, `vitest run` 1872 (6 PG-skipped), `build` 0.
- **Move:** Take iter-0112's "Next" #1 — the failure-reason taxonomy's missing third leg.
  The instance metric (`posthorn_delivery_failures_total{reason}`) and the per-attempt
  `failureReason` existed, but `GET /v1/endpoints/:id/stats` reported only
  totals/successRate/avgDuration/daily — no per-reason aggregate, the exact data an operator
  triages a flapping endpoint from ("mostly `connection_refused`" vs "mostly `http_5xx`").
- **Changed:**
  - `EndpointStats` gains `failureReasons: DeliveryFailureReasonCounts` — closed taxonomy,
    **every** reason key present (zeros included), the same convention as the metric.
    Documented invariant: classified failures sum to `failed`; legacy null-reason rows are
    counted in `failed` but excluded here (so a window spanning that upgrade sums to less).
  - All three `statsByEndpoint` backends compute it: in-memory folds per attempt; sqlite +
    postgres add a second indexed range scan `GROUP BY failure_reason` (rides the existing
    `(endpoint_id, attempted_at)` index), folded through `emptyDeliveryFailureCounts()` with an
    `isDeliveryFailureReason` guard against hand-edited junk.
  - Surface: OpenAPI gains a `DeliveryFailureReasonCounts` schema built from
    `DELIVERY_FAILURE_REASONS` + `EndpointStats.required` now lists `failureReasons`; SDK
    `EndpointStatsView` typed; README route table gains the previously-undocumented `/stats` row.
  - Tests: conformance breakdown (sums + key-completeness + legacy-null exclusion), api.test
    end-to-end assertion, two OpenAPI drift guards; `smoke-failure-reason.mjs` extended to assert
    the breakdown through the booted `dist` gateway on both endpoints.
- **Decisions:** A whole-window per-reason tally (not per-day) keeps the response bounded and
  matches the metric's shape. Two queries over one combined `GROUPING SET` — clearer, matches the
  one-statement-per-read-shape house style, and `/stats` is a low-QPS operator route. Logged to
  LOG.md only (PROJECT.md is the frozen roadmap; this is observability completion).
- **Validation:** `tsc` 0; `vitest run` **1876** no-PG (+4; 6 PG-skipped); with a live Docker
  `postgres:16` the **full** suite is **2153/2153** (incl. PG attempt-store conformance + the two
  PG gateway e2e). `build` 0. `smoke-failure-reason.mjs` **29/29** through `dist` (ep1 http_5xx:2,
  refused:0; ep2 refused:1, http_5xx:0). `assert-gate-integrity.ps1` 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`.
- **Notes:** Smoke assertions use `≥ 1` / cross-reason-zero rather than a strict sum-equals-failed,
  since the still-retrying worker writes concurrently with the read; the exact sum invariant is
  proven deterministically in the conformance suite.
- **Next:** Export a typed `narrowApiError` helper for SDK consumers; or audit dashboard/portal
  HTML error rendering against the error-code vocabulary; or surface a per-endpoint failure-reason
  panel on the tenant dashboard now the aggregate exists.

## 2026-05-25T03:30 · iter-0112 · GREEN · pin-api-error-code-contract-enum-drift-guard

- **Baseline:** clean main @ `2aef6ef` (iter-0111 SSRF portal test-send). Verified green first:
  `tsc` 0, `vitest run` 1869 (6 PG-skipped), `build` 0.
- **Move:** Closed iter-0111's "Next" #1–2 by inspection (no dashboard test-send surface exists —
  both dashboard handlers only take a clock; the connect/request-timeout failure-reason split
  already shipped in `failure-reason.ts` and is surfaced on the attempt view, delivery views, SDK,
  OpenAPI, dashboard, and the `?failureReason=` filter), then took #3 properly. The machine-readable
  error `code` was the **one** contract field not pinned to a single source of truth: OpenAPI
  `Error.code` advertised only 6 codes as loose `examples` while the API emits **12** — `conflict`,
  `internal_error`, `method_not_allowed`, `endpoint_disabled`, `invalid_json` undocumented, and
  `payload_too_large` (from the `server.ts` body-cap path) missing entirely — with no `enum` and no
  drift guard, so the SDK's whole `err.code`-branching contract could silently rot.
- **Changed:**
  - New `src/http/error-codes.ts`: `API_ERROR_CODES` (`as const`) → derived `ApiErrorCode` union,
    `isApiErrorCode` guard, and `errorEnvelope(code, message)` — the single typed constructor of an
    error body, doc'd with the HTTP-status table.
  - `api.ts` + `server.ts`: every emission site now routes through `errorEnvelope` / a typed
    `HttpError.code`, so the closed set is **compile-enforced** (the `API_ROUTE_KEYS` discipline).
  - `openapi.ts`: `Error.code` is now `enum: [...API_ERROR_CODES]` (was `examples`).
  - SDK `PosthornApiError.code` typed `ApiErrorCode | (string & {})` — autocomplete on known codes,
    `http_<status>` fallback kept, structurally still `string` so no consumer breaks. Barrel exports
    the new surface.
  - Tests: bidirectional OpenAPI drift guard (`enum` == array) + a non-vacuous emission proof driving
    six real error paths and asserting each `code` is in the closed set. README error-code table.
- **Decisions:** Derived the union from the `as const` array (union+array cannot disagree) over a
  hand-written union; widened the SDK type with `(string & {})` rather than a breaking literal-only
  type. Logged the per-iteration record to LOG.md only (PROJECT.md is the frozen feature roadmap;
  this is contract hardening).
- **Validation:** `tsc` 0; `vitest run` **1872** (+3; 6 PG-skipped, no flaky exit); `build` 0.
  **Dist smoke** through production ESM: OpenAPI `enum` deep-equals `API_ERROR_CODES`, 12 codes incl.
  `payload_too_large`, `isApiErrorCode`/`errorEnvelope` correct. `assert-gate-integrity.ps1` 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Notes:** No full booted-gateway smoke — the change is pure wiring plus a JSON-Schema `enum`
  identical in shape to the already-Redocly-validated `failureReason` enum (no new runtime/ESM path);
  the import-from-`dist` smoke and the real-socket server/gateway/SDK suites already exercise the
  production composition.
- **Next:** Per-endpoint failure-reason breakdown on `GET /v1/endpoints/:id/stats` (the taxonomy's
  missing third leg — instance metrics + per-attempt exist, the per-endpoint aggregate does not);
  or export a typed `narrowApiError` helper for SDK consumers; or audit the dashboard/portal HTML
  error rendering against this same code vocabulary.

## 2026-05-25T03:05 · iter-0111 · GREEN · ssrf-guard-portal-test-send-transport-wiring

- **Baseline:** clean main @ `9a8ac74` (iter-0110 HTTP socket timeouts). Verified green first:
  `tsc` 0, `vitest run` 1868 (6 PG-skipped), `build` 0.
- **Move:** Pivot off the saturated PG-pool and the just-touched HTTP-edge axes onto the SSRF thread
  with a genuine hardening finding: the consumer-portal one-shot test-send
  (`POST /portal/endpoints/:id/test`) ran on the **unguarded** `fetchTransport`. The JSON-API
  test-send, the worker, and system-events all ride `deliveryTransport` (the connection-time
  SSRF-guarded transport), but `createGateway` never passed `transport` to `createPortalHandler`, so
  it silently fell through to the `deps.transport ?? fetchTransport` default. The portal is the most
  externally-exposed surface (reachable by a tenant's own customers) and its registration-time static
  guard cannot catch a hostname that passes create-time validation then resolves to loopback /
  169.254.169.254 at test time — the exact DNS-rebinding case the connection-time guard exists for.
- **Changed:**
  - `runtime/gateway.ts`: pass `transport: deliveryTransport` into `createPortalHandler({...})`
    (parity with the API handler's line 566), with a comment recording why. The connect-timeout
    split comes along for free — it is baked into `deliveryTransport`.
  - `runtime/gateway.test.ts`: a regression test booting the real gateway with
    `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=false`, storing an endpoint at `http://localhost/hook`
    (a *hostname* → loopback; a literal IP would skip Node's lookup hook), minting a portal session
    over HTTP, and asserting the rendered test-send reports the `blocked_resolved_address` SSRF error.
- **Decisions:** Composition-root injection over a defaulted-to-guarded transport, matching the
  established worker/API pattern. Test asserts at the gateway level (the only layer that catches the
  wiring omission) via the real `node:http` server, not a handler-unit fake. Used `localhost` (not a
  literal private IP) because the connection-time guard fires only on DNS-resolved hosts.
- **Validation:** `tsc` 0; `vitest run` **1869** (+1; 6 PG-skipped, no flaky exit). Proved the test
  non-vacuous: with the wiring line commented out it **fails** on the `private or internal address`
  assertion (unguarded transport never reports the block), passes with it restored. `build` 0;
  `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Notes:** No `dist` smoke this tick — the guard is pure JS wiring with no runtime/ESM-specific
  behavior, and the integration test already exercises the production composition root through the
  real HTTP listener (unlike iter-0110's keep-alive *timer*, which needed a live socket to prove).
- **Next:** Audit the **dashboard** test-send / verify surfaces for the same transport-wiring parity;
  or add a distinct metrics label / audit reason code for the connect-timeout failure so operators can
  tell "unreachable" apart from a total-timeout; or the README error-code table matching the OpenAPI
  `Error.code` enum.

## 2026-05-25T02:45 · iter-0110 · GREEN · explicit-configurable-http-server-socket-timeouts

- **Baseline:** clean main @ `ac90e16` (iter-0109 pg-pool acquire-timeout counter). Verified
  green first: `tsc` 0, `vitest run` 1852 (6 PG-skipped), `build` 0.
- **Move:** Break the eight-tick PG-pool/DB-pressure tunnel (memory flags that axis SATURATED)
  and harden a *different* surface — the public HTTP edge. `createHttpServer` set **no** socket
  timeouts, implicitly inheriting Node's defaults: the Slowloris bounds were unconfigurable and,
  worse, the 5 s `keepAliveTimeout` default perpetuated the upstream-`502` keep-alive-reuse race
  for the active/active-behind-LB topology iter-0106 just documented.
- **Changed:**
  - `http/server.ts`: three exported defaults (`DEFAULT_HTTP_{KEEP_ALIVE,HEADERS,REQUEST}_TIMEOUT_MS`
    = Node's own `5000`/`60000`/`300000`) + `HttpServerOptions.{keepAliveTimeoutMs,headersTimeoutMs,
    requestTimeoutMs}`; `createHttpServer` now sets `server.{keepAliveTimeout,headersTimeout,
    requestTimeout}` explicitly (`option ?? default`).
  - `runtime/config.ts`: flat `http{KeepAlive,Headers,Request}TimeoutMs` on `GatewayConfig`
    (flat like `maxBodyBytes`, dodging the hand-built-smoke sub-object deref trap), read by a new
    `readHttpServerTimeouts` with a fail-fast cross-field check (headers <= request when both > 0).
    `0` disables each.
  - `runtime/gateway.ts` threads the three into the `createHttpServer` options; `index.ts`
    re-exports the defaults (parity with `DEFAULT_MAX_BODY_BYTES`).
  - `.env.example` + `docs/DEPLOY.md`: the three vars (config-drift guard enforces both) + a new
    `### Load-balancer keep-alive and timeouts` section with the ALB/nginx ordering rule
    (`keepAlive > LB idle`, `headers > keepAlive`).
- **Decisions:** Defaults == Node's, so **zero behavior change** out of the box — the leverage is
  configurability + the LB-coordination correctness fix + explicitness against future Node
  default drift, *not* a tightened default (which would risk regressing a slow legitimate upload).
  Flat config fields over a `worker`/`fanout`-style sub-object specifically to avoid the
  smoke-config crash ([[adding-a-config-var-has-hidden-requirements]]).
- **Validation:** `tsc` 0; `vitest run` **1868** (+16; 6 PG-skipped) — one flaky tinypool
  worker-exit on the first full run ([[vitest-tinypool-flaky-worker-exit]]), clean on re-run.
  `build` 0. **Live `dist` smoke:** booted `node dist/main.js` with
  `POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS=600`; an idle keep-alive socket closed after 1601 ms (vs the
  5000 ms Node default) → runtime enforcement confirmed; normal `GET /healthz` 200.
  `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Notes:** Exact property values are asserted in unit (server.test) + integration (gateway.test
  reads `gateway.httpServer.*`) tests; the dist smoke proves the knob bites at runtime. keep-alive
  is per-socket-timer enforced (prompt); headers/request are swept on `connectionsCheckingInterval`
  (30 s default), so sub-second header/request deadlines are coarse-grained — see Next.
- **Next:** Tighten the *default* `requestTimeout` for ingest (needs a payload-size-vs-link-speed
  argument first) or expose `connectionsCheckingInterval` (the sweep granularity bounding how
  promptly headers/request deadlines fire); or pivot off the HTTP-edge axis to a fresh
  correctness/data-loss review of the delivery worker.

## 2026-05-25T02:10 · iter-0109 · GREEN · pg-pool-acquire-timeout-counter-and-saturation-alert

- **Baseline:** clean main @ `eee8276` (iter-0108 `posthorn_pg_pool_errors_total`). Verified green
  first: `tsc` 0, `vitest run` 1847 (6 PG-skipped), `build` 0.
- **Move:** Close iter-0108's own "Next" — the *other* DB-pressure failure mode. iter-0108 made a
  severed *idle* connection observable; the saturation twin (a `pool.connect()` checkout that
  exhausts `connectionTimeoutMillis` because the pool is at `max`, or a stalled handshake) still
  failed requests *invisibly*. Add `posthorn_pg_pool_acquire_timeouts_total` so it is alertable.
- **Changed:**
  - `db/postgres.ts`: new `onAcquireTimeout` sink + exported pure `isPgAcquireTimeoutError` (matches
    pg-pool's two timeout messages — there is no error `code`). `createPostgresPool` wraps the pool's
    `connect` (the single seam every acquisition funnels through — `pool.query` calls `this.connect`
    internally), observing both the callback form (query) and promise form (txn checkout), counting
    the timeout then **re-throwing it unchanged**. Wrapper installed only when a sink is wired.
  - `metrics.ts`: `pgPoolAcquireTimeouts` counter + arrow-bound `recordPgPoolAcquireTimeout`, rendered
    as `posthorn_pg_pool_acquire_timeouts_total` (always present, `0` on SQLite).
  - `gateway.ts`: wire the sink → log + counter (admin path in `main.ts` left as-is: a CLI
    acquire-timeout already fails the command loudly, unlike the request-invisible idle error).
  - `monitoring/alerts.yml`: `PosthornPostgresAcquireTimeouts` (`rate(...[5m]) > 0`, per-`instance`).
  - `docs/DEPLOY.md`: counter row + multi-replica note; **reconciled** the stale alert table (said
    "four", listed 5, omitted iter-0108's `PosthornPostgresPoolErrors`) → now lists all **seven**.
- **Decisions:** Message-string match is the only signal pg gives (pinned to pg-pool 8.x, comment +
  unit-tested; a reword surfaces as the counter going quiet). No new `POSTHORN_*` var — always-on
  like `pgPoolErrors`. Wrapper *only observes*, never alters control flow, given its blast radius
  (every DB acquisition).
- **Validation:** `tsc` 0; `vitest run` **1852** ungated (+5; 6 PG-skipped). Against live Docker
  `postgres:16`: gated `postgres.test.ts` **11/11** incl. a real saturated-pool timeout firing the
  sink once + re-throwing unchanged, and a happy-path guard (query + checkout succeed, sink silent);
  full suite PG-enabled **2128/2128** (60 files — wrapper transparent to every store). `build` 0.
  **Compiled-`dist` smoke** vs Docker PG: production ESM wrapper 6/6 (happy path silent → saturate →
  timeout classified, re-thrown, sink fired once). `assert-gate-integrity.ps1` 0 (zero substrate
  edits); `validate-log-compliance.py` `[PASS]`.
- **Notes:** A gateway-HTTP `/metrics` trigger is impractical — the production timeout is a fixed
  10 s and the gateway's queries are sub-ms, so the pool never naturally stays saturated that long;
  the gateway *wiring* is covered by the PG-gated `createGateway` suite. The first full PG run threw a
  one-off tinypool "worker exited" ([[vitest-tinypool-flaky-worker-exit]]); clean on re-run.
- **Next:** Both DB-pressure failure modes (idle-loss + saturation) are now observable. A
  pool-utilization gauge (`in-use / max` at scrape time) would let operators see saturation
  *approaching* before timeouts fire; or a brief `/readyz` cache if a high LB probe cadence makes the
  per-request `SELECT 1` load undesirable.

## 2026-05-25T01:35 · iter-0108 · GREEN · pg-pool-errors-counter-and-flapping-db-alert

- **Baseline:** clean main @ `0f95e79` (iter-0107 crash-safe PG pool + `/readyz`). Verified
  green: `tsc` 0, `vitest run` 1845 (6 PG-skipped), `build` 0.
- **Move:** Close iter-0107's own headline gap — the pool `'error'` it made *non-fatal* now
  leaves only a log line, so a flapping managed-Postgres is invisible to metrics/alerting.
  Add `posthorn_pg_pool_errors_total` so the recoverable-but-request-invisible event becomes
  observable and alertable.
- **Changed:**
  - `metrics.ts`: new `pgPoolErrors` counter on `MetricsRegistry` + arrow-bound
    `recordPgPoolError`; rendered as `posthorn_pg_pool_errors_total` (always present, `0` on
    SQLite — consistent with the "every series always present" design).
  - `gateway.ts`: construct `metrics` *before* `openStoreBackend` (mirrors iter-0107's logger
    move) and thread it in; the PG pool `onError` now logs **and** counts. `main.ts` admin path
    left log-only (short-lived CLI, no `/metrics`).
  - `monitoring/alerts.yml`: new `posthorn.database` group — `PosthornPostgresPoolErrors` fires
    on `rate(...[5m]) > 0`, per-`instance` (the counter is per-replica; do not aggregate).
  - Docs: DEPLOY.md counters-table row + a per-replica monitoring note (alert per-instance).
- **Decisions:** No new `POSTHORN_*` var — always-on like `/readyz`, keeping the config↔docs
  surface clean. Unlabeled single series (a pool `'error'` carries no useful dimension). Rendered
  on SQLite too (stays `0`) so dashboards/alerts don't break when switching backends.
- **Validation:** `tsc` 0; `vitest run` **1847** (+2 metric tests; 6 PG-skipped, no flaky exit)
  incl. the `/metrics` integration test; `build` 0; `assert-gate-integrity.ps1` 0 (zero substrate
  edits); `validate-log-compliance.py` `[PASS]`. **Live DB-down smoke** on compiled `dist` vs
  Docker `postgres:16`: counter `0` → `docker stop` (pool logged 3× "postgres pool error", process
  **survived**, `/readyz` 503, `/healthz` 200) → `docker start` (`/readyz` auto-recovered to 200) →
  `posthorn_pg_pool_errors_total` = **3**. 8/8 checks.
- **Next:** A pool-saturation / acquisition-timeout counter (the iter-0105 `connectionTimeoutMillis`
  path) for the other "DB pressure" failure mode; or a brief `/readyz` cache if a high LB probe
  cadence makes the per-request `SELECT 1` load undesirable.

## 2026-05-25T01:10 · iter-0107 · GREEN · readyz-probe-and-crash-safe-pg-pool-error-handler

- **Baseline:** clean main @ `f814eca` (iter-0106 active/active deploy guide). Verified
  green: `tsc` 0, `vitest run` 1840 (6 PG-skipped), `build` 0.
- **Move:** Close the readiness gap iter-0106 explicitly flagged (`/healthz` is liveness,
  *not* a DB probe) by adding a backend-gated `/readyz` — and, while validating it against
  a live Postgres being killed, fix the **P0 crash** that drop exposed: the gateway dies on
  any idle-connection loss.
- **Changed:**
  - **Crash-safe PG pool (the headline).** `pg.Pool` emits `'error'` when an *idle* pooled
    connection is severed server-side (DB restart/failover, `pg_terminate_backend`, idle
    timeout, network blip); Node re-throws an unlistened `'error'`, so a routine managed-PG
    maintenance event **crashed the whole process**. `createPostgresPool` now always attaches
    a listener (new `PostgresPoolOptions.onError`); the error is recoverable (pg discards the
    broken client, reopens on next checkout), so it is logged + swallowed. Wired to the
    structured logger in `gateway.ts` (logger now built before the backend; `openStoreBackend`
    takes it) and to the console sink in `main.ts`'s admin path.
  - **`GET /readyz`** (unauthenticated): `200 {"status":"ready"}` / `503 {"status":"not_ready"}`,
    gated on a new `StoreBackend.ping()` — `SELECT 1` through the shared pool for Postgres
    (bounded by the iter-0105 acquisition timeout), immediate-success for embedded SQLite (no
    out-of-process dependency; readiness ≡ liveness). Added to `API_ROUTE_KEYS` + handler +
    OpenAPI doc (`Readiness` schema, `security: []`); probe access logged at `debug` like
    `/healthz`/`/metrics`, but a `503` rides the `≥500 → error` branch so a not-ready replica
    stays visible. Docs: README route table, DEPLOY (liveness-vs-readiness split, k8s
    `readinessProbe` on `/readyz`, quick-start curl), `.env.example` log-level note.
- **Decisions:** No new config var (readiness is always-on; no config↔docs drift). Probe
  error never echoed on the unauthenticated body (no backend detail leak). Landed both in one
  tick — the crash fix is the prerequisite that makes `/readyz` observable (a dead process
  serves nothing), so they are one coherent "survive a DB outage" change.
- **Validation:** `tsc` 0; `vitest run` **1845** (+5; 6 PG-skipped, no flaky exit). Against
  live Docker `postgres:16`: gateway+postgres PG-gated suites **23/23** incl. `/readyz` 200 via
  real `SELECT 1`. **Live crash smoke on compiled `dist`:** PG up → `/readyz` 200; PG killed →
  process **survives** (logs `postgres pool error`, previously fatal), `/readyz` 503, `/healthz`
  stays 200; PG restored → `/readyz` auto-recovers to 200 in ~2 s; SIGTERM → clean exit. `build`
  0; `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** Consider a pool `'error'` counter/gauge (`posthorn_pg_pool_errors_total`) so a
  flapping database is alertable, not just logged; or a brief readiness-cache (e.g. 1 s) if a
  high-frequency LB probe cadence makes the per-request `SELECT 1` load undesirable.

## 2026-05-25T00:50 · iter-0106 · GREEN · multi-replica-active-active-deploy-guide

- **Baseline:** clean main @ `541cd5b` (iter-0105 bounded the PG pool max + acquisition
  timeout). Verified green first: `tsc --noEmit` 0, `vitest run` 1840 (6 PG-skipped),
  `npm run build` 0; `assert-gate-integrity.ps1` 0.
- **Move:** Write the operator guide for the one capability the entire iter-0103→0105 Postgres
  investment exists to enable but never documented — **running more than one gateway replica
  active/active**. The machinery (deployable PG backend, lock/idle timeouts, bounded pool) is in
  and correct; an operator who set `POSTHORN_DATABASE_URL` still had no instructions for scaling
  out, and the Monitoring section silently assumed a single process.
- **Changed:** New `## Running multiple replicas (active/active)` section in `docs/DEPLOY.md`,
  grounded in a read of how every background loop actually coordinates:
  - Per-subsystem coordination table — worker (`FOR UPDATE SKIP LOCKED` lease, verified
    `postgres-queue.ts:207`), idempotency unique index, endpoint-health fold (transactional
    `SELECT … FOR UPDATE`, `postgres-endpoint-store.ts:251`), fan-out dispatcher (uncoordinated
    but at-least-once / duplicate-safe), pruner (idempotent `DELETE … < cutoff`), monthly quota
    (per-request UTC-month count, no reset job).
  - A Docker-Compose worked example (3 replicas + shared `postgres:16` + nginx `resolver`
    round-robin), a k8s `Deployment` sketch, LB/health-check guidance (`/healthz` is a static
    liveness signal, not a DB probe), and the `replicas × POSTHORN_PG_POOL_MAX ≤ max_connections`
    budget example.
  - **Monitoring a fleet** — the load-bearing nuance: counters are per-replica (sum them), but
    the queue-backed gauges are read from the shared store at scrape time, so every replica
    reports the *same* value — `max without(instance)`, never `sum` (else N× the truth) — plus
    the `monitoring/alerts.yml` adjustments (gauge alerts fire per-replica; failure-rate rule is
    per-replica).
  - TOC fixed (it was also missing the existing PostgreSQL-backend entry) + a forward-ref note
    on the single-process Monitoring intro.
- **Decisions:** Docs-only — verified each operational claim against source rather than asserting
  it; no code change, so no new `POSTHORN_*` var and no config↔docs drift. Chose this over a 5th
  consecutive PG-pool knob (`idleTimeoutMillis`/`maxLifetimeSeconds`, diminishing returns) because
  the undocumented scale-out story blocks *all* multi-replica adoption — the capstone that makes
  the PG investment usable.
- **Validation:** `vitest run src/runtime/config.test.ts` 121/121 (the config↔docs drift guard
  reads the edited DEPLOY.md — every var still documented); `assert-gate-integrity.ps1` 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`. Docs-only: the iter-0105 code baseline
  (tsc 0 · vitest 1840 · build 0) is unchanged and stands.
- **Next:** Optional PG pool `idleTimeoutMillis` / `maxLifetimeSeconds` recycling knobs behind a
  connection-capping proxy; or commit a runnable k8s manifest / Helm values under `deploy/` to
  complement the in-doc sketch.

## 2026-05-25T00:30 · iter-0105 · GREEN · postgres-pool-max-and-connection-acquisition-timeout

- **Baseline:** clean main @ `07ca4f1` (iter-0104 added the per-connection lock +
  idle-in-txn GUC timeouts). Verified green first: `tsc --noEmit` 0, `vitest run`
  1831 (7 PG-skipped), `npm run build` 0.
- **Move:** Bound the shared Postgres pool — the last "wait forever" default on the PG
  path. `createPostgresPool` was a bare `new Pool({ connectionString, options })`: pg's
  default `max: 10` (unsizable — N replicas × 10 can exhaust a small managed Postgres'
  `max_connections`, or starve a single busy replica) and, worse, `connectionTimeoutMillis: 0`
  — a checkout against a *saturated* pool waits **indefinitely**. That is the
  pool-acquisition twin of the infinite `lock_timeout` iter-0104 just closed, and it would
  re-hang the whole gateway under connection starvation *despite* the statement-level timeouts.
- **Changed:**
  - `db/postgres.ts`: `createPostgresPool(url, { max?, connectionTimeoutMillis? })`. `max`
    defaults to new `DEFAULT_PG_POOL_MAX` (10 = pg's own default, so unset is a no-op);
    `connectionTimeoutMillis` defaults to fixed `POSTGRES_CONNECTION_TIMEOUT_MS` (10 s),
    bounding both new-connection establishment and the saturated-pool queue wait.
    Positive-int / non-negative-finite `RangeError` guards.
  - `config.ts`: new `POSTHORN_PG_POOL_MAX` → `databasePoolMax` (int ≥ 1, default 10),
    threaded into the pool at both creation sites — `gateway.ts` composition root and
    `main.ts` admin CLI. `index.ts` exports `DEFAULT_PG_POOL_MAX` + `PostgresPoolOptions`.
  - Docs: `.env.example` + a DEPLOY.md table row & "Connection pool sizing" note (the
    config↔docs drift guard enforces both).
- **Decisions:** Pool *max* is an operator var (a genuine per-deploy capacity call against the
  shared server budget); the acquisition *timeout* is a fixed safety bound (a constant, not an
  env var — same call as iter-0104's GUC timeouts, keeping the config↔docs surface to one new
  var). `connectionTimeoutMillis` stays an injectable option only so a test can prove fast-fail
  without the 10 s production wait.
- **Validation:** `tsc` 0; `vitest run` **1840** (6 PG-skipped files; +3 ungated pool-config
  tests now run in the gate, +4 config). Against live Docker Postgres 16: `postgres.test.ts`
  6/6 — incl. a new `max:1` saturation test proving a checkout fails with `timeout exceeded
  when trying to connect` in ~250 ms, never hangs — and gateway PG e2e 21/21;
  `smoke-postgres.mjs` on the compiled `dist` **9/9**. `npm run build` 0;
  `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** `idleTimeoutMillis` / `maxLifetimeSeconds` pool knobs for connection recycling
  behind a transient-NAT proxy; or the DEPLOY.md active/active topology guide.

## 2026-05-25T00:15 · iter-0104 · GREEN · postgres-lock-and-idle-txn-timeouts

- **Baseline:** clean main @ `d682435` (iter-0103 wired the PG backend into the gateway).
  Verified green first: `tsc --noEmit` 0, `vitest run` 1831 (6 PG-skipped), `npm run build` 0.
- **Move:** Give the freshly-deployable Postgres backend the connection-level safety
  timeouts that the multi-replica path it exists for actually needs — the analogue of
  the SQLite busy-timeout added in iter-0102. `createPostgresPool` was a bare
  `new Pool({ connectionString })`, and Postgres defaults both `lock_timeout` and
  `idle_in_transaction_session_timeout` to *infinite*. The PG queue's single-task
  mutators (`complete`/`fail`/`retry`/`cancel`/`postpone`) take a plain `FOR UPDATE`
  (no `SKIP LOCKED`), so a manual API `retry`/`cancel` colliding with a worker's `fail`
  on the same row would block **forever**, pinning a pooled connection; a session left
  idle mid-`BEGIN` would hold its row locks forever, blocking every other replica.
- **Changed:**
  - `db/postgres.ts`: new `POSTGRES_LOCK_TIMEOUT_MS` (5 s, matching the SQLite
    busy-timeout) and `POSTGRES_IDLE_IN_TXN_TIMEOUT_MS` (10 s), applied to every pooled
    connection via the `-c …` startup `options` parameter — set at handshake, so no
    statement ever runs before the timeouts and there is no extra round-trip.
  - `db/postgres.test.ts` (new, PG-gated): asserts both GUCs reach the backend
    (`pg_settings`), and a real two-client `FOR UPDATE` contention test proving the
    blocked statement is cancelled with `55P03` within the bound — never hangs.
  - `DEPLOY.md`: "Concurrency safety timeouts" note in the PostgreSQL backend section.
- **Decisions:** Startup `options` param, not a `pool.on('connect')` SET — empirically
  the SET path emits pg's `client.query()`-while-busy DeprecationWarning (removed in
  pg@9) and races the first query; `options` is race-free and future-proof. Fixed
  constants, not new `POSTHORN_*` vars (same call as iter-0102's busy-timeout — keeps
  them off the config↔docs drift surface). **No `statement_timeout`**: the data pruner's
  bulk `DELETE`s can legitimately run long; both chosen timeouts fire only on a *blocked*
  or *stalled* statement, never on one making progress.
- **Validation:** `tsc` 0; `vitest run` **1831** (7 PG-skipped, +1 file). Against live
  Docker Postgres 16: full `vitest run` **2105/2105**, 0 skipped (incl. the 2 new tests).
  `npm run build` 0; `scripts/smoke-postgres.mjs` on the compiled `dist` vs real PG
  **9/9**. `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** A `POSTHORN_PG_POOL_MAX` knob (the pool currently uses pg's default max 10,
  likely too low for a busy multi-replica deploy); or a DEPLOY.md active/active topology
  guide for the PG horizontal-scale path.

## 2026-05-24T23:59 · iter-0103 · GREEN · wire-postgres-backend-into-the-gateway

- **Baseline:** clean main @ `f4710f2` (iter-0102). Verified green first:
  `tsc --noEmit` 0, `vitest run` 1823, `npm run build` 0.
- **Move:** Make the long-advertised "Postgres optional" backend *actually deployable*.
  The six `Postgres*Store`s were implemented and conformant, but the gateway composition
  root + config could only ever open SQLite — an operator had no way to *select*
  Postgres, so a headline wedge ("none (SQLite) / PG optional") was unreachable. First
  proved the foundation: spun up Docker Postgres 16 and ran all six PG conformance
  suites — **270/270 pass** (the store layer was genuinely byte-for-byte conformant,
  just unwired).
- **Changed:**
  - `config.ts`: new `POSTHORN_DATABASE_URL` (`databaseUrl`) — a validated
    `postgres:`/`postgresql:` URL selects the PG backend; unset = SQLite (default).
  - `gateway.ts`: extracted `openStoreBackend(config)`, the *only* place the backend is
    chosen — the PG branch opens one shared `pg.Pool` + the six PG stores. `start()` now
    `await`s an async `initialize()` (PG schema DDL; no-op for SQLite) before listening;
    `stop()` `await`s `dispose()` (close SQLite handles / drain the pool). Started-log
    gains `backend`; the credential-bearing PG URL is never logged.
  - `main.ts`: the `admin` CLI opens a `PostgresAppStore` on the same DB when the URL is
    set, so CLI and gateway can't provision into different stores.
  - Docs: `POSTHORN_DATABASE_URL` in `.env.example` + a `DEPLOY.md` "PostgreSQL backend"
    section (the config↔docs drift guard enforces both).
- **Decisions:** Backend chosen by *presence of the connection URL* (the `DATABASE_URL`
  convention), not a separate enum — one var, no invalid states. No cross-store FKs in
  the PG schemas, so `initialize()` order is free. The pool is owned by the composition
  root (one shared pool; PG slots are precious); `dataDir` is unused on PG.
- **Validation:** `tsc` 0; `vitest run` **1831** (+8 config tests; 6 PG files still skip
  without a DB). With a live Postgres: +2 PG-gated gateway e2e tests (boot→schema→
  deliver→**verify**; restart-persistence on the shared DB) pass. `npm run build` 0. New
  `scripts/smoke-postgres.mjs` on the compiled `dist` vs real PG: **9/9** — proving the
  `pg` CJS-in-ESM interop under the real Node loader. Admin CLI verified cross-process on
  PG. `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py`
  `[PASS]`.
- **Notes:** Hit the known flaky tinypool "Worker exited unexpectedly" on two full runs;
  a re-run was clean 1831/1831 (not red).
- **Next:** Postgres `lock_timeout`/`statement_timeout` for parity with the SQLite
  busy-timeout; or a DEPLOY.md multi-replica active/active topology guide for the new PG
  horizontal-scale path.

## 2026-05-24T23:55 · iter-0102 · GREEN · sqlite-busy-timeout-for-multi-process-contention

- **Baseline:** clean main @ `f5930ab` (iter-0101 log rotation). Verified green first:
  `tsc --noEmit` 0, `vitest run` 1819, `npm run build` 0.
- **Move:** Close the one conspicuous gap in the SQLite connection setup — no `busy_timeout`.
  `node:sqlite` defaults it to 0, so a write that loses a lock race fails *immediately* with
  `SQLITE_BUSY` ("database is locked") rather than waiting. Posthorn's own single process never
  contends (one synchronous connection per store file), but the product *supports* concurrent
  multi-process access: the `posthorn admin` CLI opens the same `apps.db` while the gateway runs
  (`resolveLocations`), rolling deploys briefly overlap two containers on the shared data dir, and
  online backup tooling (`.backup`, Litestream) takes locks — there the loser failed spuriously.
- **Changed:**
  - New `src/db/sqlite.ts`: `SQLITE_BUSY_TIMEOUT_MS` (5 s) + `applyConnectionPragmas(db,{foreignKeys?})`
    — single source of truth for the WAL + synchronous=NORMAL + busy-timeout opening sequence the six
    stores each duplicated inline; foreign-key enforcement stays opt-in per store.
  - Refactored all six SQLite stores (apps, endpoints, messages, attempts, event-types, queue) onto
    the helper. Behaviour-preserving: WAL/synchronous unchanged; FK passed `true` exactly where each
    store set it before (node:sqlite already defaults FK on, so the three that omitted it are
    unaffected); the only new effect is the busy-timeout.
  - `src/db/sqlite.test.ts` (+4) and a `docs/DEPLOY.md` note beside the online-backup guidance.
- **Decisions:** Hard-coded constant, not a new `POSTHORN_*` env var — it belongs with the other
  non-tunable durability pragmas and avoids the config/doc-drift surface for a value operators never
  need to change. 5 s is the standard server-SQLite recommendation; the synchronous event-loop block
  is bounded and only paid under real, rare contention. No public API/SDK/OpenAPI change — the helper
  is internal to the store layer (not re-exported from `index.ts`).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1823** (+4; 53 files, 6 PG-skipped, no flaky
  exit) — incl. the file-backed restart-persistence integration test exercising the new pragmas
  through the real composition root; `npm run build` 0; `assert-gate-integrity.ps1` 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** Mirror the failure-reason column onto the admin dashboard message-detail deliveries
  (`dashboard/views.ts`) for parity with the tenant view; or review a Postgres-side `lock_timeout`
  for the optional PG backend.

## 2026-05-24T23:45 · iter-0101 · GREEN · rotate-canonical-log-into-monthly-archive

- **Baseline:** clean main @ `2ebfab1` (iter-0100 tenant failure-reason column). `docs/LOG.md`
  stood at 994 lines / 83 KB — under the 250 KB ceiling but one product entry short of the
  1,000-line rotation boundary the last three ticks flagged (iter-0098/0099/0100 Notes).
- **Move:** Pre-emptively rotate the active ledger before the next code entry crosses the cap, so
  every commit lands a compliant, lean `docs/LOG.md` (Axiom 2 / checklist step 6 state hygiene).
- **Changed:**
  - Moved the 25 canonical-schema entries (`iter-0076`–`iter-0100`) verbatim out of `docs/LOG.md`
    into `docs/log/2026-05.md`, the existing monthly archive, placed **above** the legacy `LOOP_LOG`
    section so the file stays globally newest-first across both schema generations.
  - Rewrote the archive's provenance banner to describe both generations it now holds (canonical
    0076–0100 on top, legacy 1–75 below) and to record that the canonical block rotated here
    at iter-0101.
  - `docs/LOG.md` now carries only the Page-1 rules header, the `== LOG-ANCHOR ==`, and this entry.
- **Decisions:** Archived rather than truncated — Axiom 3: every prior entry is preserved intact,
  just relocated (no entry was rewritten; only the archive's own banner prose changed). Reused the
  `docs/log/YYYY-MM.md` monthly path the substrate documents and iter-0076 established, since all of
  2026-05's history belongs in one month archive. Started the active log "fresh" (header + anchor +
  newest entry) mirroring iter-0076, as the rules mandate no minimum retained-entry count and the
  full history is one `cat` away.
- **Validation:** `python scripts/validate-log-compliance.py` → `[PASS]` (anchor present, sole
  entry heading well-formed, no duplicate id, no >2000-char line); `pwsh
  scripts/assert-gate-integrity.ps1` → 0 (zero substrate edits). Docs-only: the iter-0100 green
  code baseline (tsc 0 · vitest 1819/1819 · build 0) is unchanged and still stands.
- **Notes:** The validator does not itself enforce the line cap; this rotation honors doctrine rule
  #5 and checklist step 6 proactively so the active ledger never lands oversized.
- **Next:** SQLite `busy_timeout` hardening so multi-process access (the `posthorn admin` CLI on
  `apps.db`, rolling-deploy file overlap, online backup tooling) waits briefly instead of failing
  with "database is locked"; or mirror the failure-reason column onto the admin dashboard.
