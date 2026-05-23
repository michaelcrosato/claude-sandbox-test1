# Posthorn

[![CI](https://github.com/michaelcrosato/claude-sandbox-test1/actions/workflows/ci.yml/badge.svg)](https://github.com/michaelcrosato/claude-sandbox-test1/actions/workflows/ci.yml)

> Open-core, [Standard Webhooks](https://www.standardwebhooks.com/)-compliant **reliable
> webhook delivery infrastructure**. Single container, **no Redis**, MIT-licensed.
>
> _Working name — see [`docs/PROJECT.md`](docs/PROJECT.md) for the full product decision._

Posthorn lets any product send **signed, retried, observable** webhooks to its own
customers, with the operational simplicity that the incumbents (Svix, Convoy) lack: it runs
as a single process backed by SQLite by default (Postgres optional), with a durable queue
built in — no separate Redis to operate.

## Status

Early foundation. Implemented so far:

- ✅ **Standard Webhooks signer / verifier** — HMAC-SHA256, `whsec_` secrets, `v1,` signature
  scheme, replay-window enforcement, key-rotation (multi-signature) support. Verified against
  the canonical Standard Webhooks test vector.
- ✅ **Delivery decision core** — a pure, deterministic retry/backoff scheduler
  (fixed or exponential, optional injectable jitter, sensible default schedule) and a delivery
  state machine (`pending → delivering → succeeded`, with policy-driven retries and automatic
  dead-lettering once retries are exhausted).
- ✅ **Message store + idempotent intake** — a storage interface (`MessageStore`) with two
  interchangeable backends. Idempotency keys collapse a producer's retried `create` onto the
  single message first accepted; reusing a key for a *different* request is rejected as a
  conflict; key bindings expire after a configurable window.
  - **In-memory** — zero-dependency reference backend, ideal for embedding and tests.
  - **SQLite** — durable, **crash-safe** backend built on Node's *built-in* `node:sqlite`
    (Node 22.5+): no native compilation, no third-party dependency. Survives restarts, so a
    producer's retry after a crash still dedups. Both backends pass one shared behavioural
    conformance suite, so they are guaranteed to behave identically.
- ✅ **Durable delivery queue** — the reliable-delivery spine. A store-backed `DeliveryQueue`
  hands due deliveries to a worker, **leases** each one (so only one attempt is in flight) with a
  visibility timeout, and — the heart of the **no-Redis** wedge — **replays in-flight work after a
  crash**: if a worker dies mid-delivery, its lease lapses and the task is reclaimed rather than
  lost. Failures reschedule through the retry policy or dead-letter once exhausted. Same two
  backends (in-memory + SQLite), same one conformance suite.
- ✅ **Delivery worker** — the runtime I/O driver that joins the pieces into a real send: it
  claims due tasks, loads each message, signs it, POSTs it over an injectable transport, and
  settles the task so the retry policy reschedules or dead-letters it. Every outside-world touch
  (clock, HTTP transport, endpoint lookup) is an injected seam, so the whole loop is fake-clock
  testable; a worker-emitted request verifies against the signer.
- ✅ **Endpoints** — the persisted, tenant-scoped subscriptions (`appId`, destination URL,
  signing secret, event-type filter, enable/disable). Same dual-backend + one-conformance-suite
  pattern; the worker resolves a task's endpoint to its URL + secret through this store.
- ✅ **Message fan-out** — the step that makes Posthorn a webhook *service*: `fanOut` lists a
  message's tenant endpoints, selects the enabled subscribers for the event type, and enqueues one
  delivery per match; `ingest` accepts a message and fans it out in one call, suppressing
  re-delivery on an idempotent (deduplicated) retry. Idempotency keys are **scoped per tenant**, so
  one app's key never dedups against — or leaks — another app's message.
- ✅ **Crash-safe fan-out (transactional outbox)** — accepting a message and recording that it
  *owes a fan-out* is one atomic step in the store (a `fanned_out_at` outbox marker, written in the
  same transaction). So a crash between "accepted" and "fanned out" can no longer strand a message:
  a producer's retry re-drives the owed fan-out, and a background **`FanoutDispatcher`** sweeps any
  message left pending (the path for fire-and-forget producers). Delivery is now guaranteed
  *at-least-once* end-to-end — closing the one window where an accepted message could have been
  delivered *zero* times.
- ✅ **Apps + API-key authentication** — the tenancy/identity layer that turns `appId` from an
  opaque string into an authenticated tenant. An `App` owns one or more API keys; presenting a key's
  secret authenticates a request as that app (`authenticate` → the owning `App`). Secrets are stored
  only as a SHA-256 hash (a fast hash is correct for a 256-bit random secret) that doubles as the
  O(1) lookup index; the plaintext is returned exactly once at creation and is never recoverable.
  Keys can be rotated and revoked; a revoked key never authenticates again. Same dual-backend +
  one-conformance-suite pattern, with the SQLite backend cascade-deleting a tenant's keys.
- ✅ **HTTP API (run it as a service)** — the layer that turns the engine into a deployable
  webhook gateway, built on Node's **built-in** `node:http` (zero runtime dependencies, same wedge
  as `node:sqlite`/`node:crypto`). Bearer-key authentication scopes every request to its tenant;
  routes cover the headline `POST /v1/messages` (accept + fan-out, `202`) and endpoint CRUD
  (`/v1/endpoints`), plus an unauthenticated `GET /healthz`. Tenancy comes from the key, never the
  request body; cross-tenant access returns `404` (existence is never revealed); an endpoint's
  signing secret is returned exactly once at creation and never echoed afterward. Routing/auth/domain
  logic is a pure, exhaustively-tested request→response function; the `node:http` socket plumbing is a
  thin adapter — the same pure-core/thin-I/O split as the delivery worker.
- ✅ **Runnable gateway** — the composition root that boots the whole thing as one process: a
  `posthorn` binary (`npm start`) reads config from the environment, opens the SQLite stores under a
  data directory (one file per store, or `:memory:`), wires the HTTP API and the delivery worker
  together, and serves — then shuts down gracefully on `SIGINT`/`SIGTERM`. No Redis, no Postgres, no
  framework. `createGateway(config)` exposes the same wiring as a library for embedding/tests.
- ✅ **Delivery-status read API** — the *observable* half of the tagline. After a producer sends a
  message it can ask `GET /v1/messages/:id` and get the message plus **one delivery record per
  subscribed endpoint** — current `status` (pending / delivering / succeeded / dead_letter), attempt
  count, next-retry time, and the last error — so "what happened to my webhook?" has an answer instead
  of a void. Backed by a new `DeliveryQueue.listByMessage`, scoped to the authenticated tenant
  (another tenant's message is `404`, never revealed), and proven end-to-end (ingest → worker delivers
  → the status flips to `succeeded`).

- ✅ **Per-attempt delivery audit log** — the *depth* behind "observable", and the single most-used
  view in every incumbent's dashboard. The status read above shows each delivery's *current* state;
  `GET /v1/messages/:id/attempts` (and `client.listMessageAttempts(id)`) shows the *history* of how it
  got there — **one record per HTTP attempt**: attempt number, outcome, the receiver's HTTP status (or
  `null` on a transport/pre-flight failure), the error, latency, and timestamp, oldest-first. This is
  the data you debug a flaky receiver from ("attempt 3: 503 in 1.2s; attempt 4: timeout"). It is an
  append-only `DeliveryAttemptStore` kept **separate from the queue** (so the scheduler's hot path
  never scans the unbounded audit table), written by the worker through a best-effort `recordAttempt`
  seam (a failed audit write never blocks a delivery), tenant-scoped (`404` for another tenant's
  message), and dual-backend (in-memory + durable SQLite, one conformance suite).

- ✅ **Message listing** — the collection half of "what have I sent?": `GET /v1/messages` returns the
  tenant's messages **newest-first**, **keyset-paginated** (`?limit=` + an opaque `?cursor=` fed back
  from each page's `nextCursor`). Keyset paging stays correct as the message log grows unbounded and is
  stable under concurrent sends — a new message lands on page one rather than shifting rows out from
  under an in-flight scan. List rows are lightweight summaries (no payload, no per-endpoint deliveries —
  fetch `GET /v1/messages/:id` for those). Backed by a new `MessageStore.listByApp` (both backends, one
  conformance suite), scoped to the authenticated tenant so a listing never reveals another tenant's
  messages.

- ✅ **First-class TypeScript/JavaScript SDK** — the typed client a producer imports instead of
  hand-rolling `fetch`: `PosthornClient` covers the whole surface (send messages, manage endpoints,
  read delivery status) with mapped errors (`PosthornApiError` carries the HTTP status + machine
  code) and a configurable per-request timeout — over the platform `fetch`, **zero dependencies**.
  It ships the matching **receiver-side** helper too: `verifyWebhook(secret, headers, rawBody)` pulls
  the Standard Webhooks headers out of a raw HTTP header bag (case-insensitive) and verifies the
  signature, so a consumer's whole integration — send and receive — is one import. For operators,
  `PosthornAdminClient` is the typed **control-plane** counterpart — provision tenants, mint/revoke
  API keys, change plan quotas, and read per-tenant usage over the admin-token-gated `/v1/admin/*`.

- ✅ **Manual retry / replay** — the operator's recovery path, and the last word in "signed,
  **retried**, observable". Automatic retries handle transient blips, but a *sustained* receiver
  outage eventually exhausts the schedule and a delivery lands in the terminal `dead_letter` state —
  previously a dead end. `POST /v1/messages/:id/retry` (and `client.retryMessage(id)`) re-drives a
  message's dead-lettered deliveries: each is reset to a fresh, immediately-deliverable `pending`
  state with its attempt budget restored, so the worker tries again under the full schedule. This is
  the "replay"/"retry" feature every incumbent exposes. It is the lone transition *out* of a terminal
  state in the delivery FSM, scoped to the authenticated tenant (another tenant's message is `404`),
  and targets only dead-lettered deliveries — succeeded/in-flight ones are left untouched.

- ✅ **Zero-downtime secret rotation** — rotating an endpoint's signing secret is the security
  operation that *breaks* naive webhook setups: swap the secret and every receiver fails verification
  until it is reconfigured in lockstep. Posthorn does it the Standard Webhooks way instead.
  `POST /v1/endpoints/:id/rotate-secret` (and `client.rotateEndpointSecret(id)`) installs a fresh
  primary secret while keeping the old one **active for an overlap window** (default 24h, tunable per
  call; `0` = instant hard swap). During the overlap every delivery is signed with **all** active
  secrets — multiple space-delimited tokens in the `webhook-signature` header, the multi-sign form the
  verifier already accepts — so a receiver still on the old secret keeps verifying while it migrates to
  the new one at its leisure; then the old secret simply expires. The new secret is revealed exactly
  once (like create); the retired secrets are never exposed over HTTP. Modeled as a pure
  `rotateEndpointSecret` helper + an `EndpointStore.rotateSecret` method (both backends, one
  conformance suite; SQLite stores them in a `previous_secrets` column added by a seamless migration),
  proven end-to-end (a delivered webhook verifies against **both** the old and the new secret).

- ✅ **Single-container image (the deployment wedge made real)** — a multi-stage `Dockerfile`
  packages the gateway as **one container, no Redis, no Postgres**, with durable state in an embedded
  SQLite volume. Because the runtime has **zero dependencies**, the image carries only a Node binary
  and the compiled `dist/` — no `node_modules` to ship or patch — and runs as an unprivileged user
  with a built-in `/healthz` `HEALTHCHECK`. The same image runs the gateway *and* the one-shot
  `posthorn admin` bootstrap. `docker build -t posthorn . && docker run -p 3000:3000 -v posthorn-data:/data posthorn`.

- ✅ **Prometheus metrics (operator observability)** — an unauthenticated `GET /metrics` serves
  the operator-facing half of "observable": instance throughput and health in the standard Prometheus
  text exposition format, scrape-ready with zero extra dependencies. Monotonic counters
  (`posthorn_messages_ingested_total`, `posthorn_deliveries_total{outcome="…"}`) come from the ingest
  route and the worker's per-tick tally; a point-in-time backlog gauge
  (`posthorn_delivery_tasks{status="…"}` — the alert you actually set: how many deliveries are stuck
  in `dead_letter` or queued right now) is read from the queue at scrape time. Exposes only
  instance-aggregate operational data — no tenant id, payload, or secret — so it is safe to scrape
  without a key; restrict it at the network layer if you want it private.

- ✅ **OpenAPI 3.1 contract** — the cross-language complement to the TS SDK: an unauthenticated
  `GET /openapi.json` serves a complete, machine-readable description of the v1 surface, so a consumer
  in *any* language can generate a typed client (`openapi-generator`, `oapi-codegen`, …) or render
  interactive docs (Swagger UI / Redoc) — no hand-written wrappers. It is **hand-authored** for rich
  per-field docs, error codes, and the security model, then held to the implementation by a
  bidirectional **drift test**: the documented operations are asserted to equal the router's single
  source of truth, so a route can never ship undocumented (or a doc entry without a route). Validated
  as a valid OpenAPI 3.1 document, with **zero runtime dependencies** (a pure builder over `node:*`).

- ✅ **Per-tenant usage metering** — the metering read model a hosted control plane bills and enforces
  quotas on. It meters **both** units this market prices on: **accepted messages** *and* **delivery
  attempts** (operations — every HTTP send, retries included, the real resource/cost unit). Both
  `GET /v1/usage` (a tenant's own) and `GET /v1/admin/apps/:id/usage` (admin-token-gated) return, over
  an inclusive `YYYY-MM-DD` UTC range broken down by day: a message `total`/`daily`, plus a
  `deliveries` block (`total`/`succeeded`/`failed` + per-day). Counts are **exact** — computed directly
  from the messages and append-only delivery-attempt logs (the sources of truth), each riding its own
  index, rather than separate rollups that could drift — and a deduplicated retry is never
  double-counted. The span is capped (≤ 366 days) so a query stays bounded.
- ✅ **Endpoint health + auto-disable** — Posthorn stops wasting deliveries on a permanently-dead
  endpoint.
- ✅ **Per-key `lastUsedAt`** — each API key now records the last time it successfully
  authenticated a request (`lastUsedAt`, epoch ms; `null` if never used). Surfaced in the admin
  dashboard's key table, the admin SDK `AdminApiKey` type, and the OpenAPI `ApiKey` schema.
  Enables the "find and revoke stale keys" security workflow at a glance.

- ✅ **Tenant dashboard UI** — a browser UI at `/dashboard/tenant` where any tenant can log in with
  their API key and browse their message history, per-endpoint delivery statuses, and the
  per-attempt audit log (the "attempt 3: 503 in 1.2s" view). Tenant-scoped by session — one
  tenant's messages, deliveries, and endpoints are never visible to another. No extra config;
  it is always available alongside the gateway. Each endpoint tracks its delivery health (`consecutiveFailures` + the `firstFailureAt`/
  `lastFailureAt` streak, all surfaced over the API/SDK); once a delivery has been *failing
  continuously* for a configurable window (`POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS`, default 5 days;
  `0` = off), the endpoint is **automatically disabled** so fan-out stops sending it new work —
  capping the retry attempts (and the tenant's metered operations) burned on a receiver that is gone.
  A single outage that recovers never trips it (sustained failure is required, and any success resets
  the streak); re-enabling (`updateEndpoint(id, { disabled: false })`) starts it clean. The verdict is
  reported by the worker through a best-effort seam and applied as one atomic, no-drift store rule
  (pure `evaluateEndpointHealth`, both backends, one conformance suite) — health writes never block or
  fail a delivery, and the success hot path takes no write.

See the roadmap in [`docs/PROJECT.md`](docs/PROJECT.md).

## Quickstart (signing module)

```ts
import { sign, verify, generateSecret } from "posthorn";

const secret = generateSecret(); // "whsec_..."
const id = "msg_2k1...";
const timestamp = Math.floor(Date.now() / 1000);
const payload = JSON.stringify({ event: "user.created", id: 42 });

// Sender side — produce the `webhook-signature` header value:
const signature = sign(secret, { id, timestamp, payload });

// Receiver side — throws WebhookVerificationError on any mismatch / replay:
verify(secret, { id, timestamp, signature }, payload);
```

## Quickstart (delivery core)

The delivery core decides *what happens* as attempts resolve; your worker owns the HTTP call.

```ts
import {
  DEFAULT_RETRY_POLICY,
  initialDeliveryState,
  isDeliverable,
  isTerminal,
  reduce,
} from "posthorn";

let state = initialDeliveryState(); // pending, deliverable now

while (!isTerminal(state)) {
  if (!isDeliverable(state, Date.now())) break; // wait until state.nextAttemptAt
  state = reduce(DEFAULT_RETRY_POLICY, state, { type: "attemptStarted" });

  const ok = await tryDeliver(); // your HTTP POST -> true on a 2xx
  state = ok
    ? reduce(DEFAULT_RETRY_POLICY, state, { type: "attemptSucceeded" })
    : reduce(DEFAULT_RETRY_POLICY, state, {
        type: "attemptFailed",
        error: "non-2xx",
        nowMs: Date.now(),
      });
  // On failure, state is `pending` with `nextAttemptAt` set — or `dead_letter`
  // once the retry schedule is exhausted.
}
```

## Quickstart (message store)

Accept messages for delivery with built-in idempotency. A retried `create` with the same
`idempotencyKey` returns the original message instead of duplicating the send.

```ts
import { InMemoryMessageStore } from "posthorn";

const store = new InMemoryMessageStore();

const { message } = await store.create({
  appId: "app_acme", // the tenant the message belongs to
  eventType: "user.created",
  payload: JSON.stringify({ id: 42 }),
  idempotencyKey: "req_abc123", // optional
});

// A network-retried create with the same key is collapsed onto the original:
const again = await store.create({
  appId: "app_acme",
  eventType: "user.created",
  payload: JSON.stringify({ id: 42 }),
  idempotencyKey: "req_abc123",
});
again.deduplicated; // true — again.message.id === message.id (no duplicate send)
// Idempotency keys are scoped per tenant: the same key under a different appId
// is an independent message, never a cross-tenant dedup or leak.
```

For durability across restarts, swap in the SQLite backend — same interface, now
crash-safe and persisted to a file (or `:memory:`):

```ts
import { SqliteMessageStore } from "posthorn";

const store = new SqliteMessageStore({ location: "./posthorn.sqlite" });
// ...identical create / get / getByIdempotencyKey API as above...
store.close(); // release the database handle on shutdown
```

## Quickstart (delivery queue)

The durable queue schedules *what to deliver and when*, leasing each task so a worker can do the
HTTP call safely. A crashed worker's lease lapses and the task is replayed — work is never lost.

```ts
import { SqliteDeliveryQueue } from "posthorn";

const queue = new SqliteDeliveryQueue({ location: "./posthorn.sqlite" });

// Producer side: enqueue a message for delivery.
await queue.enqueue({ messageId: "msg_2k1..." });

// Worker loop: claim due work, attempt it, then report the outcome.
for (const task of await queue.claimDue({ nowMs: Date.now() })) {
  try {
    await deliverOverHttp(task.messageId); // your signed POST; throws on non-2xx
    await queue.complete(task.id, task.leaseToken!); // -> succeeded
  } catch (err) {
    // Reschedules per the retry policy, or dead-letters once retries are spent:
    await queue.fail(task.id, task.leaseToken!, {
      error: String(err),
      nowMs: Date.now(),
    });
  }
}

queue.close(); // release the database handle on shutdown
```

## Quickstart (ingest + fan-out)

The headline operation: accept a message and fan it out to every subscribed, enabled endpoint
in its tenant — one durable delivery task per match. A `DeliveryWorker` then drains the queue.

```ts
import {
  SqliteEndpointStore,
  SqliteMessageStore,
  SqliteDeliveryQueue,
  ingest,
} from "posthorn";

const endpoints = new SqliteEndpointStore({ location: "./posthorn.sqlite" });
const messages = new SqliteMessageStore({ location: "./posthorn.sqlite" });
const queue = new SqliteDeliveryQueue({ location: "./posthorn.sqlite" });

// Register where this tenant's events should go (secret auto-generated):
await endpoints.create({
  appId: "app_acme",
  url: "https://acme.example/webhooks",
  eventTypes: ["user.created"], // omit/null = subscribe to everything
});

// Accept an event and fan it out in one call:
const { message, fanout } = await ingest(
  {
    appId: "app_acme",
    eventType: "user.created",
    payload: JSON.stringify({ id: 42 }),
    idempotencyKey: "req_abc123", // optional; a retry won't double-fan-out
  },
  { messages, endpoints, queue },
);
fanout.matched; // number of endpoints a delivery was enqueued for

// ...then run a DeliveryWorker against the same queue/store/endpoints to deliver.
```

## Quickstart (apps + authentication)

Each tenant is an `App` that owns API keys. Authenticate an incoming request by its key
secret to get the owning app, then scope every other operation to `app.id`.

```ts
import { SqliteAppStore } from "posthorn";

const apps = new SqliteAppStore({ location: "./posthorn.sqlite" });

// Provision a tenant and mint its first key. The plaintext is shown ONCE —
// only its hash is stored, so save it now; it can never be retrieved again.
const app = await apps.create({ name: "Acme" });
const { secret } = await apps.createApiKey(app.id); // -> "phk_..."

// On each request, resolve the presented secret to its owning app (or null):
const caller = await apps.authenticate(secret);
if (caller === null) throw new Error("401 Unauthorized");
caller.id === app.id; // scope endpoint/message/ingest operations to this appId

// Rotate freely; revoke instantly. A revoked key never authenticates again.
const { apiKey } = await apps.createApiKey(app.id); // a second, live key
await apps.revokeApiKey(apiKey.id);

apps.close(); // release the database handle on shutdown
```

## Run it as a service (the gateway)

Build once, then start the gateway. It binds the HTTP API, starts the delivery worker, and
persists everything to SQLite files under the data directory — a single process, no Redis.

```bash
npm install && npm run build
POSTHORN_DATA_DIR=./posthorn-data POSTHORN_PORT=3000 npm start
# [posthorn] listening on http://0.0.0.0:3000 (data: ./posthorn-data)
```

### Run with Docker (the headline deployment)

The whole product is **one container, no Redis, no Postgres** — durable state lives in an
embedded SQLite file. Because Posthorn has **zero runtime dependencies** (every moving part is a
Node built-in), the image ships only a Node binary and the compiled output: no `node_modules` to
audit or patch.

For a production setup with Prometheus monitoring, see **[`docs/DEPLOY.md`](docs/DEPLOY.md)**.

```bash
docker build -t posthorn .
docker run -p 3000:3000 -v posthorn-data:/data posthorn
# [posthorn] listening on http://0.0.0.0:3000 (data: /data)
```

State persists in the `/data` volume across restarts and upgrades. Bootstrap the first
tenant + key with the same image (one-shot `admin` commands against the shared volume — see
below), then drive the API with the minted key:

```bash
docker run --rm -v posthorn-data:/data posthorn admin create-app "Acme"
docker run --rm -v posthorn-data:/data posthorn admin create-key app_xxx   # prints the secret once
```

The container binds `0.0.0.0:3000`, runs as the unprivileged `node` user, and ships a built-in
`HEALTHCHECK` against `/healthz` (so `docker ps` / orchestrators see real liveness). Override any
setting with the `POSTHORN_*` environment variables below (e.g. `-e POSTHORN_PORT=8080`). When
bind-mounting a host directory instead of a named volume, ensure it is writable by uid `1000`.

Configuration is environment-driven (all optional). See also `.env.example` and the full reference in [`docs/DEPLOY.md`](docs/DEPLOY.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTHORN_HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` to restrict to loopback). |
| `POSTHORN_PORT` | `3000` | TCP port for the HTTP API. |
| `POSTHORN_DATA_DIR` | `./posthorn-data` | Directory for the SQLite files, or `:memory:` for an ephemeral run. |
| `POSTHORN_MAX_BODY_BYTES` | `1000000` | Request-body cap (`413` beyond it). |
| `POSTHORN_ADMIN_TOKEN` | _(unset)_ | Enables the admin API (`/v1/admin/*`) and dashboard. Must be ≥ 32 chars. |
| `POSTHORN_WORKER_BATCH_SIZE` | `16` | Deliveries claimed per worker tick. |
| `POSTHORN_WORKER_CONCURRENCY` | `8` | Max deliveries in flight at once within a tick (`1` = sequential). |
| `POSTHORN_WORKER_REQUEST_TIMEOUT_MS` | `10000` | Per-delivery HTTP timeout. |
| `POSTHORN_WORKER_IDLE_POLL_MS` | `1000` | Worker poll interval when idle. |
| `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS` | `30000` | Lease lifetime before an in-flight delivery is reclaimed. |
| `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` | `432000000` | Auto-disable a failing endpoint after this many ms (default 5 days). `0` = off. |

### Bootstrap the first tenant + API key

Every API route requires a Bearer key, but minting that first key has **no HTTP route** — there is
no key yet to authenticate the call that creates it, and an open provisioning endpoint is a door we
refuse to build. Provisioning lives behind the right boundary instead: **the shell on the host that
owns the data directory.** The `posthorn admin` command operates directly on the same SQLite store
the server reads (WAL-safe to run against a live gateway):

```bash
# 1. Create a tenant (app):
posthorn admin create-app "Acme"
#   Created app app_xxx ...

# 2. Mint its API key — the secret is printed ONCE and is not recoverable:
posthorn admin create-key app_xxx
#   secret: phk_...            ← save this; use it as: Authorization: Bearer <secret>
```

`POSTHORN_DATA_DIR` selects the same store the server uses. Other subcommands: `list-apps`,
`list-keys <appId>`, `revoke-key <keyId>` (a revoked key stops authenticating immediately, even on a
running server). Run `posthorn admin help` for the full list.

Embedding Posthorn as a library? Provision programmatically against the gateway's `AppStore`
instead — `createGateway(loadConfig(process.env))`, then `gateway.apps.create(...)` /
`gateway.apps.createApiKey(...)` (the same operations the CLI drives).

Your customers then drive the API with that key:

```bash
# Register a destination (the response includes the signing secret — once):
curl -sX POST localhost:3000/v1/endpoints \
  -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"url":"https://acme.example/hook","eventTypes":["user.created"]}'

# Send an event — it is accepted (202) and fanned out to every subscribed endpoint:
curl -sX POST localhost:3000/v1/messages \
  -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"eventType":"user.created","payload":{"id":42}}'

# Then check what happened to it — its per-endpoint delivery status:
curl -s localhost:3000/v1/messages/$MESSAGE_ID -H "authorization: Bearer $SECRET"
#   { "id": "...", "deliveries": [ { "endpointId": "...", "status": "succeeded", "attempts": 1, ... } ] }

# If a delivery dead-lettered (receiver was down), fix the receiver and replay it:
curl -sX POST localhost:3000/v1/messages/$MESSAGE_ID/retry -H "authorization: Bearer $SECRET"
#   { "id": "...", "retried": 1, "deliveries": [ { "endpointId": "...", "status": "pending", "attempts": 0, ... } ] }

# Browse what you've sent — newest-first, paginated. Feed nextCursor back as ?cursor= for the next page:
curl -s "localhost:3000/v1/messages?limit=50" -H "authorization: Bearer $SECRET"
#   { "data": [ { "id": "...", "eventType": "user.created", "createdAt": 169... } ], "nextCursor": "..." }

# Scrape operational metrics (Prometheus text exposition; no auth — instance-aggregate only):
curl -s localhost:3000/metrics
#   posthorn_messages_ingested_total 12
#   posthorn_deliveries_total{outcome="succeeded"} 11
#   posthorn_delivery_tasks{status="dead_letter"} 1   ← the gauge to alert on

# Fetch the machine-readable API contract — generate a client for any language, or render docs:
curl -s localhost:3000/openapi.json | jq .openapi   # "3.1.0"
```

| Method | Path                | Auth   | Purpose                                |
| ------ | ------------------- | ------ | -------------------------------------- |
| GET    | `/healthz`          | none   | Liveness probe.                        |
| GET    | `/metrics`          | none   | Prometheus exposition (operator metrics).|
| GET    | `/openapi.json`     | none   | OpenAPI 3.1 contract (client codegen + docs).|
| POST   | `/v1/messages`      | Bearer | Accept an event and fan it out (`202`).|
| GET    | `/v1/messages`      | Bearer | List the tenant's messages (paginated).|
| GET    | `/v1/messages/:id`  | Bearer | Read a message + its delivery statuses.|
| POST   | `/v1/messages/:id/retry` | Bearer | Replay a message's dead-lettered deliveries.|
| GET    | `/v1/endpoints`     | Bearer | List the tenant's endpoints.           |
| POST   | `/v1/endpoints`     | Bearer | Create an endpoint (`201`, secret once).|
| GET    | `/v1/endpoints/:id` | Bearer | Fetch one endpoint.                    |
| PATCH  | `/v1/endpoints/:id` | Bearer | Update an endpoint.                    |
| DELETE | `/v1/endpoints/:id` | Bearer | Delete an endpoint (`204`).            |
| POST   | `/v1/endpoints/:id/rotate-secret` | Bearer | Rotate the signing secret, zero-downtime (new secret once).|

## Quickstart (TypeScript SDK)

The typed alternative to the `curl` calls above. Construct one `PosthornClient` with your gateway
URL + API key, then send, manage endpoints, and read delivery status — no `fetch` plumbing, no
hand-built headers. Errors arrive as `PosthornApiError` (with the HTTP `status` and machine `code`).

```ts
import { PosthornClient, PosthornApiError } from "posthorn";

const client = new PosthornClient({
  baseUrl: "https://posthorn.acme.example",
  apiKey: process.env.POSTHORN_API_KEY!, // a "phk_..." key from `posthorn admin create-key`
});

// Register a destination. The signing `secret` is returned ONCE — store it now.
const endpoint = await client.createEndpoint({
  url: "https://acme.example/hook",
  eventTypes: ["user.created"], // omit/null = all events
});

// Send an event (accepted + fanned out):
const { message, fanout } = await client.sendMessage({
  eventType: "user.created",
  payload: { id: 42 },          // any JSON value
  idempotencyKey: "req_abc123", // optional; a retry won't double-send
});
fanout?.matched; // endpoints a delivery was enqueued for

// Ask what happened to it — per-endpoint delivery status:
const status = await client.getMessage(message.id);
status.deliveries[0]?.status; // "pending" | "delivering" | "succeeded" | "dead_letter"

// Receiver was down and a delivery dead-lettered? Fix it, then replay:
const replay = await client.retryMessage(message.id);
replay.retried; // how many dead-lettered deliveries were re-driven (now "pending")

// Rotate the signing secret with zero downtime — the OLD secret keeps verifying
// for the overlap window, so receivers migrate at their own pace, no dropped webhooks:
const rotated = await client.rotateEndpointSecret(endpoint.id); // default 24h overlap
rotated.secret; // the NEW secret, revealed once — configure your receivers with it

// Browse what you've sent, newest-first. Page forward with the returned cursor:
let page = await client.listMessages({ limit: 50 });
page.data; // MessageRef[] (lightweight summaries — no payload/deliveries)
while (page.nextCursor !== null) {
  page = await client.listMessages({ limit: 50, cursor: page.nextCursor });
}

try {
  await client.getMessage("msg_does_not_exist");
} catch (err) {
  if (err instanceof PosthornApiError) err.status; // 404
}
```

On the **receiving** end, verify each delivered webhook against the raw body — the SDK pulls the
Standard Webhooks headers for you (verify the bytes as received, before any JSON re-serialize):

```ts
import { verifyWebhook } from "posthorn";

// inside your webhook receiver, with the raw body string in hand:
try {
  verifyWebhook(endpointSecret, req.headers, rawBody);
  // authentic — handle the event
} catch {
  // reject: missing header, replayed timestamp, or bad signature
}
```

### Operators: the admin / control-plane SDK

Running Posthorn as a service (or building a dashboard)? `PosthornAdminClient` is the typed client
for the admin API. It authenticates with the operator **admin token** (`POSTHORN_ADMIN_TOKEN`) — a
credential distinct from any tenant key — and provisions tenants and keys over HTTP. The admin API is
**disabled by default**: until `POSTHORN_ADMIN_TOKEN` is set, every `/v1/admin/*` route (and so every
call below) returns `404`.

```ts
import { PosthornAdminClient } from "posthorn";

const admin = new PosthornAdminClient({
  baseUrl: "https://posthorn.acme.example",
  adminToken: process.env.POSTHORN_ADMIN_TOKEN!,
});

// Provision a tenant on a capped plan, then mint its first key:
const app = await admin.createApp({ name: "Acme", monthlyMessageQuota: 100_000 });
const { secret } = await admin.createApiKey(app.id); // hand `secret` to the tenant — shown ONCE

// Change the plan later (null removes the limit); meter usage for billing:
await admin.updateApp(app.id, { monthlyMessageQuota: 500_000 });
const usage = await admin.getAppUsage(app.id, { from: "2026-05-01", to: "2026-05-31" });
usage.total;              // messages accepted in the (inclusive, required) UTC-day range
usage.deliveries.total;   // delivery attempts (operations) made — succeeded + failed

// Off-board: revoke a key, or delete the tenant (cascades its keys):
await admin.revokeApiKey(/* keyId */ "ak_…");
await admin.deleteApp(app.id);
```

## Development

```bash
npm install
npm test         # vitest
npm run typecheck
npm run build
```

## License

MIT © Michael Crosato
