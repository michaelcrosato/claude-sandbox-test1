# plan/BASELINE — Posthorn repo baseline (Phase 1, verified 2026-05-29)

Self-contained baseline established by direct exploration this session (`git log`, `package.json`,
`docs/`, `src` map, two live gate runs). Evidence is cited inline; nothing here depends on a prior plan.

## Purpose & value prop

Posthorn is open-core (**MIT**) **outbound webhook-delivery infrastructure**: a SaaS platform uses it
to send signed, retried, observable webhooks to *its* customers. The wedge is **operational
simplicity** — a single Node process backed by `node:sqlite` (no Redis, no required Postgres), with a
durable leased delivery queue built in, also embeddable as a Node library. Optional Postgres backend
for active/active HA. Buyer: an indie/SMB engineering team that wants reliable webhooks without
standing up a broker. It is **not** a general event bus, inbound router, or multi-protocol sink.

## Architecture (text diagram)

```
producer ─POST /v1/messages─▶ [idempotency dedup] ─▶ Message store
                                          │ Fanout: match endpoints by eventType/channel filter
                                          ▼ per-endpoint Delivery enqueued as a leased queue task
   ┌─ Delivery Worker ─────────────────────────────────────────────────────────────┐
   │ claim lease → sign (HMAC-SHA256, Standard Webhooks) → SSRF-guarded POST          │
   │ (DNS-pin + connect-time guard + socket timeout; 3xx NOT followed) → record       │
   │ Attempt → fold endpoint health → success | retry (jittered backoff ~8/28h) |     │
   │ dead-letter (terminal) ; circuit-break failing endpoints                         │
   └──────────────────────────────────────────────────────────────────────────────────┘
                                          ▼
   Prometheus /metrics (bounded labels) + JSONL logs ; data-pruner retention sweep
```

**Entities:** `App`(tenant)→`ApiKey`; `App`→`Endpoint`(filter); `App`→`Message`→`Delivery`→`Attempt`;
`EventType` catalog (`schemaExample`); `Plan`(free/pro/scale entitlements); internal `system-events`.
**Stores:** three backends (in-memory / SQLite / Postgres) behind one async contract + a shared
cross-backend `conformance.ts` per area (`storage`, `queue`, `endpoints`, `apps`, `attempts`,
`event-types`).

**Layers / key modules (`src/`):** `signing/` (Standard Webhooks HMAC + rotation), `net/` (SSRF
defense: `ssrf-guard`, `guarded-lookup` DNS-pin, `guarded-transport`), `http/` (`server`, `router`,
`api`, `openapi` drift-tested, `error-codes` closed enum), `worker/` + `fanout/` (delivery), `billing/`
(flag-gated Noop/Stripe over injected transport), `dashboard/` + `portal/` (server-rendered UIs),
`metrics/` · `logging/` · `pruner/` · `db/`, `sdk/` (TS client + `verifyWebhook`), `runtime/`
(`gateway`, `config` authoritative `POSTHORN_*` parse, `admin`/`client-cli`, `backup`). Entry points:
`src/main.ts` (CLI + bootstrap), `src/index.ts` (library exports). Python SDK in `clients/python/`.

## Tech stack & versions

- **Language/runtime:** TypeScript **5.7** / ESM, Node **≥22.13** (the real `node:sqlite` floor),
  strict `tsc` (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- **Tests:** Vitest **2.1**, ~2068 colocated `*.test.ts`; compiled-`dist` smokes (`scripts/smoke-*.mjs`).
- **Deps:** **zero runtime dependencies**; `pg` optional; devDeps = typescript, vitest, @types/node,
  @types/pg. `npm audit --omit=dev` = 0 vulns.
- **Package:** `posthorn@1.0.0`, MIT, `bin: posthorn`, `exports` with `types` before `import`.
- **Deploy/CI:** `Dockerfile` (+ OCI labels), `docker-compose.yml`, `deploy/helm/posthorn/`,
  `.github/workflows/ci.yml` — 5 jobs: type/test/build (Node matrix 22.13 + 24) · docker image · helm
  lint/template · `npm pack` readiness · dependency audit.

## Current state (strengths / weaknesses / debt)

- **Verified green this session:** `npm run agent:check` **exit 0**. Run 1: 2049/2068 + one tinypool
  `Worker exited unexpectedly` (0 failed assertions = the documented teardown flake). Run 2 (re-run
  per protocol): **2068/2068, 61 files, 6 PG-skipped, 0 errors, 21.4s** → genuinely green.
- **Strengths:** mature, well-factored (per-subsystem dirs, three conformant store backends); sound
  SSRF posture (connect-time DNS-pin, 3xx not followed — matches OWASP); honest code-verified
  competitor matrix (`docs/PARITY.md`); strong CI; zero `TODO`/`FIXME` in `src`; near-zero attack
  surface from deps.
- **Weaknesses/debt:** effectively none in the autonomous lane — the 11-item commercial backlog and
  the 13-item hardening backlog are both shipped (PROGRESS.md). The default datastore (`node:sqlite`)
  is **pre-stable** (RC) upstream — mitigated by a pinned Node floor + documented status + the
  Postgres alternative.

## Open questions (human strategy — see specs/SPEC-H5)

Public name? · first commercial path (hosted / paid self-host / enterprise)? · metering unit
(messages / attempts / endpoints / blended)? · first deploy target to polish? · minimum public-launch
bar? These are recorded in `docs/GOAL.md` and gate the launch specs; they must not be answered in code.
