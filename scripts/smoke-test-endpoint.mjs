/**
 * Smoke test for `POST /v1/endpoints/:id/test` — compiled-dist validation.
 *
 * Runs through production ESM on :memory: SQLite:
 *   provision → create endpoint → test (success path) → test (failure path)
 *   → test with custom eventType/payload → catalog-driven test (schemaExample,
 *   explicit-payload override, unknown-type fallback) → 404 unknown → 400 disabled
 *   → auth guard
 */
import { createGateway, loadConfig } from "../dist/index.js";
import { createServer } from "node:http";

let pass = 0; let fail = 0;
function check(label, ok, extra = "") {
  if (ok) { console.log(`✓ ${label}${extra ? " " + extra : ""}`); pass++; }
  else { console.error(`✗ ${label}${extra ? " " + extra : ""}`); fail++; }
}

// ── Spin up a real receiver HTTP server ────────────────────────────────────
let receiverStatusToReturn = 200;
const receivedHeaders = [];
const receivedBodies = [];
const receiver = createServer((req, res) => {
  const hdrs = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith("webhook-")) hdrs[k] = v;
  }
  receivedHeaders.push(hdrs);
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    receivedBodies.push(raw);
    res.writeHead(receiverStatusToReturn);
    res.end();
  });
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const receiverPort = receiver.address().port;
const receiverUrl = `http://127.0.0.1:${receiverPort}`;

// ── Boot the gateway ───────────────────────────────────────────────────────
const gw = createGateway(
  loadConfig({
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_ADMIN_TOKEN: "smoke-test-token-for-iter44",
    // This smoke delivers to a loopback receiver; opt out of the SSRF guard.
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
  }),
);
const addr = await gw.start();
const base = `http://127.0.0.1:${addr.port}`;

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
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json };
}

// ── Provision app + key ────────────────────────────────────────────────────
const appRes = await api("POST", "/v1/admin/apps", { name: "smoke" }, "smoke-test-token-for-iter44");
const appId = appRes.body.id;
const keyRes = await api("POST", `/v1/admin/apps/${appId}/keys`, {}, "smoke-test-token-for-iter44");
const apiKey = keyRes.body.secret;
check("provisioned app + key", Boolean(appId) && Boolean(apiKey));

// ── Create endpoint pointed at the local receiver ─────────────────────────
const epRes = await api("POST", "/v1/endpoints", { url: receiverUrl }, apiKey);
check("create endpoint 201", epRes.status === 201);
const epId = epRes.body.id;
const epSecret = epRes.body.secret;

// ── 1. Test delivery → success (receiver returns 200) ─────────────────────
receiverStatusToReturn = 200;
const t1 = await api("POST", `/v1/endpoints/${epId}/test`, {}, apiKey);
check("test delivery success: HTTP 200", t1.status === 200);
check("test delivery success: success=true", t1.body.success === true);
check("test delivery success: httpStatus=200", t1.body.httpStatus === 200);
check("test delivery success: durationMs is number", typeof t1.body.durationMs === "number");
check("test delivery success: payloadSource=default (no catalog match)", t1.body.payloadSource === "default");
check("receiver got exactly one request", receivedHeaders.length === 1);
check("received webhook-id starts with test_", String(receivedHeaders[0]?.["webhook-id"] ?? "").startsWith("test_"));
check("received webhook-signature header present", Boolean(receivedHeaders[0]?.["webhook-signature"]));

// ── 2. Test delivery → failure (receiver returns 500) ─────────────────────
receiverStatusToReturn = 500;
const t2 = await api("POST", `/v1/endpoints/${epId}/test`, {}, apiKey);
check("test delivery failure: HTTP 200", t2.status === 200);
check("test delivery failure: success=false", t2.body.success === false);
check("test delivery failure: httpStatus=500", t2.body.httpStatus === 500);
check("test delivery failure: no error field", t2.body.error === undefined);

// ── 3. Test delivery with custom eventType + payload ──────────────────────
receiverStatusToReturn = 201;
const t3 = await api("POST", `/v1/endpoints/${epId}/test`, { eventType: "user.created", payload: { id: 42 } }, apiKey);
check("custom eventType test: HTTP 200", t3.status === 200);
check("custom eventType test: success=true (201 is 2xx)", t3.body.success === true);
check("custom eventType test: httpStatus=201", t3.body.httpStatus === 201);
check("custom eventType test: payloadSource=request (explicit payload)", t3.body.payloadSource === "request");

// ── 3b. Catalog-driven test payload — the event type's schemaExample ──────
// Register a catalog event type carrying a sample payload, then send a test
// that references it WITHOUT an explicit payload: the receiver should get the
// registered schemaExample verbatim and the result should report source=catalog.
receiverStatusToReturn = 200;
const catalogExample = JSON.stringify({ invoiceId: "in_123", amountCents: 4200 });
const etRes = await api(
  "POST",
  "/v1/event-types",
  { id: "invoice.paid", name: "Invoice Paid", schemaExample: catalogExample },
  apiKey,
);
check("create event type with schemaExample → 201", etRes.status === 201);

const beforeCatalog = receivedBodies.length;
const tc1 = await api("POST", `/v1/endpoints/${epId}/test`, { eventType: "invoice.paid" }, apiKey);
check("catalog test: HTTP 200", tc1.status === 200);
check("catalog test: payloadSource=catalog", tc1.body.payloadSource === "catalog");
check("catalog test: receiver got the schemaExample body", receivedBodies[beforeCatalog] === catalogExample);

// A caller-supplied payload still wins over the catalog example.
const tc2 = await api(
  "POST",
  `/v1/endpoints/${epId}/test`,
  { eventType: "invoice.paid", payload: { override: true } },
  apiKey,
);
check("catalog test: explicit payload overrides → payloadSource=request", tc2.body.payloadSource === "request");
check(
  "catalog test: receiver got the explicit body",
  receivedBodies[beforeCatalog + 1] === JSON.stringify({ override: true }),
);

// An unknown event type falls back to the generic event.
const tc3 = await api("POST", `/v1/endpoints/${epId}/test`, { eventType: "no.such.type" }, apiKey);
check("catalog test: unknown type → payloadSource=default", tc3.body.payloadSource === "default");
check(
  "catalog test: receiver got the generic body",
  receivedBodies[beforeCatalog + 2] === JSON.stringify({ test: true }),
);

// ── 4. Test delivery doesn't pollute message store ────────────────────────
const msgList = await api("GET", "/v1/messages", undefined, apiKey);
check("test deliveries not stored in message list", msgList.body.data.length === 0);

// ── 5. 404 for unknown endpoint ───────────────────────────────────────────
const t5 = await api("POST", "/v1/endpoints/ep_unknown/test", {}, apiKey);
check("test unknown endpoint → 404", t5.status === 404);

// ── 6. 400 for disabled endpoint ──────────────────────────────────────────
await api("PATCH", `/v1/endpoints/${epId}`, { disabled: true }, apiKey);
const t6 = await api("POST", `/v1/endpoints/${epId}/test`, {}, apiKey);
check("test disabled endpoint → 400", t6.status === 400);
check("test disabled endpoint → code=endpoint_disabled", t6.body?.error?.code === "endpoint_disabled");

// ── 7. Auth guard ─────────────────────────────────────────────────────────
const t7 = await fetch(`${base}/v1/endpoints/${epId}/test`, { method: "POST" });
check("test without auth → 401", t7.status === 401);

// ── Teardown ───────────────────────────────────────────────────────────────
await gw.stop();
receiver.close();

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
