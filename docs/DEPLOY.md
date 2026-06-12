# Deploy Posthorn with Docker

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

## Data and Secrets

The `/data` volume contains the SQLite database. That database stores tenant records, API-key hashes, endpoint signing secret ciphertext, and the local key material needed to reveal endpoint signing secrets. Back it up and restrict access like any other production secret-bearing store.
