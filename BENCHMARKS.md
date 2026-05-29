# Benchmarks

Posthorn ships a throughput benchmark that boots a **real gateway** (running delivery
worker, in-memory store) and a loopback receiver in one process, then measures two rates
over a single bounded run:

| Phase | What it counts | What it stresses |
| --- | --- | --- |
| **ingest** | accepted `POST /v1/messages` (the `202` path) | request parsing, validation, idempotency check, persist, fan-out enqueue |
| **delivery** | signed webhooks the worker actually POSTs to the receiver, end-to-end | queue drain, Standard Webhooks signing, the HTTP delivery client, attempt recording |

`delivery` is measured **end-to-end** — from the first ingest to the last webhook the
receiver sees — so it includes time the worker spends draining the queue *while* ingest is
still running (the two phases overlap; the worker starts delivering immediately).

## Running it

```bash
npm run build          # the CLI runs the compiled dist harness
npm run bench          # default: 2,000 messages
node bench/throughput.mjs 5000   # or pass a message count
```

Tunables (environment variables, all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_MESSAGES` | `2000` | messages to ingest (each fans out to the one endpoint) |
| `BENCH_PAYLOAD_BYTES` | `256` | approximate JSON payload size per message |
| `BENCH_INGEST_CONCURRENCY` | `50` | in-flight `POST /v1/messages` during ingest |
| `BENCH_WORKER_CONCURRENCY` | `16` | delivery-worker concurrency (`POSTHORN_WORKER_CONCURRENCY`) |
| `BENCH_WORKER_BATCH_SIZE` | `64` | delivery-worker claim batch (`POSTHORN_WORKER_BATCH_SIZE`) |
| `BENCH_SETTLE_TIMEOUT_MS` | `60000` | fail loudly if delivery hasn't settled in this budget |

## What this measures — and what it does not

This is a **pipeline** benchmark on loopback, **not** a network or disk benchmark. It
characterizes Posthorn's own per-message overhead, isolated from the things a production
deployment is actually bottlenecked on:

- **No network.** The receiver is in the same process on `127.0.0.1`; there is no real
  round-trip latency, TLS, or bandwidth limit. A real receiver's response time dominates
  delivery throughput in production.
- **In-memory store (`:memory:`).** No disk `fsync`. A file-backed SQLite or a Postgres
  backend trades some of this throughput for durability; measure your own backend.
- **Success path only.** The receiver `200`s everything, so every message is delivered in
  exactly one attempt — no retries, backoff, or dead-lettering.
- **Single process, shared CPU.** Ingest client, gateway, worker, and receiver all share
  the same event loop and cores, so they compete for CPU rather than running on separate
  machines as they would in production.

Treat the numbers as a **relative** signal — useful for catching a regression between
commits or comparing payload sizes and worker settings — not as a capacity SLA.

## Sample results

Illustrative only, from one developer machine — **your numbers will differ.** Captured on
Node v24.15.0, Windows 11 (x64), Intel Core i7-14700F, with the default `:memory:` backend.

| Run | Messages | Payload | Ingest (msg/s) | Delivery (ops/s) |
| --- | --- | --- | --- | --- |
| default | 2,000 | ~256 B | ~2,300 | ~1,740 |
| larger | 5,000 | ~256 B | ~2,320 | ~1,660 |
| bigger payload | 2,000 | ~1 KB | ~2,090 | ~1,590 |

## In the gate

`src/bench/throughput.test.ts` runs a small bounded version (25 messages, a generous
settle budget) and asserts the run **completes** and reports finite, positive rates — every
message accepted and every webhook delivered. It deliberately asserts *correctness, not
speed*: no absolute-throughput threshold is checked, so the test stays green and non-flaky
across machines and CI while still exercising the full pipeline on every run.
