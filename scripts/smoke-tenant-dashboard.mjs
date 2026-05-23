/**
 * Compiled-dist smoke test: tenant dashboard UI end-to-end.
 *
 * Boots a real gateway, provisions a tenant + key over the admin API, then drives
 * the tenant dashboard through a live HTTP session to verify:
 *  1. GET /dashboard/tenant/login → 200 HTML with login form
 *  2. POST /dashboard/tenant/login with wrong key → 200 + error
 *  3. POST /dashboard/tenant/login with correct key → 302 + ph_tenant_session cookie
 *  4. Session cookie authenticates GET /dashboard/tenant/messages → 200 HTML
 *  5. Messages page is scoped to the tenant (other tenant's messages absent)
 *  6. GET /dashboard/tenant redirects to messages
 *  7. After sending a message, message appears in the list
 *  8. GET /dashboard/tenant/messages/:id shows message detail with payload
 *  9. GET /dashboard/tenant/endpoints shows endpoint list
 * 10. POST /dashboard/tenant/logout clears session → subsequent request redirects to login
 * 11. Unauthenticated GET /dashboard/tenant/messages → 302 to login
 */

import { createGateway } from "../dist/runtime/gateway.js";

let gateway;
let checks = 0;
let passed = 0;

function check(label, condition) {
  checks++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
  }
}

async function main() {
  const ADMIN_TOKEN = "smoke-admin-token-long-enough-32chars";
  gateway = createGateway({
    host: "127.0.0.1",
    port: 0,
    dataDir: ":memory:",
    maxBodyBytes: 1_000_000,
    adminToken: ADMIN_TOKEN,
    endpointAutoDisableAfterMs: 0,
    worker: { batchSize: 10, concurrency: 4, requestTimeoutMs: 5_000, idlePollMs: 50, visibilityTimeoutMs: 30_000 },
    fanout: { graceMs: 500, batchSize: 10, idlePollMs: 50 },
  });
  const { port } = await gateway.start();
  const base = `http://127.0.0.1:${port}`;

  // ── Provision a tenant + key over the admin API ──────────────────────────
  const appRes = await fetch(`${base}/v1/admin/apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "SmokeApp" }),
  });
  const { id: appId } = await appRes.json();

  const keyRes = await fetch(`${base}/v1/admin/apps/${appId}/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  const { secret: apiKey } = await keyRes.json();

  // ── Provision a second tenant to verify isolation ────────────────────────
  const app2Res = await fetch(`${base}/v1/admin/apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "OtherApp" }),
  });
  const { id: app2Id } = await app2Res.json();
  const key2Res = await fetch(`${base}/v1/admin/apps/${app2Id}/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  const { secret: apiKey2 } = await key2Res.json();

  // Other tenant sends a message that should NOT appear in App1's dashboard.
  await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey2}`, "content-type": "application/json" },
    body: JSON.stringify({ eventType: "other.tenant.event", payload: { secret: "other" } }),
  });

  // ── 1. GET /dashboard/tenant/login → 200 HTML ────────────────────────────
  const loginGet = await fetch(`${base}/dashboard/tenant/login`, { redirect: "manual" });
  check("GET /dashboard/tenant/login → 200 HTML", loginGet.status === 200);
  const loginHtml = await loginGet.text();
  check("Login page contains apikey input", loginHtml.includes("apikey"));

  // ── 2. Wrong key → 200 + error ───────────────────────────────────────────
  const wrongKey = await fetch(`${base}/dashboard/tenant/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "apikey=phk_bogus",
    redirect: "manual",
  });
  check("POST login with wrong key → 200", wrongKey.status === 200);
  check("Wrong key shows error message", (await wrongKey.text()).includes("Invalid API key"));

  // ── 3. Correct key → 302 + session cookie ────────────────────────────────
  const loginPost = await fetch(`${base}/dashboard/tenant/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `apikey=${encodeURIComponent(apiKey)}`,
    redirect: "manual",
  });
  check("POST login with correct key → 302", loginPost.status === 302);
  const rawCookie = loginPost.headers.get("set-cookie") ?? "";
  const cookieMatch = rawCookie.match(/ph_tenant_session=([^;]+)/);
  check("Login sets ph_tenant_session cookie", cookieMatch !== null);
  check("Cookie is HttpOnly", rawCookie.includes("HttpOnly"));
  check("Cookie is SameSite=Strict", rawCookie.includes("SameSite=Strict"));
  const sessionCookie = `ph_tenant_session=${cookieMatch?.[1] ?? ""}`;

  // ── 4. Authenticated GET /dashboard/tenant/messages → 200 ────────────────
  const msgList = await fetch(`${base}/dashboard/tenant/messages`, {
    headers: { cookie: sessionCookie },
    redirect: "manual",
  });
  check("Authenticated GET /dashboard/tenant/messages → 200", msgList.status === 200);

  // ── 5. Other tenant's message not visible ────────────────────────────────
  const msgListBody = await msgList.text();
  check("Other tenant's event not in messages list", !msgListBody.includes("other.tenant.event"));

  // ── 6. GET /dashboard/tenant → redirects to messages ─────────────────────
  const rootRedirect = await fetch(`${base}/dashboard/tenant`, {
    headers: { cookie: sessionCookie },
    redirect: "manual",
  });
  check("GET /dashboard/tenant → 302 to messages", rootRedirect.status === 302);

  // ── 7. Send a message and verify it appears in the list ──────────────────
  await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ eventType: "smoke.event", payload: { hello: "world" } }),
  });
  const msgList2 = await fetch(`${base}/dashboard/tenant/messages`, {
    headers: { cookie: sessionCookie },
    redirect: "manual",
  });
  const msgList2Body = await msgList2.text();
  check("Sent message appears in messages list", msgList2Body.includes("smoke.event"));

  // ── 8. Message detail shows payload ──────────────────────────────────────
  // Extract message id from the list page (it's in the href)
  const hrefMatch = msgList2Body.match(/href="\/dashboard\/tenant\/messages\/(msg_[^"]+)"/);
  check("Message id found in list HTML", hrefMatch !== null);
  if (hrefMatch) {
    const msgId = hrefMatch[1];
    const detail = await fetch(`${base}/dashboard/tenant/messages/${msgId}`, {
      headers: { cookie: sessionCookie },
      redirect: "manual",
    });
    check("GET message detail → 200", detail.status === 200);
    const detailBody = await detail.text();
    check("Detail page contains event type", detailBody.includes("smoke.event"));
    check("Detail page contains payload", detailBody.includes("hello"));
  }

  // ── 9. Endpoints page ────────────────────────────────────────────────────
  const epsPage = await fetch(`${base}/dashboard/tenant/endpoints`, {
    headers: { cookie: sessionCookie },
    redirect: "manual",
  });
  check("GET /dashboard/tenant/endpoints → 200", epsPage.status === 200);
  const epsBody = await epsPage.text();
  check("Endpoints page shows empty state (no endpoints registered)", epsBody.includes("No endpoints"));

  // ── 10. Logout clears session ─────────────────────────────────────────────
  const logout = await fetch(`${base}/dashboard/tenant/logout`, {
    method: "POST",
    headers: { cookie: sessionCookie },
    redirect: "manual",
  });
  check("POST logout → 302", logout.status === 302);
  const clearCookie = logout.headers.get("set-cookie") ?? "";
  check("Logout sets Max-Age=0 to clear cookie", clearCookie.includes("Max-Age=0"));

  // ── 11. Unauthenticated request after logout → redirect ───────────────────
  const unauth = await fetch(`${base}/dashboard/tenant/messages`, {
    redirect: "manual",
  });
  check("Unauthenticated GET /dashboard/tenant/messages → 302 to login", unauth.status === 302);
  check(
    "Redirect target is login page",
    (unauth.headers.get("location") ?? "").includes("/dashboard/tenant/login"),
  );

  console.log(`\n${passed}/${checks} checks PASS`);
  if (passed !== checks) process.exit(1);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => gateway?.stop().catch(() => {}));
