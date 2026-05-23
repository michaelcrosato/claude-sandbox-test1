/**
 * Compiled-dist smoke test for the admin dashboard.
 * Proves the dashboard serves HTML, session auth works, and app/key management
 * round-trips through production ESM (including the node:sqlite createRequire path).
 *
 * Run: node scripts/smoke-dashboard.mjs
 */

import { createGateway } from "../dist/runtime/gateway.js";

const ADMIN_TOKEN = "smoke-test-admin-token-ok";

const gw = createGateway({
  host: "127.0.0.1",
  port: 0,
  dataDir: ":memory:",
  maxBodyBytes: 1_000_000,
  adminToken: ADMIN_TOKEN,
  endpointAutoDisableAfterMs: 0,
  worker: {
    batchSize: 10,
    concurrency: 4,
    requestTimeoutMs: 5_000,
    idlePollMs: 50,
    visibilityTimeoutMs: 30_000,
  },
  fanout: { graceMs: 500, batchSize: 10, idlePollMs: 50 },
});

const { port } = await gw.start();
const base = `http://127.0.0.1:${port}`;

let passed = 0;
function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ✓ ${label}`);
  passed++;
}

// ── 1. Login page served as HTML ─────────────────────────────────────────────
{
  const res = await fetch(`${base}/dashboard/login`);
  assert("GET /dashboard/login → 200", res.status === 200);
  assert("GET /dashboard/login → text/html", res.headers.get("content-type").includes("text/html"));
  const body = await res.text();
  assert("Login page contains form", body.includes("Sign in"));
}

// ── 2. Wrong token is rejected ────────────────────────────────────────────────
{
  const res = await fetch(`${base}/dashboard/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "token=wrong-token",
    redirect: "manual",
  });
  assert("POST /dashboard/login wrong token → 200", res.status === 200);
  const body = await res.text();
  assert("Wrong token → error shown", body.includes("Invalid admin token"));
}

// ── 3. Correct token sets a session cookie and redirects ──────────────────────
{
  const res = await fetch(`${base}/dashboard/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(ADMIN_TOKEN)}`,
    redirect: "manual",
  });
  assert("POST /dashboard/login correct token → 302", res.status === 302);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert("Set-Cookie contains ph_session", setCookie.includes("ph_session="));
  assert("Set-Cookie is HttpOnly", setCookie.includes("HttpOnly"));
}

// ── 4. Authenticated session can browse apps and create one ───────────────────
// First get a session cookie
const loginRes = await fetch(`${base}/dashboard/login`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: `token=${encodeURIComponent(ADMIN_TOKEN)}`,
  redirect: "manual",
});
const rawCookie = loginRes.headers.get("set-cookie") ?? "";
const sessionMatch = rawCookie.match(/ph_session=([^;]+)/);
const sessionCookie = `ph_session=${sessionMatch[1]}`;

{
  const res = await fetch(`${base}/dashboard/apps`, {
    headers: { cookie: sessionCookie },
  });
  assert("GET /dashboard/apps with session → 200", res.status === 200);
  const body = await res.text();
  assert("Apps page renders", body.includes("Apps"));
}

// ── 5. Create an app via the dashboard ───────────────────────────────────────
{
  const res = await fetch(`${base}/dashboard/apps`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: sessionCookie,
    },
    body: "name=Smoke+Test+App&quota=999",
    redirect: "manual",
  });
  assert("POST /dashboard/apps → 302", res.status === 302);
  const loc = res.headers.get("location") ?? "";
  assert("Redirect to app detail", loc.startsWith("/dashboard/apps/app_"));

  // Fetch app detail
  const detailRes = await fetch(`${base}${loc}`, {
    headers: { cookie: sessionCookie },
  });
  assert("GET /dashboard/apps/:id → 200", detailRes.status === 200);
  const body = await detailRes.text();
  assert("App detail shows app name", body.includes("Smoke Test App"));
  assert("App detail shows quota", body.includes("999"));

  // ── 6. Create an API key via the dashboard ────────────────────────────────
  const appId = loc.replace("/dashboard/apps/", "");
  const keyRes = await fetch(`${base}/dashboard/apps/${appId}/keys`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: sessionCookie,
    },
    body: "",
    redirect: "manual",
  });
  assert("POST /dashboard/apps/:id/keys → 200 (secret shown)", keyRes.status === 200);
  const keyBody = await keyRes.text();
  assert("Key creation page shows secret banner", keyBody.includes("New API key created"));
  assert("Secret is visible (phk_ prefix)", keyBody.includes("phk_"));

  // Extract the secret from the page (it's between <div class="secret"> and </div>)
  const secretMatch = keyBody.match(/class="secret">([^<]+)</);
  const secret = secretMatch ? secretMatch[1].trim() : null;
  assert("Secret extracted from page", secret !== null && secret.startsWith("phk_"));

  // ── 7. The minted key authenticates a tenant API request ─────────────────
  const authRes = await fetch(`${base}/v1/endpoints`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert("Minted key authenticates the tenant API (200)", authRes.status === 200);

  // ── 8. Delete the app via the dashboard ───────────────────────────────────
  const delRes = await fetch(`${base}/dashboard/apps/${appId}/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: sessionCookie,
    },
    body: "",
    redirect: "manual",
  });
  assert("POST /dashboard/apps/:id/delete → 302", delRes.status === 302);
  assert("Redirect to apps list after delete", delRes.headers.get("location") === "/dashboard/apps");

  // The key no longer authenticates (cascade delete)
  const afterDelRes = await fetch(`${base}/v1/endpoints`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert("Key rejected after app deletion (401)", afterDelRes.status === 401);
}

// ── 9. Logout clears the session ──────────────────────────────────────────────
{
  const res = await fetch(`${base}/dashboard/logout`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: sessionCookie,
    },
    redirect: "manual",
  });
  assert("POST /dashboard/logout → 302", res.status === 302);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert("Logout clears cookie (Max-Age=0)", setCookie.includes("Max-Age=0"));

  // Session is now invalid — apps page redirects to login
  const appsRes = await fetch(`${base}/dashboard/apps`, {
    headers: { cookie: sessionCookie },
    redirect: "manual",
  });
  assert("After logout session is invalid → redirect to login", appsRes.status === 302);
}

await gw.stop();
console.log(`\n${passed}/${passed} checks PASS — dashboard smoke OK`);
