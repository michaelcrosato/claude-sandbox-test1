# LOOP_LOG

High-compression, unvarnished record of every iteration (Axiom 5). Newest first.

---

## 2026-05-23 — Iteration 24: P3/P5 — admin / control-plane HTTP provisioning API (opt-in, token-gated)

**Repo truth at start:** clean main @ `cbae83c` (iter 23, zero-downtime secret rotation) — a real clean
baseline, not an interrupted tick (git clean; iter-23 entry present + matches head). Baseline re-verified
by the manual gate (`[[validation-gate-is-manual]]`): `tsc --noEmit` clean, vitest **623/623**, `npm run
build` clean, integrity + local gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Build the **admin / control-plane HTTP provisioning API** —
the item listed *first* in every recent tick's "standing deferred" list and the **keystone for P5 (the
hosted control plane = monetization)**, which is exactly the GOAL's profit filter. The decisive
observation: a deployed gateway could only be provisioned by the `posthorn admin` CLI **on the host
shell** (or programmatic `AppStore`); a remote/hosted operator had **no network path** to mint the first
tenant/key, leaving the whole authenticated API unreachable without shell access. The sending core is
mature and exhaustively tested, so the marginal value of more delivery polish is low; opening the
monetization phase is high. It is also a clean, deterministic, zero-dep vertical slice that follows the
established HTTP-API pattern exactly (compile-checked route table + bidirectional OpenAPI drift test force
completeness), and it **respects the project's security stance** — the earlier ticks rightly refused an
*open* provisioning endpoint; an *authenticated, opt-in* one is the legitimate control plane.

**Built this tick (a full vertical slice):**
- **`runtime/config.ts`** — `GatewayConfig.adminToken: string | null` from `POSTHORN_ADMIN_TOKEN`
  (`readAdminToken`: unset/blank → `null` = disabled; present → trimmed, validated to
  `MIN_ADMIN_TOKEN_LENGTH = 16` chars else `ConfigError` at boot — a weak root credential never reaches
  prod).
- **`http/api.ts`** — `ApiDeps.adminToken?`; a constant-time `constantTimeEqual` (both sides SHA-256'd so
  neither length nor content leaks via timing); an `adminAuthed` wrapper (no token configured → **404**,
  indistinguishable from a nonexistent path, so a disabled instance never reveals the surface; bad/missing
  token → **401**); `appView`/`apiKeyView` (no secret material); 7 handlers — `POST/GET /v1/admin/apps`,
  `GET/DELETE /v1/admin/apps/:id`, `POST/GET /v1/admin/apps/:id/keys`, `DELETE /v1/admin/keys/:id` (a
  superset of the CLI); `UnknownAppError → 404` added to the error map; all 7 keys added to
  `API_ROUTE_KEYS` (the `Record<ApiRouteKey, RouteHandler>` made the handler wiring exhaustive at compile
  time). A minted key's secret is revealed once (like endpoint create); key listings are metadata-only;
  delete-app cascades keys.
- **`http/openapi.ts`** — an `adminAuth` security scheme + an `Admin` tag + the 7 operations (each
  overriding the global bearer with `security: [{ adminAuth: [] }]`) + `App`/`NewApp`/`AppList`/`ApiKey`/
  `ApiKeyList`/`CreatedApiKey` schemas; `info.description` corrected. The bidirectional drift test +
  orphan-schema test *forced* every operation and schema to exist.
- **`runtime/gateway.ts`** — passes `config.adminToken` into the HTTP deps (conditional spread; `null` →
  routes stay disabled); `Gateway.apps` docstring updated. **`index.ts`** re-exports
  `MIN_ADMIN_TOKEN_LENGTH`. Stale "provisioning is not an HTTP route" claims in `api.ts`/`gateway.ts`/
  `openapi.ts`/PROJECT.md corrected to the new opt-in reality.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **641/641** (was 623;
**+18**: an admin handler suite — disabled→404 across all 7 routes, missing/wrong/**tenant-key**→401, full
CRUD, **a minted key authenticates a tenant route**, revoke-then-401, delete-cascades-then-401, 400 on bad
name, 404s; 3 config parse/validate cases; an OpenAPI `adminAuth`/all-7-ops-gated assertion; and 2
running-gateway e2es — disabled→404 + provision→mint→deliver+verify→revoke→401). `npm run build` clean.
Integrity gate exit 0 (three hash-protected files untouched); local gate exit 0. No tinypool flake this run.

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway against a
**file-backed** data dir (real `node:sqlite` `createRequire` path) with `POSTHORN_ADMIN_TOKEN` set;
provisioned a tenant + minted a key **entirely over the admin HTTP API**, used that key to create an
endpoint and send a message whose delivered webhook **verified** against the endpoint secret, confirmed
list-keys is metadata-only, revoked the key over HTTP (→ tenant route 401), then **reopened on the same
files** and saw the HTTP-provisioned tenant persist. Exit 0; temp script + dir removed; git shows only the
9 intended source files.

**State:** GREEN → committing to main as Iteration 24. Net: a deployed Posthorn can now be provisioned
**remotely over HTTP** behind an opt-in, constant-time-checked admin token — the control-plane seam P5's
hosted dashboard/billing will drive — without weakening the default posture (admin routes are `404` until
the token is set) or the refusal to ship an *open* provisioning door. **Standing deferred (next
candidates):** an *admin* SDK client (`PosthornAdminClient`); per-key `lastUsedAt`; attempt-log
pagination/retention; an operator deploy/monitoring guide (last P4 doc item); and the rest of P5 (usage
metering, billing, dashboard).

---

## 2026-05-23 — Iteration 23: P3 — zero-downtime endpoint secret rotation

**Repo truth at start:** clean main @ `de12c10` (iter 22, bounded concurrency) — a real clean baseline,
not an interrupted tick (git clean; iter-22 entry present + matches head). Baseline re-verified by the
manual gate (`[[validation-gate-is-manual]]`): `tsc --noEmit` clean, vitest **591/591**, `npm run build`
clean, integrity + local gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Ship **first-class zero-downtime secret rotation**. The
decisive observation on reading the code: the *receiver* half of this Standard Webhooks capability was
already built — `verify` (and the SDK's `verifyWebhook`) accept a multi-token `webhook-signature`
header — but the *sender* half was missing: the worker only ever signed with one secret, and the lone
rotation path (`PATCH …{secret}`) was a **hard swap** that breaks every receiver until it is
reconfigured in lockstep. So this completes a named differentiator ("first-class Standard Webhooks")
that was genuinely half-finished, sits in the loop's strongest regime (pure, deterministic,
fake-clock/in-process testable), is a real security/compliance ask (a target segment), and needs **zero
new deps**. Beat the standing-deferred alternatives (admin HTTP route, per-key `lastUsedAt`, attempt-log
pagination, operator docs): every one is narrower or lower-value than closing a half-built spec feature.

**Built this tick (a full vertical slice, bottom-up):**
- **`endpoints/endpoint.ts`** — `Endpoint.previousSecrets: {secret, expiresAt}[]` (retirees still
  signing until they expire); pure `rotateEndpointSecret(current, newSecret, now, overlapMs?)` (install
  new primary, retire old with overlap, prune expired, cap at `MAX_PREVIOUS_SECRETS=8`), pure
  `activeSigningSecrets(endpoint, now)` (the one shared "which secrets sign now" rule),
  `DEFAULT_SECRET_ROTATION_OVERLAP_MS=24h`, `EndpointStore.rotateSecret(id, {secret?, overlapMs?})` +
  `RotateSecretOptions`. `applyEndpointUpdate` carries `previousSecrets` through untouched (a direct
  `secret` patch stays a deliberate hard swap; rotation owns the overlap).
- **Both store backends** — `rotateSecret` (in-memory + SQLite, read-modify-write in `BEGIN IMMEDIATE`
  for atomicity); SQLite gains a `previous_secrets` JSON column via a guarded `ALTER TABLE` migration
  (`#migratePreviousSecretsColumn`), default `'[]'` so a pre-rotation DB upgrades seamlessly with no
  re-delivery; both held to one expanded conformance suite.
- **Multi-secret signing** — `DeliveryTarget.additionalSecrets`; `buildSignedRequest` signs with the
  primary **plus** each additional, space-joining `v1,…` tokens; `endpointToDeliveryTarget(endpoint,
  now)` + `storeBackedResolver(store, {now})` filter expired retirees via an injected clock.
- **Surface** — tenant-scoped `POST /v1/endpoints/:id/rotate-secret` (reveals the **new** primary once
  like create; **never** exposes the retired secrets; optional body; bad secret/overlap → 400; cross-
  tenant → 404), added to the compile-checked `API_ROUTE_KEYS`; SDK `client.rotateEndpointSecret`; the
  OpenAPI operation + `RotateSecretRequest` schema (the bidirectional drift test forced both); `index.ts`
  re-exports.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **623/623** (was 591;
**+32**: pure rotate/active-secrets unit tests, conformance ×2 backends incl. overlap→expiry + SQLite
reopen + **pre-rotation-DB migration**, worker multi-sign verify-against-both, resolver overlap-with-
clock, api handler 5 cases + cross-tenant 404, SDK round-trip, and the zero-downtime gateway e2e). `npm
run build` clean. Integrity gate exit 0; local gate exit 0 (three hash-protected files untouched). One
transient tinypool "worker exited unexpectedly" appeared on a first full run and did not reproduce
(flaky Windows/node:sqlite worker exit, not a test failure — re-run was 32/32 clean, then 623/623).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway against
a **file-backed** data dir (real `node:sqlite` `createRequire` path), created an endpoint, rotated over
HTTP, sent a message; the single delivered webhook **verified against BOTH the old and the new secret**
(2 signature tokens), the rotate response did not leak `previousSecrets`, and after `stop()` + reopen on
the same files the new primary + retired secret **persisted** — proving the new column + migration work
through production ESM, not just under Vitest's bundler. Exit 0; temp script + dir removed; git shows
only the intended files.

**State:** GREEN → committing to main as Iteration 23. Net: rotating a signing secret no longer drops a
webhook — the old secret keeps verifying through a tunable overlap while receivers migrate, then
expires; the sender now produces the multi-sig header the verifier always accepted, closing the loop on
"first-class Standard Webhooks". **Standing deferred (next candidates):** admin/control-plane *HTTP*
provisioning route (CLI covers local bootstrap); per-key `lastUsedAt`; attempt-log pagination/retention;
an operator deploy/monitoring guide (last P4 doc item); and the larger P5 hosted control plane.

---

## 2026-05-23 — Iteration 22: P2.5 — bounded worker concurrency (kill head-of-line blocking)

**Repo truth at start:** clean main @ `436a0ad` (iter 21, audit log) — a real clean baseline, not an
interrupted tick (git clean, iter-21 entry present + matches the head commit). Baseline re-verified by
the manual gate (`[[validation-gate-is-manual]]`): `tsc --noEmit` clean, vitest **585/585**, `npm run
build` clean, integrity gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Replace the delivery worker's **sequential** per-batch
loop with a **bounded concurrency pool** — the *one remaining engine-level limitation*, called out in
both the worker's own doc comment and PROJECT.md's P2.5 bullet as "the next throughput optimization."
Reasoning that beat the alternatives (admin HTTP route, per-key `lastUsedAt`, attempt-log pagination,
operator docs): every feature shipped in the last ~10 ticks was observability / packaging / API
*surface*; the **core delivery engine** still serialized a claimed batch, so one slow/timing-out
receiver blocked every healthy delivery behind it (head-of-line blocking) and `batchSize ×
requestTimeoutMs` could exceed the visibility timeout under load → leases lapse → wasted reclaim churn.
It is a core-path *reliability/throughput* fix (the product's central promise), sits in the loop's
strongest regime (pure, deterministic, fake-clock/gated-transport testable), and needs **zero new deps**.

**Built this tick:**
- **`delivery-worker.ts`** — new `concurrency` option (default `DEFAULT_WORKER_CONCURRENCY = 8`;
  validated positive int; `1` = fully sequential). `processOnce` now delegates the claimed batch to a
  new private `#deliverBatch`: a fixed pool of `min(concurrency, batch)` pump loops, each pulling the
  next un-started task as it frees a slot, collecting outcomes **by original index**. Each `#deliver`
  already settles its own task under its own lease, so the pool needs no extra coordination. The
  "unexpected (non-stale) settle error propagates from `processOnce`" contract is preserved *without*
  leaving sibling rejections unhandled: a pump captures the first such error, the others stop pulling
  new work, and it is re-thrown after the in-flight deliveries settle. Doc comments updated (the lease
  constraint is now `ceil(batchSize/concurrency) × timeout`).
- **`config.ts`** — `POSTHORN_WORKER_CONCURRENCY` (min 1) → `WorkerConfig.concurrency`; **`gateway.ts`**
  passes it to the worker; **`index.ts`** re-exports `DEFAULT_WORKER_CONCURRENCY`.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **591/591** (was
585; **+6**: worker construction-reject `concurrency`, a 4-test gated-transport pool suite —
parallel-but-bounded at the limit, strictly-sequential at `concurrency:1`, a slow receiver does **not**
block the fast deliveries in its batch, in-flight cap holds for a larger batch — and a config
parse/validate case). `npm run build` clean. Integrity gate exit 0; local gate exit 0 (three
hash-protected files untouched).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway with
`POSTHORN_WORKER_CONCURRENCY=4`, fanned one message to a **slow** (500 ms response delay) and a **fast**
receiver, and measured the gap between when each *received* its request: **0 ms** (a sequential worker
would only send to the second after the first's full ~500 ms attempt resolved). Both deliveries verified
via the SDK's own `isValidWebhook`. Exit 0; temp script removed; git shows only the intended files.

**State:** GREEN → committing to main as Iteration 22. Net: head-of-line blocking is gone — a stuck
receiver occupies only its own slot, and the worst-case batch wall time drops by up to `concurrency×`.
The core delivery engine has no remaining known throughput/correctness-under-load gap. **Standing
deferred (next candidates):** admin/control-plane *HTTP* provisioning route (CLI covers local
bootstrap); per-key `lastUsedAt`; attempt-log pagination/retention; an operator deploy/monitoring guide
(last P4 doc item); and the larger P5 hosted control plane.

---

## 2026-05-23 — Iteration 21: P3 — per-attempt delivery audit log (`GET /v1/messages/:id/attempts`)

**Repo truth at start — reconciliation, not a clean baseline.** `git log` head was `51585d7` (iter 20,
OpenAPI), but the **workspace was dirty**: a complete, untracked `src/attempts/` plus matching edits to
the worker, api, openapi, sdk, gateway, index, README, and PROJECT.md — and **no LOOP_LOG entry**. A prior
tick had clearly *built* the per-attempt audit log and *updated the docs to mark it ✅*, then was
interrupted before validating, logging, or committing. So this tick's highest-leverage move was not to
write a new feature but to **reconcile and adjudicate** the orphaned work: prove it green and land it
(Axiom 2), or archive + restore it (Axiom 3). The work is exactly the top "next candidate" iter 20 named
(the remaining observability *depth* item) and matches the dual-backend conformance pattern used
throughout, so it was a credible landing candidate, not slop to discard.

**Reconciliation findings (read before trusting):** reviewed the load-bearing pieces by hand —
`src/attempts/delivery-attempt.ts` (immutable `DeliveryAttempt`, strict `normalizeNewAttempt` intake
guard, `datt_` ids), `sqlite-attempt-store.ts` (the `createRequire("node:sqlite")` builtin path, `STRICT`
append-only table, `idx_delivery_attempts_message`, prepared statements), the **worker hot-path edit**
(records one attempt through a best-effort `recordAttempt` seam *before* settling; latency captured in a
`finally` so a thrown/aborted send still measures; `attemptNumber = task.attempts`, already incremented by
`applyClaim`; a thrown audit write is routed to `onError`, never failing the delivery), the `api.ts` route
(tenant-scoped `404`-not-`403`, explicit `attemptView` map so no internal field leaks, key added to the
compile-checked `API_ROUTE_KEYS` map), and the gateway wiring (opens/closes the 5th SQLite backend, feeds
the worker + HTTP server). Coherent and faithful to the codebase's conventions.

**Force Absolute Validation (the manual gate, per `[[validation-gate-is-manual]]`):** `tsc -p
tsconfig.json --noEmit` clean (strict). `npx vitest run` **585/585** (was 540 at iter 20 end; **+45**: the
new `src/attempts/` suite — pure normalize/id + in-memory & SQLite shared conformance — plus worker
`recordAttempt` cases, api handler, sdk `listMessageAttempts`, gateway end-to-end, and the openapi
operation/schema drift coverage). `npm run build` clean. Integrity gate exit 0; local gate exit 0 (the
three hash-protected files untouched).

**Beyond the gate — compiled-`dist` smoke (the unique production-ESM proof vitest's bundler workaround
can mask):** booted the **built** gateway against a **file-backed** data dir (real `node:sqlite`
`createRequire` path, not `:memory:`), fanned one message to a 200 receiver and a 500 receiver, and polled
`GET /v1/messages/:id/attempts` until **both first attempts were recorded** — `succeeded`/`responseStatus
200` and `failed`/`responseStatus 500`, each `attemptNumber 1`, non-negative `durationMs` — then confirmed
a second tenant's key gets `404` (cross-tenant isolation). Exit 0. Temp dir + smoke script removed; git
status shows only the intended files.

**State:** GREEN → committing the reconciled work to main as Iteration 21. Net: `dead_letter`/`succeeded`
state was already observable; now the *history* behind it is — one immutable record per HTTP attempt, the
view a developer debugs a flaky receiver from. **Standing deferred (next candidates):** an admin/control-
plane *HTTP* route for app/key provisioning (CLI already covers local bootstrap); per-key `lastUsedAt`;
pagination/retention for the attempt log once a single message's attempt count can grow large; and the
larger P5 hosted control plane. With the audit log landed, the v1 observability surface (status → list →
retry → attempts) is complete.

---

## 2026-05-23 — Iteration 20: P3 — OpenAPI 3.1 contract (`GET /openapi.json`)

**Repo truth at start:** clean main @ `7669885`. Baseline re-verified before any change: `tsc --noEmit`
clean, vitest **529/529**, `npm run build` clean. Node 24.15. Reconciled GOAL→PROJECT: Posthorn's v1 is
functionally complete and now *deployable + bootstrappable + monitorable* (iter 18 Docker, iter 19
`/metrics`). The standing deferred list was: **OpenAPI spec**, an admin HTTP route, a per-attempt audit
log, per-key `lastUsedAt`. Iter 19 deferred OpenAPI deliberately ("lower operational value than 'can I
monitor this in prod?'"); with metrics now landed, the cross-language interop/adoption gap is the top item.

**High-leverage move chosen:** Ship the **OpenAPI 3.1 document + `GET /openapi.json`** (checklist #3).
Highest-leverage now because it compounds the just-shipped TS SDK by unlocking **every other language**
(client codegen) + interactive docs (Swagger/Redoc) — a table-stakes adoption/procurement asset the
product lacked — and it sits squarely in the loop's strongest regime: pure, deterministic, **zero new
deps**, low landing risk. Chosen over the **per-attempt audit log** (larger, touches the worker hot path,
migration → higher risk; deferred again) and the **admin HTTP route** (the CLI already covers bootstrap).

**Built this tick:**
- **`src/http/openapi.ts`** — `buildOpenApiDocument()`, a **pure**, zero-dependency builder of a
  hand-authored OpenAPI 3.1 document (15 component schemas modeled byte-faithfully to the real
  `api.ts` views/error envelope; Bearer security scheme + `security:[]` on the three unauthenticated
  routes; `info.version` from the `version.ts`/`createRequire` seam). Hand-authored, not reflected —
  a useful spec carries per-field docs/schemas/error-codes/examples the route table can't.
- **`api.ts` refactor → single source of truth.** Extracted `API_ROUTE_KEYS` (exported), built the
  route table from it via a `Record<ApiRouteKey, RouteHandler>` map (a missing/extra key is a *compile*
  error), added the `GET /openapi.json` handler (served verbatim as JSON), and an exported pure
  `patternToOpenApiPath` (`:id`→`{id}`). Behaviour of the existing 11 routes unchanged (49 api tests green).
- **`index.ts`** re-exports `buildOpenApiDocument`/`OpenApiDocument`/`API_ROUTE_KEYS`/`ApiRouteKey`/
  `patternToOpenApiPath`. **README + PROJECT.md** updated (feature bullet, surface table row, curl line).

**Anti-drift (the load-bearing guarantee, same discipline as the dual-backend conformance suites):**
a **bidirectional drift test** asserts the document's operations exactly equal `API_ROUTE_KEYS`
(mapped via `patternToOpenApiPath`) — a route can never ship undocumented, nor a doc entry without a
route. Plus ref-integrity (every `$ref` resolves) + no-orphan-schema + structure (3.1, unique
operationIds, described responses, the exact 3 unauthenticated routes) tests.

**Validation:** `tsc --noEmit` clean (strict). vitest **540/540** (was 529; +11: openapi suite 9, api +1,
server +1). `npm run build` clean. **Compiled-`dist` smoke:** booted the *built* gateway, fetched
`/openapi.json` over a real socket → 200 `application/json`, `openapi:"3.1.0"`, `info.version:"0.0.1"`
(proves the production `createRequire` path), 12 operations / 15 schemas, retry route present. **Beyond
the gate:** generated the doc and ran the **Redocly CLI OpenAPI linter** (`npx @redocly/cli lint`) →
*"Your API description is valid"*, **0 errors** (only the stylistic `operation-4xx-response` warning on
`/healthz` + `/openapi.json`, which correctly have no client-error path). Smoke artifacts removed; git
status shows only intended files.

**State:** GREEN → committing to main. Next candidates: per-attempt audit log (the remaining
observability *depth* item), an admin/control-plane HTTP route, or P4 operator/deploy docs.

---

## 2026-05-23 — Iteration 19: P4 — Prometheus `/metrics` endpoint (operator observability)

**Repo truth at start:** clean main @ `1f3cca4`. Baseline re-verified before any change: `tsc --noEmit`
clean, vitest **503/503**, `npm run build` clean, integrity + local gate both exit 0. Node 24.15.
Reconciled GOAL→PROJECT: Posthorn stands; v1 is functionally complete (sign → fan-out → deliver →
observe → list → retry; HTTP API + SDK + admin CLI + bootable gateway + single-container image). The
remaining glaring gap in P4 (self-host packaging): you could now *deploy* and *bootstrap* an instance,
but you could not **monitor a running one** — no metrics surface at all. "Does it expose Prometheus
metrics?" is a real self-host procurement question, and it is the operator-facing half of the product's
own "**observable**" promise (the prior ticks' status/list/retry answered the *producer's* questions).

**High-leverage move chosen:** Build a Prometheus **`GET /metrics`** endpoint end-to-end. Highest-
leverage (checklist #3): it closes the production-operability gate that blocks serious self-host
adoption, completes P4's substantive scope, and stays squarely in the loop's strongest regime — fully
deterministic, in-process testable, **zero new dependencies** (a pure text renderer over `node:http`,
the same posture as `node:sqlite`/`node:crypto`). Chosen over the **per-attempt audit log** (larger,
touches the worker hot path → higher landing risk; deferred again) and **OpenAPI** (interop/docs,
lower operational value than "can I monitor this in prod?"). Re-confirmed the sandbox has Docker +
network (memory `[[sandbox-has-network-and-docker]]`), but this tick needed neither — it validates
fully on the manual gate plus a compiled-`dist` smoke.

**Built this tick:**
- **`src/metrics/metrics.ts`.** `MetricsRegistry` — a tiny in-memory accumulator of monotonic counters
  (arrow-bound `recordIngest`/`recordTick` so they pass as bare callbacks) + uptime from an injected
  clock; holds no domain logic. `renderPrometheus(snapshot)` — a **pure**, exhaustively-tested function
  to v0.0.4 text exposition (HELP/TYPE headers, labeled series, label-value escaping, trailing newline).
- **`DeliveryQueue.countByStatus()`** — the load-bearing new read primitive behind the backlog gauge.
  Added to the contract + a shared `DeliveryCountsByStatus` type + `zeroDeliveryCounts()` helper, both
  backends (in-memory tally; SQLite a single prepared `GROUP BY status` scan), and the one shared
  conformance suite (+3×2 cases: empty, all-four-statuses, reflects-a-transition). Always returns every
  status key (zero when none) so a full gauge family renders.
- **`DeliveryWorker.onTick(result)`** — an optional observability seam (sibling of `onError`) called
  once per `processOnce` tick with its `TickResult`; the gateway wires `onTick: metrics.recordTick`.
  The worker gains *no* metrics logic. Counters: ingested / deduplicated / `deliveries_total{outcome}`.
- **HTTP.** `ApiResponse.contentType` — a raw-body escape hatch so the adapter writes the Prometheus
  text verbatim instead of JSON-encoding it (`server.ts`). `GET /metrics` route (`api.ts`),
  unauthenticated like `/healthz`; reads `countByStatus()` at scrape time, renders, returns text. Ingest
  is counted in `createMessage`. `metrics?` added (optional) to `ApiDeps` → `404` when not wired.
- **Gateway + version.** `createGateway` constructs the registry (version from `POSTHORN_VERSION`),
  wires it to the worker (`onTick`) and the HTTP deps, and exposes it on `Gateway`. New `src/version.ts`
  reads `package.json`'s version once via `createRequire` (same idiom as `node:sqlite`; degrades to
  `"unknown"` if not found, so a cosmetic label can never break `/metrics`). New public symbols exported
  from `src/index.ts`.
- **Docs reconciled to reality.** README: a Status bullet + a `/metrics` curl example + the route table
  row. PROJECT.md: P4 metrics ✅ with the design + validation evidence; P4 remaining narrowed to operator
  docs.

**Key decisions (honest tradeoffs):** **unauthenticated** `/metrics` (Prometheus norm) — it exposes only
instance-aggregate data (counts, a backlog gauge), never a tenant id, payload, or secret; documented
that operators restrict it at the network layer, with a dedicated admin port / opt-out flag noted as a
later add (kept config.ts untouched this tick). **Counters in-memory / process-lifetime** (reset on
restart) — correct for the single-process, no-Redis model, and Prometheus detects resets; a multi-replica
P5 plane aggregates per-instance series the usual way. Backlog as a **scrape-time gauge** from the queue
(never stale) vs. counters for throughput — the idiomatic split. Fed metrics through the *existing* ingest
+ worker-tick seams rather than mutating the delivery hot path (the per-attempt-audit-log risk we keep
deferring). Modeled the delivery breakdown as one labeled counter (`outcome=`) not four metric names.

**Validation:** `tsc --noEmit` clean (strict). vitest **529/529** (was 503; +26: metrics 13, queue
conformance 3×2=6, api route 4, server raw-text 1, worker onTick 1, gateway end-to-end 1). `npm run
build` clean. **Compiled-`dist` smoke** (production ESM, in-memory gateway + a real receiver): ingest →
worker delivers → poll `/metrics` until `posthorn_deliveries_total{outcome="succeeded"} 1`, asserting
the v0.0.4 content-type, `posthorn_messages_ingested_total 1`, the backlog gauge, and
`posthorn_build_info{version="0.0.1"}` (proving `version.js` + `SqliteDeliveryQueue.countByStatus`'
`createRequire`/`node:sqlite` paths work in the built output). Integrity + local gate: exit 0. The three
hash-protected files were not touched.

**State:** GREEN → committing to main. Posthorn is now deployable, bootstrappable, *and monitorable*.
Next ticks: operator docs (deploy/monitoring guide, closes P4); then the per-attempt audit log or OpenAPI
(P3 deferred), or begin P5 (hosted control plane).

---

## 2026-05-23 — Iteration 18: P4 — single-container `Dockerfile` (the deployment wedge made real)

**Repo truth at start:** clean main @ `6c37137`. Baseline re-verified before any change: `tsc --noEmit`
clean, vitest **503/503**, `npm run build` clean, integrity + local gate both exit 0. Node 24.15.
Reconciled GOAL→PROJECT: Posthorn stands; the product is functionally complete for v1 (sign → fan-out →
deliver → observe → list → retry, HTTP API + SDK + admin CLI + bootable gateway). The glaring gap: the
**entire market wedge is "deploy as one container, no Redis," and there was no `Dockerfile`** — the
headline differentiator existed only as prose. P4's top remaining item.

**Re-tested a blocking assumption from iter 17 — it was wrong.** Iter 17 deferred the Dockerfile as
"un-validatable green here — needs network egress this sandbox blocks." I probed it directly: `docker
--version`/`docker info` (29.4.3, daemon live), `docker pull node:24-alpine` **succeeded**, and `npm ci`
**inside the build succeeded**. Network egress is available. So the Dockerfile is not only the
highest-leverage move (realizes the wedge, unblocks all self-host adoption) but now **fully validatable
for real** — a `docker build` + `docker run` smoke that *exceeds* the standard gate. Chosen over the
metrics endpoint / operator docs (smaller, and docs follow a real artifact) and the per-attempt audit log
(deferred again — larger, touches the worker hot path, higher landing risk).

**Built this tick:**
- **`Dockerfile` (multi-stage).** Stage 1 (`node:24-alpine`): `npm ci` (cached on lockfile) → `tsc` →
  `dist/`, then strips the compiled `*.test.*` output tsc emits from `src/**/*.test.ts` (never on the
  runtime graph). Stage 2 (`node:24-alpine`): copies **only** `dist/` + the `package.json` that marks the
  output ESM (`"type":"module"`) — **no `node_modules`, because the runtime has zero dependencies** (every
  moving part is a `node:*` builtin: `node:http`/`node:sqlite`/`node:crypto`). The cleanest possible
  expression of the wedge: nothing to `npm install`, audit, or patch in the runtime image.
- **Hardening / ops.** Runs as the unprivileged `node` user (uid 1000); durable SQLite state on a `/data`
  `VOLUME` (chowned to `node` before the privilege drop, so anonymous volumes inherit a writable baseline);
  `POSTHORN_*` defaults (`HOST=0.0.0.0`, `PORT=3000`, `DATA_DIR=/data`); a dependency-free `HEALTHCHECK`
  using Node's built-in `fetch` against `/healthz` (no curl/wget). One exec-form
  `ENTRYPOINT ["node","dist/main.js"]`: `node` is PID 1 and receives `SIGTERM` directly → the existing
  graceful drain; no args → gateway, `admin <command>` args → the one-shot bootstrap. Same image runs the
  server *and* mints the first key.
- **`.dockerignore`** keeps the build context to just the compiled sources (`src/`, `package*.json`,
  `tsconfig.json`); excludes `node_modules`/`dist`/`.git`/state/docs so the image is reproducible and lean.
- **Docs reconciled to reality.** README: a "Run with Docker (the headline deployment)" subsection (build/
  run/admin/volume/healthcheck/uid-1000 bind-mount caveat) + a Status bullet. PROJECT.md: P4 Dockerfile ✅
  with the validation evidence.

**Key decisions (honest tradeoffs):** pinned `node:24-alpine` to match the dev/test runtime (`node:sqlite`
is a stable builtin there; Alpine = small) — image ~231 MB, dominated by the Node base, acceptable for v1
(a `slim`/distroless shave is a later optimization). Did **not** add `tini`/`--init`: the app spawns no
children and handles its own signals, so PID-1 `node` is correct and lighter; noted `--init` is harmless if
an operator wants it. Stripped only `*.test.*` from `dist` (clearly off the runtime graph) rather than
introducing a second `tsconfig.build.json` — keeps **one** validated build path, no config fork. Kept the
existing `npm run build`; the container reuses it verbatim.

**Validation (exceeds the standard gate):** standard gate first — `tsc --noEmit` clean, vitest **503/503**
(no source changed; Docker/docs-only), `npm run build` clean, integrity + local gate exit 0, three
hash-protected files untouched. Then a **real container smoke**: `docker build -t posthorn:smoke .`
succeeds; booted container serves `/healthz` 200 and Docker reports `healthy`; a *separate* `admin`
container sharing the `/data` volume mints app+key and the **running server authenticates that key over
HTTP** (401 without → 200 on `/v1/endpoints`, 202 on `POST /v1/messages`); the sent message is listable;
`docker stop` logs the graceful `SIGTERM` drain; and the message **survives a full teardown + fresh boot on
the same volume** (durability, no Redis). Smoke artifacts (image/volume/containers) removed after.

**State:** GREEN → committing to main. The "single container, no Redis" wedge is now a thing you can
`docker run`, not a claim. Next ticks (P4 tail): a metrics endpoint, operator docs; then OpenAPI / a
per-attempt audit log (P3 deferred).

---

## 2026-05-23 — Iteration 17: P3 — manual retry / replay (`POST /v1/messages/:id/retry`)

**Repo truth at start:** clean main @ `fe2ca77`. Baseline re-verified before any change: `tsc --noEmit`
clean, vitest **479/479**, `npm run build` clean, integrity + local gate both exit 0. Node 24.15 /
Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands; repo is far past the GOAL's "decide a
project" stage. The glaring gap after iter 16: the send→fan-out→deliver→observe→list loop is complete,
but `dead_letter` was a **terminal dead end** — once a receiver outage exhausted the retry schedule,
nothing could make Posthorn try again. The delivery FSM had *no* transition out of a terminal state, the
queue *no* re-drive primitive, and the API *no* route. "Replay"/"retry" is a feature every incumbent
(Svix/Convoy/Hookdeck) exposes; it is the unaddressed half of the tagline's "**retried**".

**High-leverage move chosen:** Build **manual retry** end-to-end — FSM `manualRetry` → queue `retry` →
`retryMessageDeliveries` service → `POST /v1/messages/:id/retry` → SDK `client.retryMessage`. Highest-
leverage (checklist #3): it closes a *functional capability* gap (not docs), turns `dead_letter` from a
permanent loss into a recoverable state (a real product limitation), and completes the operability story
the prior two ticks began (status read → listing → **recovery**). Chosen over **OpenAPI** (interop/docs,
smaller user value than recovering lost deliveries), the **per-attempt audit log** (larger, touches the
worker hot path → higher landing risk), and the **Dockerfile** (still un-validatable green here — needs
network egress this sandbox blocks). Stayed in the loop's strongest regime: fully deterministic, in-process
testable, **zero new deps**, on the proven pure-core / interface+two-backends+one-conformance-suite pattern.

**Built this tick:**
- **FSM `manualRetry` (`src/delivery/delivery-state.ts`).** The lone transition *out* of a terminal state:
  legal only from `succeeded`/`dead_letter` (illegal from `pending`/`delivering` — those are already being
  driven), reviving the delivery as brand-new: `pending`, `nextAttemptAt:null` (deliverable now),
  **`attempts:0`** (a fresh budget — keeping the exhausted count would re-dead-letter on the first new
  attempt), `lastError:null`. The exhaustive switch forced the case (no fallthrough), so the FSM stays the
  single source of transition truth.
- **Queue `retry` primitive + `applyManualRetry` (`src/queue/`).** Pure `applyManualRetry` defers to the
  reducer (terminal→pending can't drift) and clears the lease overlay; `DeliveryQueue.retry(taskId)` added
  to the contract + both backends (in-memory; SQLite in a `BEGIN IMMEDIATE` txn that rolls back a non-
  terminal retry). +4 shared conformance cases × 2 backends: revives dead_letter (claimable, budget reset),
  revives succeeded (a resend), `UnknownDeliveryTaskError` (unknown id), `DeliveryStateError` (non-terminal,
  task left untouched).
- **`retryMessageDeliveries` service (`src/queue/retry-message.ts`).** The structural twin of `fanOut`:
  lists a message's tasks, re-drives only the **dead-lettered** ones (succeeded/in-flight/pending untouched
  — replaying healthy deliveries is not "retry the failures"), returns `{messageId, retried, tasks}` (the
  refreshed snapshots). Absorbs the concurrent double-retry race (`DeliveryStateError`/`UnknownDeliveryTaskError`
  ⇒ "already revived", the same expected-catchable pattern as a lapsed lease). 5 tests incl. a worker-driven
  **full recovery loop** (ingest → fail → dead_letter → retry → delivered).
- **HTTP route + SDK.** `POST /v1/messages/:id/retry` (`src/http/api.ts`): tenant from the key, another
  tenant's/absent message is `404` (existence never revealed, identical to the read route); returns the
  refreshed per-endpoint statuses (replayed ones back to `pending`); internal `leaseToken` never exposed.
  `client.retryMessage(id)` (`src/sdk/client.ts`) + the `RetryMessageResponse` wire view. New public symbols
  re-exported from `src/index.ts`. Fixed two inline `DeliveryQueue` stubs in the worker test for the new
  contract method.

**Key decisions (honest tradeoffs):** reset the attempt budget on retry (the feature's whole point — a full
fresh schedule after the receiver is fixed) at the cost of losing the prior count, which a future per-attempt
audit log would preserve. Target **dead_letter only** (the unambiguous "needs human intervention" state),
not pending/delivering/succeeded — crisp semantics, no surprise re-sends to healthy receivers; "force-retry
pending" / "resend succeeded" noted as possible later options (the FSM/queue primitive already permits
reviving `succeeded`, the route just doesn't expose it). Modeled the transition in the FSM (not ad-hoc in the
queue) so it can't drift. Extracted a tested `retryMessageDeliveries` rather than inlining in the route, for
symmetry with `fanOut`/`ingest` and reuse (a future `posthorn admin retry-message`).

**Validation:** `tsc --noEmit` clean (strict). vitest **503/503** (was 479; +24: FSM 3, conformance 4×2=8,
service 5, api route 5, SDK 3). `npm run build` clean. **Smoke-tested the compiled `dist`** (SQLite backends,
production ESM): ingest → worker dead-letters → `retryMessageDeliveries` → worker delivers a request that
**verifies** against the endpoint secret → status `succeeded` (exercised the `node:sqlite` `createRequire`
path in `SqliteDeliveryQueue.retry`). Integrity + local gate: exit 0. The three hash-protected files were not
touched.

**State:** GREEN → committing to main. `dead_letter` is no longer a dead end — a sustained-outage delivery is
recoverable on demand, end-to-end. Next tick: the **OpenAPI** spec over this surface (other-language clients +
interactive docs); the **per-attempt audit log** (richer than the latest-state-per-endpoint view, and would
restore full attempt history across a manual retry); or the single **Dockerfile** to finish P4 (still blocked
on validatable network egress here).

---

## 2026-05-23 — Iteration 16: P3 — message listing (`GET /v1/messages`, keyset-paginated)

**Repo truth at start:** clean main @ `f6030ba`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **450/450**, `npm run build` clean, integrity + local gate both exit 0.
Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands; repo is far past the
GOAL's "decide a project" stage. The glaring gap after iter 15: the server + SDK cover the full
send→observe-*one*-message→verify loop, but there was **no way to enumerate messages** — a producer
could read `GET /v1/messages/:id` only if it had kept the id; it could not browse what it sent. Every
incumbent's dashboard centers on a messages list, and PROJECT.md listed `GET /v1/messages` (gated on a
`MessageStore.listByApp`) as deferred. Also note: there was **no query-string plumbing** in the HTTP
layer at all (`server.ts` discarded it), so pagination needed that rail built too.

**High-leverage move chosen:** Build **`GET /v1/messages`** — tenant-scoped, **keyset-paginated**
message listing — backed by a new `MessageStore.listByApp`, plus query-string support in the HTTP layer
and `client.listMessages` on the SDK. Highest-leverage (checklist #3): it closes a *functional* gap (not
docs), completes the "observable" half of the product (iter 14 did the single message; this does the
collection), and lays a **reusable `?limit=&cursor=` rail** every future list/filter route — and the P5
control-plane dashboard — needs; messages is exactly the unbounded collection where pagination is
mandatory. Chosen over **OpenAPI** (interop/docs, not a capability — a smaller user value than the
missing browse) and the **per-attempt audit log** (larger, touches the worker hot path → higher risk to
land green in one tick) and the **Dockerfile** (still un-validatable green here — `docker build` needs
network egress this sandbox blocks). The loop's strongest regime: fully deterministic, in-process
testable, **zero new deps**; followed the proven pure-core / interface+two-backends+one-conformance-suite
pattern.

**Built this tick:**
- **`MessageStore.listByApp(appId, {limit, cursor})` → `MessagePage` (`src/storage/message-store.ts`).**
  Newest-first by `(createdAt, id)` DESC, **keyset** (not offset) paginated: an opaque base64url cursor
  encodes the last row's `(createdAt, id)`; the next page is everything strictly older. Keyset is stable
  under concurrent inserts (a new message appears on page one, never shifting an in-flight scan — the
  classic offset bug) and stays indexed as the log grows unbounded. Shared pure helpers are the single
  source of the rule: `encodeMessageCursor`/`decodeMessageCursor` (malformed → `TypeError`),
  `resolveListMessagesQuery` (limit defaults 50, capped at `MAX_LIST_MESSAGES_LIMIT=200`, RangeError
  otherwise), and `compareMessagesNewestFirst`/`isMessageAfterCursor` — the in-memory backend sorts by
  the comparator, SQLite mirrors it as `ORDER BY created_at DESC, id DESC` + the keyset predicate, so the
  two cannot drift (ids are ASCII ⇒ JS string order == SQLite BINARY collation).
- **Both backends + conformance.** In-memory: filter+sort+slice (fetch-one-extra signals a further page).
  SQLite: two prepared statements (first page / keyset page) + a new `idx_messages_app_created
  (app_id, created_at, id)` created via `IF NOT EXISTS` — **no migration**, a pure read optimization over
  existing rows (same reasoning as iter 14's per-message index). 9 new shared conformance cases × 2
  backends (empty, newest-first, tenant-scoping, multi-page coverage with no overlap/gaps, exact-multiple
  termination [no phantom trailing page], same-ms id tiebreak, limit out-of-range reject, malformed-cursor
  reject, real-cursor round-trip).
- **HTTP query rail + route (`src/http/api.ts`, `server.ts`).** `ApiRequest` gained a `query` map, filled
  by the `node:http` adapter from `URL.searchParams` (first value wins for repeats) — the reusable rail.
  `GET /v1/messages` validates `?limit=` to a `400` and passes `?cursor=` through (a malformed one →
  `TypeError` → `400` via the existing map); tenancy is the key's, so a listing never reveals another
  tenant's messages. **Lean list rows** (`messageListItemView`): id/appId/eventType/idempotencyKey/
  createdAt only — no payload, no deliveries, so a page never fans out into an N+1 delivery query (detail
  stays on `/:id`).
- **SDK `client.listMessages({limit, cursor})` → `{ data: MessageRef[], nextCursor }`** (`src/sdk/client.ts`),
  building the query string via `URLSearchParams`. Re-exported new public types/constants from
  `src/index.ts` (storage `ListMessagesOptions`/`MessagePage`/`MessageCursor` + cursor helpers + limit
  constants; SDK `ListMessagesParams`/`MessageListPage`). README + PROJECT.md updated; the deferred list
  dropped the message-list item.

**Key decisions (honest tradeoffs):** keyset over offset (correctness under concurrent writes + indexed
at scale, at the cost of opaque cursors — the right call for an append-only log). Lean list rows over
embedding delivery status per row (avoids N+1; detail view already exists). `query` made a **required**
`ApiRequest` field (one test helper + the one adapter updated) rather than optional, so handlers never
thread an `undefined`. List items typed as the existing SDK `MessageRef` (identical shape) rather than a
new wire type — less surface, no lie.

**Validation:** `tsc --noEmit` clean (strict). vitest **479/479** (was 450; +29: conformance 9×2=18,
api list block 7, server query-parse 1, SDK 3 [in-process paging + 2 injected-fetch URL-construction]).
`npm run build` clean. **Smoke-tested the compiled `dist`**: boot gateway → SDK send 5 → page through
3×(limit 2) → distinct full coverage, full list lean (no payload/deliveries) + `nextCursor:null`, unknown
id still `404` — through production ESM. Integrity + local gate: exit 0. The three hash-protected files
were not touched.

**State:** GREEN → committing to main. A producer can now browse everything it has sent, paginated and
tenant-scoped, and the HTTP layer has a reusable query/pagination rail. Next tick: the **OpenAPI** spec
over this surface (other-language clients + docs); the **per-attempt audit log** (richer than the
latest-state-per-endpoint view); or the single **Dockerfile** to finish P4 (blocked on validatable
network egress here).

---

## 2026-05-23 — Iteration 15: P3 — the first-class TS/JS SDK (the consumer's touchpoint)

**Repo truth at start:** clean main @ `f1a7608`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **420/420**, `npm run build` clean, integrity + local gate both exit 0.
Node 24 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands; repo is far past the
GOAL's "decide a project" stage. Verified a *product* fact before choosing: iter 14's `GET
/v1/messages/:id` is reachable — `POST /v1/messages` does return `message.id` in its 202 (`api.ts`
:319), so the read API is not stranded. The glaring gap after iter 14: the server surface is
feature-complete and observable, but there was **no client SDK** — a consumer had to hand-roll
`fetch`, header construction, error parsing, *and* the receiver-side signature verification. Yet
"first-class TS/JS SDK" is the named DX differentiator in PROJECT.md's wedge table and the #1
deferred item.

**High-leverage move chosen:** Build the **TypeScript/JavaScript SDK** (`src/sdk/`). Highest-leverage
(checklist #3) because it is the *consumer's entire touchpoint* (send → observe → verify received
webhooks) — the move that most advances adoption / "beyond-market DX," the product's stated goal.
Chosen over the **Dockerfile** (a `docker build` pulls a base image needing network egress this
sandbox blocks → it cannot be *validated* green, violating "Force Absolute Validation"; iter 14
already judged it "convenience over an already-runnable process") and over the **per-attempt audit
log / `GET /v1/messages` list** (incremental observability over what iter 14 already made gating; the
SDK is the higher consumer-value unit). Exactly the loop's strongest regime: fully deterministic,
in-process testable against the real server on an ephemeral port, **zero new runtime dependencies**
(platform `fetch` + the existing verifier), preserving the zero-dep wedge.

**Built this tick (`src/sdk/`):**
- **`client.ts` — `PosthornClient`.** A typed wrapper over the whole v1 surface
  (`health`/`sendMessage`/`getMessage`/`listEndpoints`/`createEndpoint`/`getEndpoint`/`updateEndpoint`/
  `deleteEndpoint`). Errors are mapped: a non-2xx → **`PosthornApiError`** (carries HTTP `status` + the
  `{error:{code,message}}` envelope's machine `code`, falling back to `http_<status>` for a non-envelope
  body), a transport failure → **`PosthornError`** (with `cause`), a request past `timeoutMs` →
  **`PosthornTimeoutError`** (via an internal `AbortController`; default 30s, `0` disables). `fetch` is
  injectable (the `PosthornFetch` structural subset the platform global satisfies) so error/timeout/
  parse paths are unit-testable with no socket. The wire types are **SDK-owned views**, not the server's
  domain types, because the HTTP surface returns reduced shapes (endpoint `secret` write-only; delivery
  `leaseToken` never exposed) — the SDK models exactly what crosses the wire.
- **`verify.ts` — the receiver half.** `verifyWebhook(secret, headers, rawBody, opts?)` and the
  non-throwing `isValidWebhook(...)` extract the three Standard Webhooks headers from a raw header bag
  (case-insensitive, collapsing node's array-valued headers) and delegate to the library `verify` — no
  crypto duplicated, so SDK and core can't drift. Docstring hammers the one footgun: verify the **raw
  bytes as received**, before any JSON round-trip.
- Re-exported the whole SDK surface from `src/index.ts` (client + types + the three error classes +
  `verifyWebhook`/`isValidWebhook`/`IncomingHeaders`). README gained a status bullet + a "Quickstart (TS
  SDK)" (send + receive); PROJECT.md P3 gained the SDK bullet and the deferred list dropped "TS SDK".

**Key decisions (honest tradeoffs):**
- **`getMessage().payload` is the raw signed JSON *string*, not a parsed value.** It is the exact bytes
  delivered/signed; the SDK surfaces it losslessly and documents `JSON.parse` to recover the value.
  Parsing for the caller would hide what was actually on the wire.
- **SDK-owned wire types over re-exporting domain types.** Slightly more type code, but it can't lie
  about secret/leaseToken being absent from reads, and it decouples the SDK from internal store shapes.
- **OpenAPI deferred (not bundled).** The SDK serves typed TS consumers now; an OpenAPI spec (other-
  language clients + interactive docs) is a distinct, larger artifact and a separate tick. Logged.

**Validation:** `tsc --noEmit` clean (strict). vitest **450/450** (was 420; +30: verify 10
[authentic/tampered/wrong-secret/missing-header/case-insensitive/array-valued/replay-window +
isValid×3], client 20 [in-process CRUD + send + status-read + idempotency + secret-never-leaked +
401/404 mapping + trailing-slash + 3 construction guards + injected-fetch envelope/`http_<status>`/204/
parse-error/transport-error/timeout + a full **end-to-end driven entirely through the SDK**: send →
running worker delivers → receiver verifies with the SDK's own `verifyWebhook` → `getMessage` observes
`succeeded`]). `npm run build` clean. **Smoke-tested the compiled `dist`**: the same full SDK loop
(health → create [secret once, never leaked on get] → send → deliver → `verifyWebhook` passes, tampered
rejected → poll `getMessage` to `succeeded` → idempotency dedup → unknown-id `404` PosthornApiError)
through production ESM incl. the `node:sqlite` `createRequire` path. Integrity + local gate: exit 0.
The three hash-protected files were not touched.

**State:** GREEN → committing to main. A consumer's whole integration — send, observe, and verify
received webhooks — is now one typed, zero-dependency import. Next tick: the **OpenAPI** spec (other-
language clients + docs) over this surface; the single **Dockerfile** to finish P4 packaging; or a
per-attempt audit log + `GET /v1/messages` list for richer observability.

---

## 2026-05-23 — Iteration 14: P3 — delivery-status read API (the "observable" promise made real)

**Repo truth at start:** clean main @ `24400c4`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **407/407**, `npm run build` clean, integrity + local gate both exit 0.
Node 24.15 / Docker 29.4.3 present / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands;
the repo is far past the GOAL's "decide a project" stage. Inspected the live HTTP surface (`api.ts`):
it can **accept** (`POST /v1/messages` → 202) and CRUD endpoints, but there was **no way to read what
happened to a delivery** — no `GET /v1/messages/:id`, no delivery-status read of any kind. The queue
persists per-task `status`/`attempts`/`lastError` but exposed only `get(taskId)`/`claimDue`; the 202
doesn't even return task ids. So a producer fired a message into a void: the product's own one-liner
promises "signed, retried, **observable** webhooks," yet observability was entirely absent.

**High-leverage move chosen:** Build the **delivery-status read API**. Highest-leverage (checklist #3)
because it adds a *gating* product capability, not sugar: for a *reliable-delivery* product, inability
to observe delivery outcomes is the most fundamental missing piece, and per-message status is the
single most-used feature of every incumbent (Svix/Convoy dashboards). Chosen over the **Dockerfile**
(the service already runs via `npm start`; containerization is convenience over an already-runnable
process and adds no new capability) and the **TS SDK** (which would *wrap* this read — it is upstream).
Exactly the loop's strongest regime: fully deterministic, in-process testable, **zero new
dependencies**. Followed the proven pure-core / interface+two-backends+one-conformance-suite patterns.

**Built this tick:**
- **`DeliveryQueue.listByMessage(messageId)`** — the load-bearing read primitive (the data was already
  persisted; nothing exposed it per message). Added to the contract (a pure read: oldest-first, `[]`
  for unknown/empty id, never throws, never mutates), to **both backends** (in-memory: filter the
  insertion-ordered map; SQLite: `WHERE message_id ORDER BY rowid` + a new
  `idx_delivery_tasks_message`, added to the schema via `IF NOT EXISTS` so a pre-index DB gains it
  automatically on next open — **no migration needed, it is a pure read optimization over existing
  rows**), and to the **one shared conformance suite** (3 cases: empty for unknown, oldest-first +
  scoped-to-message, reflects post-transition state) so the two backends can't drift.
- **`GET /v1/messages/:id`** (`src/http/api.ts`) — authenticated; loads the message, **404 if absent
  or another tenant's** (existence never revealed — identical to the endpoint routes; tenancy from the
  key, never the body), lists its tasks, and returns a `messageView` (id/appId/eventType/idempotencyKey/
  **payload echoed**/createdAt + `deliveries[]`). `deliveryView` surfaces status/attempts/nextAttemptAt/
  lastError/endpointId/timestamps and **omits the internal `leaseToken`**. Route ordering is safe:
  `/v1/messages` (2 segments, POST) and `/v1/messages/:id` (3 segments, GET) never collide.

**Key decisions (honest tradeoffs):**
- **Latest-state-per-endpoint, not a full per-attempt audit log.** The view shows each delivery's
  *current* task state; a per-HTTP-attempt history (one row per attempt with response detail) is the
  richer observability add-on, still deferred and logged (distinct from the load-bearing state shown).
- **Single-message read only; no `GET /v1/messages` list yet.** A tenant-wide list needs a
  `MessageStore.listByApp` (+ pagination) that doesn't exist; the bounded single-id read is the precise
  high-value slice. Logged as the next deferred item.
- **Payload is echoed back** in the status read (the producer's own data, tenant-scoped) — useful for
  "what did I actually send?" debugging; the 202 create response still omits it for brevity.

**Validation:** `tsc --noEmit` clean (strict). vitest **420/420** (was 407; +13: queue conformance 3
× 2 backends = 6, api 6 [401/404-unknown/pending-before-worker/succeeded-after-worker/empty-deliveries/
404-cross-tenant], gateway 1 real-socket end-to-end [ingest → running worker delivers → poll status →
`succeeded`]). `npm run build` clean. **Smoke-tested the compiled `dist`** on the **SQLite** backends
through `createApi` (ingest → status `pending`/0 attempts, payload echoed, no `leaseToken` leak → worker
drains → status `succeeded`/1 attempt → cross-tenant read `404`), through production ESM incl. the
`node:sqlite` `createRequire` path. Integrity + local gate: exit 0. The three hash-protected files were
not touched.

**State:** GREEN → committing to main. Posthorn's deliveries are now observable: a producer can ask
what became of any message it sent. Next tick: the **TS SDK** + **OpenAPI** over this surface (now
including the status read), the single **Dockerfile** to finish P4 self-host packaging, or a per-attempt
audit log + `GET /v1/messages` list for richer observability.

---

## 2026-05-23 — Iteration 13: P3/P4 — admin provisioning CLI (the deployed gateway becomes usable)

**Repo truth at start:** clean main @ `e71de03`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **385/385**, `npm run build` clean, integrity + local gate both
exit 0. Node 24 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 12: the gateway boots and serves an authenticated HTTP API, and the core delivery
path is now crash-consistent — **but there was no way to create the first credential against a
running deployment.** Every API route requires a Bearer key; minting that key existed *only* as the
programmatic `AppStore` surface (`gateway.ts`'s own docstring: "provisioning is done programmatically
… by an admin script" — a script that did not exist). So a freshly-deployed `posthorn` could be
*started* but its entire authenticated API was **unreachable out of the box** unless the operator
wrote and ran TypeScript. For a product whose standalone-gateway half is a headline wedge, "boots but
cannot be used" is the dominant defect.

**High-leverage move chosen:** Build the **`posthorn admin` provisioning CLI**. Highest-leverage
(checklist #3) because it converts a startable-but-unusable service into an *operable* one — the
single biggest systemic step available. Chosen over the **Dockerfile** (which without provisioning
would `docker run` into the same unusable state — provisioning is strictly upstream) and over the
**SDK/OpenAPI** (which describe an API you still can't authenticate against). It is also the regime
this loop is strongest in: fully deterministic, in-process testable, **zero new dependencies**
(node built-ins only). Security boundary chosen deliberately: provisioning lives behind **the shell
on the host that owns the data directory**, *not* an open HTTP route — exactly the door Iter 10
refused to build. The CLI naturally pairs with a future Dockerfile (`docker exec … posthorn admin …`),
so it is not throwaway.

**Built this tick:**
- **`src/runtime/admin.ts`** — `runAdminCommand(args, {store, out, err})`: the tested core. Takes an
  injected `AppStore` + output sinks, dispatches `create-app [name]` / `create-key <appId>` (prints
  the one-time secret + a "shown ONCE" warning + the `Authorization: Bearer` hint) / `list-apps` /
  `list-keys <appId>` / `revoke-key <keyId>` / `help`, and **returns a process exit code** (`0` ok,
  `1` usage error or failed op). Performs no I/O of its own — every command's behaviour, exit code, and
  exact output is unit-testable without a process/socket/fs. Expected failures (unknown app, nothing to
  revoke) are reported via `err` and the exit code, never thrown. `list-keys` distinguishes
  unknown-app (error) from app-with-no-keys (ok) via a `store.get` probe.
- **`src/main.ts`** — gained an `admin` dispatch: `argv[0] === "admin"` runs a one-shot command (open
  the `SqliteAppStore` at the configured `dataDir`, run, close, set `process.exitCode`) and exits; any
  other invocation boots the server as before. The existing boot logic moved into `runServer()`; the
  file stays the thin, untested process shell (the core it drives is tested).
- **`src/runtime/gateway.ts`** — `resolveLocations` (+ its `StoreLocations` type) is now **exported**
  and documented as the single source of truth for the on-disk store layout, so the admin path and the
  running gateway open the *same* `apps.db` and can never drift. `src/index.ts` re-exports the admin
  surface (`runAdminCommand`, `ADMIN_USAGE`, `AdminDeps`) + `resolveLocations`/`StoreLocations`.

**Key decisions (honest tradeoffs):**
- **CLI, not an HTTP route.** A control-plane HTTP route for provisioning is still deferred (it needs
  its own admin-auth design); the filesystem-gated CLI is the correct, smaller bootstrap primitive and
  the right privilege boundary for v1. Logged.
- **WAL makes admin-vs-live-server safe.** The app store opens in WAL mode, so a separate admin
  process writing while the server reads/runs is fine. A rare `SQLITE_BUSY` is possible if both write
  the exact same instant (server app/key writes are rare — it mostly *reads* on authenticate); no
  busy-retry added in v1, noted not hidden.
- **Test-fixture pitfall hit + fixed (same class as Iter 9):** the first test secret (`phk_secret_1`)
  was exactly 12 chars — equal to the display-prefix length — so the leak-check ("the full secret never
  appears in `list-keys`") falsely failed because the prefix *was* the whole secret. Fixed by using a
  realistically long test secret so the 12-char prefix is a strict truncation.

**Validation:** `tsc --noEmit` clean (strict). vitest **407/407** (was 385; +22 admin: per-command
success + failure paths, usage/exit-code semantics, no-secret-leak, and an end-to-end "a CLI-minted
secret authenticates against the store / a revoked one does not"). `npm run build` clean.
**Smoke-tested the compiled `dist` across processes**: `node dist/main.js admin create-app/create-key`
in one process, then a separately-spawned `node dist/main.js` server authenticated the minted key over
real HTTP (`401` without → `200` with), a CLI `revoke-key` was honored live (→ `401`), and `list-keys`
never echoed the full secret — through production ESM incl. the `node:sqlite` `createRequire` path.
Integrity + local gate: exit 0. The three hash-protected files were not touched.

**State:** GREEN → committing to main. A deployed Posthorn can now be bootstrapped end-to-end without
writing code: `npm start`, then `posthorn admin create-app` + `create-key`, and curl the API with the
key. Next tick: the single **Dockerfile** (finishes the P4 single-container story, now that the bootstrap
exists) + a **metrics endpoint**, or the **TS SDK** + **OpenAPI** over the HTTP surface.

---

## 2026-05-22 — Iteration 12: P3 — transactional outbox (close the accept→fan-out crash window)

**Repo truth at start:** clean main @ `4beaa66`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **355/355**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 11: the gateway is now *runnable*, but `ingest` had **one known correctness hole** —
its create-then-fan-out was not atomic. A crash after the message is stored but before fan-out
completes leaves a message whose idempotent retry **dedups and skips fan-out** → some/all of its
deliveries are *never enqueued*. For a product whose entire value is *reliable* delivery, an
accepted message that is silently delivered **zero** times is the worst possible failure. Every
prior tick (5×) deferred this "on principle" — runnability was upstream. Iter 11 explicitly named
the outbox "the clearly-named next correctness tick." So it was now the unambiguous highest-leverage
move (checklist #3: maximize systemic value), and it is exactly the deterministic, in-process-
testable regime this loop is strongest in (Axiom 2). Chosen over the Dockerfile/SDK (additive
packaging/DX, no correctness gain) because closing a *zero-once* delivery bug in a reliability
product dominates.

**Design — transactional outbox, faithful to the cross-store reality.** The four stores are
separate SQLite files, so you cannot enqueue into the queue *inside* the message's transaction.
The outbox pattern bridges exactly that: record the **intent** ("this message owes a fan-out") in
the *same* transaction that accepts the message, then relay it. So the message store *becomes* the
outbox.

**Built this tick:**
- **`MessageStore` contract + both backends** — `CreateMessageResult` gains `fanoutPending`; the
  interface gains `markFannedOut(id)` (idempotent marker-clear) + `listPendingFanout({limit,
  createdAtOrBefore})` (oldest-first drain). In-memory: a `#pendingFanout` set. SQLite: a
  `fanned_out_at` column (NULL = owed), written NULL **in the same `BEGIN IMMEDIATE` txn** as the
  insert (the atomic accept-and-record), a **partial index** `WHERE fanned_out_at IS NULL` so the
  sweep stays cheap as `messages` grows unbounded, and a guarded **migration** (`PRAGMA table_info`
  → `ALTER ADD COLUMN` + one-time backfill of pre-existing rows as *already*-fanned so an upgrade
  never re-delivers history). Both held to the same new **conformance** block (7 cases) so semantics
  can't drift; SQLite adds a migration test + a crash-safe outbox-replay-across-reopen test.
- **`ingest` reworked** (`src/fanout/fanout.ts`) — fans out **iff** the store reports `fanoutPending`
  (always for a fresh create; **true for a deduplicated retry of an orphaned create** → the retry now
  *recovers* the skipped fan-out instead of dropping it), then `markFannedOut`. The old "honest
  limitation: not atomic" docstring is replaced by the outbox guarantee + the residual at-least-once
  note. `IngestResult` no longer extends `CreateMessageResult` (so it doesn't leak a stale
  `fanoutPending`).
- **`FanoutDispatcher`** (`src/fanout/fanout-dispatcher.ts`) — the relay, the structural twin of the
  delivery worker: `sweepOnce()` (deterministic unit — list pending older than `graceMs`, `fanOut` +
  `markFannedOut` each) + `run()`/`stop()` (poll loop, **backs off on no-progress** so a persistently
  failing message can't hot-loop), every seam (clock/sleep) injected. Reuses the pure `fanOut` so
  routing can't drift. A `graceMs` window keeps it from racing a healthy in-flight inline ingest
  (duplicate fan-out is *safe* — at-least-once + receiver dedup — so grace is an efficiency guard, not
  a correctness one; logged). Wired into `createGateway` (runs alongside the worker; `start`/`stop`
  manage both) and `loadConfig` (`POSTHORN_FANOUT_GRACE_MS/_BATCH_SIZE/_IDLE_POLL_MS`).

**Key decisions (honest tradeoffs):**
- **Inline fan-out kept for the common path; dispatcher is the safety net.** ingest still fans out
  synchronously (low latency, the HTTP 202 can report fan-out counts); the dispatcher only recovers
  orphans. This is least-disruptive (no API contract change) and the grace period prevents the two
  racing on the happy path.
- **Residual at-least-once, not exactly-once.** fan-out enqueues into the queue (one DB) then clears
  the marker (another DB); a crash between them re-fans on recovery → a possible duplicate delivery.
  That is the queue's pre-existing at-least-once contract (receiver dedups on the stable message id).
  What changed: the floor moved from *zero*-once to *at-least*-once. Logged, not hidden.
- **Migration backfills old rows as fanned-out.** Adding a NULL column would mark all history "owed"
  → a re-delivery storm on upgrade. The one-time backfill (inside the column-add branch only, never
  on subsequent boots) prevents that.

**Validation:** `tsc --noEmit` clean (strict). vitest **385/385** (was 355; +30: store conformance
outbox ×2 backends +14, sqlite migration/replay +2, ingest +3, dispatcher +9, config +2, gateway +1
[orphan recovered end-to-end in a *running* gateway, signature verifies]). `npm run build` clean.
**Smoke-tested the compiled `dist`**: simulated a crash (accept, no fan-out) → `listPendingFanout`
sees it → `FanoutDispatcher.sweepOnce` recovers it → worker delivers → signature **verifies**, all
through production ESM incl. the `node:sqlite` `createRequire` path. Integrity + local gate: exit 0.
The three hash-protected files were not touched.

**State:** GREEN → committing to main. The core delivery path is now crash-consistent: an accepted
message is guaranteed to be fanned out (at-least-once) even across a crash, by retry **or** by the
dispatcher. The one known correctness gap is closed. Next tick: the **TS SDK** + **OpenAPI** over the
HTTP surface, or the single **Dockerfile** to finish the P4 self-host packaging story.

---

## 2026-05-22 — Iteration 11: P3/P4 — composition root + `posthorn` bin (the gateway actually boots)

**Repo truth at start:** clean main @ `5e25f91`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **338/338**, `npm run build` clean, integrity + local gate both
exit 0. Node 24 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 10: the HTTP API landed only as a **`createHttpServer(deps)` factory** — `src/index.ts`
exports it and `createApi`, but there was **no composition root and no bootable entrypoint** (no
`src/main.ts`, no `bin`, nothing that instantiates the SQLite stores, wires `ingest`+worker, and
calls `.listen()`). So last tick's "the engine becomes a runnable service" built the *handler* but
Posthorn could be *constructed in a test* and **not actually started or deployed** — the
"standalone gateway" half of PROJECT.md's wedge ("library *or* a standalone gateway") did not exist.

**High-leverage move chosen:** Build the **composition root + runnable gateway bin**. Highest-leverage
because it converts a pile of correct modules + an inert handler factory into a *thing you can run*
(`npm start` / `posthorn`) — the single biggest systemic step (checklist #3), and it realizes the
missing half of the product wedge. Explicitly chosen over the **transactional outbox** (again
deferred): you cannot meaningfully harden the crash-consistency of an ingest path on a service that
has no way to boot — making it runnable is strictly upstream of refining its crash semantics. Kept
fully deterministic + in-process testable (Axiom 2); zero new dependencies (`node:http`/`node:fs`/
`node:sqlite` only), preserving the zero-dep wedge. Followed the codebase's pure-core/thin-I/O split.

**Built this tick (`src/runtime/` + `src/main.ts`):**
- `config.ts` — `loadConfig(env)`: a **pure** env→`GatewayConfig` parser (`POSTHORN_*` vars,
  defaults imported from the worker/queue/http modules so they can't drift, integer-range validation
  with a `ConfigError` naming the offending key, frozen result). No `process.env`/socket/fs access —
  the whole config surface is unit-testable.
- `gateway.ts` — `createGateway(config)`: pure plumbing. Resolves store locations (one SQLite file
  per store under `dataDir`, `mkdir -p`; or `:memory:`), opens the four backends, wires the worker
  (`storeBackedResolver(endpoints)`) + `createHttpServer`, returns a `Gateway`: `start()` (listen via
  a promisified `listen`, capturing a bind error; then `worker.run()`, returns the bound address) and
  an **idempotent, graceful `stop()`** (worker.stop → await the run loop → `close()` + `closeAllConnections()`
  the server → close all four SQLite handles). Stores exposed so the keyless app/key bootstrap stays
  programmatic (still no HTTP route).
- `main.ts` — the `posthorn` bin (`#!/usr/bin/env node` shebang, preserved by tsc into `dist/main.js`):
  load config, boot, log the listen line, translate `SIGINT`/`SIGTERM` into one graceful `stop()`. The
  thin process shell; not unit-tested (the composition it drives is). `index.ts` re-exports the runtime
  surface; `package.json` gained `"bin": {"posthorn": ...}` + a `start` script.

**Key decisions (honest tradeoffs):**
- **Default `POSTHORN_HOST=0.0.0.0`** — correct for the headline single-container deploy (a
  loopback bind is unreachable through the container boundary); documented, override to `127.0.0.1`
  to restrict. A bind-everywhere default is a deliberate container-first choice, logged.
- **One SQLite file per store** (apps/endpoints/messages/queue), matching the existing per-store
  architecture rather than forcing a shared connection now. The transactional-outbox tick (which
  wants messages+queue in one txn) may later consolidate; flagged, not pre-optimized.
- **Transactional outbox deferred a 5th time — on principle, not avoidance.** Runnability is
  upstream of crash-window correctness; the outbox is now the clearly-named next correctness tick.

**Validation:** `tsc --noEmit` clean (strict). vitest **355/355** (was 338; +17: config 12 pure,
gateway 5 incl. a real-socket end-to-end boot→provision→ingest→deliver→**verify** + a file-backed
**durability-across-restart** test). `npm run build` clean. **Smoke-tested the compiled binary**
(`node dist/main.js` boots, logs the listen line, serves `/healthz 200` over a real socket) **and the
compiled `dist/index.js`** (full provision→ingest→deliver→verify through production ESM incl. the
`node:sqlite` `createRequire` path). Integrity + local gate: exit 0. The three hash-protected files
were not touched.

**State:** GREEN → committing to main. Posthorn is now a **runnable, deployable single-process
gateway** — `npm start` and it serves. Next tick: a single **Dockerfile** (finishing the P4
self-host story) + **TS SDK/OpenAPI**, or the **transactional outbox** to close the core crash window.

---

## 2026-05-22 — Iteration 10: P3 — HTTP API (the engine becomes a runnable service)

**Repo truth at start:** clean main @ `a954399`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **295/295**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 9: every backend layer existed and was wired (signer → store → queue → worker →
endpoints → fan-out → apps/auth), but there was **no way to actually run Posthorn as a service** —
it was a library only. PROJECT.md's wedge is explicitly "library *or* standalone gateway," yet only
the library half existed. Every prior tick ended "next: the Fastify HTTP API" and then deferred it,
citing Fastify's `npm install`/network risk in this sandbox. That deferral was the loop's local minimum.

**High-leverage move chosen:** Build the **HTTP API on Node's built-in `node:http`** instead of
Fastify. Highest-leverage because (a) it converts a pile of correct-but-inert modules into a
*deployable webhook gateway* — the single biggest systemic step available (checklist #3, "maximize
systemic value"); (b) `node:http` **kills the only stated blocker** (zero `npm install`, zero network)
and adds **zero runtime dependencies**, the same reasoning that chose `node:sqlite`/`node:crypto` —
so it *strengthens* the single-container wedge rather than compromising it with a framework; (c) it is
fully in-process testable on localhost (deterministic → Axiom 2). Deferred the transactional outbox
again — a narrower internal-robustness fix that couples two stores; the API is what makes the product
*exist*. Followed the worker's proven **pure-core + thin-I/O-adapter** split verbatim to keep risk low.

**Built this tick (`src/http/`):**
- `router.ts` — a **pure** dependency-free path router. `matchRoute(routes, method, path)` →
  `matched | methodNotAllowed(allow[]) | notFound`; path matched before method so a wrong-method hit
  on a known path yields 405 (+`Allow`), not a misleading 404. `:param` captures one URL-decoded
  segment; malformed percent-encoding = non-match. Exhaustively unit-testable without sockets.
- `api.ts` — `createApi(deps)`: the **pure** request→response handler composing `AppStore.authenticate`
  (Bearer auth), `EndpointStore` (CRUD), and `ingest` (accept + fan-out). Standard `{error:{code,message}}`
  envelope; domain errors mapped to status (`IdempotencyConflictError`→409, `UnknownEndpointError`→404,
  validator `TypeError`→400). Surface: `GET /healthz` (open); `POST /v1/messages` (202);
  `GET/POST /v1/endpoints`; `GET/PATCH/DELETE /v1/endpoints/:id`.
- `server.ts` — `createHttpServer(deps, {maxBodyBytes?})`: the thin `node:http` adapter — reads the
  body (1 MiB cap → 413, rejects early on overflow + closes the conn), normalizes headers, dispatches,
  writes JSON. `src/index.ts` re-exports the whole http surface.

**Security model (decided, not incidental):**
- **Tenancy from the key, never the body.** Every authed route scopes to `authenticate(bearer).id`;
  a body `appId` is ignored — a caller can't act as another tenant by forging a field (tested for both
  messages and endpoint-create).
- **Cross-tenant access is 404, not 403** — get/patch/delete/list of another app's endpoint is
  indistinguishable from "absent"; existence is never revealed.
- **Signing secrets are write-only over HTTP** — an endpoint's `secret` is returned exactly once in
  the 201 create body (you need it to configure verification) and never echoed by list/get/update.
- **App/key provisioning is intentionally not an HTTP route** — a privileged bootstrap with no key to
  authenticate it; exposing it unauthenticated is an open door. It stays on the programmatic `AppStore`
  (an admin/control-plane route is a later tick). This API is the *tenant-facing* surface only. Logged.

**Key decisions (honest tradeoffs):**
- **`payload` is any JSON value; the delivered/signed body is its `JSON.stringify`.** Conventional
  webhook-API contract (Svix-like); byte-exact control is traded for ergonomics. Logged.
- **`TypeError` → 400 is a deliberate convention** (every `normalize*`/`apply*Update` validator throws
  it on bad input). A genuine internal bug throwing `TypeError` would also surface as 400; the
  validators are the only realistic source on these routes. Commented in code.
- **One self-inflicted test bug found + fixed:** the end-to-end test pinned the worker clock to 2023,
  but `verify` checks the signed `webhook-timestamp` against the *real* wall clock + a replay window →
  "too old". The signature was correct; fixed by signing with the real clock (the test asserts the
  round-trip, not time logic).

**Validation:** `tsc --noEmit` clean (strict). vitest **338/338** (was 295; +43: router 11, api 27,
server 5). `npm run build` clean. **Smoke-tested the built `dist` over a real socket** (unauth→401,
health, endpoint create returns secret once, list never leaks it, ingest→202 fans out 1, worker drains,
the signed delivery **verifies** against the endpoint secret). Integrity + local gate: exit 0. The three
hash-protected files were not touched.

**State:** GREEN → committing to main. Posthorn is now a runnable, zero-dependency webhook *service*,
not just a library — curl an event in, it authenticates, fans out, and the worker delivers a verifiable
signed webhook. Next tick: the **TS SDK** + **OpenAPI** over this surface, or the **transactional
outbox** to close the one known correctness gap (crash between ingest's create and fan-out).

---

## 2026-05-22 — Iteration 9: P3 — App/tenant entity + API-key authentication (identity layer)

**Repo truth at start:** clean main @ `56a6f4a`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **239/239**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 8: every layer was built and connected (signer → store → queue → worker → endpoints →
fan-out → ingest), but `appId` was an **opaque, unauthenticated string** — any caller could assert
any tenant, and no entity minted or validated it. That identity gap blocks the HTTP API: without
auth, the API would be wide open and `appId` forgeable.

**High-leverage move chosen:** Build the **App/tenant entity + API-key auth** (`src/apps/`). Highest-
leverage because (a) it is the load-bearing tenancy+auth foundation the deferred Fastify HTTP API must
sit on (`authenticate(key)` → `appId` → scope existing ops); (b) it is security-critical yet fully
deterministic — golden-vector-testable like the P0 signer — the regime this loop is strongest in; (c)
**zero new dependencies** (only `node:crypto` + `node:sqlite`), preserving the zero-dep wedge, whereas
Fastify still carries the sandbox install/network risk the loop has repeatedly and correctly deferred.
Followed the proven `interface + in-memory reference + SQLite + one shared conformance suite` pattern
verbatim to keep risk low.

**Built this tick (`src/apps/`):**
- `app.ts` — `App`/`NewApp`/`AppUpdate`, `ApiKey` (metadata; no secret) + `CreatedApiKey` (one-time
  plaintext), the `AppStore` contract (app CRUD + `createApiKey`/`listApiKeys`/`revokeApiKey`/
  `authenticate`), `UnknownAppError`, and the shared **pure** crypto/validation helpers so backends
  can't drift: `createAppId`/`createApiKeyId`/`generateApiKeySecret`, `hashApiKey` (sha256 hex —
  storage *and* lookup index), `apiKeyPrefix` (12-char non-secret display prefix), `apiKeyHashesEqual`
  (constant-time), `normalizeNewApp`/`applyAppUpdate`.
- `in-memory-app-store.ts` — insertion-ordered reference; a `keyHash → keyId` index makes
  `authenticate` O(1), mirroring the SQLite hash index; cascade-drops a deleted app's keys.
- `sqlite-app-store.ts` — durable backend on built-in `node:sqlite` (same `createRequire` workaround),
  two `STRICT` tables (`apps`, `api_keys`), `api_keys.app_id REFERENCES apps(id) ON DELETE CASCADE`
  with `PRAGMA foreign_keys = ON`, UNIQUE indexed `key_hash`, `revoke` guarded by `revoked_at IS NULL`.
- `conformance.ts` + `app.test.ts` (pure helpers incl. **golden SHA-256 vectors**) + per-backend tests;
  SQLite adds crash-safe replay (app + live key + revocation survive reopen), cascade-survives-reopen,
  UNIQUE-hash-collision, and file isolation. `src/index.ts` re-exports the apps surface.

**Security model (decided, not hand-waved):** key secret = 256 bits CSPRNG, so store only its SHA-256
(fast hash is correct for high-entropy input — bcrypt/argon2 defend low-entropy passwords); plaintext
returned exactly once; constant-time compare as defense-in-depth atop the indexed exact-hash match;
revoked keys denied; `authenticate` is a pure read (no hot-path write-amplification). The golden vector
pins the hash format so a future change can't silently invalidate every stored key.

**Key decisions (honest tradeoffs):**
- **Per-key `lastUsedAt` deferred.** Bumping it on every auth would put a write on the hot read path;
  it's an observability add-on (like the deferred per-attempt audit log), logged not hidden.
- **App deletion cascades keys but not endpoints/messages.** Those are independent stores; cross-store
  reaping is a service-level concern, not a store coupling. Logged.
- **One test-fixture bug found + fixed mid-tick:** the conformance leak-check asserted the listed
  metadata omits the secret, but the *injected* test secret (`phk_test_1`) is shorter than the 12-char
  display prefix, so the prefix legitimately equals it. Moved the no-leak assertion to a test using the
  realistic (long) default generator, where the property actually holds.

**Validation:** `tsc --noEmit` clean (strict). vitest **295/295** (was 239; +56: apps pure helpers 14,
in-mem 20, sqlite 22). `npm run build` clean. **Smoke-tested the built `dist/index.js`** end-to-end on
the SQLite backend (mint → authenticate → isolated revoke-denies → wrong/empty denied → cross-tenant
isolation → cascade-delete-denies → metadata carries no full secret). Integrity + local gate: exit 0.

**State:** GREEN → committing to main. `appId` is now an authenticated identity. Next tick: the
**Fastify HTTP API** (composing `AppStore.authenticate`) — or the **transactional outbox** to make
ingest atomic if the Fastify install risk warrants staying dependency-free one more tick.

---

## 2026-05-22 — Iteration 8: P3 — message fan-out (the parts become a service)

**Repo truth at start:** clean main @ `b9c4cfa`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **222/222**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 7: signer, FSM/retry, message store, queue, worker, endpoint store, and resolver
were all built — but **nothing connected "a message was created" to "enqueue a delivery for each
subscribed endpoint."** You had to hand-enqueue one `DeliveryTask` per endpoint. That join — fan-out
— is the functional heart of a webhook service and the exact thing a future `POST /messages` sits on.

**High-leverage move chosen:** Build **message fan-out**. Highest-leverage because (a) it converts a
pile of correct-but-disconnected machinery into an actual service (ingest an event → it reliably
reaches every relevant destination); (b) it needs **zero new dependencies** (unlike Fastify, which
carries an install/network risk in this sandbox), is fully deterministic + in-process validatable
(Axiom 2); (c) it is the prerequisite the HTTP ingest path will sit on. Deferred the App/tenant
entity and the Fastify layer to keep this one cohesive green unit.

**Prerequisite, done right (`src/storage/`):** fan-out needs a message to know its tenant, so added
**`appId` to `Message`/`NewMessage`** (required, mirroring the endpoint store). Because the message
now carries a tenant, **idempotency had to become per-tenant** — otherwise tenant B's key would
dedup against, and *return*, tenant A's message (a real cross-tenant data leak that adding `appId`
would have introduced). So `getByIdempotencyKey(appId, key)`, a nested in-memory index, and a
composite `(app_id, key)` SQLite PK. The shared conformance suite gained cross-tenant isolation
tests proving both backends namespace keys per app. Fingerprint stays `(eventType, payload)` — within
a fixed `(appId, key)` scope the appId is invariant, so it adds nothing.

**Built this tick (`src/fanout/`):**
- `selectFanoutTargets(endpoints, eventType)` — **pure** routing: partitions into `matched`
  (enabled + `endpointSubscribesTo`), `skippedDisabled`, `skippedUnsubscribed`; order-preserving;
  disabled wins over subscribed. Skip-reason buckets give operators "why didn't my endpoint fire?".
- `fanOut(message, {endpoints, queue}, {availableAt?})` — lists the message's `appId` endpoints,
  selects, and enqueues one `DeliveryTask` per match (carrying the opaque `endpointId`), sequentially
  in endpoint order (deterministic; matches the worker's sequential model). Returns the tasks + counts.
- `ingest(input, {messages, endpoints, queue})` — the headline op: create the message, then fan out
  **only when the create was new**; a deduplicated retry is *not* re-fanned (would double-deliver).
- `src/index.ts` re-exports the fan-out surface.

**Key decisions (honest tradeoffs):**
- **Per-tenant idempotency was bundled in, not deferred.** Adding `appId` without scoping the key
  index would knowingly ship a cross-tenant leak; correctness outranks a smaller diff. The cost was
  mechanical test churn (every message-`create` call gained `appId`).
- **`ingest` is not atomic.** A crash after store-create but before fan-out completes leaves a
  message whose retry dedups and skips fan-out → some deliveries never enqueue. Right fix is a
  transactional outbox (enqueue inside the create txn); deferred and logged, not hidden. Best-effort
  -after-accept is the correct common-path default and never double-*creates*.
- **Fan-out is at-least-once** (like the queue it feeds): a second `fanOut` of the same message
  enqueues a second task set → possible duplicate delivery, which is why every message carries a
  stable id for receiver-side dedup (Standard Webhooks).

**Validation:** `tsc --noEmit` clean (strict). vitest **239/239** (was 222; +17: fan-out 13 [pure 6,
fanOut 4, ingest 3 incl. an end-to-end ingest→deliver→verify] + cross-tenant idempotency conformance
4 [in-mem 2, sqlite 2]). `npm run build` clean. **Smoke-tested the built `dist/index.js`** end-to-end
on SQLite backends (ingest fans out to 2/4 endpoints, skips 1 unsubscribed + 1 disabled; cross-tenant
key stays distinct/no-leak; retry dedups + no re-fan-out; worker drains both; signature **verifies**).
Integrity + local gate: exit 0.

**State:** GREEN → committing to main. Posthorn now ingests an event and reliably fans it out to a
tenant's subscribers, end-to-end. Next tick: the **App/tenant** entity (mint/validate `appId`), then
the **Fastify HTTP API**, or the **transactional outbox** to make ingest atomic.

---

## 2026-05-22 — Iteration 7: P3 begins — the endpoint store + store-backed resolver

**Repo truth at start:** clean main @ `6b58953`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **168/168**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: the Posthorn decision stands. The
glaring gap after P2.5: the worker could sign+POST, but its `EndpointResolver` seam had **no
implementation** — there was no persisted endpoint at all, and a `DeliveryTask` carried only an
opaque `messageId` with no way to say *which* endpoint it targets. So the worker still required a
hand-written resolver; nothing could store a subscription. That entity is the foundation the whole
of P3 (HTTP API, fan-out, SDK) sits on.

**High-leverage move chosen:** Build the **endpoint store** and connect it to the worker. Highest-
leverage because (a) it is the load-bearing entity every later P3 step depends on; (b) it fills the
worker's deliberately-left resolver seam, ending the "four/five disconnected islands" pattern; (c)
it needs **zero new dependencies** (no `npm install`/network risk in this sandbox) and is fully
in-process validatable, directly serving Axiom 2. Followed the proven `MessageStore`/`DeliveryQueue`
architecture verbatim (interface + in-memory reference + SQLite + one shared conformance suite) to
keep risk low. Deliberately deferred fan-out + the App/tenant entity + the Fastify HTTP layer to
keep this one cohesive green unit (Fastify also carries an install-network risk; the pure data layer
is both the foundation and the safe part).

**Built this tick (`src/endpoints/`):**
- `endpoint.ts` — `Endpoint` (tenant-scoped `appId`; `url` + `secret` + `eventTypes` filter [`null`
  = all] + `disabled`), the `EndpointStore` CRUD contract, `UnknownEndpointError`, and shared **pure**
  helpers so backends can't drift: `normalizeNewEndpoint` (http(s)-only URL validation, deduped
  filter, secret signalled as `null` → backend mints one via an injectable generator),
  `applyEndpointUpdate` (validated patch; `id`/`appId`/`createdAt` immutable, `updatedAt` bumped),
  `endpointSubscribesTo` (for fan-out next tick), `createEndpointId`.
- `in-memory-endpoint-store.ts` — insertion-ordered reference backend; `listByApp` oldest-first.
- `sqlite-endpoint-store.ts` — durable backend on built-in `node:sqlite` (same `createRequire`
  workaround), `STRICT` schema, `event_types` as JSON (or NULL), `disabled` as 0/1, `update` as a
  read-modify-write in a `BEGIN IMMEDIATE` txn, `delete` via row-changes count.
- `conformance.ts` + `endpoint.test.ts` (pure helpers) + per-backend tests; SQLite adds crash-safe
  replay (filter + flags survive reopen) + file isolation.
- **Wired to the worker:** `DeliveryTask`/`EnqueueInput` now carry an opaque, nullable `endpointId`
  (the "message×endpoint richer unit" the queue's own docstring anticipated) — threaded through both
  queue backends + the queue conformance suite (round-trip + reject-empty). `endpoint-resolver.ts`'s
  `storeBackedResolver(store)` fills the worker's `EndpointResolver` seam: resolves `endpointId` →
  target, declining (null → failed attempt → policy retries/dead-letters) for absent/deleted/disabled
  endpoints. `src/index.ts` re-exports the endpoint surface.

**Key decisions (honest tradeoffs):**
- `endpointId` is a **passenger** field — the queue carries it, never interprets it — so transitions
  preserve it for free via the existing `...task` spread and the SQLite `#persist` UPDATE leaves it
  untouched (immutable post-enqueue).
- A **disabled** endpoint resolves to `null`, i.e. a *failed attempt* that eventually dead-letters,
  rather than an out-of-band cancel (the worker has none in v1). Fan-out won't enqueue work for
  disabled endpoints; this only bites an endpoint disabled *after* enqueue. Logged, not hidden.
- `appId` is required now (multi-tenant from day one, `listByApp` never leaks) but treated as an
  opaque scope string — the App entity that mints/validates it is a later tick.

**Validation:** `tsc --noEmit` clean (strict). vitest **222/222** (was 168; +54: endpoints 50 [pure
9, in-mem 17, sqlite 18, resolver 6], queue +4, plus the worker-test literal gained `endpointId`).
`npm run build` clean. **Smoke-tested the built `dist/index.js`** (`SqliteEndpointStore` create →
filter round-trip → enqueue with `endpointId` → `storeBackedResolver` → worker delivers → signature
**verifies**) to prove the full path works in production ESM. Integrity + local gate: exit 0.

**State:** GREEN → committing to main. P3 underway; the endpoint is persisted and the worker delivers
to a stored endpoint end-to-end. Next tick: message **fan-out** (needs `appId` on the message) +
the **App/tenant** entity, then the Fastify HTTP API.

---

## 2026-05-22 — Iteration 6: P2.5 — the delivery worker (runtime I/O driver), end-to-end send real

**Repo truth at start:** clean main @ `7c1926b`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **145/145**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after P2: signer, retry/FSM, store, and the durable queue were **four fully-built but
disconnected islands** — nothing performed actual I/O, so Posthorn could not yet *send a single
webhook*. The roadmap's named next item (P2.5) closes exactly that.

**High-leverage move chosen:** Build the **`DeliveryWorker`** — the runtime loop that joins all four
islands into a real send: claim due tasks → load message → sign → POST → settle. Highest-leverage
because it converts a pile of correct-but-inert machinery into a working product (the first
end-to-end delivery), and it does so without adding any decision logic (retry/state stays in P1/P2),
keeping the unit small and fully green.

**Built this tick (`src/worker/delivery-worker.ts`):**
- Pure helpers: `isSuccessStatus` (2xx) and `buildSignedRequest` (Standard Webhooks headers; signs
  over `{id}.{ts}.{payload}` with the *send* time, not message createdAt; caller headers merged but
  cannot clobber the `webhook-*` headers).
- `DeliveryWorker`: `processOnce()` (deterministic single tick at one clock instant — claim a batch,
  deliver each sequentially, return a `TickResult` tally) and `run()`/`stop()` (continuous poll:
  drains back-to-back, sleeps `idlePollMs` when idle, survives unexpected tick errors via `onError`).
- Injected seams (the whole point — fully fake-clock/transport-testable): `queue`, `store`, `now`,
  `transport` (default `fetchTransport` over global `fetch`, with per-attempt `AbortSignal` timeout),
  injectable `sleep`, and an **`EndpointResolver`** — the deliberate plug-point for P3's
  endpoint/secret store (the queue task carries only an opaque `messageId`).
- Settle hygiene: a lapsed-and-reclaimed lease raises `StaleLeaseError` on `complete`/`fail`, which
  the worker absorbs (counted `stale`) per the queue's at-least-once contract — never double-settles.
  Missing message / unresolved endpoint / transport throw / non-2xx all become a *failed attempt*
  (the queue's policy then retries or dead-letters); deliberately no out-of-band cancel in v1.
- `src/index.ts` re-exports the worker surface.

**Key decision — sequential batch processing in v1.** Honest tradeoff: simple + deterministic, but
`batchSize × requestTimeoutMs` must stay below the queue's visibility timeout or leases lapse
mid-batch. Correctness holds regardless (stale settles are absorbed); bounded concurrency is the
next throughput optimization. Documented in code + PROJECT.md.

**Validation:** `tsc --noEmit` clean (strict). vitest **168/168** (was 145; +23 worker: pure-helper +
construction guards + happy-path + retry/dead-letter/missing-msg/no-endpoint/transport-error/stale-
reclaim/timeout-abort + `run` drain/resilience/concurrent-guard). The headline test and a
compiled-**`dist`** smoke run both prove a worker-emitted request **verifies against the existing
verifier** — the full sign→deliver→verify loop closed in-process and in production ESM.
`npm run build` clean. Integrity + local gate: exit 0.

**State:** GREEN → committing to main. P2.5 complete; Posthorn now performs a real end-to-end
delivery. Next tick: P3 — Fastify HTTP API (apps/endpoints/messages) + an endpoint store backing a
real `EndpointResolver` + TS SDK.

---

## 2026-05-22 — Iteration 5: P2 finished — durable delivery queue (lease + crash-safe replay)

**Repo truth at start:** clean main @ `542b0b0`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **100/100**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: the Posthorn decision (Iter 1) stands.
The glaring gap: the retry policy + delivery FSM (P1) were **pure islands disconnected from
storage** — nothing scheduled or persisted delivery work, so the product's headline "durable,
no-Redis, crash-safe delivery" wedge was unrealized.

**High-leverage move chosen:** Build the **durable, store-backed `DeliveryQueue`** — the spine that
joins retry-policy + delivery-FSM + persistence into actual reliable delivery. Highest-leverage
because (a) it *is* the differentiating "no Redis, single process, crash-safe" feature; (b) it
connects three previously-disconnected cores; (c) without it P3's HTTP API would have nothing
behind it. Followed the proven `MessageStore` architecture verbatim (interface + in-memory
reference + SQLite + one shared conformance suite) to keep risk low and validation fully in-process.

**Built this tick (`src/queue/`):**
- `delivery-queue.ts` — `DeliveryTask` + `DeliveryQueue` contract (`enqueue`/`claimDue`/`complete`/
  `fail`/`get`), `UnknownDeliveryTaskError` + `StaleLeaseError`, and **shared pure transition
  helpers** (`applyClaim`/`applySuccess`/`applyFailure` + `claimableState`) that defer to the P1
  delivery-state reducer — so the two backends cannot drift. Lease model: each claim mints a fresh
  lease token + visibility timeout; only the token holder may resolve the task.
- `in-memory-queue.ts` — `InMemoryDeliveryQueue`: insertion-ordered map of immutable task
  snapshots; the reference semantics.
- `sqlite-queue.ts` — `SqliteDeliveryQueue` on built-in `node:sqlite` (loaded via `createRequire`,
  same Vite-5 workaround as the store), `STRICT` schema, `claimDue` in a `BEGIN IMMEDIATE` txn
  ordered by `rowid` (atomic across connections; two workers never claim the same task).
- `conformance.ts` — `describeDeliveryQueueContract` + deterministic clock/id/lease-token
  generators; the single behavioural spec both backends run.
- Tests: in-memory + sqlite each run the conformance suite; SQLite adds **crash-safe replay**
  (enqueue→claim→close→reopen→lapsed lease reclaimed under a fresh token, old token rejected),
  terminal-survives-reopen, and file-isolation tests. `src/index.ts` re-exports the queue surfaces.

**Key design decision — at-least-once via lease + visibility timeout.** A lapsed lease (crashed/
stalled worker) makes a `delivering` task claimable again, reclaimed *as pending* so a fresh
attempt starts (the dead attempt still counts). This can double-deliver a stalled worker's task —
which is exactly why every message carries a stable id for receiver-side dedup (Standard Webhooks).
Logged honestly as the deliberate tradeoff. The full per-attempt audit log is deferred (an
observability add-on, distinct from the load-bearing delivery *state* the queue now persists).

**Validation:** `tsc --noEmit` clean (strict). vitest **145/145** (was 100; +45: in-memory queue 21,
sqlite queue 24). `npm run build` clean. **Smoke-tested the built `dist/index.js`** (Sqlite
enqueue→claim→lease-lapse→replay→complete) to prove the `createRequire` path works in production
ESM, not just under Vitest. Integrity + local gate: exit 0. (One tsc fix mid-build: `.all()` returns
`Record<string,…>[]`, so its cast to `TaskRow[]` had to route through `unknown` — `.get()`'s direct
cast does not need this.)

**State:** GREEN → committing to main. P2 complete. Next tick: P2.5 — the delivery *worker* loop
(claim → load message → sign → POST → complete/fail), the injectable, fake-clock-testable I/O driver
that finally makes an end-to-end send real.

---

## 2026-05-22 — Iteration 4: P2 begins — durable, crash-safe SQLite MessageStore + shared conformance

**Repo truth at start:** clean main @ `6984197`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **81/81**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9 / Vite 5.4.21. Roadmap's next item: P2 — a durable
`MessageStore` implementing the P1 interface.

**High-leverage move chosen:** Build the **durable storage backend** + a **shared conformance
suite** that every `MessageStore` must pass. Highest-leverage because it (a) delivers the
product's core "single process, no Redis, durable" wedge, (b) validates the P1 storage seam by
giving it a *second* implementation, and (c) the conformance suite makes the future Postgres
backend trivially verifiable — "matches the reference" becomes a proven fact, not a hope.
Scoped to the store only; the durable queue + delivery-attempt records are deferred to keep
this a small, fully-validatable green unit (mirrors how P1 was split).

**Engine decision revised — `better-sqlite3` → built-in `node:sqlite`.** Probed the sandbox:
Node 24's `node:sqlite` works with zero deps and no native compile step. This *strengthens* the
"zero-dependency single container" wedge vs. the native `better-sqlite3` originally planned.
PROJECT.md §3 updated.

**Built this tick:**
- `src/storage/message-store.ts` — extracted three shared, pure helpers so backends can't
  drift: `normalizeNewMessage` (intake validation), `isIdempotencyExpired` (the one expiry
  rule, Infinity-safe), `assertValidIdempotencyWindow`, plus shared `DEFAULT_IDEMPOTENCY_WINDOW_MS`.
- `src/storage/in-memory-store.ts` — refactored onto those helpers; behaviour unchanged.
- `src/storage/sqlite-store.ts` — `SqliteMessageStore`: WAL + `synchronous=NORMAL` + FK,
  `STRICT` tables, two-table schema mirroring the in-memory design (`messages` never pruned;
  `idempotency_keys` ages out). `create` runs in a `BEGIN IMMEDIATE` txn so check-then-insert
  is atomic across connections. Adds `close()` and a `size` getter.
- `src/storage/conformance.ts` — `describeMessageStoreContract(label, factory)` + a
  deterministic clock; the single behavioural spec both backends run.
- Test files rewritten to call the conformance suite; SQLite adds a **crash-safe replay** test
  (write to a temp file, close, reopen → message + idempotency binding survive, retry dedups)
  and a file-isolation test. `src/index.ts` re-exports `SqliteMessageStore`.

**Snag + fix (logged honestly):** Vite 5's bundled builtins list predates `node:sqlite`, so a
static `import … from "node:sqlite"` made vite-node strip the prefix and fail to resolve
`sqlite`. `server.deps.external` and a `pre` `resolveId` plugin both failed to stop it. Resolved
by loading the builtin via `createRequire(import.meta.url)("node:sqlite")` — no static specifier
for the bundler to mangle; works identically in the compiled `dist` ESM (smoke-tested). `vitest.config.ts`
left at its clean original.

**Validation:** `tsc --noEmit` clean (strict). vitest **100/100** (was 81; +19: SQLite suite 18
incl. 14 shared-conformance + reopen/isolation, in-memory +1 size test). `npm run build` clean.
Smoke-tested the built `dist/index.js` (Sqlite create→dedup→size→close) to prove the
`createRequire` path works in production, not just under Vitest. Integrity + local gate: exit 0.

**State:** GREEN → committing to main. Next tick: continue P2 — delivery-attempt persistence
(extend the schema/interface) and a durable, store-backed queue with crash-safe replay of
in-flight deliveries.

---

## 2026-05-22 — Iteration 3: P1 finished — idempotent message store + storage seam

**Repo truth at start:** clean main @ `d2f06f8`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **60/60**, `npm run build` clean, integrity gate + local gate
both exit 0. Node 24 / vitest 2.1.9. Strict tsconfig confirmed (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Roadmap's open P1 items: idempotency/dedup
keys + in-memory store behind a storage interface.

**High-leverage move chosen:** Build the **persistence seam** — the `MessageStore` interface +
its in-memory reference implementation + idempotent intake. Highest-leverage because it is the
load-bearing contract every later phase depends on: P2 (SQLite/Postgres) just implements the
same interface, and P3's HTTP handlers await it. Kept to message *intake* (not delivery-attempt
records, deferred to P2) to stay one small, fully-validatable green unit.

**Built this tick (`src/storage/`):**
- `message-store.ts` — `Message`/`NewMessage`/`CreateMessageResult` types, the async
  `MessageStore` interface (async so one contract spans sync better-sqlite3 *and* async
  Postgres), `IdempotencyConflictError`, a pure **length-prefixed** `messageFingerprint`
  (so `("ab","c")` ≠ `("a","bc")`), and the default `createMessageId` (144-bit base64url).
- `in-memory-store.ts` — `InMemoryMessageStore`: idempotent `create` (dedup on key → returns
  original w/ `deduplicated:true`; **conflict** on same-key/different-fingerprint → throws;
  **TTL** binding expiry, default 24h, `Infinity` = never), `get`, `getByIdempotencyKey`.
  Clock + id generator injected for determinism (matches signer/delivery convention). The
  message map is never pruned on expiry — only the key→id index ages out (Axiom 3 in spirit).
  Both surfaces re-exported from `src/index.ts`.

**Validation:** `tsc --noEmit` clean (strict). vitest **81/81** (was 60; +21: 6 fingerprint/
id/error, 15 store incl. conflict + TTL-boundary + Infinity-window + construction guard).
`npm run build` clean. Integrity gate + local gate: exit 0. git status: only `src/index.ts`,
new `src/storage/`, README, PROJECT.md (dist/ gitignored).

**State:** GREEN → committing to main. P1 complete. Next tick: P2 — a SQLite `MessageStore`
implementing this interface, then delivery-attempt persistence + a durable store-backed queue.

---

## 2026-05-22 — Iteration 2: P1 delivery decision core (retry + state machine)

**Repo truth at start:** clean main @ `671bfff`. P0 (signer/verifier) green, 23 tests.
Baseline re-verified before touching anything: `tsc --noEmit` clean, vitest 23/23,
integrity gate + local gate both exit 0. Node 24.15. `docs/GOAL.md` already resolved by
`docs/PROJECT.md` (Posthorn). Roadmap's next item: P1 delivery core.

**High-leverage move chosen:** Build the **delivery decision core** — the cohesive,
fully-deterministic heart of "reliable" delivery. Scoped to retry/backoff + state machine +
dead-letter (one logical unit: "what happens when an attempt resolves"). Deliberately
deferred idempotency/dedup + storage interface to the next tick to keep this commit a small,
fully-validatable green unit rather than a P1 blob.

**Built this tick (`src/delivery/`):**
- `retry-policy.ts` — immutable `RetryPolicy` (ordered inter-attempt delays). Builders:
  `fixedSchedule`, `exponentialBackoff` (base/factor/cap, validated). `DEFAULT_RETRY_POLICY`
  = Svix-like 7-retry / 8-attempt schedule (5s→…→10h, ~28h). `planNextAttempt` is the pure
  decision fn; jitter is opt-in with an **injectable RNG** so scheduling stays reproducible.
- `delivery-state.ts` — pure FSM `pending → delivering → succeeded`, failures routed through
  the policy back to `pending` (with `nextAttemptAt`) or to terminal `dead_letter` on
  exhaustion. Illegal transitions throw `DeliveryStateError` (no silent no-ops). Helpers
  `isTerminal` / `isDeliverable` for worker scheduling. Both surfaces re-exported from
  `src/index.ts`.

**Validation:** `tsc --noEmit` clean (strict, `exactOptionalPropertyTypes` +
`noUncheckedIndexedAccess`). vitest **60/60** (was 23; +37: 23 retry, 14 state). `npm run
build` clean. Integrity gate + local gate: exit 0. git status: only README, PROJECT.md,
index.ts, and new `src/delivery/` (dist/ correctly gitignored).

**State:** GREEN → committing to main. Next tick: finish P1 — idempotency/dedup keys + the
in-memory store behind a storage interface (sets up P2 SQLite).

---

## 2026-05-22 — Iteration 1: Project decided + foundation seeded

**Repo truth at start:** 1 commit (infra seed). `docs/GOAL.md` still open ("find a software
project to build"). `LOOP_LOG.md` empty. Dangling uncommitted improvement to
`run-autonomous-loop.ps1` (adds real engine-invocation param). Frozen gate
(`local-gate.ps1`) only checks git-cleanliness + conflict markers; manifest protects
AXIOMS + both gate scripts (cannot/should-not modify).

**High-leverage move chosen:** Resolve the GOAL's open decision — it blocks every future
build tick. Did the GOAL-mandated GitHub check + market research, then locked a decision
and seeded a validated foundation.

**GitHub check (`github.com/michaelcrosato`):** existing repos `salesforce-lite-crm` (TS),
`AC1` (Python), `agy-sandbox` (JS). CRM space is taken → avoided.

**Decision:** Build **Posthorn** (working name) — open-core, Standard Webhooks-compliant
**reliable webhook delivery infrastructure**. Rationale, market/competition/pricing analysis,
and roadmap in `docs/PROJECT.md`. Picked because it is the best intersection of the GOAL's
two filters: near-fully-deterministic logic (max autonomous buildability + test-verifiable →
keeps main green) AND high-profit open-core with expensive, ops-heavy incumbents (Svix
$490/mo + PG/Redis). Wedge: single container, **no Redis**, SQLite default, MIT, library mode.

**Stack:** TypeScript/Node — confirmed by probing sandbox (Node 24/npm/pnpm/Docker present,
**no Go**); also matches the human's TS ecosystem.

**Built this tick (P0):** TS scaffold (package.json, tsconfig strict, vitest, MIT LICENSE,
README, .gitignore) + first core module: spec-compliant HMAC signer/verifier
(`src/signing/webhook-signature.ts`) with `sign`/`verify`/`generateSecret`, replay window,
key-rotation multi-signature support.

**Validation:** `tsc --noEmit` clean (strict). `vitest` 23/23 pass, **including the canonical
Standard Webhooks reference vector** (proves byte-for-byte spec compliance). local-gate +
integrity gate: pass. Note: 5 moderate npm-audit advisories in dev deps (vitest/esbuild
chain) — tracked, not blocking; revisit in a tooling tick.

**State:** GREEN → committed to main. Next tick: P1 delivery core (retry/backoff schedule,
delivery state machine, idempotency, dead-letter) — all pure/deterministic.
