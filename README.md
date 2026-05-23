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
  eventType: "user.created",
  payload: JSON.stringify({ id: 42 }),
  idempotencyKey: "req_abc123", // optional
});

// A network-retried create with the same key is collapsed onto the original:
const again = await store.create({
  eventType: "user.created",
  payload: JSON.stringify({ id: 42 }),
  idempotencyKey: "req_abc123",
});
again.deduplicated; // true — again.message.id === message.id (no duplicate send)
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

## Development

```bash
npm install
npm test         # vitest
npm run typecheck
npm run build
```

## License

MIT © Michael Crosato
