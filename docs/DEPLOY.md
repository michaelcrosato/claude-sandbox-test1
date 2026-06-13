# Deploy Posthorn

Posthorn runs as one Node process with SQLite-backed state in `/data`. The container does not need Redis or Postgres.

## Build

```bash
docker build -t posthorn:local .
```

The image builds with `npm ci`, compiles TypeScript to `dist`, and runs `node dist/src/server.js`.

## Run One Container

Set a long admin token in your shell. Do not commit it to the repo.

```bash
export POSTHORN_ADMIN_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
docker volume create posthorn-data
docker rm -f posthorn-smoke >/dev/null 2>&1 || true
docker run -d --name posthorn-smoke \
  -p 127.0.0.1:3000:3000 \
  -v posthorn-data:/data \
  -e POSTHORN_DATA_DIR=/data \
  -e POSTHORN_ADMIN_TOKEN="$POSTHORN_ADMIN_TOKEN" \
  posthorn:local
```

Smoke-check the running container:

```bash
curl -fsS http://localhost:3000/healthz
curl -fsS http://localhost:3000/readyz
curl -fsS http://localhost:3000/metrics | head
docker logs posthorn-smoke
```

Stop the smoke container without deleting the named SQLite volume:

```bash
docker rm -f posthorn-smoke
```

## Bootstrap a Tenant

Admin routes are available only when `POSTHORN_ADMIN_TOKEN` is set. Create a tenant and API key through the implemented HTTP control-plane routes:

```bash
APP_ID="$(
  curl -fsS http://localhost:3000/v1/admin/apps \
    -H "Authorization: Bearer $POSTHORN_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"Acme"}' |
    node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(0, 'utf8')).app.id)"
)"

POSTHORN_API_KEY="$(
  curl -fsS "http://localhost:3000/v1/admin/apps/$APP_ID/keys" \
    -H "Authorization: Bearer $POSTHORN_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' |
    node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(0, 'utf8')).secret)"
)"
```

Save the tenant API key in your own secret manager; Posthorn only returns it once.

## Compose Reference

`docker-compose.yml` runs the Posthorn service, a persistent `posthorn-data` volume, and a Prometheus scrape example for `/metrics`. The sample binds both host ports to `127.0.0.1`; put a TLS reverse proxy or firewall in front before exposing either service on a network.

```bash
export POSTHORN_ADMIN_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
docker compose up -d --build
curl -fsS http://localhost:3000/healthz
curl -fsS http://localhost:9090/-/ready
docker compose logs posthorn
docker compose down
```

The compose file reads `POSTHORN_ADMIN_TOKEN` from your shell and fails fast when it is missing. Avoid sharing `docker compose config` output because Compose renders environment values into the generated config.

Prometheus uses [docs/prometheus.yml](prometheus.yml), which scrapes `posthorn:3000` at `/metrics`.

## Helm Chart Reference

`charts/posthorn` is a starter Helm chart for Kubernetes. It runs the same single-pod, single-container
Posthorn service with SQLite state persisted at `/data`; it is not a multi-replica or scale-out
chart. The PostgreSQL backend is not implemented yet.

Create an admin-token Secret before installing:

```bash
kubectl create namespace posthorn
kubectl create secret generic posthorn-admin \
  --namespace posthorn \
  --from-literal=posthorn-admin-token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
```

Install the chart from the repo:

```bash
helm install posthorn ./charts/posthorn \
  --namespace posthorn \
  --set admin.existingSecret=posthorn-admin \
  --set admin.existingSecretKey=posthorn-admin-token \
  --set image.repository=posthorn \
  --set image.tag=local
```

The chart defaults to one pod, a `ClusterIP` service on port `3000`, a persistent volume claim for
`/data`, and `/healthz` plus `/readyz` probes. It intentionally does not include Ingress,
ServiceMonitor, horizontal scaling, Redis, or PostgreSQL templates; add those only when the product
supports the related runtime behavior.

## Monitoring Artifacts

Use [docs/prometheus-alerts.yml](prometheus-alerts.yml) as a starting Prometheus rule group for
Posthorn target health, dead letters, stuck deliveries, and retry spikes. The rules reference only
the metrics served by `/metrics` plus Prometheus' own `up` scrape metric.

Import [docs/grafana-dashboard.json](grafana-dashboard.json) into Grafana and select your
Prometheus datasource when prompted. The dashboard summarizes accepted messages, delivery outcomes,
delivery task backlog, dead-letter reasons, uptime, and build information without tenant labels or
payload data.

## Data and Secrets

The `/data` volume contains the SQLite database. That database stores tenant records, API-key hashes, endpoint signing secret ciphertext, and the local key material needed to reveal endpoint signing secrets. Back it up and restrict access like any other production secret-bearing store.
