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
  against the existing verifier** in tests and a compiled-`dist` smoke run. A claimed batch is
  delivered through a **bounded concurrency pool** ✅ (`concurrency`, default 8, env
  `POSTHORN_WORKER_CONCURRENCY`; `1` restores sequential): up to `concurrency` sends are in flight at
  once, so one slow/timing-out receiver no longer blocks the healthy deliveries behind it
  (head-of-line blocking), and the worst-case batch wall time drops from `batchSize × timeout` to
  `ceil(batchSize / concurrency) × timeout` — relaxing the lease-lapse constraint. Each task still
  settles independently under its own lease, so concurrency adds no new coordination, and an
  unexpected settle error still propagates from `processOnce` (no sibling pump rejection is left
  unhandled). Proven by a gated-transport pool-saturation suite (parallel-but-bounded, sequential at
  `concurrency:1`, slow-receiver-doesn't-block) and a compiled-`dist` smoke (one message fanned to a
  slow + fast receiver arrives in parallel, both verified through production ESM).
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
  - **Message fan-out ✅ (this tick):** the step that makes the parts a *service* — `src/fanout/`.
    A message is now **tenant-aware** (`appId` added to `Message`/`NewMessage`), and because the
    message carries a tenant, **idempotency is now scoped per app** (`getByIdempotencyKey(appId, key)`,
    composite `(app_id, key)` SQLite PK, nested in-memory index) — one tenant's key can no longer
    dedup against *or leak* another tenant's message (a real cross-tenant bug that adding `appId`
    would otherwise have introduced). `selectFanoutTargets` is the **pure** routing rule (enabled +
    `endpointSubscribesTo`, with skip-reason buckets for observability); `fanOut` lists a message's
    `appId` endpoints, selects, and enqueues one `DeliveryTask` per match (carrying the opaque
    `endpointId`); `ingest` accepts a message and fans it out in one call, **suppressing re-fan-out
    on a deduplicated retry** (the headline `POST /messages` operation). Proven end-to-end through
    the compiled `dist` (ingest → fan-out → queue → worker → sign → **verify**) including cross-tenant
    idempotency isolation. **Honest limitation:** `ingest`'s create+fan-out is not one atomic unit —
    a crash between them leaves a message whose retry dedups and skips fan-out; the robust fix is a
    transactional outbox (enqueue inside the create txn), deferred.
  - **App/tenant entity + API-key auth ✅ (this tick):** the identity layer that turns `appId`
    from a forgeable opaque string into an authenticated tenant — `src/apps/`. `App`
    (`id`/`name`/timestamps) is the tenant a single instance serves; each app owns one or more
    `ApiKey`s. The `AppStore` contract adds app CRUD (`create`/`get`/`list`/`update`/`delete`) plus
    the credential surface (`createApiKey`/`listApiKeys`/`revokeApiKey`/`authenticate`).
    **Security model:** a key secret is 256 bits of CSPRNG output, so the store keeps only
    `sha256(secret)` (hex) — which doubles as the O(1) `authenticate` lookup index — and returns the
    plaintext exactly once at creation (never recoverable); a deliberately fast hash, not a password
    KDF, because the input is high-entropy (the same reasoning behind storing the P0 signer's
    secrets). Constant-time hash compare on the auth path (defense-in-depth atop the indexed match);
    revoked keys never re-authenticate; `authenticate` is a pure read (no hot-path write). Same proven
    dual-backend + one-shared-conformance-suite pattern (in-memory reference + durable SQLite; the
    SQLite backend ties keys to apps with `ON DELETE CASCADE` so deleting a tenant reaps its keys
    atomically). A golden SHA-256 vector pins the on-disk hash format so a future change can't silently
    invalidate every stored key. Proven end-to-end on the compiled `dist` (mint → authenticate →
    revoke-denies → cross-tenant isolation → cascade-delete-denies). This is the exact plug-point the
    HTTP API's auth middleware will call: `authenticate(presentedKey)` → `appId` → scope the existing
    endpoint/message/ingest operations. **Deferred within auth:** per-key `lastUsedAt` (kept off the
    hot read path as an observability add-on).
  - **HTTP API ✅ (this tick):** the layer that turns the engine into a *runnable service* —
    `src/http/`. Built on Node's **built-in `node:http`** (revised from the long-deferred Fastify:
    the builtin needs no `npm install`/network access in this sandbox and adds **zero runtime
    dependencies**, the same reasoning that chose `node:sqlite`/`node:crypto` — and *strengthens* the
    single-container, zero-dep wedge rather than compromising it with a framework). Mirrors the
    delivery worker's pure-core/thin-I/O split: a **pure router** (`router.ts`, `matchRoute` →
    matched/methodNotAllowed/notFound) + a **pure request→response handler** (`api.ts`,
    `createApi(deps)`) composing `AppStore.authenticate` (Bearer auth), `EndpointStore` (CRUD), and
    `ingest` (accept + fan-out), behind a thin `node:http` adapter (`server.ts`, `createHttpServer`)
    that only reads the body (1 MiB cap → `413`), normalizes the request, and writes JSON. Surface:
    unauthenticated `GET /healthz`; authenticated `POST /v1/messages` (`202`), `GET/POST /v1/endpoints`,
    `GET/PATCH/DELETE /v1/endpoints/:id`. **Security decisions (not incidental):** tenancy is taken
    from the authenticated key, never a request-body `appId` (no tenant forgery); cross-tenant access
    is `404` not `403` (existence never revealed); an endpoint's signing secret is returned exactly
    once on create and never echoed by list/get/update; app/key *provisioning* is **not** a
    *tenant*-key route (a tenant cannot mint credentials) — it lives on the separate, admin-token-gated
    `/v1/admin/*` control-plane surface, added in a later tick. Proven end-to-end on the compiled `dist`
    over a real socket (auth → endpoint create → ingest → worker drains → the signed delivery
    **verifies** against the endpoint secret), plus a pure in-process suite (router + handler + a
    `node:http` integration test on an ephemeral port).
  - **Runnable gateway ✅ (this tick):** the composition root that makes the standalone-gateway
    half of the wedge real — `src/runtime/` + `src/main.ts`. The HTTP API had only landed as a
    `createHttpServer(deps)` *factory*; nothing instantiated the durable stores, joined them, opened
    a socket, and started the worker, so Posthorn could be *constructed* in a test but not *run*.
    `loadConfig(env)` is a **pure**, exhaustively-tested env→`GatewayConfig` parser (`POSTHORN_*`
    vars, validated, frozen; no `process.env`/socket/fs access — the same pure-core discipline as the
    HTTP handler). `createGateway(config)` is pure plumbing: it opens the four SQLite backends under
    `dataDir` (one file per store, or `:memory:`), wires `ingest` + the worker (`storeBackedResolver`)
    + the HTTP server, and returns a `Gateway` with `start()` (listen + run the worker; returns the
    bound address) and an idempotent, graceful `stop()` (drain the worker, close the server's idle
    sockets, release every SQLite handle). `src/main.ts` is the thin `posthorn` bin (shebang +
    `npm start`): load config, boot, translate `SIGINT`/`SIGTERM` into `stop()`. The stores are
    exposed on the `Gateway` so the keyless app/key bootstrap stays programmatic (still no HTTP
    route). Proven end-to-end on the **compiled `dist`**: the binary boots and serves `/healthz` over
    a real socket, and a full provision→ingest→deliver→**verify** round-trip runs through the built
    ESM (incl. the `node:sqlite` `createRequire` path); an in-process suite adds durability across a
    restart (an endpoint created before `stop()` survives a fresh `createGateway`).
  - **Transactional outbox ✅ (this tick):** the fix that closes the one known correctness gap in
    the core path — `src/fanout/fanout-dispatcher.ts` + outbox state in the message store. Accepting
    a message and recording that it *owes a fan-out* is now a single atomic step in the store (a
    `fanned_out_at` marker, written in the same transaction that inserts the message — exposed as
    `CreateMessageResult.fanoutPending` + `MessageStore.markFannedOut`/`listPendingFanout`). So the
    old window — message stored, but its idempotent retry dedups and *skips* fan-out, stranding
    deliveries — is gone: the marker survives a crash. It is drained two ways: (1) a producer's retry
    sees `fanoutPending` and re-drives the owed fan-out (`ingest`); (2) a **`FanoutDispatcher`** (the
    structural twin of the delivery worker — `sweepOnce`/`run`/`stop`, fully fake-clock-testable)
    sweeps any message left pending past a grace period, the path for fire-and-forget producers that
    never retry. The dispatcher reuses the pure `fanOut`, so routing can't drift; it is wired into the
    gateway and runs alongside the worker. A SQLite **migration** brings a pre-outbox database up to
    schema, backfilling existing rows as already-fanned-out so an upgrade never re-delivers history.
    **Net guarantee:** end-to-end delivery is now *at-least-once* (the residual being a possible
    duplicate if a crash strikes between the queue enqueue and the cross-store marker-clear — the
    queue's existing at-least-once contract, covered by receiver-side dedup on the stable message id);
    the previous gap allowed *zero*-once. Proven through the compiled `dist` (orphan → dispatcher
    sweep → worker → **verify**) and a running-gateway end-to-end test.
  - **Admin provisioning CLI ✅ (this tick):** the **bootstrap path** that makes a deployed gateway
    actually usable — `src/runtime/admin.ts` + an `admin` dispatch in `src/main.ts`. The HTTP API
    authenticates every route with a Bearer key, but minting the *first* key has no HTTP route (no key
    exists yet to authenticate the call, and an open provisioning endpoint is the door we refuse to
    build). Before this tick that left provisioning reachable *only* programmatically against
    `AppStore` — so a freshly-booted `posthorn` could be started but had **no way to create a
    credential against it**, leaving the entire authenticated API unreachable out of the box. The CLI
    closes that gap behind the correct privilege boundary — **the shell on the host that owns the data
    directory**, not the network. `posthorn admin <command>`: `create-app [name]`, `create-key
    <appId>` (prints the one-time secret), `list-apps`, `list-keys <appId>`, `revoke-key <keyId>`,
    `help`. Faithful to the pure-core/thin-I/O split: `runAdminCommand(args, {store, out, err})` is the
    tested core (injected store + output sinks, returns a process exit code, no I/O of its own — 22
    unit tests over an `InMemoryAppStore`), and `main.ts` is the thin shell that opens the
    `SqliteAppStore` at the *same* location the gateway uses (a now-shared `resolveLocations`, so admin
    and server can never disagree on the file). WAL makes it safe against a live gateway. Proven on the
    compiled `dist` across processes: provision via the CLI, then a separately-spawned server
    authenticates the minted key over real HTTP (401 without → 200 with), a CLI `revoke-key` is
    honored by the running server (→ 401), and `list-keys` never echoes the full secret.
  - **Delivery-status read API ✅ (this tick):** the *observable* half of the product's
    one-line promise ("signed, retried, **observable** webhooks"), which until now had no surface at
    all — a producer could `POST /v1/messages`, get a `202`, and then never learn the fate of the
    delivery. `GET /v1/messages/:id` (`src/http/api.ts`) returns the message plus **one delivery
    record per subscribed endpoint** — `status` (pending/delivering/succeeded/dead_letter), `attempts`,
    `nextAttemptAt`, and `lastError` — answering "what happened to my webhook?", the single
    most-used feature of every incumbent (Svix/Convoy's dashboards). The load-bearing addition is a new
    **`DeliveryQueue.listByMessage(messageId)`** read primitive (the queue already persisted per-task
    `status`/`attempts`/`lastError`; nothing exposed it per message): added to the contract, both
    backends (in-memory filter; SQLite `WHERE message_id` + a new `idx_delivery_tasks_message`,
    auto-created via `IF NOT EXISTS` so an existing DB needs no migration — it is a pure read
    optimization), and the one shared conformance suite (3 cases × 2 backends). **Security:** tenancy
    from the key; a message belonging to another app (or absent) is `404`, never revealed — identical
    to the endpoint routes. Internal queue plumbing (`leaseToken`) is omitted from the view. Proven by
    a deterministic unit path (ingest → `worker.processOnce` → status flips `pending`→`succeeded`), a
    real-socket gateway end-to-end, and a compiled-`dist` SQLite smoke run.
  - **TypeScript/JavaScript SDK ✅ (this tick):** the headline DX differentiator from the wedge —
    `src/sdk/`. A *consumer* now imports a typed client instead of hand-rolling `fetch`, header
    construction, and error parsing. `PosthornClient({ baseUrl, apiKey })` covers the full v1 surface
    (`health`/`sendMessage`/`getMessage`/`listEndpoints`/`createEndpoint`/`getEndpoint`/
    `updateEndpoint`/`deleteEndpoint`); a non-2xx becomes a `PosthornApiError` carrying the HTTP
    `status` + the envelope's machine `code` (falling back to `http_<status>`), a transport failure a
    `PosthornError`, and a request past `timeoutMs` a `PosthornTimeoutError` (via an `AbortController`).
    The wire types are **SDK-owned views**, not the server's domain types, because the HTTP surface
    returns deliberately reduced shapes (an endpoint's `secret` is write-only; a delivery's internal
    `leaseToken` is never exposed) — the SDK models exactly what crosses the wire. **Zero runtime
    dependencies:** it speaks over the platform `fetch`, injectable for tests/exotic runtimes. It also
    ships the **receiver** half so a consumer's whole integration is one import: `verifyWebhook(secret,
    headers, rawBody)` / `isValidWebhook(...)` (`src/sdk/verify.ts`) extract the three Standard Webhooks
    headers from a raw header bag (case-insensitive, array-tolerant) and delegate to the proven library
    `verify` — no crypto duplicated, so the two can't drift. Proven by a pure receiver-verify suite, an
    in-process client suite against the real `node:http` server (CRUD, idempotency, secret-never-leaked,
    401/404 mapping, injected-fetch error/timeout/parse paths), and a **full end-to-end test driven
    entirely through the SDK** (send → running worker delivers → the receiver verifies with the SDK's
    own `verifyWebhook` → the SDK's `getMessage` observes `succeeded`), plus a compiled-`dist` smoke run
    of that same loop through production ESM.
  - **Message listing — `GET /v1/messages` ✅ (this tick):** the *collection* half of the product's
    observability promise, completing the single-message read from the prior tick. A producer can now
    enumerate what it has sent — newest-first — rather than only fetching a message whose id it already
    kept; this is the load-bearing surface every incumbent's dashboard is built on, and a prerequisite
    for the eventual hosted control plane (P5). **Keyset-paginated, not offset-paginated** (`src/storage/
    message-store.ts`): a new `MessageStore.listByApp(appId, {limit, cursor})` orders by `(createdAt,
    id)` descending and pages on an opaque cursor encoding the last row's `(createdAt, id)` — stable
    under concurrent inserts (a new message lands on page one, never shifting an in-flight scan) and an
    indexed lookup as the unbounded log grows. One shared ordering rule (`compareMessagesNewestFirst` /
    `isMessageAfterCursor`) is mirrored by the in-memory sort and the SQLite `ORDER BY … DESC` + keyset
    predicate, so the two backends can't drift; both pass the same expanded conformance suite (9 new
    cases × 2 backends — empty, newest-first, tenant-scoping, multi-page coverage, exact-multiple
    termination, same-ms id tiebreak, limit cap, malformed-cursor reject). SQLite gains
    `idx_messages_app_created (app_id, created_at, id)`, created via `IF NOT EXISTS` so an existing DB
    needs **no migration** (a pure read optimization, like the prior tick's per-message index). The HTTP
    layer learned to parse a **query string** (`ApiRequest.query`, filled by the `node:http` adapter) —
    the reusable `?limit=&cursor=` rail every future list/filter route needs; the route validates
    `?limit=` to a 400 and scopes to the authenticated tenant (a listing never reveals another tenant's
    messages). **Lean list rows** (`messageListItemView`): id/appId/eventType/idempotencyKey/createdAt
    only — no payload, no per-endpoint deliveries, so a page never fans out into an N+1 delivery query;
    the detail (`GET /v1/messages/:id`) carries those. The SDK gained `client.listMessages({limit,
    cursor})` → `{ data: MessageRef[], nextCursor }`. Proven by the expanded conformance suite, a pure
    handler suite (auth/empty/order/paging/400s/tenant-isolation), a real-socket query-parsing test, an
    in-process SDK paging test, and a compiled-`dist` smoke run (send 5 → page through 3× via the SDK →
    full list lean + `nextCursor:null`).
  - **Manual retry / replay — `POST /v1/messages/:id/retry` ✅ (this tick):** the operator's
    recovery path, and the last unaddressed word in the tagline ("signed, **retried**, observable").
    Automatic retries (the P1 policy + FSM) absorb transient receiver blips, but a *sustained* outage
    exhausts the schedule and the delivery lands in the terminal `dead_letter` state — which until now
    was a permanent dead end: once a receiver was fixed, nothing could make Posthorn try again. Every
    incumbent (Svix/Convoy/Hookdeck) exposes exactly this as "replay"/"retry". Built faithful to the
    pure-core discipline: a new **`manualRetry`** event on the delivery FSM (`src/delivery/delivery-state.ts`)
    — the *only* transition out of a terminal state — revives a finished delivery as a brand-new one
    (`pending`, deliverable now, **attempt budget reset** so the full schedule applies again — keeping
    the exhausted count would re-dead-letter on the first new attempt — and `lastError` cleared).
    The queue gains a pure `applyManualRetry` helper (defers to the reducer, so terminal→pending can't
    drift) and a **`DeliveryQueue.retry(taskId)`** primitive (both backends, +4 shared conformance cases
    × 2: revives dead_letter→claimable with budget reset, revives succeeded, `UnknownDeliveryTaskError`
    on unknown id, `DeliveryStateError` on a non-terminal task). A thin **`retryMessageDeliveries`**
    orchestration (`src/queue/retry-message.ts`, the structural twin of `fanOut`) lists a message's
    tasks and re-drives only the **dead-lettered** ones — succeeded/in-flight/pending are left untouched
    (replaying healthy deliveries is not what "retry the failures" means) — absorbing the concurrent
    double-retry race (`DeliveryStateError` ⇒ "already revived", like a lapsed lease). The route is
    tenant-scoped (another tenant's/absent message is `404`, never revealed, identical to the read
    route), returns the refreshed per-endpoint statuses, and the SDK gains `client.retryMessage(id)`.
    Proven by FSM unit tests, the expanded conformance suite, a service suite incl. a **worker-driven
    full recovery loop** (ingest → dead_letter → retry → delivered), pure handler + SDK tests, and a
    compiled-`dist` SQLite smoke (dead_letter → retry → delivered+**verified** through production ESM).
    Net: a dead-lettered delivery is recoverable instead of lost — `dead_letter` is no longer terminal
    for an operator.
  - **OpenAPI 3.1 contract — `GET /openapi.json` ✅ (this tick):** the cross-language complement to
    the TS SDK and the source for interactive docs (Swagger UI / Redoc) — the SDK covers typed *TS*
    consumers; the spec lets a consumer in **any** language generate a typed client (`openapi-generator`,
    `oapi-codegen`, …). `src/http/openapi.ts` is a **pure**, zero-dependency builder
    (`buildOpenApiDocument()`) of a hand-authored document — hand-authored, not reflected, because a
    useful spec carries far more than the route table (per-field descriptions, request/response schemas,
    error codes, examples, the Bearer security model + the `security:[]` overrides on the three
    unauthenticated routes). `info.version` is read from `package.json` via the same `version.ts` seam
    `/metrics` uses, so the published spec always names the running build. The route is served verbatim
    (unauthenticated, like `/healthz`/`/metrics`). **What stops the spec drifting from the router** is the
    same conformance discipline the dual store backends use: `api.ts` now exposes a single source of
    truth `API_ROUTE_KEYS`, the route table is built from it via a `Record<ApiRouteKey, RouteHandler>`
    (so a key with no handler — or a handler with no key — is a *compile* error), and a **bidirectional
    drift test** asserts the document's operations exactly equal `API_ROUTE_KEYS` (mapped `:id`→`{id}` by
    the shared, exported `patternToOpenApiPath`). So a route can never ship undocumented, nor a doc entry
    without a route. Proven by a pure builder/structure/ref-integrity/orphan-schema suite, the drift test,
    a pure handler test + a real-socket JSON test, a **compiled-`dist` smoke** (production ESM serves the
    doc — 12 operations, 15 schemas, real build version via the `createRequire` path), and — beyond the
    standard gate — **externally validated as a valid OpenAPI 3.1 document by the Redocly CLI linter**
    (0 errors; the only output is the stylistic "no 4xx response" warning on the two probe routes that
    legitimately have none). SDK coverage of this *meta* endpoint is intentionally omitted (the SDK is the
    typed-TS path; OpenAPI exists for everyone else).
  - **Per-attempt delivery audit log — `GET /v1/messages/:id/attempts` ✅ (this tick):** the *depth*
    behind the "observable" promise, and the single most-used view in every incumbent's dashboard
    (Svix "message attempts", Convoy "delivery attempts"). The `DeliveryQueue` already persisted each
    delivery's *latest* state (status/attempts/`lastError`) — "where does this delivery stand now?" — but
    threw away the history: it could not say *attempt 3 got an HTTP 503 after 1.2s, attempt 4 timed out*,
    the data a developer actually debugs a flaky receiver from. This adds that history as a separate,
    append-only **`DeliveryAttemptStore`** (`src/attempts/`): one immutable record per HTTP attempt —
    `attemptNumber` (1-based), `outcome` (succeeded/failed), `responseStatus` (or `null` on a transport/
    pre-flight failure), `error`, `durationMs`, `attemptedAt`. Deliberately **separate from the queue**:
    the scheduler's hot path never scans the unbounded audit table, and it can be pruned/tiered later
    without touching delivery correctness. Same proven dual-backend + one-shared-conformance-suite pattern
    (in-memory reference + durable SQLite on `node:sqlite`, `STRICT`, a `message_id` index, append-only —
    no `UPDATE`/`DELETE`). The {@link DeliveryWorker} writes one record per attempt through a new injected
    **`recordAttempt`** seam (the structural twin of the metrics `onTick` hook — the worker holds no audit
    logic; it captures the response status + measures latency around the send and reports facts);
    recording is **best-effort** — a failed audit write is routed to `onError` and never blocks or fails a
    delivery (audit is an add-on, delivery is the core). Pre-flight and transport failures are logged too
    (`responseStatus:null`), so the trail is complete; at-least-once duplicate attempts are recorded
    faithfully. The route is tenant-scoped (another tenant's/absent message is `404`, never revealed,
    identical to the read/retry routes), returns the full log oldest-first (bounded by endpoints×attempts,
    no pagination — like the per-endpoint deliveries), the SDK gains `client.listMessageAttempts(id)`, and
    the OpenAPI doc gains the operation + `DeliveryAttempt`/`DeliveryAttemptList` schemas (the bidirectional
    drift test forces both). Proven by the shared conformance suite (×2 backends), worker tests (success/
    non-2xx/transport-throw/pre-flight/latency/attempt-numbering/best-effort-absorb), pure handler + SDK
    tests, running-gateway end-to-end, and a **compiled-`dist` smoke** (succeeded-200 + failed-500 attempts
    recorded and read back through production ESM, incl. the `node:sqlite` `createRequire` path).
  - **Zero-downtime secret rotation — `POST /v1/endpoints/:id/rotate-secret` ✅ (this tick):** the
    completion of a named Standard Webhooks capability whose *receiver* half already existed but whose
    *sender* half did not. The verifier (and the SDK's `verifyWebhook`) have always accepted a
    multi-token `webhook-signature` header — the spec's mechanism for rotating a signing secret without
    dropping a webhook — but the sender only ever signed with one secret, and the lone rotation path
    (`PATCH …{secret}`) was a **hard swap** that breaks every receiver until it is reconfigured in
    lockstep. This adds the missing half. The `Endpoint` gains `previousSecrets: {secret, expiresAt}[]`
    — secrets retired by a rotation that keep signing until each expires; a pure
    `rotateEndpointSecret(current, newSecret, now, overlapMs)` installs a fresh primary, retires the old
    one with an overlap window (`DEFAULT_SECRET_ROTATION_OVERLAP_MS` = 24h; `0` = instant hard swap),
    prunes expired retirees, and caps the set at `MAX_PREVIOUS_SECRETS`; a pure `activeSigningSecrets
    (endpoint, now)` is the one shared rule for "which secrets sign right now". The worker's
    `buildSignedRequest` now signs with the primary **plus** every `additionalSecrets` the resolver
    forwards (the still-active retirees, filtered by an injected clock in `storeBackedResolver`/
    `endpointToDeliveryTarget`), emitting one space-delimited `v1,…` token per active secret — so during
    the overlap a receiver on *either* the old or the new secret verifies, then the old simply expires.
    A new **`EndpointStore.rotateSecret`** primitive (both backends, one shared conformance suite; the
    SQLite backend persists the retirees in a `previous_secrets` JSON column added by a seamless
    `ALTER TABLE` migration so a pre-rotation DB upgrades with no data loss and no re-delivery) is wired
    to a tenant-scoped HTTP route that reveals the **new** primary exactly once (like create) and
    **never** exposes the retired secrets, the SDK's `client.rotateEndpointSecret(id, {secret?,
    overlapMs?})`, and the OpenAPI doc (the bidirectional drift test forces both). Proven by pure
    helper tests, the expanded conformance suite (×2 backends, incl. overlap-then-expiry + reopen +
    migration), worker multi-sign tests, pure handler + SDK tests, and a **running-gateway +
    compiled-`dist`** end-to-end where one delivered webhook **verifies against both the old and the
    new secret** and the rotation survives a restart on the real `node:sqlite` file path.
  - **Admin / control-plane HTTP API ✅ (this tick):** the keystone for **remote/hosted operation and
    P5** — provisioning over HTTP, not just the host shell. Until now the only way to mint the first
    app/key against a deployed gateway was the `posthorn admin` CLI on the box (or programmatic
    `AppStore`); a remote/hosted operator had no network path to create a tenant, so the entire
    authenticated API was unreachable without shell access. This adds a **separate, admin-token-gated**
    surface under `/v1/admin/*` (`src/http/api.ts`): create/list/get/delete tenants (`POST/GET
    /v1/admin/apps`, `GET/DELETE /v1/admin/apps/:id`) and mint/list/revoke keys (`POST/GET
    /v1/admin/apps/:id/keys`, `DELETE /v1/admin/keys/:id`) — a superset of the CLI. **Security (decided,
    not incidental):** it is **disabled by default** — every admin route is `404`, indistinguishable from
    a nonexistent path, unless `POSTHORN_ADMIN_TOKEN` is set, so the default attack surface is unchanged
    and a disabled instance never reveals the surface exists. The token is a **distinct credential** from a
    tenant API key (a tenant key never satisfies an admin route, nor vice versa), compared in **constant
    time** (both sides SHA-256'd, so neither length nor content leaks via timing) and validated at boot to
    a minimum length (`MIN_ADMIN_TOKEN_LENGTH`; a weak token → `ConfigError`, fail-fast). A minted key's
    secret is revealed exactly once (like endpoint create); key listings are metadata-only; deleting a
    tenant cascades its keys. This is the legitimate **authenticated, opt-in** control plane — not the
    "open provisioning endpoint" earlier ticks rightly refused. Faithful to the compile-checked route table
    + bidirectional OpenAPI drift test (the 7 ops + `App`/`NewApp`/`AppList`/`ApiKey`/`ApiKeyList`/
    `CreatedApiKey` schemas + an `adminAuth` security scheme were *forced* by the drift/orphan-schema tests).
    Proven by a pure handler suite (disabled→404; missing/wrong/tenant-key token→401; full CRUD; **a minted
    key authenticates a tenant route, revoke denies, delete cascades**), config parse/validate tests, a
    running-gateway e2e (provision → mint → deliver+**verify** → revoke→401), and a **compiled-`dist`** smoke
    (provision-over-HTTP on the real `node:sqlite` file path; delivery verifies through production ESM; the
    tenant persists across a restart). The keyless CLI remains the local-shell bootstrap path; the typed
    *admin* SDK client landed the next tick (below).
  - **Admin / control-plane SDK — `PosthornAdminClient` ✅ (this tick):** the typed control-plane
    counterpart to the tenant `PosthornClient` — `src/sdk/admin-client.ts`. A hosted operator (and the
    eventual P5 dashboard) can now *provision* a deployment from typed TS instead of hand-rolling `fetch`
    against `/v1/admin/*`: `createApp`/`listApps`/`getApp`/`updateApp`/`deleteApp`,
    `createApiKey`/`listApiKeys`/`revokeApiKey`, and `getAppUsage` — the full 9-route admin surface,
    authenticated by the operator **admin token** (a distinct credential from a tenant key, sent as the same
    `Authorization: Bearer …` envelope). Faithful to the SDK's wedge: **zero runtime dependencies** (platform
    `fetch`, injectable), **SDK-owned wire views** (an app/key carries no secret material except the one-time
    `secret` from `createApiKey`), and the same error model. **`getAppUsage`'s range is required** (`from`/`to`
    inclusive `YYYY-MM-DD`) because the admin metering route mandates an explicit window — unlike the tenant
    `GET /v1/usage`, which defaults to the current month (a real wire-contract difference the types now
    encode). The disabled-by-default admin surface surfaces as a `404` `PosthornApiError` (hidden, not merely
    forbidden), a wrong/tenant-key token as `401`. **No-drift refactor:** the request mechanics (the `fetch`
    contract, the three error classes, timeout/abort, the `{error:{code,message}}` mapping) were extracted
    from `client.ts` into a shared `src/sdk/http.ts` `HttpTransport` that **both** clients delegate to, so a
    fix to one lands in both — the same one-shared-rule discipline the store backends get from conformance
    suites; the public symbols are re-exported from `client.ts` so every existing import path stays stable.
    Proven by an in-process `node:http` suite (full CRUD; **a minted key authenticates a tenant
    `PosthornClient`, revoke locks it out, delete cascades**; disabled→404; wrong/tenant-key token→401;
    metered usage), injected-`fetch` transport tests (Bearer header, trailing-slash, path-encoding, error
    envelope, 204→void, timeout), a **running-gateway e2e** (provision over the admin SDK → the minted key
    delivers a **verified** webhook → admin SDK reads usage → revoke→401), and a **compiled-`dist` smoke**
    (provision-over-HTTP through production ESM on the real `node:sqlite` file path; tenant + quota + usage
    persist across a restart). The OpenAPI doc already covers *non-TS* admin consumers; this completes the
    typed-TS path.
  - **Endpoint health + automatic disabling ✅ (this tick):** the self-protection that stops Posthorn
    wasting deliveries — and the tenant's now-metered **operations** — on a permanently-dead endpoint, a
    named market-parity feature (Svix auto-disables consistently-failing endpoints). The `Endpoint` gains
    a health sub-record (`consecutiveFailures` + the `firstFailureAt`/`lastFailureAt` streak, all
    surfaced over the API/SDK/OpenAPI for transparency); a pure `evaluateEndpointHealth(current, outcome,
    now, autoDisableAfterMs)` folds one **terminal** delivery outcome into that state — a `succeeded`
    clears the streak (and is a **no-op on an already-healthy endpoint**, so the success hot path takes no
    write), a dead-lettered `failed` opens/extends it, and once the streak has lasted ≥ the configured
    window the endpoint is auto-disabled so fan-out (and the resolver) stop sending it new work. The
    policy is **time-based, not count-based** (deliberate: the ~28h, 8-attempt retry schedule means a
    single dead-letter already represents ~a day of failure, so a count threshold would disable a
    high-volume endpoint during a *recoverable* outage; a window is traffic-independent). A single
    isolated failure can never disable (its streak duration is 0 — sustained failure is required); a
    manual re-enable (`PATCH …{disabled:false}`) clears the streak for a clean restart. Applied as one
    atomic, no-drift store rule — a new **`EndpointStore.recordDeliveryOutcome`** (both backends, one
    shared conformance suite; the SQLite backend adds three columns via a seamless `ALTER TABLE` migration
    that backfills existing rows as healthy, and uses a **lock-free read on the success hot path**, taking
    a write txn only when state actually changes). The worker reports the terminal verdict through a new
    best-effort `onDeliveryOutcome` seam (the structural twin of `recordAttempt`/`onTick` — the worker
    holds no health logic; a failed health write is routed to `onError` and never blocks a delivery),
    wired in the gateway with the window from `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` (default 5 days;
    `0` = off, health still tracked). Proven by pure-policy tests, the expanded endpoint conformance suite
    (×2 backends), a SQLite **migration** test, worker seam tests + a **worker→store→resolver end-to-end**
    auto-disable test (the dead endpoint is disabled and the resolver then declines it — runaway delivery
    stops), config tests, an HTTP-view test, and a **compiled-`dist` smoke** (migration backfill +
    auto-disable + restart persistence on the real `node:sqlite` file, and the HTTP health view over a
    running gateway, all through production ESM).
  - **Deferred (next ticks):** per-key `lastUsedAt` ✅ (iter 33); attempt-log pagination ✅ (iter 35);
    `endpoint.disabled` notification event when an endpoint is auto-disabled (Svix emits one; today the
    disabled state is observable via the API/SDK, which a tenant polls or sees on next use).
- **P4 — Self-host packaging:** config ✅ (env-driven `loadConfig`) + a runnable single-process
  entrypoint ✅ (`posthorn` bin / `npm start`) + a `/healthz` liveness probe ✅ + an **admin
  provisioning CLI** ✅ (`posthorn admin …`, see P3) + a **single-container `Dockerfile`** ✅ + a
  **Prometheus `/metrics` endpoint** ✅ (this tick) — so a deployed instance can be bootstrapped,
  run, *and monitored* without writing code.
  - **Single-container image ✅ (this tick):** the headline deployment artifact that makes the
    "single container, no Redis" wedge a *thing you can `docker run`*, not just a prose claim. A
    multi-stage `Dockerfile` (+ `.dockerignore`): stage 1 (`node:24-alpine`) `npm ci` + `tsc` →
    `dist/` and strips the compiled `*.test.*` output; stage 2 copies **only** `dist/` + the
    `package.json` that marks the output ESM (`"type":"module"`) onto a bare Node base — **no
    `node_modules`, because the runtime has zero dependencies** (every moving part is a `node:*`
    built-in), the cleanest possible expression of the wedge. Runs as the unprivileged `node` user,
    persists durable SQLite state to a `/data` `VOLUME`, sets `POSTHORN_*` defaults, and ships a
    dependency-free `HEALTHCHECK` (Node's built-in `fetch` against `/healthz`). One exec-form
    `ENTRYPOINT ["node","dist/main.js"]` serves the gateway with no args (PID-1 `node` receives
    `SIGTERM` → the existing graceful drain) **and** runs the one-shot `posthorn admin <command>`
    bootstrap with args — so the same image provisions the first key and runs the server. **Validated
    for real, beyond the standard gate:** `docker build` succeeds; the booted container serves
    `/healthz` (Docker reports `healthy`); the `admin` CLI mints an app+key in a *separate* container
    sharing the `/data` volume and the running server **authenticates that key over HTTP** (401
    without → 200/202 with); a sent message is listable; `docker stop` drains gracefully; and the
    message **survives a full container teardown + fresh boot** on the same volume (durability, no
    Redis). Image ~231 MB (Alpine + Node).
  - **Prometheus metrics endpoint ✅ (this tick):** the operator-facing half of "observable", and
    the production-operability gate for any serious self-hoster ("does it expose Prometheus
    metrics?" is a real procurement question). An unauthenticated `GET /metrics` serves the standard
    text exposition (v0.0.4) over `node:http` with **zero new dependencies** (a pure string renderer,
    the same posture as the rest of the stack). Faithful to the pure-core/thin-I/O split: a
    `MetricsRegistry` (`src/metrics/`) is a tiny in-memory accumulator of monotonic counters fed by
    two *existing* seams — the ingest route and a new optional `DeliveryWorker.onTick(result)` hook
    that folds each tick's `TickResult` tally in (the worker holds no metrics logic) — and
    `renderPrometheus(snapshot)` is a **pure**, unit-tested function from a snapshot to exposition
    text. Counters: `posthorn_messages_ingested_total`, `posthorn_messages_deduplicated_total`,
    `posthorn_deliveries_total{outcome="succeeded|failed|dead_lettered|stale"}`. The load-bearing
    addition is a new **`DeliveryQueue.countByStatus()`** read primitive (added to the contract, both
    backends — in-memory tally; SQLite `GROUP BY status` — and the one shared conformance suite, +3×2
    cases) powering a point-in-time backlog gauge `posthorn_delivery_tasks{status="…"}` (the gauge
    operators alert on: how many deliveries are queued / in flight / stuck in `dead_letter` *right
    now*), read from the queue at scrape time so it is never stale. Plus `posthorn_uptime_seconds` and
    `posthorn_build_info{version}` (the version read once from `package.json` via `createRequire`,
    the same idiom as `node:sqlite`). The HTTP layer gained a small raw-body escape hatch
    (`ApiResponse.contentType`) so the adapter writes the Prometheus text verbatim instead of
    JSON-encoding it. **Security:** the endpoint exposes only instance-aggregate data — no tenant id,
    payload, or secret — so it is safe to scrape unauthenticated (Prometheus norm); operators restrict
    it at the network layer if desired (a dedicated admin port / opt-out flag is a noted later add).
    Counters are process-lifetime (reset on restart), correct for the single-process, no-Redis model
    (Prometheus detects resets). Proven by a pure renderer/registry suite, a pure handler suite, a
    real-socket raw-text test, a running-gateway end-to-end (deliver → scrape → counters reflect it),
    and a **compiled-`dist` smoke** through production ESM (incl. the `version.js`/`node:sqlite`
    `createRequire` paths).
  - **Operator deploy/monitoring guide ✅ (iter 34):** `docs/DEPLOY.md` — requirements, Docker
    Compose quick start, tenant bootstrap, full configuration reference (12 `POSTHORN_*` vars),
    security hardening (TLS/reverse-proxy, admin token, `/metrics` restriction, data-dir perms),
    Prometheus metrics catalog + PromQL queries, alerting guide (5 rules), Grafana add-on,
    upgrade procedure, standalone binary + systemd unit, library embedding, throughput tuning.
    `docker-compose.yml` + `monitoring/prometheus.yml` + `monitoring/alerts.yml` wire up the
    production monitoring stack in one command. `.env.example` documents every environment
    variable. GitHub Actions CI (`.github/workflows/ci.yml`) automates `tsc + vitest + build` on
    every push and PR to main. **P4 is now complete.**
- **P5 — Hosted control plane:** multi-tenant, usage metering, billing, dashboard (monetization). Its
  **foundation now exists** — the admin-token-gated `/v1/admin/*` provisioning API (see P3) is the
  control-plane seam a hosted dashboard/billing layer drives tenants and keys through.
  - **Per-tenant usage metering ✅ (this tick):** the read model usage-based billing and free-tier
    quota enforcement sit on — you cannot price per message (this market's unit) without it.
    `MessageStore.summarizeUsageByApp(appId, {fromMs, toMs})` returns a tenant's message volume over a
    half-open epoch-ms range, grouped by **UTC calendar day** (`total` + per-day breakdown). The
    deliberate design choice: it is an **aggregate over the messages table — the source of truth —
    not a separate rollup**, so the count is always *exact* (no recording seam to drop a write, no
    eventually-consistent drift, nothing to reconcile) and it rides the *existing*
    `idx_messages_app_created (app_id, created_at, id)` index that backs message listing — **zero new
    schema, zero migration, no change to the ingest hot path or the delivery worker**. A pure
    `utcDayKey` is the one shared day-bucketing rule the in-memory backend groups by and the SQLite
    backend mirrors as `date(created_at/1000,'unixepoch')` (held equal by the conformance suite, so
    they can't drift); a deduplicated retry is one stored message and is never double-counted. Exposed
    as the admin-token-gated `GET /v1/admin/apps/:id/usage?from=&to=` (inclusive `YYYY-MM-DD` UTC days,
    span capped at `MAX_USAGE_RANGE_DAYS = 366`; unknown tenant → 404, bad/missing/inverted/over-cap
    range → 400), added to the compile-checked route table + bidirectional OpenAPI drift test (the
    operation + `Usage`/`UsageDay` schemas were *forced* by the drift/orphan-schema tests). Proven by
    the expanded conformance suite (×2 backends: empty/grouping/tenant-scope/half-open-boundary/
    dedup-once/inverted-reject), a pure handler suite (disabled→404, auth, unknown-app, the 400 family,
    correct per-day counts, tenant isolation), a running-gateway e2e (send → query usage over HTTP →
    tenant-key→401), and a **compiled-`dist` smoke** (provision+send+usage over production ESM on the
    real `node:sqlite` file, persisting across a restart). The delivery-side companion —
    per-tenant *delivery* usage — landed in iter 29 (below).
  - **Real-time monthly quota enforcement ✅ (this tick):** the *enforcement* half of metering — the
    freemium / usage-based-pricing gate that turns the read model into a billable boundary. A tenant
    (`App`) gains an optional `monthlyMessageQuota: number | null` (`null` = no limit, the default; a
    non-negative integer caps monthly accepts; `0` suspends a tenant), settable at provision time
    (`POST /v1/admin/apps`) and changeable on the **new `PATCH /v1/admin/apps/:id`** plan-management
    route (the upgrade/downgrade path; `null` removes the limit). On `POST /v1/messages` the handler
    enforces it *before* accepting: a pure `utcMonthRange(now)` (`src/storage/message-store.ts`) locates
    the current **UTC calendar month**, the existing `summarizeUsageByApp` counts that window, and a pure
    `isQuotaExceeded(usage, quota)` (`src/apps/app.ts`, `>=` so a quota of `N` admits exactly `N`)
    decides → `429 quota_exceeded`. **Reuses the iter-25 read model** — no rollup, no new index, no
    ingest-hot-path write; the window "resets" at the month boundary with **no scheduled job** (the
    range simply moves). Two deliberate correctness calls: an **idempotent replay is exempt** (it creates
    no new message, so 429-ing it would break idempotency for a client retrying a send it already made),
    and the limit is **soft** (a burst near the ceiling can overshoot by at most the concurrency — the
    standard trade for not serializing ingest behind a counter). The quota is a nullable SQLite column
    added by a seamless `ALTER TABLE` migration (a pre-quota DB upgrades with existing tenants defaulting
    to unlimited — no behaviour change), validated by the shared `normalizeQuota`/`applyAppUpdate` so
    intake can't drift across backends. The route table + bidirectional OpenAPI drift test *forced* the
    `updateApp` operation, the `AppUpdate` schema, the `429` response, and the `monthlyMessageQuota`
    field on `App`/`NewApp`. Proven by pure unit tests (`normalizeQuota`/`isQuotaExceeded`/`utcMonthRange`/
    `applyAppUpdate`), the expanded app-store conformance suite (×2 backends: default/persist/reject/
    update-clear), a pure handler suite (unlimited never blocked, admits-N-then-429, replay-exempt,
    quota-0-blocks-all, **month-boundary reset**, PATCH set/change/clear + 400/404, disabled→404), and a
    **compiled-`dist` smoke** (admin-create-with-quota → 429 at the ceiling → PATCH raises it → sends
    resume, all over real HTTP, with the quota *and* the counted messages surviving a restart on the real
    `node:sqlite` file). **Reconciled, not freshly authored:** the implementation landed orphaned from an
    interrupted prior tick (built + uncommitted, no LOOP_LOG entry, tree red on `tsc`); this tick
    adjudicated it, completed the missing test coverage, and validated it green ([[interrupted-tick-reconcile-pattern]]).
  - **Tenant self-service usage & quota — `GET /v1/usage` ✅ (this tick):** the *customer-facing* half of
    the meter→enforce→**expose** arc, and the foundation the eventual dashboard UI renders. iter-25 metered
    message usage and iter-26 enforced a monthly quota, but both were reachable **only** over the admin
    control plane (`/v1/admin/apps/:id/usage`, admin-token-gated) — a tenant had *no* way to see its own
    consumption or even its plan limit, so a freemium user hitting a `429` was flying blind (and every such
    "what's my usage / how close am I?" question is a support ticket and an invisible upgrade prompt). This
    adds the tenant-authenticated counterpart (`src/http/api.ts`): scoped to the API key's tenant (never a
    body/path `appId`), it returns the tenant's own message breakdown over a range **plus** a live `quota`
    block for the **current UTC month** — `monthlyMessageQuota`, `used`, `remaining`, `periodStart`,
    `resetsAt`. The breakdown **defaults to the current month** (the natural self-service view) and accepts
    the same optional inclusive-`YYYY-MM-DD` `?from=&to=` historical window as the admin route (reusing
    `parseUsageRangeParams`; a partial/invalid/over-cap range → `400`); critically the `quota` block always
    reports **this month** regardless of the queried range — so a dashboard can show "you've used N of M,
    resets on the 1st" while still pulling history. **Pure reuse, zero new state:** it composes the existing
    `summarizeUsageByApp` read model (iter-25), `utcMonthRange` (iter-26), and a new pure
    `quotaRemaining(used, quota)` (`src/apps/app.ts` — the companion to `isQuotaExceeded`: `null`→`null`
    unlimited, else `max(0, quota−used)` so a soft-limit overshoot never reports negative) — **no store
    change, no migration, no new index, no ingest/worker change**. One store call in the default case (the
    queried range *is* the current month); a custom range adds one more to keep the quota block live. The
    compile-checked route table + bidirectional OpenAPI drift + orphan-schema tests **forced** the `getUsage`
    operation, a `Usage` tag, and the `TenantUsage` (`allOf` of the existing `Usage` + a `quota`) /
    `QuotaStatus` schemas. The SDK gained `client.getUsage({from?,to?})` → `TenantUsage` (the typed-TS path
    stays complete). Proven by pure `quotaRemaining` unit tests, a pure handler suite (401, current-month
    default, unlimited→`remaining:null`, used/remaining against a quota, historical-range-with-live-quota,
    partial/invalid/inverted-range `400`, tenant isolation), an in-process SDK test, and a **compiled-`dist`**
    smoke (admin-provision a quota'd tenant over HTTP → send → SDK `getUsage` reports `used/remaining` →
    historical range returns its window while quota stays current-month → usage+quota **survive a restart**
    on the real `node:sqlite` file).
  - **Per-tenant delivery (operations) usage ✅ (this tick):** the *delivery-side* meter that
    completes the billing read model. iter-25–27 metered **accepted messages**; this meters what
    Posthorn actually *did* — every HTTP **delivery attempt**, retries included — which is the real
    resource/cost unit incumbents bill on ("operations", e.g. Svix/Convoy), not just accepts. It was
    the standing-first deferred P5 item, deferred because the audit-log attempt carried `messageId`
    and `endpointId` but **not** the tenant, so a per-tenant count needed a join. The fix is the
    project's own established pattern, not a new rollup: **denormalize `appId` onto the
    `DeliveryAttempt`** (the worker already holds the loaded message at record time — `null` only for
    a vanished message, which then belongs to no tenant), exactly as `messageId`/`endpointId` are
    already denormalized "so the per-X read is a single indexed scan rather than a join." A new
    `DeliveryAttemptStore.summarizeAttemptsByApp(appId, range)` returns `{total, succeeded, failed,
    daily[]}` over a half-open epoch-ms range, grouped by **UTC day** and split by outcome — computed
    straight from the append-only attempts log (the source of truth, so the count is exact with no
    rollup to drift), riding a new `(app_id, attempted_at)` index, **sharing the message store's
    `UsageRange` + `utcDayKey`** so the two usage views line up day-for-day and can't drift. Exposed
    as a purely-additive `deliveries` block on **both** usage routes (`GET /v1/usage` *and*
    `GET /v1/admin/apps/:id/usage`, which share `usageView`) and on the typed SDKs
    (`TenantUsage.deliveries` / `AdminUsage.deliveries`); the route table + bidirectional OpenAPI
    drift + orphan-schema tests *forced* the `DeliveryUsage`/`DeliveryUsageDay` schemas. The SQLite
    `app_id` is a nullable column added by a seamless `ALTER TABLE` migration (pre-existing attempts
    keep `app_id = NULL` and are simply never attributed — honest: the data was never recorded), with
    the companion index created post-migration so a pre-tenant-usage DB upgrades cleanly. Proven by
    the expanded attempt-store conformance suite (×2 backends: zero/grouping/outcome-split/
    tenant-scope+null-exclusion/half-open-boundary/inverted-reject), worker tests (records the
    message's tenant; `null` for a vanished message), pure HTTP handler tests on both routes
    (populated per-day counts, tenant isolation, empty block), in-process SDK tests, and a
    **compiled-`dist` smoke** (provision over HTTP → real worker delivers a verified webhook →
    admin + tenant SDK both read `deliveries.total ≥ 1` → counts **survive a restart** on the real
    `node:sqlite` files).
  - **Admin dashboard UI ✅ (this tick):** the browser-facing face of the operator control plane —
    `src/dashboard/`. A server-rendered HTML admin panel served under `/dashboard/*`, enabled by the
    same `POSTHORN_ADMIN_TOKEN` already required to enable the admin JSON API (no new config, identical
    opt-in model — unset = every `/dashboard/*` route is `404`). Session auth: presenting the admin
    token in a login form issues an `HttpOnly; SameSite=Strict` session cookie (8-hour TTL,
    in-memory — sessions are ephemeral by design for an operator tool). **Security (decided, not
    incidental):** token comparison is constant-time (both sides SHA-256'd, `timingSafeEqual`); tenant
    API keys never satisfy the dashboard login; `SameSite=Strict` prevents CSRF from cross-site forms;
    `Secure` flag deliberately omitted (the Node server has no TLS — operators add it via a reverse
    proxy). Pages: login, apps list (+ create form with optional quota), app detail (keys table +
    one-time-create + revoke + delete-with-confirm). One-time key display on `POST …/keys` is a
    direct 200 response (not a redirect) so the secret is visible immediately; the operator copies it
    once and it is never retrievable again. Zero new runtime dependencies: pure HTML/CSS string
    builders (`src/dashboard/views.ts` — escapes all user content via `esc()` for XSS safety), a
    tiny in-memory `InMemorySessionStore` (`src/dashboard/sessions.ts`), and the handler
    (`src/dashboard/handler.ts`) re-uses the `ApiRequest`/`ApiResponse` types the JSON API already
    defines. `server.ts` dispatches on the `/dashboard` path prefix; `gateway.ts` wires the handler
    when `adminToken != null`. Proven by 6 session-store tests + 15 dashboard-handler pure tests
    (login/logout flow, auth guard, CRUD paths, key management, 404 for unknown routes), plus a
    **compiled-`dist` smoke run** (26/26 checks: login rejects wrong token, correct token sets
    `HttpOnly` cookie; create app → app detail; create key → secret shown → minted key authenticates
    a real tenant API request; cascade-delete invalidates key → 401; logout clears session).
  - **Tenant dashboard UI ✅ (this tick):** the browser-facing face of the tenant plane — a
    developer-debugging UI at `/dashboard/tenant/*` that lets any tenant browse their webhook
    messages, per-endpoint delivery statuses, and per-attempt audit logs. Authentication is via
    the tenant's existing API key (`phk_…`) presented once in a login form, which calls
    `AppStore.authenticate` and issues an `HttpOnly; SameSite=Strict` session cookie (8-hour TTL,
    `InMemoryTenantSessionStore` that stores `{appId}` — distinct from the admin session).
    **Always enabled** — no extra config flag needed, since it adds no new credential surface
    beyond the existing JSON API auth. **Security (decided, not incidental):** `appId` comes
    from the session (resolved at login), never from a URL param, so a tenant cannot forge
    another tenant's view; cross-tenant resources return `404`; cookies are `HttpOnly;
    SameSite=Strict`; a revoked key's session expires naturally (no active invalidation needed
    — the session just carries the `appId`, not re-authenticating on each request). Pages: login
    (`GET /dashboard/tenant/login`), messages list (`GET /dashboard/tenant/messages` —
    newest-first, paginated with "Older →" cursor), message detail (`GET
    /dashboard/tenant/messages/:id` — payload, per-endpoint delivery status with endpoint URL
    resolved, and full per-attempt log), endpoints list (`GET /dashboard/tenant/endpoints` —
    URL, event types, health). The `/dashboard/tenant` dispatch is checked *before* the admin
    `/dashboard` prefix in `server.ts` so the longer prefix wins and routes don't collide.
    Zero new runtime dependencies; pure HTML/CSS string builders (`tenant-views.ts`) with `esc()`
    XSS guard. Proven by 7 session-store tests + 15 handler tests (login/logout, auth guard,
    messages list, message detail with deliveries+attempts, tenant isolation, 404s), plus a
    **compiled-`dist` smoke run** (22/22 checks through production ESM: login flow, session
    cookie attrs, tenant isolation, message list + detail, endpoints, logout, unauthenticated
    redirect).
  - **Per-key `lastUsedAt` ✅ (iter 33):** `ApiKey.lastUsedAt` tracks the last successful
    authentication timestamp (null = never used). Written inside `AppStore.authenticate` on success
    (no blast radius on callers), surfaced in the admin dashboard key table ("Last used" column),
    the admin SDK `AdminApiKey` type, and the OpenAPI `ApiKey` schema. Both backends (in-memory +
    SQLite with a seamless `ALTER TABLE` migration).
  - **Attempt-log pagination ✅ (iter 35):** `GET /v1/messages/:id/attempts` is now keyset-paginated
    oldest-first on `(attemptedAt, id)` — `?limit=` (1–200, default 50) and `?cursor=` (opaque
    base64url). Same dual-backend + one-shared-conformance-suite discipline; SQLite gains a covering
    `(message_id, attempted_at, id)` index (idempotent `IF NOT EXISTS`). SDK updated:
    `listMessageAttempts(id, {limit?, cursor?}) → {data, nextCursor}`. OpenAPI `DeliveryAttemptList`
    schema now includes `nextCursor`.
  - **`endpoint.disabled` notification event ✅ (iter 36):** when an endpoint is auto-disabled,
    Posthorn POSTs a signed Standard Webhooks `endpoint.disabled` event to the app's configured
    `systemWebhookUrl`. `App` gains `systemWebhookUrl` (admin-configurable) and a stored raw
    `systemWebhookSecret` (returned once at creation, rotatable via
    `POST /v1/admin/apps/:id/rotate-system-secret`). `EndpointStore.recordDeliveryOutcome` now
    returns `{ endpoint, autoDisabled }` so the gateway detects the transition without a second
    read. `src/system-events/` signs the payload (`sws_`-prefixed secrets normalised for the
    Standard Webhooks signer) and POSTs via an injected transport — best-effort, never blocking
    delivery. Admin SDK gains `CreatedAdminApp.systemWebhookSecret` + `rotateSystemWebhookSecret`.
    Both store backends carry the new columns behind seamless `ALTER TABLE` migrations.
  - **`?eventType=` filter on `GET /v1/messages` ✅ (iter 38):** `ListMessagesOptions` gains
    `eventType?: string | null` (null/omitted = no filter). Both backends handle the filter (`WHERE
    event_type = ?` in SQLite with a new covering `idx_messages_app_event_created (app_id,
    event_type, created_at, id)` index, `IF NOT EXISTS`; in-memory one-liner filter). Cursor is
    scoped to the same event type so pagination is stable across a filtered result. HTTP layer
    parses `?eventType=`; SDK `ListMessagesParams` gains `eventType?: string | null`;
    `listMessages` appends it to the query string when set.
  - **`GET /v1/deliveries?status=` ✅ (iter 40):** app-wide delivery listing — the cross-cutting
    operational view ("show me all my `dead_letter` deliveries across all endpoints"). `DeliveryTask`
    and `EnqueueInput` gain `appId: string | null` (denormalized at write time, same pattern as
    `DeliveryAttempt.appId`); `DeliveryQueue` gains `listByApp(appId, options?)` with an optional
    `status` filter; SQLite adds `app_id` column + `#migrateAppIdColumn()` idempotent migration + two
    partial indexes (`(app_id, created_at, id)` and `(app_id, status, created_at, id)`). HTTP route
    `GET /v1/deliveries` parses `?limit=&cursor=&status=` (validates status enum → 400); response
    view reuses `endpointDeliveryView` (carries both `messageId` and `endpointId`). OpenAPI gains
    `AppDelivery`/`AppDeliveryList` schemas (drift test forced both). SDK gains `client.listDeliveries
    ({limit?,cursor?,status?})` → `AppDeliveryListPage`. One shared conformance suite (8 cases × 2
    backends = 16 new tests).
  - **`GET /v1/endpoints/:id/deliveries` ✅ (iter 39):** endpoint-centric delivery history — the
    complement to `GET /v1/messages/:id` (which shows per-message delivery status per endpoint).
    `DeliveryQueue` gains `listByEndpoint(endpointId, options?)` returning a keyset-paginated
    `DeliveryPage` (newest-first, cursor on `(createdAt, id)`). SQLite adds a partial index
    `ON delivery_tasks (endpoint_id, created_at, id) WHERE endpoint_id IS NOT NULL` (`IF NOT
    EXISTS`). One shared conformance suite (7 cases × 2 backends). The HTTP route is tenant-scoped
    (cross-tenant endpoint → 404); response view (`endpointDeliveryView`) includes `messageId`
    (unlike the message-centric view where the message is implicit); `leaseToken`/`leaseExpiresAt`
    are omitted. OpenAPI gains `EndpointDelivery` (`allOf: [Delivery, {messageId}]`) +
    `EndpointDeliveryList` schemas; SDK gains `client.listEndpointDeliveries(id, {limit?,
    cursor?})` → `EndpointDeliveryListPage`. The bidirectional drift test forced both.
  - Remaining: usage-based billing integration (Stripe; needs an external account — permanently
    ungateable in the loop). **P5 is otherwise complete.**

## 5. Out of scope / non-goals

- Not a CRM (the human already builds `salesforce-lite-crm`) and unrelated to `AC1`/`agy-sandbox`.
- v1 does not aim to *receive/ingest* third-party webhooks (Hookdeck's lane); focus is
  reliable **sending**. Ingestion is a possible later expansion.
