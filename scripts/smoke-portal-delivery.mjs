import { createGateway, loadConfig } from "../dist/index.js";

const gw = createGateway(loadConfig({
  POSTHORN_DATA_DIR: ":memory:",
  POSTHORN_ADMIN_TOKEN: "smoke-test-token-42",
  // This smoke delivers to a loopback receiver; opt out of the SSRF guard.
  POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
}));
const addr = await gw.start();
const base = `http://127.0.0.1:${addr.port}`;

let pass = 0; let fail = 0;
function check(label, ok, extra = "") {
  if (ok) { console.log(`✓ ${label}${extra ? " " + extra : ""}`); pass++; }
  else { console.error(`✗ ${label}${extra ? " " + extra : ""}`); fail++; }
}

// 1. Provision app + key
const appRes = await fetch(`${base}/v1/admin/apps`, {
  method: "POST",
  headers: { Authorization: "Bearer smoke-test-token-42", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "smoke" }),
});
const { id: appId } = await appRes.json();

const keyRes = await fetch(`${base}/v1/admin/apps/${appId}/keys`, {
  method: "POST",
  headers: { Authorization: "Bearer smoke-test-token-42", "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
const { secret } = await keyRes.json();

// 2. Create portal session
const psRes = await fetch(`${base}/v1/portal/sessions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
  body: JSON.stringify({ externalUserId: "ext_u1" }),
});
const { token, portalUrl } = await psRes.json();
check("portal session 201", psRes.status === 201);
// With no POSTHORN_PUBLIC_BASE_URL configured, portalUrl is derived from the request
// Host (the loopback addr this smoke connects to).
check("portalUrl derived from request host when no base URL configured",
  portalUrl === `http://127.0.0.1:${addr.port}/portal/login?token=${token}`, portalUrl);

// 3. Exchange token for cookie
const loginRes = await fetch(`${base}/portal/login?token=${token}`, { redirect: "manual" });
const cookie = loginRes.headers.get("set-cookie") ?? "";
const sessionCookie = cookie.split(";")[0] ?? "";
check("login exchange 302", loginRes.status === 302);

// 4. Create endpoint via portal
const createEpRes = await fetch(`${base}/portal/endpoints`, {
  method: "POST",
  headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
  body: "url=https%3A%2F%2Frecv.example%2Fhook",
});
check("portal create endpoint 200", createEpRes.status === 200);

// 5. Ingest a message so a delivery task is created
const msgRes = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
  body: JSON.stringify({ eventType: "test.event", payload: { x: 1 } }),
});
check("ingest 202", msgRes.status === 202);

// Short wait for fan-out dispatcher to process
await new Promise(r => setTimeout(r, 200));

// 6. List portal endpoints to find ep id
const epListRes = await fetch(`${base}/portal/endpoints`, { headers: { Cookie: sessionCookie } });
const epListHtml = await epListRes.text();
const epIdMatch = epListHtml.match(/\/portal\/endpoints\/(ep_[A-Za-z0-9_-]+)/);
const epId = epIdMatch?.[1];
check("endpoint id in portal list", !!epId);

if (epId) {
  // 7. Endpoint detail — shows delivery list with clickable links
  const detailRes = await fetch(`${base}/portal/endpoints/${epId}`, { headers: { Cookie: sessionCookie } });
  const detailHtml = await detailRes.text();
  check("endpoint detail 200", detailRes.status === 200);
  const delivLinkMatch = detailHtml.match(/href="(\/portal\/endpoints\/ep_[A-Za-z0-9_-]+\/deliveries\/dtask_[A-Za-z0-9_-]+)"/);
  check("delivery rows are clickable links", !!delivLinkMatch);

  if (delivLinkMatch) {
    const delivPath = delivLinkMatch[1];
    const deliveryId = delivPath.split("/").pop();

    // 8. Delivery detail page
    const delivRes = await fetch(`${base}${delivPath}`, { headers: { Cookie: sessionCookie } });
    const delivHtml = await delivRes.text();
    check("delivery detail 200", delivRes.status === 200);
    check("delivery detail shows messageId", delivHtml.includes("msg_"));
    check("delivery detail shows status pill", delivHtml.includes("pending"));

    // 9. Cross-endpoint protection — use a fake endpoint id
    const xepRes = await fetch(`${base}/portal/endpoints/ep_fake/deliveries/${deliveryId}`, { headers: { Cookie: sessionCookie } });
    check("cross-endpoint delivery returns 404", xepRes.status === 404);

    // 10. ?retried=1 banner
    const retriedRes = await fetch(`${base}${delivPath}?retried=1`, { headers: { Cookie: sessionCookie } });
    const retriedHtml = await retriedRes.text();
    check("?retried=1 shows success banner", retriedHtml.includes("Delivery queued for retry"));
  }
}

await gw.stop();

// 11. A second gateway with POSTHORN_PUBLIC_BASE_URL configured: the minted
// portalUrl must use that canonical origin, not the request's loopback Host —
// exercising the full config → gateway → api wiring through compiled ESM.
const PUBLIC_BASE = "https://hooks.smoke.example";
const gw2 = createGateway(loadConfig({
  POSTHORN_DATA_DIR: ":memory:",
  POSTHORN_PORT: "0", // ephemeral port — avoid racing the just-stopped gateway's socket
  POSTHORN_ADMIN_TOKEN: "smoke-test-token-42",
  POSTHORN_PUBLIC_BASE_URL: `${PUBLIC_BASE}/`, // trailing slash → normalized away at load
}));
const addr2 = await gw2.start();
const base2 = `http://127.0.0.1:${addr2.port}`;
const app2 = await (await fetch(`${base2}/v1/admin/apps`, {
  method: "POST",
  headers: { Authorization: "Bearer smoke-test-token-42", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "smoke2" }),
})).json();
const { secret: secret2 } = await (await fetch(`${base2}/v1/admin/apps/${app2.id}/keys`, {
  method: "POST",
  headers: { Authorization: "Bearer smoke-test-token-42", "Content-Type": "application/json" },
  body: JSON.stringify({}),
})).json();
const ps2Res = await fetch(`${base2}/v1/portal/sessions`, {
  method: "POST",
  // A spoofed X-Forwarded-Proto/Host must be ignored once a base URL is configured.
  headers: { Authorization: `Bearer ${secret2}`, "Content-Type": "application/json", "X-Forwarded-Proto": "http" },
  body: JSON.stringify({ externalUserId: "ext_u2" }),
});
const ps2 = await ps2Res.json();
check("portalUrl uses configured POSTHORN_PUBLIC_BASE_URL",
  ps2.portalUrl === `${PUBLIC_BASE}/portal/login?token=${ps2.token}`, ps2.portalUrl);
await gw2.stop();

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
