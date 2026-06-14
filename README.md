# Posthorn

[![CI](https://github.com/michaelcrosato/claude-sandbox-test1/actions/workflows/ci.yml/badge.svg)](https://github.com/michaelcrosato/claude-sandbox-test1/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Standard Webhooks](https://img.shields.io/badge/Standard%20Webhooks-compliant-brightgreen)](https://www.standardwebhooks.com/)

> **Reliable outbound webhook delivery in a single container — no Redis, no Postgres, MIT-licensed.**

Posthorn sends signed, retried, observable webhooks to your customers' endpoints. It is one
Node process backed by embedded SQLite, with a durable leased queue built in and **zero runtime
dependencies** (`node:sqlite`, `node:crypto`, `node:http` only). It is the operationally simple
alternative to Svix/Convoy for teams that don't want to run a broker.

---

## What Posthorn does

You give it an event; it fans that event out to every endpoint registered for it, signs each
delivery with [Standard Webhooks](https://www.standardwebhooks.com/) HMAC-SHA256, retries with
exponential backoff until it succeeds or exhausts its budget, dead-letters failures, and records
a per-attempt audit log you can debug from. It meters usage per tenant and enforces monthly
quotas.

**Implemented and tested today:**

- **Multi-tenant control plane** — provision apps (tenants), mint/revoke API keys, set quotas.
- **Endpoints** — CRUD with an SSRF denylist, per-endpoint rate limiting, delivery method
  (`POST`/`PUT`), and payload format (delivery envelope, payload-only, or CloudEvents 1.0).
- **Message intake** — single and batch (≤100), idempotency keys, deduplication windows, fanout.
- **Crash-safe delivery worker** — leased SQLite-backed claim (`BEGIN IMMEDIATE`), exponential
  backoff, attempt budget → dead-letter, lease reclaim, endpoint auto-disable.
- **Standard Webhooks signing** — `whsec_` secrets, HMAC-SHA256, replay-window enforcement,
  zero-downtime multi-secret rotation.
- **Observability** — per-attempt audit log, endpoint stats, app-wide delivery listing, usage +
  quota, Prometheus `/metrics`, an OpenAPI 3.1 contract, and static browser dashboards.
- **Clients** — a TypeScript SDK + CLI, and a (partial) standard-library-only Python SDK.

**Non-goals:** a general event bus, an inbound webhook router, a CRM/workflow engine, or any
external-broker dependency in the core path.

> **Honest status.** The service, queue, crypto, SDK/CLI, and test suite are real and
> behavior-tested (~9,500 lines of tests, ~88% load-bearing). Known gaps, in priority order:
> the at-rest encryption key is currently stored in the same SQLite file it protects (see
> [Security](#security)); the Python SDK mirrors only part of the TypeScript SDK and has no admin
> client; horizontal scale-out (Postgres) is not built — this is a single-pod SQLite system. See
> **[docs/ENGINEERING_REVIEW.md](docs/ENGINEERING_REVIEW.md)** for the full, candid assessment and
> **[roadmap/ROADMAP.md](roadmap/ROADMAP.md)** for what's next.

---

## Quick start (Docker)

```bash
# 1. Build and run
docker build -t posthorn .
export POSTHORN_ADMIN_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
docker run -d --name posthorn -p 127.0.0.1:3000:3000 -v posthorn-data:/data \
  -e POSTHORN_DATA_DIR=/data \
  -e POSTHORN_ADMIN_TOKEN="$POSTHORN_ADMIN_TOKEN" \
  posthorn

# 2. Confirm health, then bootstrap a tenant (one-time)
curl -fsS localhost:3000/healthz
APP_ID=$(curl -fsS localhost:3000/v1/admin/apps \
  -H "Authorization: Bearer $POSTHORN_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Acme"}' | node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(0,'utf8')).app.id)")
POSTHORN_API_KEY=$(curl -fsS "localhost:3000/v1/admin/apps/$APP_ID/keys" \
  -H "Authorization: Bearer $POSTHORN_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{}' | node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(0,'utf8')).secret)")
curl -fsS localhost:3000/v1/endpoints \
  -H "Authorization: Bearer $POSTHORN_API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/webhooks/posthorn","eventTypes":["user.created"]}'

# 3. Send your first webhook
curl -sX POST localhost:3000/v1/messages \
  -H "Authorization: Bearer $POSTHORN_API_KEY" -H "Content-Type: application/json" \
  -d '{"eventType":"user.created","payload":{"id":42}}'
# -> 202 Accepted; the worker signs and POSTs it to your registered endpoint
```

For production Compose/Helm/Prometheus, see **[docs/DEPLOY.md](docs/DEPLOY.md)**.

---

## Architecture

```
                    HTTP (node:http)                 leased claim
  clients ─────────▶ gateway.ts ──────▶ SQLite ◀────── worker.ts ──HMAC──▶ your endpoints
  (SDK/CLI/curl)     route + authz      (storage.ts)   backoff/retry        (signed POST/PUT)
                          │                  ▲              │
                          └── admin/tenant ──┘              └── dead-letter, auto-disable
                              auth (auth.ts)                    per-attempt audit log
```

One process, three moving parts:

- **`src/gateway.ts`** — a real `node:http` server. Hand-rolled route dispatch, per-route auth
  (tenant Bearer key or admin token), streamed body with a size cap (413), JSON-error handling.
- **`src/storage.ts`** — a single SQLite database (schema + idempotent column migrations). Sane
  indexes for the delivery-claim hot path. `node:sqlite`, no ORM.
- **`src/worker.ts`** — the delivery engine. Atomic `BEGIN IMMEDIATE` lease/claim, exponential
  backoff, attempt budget, dead-lettering, lease reclaim, per-endpoint rate limiting, endpoint
  auto-disable. Correct single-writer pattern for embedded SQLite.

Supporting modules: `auth.ts`, `secret-protection.ts` (AES-256-GCM at rest), `webhooks.ts`
(HMAC-SHA256 signing/verification), `endpoints.ts` (+ SSRF guard), `messages.ts`, `deliveries.ts`,
`usage.ts`, `metrics.ts`, `openapi.ts`, `dashboard.ts`. Clients: `client.ts` + `cli.ts` (TS),
`clients/python/` (Python). Charts in `charts/posthorn/`.

This is a **single-pod SQLite** system. There is one writer and one data volume — it does not
horizontally scale. The Helm chart is a single-replica reference; Postgres-backed scale-out is
future work (see roadmap).

---

## Stack

- **Runtime:** Node ≥ 22.13, TypeScript. **No runtime dependencies** — `package.json`
  `dependencies` is empty; everything is `node:*` built-ins.
- **Storage:** embedded SQLite via `node:sqlite`.
- **Crypto:** `node:crypto` — AES-256-GCM (secrets at rest), HMAC-SHA256 (webhook signing),
  `timingSafeEqual` for all secret comparisons.
- **Tests:** Vitest (real in-process gateway over real sockets, real `:memory:` SQLite).
- **Lint/format:** Biome. **Build:** `tsc`.
- **Deploy:** multi-stage Dockerfile (non-root, healthcheck), Docker Compose (+ Prometheus),
  Helm chart (non-root, read-only rootfs, dropped caps, PVC).
- **Clients:** TypeScript SDK/CLI; std-lib-only Python SDK (partial — tenant subset, no admin).

---

## Run & develop

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run lint          # biome
npm test              # vitest run
npm run build         # tsc -> dist/
npm start             # node dist/src/server.js
bash scripts/verify.sh   # THE gate: typecheck + lint + tests + state + shield
```

Run from source without building: `npx ts-node src/server.ts` (or the compiled
`node dist/src/server.js` after `npm run build`).

### Embedding in a Node app

There is no separate gateway needed — start the whole service in-process via the exported
`startPosthornServer`:

```ts
import { startPosthornServer, loadConfig } from "posthorn";

const server = await startPosthornServer(
  loadConfig({ POSTHORN_DATA_DIR: "./posthorn-data", POSTHORN_PORT: "3000" }),
);
console.log(`listening on ${server.address.url}`);

// graceful shutdown
process.on("SIGINT", () => server.stop());
```

To provision or operate **without** the HTTP layer, import the functional API directly and pass
it an open `storage` handle (this is what the gateway and CLI call under the hood):

```ts
import { openStorage, createAdminApp, createAdminApiKey, acceptMessage } from "posthorn";

const storage = openStorage({ dataDir: "./posthorn-data" });
const { app } = createAdminApp(storage, { name: "Acme" });
const { secret } = createAdminApiKey(storage, app.id, {})!;  // phk_... shown once
acceptMessage(storage, app.id, { eventType: "user.created", payload: { id: 42 } });
```

(These are synchronous functions that take an open `storage` handle as their first argument
— exactly what the gateway and CLI call internally.)

> Note: the public surface is the **functional API** exported from `posthorn` (see `src/index.ts`),
> not store objects hung off the gateway. The `Gateway` object exposes only
> `{ serviceName, config, start, stop }`.

---

## Configuration

All settings are environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTHORN_HOST` | `0.0.0.0` | Interface to bind. Set `127.0.0.1` to restrict to loopback. |
| `POSTHORN_PORT` | `3000` | HTTP port. |
| `POSTHORN_DATA_DIR` | `./posthorn-data` | SQLite directory, or `:memory:` for ephemeral. |
| `POSTHORN_MAX_BODY_BYTES` | `1000000` | Request-body cap (`413` beyond it). |
| `POSTHORN_ADMIN_TOKEN` | _(unset)_ | Enables the admin API + dashboard. Min 16 chars; use a long random value. |
| `POSTHORN_WORKER_BATCH_SIZE` | `16` | Deliveries claimed per tick. |
| `POSTHORN_WORKER_CONCURRENCY` | `8` | Max deliveries in flight per tick. |
| `POSTHORN_WORKER_REQUEST_TIMEOUT_MS` | `10000` | Per-delivery HTTP timeout. |
| `POSTHORN_WORKER_IDLE_POLL_MS` | `1000` | Worker poll interval when idle. |
| `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS` | `30000` | Lease lifetime before reclaim. |
| `POSTHORN_WORKER_ATTEMPT_BUDGET` | `8` | Failed attempts before dead-lettering. |
| `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` | `432000000` | Auto-disable window (5 days). `0` = off. |

> The default bind is `0.0.0.0`. The provided Compose and Helm manifests bind loopback /
> ClusterIP and require an admin token; if you run a bare `docker run`/`node` on an exposed host,
> set `POSTHORN_HOST=127.0.0.1` or front it with a proxy.

---

## API & clients

The full route table, error-code envelope, TypeScript SDK, CLI, Python SDK, admin SDK, and the
receiving-side `verifyWebhook` helper are documented inline in the source and pinned by tests
(`tests/openapi-contract.test.ts` holds the OpenAPI doc to the real router; `GET /openapi.json`
serves the machine-readable 3.1 contract for codegen). Key surfaces:

- **Admin routes** are **disabled by default** — they `404` unless `POSTHORN_ADMIN_TOKEN` is set.
- **Errors** use one envelope, `{ "error": { "code": "...", "message": "..." } }`, with a closed,
  enumerated set of `code` values (pinned to the spec by a build-time test).
- **Receiving webhooks:** verify against the raw body before parsing —
  `verifyWebhook(secret, headers, rawBody)` (TS) / `verify_webhook(...)` (Python).
- **Python SDK** covers a tenant subset only (no admin client, no endpoint update/delete/rotate/
  test, no event-type methods). Use the TypeScript SDK for the full surface.

---

## Security

- AES-256-GCM for signing secrets at rest; HMAC-SHA256 webhook signing; `timingSafeEqual` /
  `hmac.compare_digest` for every secret comparison; CSPRNG for all keys/tokens/nonces;
  parameterized SQL throughout; SSRF denylist on endpoint URLs (`redirect: 'manual'` on delivery);
  per-tenant scoping on every read.
- **Known limitation:** the AES master key is currently stored in the same SQLite file as the
  ciphertext (`local_secret_keys` table). At-rest encryption therefore does **not** protect
  against an attacker who obtains the database file — only against partial logical reads. Moving
  the key to env/KMS is the top roadmap item. There is also a residual SSRF DNS-rebinding gap (the
  hostname is validated at config time, not re-resolved at delivery time).

See **[docs/ENGINEERING_REVIEW.md](docs/ENGINEERING_REVIEW.md) → Security** for detail.

---

## Project docs & automation

This repo is built by an autonomous AI operations engine; humans plan and do final QA.

- **[docs/ENGINEERING_REVIEW.md](docs/ENGINEERING_REVIEW.md)** — candid top-to-bottom review (start here).
- **[roadmap/ROADMAP.md](roadmap/ROADMAP.md)** — human-owned priorities, plain English.
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — production Docker/Compose/Helm + Prometheus.
- **[docs/PARITY.md](docs/PARITY.md)** — feature matrix vs Svix/Convoy/Hookdeck/Stripe.
- **[AGENTS.md](AGENTS.md)** → **[CLAUDE.md](CLAUDE.md)** — agent operating rules.
- **[roadmap/features.json](roadmap/features.json)** — machine backlog (edit only via
  `npx ts-node scripts/update-state.ts`).

## License

MIT © Michael Crosato
