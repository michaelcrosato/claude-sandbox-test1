# Posthorn

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

## Quickstart (run it as a service)

Compose the stores behind the built-in HTTP server and you have a deployable webhook gateway —
no framework, no extra dependencies. Provision a tenant + key out-of-band (the privileged
bootstrap stays on the `AppStore`, not an open HTTP route), then your customers drive the API
with that key.

```ts
import {
  SqliteAppStore,
  SqliteEndpointStore,
  SqliteMessageStore,
  SqliteDeliveryQueue,
  createHttpServer,
} from "posthorn";

const apps = new SqliteAppStore({ location: "./posthorn.sqlite" });
const endpoints = new SqliteEndpointStore({ location: "./posthorn.sqlite" });
const messages = new SqliteMessageStore({ location: "./posthorn.sqlite" });
const queue = new SqliteDeliveryQueue({ location: "./posthorn.sqlite" });

// One-time: mint a tenant and its API key (save the plaintext — shown once).
const app = await apps.create({ name: "Acme" });
const { secret } = await apps.createApiKey(app.id);

createHttpServer({ apps, endpoints, messages, queue }).listen(3000);
// (Run a DeliveryWorker against the same queue/store/endpoints to drain deliveries.)
```

```bash
# Register a destination (the response includes the signing secret — once):
curl -sX POST localhost:3000/v1/endpoints \
  -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"url":"https://acme.example/hook","eventTypes":["user.created"]}'

# Send an event — it is accepted (202) and fanned out to every subscribed endpoint:
curl -sX POST localhost:3000/v1/messages \
  -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"eventType":"user.created","payload":{"id":42}}'
```

| Method | Path                | Auth   | Purpose                                |
| ------ | ------------------- | ------ | -------------------------------------- |
| GET    | `/healthz`          | none   | Liveness probe.                        |
| POST   | `/v1/messages`      | Bearer | Accept an event and fan it out (`202`).|
| GET    | `/v1/endpoints`     | Bearer | List the tenant's endpoints.           |
| POST   | `/v1/endpoints`     | Bearer | Create an endpoint (`201`, secret once).|
| GET    | `/v1/endpoints/:id` | Bearer | Fetch one endpoint.                    |
| PATCH  | `/v1/endpoints/:id` | Bearer | Update an endpoint.                    |
| DELETE | `/v1/endpoints/:id` | Bearer | Delete an endpoint (`204`).            |

## Development

```bash
npm install
npm test         # vitest
npm run typecheck
npm run build
```

## License

MIT © Michael Crosato
