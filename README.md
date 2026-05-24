# Posthorn

[![CI](https://github.com/michaelcrosato/claude-sandbox-test1/actions/workflows/ci.yml/badge.svg)](https://github.com/michaelcrosato/claude-sandbox-test1/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Standard Webhooks](https://img.shields.io/badge/Standard%20Webhooks-compliant-brightgreen)](https://www.standardwebhooks.com/)

> Reliable webhook delivery for SaaS teams. **Single container, no Redis**, MIT-licensed.

Posthorn handles the hard parts of sending webhooks to your customers — signed, retried, and
observable — with the operational simplicity that Svix and Convoy lack: a single process backed
by SQLite by default, durable queue built in, zero runtime dependencies.

## Quick Start

```bash
# 1. Build and run
docker build -t posthorn .
docker run -d --name posthorn -p 3000:3000 -v posthorn-data:/data \
  -e POSTHORN_ADMIN_TOKEN=your-secret-admin-token \
  posthorn

# 2. Bootstrap a tenant (one-time)
docker run --rm -v posthorn-data:/data posthorn admin create-app "Acme"
#  Created app app_xxx (name: Acme)
docker run --rm -v posthorn-data:/data posthorn admin create-key app_xxx
#  secret: phk_...  ← save this; shown once

# 3. Send your first webhook
curl -sX POST localhost:3000/v1/messages \
  -H "Authorization: Bearer phk_..." \
  -H "Content-Type: application/json" \
  -d '{"eventType":"user.created","payload":{"id":42}}'
# -> 202 Accepted; the delivery worker signs and POSTs it to your registered endpoint
```

For production deployment with Prometheus monitoring and Docker Compose, see
**[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Why Posthorn

|  | Svix | Convoy | **Posthorn** |
| --- | --- | --- | --- |
| License | source-available | MIT | **MIT** |
| Self-host deps | Postgres + Redis | Postgres + Redis | **none (SQLite built-in)** |
| Library mode | partial | no | **yes — embed in any Node app** |
| Standard Webhooks | yes | partial | **yes, first-class** |
| Entry price | $0 → $490/mo | $99/mo | **$0, generous free tier** |

Key capabilities:

- **[Standard Webhooks](https://www.standardwebhooks.com/) signing** — `whsec_` secrets,
  HMAC-SHA256, replay-window enforcement, multi-token rotation support
- **Crash-safe retries** — exponential backoff, 8 attempts over ~28h; at-least-once delivery
  guaranteed via a leased, store-backed queue (no Redis)
- **Idempotent intake** — a producer's retried send deduplicates on the original, never
  double-fans-out
- **Zero-downtime secret rotation** — old + new secrets both verify during a configurable
  overlap window (default 24h), so receivers migrate at their own pace
- **Auto-disable dead endpoints** — a persistently-failing endpoint is automatically taken
  out of rotation after a configurable window, capping wasted retries and billed operations
- **Per-attempt audit log** — "attempt 3: HTTP 503 after 1.2s" — the data you actually
  debug a flaky receiver from
- **Usage metering + quota enforcement** — accepted messages and delivery operations (retries)
  metered per tenant; monthly caps with `429` on breach and auto-reset at month boundaries
- **Zero runtime dependencies** — `node:sqlite`, `node:crypto`, `node:http` — nothing to
  install, patch, or audit at runtime

## API Routes

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | `/healthz` | none | Liveness probe. |
| GET | `/metrics` | none | Prometheus text exposition (operator metrics). |
| GET | `/openapi.json` | none | OpenAPI 3.1 contract (client codegen + interactive docs). |
| POST | `/v1/messages` | Bearer | Accept an event and fan it out (`202`). |
| GET | `/v1/messages` | Bearer | List messages, newest-first (keyset-paginated). |
| GET | `/v1/messages/:id` | Bearer | Read a message + per-endpoint delivery statuses. |
| POST | `/v1/messages/:id/retry` | Bearer | Replay a message's dead-lettered deliveries. |
| GET | `/v1/messages/:id/attempts` | Bearer | Per-attempt audit log (paginated). |
| GET | `/v1/endpoints` | Bearer | List endpoints. |
| POST | `/v1/endpoints` | Bearer | Create an endpoint (`201`; signing secret shown once). |
| GET | `/v1/endpoints/:id` | Bearer | Fetch one endpoint. |
| PATCH | `/v1/endpoints/:id` | Bearer | Update an endpoint. |
| DELETE | `/v1/endpoints/:id` | Bearer | Delete an endpoint (`204`). |
| POST | `/v1/endpoints/:id/rotate-secret` | Bearer | Rotate signing secret, zero-downtime. |
| GET | `/v1/usage` | Bearer | Tenant's own message + delivery usage. |
| POST | `/v1/admin/apps` | Admin | Create a tenant. |
| GET | `/v1/admin/apps` | Admin | List tenants. |
| GET/PATCH/DELETE | `/v1/admin/apps/:id` | Admin | Read / update / delete a tenant. |
| GET | `/v1/admin/apps/:id/usage` | Admin | Per-tenant usage (billing read model). |
| POST/GET | `/v1/admin/apps/:id/keys` | Admin | Mint / list API keys. |
| DELETE | `/v1/admin/keys/:id` | Admin | Revoke an API key. |

The admin routes are **disabled by default** — they 404 unless `POSTHORN_ADMIN_TOKEN` is set.
`GET /openapi.json` serves a machine-readable OpenAPI 3.1 document; use it with
`openapi-generator`, `oapi-codegen`, or Redoc to generate a typed client for any language.

## TypeScript SDK

```ts
import { PosthornClient, PosthornApiError } from "posthorn";

const client = new PosthornClient({
  baseUrl: "https://posthorn.acme.example",
  apiKey: process.env.POSTHORN_API_KEY!, // a "phk_..." key from `posthorn admin create-key`
});

// Register a destination — signing secret returned once:
const endpoint = await client.createEndpoint({
  url: "https://acme.example/hook",
  eventTypes: ["user.created"], // omit / null = all events
});

// Send an event:
const { message, fanout } = await client.sendMessage({
  eventType: "user.created",
  payload: { id: 42 },
  idempotencyKey: "req_abc123", // optional; a retry won't double-send
});
fanout?.matched; // number of endpoints a delivery was enqueued for

// Check delivery status:
const status = await client.getMessage(message.id);
status.deliveries[0]?.status; // "pending" | "delivering" | "succeeded" | "dead_letter"

// Replay dead-lettered deliveries after fixing the receiver:
const replay = await client.retryMessage(message.id);
replay.retried; // deliveries reset to pending with a fresh attempt budget

// Rotate a signing secret — old secret keeps verifying during the overlap window:
const rotated = await client.rotateEndpointSecret(endpoint.id); // default 24h overlap
rotated.secret; // new primary — configure your receivers with it

// Page through sent messages:
let page = await client.listMessages({ limit: 50 });
while (page.nextCursor !== null) {
  page = await client.listMessages({ limit: 50, cursor: page.nextCursor });
}

// Per-attempt audit log:
const { data } = await client.listMessageAttempts(message.id);
data[0]; // { attemptNumber, outcome, responseStatus, durationMs, attemptedAt, ... }

// Usage and quota for the current month:
const usage = await client.getUsage();
usage.quota.remaining; // messages left in this billing period (null = unlimited)
```

### Receiving webhooks

Verify each delivered webhook against the raw body before any JSON parsing:

```ts
import { verifyWebhook } from "posthorn";

try {
  verifyWebhook(endpointSecret, req.headers, rawBody);
  // authentic — handle the event
} catch {
  // reject: missing header, replayed timestamp, or bad signature
}
```

## Admin / Control-Plane SDK

Provision tenants, manage quotas, and read billing usage programmatically:

```ts
import { PosthornAdminClient } from "posthorn";

const admin = new PosthornAdminClient({
  baseUrl: "https://posthorn.acme.example",
  adminToken: process.env.POSTHORN_ADMIN_TOKEN!,
});

// Provision a tenant on a capped plan, then mint its first key:
const app = await admin.createApp({ name: "Acme", monthlyMessageQuota: 100_000 });
const { secret } = await admin.createApiKey(app.id); // hand secret to the tenant — shown once

// Upgrade the plan; meter usage for billing:
await admin.updateApp(app.id, { monthlyMessageQuota: 500_000 });
const usage = await admin.getAppUsage(app.id, { from: "2026-05-01", to: "2026-05-31" });
usage.total;            // messages accepted
usage.deliveries.total; // delivery attempts (operations — every HTTP send, retries included)

// Off-board: revoke a key, delete a tenant (cascades its keys):
await admin.revokeApiKey("ak_…");
await admin.deleteApp(app.id);
```

## Embedding as a Library

Run the full delivery engine in-process — no separate gateway process needed:

```ts
import { createGateway, loadConfig } from "posthorn";

const gateway = createGateway(loadConfig({
  POSTHORN_DATA_DIR: "./posthorn-data",
  POSTHORN_PORT:     "3000",
}));

const addr = await gateway.start();
console.log(`listening on http://${addr.host}:${addr.port}`);

// Provision directly on the in-process stores (same as the CLI, no HTTP round-trip):
const app = await gateway.apps.create({ name: "Acme" });
const { secret } = await gateway.apps.createApiKey(app.id);

// Graceful shutdown:
process.on("SIGINT", () => gateway.stop());
```

The stores (`gateway.apps`, `gateway.messages`, `gateway.endpoints`, `gateway.queue`) are also
usable independently without the HTTP layer — import just the primitives you need.

## Configuration

All settings are environment variables. See `.env.example` for a template.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTHORN_HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` = loopback only). |
| `POSTHORN_PORT` | `3000` | HTTP port. |
| `POSTHORN_DATA_DIR` | `./posthorn-data` | SQLite data directory, or `:memory:` for ephemeral. |
| `POSTHORN_MAX_BODY_BYTES` | `1000000` | Request-body size cap (`413` beyond it). |
| `POSTHORN_ADMIN_TOKEN` | _(unset)_ | Enables the admin API + dashboard. Minimum 32 chars. |
| `POSTHORN_WORKER_BATCH_SIZE` | `16` | Deliveries claimed per worker tick. |
| `POSTHORN_WORKER_CONCURRENCY` | `8` | Max deliveries in flight per tick. |
| `POSTHORN_WORKER_REQUEST_TIMEOUT_MS` | `10000` | Per-delivery HTTP timeout. |
| `POSTHORN_WORKER_IDLE_POLL_MS` | `1000` | Worker poll interval when idle. |
| `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS` | `30000` | Lease lifetime before reclaim. |
| `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` | `432000000` | Auto-disable window (5 days). `0` = off. |

## Monitoring

`GET /metrics` serves Prometheus text exposition (instance-aggregate, no auth required):

```
posthorn_messages_ingested_total 1234
posthorn_deliveries_total{outcome="succeeded"} 1220
posthorn_deliveries_total{outcome="dead_lettered"} 3
posthorn_delivery_tasks{status="dead_letter"} 3   ← the gauge to alert on
posthorn_uptime_seconds 86400
posthorn_build_info{version="0.0.1"} 1
```

For a production Prometheus + Alertmanager setup with ready-made alerting rules, see
**[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Dashboard

Set `POSTHORN_ADMIN_TOKEN` to unlock a browser UI at `/dashboard`:

- **Admin panel** (`/dashboard`) — provision tenants, mint/revoke API keys, set quotas.
- **Tenant panel** (`/dashboard/tenant`) — browse message history, delivery statuses, and the
  per-attempt audit log. Accessible with a tenant API key (`phk_...`).

## Development

```bash
npm install
npm test            # vitest (856 tests, ~2s)
npm run typecheck
npm run build
```

## License

MIT © Michael Crosato
