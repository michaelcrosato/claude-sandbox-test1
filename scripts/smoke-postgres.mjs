/**
 * Smoke test for the PostgreSQL storage backend — compiled-dist validation.
 *
 * Proves, through production ESM (`node dist/...`, the real deployment artifact) and
 * against a live Postgres database, that an operator can actually *deploy* Posthorn
 * on Postgres — not merely that the PG stores conform in isolation (the per-store
 * conformance suites cover that). The load-bearing risk this catches that the vitest
 * suite cannot: `pg` is a CommonJS package consumed from ESM, so a default-import /
 * interop fault would only surface under the real Node ESM loader, not vite's
 * transform.
 *
 *   POSTHORN_DATABASE_URL=postgres://… → createGateway opens the six Postgres stores
 *   provision over /v1/admin/* → endpoint → ingest → worker delivers → signature VERIFIES
 *   stop → reboot on the same database → the key + endpoint survive (durable in PG)
 *
 * Gated on POSTHORN_TEST_PG_URL; a no-op (exit 0) when unset, so the standard
 * ungated smoke pass on a machine without Postgres stays green. Run it with:
 *   docker run -d --rm -e POSTGRES_PASSWORD=p -e POSTGRES_USER=u -e POSTGRES_DB=posthorn_test -p 5433:5432 postgres:16-alpine
 *   npm run build
 *   POSTHORN_TEST_PG_URL=postgres://u:p@127.0.0.1:5433/posthorn_test node scripts/smoke-postgres.mjs
 */
import { createServer } from "node:http";
import {
  createGateway,
  loadConfig,
  verify,
  HEADERS,
  createPostgresPool,
  PostgresAppStore,
  PostgresEndpointStore,
  PostgresMessageStore,
  PostgresDeliveryQueue,
  PostgresDeliveryAttemptStore,
  PostgresEventTypeStore,
} from "../dist/index.js";

const pgUrl = process.env.POSTHORN_TEST_PG_URL;
if (!pgUrl) {
  console.log("· smoke-postgres skipped (POSTHORN_TEST_PG_URL not set)");
  process.exit(0);
}

let pass = 0;
let fail = 0;
function check(label, ok, extra = "") {
  if (ok) {
    console.log(`✓ ${label}${extra ? " " + extra : ""}`);
    pass++;
  } else {
    console.error(`✗ ${label}${extra ? " " + extra : ""}`);
    fail++;
  }
}

const ADMIN = "smoke-postgres-admin-token-1234567890";

// ── Clean slate: wipe any state a prior run left in the shared database, so the
// worker isn't chasing dead receivers and assertions are isolated. ───────────────
{
  const pool = createPostgresPool(pgUrl);
  const stores = [
    new PostgresAppStore(pool),
    new PostgresEndpointStore(pool),
    new PostgresMessageStore(pool),
    new PostgresDeliveryQueue(pool),
    new PostgresDeliveryAttemptStore(pool),
    new PostgresEventTypeStore(pool),
  ];
  for (const store of stores) {
    await store.initialize();
    await store.truncate();
  }
  await pool.end();
}

// ── A receiver that captures the first delivery it gets and 200s. ────────────────
let resolveReceived;
const received = new Promise((resolve) => {
  resolveReceived = resolve;
});
const receiver = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    resolveReceived({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200);
    res.end();
  });
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

function boot() {
  return createGateway(
    loadConfig({
      POSTHORN_DATABASE_URL: pgUrl,
      POSTHORN_ADMIN_TOKEN: ADMIN,
      POSTHORN_HOST: "127.0.0.1",
      POSTHORN_PORT: "0",
      POSTHORN_WORKER_IDLE_POLL_MS: "20",
      // Loopback receivers are private addresses; opt out of the SSRF guard for the smoke.
      POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
    }),
  );
}

let gw = boot();
let addr = await gw.start();
let base = `http://127.0.0.1:${addr.port}`;
check("gateway boots on Postgres + serves /healthz", (await (await fetch(`${base}/healthz`)).json()).status === "ok");

async function api(method, path, body, auth) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers["Authorization"] = `Bearer ${auth}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

// ── Provision a tenant + key over the admin API (proves the admin plane works on PG) ──
const appRes = await api("POST", "/v1/admin/apps", { name: "smoke-pg" }, ADMIN);
const appId = appRes.body?.id;
const apiKey = (await api("POST", `/v1/admin/apps/${appId}/keys`, {}, ADMIN)).body?.secret;
check("provisioned app + key over /v1/admin/* on Postgres", Boolean(appId) && Boolean(apiKey));

// ── Endpoint → ingest → worker delivers → signature verifies ─────────────────────
const epRes = await api("POST", "/v1/endpoints", { url: receiverUrl, eventTypes: ["user.created"] }, apiKey);
check("endpoint created (201)", epRes.status === 201, `(got ${epRes.status})`);
const endpointSecret = epRes.body?.secret;
const endpointId = epRes.body?.id;

const payload = { hello: "postgres", n: 7 };
const ingestRes = await api("POST", "/v1/messages", { eventType: "user.created", payload }, apiKey);
check("message accepted (202)", ingestRes.status === 202, `(got ${ingestRes.status})`);

const delivered = await Promise.race([
  received,
  new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
]);
check("worker delivered the webhook from the Postgres queue", delivered !== null);
check("delivered body matches the ingested payload", delivered?.body === JSON.stringify(payload));
let verified = false;
try {
  verify(
    endpointSecret,
    {
      id: delivered.headers[HEADERS.id],
      timestamp: delivered.headers[HEADERS.timestamp],
      signature: delivered.headers[HEADERS.signature],
    },
    delivered.body,
  );
  verified = true;
} catch {
  verified = false;
}
check("delivered signature verifies against the endpoint secret", verified);

// ── Restart on the same database: key + endpoint are durable in Postgres ─────────
await gw.stop();
gw = boot();
addr = await gw.start();
base = `http://127.0.0.1:${addr.port}`;
const listAfter = await api("GET", "/v1/endpoints", undefined, apiKey);
check("restart: the minted key still authenticates (durable in PG)", listAfter.status === 200, `(got ${listAfter.status})`);
check(
  "restart: the endpoint survives the reboot (durable in PG, no local files)",
  (listAfter.body?.data ?? []).some((e) => e.id === endpointId),
);

// ── Teardown ─────────────────────────────────────────────────────────────────────
await gw.stop();
receiver.close();

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
