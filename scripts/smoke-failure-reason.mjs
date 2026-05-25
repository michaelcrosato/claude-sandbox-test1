/**
 * Smoke test for the structured per-attempt `failureReason` — compiled-dist validation.
 *
 * Proves, through production ESM on a real file-backed node:sqlite database, that the
 * delivery worker classifies a failed attempt into a stable reason code, persists it on
 * the append-only audit record (new `failure_reason` column), surfaces it at
 * `GET /v1/messages/:id/attempts`, and that it survives a gateway restart:
 *
 *   provision → endpoint→5xx receiver → ingest → worker fails → attempt.failureReason=http_5xx
 *   provision → endpoint→dead port    → ingest → worker fails → attempt.failureReason=connection_refused
 *   restart on the same data dir → the recorded reason is still readable
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGateway, loadConfig } from "../dist/index.js";

let pass = 0; let fail = 0;
function check(label, ok, extra = "") {
  if (ok) { console.log(`✓ ${label}${extra ? " " + extra : ""}`); pass++; }
  else { console.error(`✗ ${label}${extra ? " " + extra : ""}`); fail++; }
}

const dir = mkdtempSync(join(tmpdir(), "posthorn-failure-reason-"));
const ADMIN = "smoke-failure-reason-admin-token";

// ── A receiver that always 500s, so every delivery to it fails with an HTTP 5xx ──
let receiverStatus = 500;
const receiver = createServer((_req, res) => { res.writeHead(receiverStatus); res.end(); });
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
// A port with nothing listening → the TCP connect is refused (ECONNREFUSED).
const deadUrl = "http://127.0.0.1:1";

function boot() {
  const gw = createGateway(
    loadConfig({
      POSTHORN_DATA_DIR: dir,
      POSTHORN_ADMIN_TOKEN: ADMIN,
      // Bind loopback on an OS-assigned ephemeral port so a restart never races to
      // re-bind a fixed port (see addr.port below).
      POSTHORN_HOST: "127.0.0.1",
      POSTHORN_PORT: "0",
      // Loopback receivers are private addresses; opt out of the SSRF guard for the smoke.
      POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
      // Tight connect deadline so the dead-port case fails fast (it refuses well before this).
      POSTHORN_WORKER_CONNECT_TIMEOUT_MS: "1000",
    }),
  );
  return gw;
}

let gw = boot();
let addr = await gw.start();
let base = `http://127.0.0.1:${addr.port}`;

async function api(method, path, body, auth) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers["Authorization"] = `Bearer ${auth}`;
  const res = await fetch(`${base}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json };
}

/** Poll the attempts endpoint until at least one is recorded (or time out). */
async function waitForAttempt(messageId, apiKey, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api("GET", `/v1/messages/${messageId}/attempts`, undefined, apiKey);
    const first = res.body?.data?.[0];
    if (first) return first;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Find the delivery for (messageId[, endpointId]) in the tenant's GET /v1/deliveries list. */
async function findDelivery(messageId, apiKey, endpointId = null) {
  const res = await api("GET", "/v1/deliveries", undefined, apiKey);
  return (
    (res.body?.data ?? []).find(
      (d) => d.messageId === messageId && (endpointId === null || d.endpointId === endpointId),
    ) ?? null
  );
}

/**
 * Poll GET /v1/deliveries until the delivery for (messageId[, endpointId]) carries a
 * denormalized failureReason — the task is settled a hair after its attempt is recorded.
 */
async function waitForDeliveryReason(messageId, apiKey, endpointId = null, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await findDelivery(messageId, apiKey, endpointId);
    if (d && d.failureReason !== null) return d;
    if (Date.now() > deadline) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── Provision a tenant + key ────────────────────────────────────────────────
const appRes = await api("POST", "/v1/admin/apps", { name: "smoke" }, ADMIN);
const appId = appRes.body.id;
const apiKey = (await api("POST", `/v1/admin/apps/${appId}/keys`, {}, ADMIN)).body.secret;
check("provisioned app + key", Boolean(appId) && Boolean(apiKey));

// ── Case 1: HTTP 5xx → failureReason "http_5xx" ─────────────────────────────
await api("POST", "/v1/endpoints", { url: receiverUrl }, apiKey);
const m1 = await api("POST", "/v1/messages", { eventType: "e", payload: { n: 1 } }, apiKey);
const id1 = m1.body.message.id;
const a1 = await waitForAttempt(id1, apiKey);
check("5xx: an attempt was recorded", Boolean(a1));
check("5xx: outcome failed", a1?.outcome === "failed");
check("5xx: responseStatus 500", a1?.responseStatus === 500);
check("5xx: failureReason classified http_5xx", a1?.failureReason === "http_5xx", `(got ${a1?.failureReason})`);
// The same structured code is denormalized onto the delivery task itself (GET /v1/deliveries).
const d1 = await waitForDeliveryReason(id1, apiKey);
check("5xx: delivery.failureReason denormalized http_5xx", d1?.failureReason === "http_5xx", `(got ${d1?.failureReason})`);

// ── Case 2: refused connection → failureReason "connection_refused" ─────────
const ep2 = await api("POST", "/v1/endpoints", { url: deadUrl }, apiKey);
// Subscribe only the dead endpoint by disabling the 5xx one for this message's app would
// affect case 1's retries; instead send to all and locate the dead-endpoint attempt.
const m2 = await api("POST", "/v1/messages", { eventType: "e", payload: { n: 2 } }, apiKey);
const id2 = m2.body.message.id;
// Wait until the dead endpoint's task has at least one attempt, then find it by endpointId.
let a2 = null;
{
  const deadline = Date.now() + 8000;
  for (;;) {
    const res = await api("GET", `/v1/messages/${id2}/attempts`, undefined, apiKey);
    a2 = (res.body?.data ?? []).find((a) => a.endpointId === ep2.body.id) ?? null;
    if (a2 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}
check("refused: the dead-endpoint attempt was recorded", Boolean(a2));
check("refused: responseStatus null (no response)", a2?.responseStatus === null);
check(
  "refused: failureReason classified connection_refused",
  a2?.failureReason === "connection_refused",
  `(got ${a2?.failureReason})`,
);
// And denormalized onto the dead-endpoint delivery task.
const d2 = await waitForDeliveryReason(id2, apiKey, ep2.body.id);
check(
  "refused: delivery.failureReason denormalized connection_refused",
  d2?.failureReason === "connection_refused",
  `(got ${d2?.failureReason})`,
);

// ── Case 2.5: the ?failureReason= triage filter (one-query failure lookup) ──
// id1 fanned to one endpoint (http_5xx). id2 fanned to BOTH endpoints, so it has an
// http_5xx task (receiver) and a connection_refused task (dead port). The filter must
// return only rows matching the requested reason — no cross-reason leakage.
const only5xx = await api("GET", "/v1/deliveries?failureReason=http_5xx", undefined, apiKey);
const rows5xx = only5xx.body?.data ?? [];
check("filter http_5xx: returns at least one row", rows5xx.length >= 1);
check("filter http_5xx: every row carries http_5xx", rows5xx.every((d) => d.failureReason === "http_5xx"));
check("filter http_5xx: includes id1's delivery", rows5xx.some((d) => d.messageId === id1));

const onlyRefused = await api("GET", "/v1/deliveries?failureReason=connection_refused", undefined, apiKey);
const rowsRefused = onlyRefused.body?.data ?? [];
check("filter connection_refused: returns at least one row", rowsRefused.length >= 1);
check(
  "filter connection_refused: every row carries connection_refused (no http_5xx leakage)",
  rowsRefused.every((d) => d.failureReason === "connection_refused"),
);
check(
  "filter connection_refused: includes the dead-endpoint delivery",
  rowsRefused.some((d) => d.endpointId === ep2.body.id),
);

// An unrecognised reason code is a 400, not a silent empty list.
const badReason = await api("GET", "/v1/deliveries?failureReason=not_a_reason", undefined, apiKey);
check("filter: unrecognised failureReason → 400", badReason.status === 400, `(got ${badReason.status})`);

// ── Case 3: the reason survives a restart on the same node:sqlite files ─────
await gw.stop();
gw = boot();
addr = await gw.start();
base = `http://127.0.0.1:${addr.port}`;
const after = await api("GET", `/v1/messages/${id1}/attempts`, undefined, apiKey);
const survived = after.body?.data?.[0];
check("restart: the recorded attempt survives", Boolean(survived));
check("restart: failureReason still http_5xx", survived?.failureReason === "http_5xx", `(got ${survived?.failureReason})`);
// The denormalized task-level reason survives too — proves the new failure_reason column
// is persisted and re-hydrated from node:sqlite, not just held in memory.
const d1after = await findDelivery(id1, apiKey);
check(
  "restart: delivery.failureReason persisted http_5xx",
  d1after?.failureReason === "http_5xx",
  `(got ${d1after?.failureReason})`,
);

// ── Case 4: the dead-letter-by-reason gauge is served over /metrics ─────────
// The compiled route runs countDeadLettersByReason() against the real node:sqlite
// backend and renders it; a wiring/query fault would 500 or drop the family. (The
// failing tasks above are still pending/retrying, not dead-lettered, so the current
// values are 0 — the grouped non-zero counting is proven in the queue conformance suite.)
const metricsRes = await fetch(`${base}/metrics`);
const metricsText = await metricsRes.text();
check("metrics: GET /metrics 200", metricsRes.status === 200, `(got ${metricsRes.status})`);
check(
  "metrics: posthorn_dead_letter_tasks family declared as a gauge",
  metricsText.includes("# TYPE posthorn_dead_letter_tasks gauge"),
);
check(
  "metrics: the gauge carries every reason label (zeros included)",
  metricsText.includes('posthorn_dead_letter_tasks{reason="connection_refused"} 0') &&
    metricsText.includes('posthorn_dead_letter_tasks{reason="http_5xx"} 0') &&
    metricsText.includes('posthorn_dead_letter_tasks{reason="other"} 0'),
);

// ── Teardown ────────────────────────────────────────────────────────────────
await gw.stop();
receiver.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
