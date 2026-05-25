# Posthorn — Operator Deploy & Monitoring Guide

Everything you need to run Posthorn in production: Docker Compose, environment
reference, security hardening, monitoring with Prometheus, alerting, and upgrade
procedures.

---

## Table of contents

1. [Requirements](#requirements)
2. [Quick start with Docker Compose](#quick-start-with-docker-compose)
3. [Bootstrap the first tenant](#bootstrap-the-first-tenant)
4. [Configuration reference](#configuration-reference)
5. [Security hardening](#security-hardening)
6. [Monitoring with Prometheus](#monitoring-with-prometheus)
7. [Logging](#logging)
8. [Alerting](#alerting)
9. [Grafana (optional)](#grafana-optional)
10. [Upgrading](#upgrading)
11. [Standalone binary (without Docker)](#standalone-binary-without-docker)
12. [Embedding as a library](#embedding-as-a-library)
13. [Tuning for throughput](#tuning-for-throughput)

---

## Requirements

| Component | Minimum | Notes |
|-----------|---------|-------|
| Docker    | 20+     | Or any OCI runtime. |
| Node.js   | 20+     | Only if running outside Docker. `node:sqlite` requires Node 22.5+. |
| Disk      | 1 GB    | For the SQLite data directory. Size depends on message volume and retention. |
| Memory    | 128 MB  | Comfortable for moderate workloads; bump for very high concurrency. |
| Network   | Outbound HTTPS | The delivery worker POSTs to your tenants' webhook endpoints. |

External services required: **none**. Posthorn runs as a single process with an
embedded SQLite store — no Postgres, no Redis.

---

## Quick start with Docker Compose

The shipped `docker-compose.yml` starts Posthorn and a Prometheus instance that
scrapes `/metrics`.

```bash
# 1. Copy the example environment file and fill in your admin token:
cp .env.example .env
# Edit .env: set POSTHORN_ADMIN_TOKEN to a strong random secret (≥ 16 chars).

# 2. Build and start:
docker compose up -d

# 3. Verify liveness:
curl http://localhost:3000/healthz
# {"status":"ok"}

# 4. Check Prometheus:
open http://localhost:9090
```

State is persisted in Docker named volumes (`posthorn-data`, `prometheus-data`)
and survives container restarts and image upgrades.

---

## Bootstrap the first tenant

Every API route requires a Bearer token, but there is no "create tenant" HTTP
route you can call without one — a chicken-and-egg that is solved at the right
privilege boundary: the shell on the host that owns the data directory.

### With Docker Compose

```bash
# Create the tenant (app):
docker compose run --rm posthorn admin create-app "Acme"
# Created app app_01j...  (Acme)

# Mint the first API key — the secret is printed ONCE and never recoverable:
docker compose run --rm posthorn admin create-key app_01j...
# secret: phk_...   ← save this, use it as: Authorization: Bearer phk_...
```

### With plain Docker

```bash
# Share the same named volume so admin and server operate on the same data:
docker run --rm -v posthorn-data:/data posthorn admin create-app "Acme"
docker run --rm -v posthorn-data:/data posthorn admin create-key app_01j...
```

### Other admin subcommands

```
posthorn admin list-apps
posthorn admin list-keys <appId>
posthorn admin revoke-key <keyId>
posthorn admin help
```

### Admin HTTP API (for hosted / remote provisioning)

When `POSTHORN_ADMIN_TOKEN` is set, the operator control-plane API is also
available over HTTP:

```bash
# Provision a tenant with a monthly quota:
curl -sX POST http://localhost:3000/v1/admin/apps \
  -H "Authorization: Bearer $POSTHORN_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme","monthlyMessageQuota":100000}'

# Mint a key for the tenant:
curl -sX POST "http://localhost:3000/v1/admin/apps/$APP_ID/keys" \
  -H "Authorization: Bearer $POSTHORN_ADMIN_TOKEN"
```

The admin token is a **distinct credential** from any tenant API key — a tenant
key never satisfies an admin route, and vice versa.  The admin surface is
**disabled by default**: if `POSTHORN_ADMIN_TOKEN` is unset, every `/v1/admin/*`
route returns `404`, indistinguishable from a nonexistent path.

---

## Configuration reference

All configuration is environment-driven — no config file to manage.

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTHORN_HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to restrict to loopback (behind a reverse proxy). |
| `POSTHORN_PORT` | `3000` | TCP port for the HTTP API. |
| `POSTHORN_DATA_DIR` | `./posthorn-data` | Directory for the four SQLite files. Use `:memory:` for an ephemeral in-memory run (data lost on restart). |
| `POSTHORN_MAX_BODY_BYTES` | `1000000` | Request-body cap in bytes (`413` if exceeded). |
| `POSTHORN_ADMIN_TOKEN` | _(unset)_ | Enables the admin API and dashboard. Must be ≥ 16 chars (use a long random value in production). Unset = both disabled. |
| `POSTHORN_WORKER_BATCH_SIZE` | `16` | Deliveries claimed per worker tick. |
| `POSTHORN_WORKER_CONCURRENCY` | `8` | Max deliveries in flight within one tick. `1` = sequential. |
| `POSTHORN_WORKER_REQUEST_TIMEOUT_MS` | `10000` | Per-delivery HTTP timeout (ms). |
| `POSTHORN_WORKER_IDLE_POLL_MS` | `1000` | Worker poll interval when the queue is empty (ms). |
| `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS` | `30000` | Lease lifetime (ms); a task is reclaimed after this if the worker dies mid-delivery. |
| `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` | `432000000` | Auto-disable an endpoint after this many ms of continuous failures (default 5 days). `0` = off (health still tracked). |
| `POSTHORN_DEFAULT_RATE_LIMIT` | _(unset)_ | Gateway-wide default delivery rate limit (deliveries/min) for endpoints without an explicit `rateLimit`. Unset = no default (such endpoints are unrestricted). Range when set: 1–10000. |
| `POSTHORN_FANOUT_GRACE_MS` | `5000` | FanoutDispatcher: minimum age of a pending-fanout message before the dispatcher acts on it (ms). |
| `POSTHORN_FANOUT_BATCH_SIZE` | `50` | FanoutDispatcher: messages processed per sweep. |
| `POSTHORN_FANOUT_IDLE_POLL_MS` | `5000` | FanoutDispatcher: poll interval when the outbox is empty (ms). |
| `POSTHORN_RETENTION_DAYS` | `0` | Delete delivered/expired data older than this many days on an hourly sweep. `0` (default) disables pruning; minimum 1 when set. |
| `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS` | `false` | Allow endpoint URLs that target private/internal addresses. `false` (default, secure) blocks loopback / RFC 1918 / link-local / CGNAT / cloud-metadata / internal-hostname destinations with `400 url_not_allowed` (SSRF defense). Set `true` only for a trusted single-tenant self-host delivering to internal services. See [SSRF protection](#ssrf-protection-private-network-webhooks). |
| `POSTHORN_LOG_LEVEL` | `info` | Minimum severity of structured (JSON Lines) logs written to stdout: `debug`, `info`, `warn`, `error`, or `silent`. `info` (default) shows request access lines and errors while keeping `/healthz` + `/metrics` probe traffic (logged at `debug`) quiet; `silent` disables logging. See [Logging](#logging). |

---

## Security hardening

### TLS / HTTPS

Posthorn's HTTP server speaks plain HTTP.  Terminate TLS at a reverse proxy
(nginx, Caddy, Traefik, AWS ALB, Cloudflare Tunnel).  Example nginx snippet:

```nginx
server {
    listen 443 ssl;
    server_name posthorn.example.com;

    ssl_certificate     /etc/letsencrypt/live/posthorn.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/posthorn.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 30s;
    }
}
```

Bind Posthorn to loopback when running behind a local proxy:

```env
POSTHORN_HOST=127.0.0.1
```

### Admin token strength

`POSTHORN_ADMIN_TOKEN` must be at least 16 characters; use a long random
value in production.  Generate a cryptographically strong one:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Never reuse a tenant API key as the admin token — they are distinct credentials
with distinct scopes.

### Restricting `/metrics`

The Prometheus `/metrics` endpoint exposes only instance-aggregate operational
data (no tenant ids, payloads, or secrets) and is intentionally unauthenticated
so Prometheus can scrape it without a token.  If you want to restrict external
access, block it at the reverse proxy or network layer:

```nginx
# Block /metrics from the public internet; allow only from your Prometheus host:
location /metrics {
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://127.0.0.1:3000;
}
```

### Data directory permissions

The SQLite data directory must be writable by the process user.  When using a
Docker bind-mount instead of a named volume:

```bash
# The container runs as uid 1000 (the `node` user in node:24-alpine):
mkdir -p /srv/posthorn-data
chown 1000:1000 /srv/posthorn-data
docker run -v /srv/posthorn-data:/data posthorn
```

### Tenant isolation

Tenancy is enforced by the authenticated API key — every route resolves the
caller from the key, never from a request-body or URL `appId`.  Cross-tenant
access returns `404` (existence is never revealed).  The admin API and tenant
API use distinct credentials that cannot be substituted for each other.

### SSRF protection (private-network webhooks)

Posthorn *sends* webhooks, so an endpoint's destination URL is a
tenant-controlled input and a classic Server-Side Request Forgery vector: a
tenant who registers `http://169.254.169.254/…` (cloud instance metadata),
`http://localhost:6379/`, or `http://10.0.0.5/admin` could otherwise coerce the
gateway into making requests against your private network.

By default Posthorn **refuses to register** an endpoint whose URL targets:

- loopback (`127.0.0.0/8`, `::1`),
- RFC 1918 private ranges (`10/8`, `172.16/12`, `192.168/16`),
- link-local (`169.254.0.0/16`, including the `169.254.169.254` metadata
  address; `fe80::/10`),
- CGNAT (`100.64.0.0/10`), unique-local IPv6 (`fc00::/7`), multicast/reserved,
- internal hostnames: `localhost`, any `.localhost` / `.local` / `.internal`
  suffix, and bare single-label names (`http://redis/`, `http://db/`).

A blocked registration returns `400 url_not_allowed` on `POST`/`PATCH
/v1/endpoints` (and inline on the consumer portal). The check runs at
**registration** time; already-stored URLs are delivered as-is.

```env
# Multi-tenant / hosted: keep the default (block).
POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=false

# Trusted single-tenant self-host that delivers to internal services: opt out.
POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true
```

> **Limitation:** this is a literal-host guard and does not resolve DNS, so a
> public hostname that resolves to a private IP (or DNS rebinding after
> registration) is not caught here. Restrict egress at the network layer for
> defense in depth in hostile multi-tenant environments.

---

## Monitoring with Prometheus

Posthorn exposes a Prometheus text-format `/metrics` endpoint with the following
series.  All counters reset on process restart (correct for a single-process
Prometheus model; Prometheus detects resets via the `_created` convention).

### Counters (monotonic, reset on restart)

| Metric | Labels | Description |
|--------|--------|-------------|
| `posthorn_messages_ingested_total` | — | Messages accepted by `POST /v1/messages`. |
| `posthorn_messages_deduplicated_total` | — | Messages suppressed because the idempotency key was already seen. |
| `posthorn_deliveries_total` | `outcome` | Delivery attempt outcomes. Labels: `succeeded`, `failed`, `dead_lettered`, `stale` (lease-lapsed, counted but not retried by this worker). |

### Gauges (point-in-time, read from queue at scrape time)

| Metric | Labels | Description |
|--------|--------|-------------|
| `posthorn_delivery_tasks` | `status` | Current delivery-task counts per status. Labels: `pending`, `delivering`, `succeeded`, `dead_letter`. The `dead_letter` gauge is the one to **alert on**: non-zero means deliveries have exhausted retries and need manual replay. |

### Info / uptime

| Metric | Labels | Description |
|--------|--------|-------------|
| `posthorn_uptime_seconds` | — | Seconds since the process started. |
| `posthorn_build_info` | `version` | Always `1`; carries the running version as a label for dashboards. |

### Useful PromQL queries

```promql
# Messages accepted per minute (5-minute rolling):
rate(posthorn_messages_ingested_total[5m]) * 60

# Delivery success rate (last 10 minutes):
rate(posthorn_deliveries_total{outcome="succeeded"}[10m])
  / rate(posthorn_deliveries_total[10m])

# Dead-letter backlog (the number to keep at zero):
posthorn_delivery_tasks{status="dead_letter"}

# Pending queue depth:
posthorn_delivery_tasks{status="pending"}
```

---

## Logging

Alongside `/metrics`, Posthorn writes **structured logs as JSON Lines to stdout** —
one JSON object per line, the format every log collector (Loki, CloudWatch,
Datadog, Vector, …) ingests without configuration. In a container, capture them
with `docker logs` or your platform's stdout pipeline; there is no log file to
rotate.

Each line carries `time` (ISO-8601), `level`, `msg`, and event-specific fields.
Every line also carries the gateway's identity — `instance` (a unique id minted per
process, so lines from multiple replicas sharing one log stream stay distinguishable)
and `version` (the running build) — and lifecycle transitions (`gateway started` /
`gateway stopped`) are part of the same parseable stream rather than a separate
human banner. For example:

```json
{"time":"2026-05-24T18:45:00.900Z","level":"info","msg":"gateway started","instance":"7f3c…","version":"0.1.0","component":"gateway","host":"0.0.0.0","port":3000,"dataDir":"/var/lib/posthorn"}
{"time":"2026-05-24T18:45:01.002Z","level":"info","msg":"request","instance":"7f3c…","version":"0.1.0","component":"http","method":"POST","path":"/v1/messages","status":202,"durationMs":4}
{"time":"2026-05-24T18:45:09.117Z","level":"error","msg":"unhandled request error","instance":"7f3c…","version":"0.1.0","component":"http","method":"GET","path":"/v1/messages/abc","err":{"name":"TypeError","message":"...","stack":"..."}}
{"time":"2026-05-24T18:45:30.500Z","level":"error","msg":"delivery worker error","instance":"7f3c…","version":"0.1.0","component":"worker","err":{"name":"Error","message":"..."}}
```

Set the minimum severity with **`POSTHORN_LOG_LEVEL`** (`debug` | `info` | `warn` |
`error` | `silent`; default `info`):

- **`info`** (default) — request access lines for API traffic plus all warnings and
  errors. The `/healthz` and `/metrics` probe requests are logged at `debug`, so
  they stay out of the default stream (no health-check / scrape spam).
- **`debug`** — also includes the probe access lines; useful when diagnosing a
  load balancer or Prometheus scrape.
- **`warn`** / **`error`** — reduce volume to warnings/errors only.
- **`silent`** — disable logging entirely.

Errors that previously vanished are now surfaced here: an unhandled exception in a
request handler is logged at `error` with the captured stack (and still answered
with `500 internal_error`), and a delivery-worker / fan-out-dispatcher / pruner
backend failure — including a best-effort audit-log or system-event write that
failed — is logged at `error` with its `component`. Ship stdout to your log
platform and alert on `level="error"`.

---

## Alerting

The shipped `monitoring/alerts.yml` defines four alerting rules out of the box.
They are loaded by the Prometheus instance in the Docker Compose stack
automatically.

| Alert | Severity | Condition | Action |
|-------|----------|-----------|--------|
| `PosthornDown` | critical | Scrape target unreachable for > 1 min | Check the container, logs, and network. |
| `PosthornDeadLetterBacklog` | warning | Any dead-lettered deliveries for > 5 min | Fix receivers, then replay via the tenant dashboard or `POST /v1/messages/:id/retry`. |
| `PosthornDeadLetterBacklogHigh` | critical | > 100 dead-lettered deliveries | Investigate systemic receiver outage. |
| `PosthornDeliveryFailureRateHigh` | warning | > 20% failure rate over 10 min | Check delivery attempt logs and receiver health. |
| `PosthornDeliveryQueueDepthHigh` | warning | > 1 000 pending tasks for > 5 min | Consider tuning `POSTHORN_WORKER_BATCH_SIZE` / `POSTHORN_WORKER_CONCURRENCY`. |

Wire alerts to Alertmanager by adding the standard Prometheus Alertmanager
configuration to `monitoring/prometheus.yml`:

```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]
```

---

## Grafana (optional)

Add Grafana to the stack by extending `docker-compose.yml`:

```yaml
# docker-compose.override.yml
services:
  grafana:
    image: grafana/grafana:11.6.1
    ports:
      - "3001:3000"
    volumes:
      - grafana-data:/var/lib/grafana
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD:-admin}
      GF_USERS_ALLOW_SIGN_UP: "false"
    restart: unless-stopped

volumes:
  grafana-data:
```

Then add Prometheus as a datasource in Grafana (`http://prometheus:9090`) and
build a dashboard from the PromQL queries above.  Key panels:

- **Ingestion rate** — `rate(posthorn_messages_ingested_total[5m]) * 60`
- **Delivery success rate** — success / total over a rolling window
- **Dead-letter backlog** — `posthorn_delivery_tasks{status="dead_letter"}` (alert threshold visible)
- **Queue depth** — `posthorn_delivery_tasks{status="pending"}`
- **Uptime** — `posthorn_uptime_seconds`

---

## Upgrading

Posthorn uses forward-only SQLite migrations: on each boot, the server adds any
missing columns or tables via guarded `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
statements, backfilling safe defaults.  There are no down migrations and no
separate migration tool to run — just pull the new image and restart.

```bash
# Pull the new image (or rebuild from source):
docker compose pull   # if using a registry image
# or: docker compose build

# Restart with the new image (SQLite migrations run automatically at boot):
docker compose up -d --force-recreate posthorn
```

The SQLite data directory is never altered destructively.  It is safe to roll
back to the previous image if needed — the new columns will simply be ignored by
the older binary (SQLite's strict-table mode does not reject unknown columns
on read; Posthorn's schema is additive).

### Backup

Back up the data directory before any upgrade:

```bash
# For a named Docker volume:
docker run --rm -v posthorn-data:/data -v $(pwd):/backup alpine \
  tar -czf /backup/posthorn-data-$(date +%Y%m%d).tar.gz /data

# For a bind-mount:
cp -r /srv/posthorn-data /srv/posthorn-data.bak
```

SQLite files can also be backed up online (the WAL journal makes this safe with
a running server) using the SQLite `.backup` command or any file-copy method
that copies both the `.sqlite` file and its `-wal` / `-shm` siblings atomically.

---

## Standalone binary (without Docker)

```bash
# Install and build:
git clone https://github.com/michaelcrosato/claude-sandbox-test1.git posthorn
cd posthorn
npm ci
npm run build

# Run (stdout is JSON Lines — the boot marker is the first line):
POSTHORN_ADMIN_TOKEN=your_token POSTHORN_DATA_DIR=/var/lib/posthorn npm start
# {"time":"…","level":"info","msg":"gateway started","instance":"…","version":"…","component":"gateway","host":"0.0.0.0","port":3000,"dataDir":"/var/lib/posthorn"}
```

For a managed system service, write a systemd unit:

```ini
[Unit]
Description=Posthorn webhook gateway
After=network.target

[Service]
Type=simple
User=posthorn
WorkingDirectory=/opt/posthorn
EnvironmentFile=/etc/posthorn/env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## Embedding as a library

Posthorn can run inside your own Node process instead of as a separate service:

```ts
import { createGateway, loadConfig } from "posthorn";

const gateway = createGateway(loadConfig({
  POSTHORN_DATA_DIR: "./posthorn-data",
  POSTHORN_ADMIN_TOKEN: process.env.MY_ADMIN_TOKEN,
}));

const address = await gateway.start();
console.log(`Posthorn listening on ${address}`);

// Provision your first tenant programmatically (no HTTP call needed):
const app = await gateway.apps.create({ name: "Acme" });
const { secret } = await gateway.apps.createApiKey(app.id);

// Graceful shutdown:
await gateway.stop();
```

The library exposes all four stores (`gateway.apps`, `gateway.endpoints`,
`gateway.messages`, `gateway.queue`) so you can drive provisioning, ingestion,
and queries programmatically without the HTTP layer.

---

## Tuning for throughput

Default settings are conservative and safe.  For higher throughput:

| Concern | Setting | Guidance |
|---------|---------|----------|
| Slow batch processing | `POSTHORN_WORKER_BATCH_SIZE` | Increase to 32–64 if your receivers are fast. Large batches hold more leases simultaneously. |
| Slow receivers | `POSTHORN_WORKER_CONCURRENCY` | Increase to match your receiver count; default 8 avoids flooding a single receiver. |
| Long receiver timeouts | `POSTHORN_WORKER_REQUEST_TIMEOUT_MS` | Default 10 s is generous. Lower it if your receivers are fast and you want faster failure detection. |
| Lease expiry under load | `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS` | Must exceed `batch_size × request_timeout / concurrency` (worst-case tick duration). Default 30 s is comfortable at defaults. |
| High fan-out latency | `POSTHORN_FANOUT_GRACE_MS` | Lower for faster outbox relay; default 5 s avoids racing the synchronous inline fan-out. |
