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

## 2026-05-24T22:36 · iter-0095 · GREEN · failure-reason-triage-filter-on-deliveries

- **Baseline:** clean main @ `e481793` (iter-0094 denormalized `failureReason` onto the delivery
  task). Verified green first: `tsc --noEmit` 0, `vitest run` **1779**, `npm run build` 0,
  `assert-gate-integrity.ps1` 0.
- **Move:** Land the payoff iter-0094 teed up across the iter-0091→0094 Next lists — a
  `?failureReason=` filter on `GET /v1/deliveries`. The structured reason was denormalized onto
  `DeliveryTask` last tick *specifically* as the column this filter indexes; it answers "show me every
  delivery that failed with `connection_refused`" in one query (the operator's failure-triage view) and
  composes with the existing `?status=` filter.
- **Changed:**
  - `queue/delivery-queue.ts`: `ListByAppOptions.failureReason?` (closed-domain, composes with `status`).
  - `queue/in-memory-queue.ts`: one composing `.filter`.
  - `queue/sqlite-queue.ts`: replaced the 4 precompiled `listByApp` statements with a bounded
    prepared-statement cache keyed by composed SQL (≤ 8 shapes) + a dynamic WHERE builder; new
    `idx_delivery_tasks_app_reason (app_id, failure_reason, created_at, id)` partial index created in the
    failure_reason migration (after the column is guaranteed present).
  - `queue/postgres-queue.ts`: same dynamic WHERE (it already built inline) + the companion index after
    the `ADD COLUMN IF NOT EXISTS failure_reason` ALTER.
  - `http/api.ts`: `parseListByAppParams` parses/validates `?failureReason=` via `isDeliveryFailureReason`
    (unknown → 400); `sdk/client.ts`: `ListDeliveriesParams.failureReason` + query; `http/openapi.ts`: the
    `failureReason` query param (enum) on `listDeliveries`; README row updated.
  - Tests: +3 conformance (filter+exclude-never-failed, composes-with-status, paginates) ×2 live backends
    = +6; +2 HTTP (filter/compose/exclude + 400); +1 SDK (query string); `smoke-failure-reason` +7 (reason
    isolation + 400 through compiled ESM).
- **Decisions:** Swapped the precompiled `listByApp` statements for a small cached dynamic builder rather
  than enumerate 8 status×reason×cursor variants — `listByApp` is a cold operator path, and the cache
  keeps the prepare-once discipline. SQLite index is partial (`WHERE app_id IS NOT NULL`), mirroring
  `idx_delivery_tasks_app_status`; the status+reason combo rides either single-column index and filters
  the rest (fine off the hot path). Filter values are validated against the closed reason set *and*
  parameterized.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1788** (+9; 52 files, 6 PG-skipped, no flaky exit);
  `npm run build` 0; `node scripts/smoke-failure-reason.mjs` **20/20** (+7, real failures filtered by
  reason through compiled ESM on file-backed node:sqlite); `assert-gate-integrity.ps1` 0; `local-gate.ps1`
  PASS; `validate-log-compliance.py` `[PASS]`.
- **Next:** A `posthorn_deliveries_by_reason` point-in-time backlog gauge off the denormalized column
  (complements the per-tick lifetime failure tally); surface the structured reason as a column/filter in
  the tenant dashboard delivery rows; or honor `X-Forwarded-Proto` so HSTS emits only on requests believed
  to have arrived over HTTPS.

## 2026-05-24T22:11 · iter-0094 · GREEN · denormalize-failure-reason-onto-delivery-task

- **Baseline:** clean main @ `bea57cf` (iter-0093 CSP confirmations). Verified green first:
  `tsc --noEmit` 0, `vitest run` **1771/1771**, `npm run build` 0, `assert-gate-integrity.ps1` 0.
- **Move:** Land the foundation of the long-deferred "core-FSM denormalization" carried across the
  iter-0089→0093 Next lists: the structured `failureReason` enum lived only on the per-attempt audit
  record (iter-0088), so `GET /v1/deliveries` exposed *why* a delivery failed only via the free-text
  `lastError` or by drilling into the attempt log. Denormalize the latest classified reason onto the
  `DeliveryTask` itself and surface it on the delivery API — one-query failure triage for operators,
  and the column the future `?failureReason=` filter will index. Filter deferred to keep this green.
- **Changed:**
  - `delivery/failure-reason.ts`: new `isDeliveryFailureReason` guard (one source of truth for the
    closed domain — the filter will reuse it).
  - `queue/delivery-queue.ts`: `DeliveryTask.failureReason` + optional `FailInput.failureReason`;
    `normalizeFailInput` validates it (unknown code → `TypeError`); `applyFailure` sets it,
    `applyManualRetry` clears it to `null`. Other transitions preserve it via `...task` — exactly
    mirroring `lastError`'s reducer lifecycle (set on fail, wiped on revive, kept on claim/success).
  - `worker/delivery-worker.ts`: `#settleFailure` threads the already-classified reason into `fail()`.
  - All three backends: `failure_reason` column + idempotent additive migration (sqlite STRICT
    `ALTER`, postgres `ADD COLUMN IF NOT EXISTS`, in-memory snapshot) + insert/persist/hydrate.
  - `http/api.ts` `deliveryView`+`endpointDeliveryView`, `http/openapi.ts` `Delivery` schema (enum +
    required), `sdk/client.ts` 3 delivery view types — `failureReason` now in the public contract.
  - Tests: +conformance (round-trip, latest-wins, reset-to-null, reject-unknown, cleared-on-retry,
    recorded-on-dead-letter) ×2 live backends = +8; `smoke-failure-reason.mjs` +3 (denormalized
    reason on `GET /v1/deliveries` for http_5xx + connection_refused, and persisted across restart).
- **Decisions:** Denormalize as a task field (worker-supplied classification) rather than extend the
  `DeliveryState` reducer — the reason isn't derivable from FSM inputs, and the overlay-spread already
  gives correct preserve/clear semantics for free. Split off the query filter (additive, lower-risk
  once the indexed column exists) so the migration-bearing change lands green on its own.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1779/1779** (+8; 52 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `node scripts/smoke-failure-reason.mjs` **13/13** (+3, real failures
  through compiled ESM on file-backed node:sqlite incl. restart); `smoke-portal-delivery` 12/12 +
  `smoke-dashboard` 32/32 (no regression); `assert-gate-integrity.ps1` 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`.
- **Next:** Add the `?failureReason=` filter on `GET /v1/deliveries` (`ListByAppOptions.failureReason`
  + `idx_delivery_tasks_app_reason` partial index + parse/validate via `isDeliveryFailureReason`) —
  the payoff this foundation enables; or surface the structured reason in the portal/dashboard
  delivery rows; or a `posthorn_deliveries_by_reason` gauge off the denormalized column.

## 2026-05-24T22:05 · iter-0093 · GREEN · csp-safe-destructive-action-confirmations

- **Baseline:** clean main @ `7799e55` (iter-0092 HSTS). Verified green first: `tsc --noEmit` 0,
  `vitest run` **1761/1761** (52 files, 6 PG-skipped, no flaky exit), `npm run build` 0,
  `assert-gate-integrity.ps1` 0. Audited the three HTML view files for non-`esc()` / wrong-context
  interpolation — the standing iter-0089/0090/0091/0092 Next residual.
- **Move:** The audit found a class defect. iter-0090's dashboard/portal CSP `script-src 'none'`
  **silently disabled all three inline `onsubmit="return confirm(...)"` guards** (delete app, delete
  endpoint, archive event type) — CSP blocks inline event handlers, so each destructive form had been
  submitting on the first click with **no prompt**. The admin one was additionally a **latent XSS
  sink**: it interpolated user-controlled `app.name` into a JS string, and `esc()` (an HTML-entity
  encoder) does *not* neutralize a JS-string-context breakout — the HTML parser decodes `&#39;` back
  to `'` before the handler runs, so a name like `'+alert(document.cookie)+'` would execute (only the
  CSP that broke the handler was saving it). Replace all three with server-rendered confirmation
  interstitials: CSP-safe (zero JS), restoring the prompt, and removing the JS-context interpolation.
- **Changed:**
  - `dashboard/views.ts`: delete control on the app-detail page is now a link to a new
    `appDeleteConfirmPage(app)` (GET interstitial — app name in HTML-text context, `esc()`-correct;
    a POST form for "Yes, delete" + a Cancel link). `dashboard/handler.ts`: new route
    `GET /dashboard/apps/:id/delete` (auth-gated, 404 on unknown). POST delete route unchanged.
  - `portal/portal-views.ts`: `portalEndpointDeleteConfirmPage` + `portalEventTypeArchiveConfirmPage`;
    the endpoint-detail delete button and event-type archive button become links to them.
    `portal/portal-handler.ts`: new `GET /portal/endpoints/:id/delete` (tenant-scoped, cross-tenant
    404) + `GET /portal/event-types/:id/archive` (404 if no event-type store / unknown id).
  - `http/security-headers.ts`: corrected the module doc — its "zero `<script>`" claim now explicitly
    covers "no inline event handlers", documenting *why* destructive confirmations are server-rendered
    (so `script-src 'none'` holds without silently disabling them).
  - +10 unit tests (5 admin, 5 portal: confirm renders + does-not-mutate + no-inline-JS + 404 paths +
    a JS-breakout-name-is-escaped regression); `smoke-dashboard.mjs` +6 confirm-page checks.
- **Decisions:** Kept the hard CSP (`script-src 'none'`) and removed the JS instead of relaxing it to
  `'unsafe-inline'` — output-correctness over weakening the header. The confirm GET is a pure render
  (no mutation), safe under prefetch. Fixed all three together (one defect class) so the codebase's
  no-JS invariant is actually true and the header comment is accurate end-to-end.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1771/1771** (+10; 52 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `node scripts/smoke-dashboard.mjs` **32/32** (+6 — the GET confirm renders
  through compiled ESM on a real socket, carries no `onsubmit`, and does not delete the app);
  `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** Add a portal-delivery dist smoke check for the new endpoint-delete confirm (admin is the
  only one smoke-covered); or thread the structured `failureReason` into a `?failureReason=` triage
  filter on `GET /v1/deliveries` (the long-deferred core-FSM denormalization); or honor an upstream
  `X-Forwarded-Proto` so HSTS is emitted only on requests believed to have arrived over HTTPS.

## 2026-05-24T21:39 · iter-0092 · GREEN · hsts-response-header-behind-config-flag

- **Baseline:** clean main @ `5be3727` (iter-0091 no-store cache-control), recorded green
  `vitest run` **1737/1737**; verified green first: `tsc --noEmit` 0, `vitest run` 1737, `npm run
  build` 0, `assert-gate-integrity.ps1` 0. SSRF guard + Standard-Webhooks signature verify audited
  en route — both thorough (no latent vuln); dashboard/portal views are `esc()`-disciplined.
- **Move:** Land the standing Next #1 carried across iter-0090/0091 — `Strict-Transport-Security`
  (HSTS) behind a config flag, with the TLS-termination assumption documented. The service emitted
  per-surface CSP/XFO/cache headers but **no** transport-pinning header, so a network attacker could
  SSL-strip the first request. HSTS is dangerous to get wrong (an over-long `max-age` locks a domain
  out of plain HTTP for the whole window), so it is **opt-in, off by default**.
- **Changed:**
  - `http/security-headers.ts`: new `HstsPolicy` + pure total `hstsHeaderValue(policy)` →
    `max-age=…; includeSubDomains; preload` or `null` (disabled when `maxAgeSeconds <= 0`).
    `securityHeadersForPath(path, hsts?)` now merges the STS value onto **every** surface (API
    included — HSTS governs the origin's transport, not a response's content), refactored to build
    one object then conditionally add the header.
  - `http/server.ts`: `HttpServerOptions.strictTransportSecurity?` threaded through `serve()` into
    the single `securityHeadersForPath` call, so all exits (incl. the 413/400 early ones) stamp it.
  - `runtime/config.ts`: `GatewayConfig.hsts: HstsPolicy`; `readHstsConfig` reads
    `POSTHORN_HSTS_MAX_AGE`/`_INCLUDE_SUBDOMAINS`/`_PRELOAD` with fail-fast validation (a modifier
    needs a non-zero max-age; `preload` needs `includeSubDomains` + max-age ≥ 1 yr per the
    preload-list rules). `runtime/gateway.ts`: precompute `hstsHeaderValue(config.hsts)` once; a
    guard (`config.hsts ? … : null`) degrades a hand-built config that omits it to HSTS-off.
  - Docs: `.env.example` + `docs/DEPLOY.md` (config table rows + a new "HSTS" subsection under
    Security hardening documenting the TLS-termination assumption + ramp-up/one-way-door warning).
  - +tests (24): `hstsHeaderValue` + per-surface merge (security-headers), socket-level present/
    absent on every surface (server), config parse + 3 fail-fast rejections (config); new
    `scripts/smoke-hsts.mjs`.
- **Decisions:** HSTS rides on **all** surfaces (unlike CSP/XFO) — it's a transport assertion about
  the origin, inert on the plain-HTTP probe and honored over the proxy's HTTPS hop. Off-by-default
  and fail-fast on impossible preload configs (a `preload` that can't satisfy the list rules is a
  silent no-op otherwise — rejected at boot, matching the codebase's fail-loud config posture). Used
  a runtime guard in the gateway rather than editing the 7 hand-built smoke configs: it makes an
  absent `hsts` degrade gracefully, consistent with how the gateway already tolerates other
  incomplete hand-built configs (e.g. `smoke-logging` omits `connectTimeoutMs`).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1761/1761** (+24; 52 files, 6 PG-skipped, no
  flaky exit); `npm run build` 0; `node scripts/smoke-hsts.mjs` **20/20** (pure builder + merge,
  config validation incl. preload rejection, and the configured header on the wire on every surface
  vs. absent by default, through compiled ESM on 127.0.0.1); `smoke-logging` 22/22 + `smoke-failure-
  reason` 10/10 (no regression from the gateway guard); `assert-gate-integrity.ps1` 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Notes:** The `config.test.ts` doc-coverage guard Proxy-probes `loadConfig` and requires every
  read `POSTHORN_*` key to appear in **both** `.env.example` and `docs/DEPLOY.md` — adding the three
  HSTS vars forced (and verified) their documentation.
- **Next:** Optionally let the gateway honor an upstream `X-Forwarded-Proto` so HSTS is emitted only
  on requests it believes arrived over HTTPS (belt-and-suspenders vs. the proxy stripping it); audit
  the admin/tenant dashboard views for any non-`esc()` interpolation (iter-0089 residual, still
  unverified by reading); or the long-deferred `?failureReason=` triage filter on `GET /v1/deliveries`
  (denormalize the latest failure reason onto `DeliveryTask` across all 3 backends + the worker fail
  path — a core-FSM change, hence its repeated deferral).

## 2026-05-24T21:25 · iter-0091 · GREEN · no-store-cache-control-on-authenticated-html

- **Baseline:** clean main @ `00fb920` (iter-0090 per-surface security headers), whose recorded
  green was `vitest run` **1736/1736**; tree unchanged at that SHA. Confirmed `tsc --noEmit` 0 and
  the touched suites (`security-headers` + `server`, 29 tests) green before the full run below.
- **Move:** Land iter-0090's standing Next #1 — add `Cache-Control: no-store` to the authenticated
  HTML surfaces. Both operator **dashboards** (session-cookie) and the consumer **portal** (portal
  session) render tenant-scoped data yet carried **no** cache directive, so a browser would cache
  the markup to disk / its back-forward buffer: log out, press Back on a shared or kiosk machine,
  and the prior tenant's data is still on screen. The service had zero caching posture on any
  surface.
- **Changed:**
  - `http/security-headers.ts`: new shared `HTML_CACHE_CONTROL = "no-store"` constant; both the
    `dashboard` and `portal` branches of `securityHeadersForPath` now emit `cache-control: no-store`.
    The `api` branch is deliberately untouched. Header doc comments updated to state the rationale.
  - `http/security-headers.test.ts`: +1 test (API surface stays cacheable — `/v1/*`, `/openapi.json`,
    `/healthz` carry no `cache-control`); dashboard/portal cases now assert `no-store`.
  - `http/server.test.ts`: dashboard + portal socket tests assert `cache-control: no-store` over the
    wire; the plain-API socket test asserts it is absent (public docs/health stay cacheable).
- **Decisions:** Scoped to the two HTML surfaces only — the `api` surface also serves the *public*
  health/`openapi.json`/docs responses, which benefit from being cacheable, and its authenticated
  JSON is bearer-token (not a cookie back-button) driven, so a blanket API `no-store` would strip
  legitimate cacheability for no security gain. Used bare `no-store` (strongest: forbids browser +
  shared-proxy + bfcache storage); skipped the HTTP/1.0-legacy `Pragma`/`Expires` pair as
  cargo-cult on a modern-client service. Reused the existing pure prefix-surface model, so a
  disabled-dashboard 404 and a `/portal/*` 404 inherit the posture by URL space, not handler wiring.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1737/1737** (+1; 52 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `assert-gate-integrity.ps1` 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`. Compiled-`dist` ESM smoke: `dashboard`/`portal` →
  `no-store`, `api`/`openapi` → undefined (`DIST_SMOKE_PASS`).
- **Next:** Document the TLS-termination assumption and add `Strict-Transport-Security` (HSTS) behind
  a config flag (only safe when TLS is actually terminated — getting it wrong locks a domain out for
  the max-age); audit the admin/tenant dashboard views for any non-`esc()` interpolation (iter-0089
  residual); or the standing `?failureReason=` triage filter on `GET /v1/deliveries` (needs the
  structured reason threaded onto the `DeliveryTask` across all 3 backends + the worker `fail()`
  path — a core-FSM change, hence its repeated deferral).

## 2026-05-24T19:45 · iter-0090 · GREEN · per-surface-security-response-headers

- **Baseline:** clean main @ `82be719` (iter-0089 portal reflected-XSS fix). Verified green first:
  `tsc --noEmit` 0, `vitest run` **1721/1721** (51 files, 6 PG-skipped, no flaky exit), `npm run
  build` 0.
- **Move:** Land iter-0089's standing Next #1 — defense-in-depth security *response* headers with a
  per-surface policy. The service had **zero** security headers on any surface, so the iter-0089 XSS
  fix (encode-on-output) had no second layer, and the operator dashboards were freely iframe-able
  (clickjacking). The hard constraint: the consumer portal is *designed* to be embedded, so a blanket
  anti-framing policy can't apply — the policy must vary by surface.
- **Changed:**
  - new `http/security-headers.ts`: pure `surfaceForPath` + `securityHeadersForPath`. Universal on
    every response: `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`. **Dashboards**
    add CSP `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self';
    base-uri 'none'; frame-ancestors 'none'` + `X-Frame-Options: DENY`. **Portal** adds the same CSP
    *minus* `frame-ancestors` (stays embeddable; no `X-Frame-Options`).
  - `http/server.ts`: `serve()` computes `securityHeadersForPath(path)` once and threads it through
    **every** `writeResponse` exit — the 413/400 early body-read failures and the main path.
  - +15 tests: `security-headers.test.ts` (10 pure, incl. prefix-lookalike + tenant-subtree parity) +
    `server.test.ts` (5 socket-level: api/dashboard/portal + disabled-handler URL-space + 413).
- **Decisions:** Classify by URL **prefix**, not handler wiring — the URL space owns the posture, so a
  disabled-dashboard 404 still anti-frames and a `/portal/*` 404 stays frameable. CSP can lock this
  hard because every view is `<script>`-free with same-origin `<form action>` and inline styles only,
  so `default-src 'none'` + `style-src 'unsafe-inline'` renders intact while making any XSS payload
  non-executable by construction. API JSON/text gets `nosniff`+referrer only (no markup to police).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1736/1736** (+15; 52 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `assert-gate-integrity.ps1` 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`.
- **Next:** `Cache-Control: no-store` on authenticated dashboard/portal HTML (stop back-button session
  leakage); document TLS-termination assumptions and add `Strict-Transport-Security` (HSTS) behind it;
  or the long-standing `?failureReason=` triage filter on `GET /v1/deliveries`.

## 2026-05-24T19:35 · iter-0089 · GREEN · portal-reflected-xss-on-create-error

- **Baseline:** clean main @ `b61902b` (iter-0088 per-attempt failure reason). Verified green first:
  `tsc --noEmit` 0, `vitest run` **1720/1720** (51 files, 6 PG-skipped, no flaky exit), `npm run
  build` 0.
- **Move:** Close a reflected-XSS hole in the consumer portal — security hardening, chosen over
  continuing the observability arc per standing guidance. On a failed `POST /portal/endpoints` the
  handler surfaced the validation error by **injecting an inline
  `<script>alert(JSON.stringify(errMsg))</script>`**. `JSON.stringify` escapes quotes/backslashes but
  **not** `</script>`, and the endpoint store's syntactic validation echoes the raw URL verbatim
  (`url is not a valid absolute URL: "<input>"`, `endpoint.ts:495`) — `assertUrlDeliverable` is a
  no-op on an unparseable URL, so a malformed value reaches that echo. A URL like
  `abc</script><script>…</script>` thus broke out of the alert script and executed in the
  portal-session origin.
- **Changed:**
  - `portal/portal-views.ts`: `portalEndpointsPage` gains an optional `errorMessage`, rendered as an
    `esc()`-escaped `.alert-err` banner inside the create-form card — the exact pattern
    `portalEventTypesPage` already uses for its create error. No script ever carries the message.
  - `portal/portal-handler.ts`: the create-failure path now calls
    `portalEndpointsPage(eps, undefined, catalogTypes, errMsg)` instead of concatenating the inline
    `<script>alert(...)>`. The rendered portal HTML now contains **zero** `<script>` tags.
  - +1 regression test: a `</script><script>alert(document.cookie)</script>` URL is escaped
    (`&lt;/script&gt;` present; the breakout boundary `</script><script>` absent; nothing created).
- **Decisions:** Fixed at the sink (encode-on-output via `esc()`) rather than scrubbing the error
  text, so any future error string is safe by construction. Kept the `200` re-render + inline-banner
  UX (matches the event-types path). Deferred a defense-in-depth CSP / security-response-header pass:
  it needs per-surface policy (the portal is *designed* to be iframe-embedded, so a blanket
  `X-Frame-Options: DENY` would break it while the admin/tenant dashboards *should* set it) — its own
  tick.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1721/1721** (+1; 51 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `assert-gate-integrity.ps1` 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`.
- **Next:** Defense-in-depth security response headers with per-surface policy (`nosniff` everywhere;
  `X-Frame-Options`/CSP `frame-ancestors` on the dashboards but not the embeddable portal;
  `script-src 'none'` CSP on portal HTML); audit the other HTML surfaces (admin/tenant dashboards)
  for any non-`esc()` interpolation; or the standing `?failureReason=` triage filter on
  `GET /v1/deliveries`.

## 2026-05-24T19:25 · iter-0088 · GREEN · delivery-failure-reason-on-attempt-record

- **Baseline:** clean main @ `1ef5e5b` (iter-0087 per-reason failure metric). Verified green first:
  `tsc --noEmit` 0, `vitest run` **1714/1714** (51 files, 6 PG-skipped, no flaky exit), `npm run
  build` 0, `assert-gate-integrity.ps1` 0.
- **Move:** Complete iter-0087's value (its standing Next #1). iter-87 classified every failed
  delivery into a stable `DeliveryFailureReason`, but only as an *aggregate* metric label — the
  per-message audit attempt (`GET /v1/messages/:id/attempts`), the view a developer actually debugs a
  flaky receiver from, still carried only free-text `error`. So "why did *this* webhook keep failing?"
  could not be filtered or grouped. Land the structured cause on the attempt record itself.
- **Changed:**
  - `attempts/delivery-attempt.ts`: `DeliveryAttempt` + `NewDeliveryAttempt` (optional) +
    `NormalizedNewAttempt` gain `failureReason: DeliveryFailureReason | null`; `normalizeNewAttempt`
    validates it against the canonical `DELIVERY_FAILURE_REASONS` set and rejects a reason on a 2xx
    (`succeeded ⇒ null`).
  - Persisted in all three backends: SQLite adds a `failure_reason TEXT` column + a seamless
    `#migrateFailureReasonColumn()` `ALTER TABLE` (old rows read `null` — the cause was never
    classified, like the body columns); in-memory spreads it; Postgres column added (parity).
  - `worker/delivery-worker.ts`: the `failureReason` it already computed for the tick metric is now
    threaded into `recordAttempt` (no new classification — one source).
  - Surfaced on `attemptView` (HTTP), the SDK `DeliveryAttemptView`, and the OpenAPI `DeliveryAttempt`
    schema (nullable enum built from `DELIVERY_FAILURE_REASONS`, so it can't drift).
  - +tests: conformance round-trip + validation (×2 backends), a SQLite legacy-DB migration test,
    worker classification across http_5xx/connection_refused/no_endpoint, pure normalize, HTTP + SDK
    surfacing; new `scripts/smoke-failure-reason.mjs`.
- **Decisions:** Surfaced on the existing append-only attempt record (no new store/table); the iter-87
  classifier is reused verbatim, so the metric and the audit field can never disagree. Enforced
  `succeeded ⇒ failureReason === null` in normalize (a cross-field rule the free-text `error` lacks)
  because a queryable cause is only trustworthy if non-null always means failure.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1720/1720** (+6; 51 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `node scripts/smoke-failure-reason.mjs` **10/10** (http_5xx +
  connection_refused classified through production ESM on a real `node:sqlite` file, surviving a
  restart); `node scripts/smoke-logging.mjs` 22/22; `assert-gate-integrity.ps1` 0 (zero substrate
  edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** Surface `failureReason` as a badge in the tenant dashboard per-attempt log (the debugging
  UI that motivated the field); or add a `?failureReason=` filter to `GET /v1/deliveries` for app-wide
  triage; or persist the connect-vs-total split on the one-shot test-send path (`http/api.ts`, still
  on `fetchTransport`).

## 2026-05-24T19:07 · iter-0087 · GREEN · delivery-failure-reason-metric

- **Baseline:** clean main @ `7638450` (iter-0086 connect-vs-total timeout). Verified green first:
  `tsc --noEmit` 0, `vitest run` **1675/1675** (50 files, 6 PG-skipped, no flaky exit), `npm run
  build` 0, `assert-gate-integrity.ps1` 0.
- **Move:** Complete iter-0086's value (its standing Next #1). The transport now *fails unreachable
  fast* with a distinguishable `connect timeout after <ms>ms` error vs. a slow receiver's total-
  deadline `AbortError`, but the worker flattened both to a free-text string and metrics tallied
  only coarse outcomes — so "unreachable" was invisible on the dashboard. Recover the distinction as
  a queryable metric label.
- **Changed:**
  - New pure `src/delivery/failure-reason.ts`: a closed `DeliveryFailureReason` taxonomy (13 codes —
    `connect_timeout`/`request_timeout`/`dns_failure`/`connection_refused`/`connection_reset`/
    `tls_error`/`ssrf_blocked`/`http_4xx`/`http_5xx`/`http_other`/`no_endpoint`/`expired`/`other`),
    ordered `DELIVERY_FAILURE_REASONS`, `emptyDeliveryFailureCounts()`, and a total, I/O-free
    `classifyDeliveryFailure(signal)`. Classifies by **structured evidence** — Node `.code`/`.syscall`,
    `AbortError` name, `instanceof BlockedUrlError` (`.reason`) — not brittle text, with the transport's
    one controlled connect-timeout message the lone exception.
  - `worker/delivery-worker.ts`: capture the transport error object + a pre-flight discriminant,
    classify each non-success attempt, and tally per-reason into a new `TickResult.failureReasons`
    (counted only for `failed`/`deadLettered`, so `sum == failed + deadLettered`). `#deliver` now
    returns `{outcome, failureReason}`.
  - `metrics/metrics.ts`: `MetricsRegistry` folds the per-reason tally; new
    `posthorn_delivery_failures_total{reason="…"}` family (every series, zeros included).
  - `index.ts` re-exports the classifier; `docs/DEPLOY.md` documents the metric + two PromQL examples
    (top reasons; `connect_timeout` alone). +39 tests (classifier 29, worker 7, metrics 3).
- **Decisions:** Surfaced as a metric label (the dashboard goal), not an audit-record column — the
  latter is a 3-store schema migration deferred to a follow-up. Kept the classifier pure in
  `delivery/` (alongside `retry-policy`) so the worker stays thin and the taxonomy is unit-tested
  without a socket. `stale`/`rateLimited` contribute no reason (no settled failure verdict).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1714/1714** (+39; 51 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `node scripts/smoke-logging.mjs` 22/22; `assert-gate-integrity.ps1` 0
  (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** Persist the reason as a column on the audit attempt record (3-store migration) so a
  single message's failure cause is queryable, not just aggregate; or wire it into the dead-letter
  system-event payload; or a connect-vs-total split for the one-shot test-send path (`http/api.ts`,
  still on `fetchTransport`).

## 2026-05-24T18:51 · iter-0086 · GREEN · connect-vs-total-delivery-timeout

- **Baseline:** clean main @ `21d95b7` (iter-0085 gateway lifecycle logging). Verified green
  first: `tsc --noEmit` 0, `vitest run` **1667/1667** (50 files, 6 PG-skipped, no flaky exit),
  `npm run build` 0, `assert-gate-integrity.ps1` 0.
- **Move:** Split the delivery deadline into **connect-vs-total**, the standing iter-82 Next #2 /
  project-memory hardening candidate. Until now a *single* deadline (the worker's `AbortController`,
  the transport `signal`) spanned DNS+connect+response, so an unreachable endpoint (dropped SYN,
  black-holed IP) tied up the whole 10 s budget — indistinguishable from a reachable-but-slow
  receiver, and burning a full slot per attempt. Svix and other senders expose both; this closes
  the gap on the core delivery path.
- **Changed:**
  - `net/guarded-transport.ts`: new `connectTimeoutMs` option (default `DEFAULT_CONNECT_TIMEOUT_MS`
    = 5 s; `0` disables; validated finite ≥ 0). A connect timer bounds DNS+TCP-connect only and is
    **cleared the instant the socket connects** (`connect`/`secureConnect`, or an already-connected
    reused socket), so a slow-to-respond receiver keeps the full total budget. On expiry it
    `req.destroy`s with a distinguishable `connect timeout after <ms>ms` error (vs the total
    deadline's AbortError) — the audit log now separates *unreachable* from *slow*.
  - `runtime/config.ts`: `POSTHORN_WORKER_CONNECT_TIMEOUT_MS` → `WorkerConfig.connectTimeoutMs`
    (min 0). `runtime/gateway.ts`: threads it into the shared guarded transport (tenant + system
    webhook delivery both inherit it). `index.ts`: exports `DEFAULT_CONNECT_TIMEOUT_MS`.
  - Docs: `.env.example` + `docs/DEPLOY.md` env table + tuning table (satisfies the iter-77 config↔docs
    drift guard, which now also asserts the new key in both).
  - Tests: +5 in `guarded-transport.test.ts` (fast-fail w/ distinguishable error via a hanging
    injected lookup; clear-on-connect proven by a fast-connect+slow-response success; connected-
    but-silent hits the *total* deadline; `0` disables; construction validation) + a `delayMs`
    receiver-harness option; config default/override/min tests updated.
- **Decisions:** Connect deadline lives in the transport (only it sees the socket), not the worker —
  the worker's single total `AbortController` is unchanged. Transport option defaults to 5 s (not
  disabled) for consistency with `requestTimeoutMs`'s defaulting; the existing localhost tests
  connect instantly so the timer clears with no behavior change. Not hard-enforcing connect ≤ total
  (harmless if inverted: total fires first) — documented instead.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1675/1675** (+8; 50 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `node scripts/smoke-logging.mjs` 22/22; `assert-gate-integrity.ps1` 0
  (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** Record the connect-timeout failure as a distinct metrics label / audit reason code (so
  "unreachable" is dashboardable separately from total timeouts); or a connect-vs-total split for the
  one-shot test-send path in `http/api.ts` (still on `fetchTransport`, which can't express it).

## 2026-05-24T18:47 · iter-0085 · GREEN · structured-gateway-lifecycle-logging

- **Baseline:** clean main @ `85d4bc2` (iter-0084 structured logging). Verified green first:
  `tsc --noEmit` 0, `vitest run` **1665/1665** (50 files, 6 PG-skipped; one flaky tinypool
  "worker exited" on the first run, clean on re-run), `npm run build` 0, `assert-gate-integrity.ps1` 0.
- **Move:** Finish iter-0084's structured logging by closing its own defect — the gateway's
  **lifecycle** still went through human `console.log` in the process shell (`[posthorn] listening`,
  `stopped`, …), so a deployed Posthorn wrote a **mix of prose and JSON to stdout**, which breaks
  every JSON-Lines collector (Loki/CloudWatch/Datadog). The most operationally useful markers
  (service up / down / on which port) were the ones *not* machine-parseable, and no `instance`/
  `version` stamp existed for multi-replica log correlation. This is iter-0084's documented Next.
- **Changed:**
  - `runtime/gateway.ts`: bind `instance` (fresh `randomUUID` per gateway, overridable via new
    `CreateGatewayOptions.instanceId`) + `version` (`POSTHORN_VERSION`) onto the root logger via
    `.child(...)`, so **every** line — including sub-component lines and an embedder's own — carries
    gateway identity. `start()` emits `info` `gateway started` (host/port/dataDir) after bind;
    `stop()` emits `info` `gateway stopped` once (guarded by `stopped`, idempotent-safe).
  - `main.ts`: dropped the human banner + `[posthorn]` lifecycle prints; signal/shutdown logging now
    rides `gateway.logger`; the pre-gateway startup-failure catch emits a structured `error` line via
    a default logger — so the **entire** process stdout is uniform JSON Lines, even on fatal boot.
  - `gateway.test.ts`: reworked the logger-contract test (identity now bound, not `===`); +2 tests
    (lifecycle started/stopped fires-once; distinct default instance id per gateway).
  - `scripts/smoke-logging.mjs`: +5 checks (injected identity, lifecycle lines, and a default-sink
    section proving every captured start+stop stdout line parses as JSON). 17 → 22.
  - `docs/DEPLOY.md`: Logging section documents the `instance`/`version` stamp + lifecycle lines;
    replaced the stale `[posthorn] listening…` standalone-run example with the real JSON boot line.
- **Decisions:** Expose the **bound** child as `gateway.logger` (not the raw injected logger) so an
  embedder's own lines also carry instance/version — chose stream-identity coherence over the prior
  `toBe(injected)` identity contract (updated the one unit + one smoke assertion). Startup-failure
  log goes to stdout (not stderr) to keep one uniform JSON stream, matching the gateway's own errors.
  `admin` CLI output stays `console.log` (user-facing command results, not operational logs).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1667/1667** (+2; 50 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `node scripts/smoke-logging.mjs` **22/22** (real JSON `gateway started`/
  `gateway stopped` lines observed on the default stdout sink); `assert-gate-integrity.ps1` 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** Bind `instance`/`version` onto the worker/dispatcher metrics labels too (log↔metric
  correlation), or emit a periodic `info` heartbeat with queue depth for liveness without scraping.

## 2026-05-24T18:46 · iter-0084 · GREEN · structured-operational-logging

- **Baseline:** clean main @ `a79d56d` (iter-0083 OpenAPI `url_not_allowed`). Verified green
  first: `tsc --noEmit` 0, `vitest run` **1633/1633** (49 files, 6 PG-skipped, no flaky exit),
  `npm run build` 0, `assert-gate-integrity.ps1` 0.
- **Move:** Close the biggest remaining production-grade *observability* gap. The gateway had
  Prometheus counters but **no logs**: the HTTP 500 fallback (`server.ts`) silently swallowed the
  underlying error, the delivery-worker / fan-out-dispatcher / pruner `onError` seams were left
  **unwired** in the gateway (a backend hiccup, a failed best-effort audit/health/system-event
  write — all vanished), and there was no request access log. An operator had nothing to grep.
- **Changed:**
  - New `src/logging/logger.ts` — pure, **zero-dependency** structured logger: `LogLevel`/
    `LogThreshold` (incl. `silent`), level filtering, `child()` field-binding, `formatJsonLine`
    (Error→name/message/stack, bigint→string, circular→`fields_error` fallback), `SILENT_LOGGER`,
    default JSON-Lines→stdout sink. Sink + clock injected → fully deterministic.
  - `runtime/config.ts`: `POSTHORN_LOG_LEVEL` (default `info`; validated enum) → `GatewayConfig.logLevel`.
    Documented in **`.env.example`** and **`docs/DEPLOY.md`** (new Logging section + ToC) to satisfy
    the iter-77 config↔docs drift guard.
  - `http/server.ts`: optional `logger` (default `SILENT_LOGGER` → no behavior change for existing
    callers). Per-request access line (probes `/healthz`,`/metrics`→`debug`; 5xx→`error`; else `info`;
    method/path/status/durationMs only — never headers/body/query). The 500 catch now logs the cause
    (+stack) — the silent-swallow gap, closed.
  - `runtime/gateway.ts`: builds the logger from `logLevel` (or an injected one via new
    `CreateGatewayOptions.logger`), exposes it on `Gateway`, wires worker/dispatcher/pruner `onError`
    → `logger.error` (component-tagged children), passes the `component:"http"` child to the server.
  - `index.ts` re-exports the logging surface. +32 tests (logger unit, config, server access/500, gateway).
- **Decisions:** Sink takes the structured `LogEntry` (not a pre-formatted string) so tests assert
  fields directly and embedders can route to pino/OTel — same injected-seam discipline as
  `recordAttempt`/`onTick`. `SILENT_LOGGER` default keeps `createHttpServer` callers unchanged.
  Probe demotion to `debug` keeps health/scrape spam out of the `info` stream. Reused
  `config.logLevel` (one knob, no new sink/format vars → no further drift surface).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1665/1665** (+32, 50 files, 6 PG-skipped, no flaky
  exit); `npm run build` 0; `assert-gate-integrity.ps1` 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`; compiled-`dist` ESM smoke (`scripts/smoke-logging.mjs`)
  **17/17** — pure logger + a running gateway emitting a parseable JSON access line through the real
  stdout sink, `component:"http"` tagging, no probe spam, and `silent` truly silent.
- **Next:** Emit a structured `info` boot/stop line + bound `instance`/`version` from the gateway
  (today `main.ts` logs lifecycle as prose); or a request-id field threaded from `node:http` so
  access + error lines for one request correlate; or connect-vs-total split on the delivery timeout
  (iter-82 Next, still open).

## 2026-05-24T18:45 · iter-0083 · GREEN · openapi-surface-url-not-allowed-400

- **Baseline:** clean main @ `5369313` (iter-0082 system-event per-attempt timeout). Verified green
  first: `tsc --noEmit` 0, `vitest run` **1630/1630** (49 files, 6 PG-skipped, no flaky exit),
  `npm run build` 0, `assert-gate-integrity.ps1` 0.
- **Move:** Close the API-contract gap deferred three times (iter-80/81/82 Next): the SSRF guard
  added a real `400 url_not_allowed` error code on the four URL-accepting routes, but the published
  OpenAPI never documented it — clients/codegen couldn't branch on a code the API actually returns.
- **Changed:**
  - `src/http/openapi.ts`: new `urlGuardedErrorResponse(description)` helper — one shared definition
    for the four routes that run `assertUrlDeliverable`, so their 400 wording can't drift apart. It
    appends the `url_not_allowed` condition to the description (human-facing) **and** attaches a
    concrete `application/json` envelope `example` (machine/codegen-facing) showing the exact shape.
  - Applied it to the four 400s: `POST /v1/endpoints`, `PATCH /v1/endpoints/{id}`,
    `POST /v1/admin/apps`, `PATCH /v1/admin/apps/{id}`.
  - Added `url_not_allowed` to the shared `Error.code` `examples` enum (the discoverability list).
  - Tests: +3 (`openapi.test.ts`) — code is in the Error enum; every URL-guarded route's 400 carries
    both the description mention and the `url_not_allowed` example; and a **reverse** guard that no
    other route's 400 falsely claims `url_not_allowed`.
- **Decisions:** Doc/spec only — zero product-code or runtime change (lowest risk; the green code
  baseline stands). Shared helper over four hand-edited strings to enforce the repo's "one source of
  truth, can't drift" discipline. Example message mirrors the real `BlockedUrlError` text. Reverse
  guard prevents over-claiming the code on unguarded routes.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1633/1633** (+3, 6 PG-skipped); `npm run build` 0;
  `assert-gate-integrity.ps1` 0 (zero substrate edits); compiled-`dist` ESM smoke **PASS** (the built
  `openapi.js` carries the code in `Error.code` and the desc+example on all four 400s).
- **Next:** Connect-vs-total split on the delivery timeout (Svix exposes both; today one deadline
  spans DNS+connect+response) — iter-82 Next #2; or a `code`-enumerating error-table in the README so
  the human docs match the OpenAPI `Error.code` list.

## 2026-05-24T18:25 · iter-0082 · GREEN · system-event-delivery-per-attempt-timeout

- **Baseline:** clean main @ `546c94d` (iter-0081 two-layer SSRF guard on system-webhook URLs).
  Verified green first: `tsc --noEmit` 0, `vitest run` **1626/1626** (6 PG-skipped), `npm run
  build` 0, `assert-gate-integrity.ps1` 0, `validate-log-compliance.py` `[PASS]`.
- **Move:** Close iter-0081 Next #2 — **system-event delivery had no per-attempt timeout.** The
  tenant delivery path wraps every send in the worker's `#send` (`AbortController` +
  `setTimeout(requestTimeoutMs)`), but the `endpoint.disabled` / `message.dead_lettered`
  notification path passed **no signal**, so `systemEventTransportFrom` substituted a
  *never-aborting* signal — a system-webhook receiver that accepts the TCP connection but never
  responds would pin a socket open indefinitely. Bring system events to delivery-path parity.
- **Changed:**
  - `src/system-events/index.ts`: `systemEventTransportFrom(transport, options?)` gains an optional
    `timeoutMs` (`SystemEventTransportOptions`). When `> 0` and the caller supplies no signal, the
    request is bounded by an `AbortController` + `setTimeout` cleared on settle (the worker's exact
    `#send` idiom). A caller-supplied signal still wins (forwarded unchanged); `timeoutMs ≤ 0`
    preserves the prior never-abort fire-and-forget behavior.
  - `src/runtime/gateway.ts`: the single system-event transport instance now passes
    `timeoutMs: config.worker.requestTimeoutMs` — both emit paths inherit the worker's per-attempt
    deadline through one wiring point.
  - Tests: +4 (`system-events.test.ts`) — timeout aborts a hung transport (fake timers), the timer
    is cleared so a finished request never aborts late, a caller signal overrides the timeout, and
    `timeoutMs:0` stays never-abort.
- **Decisions:** Reused `config.worker.requestTimeoutMs` rather than adding a config knob — a system
  event is a webhook POST like any other, same deadline semantics, and **no new env var** means no
  config-docs drift (iter-77 guard). Timeout lives in the transport adapter, not each emit helper, so
  both paths are covered at one seam. No unref on the timer (matches the worker's `#send`; it is
  always cleared on settle).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1630/1630** (+4, 6 PG-skipped); `npm run build`
  0; `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`;
  compiled-`dist` ESM smoke **5/5** (hung receiver aborts at ~50ms; finished request not aborted
  after the deadline; `timeoutMs:0` never aborts — all via `dist/system-events/index.js`).
- **Next:** Surface `url_not_allowed` in the OpenAPI 400s for endpoint + admin-app create/update
  (iter-80 Next #2 / iter-81 Next #1, still open); or a connect-vs-total split on the delivery
  timeout (today one deadline covers DNS+connect+response — adequate, but Svix exposes both).

## 2026-05-24T18:05 · iter-0081 · GREEN · ssrf-guard-on-system-webhook-urls

- **Baseline:** clean main @ `3fe6366` (iter-0080 connection-time SSRF guard on delivery).
  Verified green first: `tsc --noEmit` 0, `vitest run` **1610/1610** (6 PG-skipped; a one-off
  tinypool "Worker exited unexpectedly" cleared on re-run), `npm run build` 0,
  `assert-gate-integrity.ps1` 0, `validate-log-compliance.py` `[PASS]`.
- **Move:** Close the parallel SSRF residual iter-80 named as Next #1. The app's **system
  webhook URL** (operator-set via `POST/PATCH /v1/admin/apps`, fired on `endpoint.disabled` /
  `message.dead_lettered`) had **neither** guard: registration accepted any http(s) URL incl.
  private, and delivery used a plain redirect-following `fetch` — while tenant endpoint URLs
  already have both the registration (iter-78) and connection-time (iter-80) layers. Apply
  Posthorn's existing two-layer defense to the system-webhook path for full parity.
- **Changed:**
  - `src/system-events/index.ts`: new `systemEventTransportFrom(transport)` adapts a delivery
    `Transport` into a `SystemEventTransport`, so system events ride the guarded transport
    (connection-time resolved-IP check + no redirect-following). System events are POST and
    fire-and-forget → a never-aborting signal is supplied when none is passed; a block rejects
    and is absorbed by the worker's `onError` seam (unchanged from the prior fetch, which also
    threw). Type-only `Transport` import (no runtime coupling/cycle).
  - `src/runtime/gateway.ts`: replaced the plain-`fetch` `systemEventTransport` with
    `systemEventTransportFrom(deliveryTransport)` — both delivery paths now share one guarded
    transport and the single `allowPrivateNetworks` opt-out.
  - `src/http/api.ts`: registration guard — `assertUrlDeliverable(systemWebhookUrl, ssrfPolicy)`
    in admin `createApp`/`updateApp` when the value is a non-null string (`BlockedUrlError` →
    `400 url_not_allowed`; null/non-string defers to the store's syntactic validation). Mirrors
    the endpoint guard at lines 1347/1388.
  - Tests: +5 system-events (adapter forward/signal-default/signal-forward/reject + a
    connection-time block propagating through the real guarded transport) and +11 api (6 admin
    create block vectors, update→internal block, public allow on create+update, null clear,
    opt-out allow, invalid-URL→generic 400). These are also the first coverage of setting
    `systemWebhookUrl` via the admin API surface.
- **Decisions:** Two-layer parity over connection-guard-only — avoids a "saves 201 but silently
  fails at delivery" asymmetry. Reused the existing guarded transport instance (**zero new
  deps**). Secure-by-default block; an operator who points a system webhook at internal alerting
  flips the same documented `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true` (governs both paths).
  Guard kept at the API boundary, not inside pure `normalizeSystemWebhookUrl`, so the trusted
  CLI/library path stays unconstrained (same model as iter-78). Helper stays internal —
  `system-events` is not a public `index.ts` export.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1626/1626** (+16; 6 PG-skipped, no flaky exit
  on the full run); `npm run build` 0; `assert-gate-integrity.ps1` 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`; compiled-`dist` ESM smoke **2/2** (system event to a
  metadata-resolving host blocked with `BlockedUrlError`; loopback delivered under the opt-out).
- **Next:** Surface `url_not_allowed` in the OpenAPI 400s for endpoint + admin-app create/update
  (iter-80 Next #2, still open); or add a per-attempt request timeout to system-event delivery
  (it currently has none — the never-abort signal preserves prior behavior).

## 2026-05-24T17:45 · iter-0080 · GREEN · connection-time-ssrf-guard-on-delivery

- **Baseline:** clean main @ `a501770` (iter-0079 hex/NAT64 SSRF fix). Verified green first:
  `tsc --noEmit` exit 0, vitest **1585/1585** (6 PG-skipped), `npm run build` exit 0,
  `assert-gate-integrity.ps1` exit 0.
- **Move:** Close the explicitly-documented SSRF residual — a *hostname* that resolves (or rebinds)
  to a private/internal IP, invisible to the registration-time literal-host guard, which cannot do
  DNS. Add a connection-time resolved-IP check on the actual delivery path.
- **Changed:**
  - `src/net/guarded-lookup.ts` (new): `createGuardedLookup(policy, resolver?)` builds a Node
    `lookup` for `http/https request({lookup})`. Resolves all addresses, blocks the connection if
    **any** is private/internal (fail-closed vs round-robin/0-TTL rebinding), else hands Node the
    resolved set so it connects without re-resolving — no TOCTOU window. Pass-through under the
    `allowPrivateNetworks` opt-out; genuine resolution errors surface unchanged.
  - `src/net/guarded-transport.ts` (new): `createGuardedTransport(policy)` — a `Transport` over
    built-in `node:http/https` (**zero new deps**, preserving the no-deps wedge; `undici` is not
    importable here). Same `HttpDeliveryResponse` contract as `fetchTransport`; additionally refuses
    private resolved IPs and does **not** follow redirects (closes a 3xx→internal SSRF hop that
    `fetch` auto-following allowed).
  - `src/runtime/gateway.ts`: worker + test-send (`POST /v1/endpoints/:id/test`) now use the guarded
    transport, built from `config.allowPrivateNetworks`.
  - `src/net/ssrf-guard.ts`: module doc updated to the two-layer model; `src/index.ts`: export the
    two factories. +25 tests (lookup decisions via fake resolver; transport over a real loopback
    receiver incl. hostname block + pinned-delivery).
- **Decisions:** node:http+lookup over adding `undici` (dep cost) or resolve-then-fetch (TOCTOU /
  HTTPS-SNI-breaking). Connection guard shares the single `allowPrivateNetworks` opt-out — when set,
  both layers pass-through (tests run that way, unaffected). Literal-IP hosts skip DNS, so the
  connection guard covers only hostnames (literals stay the registration guard's job).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1610/1610** (+25, 6 PG-skipped); `npm run build`
  0; `assert-gate-integrity.ps1` 0 (zero substrate edits); compiled-`dist` ESM smoke 4/4 (metadata +
  RFC1918 rebind blocked; opt-out + literal-IP deliver).
- **Next:** Extend the guard to the system-event transport (app-configured system-webhook URLs are
  also remotely-influenced); surface `url_not_allowed`/blocked-resolution in the OpenAPI 400s.

## 2026-05-24T17:21 · iter-0079 · GREEN · close-ipv6-embedded-ipv4-ssrf-bypass

- **Baseline:** clean main @ `0bc883a` (iter-0078 SSRF guard). Code baseline verified green first:
  `tsc --noEmit` clean, vitest **1570/1570** (6 PG-skipped, no flaky exit), `npm run build` clean,
  `assert-gate-integrity.ps1` + `validate-log-compliance.py` PASS.
- **Move:** Close a live, exploitable bypass *inside* the SSRF guard iter-78 just shipped. The IPv6
  classifier only unwrapped IPv4-mapped addresses in dotted form (`::ffff:127.0.0.1`); the
  equivalent all-hex spelling slipped through. Confirmed against compiled `dist`:
  `http://[::ffff:a9fe:a9fe]/` (== cloud metadata `169.254.169.254`) and `::ffff:7f00:1`
  (== `127.0.0.1`) were reported **deliverable** — the exact target the guard exists to block.
- **Changed:**
  - `src/net/ssrf-guard.ts`: new pure `expandIpv6` expands any literal to its 8 hextets (resolves
    `::`, folds a trailing dotted-quad to hex). `isBlockedIpv6` rewritten to classify on the
    expanded bits, routing every embedded-IPv4 form — IPv4-mapped (`::ffff:0:0/96`), deprecated
    IPv4-compatible (`::/96`), NAT64 (`64:ff9b::/96`) — through `isBlockedIpv4` in *any* spelling;
    link-local/ULA/multicast become exact masked-prefix checks; an unparseable literal fails closed.
    Module-doc Limitations updated (hex caveat removed; DNS-rebinding gap retained).
  - `src/net/ssrf-guard.test.ts`: +15 golden vectors — hex mapped loopback/private/metadata,
    fully-expanded form, compatible + NAT64, uppercase; public hex-mapped + NAT64 still permitted;
    fail-closed cases; two URL-level regressions (`http://[::ffff:a9fe:a9fe]/…`).
- **Decisions:** Expand-then-classify over more string regexes — judging actual bits is spelling-
  independent and kills the whole bypass class, not just the one reported form. NAT64 included (real
  translation prefix; fail-closed for a private low-32). Public embedded v4 (`::ffff:8.8.8.8`) stays
  deliverable — extract-and-classify, never block all of `::/96`. Signature unchanged; only
  re-exported via `index.ts`, so no delivery-path caller churn.
- **Validation:** `tsc --noEmit` exit 0; `vitest run` **1585/1585** (+15; 6 PG-skipped, no flaky
  exit); `npm run build` exit 0; compiled-`dist` ESM probe: the 3 hex/NAT64 SSRF targets now
  blocked, public mapped + named still deliverable; `assert-gate-integrity.ps1` exit 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Notes:** Registration-time, literal-host scope is unchanged — this hardens the existing guard,
  it does not widen where it runs.
- **Next:** Connection-time resolved-IP check (DNS-rebinding defense) via an undici `lookup`/connect
  hook — the remaining documented SSRF residual; or surface `url_not_allowed` in the OpenAPI 400
  responses of endpoint create/update.

## 2026-05-24T17:12 · iter-0078 · GREEN · ssrf-guard-on-endpoint-urls

- **Baseline:** clean main @ `5eaab3b` (iter-0077 config-docs drift guard). Code baseline verified
  green first: `tsc --noEmit` clean, vitest **1469/1469** (6 PG-skipped, no flaky worker exit),
  `npm run build` clean, `assert-gate-integrity.ps1` + `validate-log-compliance.py` PASS.
- **Move:** Close a real, unaddressed security hole. Posthorn is a webhook *sender*, but the only
  endpoint-URL validation was "syntactically http(s)". A tenant could register
  `http://169.254.169.254/…` (cloud metadata), `http://localhost:6379/`, `http://10.0.0.5/`, or
  `http://redis/` and coerce the gateway into requests against the operator's private network —
  textbook SSRF, which every incumbent (Svix/Hookdeck/Convoy) blocks and which is a showstopper for
  the hosted/multi-tenant P5 control plane that is the monetization path.
- **Changed:**
  - New pure, zero-dep `src/net/ssrf-guard.ts`: classifies a URL host (literal IPv4/IPv6 incl.
    IPv4-mapped, or a hostname) against loopback / RFC-1918 / link-local (incl. the metadata
    address) / CGNAT / unique-local / multicast ranges + internal names (`localhost`,
    `*.local`/`*.internal`, bare single-label). `assertUrlDeliverable`/`isUrlDeliverable`/
    `BlockedUrlError` (+77 unit tests).
  - Enforced at the **untrusted registration boundary only** — endpoint create/update on the JSON
    API (`BlockedUrlError`→`400 url_not_allowed` via `toErrorResponse`) and the always-on portal
    (inline error). Delivery/test run on already-validated stored URLs (a coherent "validate at
    registration" model: no silent on-upgrade delivery breakage, no resolver/worker churn).
  - Config `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS` (new `readBool`; default **false** =
    secure-by-default block) on `GatewayConfig.allowPrivateNetworks`, threaded into ApiDeps +
    PortalDeps by the gateway; exported from `index.ts`; documented in `.env.example` +
    `docs/DEPLOY.md` (forced by iter-77's config-docs drift guard).
  - Tests: 3 e2e config helpers + 2 ad-hoc smokes opt out (loopback receiver = trusted in-test);
    api + portal suites cover block/allow/non-url-patch/invalid-url.
- **Decisions:** Secure-by-default block — the dangerous deployment is multi-tenant; a self-hoster
  flips one documented env var. Guard at registration, not delivery — avoids dead-lettering
  intentional internal endpoints on upgrade and leaves the trusted CLI/library path unconstrained.
  Distinct `url_not_allowed` code so clients separate an SSRF block from generic validation.
  Literal-host only — DNS-rebinding is a documented residual gap and a Next.
- **Validation:** `tsc --noEmit` exit 0; `vitest run` **1570/1570** (+101; 6 PG-skipped, no flaky
  exit); `npm run build` exit 0; `assert-gate-integrity.ps1` exit 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`. Compiled-`dist` ESM smoke: guard blocks the 5 canonical
  SSRF targets, permits public + opt-out, config rejects a bad bool. `smoke-test-endpoint` and
  `smoke-portal-delivery` pass (loopback endpoint create 201/200 under the opt-out).
- **Notes:** Also fixed pre-existing `localhost`→`127.0.0.1` bit-rot in the two smokes I touched
  (the gateway binds IPv4; `localhost` resolved to a 404 path on this Windows box) — unrelated to
  SSRF. A Windows-only libuv teardown assertion still prints on those two after all checks pass.
- **Next:** Connection-time resolved-IP check (DNS-rebinding defense) via a custom undici
  `lookup`/connect hook; or surface `url_not_allowed` in the OpenAPI 400 responses of the endpoint
  create/update operations.

## 2026-05-24T16:52 · iter-0077 · GREEN · config-docs-drift-guard

- **Baseline:** clean main @ `2c6c952` (iter-0076 ledger migration). Code baseline verified green
  before change: `tsc --noEmit` clean, vitest **1435/1435**, `npm run build` clean.
- **Move:** Close the config↔docs drift on the self-host surface — three operator env knobs had
  landed in `loadConfig` but never reached the docs, making them invisible to self-hosters — and add
  a guard so it can never recur.
- **Changed:**
  - `.env.example`: added the three undocumented vars — `POSTHORN_MAX_BODY_BYTES`,
    `POSTHORN_RETENTION_DAYS`, `POSTHORN_DEFAULT_RATE_LIMIT` (with new retention + rate-limit
    sections); admin-token comment now states the **enforced** 16-char floor (was a false "32").
  - `docs/DEPLOY.md`: added `POSTHORN_DEFAULT_RATE_LIMIT` + `POSTHORN_RETENTION_DAYS` rows to the
    configuration reference; corrected the three "≥ 32 chars" admin-token claims to the enforced ≥ 16.
  - `src/runtime/config.test.ts`: new **config-documentation drift guard** — a `Proxy` probes
    `loadConfig` to capture the exact `POSTHORN_*` keys it reads (no hand-maintained list, no source
    parsing), then asserts each is documented in *both* `.env.example` and `docs/DEPLOY.md`, plus a
    reverse check that `.env.example` lists no var the loader doesn't recognize. +34 tests.
- **Decisions:** Proxy-capture over an exported constant — the guard verifies real loader behavior
  and needs **zero** production-code change (lowest risk). Forward guard against both docs; reverse
  guard only against `.env.example` (structured `VAR=` lines; DEPLOY prose names vars in many
  contexts → too noisy to invert). Corrected docs to the code's `MIN_ADMIN_TOKEN_LENGTH=16` (code is
  source of truth), not the reverse. Same "one source of truth, can't drift" discipline as the
  OpenAPI route table.
- **Validation:** `tsc --noEmit` exit 0; `vitest` **1469/1469** (was 1435; +34), 6 PG-skipped, no
  flaky worker exit; `npm run build` exit 0; `assert-gate-integrity.ps1` exit 0 (zero substrate
  edits); `validate-log-compliance.py` → `[PASS]`.
- **Notes:** Docs + test only; no product code touched, so the green code baseline above stands.
- **Next:** Portal endpoint-detail page should surface the *effective* rate limit (explicit vs.
  `POSTHORN_DEFAULT_RATE_LIMIT` fallback) — thread the gateway default into `PortalDeps`; or extend
  the drift guard to cover README config mentions.

## 2026-05-24T16:39 · iter-0076 · GREEN · migrate-ledger-to-canonical-log

- **Baseline:** clean main @ `1159d45` (operator substrate refresh). Code baseline verified green
  before any change: `tsc --noEmit` clean, vitest **1435/1435** (46 files, 6 Postgres-skipped, no
  flaky worker exit), `npm run build` clean.
- **Move:** Adopt the new substrate-mandated logging system — make `docs/LOG.md` the single
  operational ledger and retire the now-forbidden `docs/LOOP_LOG.md`.
- **Changed:**
  - `git mv docs/LOOP_LOG.md docs/log/2026-05.md` — 75 prior iterations (4916 lines / 354 KB)
    archived intact into the substrate's documented monthly-rotation path; git tracks it as a rename
    so blame/history are preserved.
  - Prepended a provenance banner to the archive noting the migration, the originating commit, and
    that the file is now read-only legacy history.
  - Recorded this iteration as the first entry of the new ledger below the `== LOG-ANCHOR ==`,
    conforming to the strict header schema (`iter-0076`, 4-digit id, `·`-delimited).
- **Decisions:** Archived rather than reconstructed — re-formatting 75 entries into the new schema
  would risk corrupting history and violate the "no free-hand rewrite of older entries" rule; the
  validator only scans `docs/LOG.md`, so the legacy-schema archive is compliant. Used the
  `docs/log/YYYY-MM.md` rotation path the substrate itself documents. Left `docs/GOAL.md` untouched
  (no `CURRENT_STATE` marker present → loop proceeds as active development; PROJECT.md is `DECIDED`).
  Left the lone historical `LOOP_LOG` mention in `PROJECT.md:595` intact (accurate past narrative).
- **Validation:** `python scripts/validate-log-compliance.py` → exit 0 `[PASS]`;
  `pwsh scripts/assert-gate-integrity.ps1` → exit 0 (substrate hashes intact, zero substrate edits);
  `pwsh scripts/local-gate.ps1` → clean workspace pass. Code baseline unchanged (docs-only).
- **Notes:** No product code touched; the green code baseline above stands. `docs/LOOP_LOG.md` no
  longer exists in the workspace, satisfying the new rule while Axiom 3 is honored via the archive.
- **Next:** Resume feature work under the iter-75 backlog — portal endpoint-detail page surfacing
  the effective rate limit (explicit vs. `POSTHORN_DEFAULT_RATE_LIMIT` fallback), or documenting the
  new env knob in the OpenAPI schema / README operator section.