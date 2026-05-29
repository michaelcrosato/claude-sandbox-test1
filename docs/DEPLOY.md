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
10. [Billing](#billing)
11. [PostgreSQL backend](#postgresql-backend)
12. [Running multiple replicas (active/active)](#running-multiple-replicas-activeactive)
13. [Deploying on Kubernetes with Helm](#deploying-on-kubernetes-with-helm)
14. [Upgrading](#upgrading)
15. [Standalone binary (without Docker)](#standalone-binary-without-docker)
16. [Embedding as a library](#embedding-as-a-library)
17. [Tuning for throughput](#tuning-for-throughput)

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
embedded SQLite store — no Redis, and no external database by default. A
[PostgreSQL backend](#postgresql-backend) is available as an opt-in for
horizontally-scaled / active-active deployments (still no Redis).

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

# 3. Verify liveness (process up) and readiness (storage backend reachable):
curl http://localhost:3000/healthz
# {"status":"ok"}
curl http://localhost:3000/readyz
# {"status":"ready"}    # 503 {"status":"not_ready"} if the database is unreachable

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
| `POSTHORN_DATA_DIR` | `./posthorn-data` | Directory for the SQLite store files (SQLite backend only — ignored when `POSTHORN_DATABASE_URL` is set). Use `:memory:` for an ephemeral in-memory run (data lost on restart). |
| `POSTHORN_DATABASE_URL` | _(unset)_ | Postgres connection string (`postgres://` / `postgresql://`) selecting the [PostgreSQL backend](#postgresql-backend). Unset (default) = embedded SQLite under `POSTHORN_DATA_DIR`. The schema is created/migrated automatically on first boot. |
| `POSTHORN_PG_POOL_MAX` | `10` | Max connections the shared Postgres pool opens (PostgreSQL backend only; ignored on SQLite). Every replica multiplies this against the database's one `max_connections` budget — keep `replicas × this` under the server cap. See [Connection pool sizing](#postgresql-backend). |
| `POSTHORN_MAX_BODY_BYTES` | `1000000` | Request-body cap in bytes (`413` if exceeded). |
| `POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS` | `5000` | Idle keep-alive socket timeout (ms). Defaults to Node's own. Behind a connection-pooling LB, **raise it above the LB's idle timeout** to avoid the upstream-`502` reuse race — see [Load-balancer keep-alive](#load-balancer-keep-alive-and-timeouts). `0` disables it. |
| `POSTHORN_HTTP_HEADERS_TIMEOUT_MS` | `60000` | Deadline to receive the complete request **headers** (ms) — the slow-headers Slowloris bound. Must be ≤ `POSTHORN_HTTP_REQUEST_TIMEOUT_MS` when both are non-zero. `0` disables it. |
| `POSTHORN_HTTP_REQUEST_TIMEOUT_MS` | `300000` | Deadline to receive the **entire** request, headers + body (ms) — the slow-body Slowloris bound, independent of the body-size cap. Tighten it for an internet-facing ingest endpoint (a normal POST finishes in well under a second). `0` disables it. |
| `POSTHORN_PUBLIC_BASE_URL` | _(unset)_ | Canonical public origin for portal-session links (`portalUrl`). Unset (default) derives them from each request's `Host` + `X-Forwarded-Proto`. Set it to your public origin (e.g. `https://hooks.example.com`) behind a host-rewriting proxy. Must be a bare `http`/`https` origin — scheme + host (+ port), no path/query/fragment. See [Public base URL](#public-base-url-portal-links). |
| `POSTHORN_ADMIN_TOKEN` | _(unset)_ | Enables the admin API and dashboard. Must be ≥ 16 chars (use a long random value in production). Unset = both disabled. |
| `POSTHORN_WORKER_BATCH_SIZE` | `16` | Deliveries claimed per worker tick. |
| `POSTHORN_WORKER_CONCURRENCY` | `8` | Max deliveries in flight within one tick. `1` = sequential. |
| `POSTHORN_WORKER_REQUEST_TIMEOUT_MS` | `10000` | Total per-delivery HTTP timeout — DNS + connect + response (ms). |
| `POSTHORN_WORKER_CONNECT_TIMEOUT_MS` | `5000` | Connect-only deadline — DNS + TCP connect (ms). An unreachable endpoint fails fast instead of holding the full timeout. Should be ≤ the total timeout; `0` disables it. |
| `POSTHORN_WORKER_IDLE_POLL_MS` | `1000` | Worker poll interval when the queue is empty (ms). |
| `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS` | `30000` | Lease lifetime (ms); a task is reclaimed after this if the worker dies mid-delivery. |
| `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` | `432000000` | Auto-disable an endpoint after this many ms of continuous failures (default 5 days). `0` = off (health still tracked). |
| `POSTHORN_DEFAULT_RATE_LIMIT` | _(unset)_ | Gateway-wide default delivery rate limit (deliveries/min) for endpoints without an explicit `rateLimit`. Unset = no default (such endpoints are unrestricted). Range when set: 1–10000. |
| `POSTHORN_FANOUT_GRACE_MS` | `5000` | FanoutDispatcher: minimum age of a pending-fanout message before the dispatcher acts on it (ms). |
| `POSTHORN_FANOUT_BATCH_SIZE` | `50` | FanoutDispatcher: messages processed per sweep. |
| `POSTHORN_FANOUT_IDLE_POLL_MS` | `5000` | FanoutDispatcher: poll interval when the outbox is empty (ms). |
| `POSTHORN_RETENTION_DAYS` | `0` | Delete delivered/expired data older than this many days on an hourly sweep. `0` (default) disables pruning; minimum 1 when set. |
| `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS` | `false` | Allow endpoint URLs that target private/internal addresses. `false` (default, secure) blocks loopback / RFC 1918 / link-local / CGNAT / cloud-metadata / internal-hostname destinations with `400 url_not_allowed` (SSRF defense). Set `true` only for a trusted single-tenant self-host delivering to internal services. See [SSRF protection](#ssrf-protection-private-network-webhooks). |
| `POSTHORN_HSTS_MAX_AGE` | `0` | `Strict-Transport-Security` `max-age` in seconds. `0` (default) emits no HSTS header. Only safe once the origin is served over HTTPS — see [HSTS](#hsts-strict-transport-security). |
| `POSTHORN_HSTS_INCLUDE_SUBDOMAINS` | `false` | Append `; includeSubDomains` to the HSTS header (applies the policy to every subdomain). Requires `POSTHORN_HSTS_MAX_AGE > 0`. |
| `POSTHORN_HSTS_PRELOAD` | `false` | Append `; preload` to the HSTS header (opt into browser preload lists). Requires `includeSubDomains=true` and `max-age ≥ 31536000` (1 year); otherwise startup fails fast. |
| `POSTHORN_LOG_LEVEL` | `info` | Minimum severity of structured (JSON Lines) logs written to stdout: `debug`, `info`, `warn`, `error`, or `silent`. `info` (default) shows request access lines and errors while keeping `/healthz` + `/readyz` + `/metrics` probe traffic (logged at `debug`) quiet; `silent` disables logging. See [Logging](#logging). |
| `POSTHORN_BILLING_PROVIDER` | `none` | Billing backend: `none` (default) or `stripe`. `none` carries no payment dependency — metered-usage pushes are dropped and `POST /v1/billing/webhook` is `404`. `stripe` meters usage to Stripe and accepts Stripe-signed webhooks. See [Billing](#billing). |
| `POSTHORN_STRIPE_SECRET_KEY` | _(unset)_ | Stripe secret API key (`sk_…`). **Required** when `POSTHORN_BILLING_PROVIDER=stripe` (startup fails fast otherwise); ignored when `none`. Sent as the Bearer credential on outbound Stripe calls. |
| `POSTHORN_STRIPE_WEBHOOK_SECRET` | _(unset)_ | Stripe webhook signing secret (`whsec_…`). Optional even under the `stripe` provider: when unset, outbound usage pushes still work but `POST /v1/billing/webhook` stays `404` (the inbound surface is opt-in, like the admin API). |
| `POSTHORN_STRIPE_METER_EVENT_NAME` | `posthorn_messages` | The Stripe meter `event_name` a usage push is recorded under (Stripe Billing Meter Events API). Must match the meter configured in Stripe. Ignored when the provider is `none`. |
| `POSTHORN_SIGNUP_ENABLED` | `false` | Expose the public `POST /v1/signup` route (creates a tenant + first API key on the `free` plan, no operator involvement). `false` (default) keeps it `404` — the same opt-in posture as the admin API — so an unattended gateway never lets the world mint tenants. See [Self-serve signup](#self-serve-signup). |
| `POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE` | `10` | Maximum signups accepted per rolling minute, **gateway-wide** (a single global bucket, not per-IP — the core has no trustworthy client address). Over it, `POST /v1/signup` returns `429` with `Retry-After`. A positive integer (`1`–`10000`). Only applies when signup is enabled. |

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

### Public base URL (portal links)

`POST /v1/portal/sessions` returns a ready-to-use `portalUrl` you can redirect the
end-user to. By default Posthorn builds it from the request's `Host` header and
`X-Forwarded-Proto`, so the nginx snippet above — which forwards the public host
with `proxy_set_header Host $host;` — already produces correct links with no extra
configuration.

Set `POSTHORN_PUBLIC_BASE_URL` when your proxy **rewrites** the `Host` header so the
value reaching Posthorn is the gateway's *internal* name (`posthorn.svc.cluster.local`,
a container name, an ALB target-group host, …) rather than the public one. Without it
the portal link would point at that internal host. The configured origin is
authoritative — the request `Host`/`X-Forwarded-Proto` are then ignored entirely, so
the link is never built from a client-settable header:

```env
POSTHORN_PUBLIC_BASE_URL=https://hooks.example.com
```

It must be a bare `http`/`https` origin — scheme + host, optionally a port — with no
path, query string, fragment, or embedded credentials; a malformed value is rejected
at boot. A non-default port is preserved (`https://hooks.example.com:8443`); a default
port and any trailing slash are normalized away.

### HSTS (Strict Transport Security)

Posthorn can emit a `Strict-Transport-Security` response header instructing
browsers to refuse plain-HTTP requests to this origin for a fixed window. It is
**off by default** and opt-in, because it is only meaningful — and only safe —
when the origin is genuinely reached over HTTPS. Posthorn's own socket speaks
plain HTTP and assumes **TLS is terminated upstream** (the reverse proxy above);
the emitted header travels back through that proxy to the browser over the HTTPS
hop, where it takes effect.

To stay faithful to that — and to keep security scanners quiet — Posthorn emits
the header **only on requests it identifies as HTTPS**: a direct TLS socket, or a
request carrying `X-Forwarded-Proto: https`. So your TLS-terminating proxy must
set that header (nginx, Caddy, Traefik, and the major cloud load balancers do, by
default or with a single directive) — it is the same signal Posthorn already uses
to build `https://` portal links. A plain-HTTP request that bypasses the proxy
carries no HSTS header (RFC 6797 §8.1: do not assert HSTS over insecure transport).

```env
# Start small and ramp up. 1 day while you confirm every path is HTTPS:
POSTHORN_HSTS_MAX_AGE=86400
# Once confident, the long-lived value (1 year):
POSTHORN_HSTS_MAX_AGE=31536000
POSTHORN_HSTS_INCLUDE_SUBDOMAINS=true
```

> **Warning — HSTS is a one-way door.** A browser that has seen the header will
> refuse plain HTTP to this host for the full `max-age`; you cannot shorten that
> window retroactively for clients that already cached it. Publish a large
> `max-age` (or `includeSubDomains`) only after **every** host and subdomain of
> the origin is confirmed HTTPS-ready, or you lock them out of plain HTTP until
> the window expires. Most operators terminating TLS at a proxy set HSTS *there*;
> this setting is for when you want Posthorn to assert it directly.

`POSTHORN_HSTS_INCLUDE_SUBDOMAINS` and `POSTHORN_HSTS_PRELOAD` require a non-zero
`max-age`. `preload` additionally requires `includeSubDomains` and a `max-age` of
at least one year (`31536000`), mirroring the [hstspreload.org](https://hstspreload.org)
submission rules — a configuration that cannot satisfy them is rejected at boot
rather than shipped as a silent no-op. Preloading is effectively permanent and
hard to reverse; enable it only when the whole domain is committed to HTTPS.

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

> **Running more than one replica?** `/metrics` is per-process, and the queue-backed
> gauges below report the *same* shared value on every replica while the counters are
> per-replica. See [Monitoring a fleet](#monitoring-a-fleet) for the PromQL (sum the
> counters, `max` the gauges) and the alert-rule adjustments — getting this wrong
> reports the backlog N× and mis-fires the shipped alerts.

### Counters (monotonic, reset on restart)

| Metric | Labels | Description |
|--------|--------|-------------|
| `posthorn_messages_ingested_total` | — | Messages accepted by `POST /v1/messages`. |
| `posthorn_messages_deduplicated_total` | — | Messages suppressed because the idempotency key was already seen. |
| `posthorn_deliveries_total` | `outcome` | Delivery attempt outcomes. Labels: `succeeded`, `failed`, `dead_lettered`, `stale` (lease-lapsed, counted but not retried by this worker). |
| `posthorn_delivery_failures_total` | `reason` | The **why** behind `failed` + `dead_lettered` (their sum equals the sum of this family). Labels: `connect_timeout` (endpoint unreachable — DNS+connect deadline hit), `request_timeout` (connected but too slow — total deadline hit), `dns_failure`, `connection_refused`, `connection_reset`, `tls_error`, `ssrf_blocked` (resolved to a private/internal address), `http_4xx`, `http_5xx`, `http_other`, `no_endpoint` (subscription gone), `expired` (message TTL elapsed), `other`. |
| `posthorn_pg_pool_errors_total` | — | Recoverable Postgres connection-pool errors: a severed *idle* connection (DB restart/failover, idle timeout, network blip) the pool reconnects from on its own. **Always `0` on the SQLite backend** (no pool). No request fails when it ticks, so it is the only signal a flapping database leaves behind — a sustained `rate()` is the alert (see `PosthornPostgresPoolErrors` in `monitoring/alerts.yml`). |
| `posthorn_pg_pool_acquire_timeouts_total` | — | The **saturation twin** of `posthorn_pg_pool_errors_total`: a `pool.connect()` checkout that timed out because every pooled connection was busy past the checkout deadline, or a new connection's handshake stalled. **Always `0` on the SQLite backend** (no pool). Unlike a pool *error*, a timeout **fails** the request/delivery that hit it — a sustained `rate()` means the pool is undersized or the database is too slow (raise `POSTHORN_PG_POOL_MAX`, lower `POSTHORN_WORKER_CONCURRENCY`, or fix the DB; see `PosthornPostgresAcquireTimeouts` in `monitoring/alerts.yml`). |

### Gauges (point-in-time, read from queue at scrape time)

| Metric | Labels | Description |
|--------|--------|-------------|
| `posthorn_delivery_tasks` | `status` | Current delivery-task counts per status. Labels: `pending`, `delivering`, `succeeded`, `dead_letter`. The `dead_letter` gauge is the one to **alert on**: non-zero means deliveries have exhausted retries and need manual replay. |
| `posthorn_dead_letter_tasks` | `reason` | The **why** behind the current `dead_letter` backlog — the same closed reason set as `posthorn_delivery_failures_total` (the gauge counterpart of that lifetime counter). Summed across reasons it equals `posthorn_delivery_tasks{status="dead_letter"}`. Use it to triage *which* downstream is responsible for a dead-letter spike (e.g. `connection_refused` ⇒ an endpoint is down) without scrolling the per-delivery list. A dead-letter with no recorded classification folds into `other`. |

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

# Top delivery-failure reasons (last 10 minutes) — is it unreachable, slow, or 5xx?
topk(5, sum by (reason) (rate(posthorn_delivery_failures_total[10m])))

# Unreachable endpoints specifically (dropped SYN / black-holed IP), apart from slow ones:
rate(posthorn_delivery_failures_total{reason="connect_timeout"}[10m])

# Dead-letter backlog (the number to keep at zero):
posthorn_delivery_tasks{status="dead_letter"}

# Which reason dominates the current dead-letter backlog (triage a spike):
topk(3, posthorn_dead_letter_tasks)

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
  errors. The `/healthz`, `/readyz`, and `/metrics` probe requests are logged at
  `debug`, so they stay out of the default stream (no health-check / scrape spam). A
  `/readyz` `503` is the exception — a not-ready replica is logged at `error`, visible
  at the default level.
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

The shipped `monitoring/alerts.yml` defines seven alerting rules out of the box.
They are loaded by the Prometheus instance in the Docker Compose stack
automatically.

| Alert | Severity | Condition | Action |
|-------|----------|-----------|--------|
| `PosthornDown` | critical | Scrape target unreachable for > 1 min | Check the container, logs, and network. |
| `PosthornDeadLetterBacklog` | warning | Any dead-lettered deliveries for > 5 min | Fix receivers, then replay via the tenant dashboard or `POST /v1/messages/:id/retry`. |
| `PosthornDeadLetterBacklogHigh` | critical | > 100 dead-lettered deliveries | Investigate systemic receiver outage. |
| `PosthornDeliveryFailureRateHigh` | warning | > 20% failure rate over 10 min | Check delivery attempt logs and receiver health. |
| `PosthornDeliveryQueueDepthHigh` | warning | > 1 000 pending tasks for > 5 min | Consider tuning `POSTHORN_WORKER_BATCH_SIZE` / `POSTHORN_WORKER_CONCURRENCY`. |
| `PosthornPostgresPoolErrors` | warning | Recoverable PG pool errors over 5 min (per-instance) | Check managed-Postgres status; the pool reconnects on its own, but a flapping DB stalls deliveries. (Postgres backend only.) |
| `PosthornPostgresAcquireTimeouts` | warning | PG pool acquisition timeouts over 5 min (per-instance) | Raise `POSTHORN_PG_POOL_MAX`, lower `POSTHORN_WORKER_CONCURRENCY`, or fix a slow DB; these timeouts fail the request that hit them. (Postgres backend only.) |

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

## Billing

Billing is **optional and disabled by default** — the open-core gateway carries no
payment dependency unless you opt in. With `POSTHORN_BILLING_PROVIDER=none` (the
default), metered-usage reporting is a silent no-op and `POST /v1/billing/webhook`
returns `404`, indistinguishable from a nonexistent path.

Posthorn ships one concrete backend, **Stripe**, behind the same flag. It talks to
Stripe in two directions:

- **Outbound (metered usage)** — usage is reported to the [Stripe Billing Meter
  Events API](https://docs.stripe.com/api/billing/meter-event) as a billable
  message count per tenant per period, keyed by the tenant `appId` for idempotency
  (a re-pushed period is a no-op on Stripe's side, not a double charge). Mapping a
  Posthorn `appId` to a Stripe customer is an operator concern, out of scope for the
  gateway itself.
- **Inbound (signed webhooks)** — `POST /v1/billing/webhook` verifies the
  `Stripe-Signature` header against the **raw** request body and your webhook signing
  secret, then accepts the event. A verified-but-unrecognized event still returns
  `200` (so Stripe stops retrying); only a signature/verification failure is fatal
  (`400`). The route is live **only** when a webhook secret is configured — otherwise
  it stays `404`, the same opt-in posture as the admin API.

### Enabling Stripe

```bash
POSTHORN_BILLING_PROVIDER=stripe
POSTHORN_STRIPE_SECRET_KEY=sk_live_…           # required for the stripe provider
POSTHORN_STRIPE_WEBHOOK_SECRET=whsec_…         # optional; enables the inbound webhook route
POSTHORN_STRIPE_METER_EVENT_NAME=posthorn_messages   # must match your Stripe meter
```

`POSTHORN_STRIPE_SECRET_KEY` is **required** when the provider is `stripe` — startup
fails fast otherwise rather than surfacing a `401` on the first usage push. The
webhook secret is independent: leave it unset and outbound usage reporting still
works while the inbound webhook route stays `404`. Point your Stripe webhook
endpoint at `https://<your-host>/v1/billing/webhook`.

All outbound Stripe calls ride the same connection-time SSRF-guarded HTTP transport
as webhook delivery, governed by `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS`.

---

## Self-serve signup

By default, provisioning a tenant is a privileged operator action (the admin API or
the `posthorn admin` CLI). For a **self-serve product** — where users sign themselves
up without you in the loop — enable the public `POST /v1/signup` route:

```bash
POSTHORN_SIGNUP_ENABLED=true
POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE=10   # optional; gateway-wide cap, default 10
```

`POST /v1/signup` creates a tenant and mints its first API key in one unauthenticated
call, then returns the tenant, the key's metadata, and the key's **one-time** plaintext
secret (persist it — it is never recoverable). The new tenant always lands on the
`free` plan; a paid tier or a custom quota can only be assigned by an operator via the
admin API, so a self-serve caller can never grant itself more than the free allowance.

**Opt-in, like the admin API.** With `POSTHORN_SIGNUP_ENABLED` unset or `false` (the
default) the route returns `404`, indistinguishable from a nonexistent path — an
unattended gateway never lets the world mint tenants.

**Rate limiting.** When enabled, signups are capped at
`POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE` per rolling minute, **gateway-wide**: it is a
single global bucket rather than a per-client limit, because the request core has no
trustworthy client address (`X-Forwarded-For` is spoofable). It is a coarse defense
against automated tenant-spraying, not a fairness mechanism; over the cap the route
returns `429` with a `Retry-After` header. The limit is in-process and per-replica
(not coordinated across a multi-replica Postgres deployment), the same caveat as
delivery rate limiting — size it per replica accordingly.

---

## PostgreSQL backend

By default Posthorn stores everything in embedded SQLite — the zero-dependency
single-process deployment. For a **horizontally-scaled or active/active** setup,
point every store at one shared PostgreSQL database instead by setting a single
variable:

```bash
POSTHORN_DATABASE_URL=postgres://posthorn:secret@db:5432/posthorn?sslmode=require
```

When set, all six stores (apps, endpoints, messages, delivery queue, attempt audit
log, event types) live in that one database and `POSTHORN_DATA_DIR` is unused. The
`pg` driver ships with the image (an optional dependency), so nothing else to
install. Use Postgres when you need to run **more than one gateway replica against
the same data** (the SQLite backend is single-host); a single replica is perfectly
happy on SQLite.

**Why it is safe across replicas.** The delivery queue claims work with
lease-based row locking and visibility timeouts (the same contract the SQLite queue
honors, proven by a shared conformance suite), so multiple gateways draining one
Postgres queue never double-deliver a task that another replica already holds, and a
replica that dies mid-delivery has its lease reclaimed. Idempotency keys are enforced
by a composite unique index, so concurrent ingests of the same key still dedup.

**Concurrency safety timeouts.** Every pooled connection opens with a 5-second
`lock_timeout` and a 10-second `idle_in_transaction_session_timeout` (the Postgres
counterpart to the SQLite busy-timeout). Postgres defaults both to *infinite*, so
without them a queue mutation blocked behind another replica's row lock — or a
session left idle mid-transaction by a stalled/crashed peer — would wait forever,
pinning a connection and the locks it holds. With finite timeouts the blocked
statement fails promptly with a retryable error instead, and a zombie transaction is
aborted so its locks free. These are fixed, not tunable: they only ever fire on a
statement that is *blocked* or a session that is *stalled*, never on one making
progress, so the data-retention pruner's bulk deletes (which can run long) are
deliberately left uncapped — there is no `statement_timeout`.

**Connection pool sizing.** Each gateway opens a single shared pool of at most
`POSTHORN_PG_POOL_MAX` connections (default 10) to the database. This is the one
PostgreSQL tunable you must actively plan in a multi-replica deployment: Postgres
caps total connections server-side (`max_connections` — frequently ~100 on a
managed instance, far lower on small/shared tiers), and **every replica's pool
draws on that same budget**, so size it as `replicas × POSTHORN_PG_POOL_MAX` ≤
`max_connections` (leaving headroom for admin tools and the pruner). Lower it when
many replicas share a small database; raise it for a single busy replica that needs
more than 10 deliveries/queries in flight at once. The pool also bounds how long a
checkout *waits* for a free connection: a fixed 10-second connection-acquisition
timeout (pg's default is to wait **forever**) means a saturated or struggling pool
fails fast with a retryable error rather than hanging the whole gateway — the
pool-acquisition counterpart to the lock/idle timeouts above, and likewise fixed
because it only ever fires on a checkout that is already stuck. If you see those
timeouts under normal load, the pool is under-provisioned: raise
`POSTHORN_PG_POOL_MAX` (and the database's `max_connections` if needed).

**Schema.** Created and migrated automatically on first boot — the same
forward-only, additive `ADD COLUMN IF NOT EXISTS` discipline as SQLite. No separate
migration tool to run. The database role only needs `CREATE`/DDL on its schema plus
normal DML.

**Provisioning.** The `posthorn admin` CLI and the `/v1/admin/*` API both operate on
the configured backend automatically — run the CLI with the same
`POSTHORN_DATABASE_URL` in its environment and it provisions into Postgres, not a
stray SQLite file.

**Backup** is now your Postgres operator's job — `pg_dump` / managed snapshots /
streaming replication — rather than the SQLite file copy described below. The
SQLite-specific `.backup` guidance does not apply to a Postgres deployment.

---

## Running multiple replicas (active/active)

A single container on embedded SQLite is **single-host** by design — wonderfully
simple, but one process. When you need high availability (survive a node failure) or
more delivery throughput than one process provides, switch to the shared
[PostgreSQL backend](#postgresql-backend) and run **several identical gateway replicas
against the same database**. There is still no Redis and **no leader election**: every
replica runs the full engine, and all coordination lives in Postgres rows.

### What runs on every replica — and how they stay out of each other's way

Each gateway process runs the HTTP API, the delivery worker, the fan-out dispatcher,
and (when `POSTHORN_RETENTION_DAYS > 0`) the data pruner. None of them needs to know
another replica exists; they coordinate entirely through the shared tables:

| Subsystem | Coordination mechanism | Behavior across N replicas |
|-----------|------------------------|----------------------------|
| **Delivery worker** (the hot path) | `SELECT … FOR UPDATE SKIP LOCKED` lease + visibility timeout | Each due delivery is claimed by exactly one replica; the rest skip the locked rows and claim *different* work, so delivery throughput scales with replica count. A replica that dies mid-delivery has its lease reclaimed after `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS` and the task is re-driven elsewhere — nothing is lost or stranded. |
| **Idempotent intake** | composite unique index on `(app_id, idempotency_key)` | Two replicas accepting the same key at the same instant still collapse to one stored message and one fan-out. |
| **Endpoint health / auto-disable** | folded per terminal outcome inside a `SELECT … FOR UPDATE` transaction | Concurrent failure reports from different replicas never lose an increment, so auto-disable fires on the true consecutive-failure streak, not an undercount. |
| **Fan-out dispatcher** (outbox relay) | none — *duplicate-safe by design* | Runs on every replica. The rare orphan it recovers — a message accepted but not inline-fanned-out because a crash struck in between — can be swept by more than one replica at once, producing a duplicate fan-out. Delivery is **at-least-once** and every webhook carries a stable `webhook-id`, so a compliant receiver dedups the repeat; `POSTHORN_FANOUT_GRACE_MS` keeps the dispatcher from racing a *healthy* inline fan-out. The only cost is occasionally double-counting a metered operation on an orphan. |
| **Data pruner** | idempotent `DELETE … WHERE … < cutoff` | Safe to run on every replica: concurrent sweeps merely race to delete the same expired rows and the loser deletes nothing — redundant work, never destructive. Set `POSTHORN_RETENTION_DAYS` identically on every replica. |
| **Monthly quota** | per-request count over the current UTC month — no scheduled reset job | The window "resets" implicitly at the UTC month boundary, so there is nothing to coordinate. Under heavy concurrency two replicas can both pass the check on the boundary message and overshoot the cap by a hair — the quota is a guard, not a hard ceiling. |

The takeaway: **scale the replica count freely.** The load-bearing delivery path is
lease-serialized, and every other subsystem is either idempotent or
at-least-once-safe.

### A worked example (Docker Compose)

```yaml
# docker-compose.yml — three gateway replicas behind nginx, one shared Postgres.
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: posthorn
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: posthorn
    command: ["postgres", "-c", "max_connections=100"]
    volumes:
      - pgdata:/var/lib/postgresql/data

  posthorn:
    image: posthorn
    environment:
      POSTHORN_DATABASE_URL: postgres://posthorn:secret@db:5432/posthorn
      POSTHORN_PG_POOL_MAX: "10"          # 3 replicas × 10 = 30 ≤ max_connections
      POSTHORN_ADMIN_TOKEN: ${POSTHORN_ADMIN_TOKEN}
    depends_on: [db]
    # No host port published — nginx fronts the replicas.

  lb:
    image: nginx:alpine
    ports: ["3000:80"]
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on: [posthorn]

volumes:
  pgdata:
```

Scale the gateway tier; Compose's embedded DNS returns one address per replica:

```bash
docker compose up -d --scale posthorn=3
```

`nginx.conf` — re-resolve the Compose service name each request so nginx round-robins
across whatever replicas are currently up (the `resolver` + variable-`proxy_pass`
pattern; a static `upstream` would pin to the addresses present at nginx start):

```nginx
resolver 127.0.0.11 valid=10s;   # Docker's embedded DNS
server {
    listen 80;
    location / {
        set $backend http://posthorn:3000;
        proxy_pass $backend;     # variable proxy_pass forwards the original request URI
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;   # also drives HTTPS portal links / HSTS
    }
}
```

On Kubernetes the same shape is a `Deployment` with `replicas: 3`, the database URL
from a `Secret`, a `livenessProbe` on `GET /healthz` and a `readinessProbe` on
`GET /readyz` (see below), and an ordinary `Service` in front — no `StatefulSet` and no
per-pod volume, because the replicas hold no local state.

### Load balancing and health checks

- Replicas are **stateless** — no sticky sessions or session affinity. Any algorithm
  (round-robin, least-connections) works.
- **Two distinct probes — use both, for different jobs:**
  - **`GET /healthz` — liveness.** A static `200 {"status":"ok"}` served as soon as
    the HTTP listener is up. It says only *the process is serving*; it does **not**
    touch the database. Use it as the Kubernetes `livenessProbe` (and the Docker
    `HEALTHCHECK`) — a transient database blip must **not** restart an otherwise-healthy
    replica, so the liveness check is deliberately backend-independent.
  - **`GET /readyz` — readiness.** Probes the storage backend: `200 {"status":"ready"}`
    when it is reachable, `503 {"status":"not_ready"}` when it is not (for Postgres a
    `SELECT 1` round-trip bounded by the pool's connection-acquisition timeout, so a
    dead database fails the probe fast; for embedded SQLite it is always ready — there
    is no out-of-process dependency to lose). Use it as the **load-balancer health
    check** and the Kubernetes `readinessProbe`: a replica whose Postgres is
    unreachable is pulled from rotation — stops receiving ingest it could not durably
    store — while staying alive to recover, rather than 500-ing clients. Pair it with
    the delivery-failure and connection-timeout signals in
    [Monitoring a fleet](#monitoring-a-fleet) to catch a replica that is *reachable but
    degraded* (`/readyz` only reports binary reachability, not slowness).
- **Rolling deploys and replica loss are safe.** Drain or kill a replica at any time:
  any delivery it held mid-flight loses its lease and is reclaimed by a peer after the
  visibility timeout, so the only observable effect is at-least-once redelivery (which
  receivers already dedup on `webhook-id`). On a clean `SIGTERM`/`SIGINT` the replica
  also drains its HTTP edge — see [Graceful shutdown](#graceful-shutdown-and-the-drain-window)
  below — so an in-flight ingest finishes rather than being reset; a hard kill (`SIGKILL`,
  node failure) is still safe, it just falls back to lease reclaim.

### Graceful shutdown and the drain window

On `SIGTERM` or `SIGINT` the gateway shuts down in order: it stops the delivery worker
(the current tick finishes, then the loop exits — any task still leased is reclaimed by a
peer after the visibility timeout), **stops accepting new HTTP connections and lets
in-flight requests finish**, then releases the storage backend. The HTTP drain is the part
that matters for a producer: an ingest (`POST /v1/messages`) that is mid-flight when the
signal arrives completes and returns its `202` instead of seeing a connection reset — which
a producer *without* an idempotency key would otherwise have to disambiguate (did it land?)
by retrying, risking a duplicate.

`POSTHORN_HTTP_SHUTDOWN_GRACE_MS` (default `10000`) bounds that drain: after the window,
any socket still serving a request is force-closed, so one slow or stuck request can't hold
shutdown open indefinitely. `0` disables the cutoff (the drain is then bounded only by
`POSTHORN_HTTP_REQUEST_TIMEOUT_MS`). **Set your orchestrator's termination grace at or above
this value** so the drain completes before a `SIGKILL` lands:

```
Kubernetes terminationGracePeriodSeconds  ≥  POSTHORN_HTTP_SHUTDOWN_GRACE_MS / 1000  (+ headroom)
docker stop -t <seconds>                  ≥  POSTHORN_HTTP_SHUTDOWN_GRACE_MS / 1000  (+ headroom)
```

The Kubernetes default (30 s) comfortably covers the 10 s default; `docker stop`'s default
is 10 s, so either lower the grace below it or raise `docker stop -t`. In practice almost
every request drains in well under a second, so the window is only a ceiling for the
pathological case, not the normal shutdown latency.

### Load-balancer keep-alive and timeouts

There is one HTTP-edge knob a deployment **behind a connection-pooling load balancer**
(AWS ALB, nginx, Envoy, HAProxy, …) should set, and it is a correctness fix, not just
tuning. The LB keeps a pool of upstream connections to each replica and reuses them. If
the replica's keep-alive timeout is *shorter* than the LB's idle timeout, the LB can pick
a socket to reuse in the same instant the replica decides to close it — the request lands
on a half-closed connection and the client sees a sporadic, unexplained `502`/`504`.

The fix is to make the replica's keep-alive timeout **longer** than the LB's idle
timeout, so the LB always closes idle sockets first:

```
POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS  >  (LB idle timeout)
POSTHORN_HTTP_HEADERS_TIMEOUT_MS     >  POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS
```

| Load balancer | Default idle timeout | Suggested `POSTHORN_HTTP_KEEP_ALIVE_TIMEOUT_MS` | Suggested `POSTHORN_HTTP_HEADERS_TIMEOUT_MS` |
|---------------|----------------------|--------------------------------------------------|----------------------------------------------|
| AWS ALB       | 60 s                 | `65000`                                          | `66000` |
| nginx (`keepalive_timeout`) | 75 s    | `80000`                                          | `81000` |
| Direct / no LB | —                   | `5000` (default — keep short)                    | `60000` (default) |

The defaults match Node's own (`5000` / `60000` / `300000`), so a single-container or
direct-exposed deployment needs no change. `POSTHORN_HTTP_REQUEST_TIMEOUT_MS` (whole
request, headers + body) is the slow-body Slowloris bound; the `5`-minute default is
generous for a 1 MiB body over a slow link — tighten it (e.g. `30000`) on an
internet-facing ingest endpoint where a legitimate webhook POST finishes near-instantly.
Setting `POSTHORN_HTTP_HEADERS_TIMEOUT_MS` above `POSTHORN_HTTP_REQUEST_TIMEOUT_MS` is
rejected at boot (the headers deadline can never outlast the whole-request one).

### Connection budget — the one number to plan

This is the single PostgreSQL knob a multi-replica deployment *must* get right.
Postgres caps total connections server-side (`max_connections` — often ~100 on a
managed instance, far less on small tiers), and **every replica opens its own pool of
up to `POSTHORN_PG_POOL_MAX` (default 10)** against that shared budget:

```
replicas × POSTHORN_PG_POOL_MAX  ≤  max_connections − headroom
```

Reserve headroom (a dozen connections is safe) for the `posthorn admin` CLI, ad-hoc
`psql`, backups, and Postgres's own background workers. Three replicas at the default
10 draw 30 connections; eight replicas on a 100-connection server still fit at the
default (80), but sixteen would need `POSTHORN_PG_POOL_MAX` lowered to ~5. If a healthy
fleet starts logging connection-acquisition timeouts (`timeout exceeded when trying to
connect`), that replica's pool is under-provisioned for its load — raise
`POSTHORN_PG_POOL_MAX` *and* `max_connections` together, never just one. See
[Connection pool sizing](#postgresql-backend) for the per-pool details.

### Monitoring a fleet

`/metrics` is **per-process**, so point Prometheus at **every replica as its own scrape
target** (Compose / Kubernetes service discovery does this automatically, tagging each
with a distinct `instance`). Two metric families then behave differently, and
conflating them is the easiest multi-replica monitoring mistake:

- **Counters are per-replica — sum them.** `posthorn_messages_ingested_total`,
  `posthorn_deliveries_total`, `posthorn_messages_deduplicated_total`, and
  `posthorn_delivery_failures_total` each accumulate in the process that handled the
  work, so a fleet total is a `sum`. (`posthorn_pg_pool_errors_total` and
  `posthorn_pg_pool_acquire_timeouts_total` are also per-replica — each replica owns
  its own pool — but they track the *health of a replica's connection to the shared
  database*, so the shipped alerts keep them per-`instance` rather than summing,
  surfacing exactly which replica lost its connections or saturated its pool.)

  ```promql
  # Fleet-wide ingest rate (msgs/min):
  sum(rate(posthorn_messages_ingested_total[5m])) * 60

  # Fleet-wide delivery success rate — sum numerator and denominator *first*:
  sum(rate(posthorn_deliveries_total{outcome="succeeded"}[10m]))
    / sum(rate(posthorn_deliveries_total[10m]))
  ```

- **Queue gauges are global — do *not* sum them.** `posthorn_delivery_tasks` and
  `posthorn_dead_letter_tasks` are read from the *shared* queue at scrape time, so every
  replica reports the **same** backlog. Prometheus stores one identical series per
  `instance`; summing them inflates the backlog N-fold. Collapse the duplicates with
  `max` instead:

  ```promql
  # True dead-letter backlog across the fleet (NOT sum — that would be N× the truth):
  max without (instance) (posthorn_delivery_tasks{status="dead_letter"})

  # True pending depth:
  max without (instance) (posthorn_delivery_tasks{status="pending"})
  ```

- `posthorn_uptime_seconds` and `posthorn_build_info` are genuinely per-replica; during
  a rolling upgrade `count by (version) (posthorn_build_info)` shows the live version mix.

**The shipped `monitoring/alerts.yml` rules assume a single scrape target.** Under
multiple replicas the gauge-based rules (`PosthornDeadLetterBacklog`,
`PosthornDeadLetterBacklogHigh`, `PosthornDeliveryQueueDepthHigh`) compare *each*
replica's copy of the shared gauge, so they still test the correct value but raise one
duplicate alert per replica — wrap the gauge in `max without (instance) (…)` to fire
once. The failure-rate rule (`PosthornDeliveryFailureRateHigh`) is evaluated per
replica, which is useful for catching a single sick replica; for a true *fleet* ratio,
rewrite it as `sum(rate(…failed…)) / sum(rate(…total…))`. `PosthornDown` (`up == 0`) is
already per-target and correct as-is.

### Rolling upgrades across the fleet

Posthorn's schema migrations are **forward-only and additive**
(`ADD COLUMN IF NOT EXISTS` — see [Upgrading](#upgrading)), so a mixed-version fleet
*during* a rolling deploy is safe: a new replica adds any missing columns on boot, and
older replicas ignore columns they do not know about. Upgrade one replica at a time
behind the load balancer; no maintenance window or separate migration step is required.

---

## Deploying on Kubernetes with Helm

A Helm chart lives in [`deploy/helm/posthorn`](../deploy/helm/posthorn). It renders the
`Deployment` + `Service` shape described above — `livenessProbe` on `GET /healthz`,
`readinessProbe` on `GET /readyz`, a derived `terminationGracePeriodSeconds`, a
locked-down non-root pod, and the full `POSTHORN_*` surface as values — for both storage
backends.

### Install (embedded SQLite — the single-container default)

```bash
helm install posthorn ./deploy/helm/posthorn \
  --set image.repository=<your-registry>/posthorn \
  --set image.tag=1.0.0
```

This is the zero-dependency path: one replica, a `ReadWriteOnce`
`PersistentVolumeClaim` mounted at `/data`, and an `update` strategy of
`Recreate` (one SQLite writer can't overlap with its successor on the volume). SQLite is
**single-writer**, so the chart *refuses to render* a multi-replica or autoscaled SQLite
deployment — `replicaCount > 1` or `autoscaling.enabled=true` aborts `helm install` with an
explanatory error rather than producing a deployment that corrupts on the second pod.

### Install (shared Postgres — horizontally scalable)

For the [active/active](#running-multiple-replicas-activeactive) path, point the chart at a
Postgres database and scale out. Keep the connection string in a `Secret` (either let the
chart create one from `backend.postgres.url`, or reference your own with
`backend.postgres.existingSecret`):

```bash
helm install posthorn ./deploy/helm/posthorn \
  --set image.repository=<your-registry>/posthorn --set image.tag=1.0.0 \
  --set backend.type=postgres \
  --set backend.postgres.existingSecret=posthorn-db \
  --set replicaCount=3 \
  --set backend.postgres.poolMax=10            # 3 × 10 = 30 ≤ server max_connections
```

In Postgres mode the pods are **stateless** — no PVC is mounted — so a `HorizontalPodAutoscaler`
(`autoscaling.enabled=true`), a `PodDisruptionBudget`, and a rolling update strategy all apply.

### What the values control

| Value | Maps to | Notes |
|-------|---------|-------|
| `backend.type` | storage backend | `sqlite` (default, needs `persistence`) or `postgres`. |
| `backend.postgres.url` / `.existingSecret` | `POSTHORN_DATABASE_URL` | Injected via `Secret`, never a plain env value. |
| `admin.enabled` + `admin.token` / `.existingSecret` | `POSTHORN_ADMIN_TOKEN` | Off by default — the admin API stays `404` until set. |
| `signup.enabled` / `signup.ratePerMinute` | `POSTHORN_SIGNUP_ENABLED` / `POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE` | Self-serve onboarding, off by default. |
| `billing.provider` + `billing.stripe.*` | `POSTHORN_BILLING_PROVIDER`, `POSTHORN_STRIPE_*` | Stripe keys land in a `Secret`. |
| `config.*` | the remaining `POSTHORN_*` knobs | HTTP timeouts, worker/fan-out tuning, HSTS, retention, SSRF policy — see the [Configuration reference](#configuration-reference). |
| `terminationGracePeriodSeconds` | pod grace | Empty = derived as `config.http.shutdownGraceMs / 1000 + 5s`, satisfying the [graceful-shutdown rule](#graceful-shutdown-and-the-drain-window). |
| `serviceMonitor.enabled` | Prometheus Operator | Scrapes `/metrics`; requires the Operator CRDs. |

Secrets (`POSTHORN_ADMIN_TOKEN`, `POSTHORN_DATABASE_URL`, the Stripe keys) are always wired
through a Kubernetes `Secret` — either chart-managed from an inline value, or your own via the
matching `existingSecret` field — never as a plain-text `ConfigMap`/env entry. A
`checksum/config` (and `checksum/secret`) pod annotation rolls the pods automatically when
config changes.

### Verify the release

```bash
helm test posthorn        # runs an in-cluster probe of GET /readyz
helm lint ./deploy/helm/posthorn
helm template posthorn ./deploy/helm/posthorn   # render manifests without installing
```

`helm lint` and a render of both backends run in CI, so a chart change that breaks templating
fails the build.

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
Each store opens its database with a 5-second SQLite busy-timeout, so concurrent
access from another process — an online `.backup`, the `posthorn admin` CLI, or
the brief file overlap while a rolling deploy hands off — waits for the write
lock to free instead of failing immediately with `database is locked`.

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
| Long receiver timeouts | `POSTHORN_WORKER_REQUEST_TIMEOUT_MS` | Total deadline (DNS + connect + response). Default 10 s is generous. Lower it if your receivers are fast and you want faster failure detection. |
| Unreachable endpoints | `POSTHORN_WORKER_CONNECT_TIMEOUT_MS` | Connect-only deadline so a dead/black-holed endpoint fails fast rather than burning the full total timeout. Default 5 s; lower for snappier failure detection, `0` to fold it back into the total deadline. |
| Lease expiry under load | `POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS` | Must exceed `batch_size × request_timeout / concurrency` (worst-case tick duration). Default 30 s is comfortable at defaults. |
| High fan-out latency | `POSTHORN_FANOUT_GRACE_MS` | Lower for faster outbox relay; default 5 s avoids racing the synchronous inline fan-out. |
