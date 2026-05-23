# PROJECT DECISION RECORD

> Status: **DECIDED** (2026-05-22). Supersedes the open question in `docs/GOAL.md`.
> Working name: **Posthorn** (provisional — the human may rename; code paths are kept
> brand-neutral so a rename touches only `package.json`, `README.md`, and this file).

## 1. The decision

Build **Posthorn — open-core reliable webhook-delivery infrastructure.** A service (and
embeddable library) that lets any product send signed, retried, observable webhooks to its
own customers, deployable as a **single container with no external Redis** and a generous
free tier, fully compliant with the **Standard Webhooks** specification.

This is the "send webhooks to your users" category currently owned by **Svix**, with
**Hookdeck Outpost**, **Hook0**, and **Convoy** as the other serious players.

## 2. Why this maximizes the GOAL's two filters

`docs/GOAL.md` sets two filters: *(a) easiest for a fully autonomous coding agent to bring
to production grade*, and *(b) highest profit while improving beyond current offerings.*
Webhook infrastructure is the strongest intersection of the two.

### (a) Easiest to bring to production grade autonomously

The product is **almost entirely deterministic, self-contained logic** — the regime where
an autonomous agent + a test gate is strongest:

| Core capability | Verifiable how |
| --- | --- |
| HMAC signing / verification (Standard Webhooks) | Golden vectors + round-trip unit tests |
| Retry schedule & exponential backoff | Pure-function unit tests |
| Idempotency / dedup keys | Unit tests |
| Delivery state machine, dead-letter, replay | In-process integration tests |
| Subscription & endpoint CRUD | API contract tests against in-process server |
| Fan-out / ordering guarantees | Deterministic integration tests with a fake clock |

No ML nondeterminism, no required third-party accounts, no human design or ops gate to
ship v1. A receiver and sender can both be stood up **in-process** in tests, so every loop
iteration is fully validatable locally — directly serving Axiom 2 (*Keep Main Green*).

### (b) Highest profit + clear improvement over the market

- **Incumbent pricing is steep and ops-heavy.** Svix's free tier (50k msgs) jumps to
  **$490/mo** Professional, then **$100 per million** messages, and self-hosting it needs
  **Postgres + Redis**. Hookdeck Outpost undercuts delivery cost (~$10/M) but is a
  narrower product; Hook0 is SSPL source-available; Convoy (MIT, self-host) is a heavier,
  Redis-backed deployment.
- **The wedge — operational simplicity + price.** Posthorn ships as a **single process,
  SQLite-by-default (Postgres optional), with a durable in-process queue (no Redis)**,
  MIT-licensed, Standard-Webhooks-compliant, with a first-class TS/JS SDK and an
  **embeddable library mode** (use it as a library *or* a standalone gateway). Nobody owns
  the "drop-in, zero-dependency, affordable, spec-compliant" slot for indie/SMB teams.
- **Recurring B2B revenue with classic open-core economics.** Open-source core drives
  adoption; monetize via a hosted cloud (usage-based) and enterprise features (SSO, audit
  log retention, multi-region, SLAs). Micro-SaaS infra margins run 70–85%.

### Target clients

1. **Indie devs / small SaaS teams** priced out of Svix Pro — land via OSS + free hosted tier.
2. **Mid-market platforms** that need to *send* webhooks and currently roll their own badly
   (no retries/signing/observability) — expand via hosted cloud.
3. **Compliance-sensitive / on-prem buyers** who require self-hosting — enterprise license.

### Competition & differentiation summary

| | Svix | Hookdeck Outpost | Hook0 | Convoy | **Posthorn** |
| --- | --- | --- | --- | --- | --- |
| License | source-available | SaaS | SSPL | MIT | **MIT** |
| Self-host deps | PG + Redis | n/a | PG | PG + Redis | **none (SQLite) / PG optional** |
| Library mode | partial | no | no | no | **yes** |
| Standard Webhooks | yes | partial | yes | partial | **yes (first-class)** |
| Entry price | $0 → $490/mo | low | mid | $99/mo | **$0, gentle usage curve** |

## 3. Stack decision (grounded in this sandbox's real toolchain)

Probed available: **Node 24, npm 11, pnpm, Python 3.14, Docker 29** — **no Go**.

- **Language: TypeScript / Node.** Runnable and testable here (so main stays green),
  matches the human's primary ecosystem (their `salesforce-lite-crm` is TS), and the SDKs
  customers consume are TS/JS first. Go's single-static-binary edge is nice but
  unavailable here; Docker presence still delivers the single-container self-host story.
- **HTTP:** Fastify. **Storage:** SQLite default via Node's **built-in `node:sqlite`**
  (revised from `better-sqlite3` — the builtin needs no native compile step and adds zero
  dependencies, strengthening the "single container, no deps" wedge), Postgres optional via a
  thin storage interface. **Queue:** durable, store-backed (no Redis). **Tests:** Vitest.
- **Packaging:** single Docker image; library entrypoint published to npm.

## 4. Roadmap (each phase is one or more validated loop iterations)

- **P0 — Foundation (this iteration):** decision record, TS scaffold, and the spec-compliant
  **signer/verifier** (the security heart) with golden-vector tests. ✅
- **P1 — Delivery core (complete):** retry/backoff schedule ✅, delivery state machine ✅,
  dead-letter ✅ (`src/delivery/`); idempotency/dedup keys ✅, in-memory store + `MessageStore`
  storage interface ✅ (`src/storage/`). All pure/deterministic, heavily tested.
- **P2 — Persistence + queue (complete):** durable, crash-safe SQLite `MessageStore` on
  built-in `node:sqlite` ✅ (`src/storage/sqlite-store.ts`), proven byte-for-byte equivalent to
  the in-memory reference via a shared conformance suite ✅ (`src/storage/conformance.ts`); and the
  reliable-delivery spine — a durable, store-backed **`DeliveryQueue`** ✅ (`src/queue/`) with
  lease-based claiming + visibility timeouts and **crash-safe replay of in-flight work** (a lapsed
  lease is reclaimed, never lost), in both in-memory and SQLite backends held to one shared
  conformance suite. The queue persists delivery *state* (status/attempts/`lastError`) and reuses
  the P1 pure FSM + retry policy for every transition. Deferred to a later tick: a full per-attempt
  audit log (one record per HTTP attempt with response detail) — an observability add-on, distinct
  from the load-bearing state the queue already persists.
- **P2.5 — Delivery worker (complete):** the runtime I/O driver that ties the pieces together —
  `DeliveryWorker` (`src/worker/delivery-worker.ts`) claims due tasks from the queue, loads each
  message from the store, signs it, POSTs it over an **injectable `Transport`** (default
  `fetchTransport`), and settles the task (`complete`/`fail`) so the P1/P2 pure FSM + retry policy
  reschedule a retry or dead-letter an exhausted delivery. Holds **no** retry/state logic of its
  own; it only classifies a 2xx response as success. Every outside-world touch is an injected seam
  (clock, transport, idle `sleep`, and an **`EndpointResolver`** — the exact plug-point where P3's
  endpoint store supplies each task's URL + signing secret). `processOnce()` is the deterministic
  unit of work; `run()`/`stop()` is the continuous poll loop (drains back-to-back, sleeps when idle,
  survives unexpected tick errors via `onError`). A lapsed-and-reclaimed lease surfaces as a
  `StaleLeaseError` on settle, which the worker absorbs (counted `stale`) so it never double-settles.
  Per-attempt HTTP timeout via `AbortSignal`. Proven end-to-end: a worker-emitted request **verifies
  against the existing verifier** in tests and a compiled-`dist` smoke run. v1 processes a claimed
  batch sequentially (bounded concurrency is the next throughput optimization).
- **P3 — endpoints + HTTP API + SDK (in progress):**
  - **Endpoint store ✅ (this tick):** the persisted subscription/endpoint entity the rest of P3
    sits on. `Endpoint` (tenant-scoped via `appId`; url + signing secret + event-type subscription
    filter + disabled flag), the `EndpointStore` CRUD contract (`create`/`get`/`listByApp`/
    `update`/`delete`), shared pure validation/normalization (http(s)-only URL, deduped filter,
    injectable secret generation), in-memory reference + durable SQLite backends on one shared
    conformance suite (`src/endpoints/`) — the exact `MessageStore`/`DeliveryQueue` pattern. Wired
    to the worker: a queued `DeliveryTask` now carries an opaque `endpointId`, and
    `storeBackedResolver` fills the worker's `EndpointResolver` seam — proven end-to-end (a stored
    endpoint's secret signs a delivery that verifies against the verifier, in tests and a compiled-
    `dist` smoke run). The worker is no longer an island awaiting a hand-written resolver.
  - **Deferred (next ticks):** message **fan-out** (on create, enqueue one task per subscribed,
    enabled endpoint via `endpointSubscribesTo`; this needs `appId` on the message), the **App/tenant**
    entity that mints/validates `appId`, the **Fastify HTTP API** (apps/endpoints/messages CRUD +
    ingest), contract tests, TS SDK, OpenAPI.
- **P4 — Self-host packaging:** single Docker image, config, health/metrics, docs.
- **P5 — Hosted control plane:** multi-tenant, usage metering, billing, dashboard (monetization).

## 5. Out of scope / non-goals

- Not a CRM (the human already builds `salesforce-lite-crm`) and unrelated to `AC1`/`agy-sandbox`.
- v1 does not aim to *receive/ingest* third-party webhooks (Hookdeck's lane); focus is
  reliable **sending**. Ingestion is a possible later expansion.
