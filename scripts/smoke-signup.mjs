// Compiled-dist smoke: opt-in self-serve signup, through production ESM.
// Proves three things end-to-end on the compiled output:
//  1. The env→config wiring: signup defaults to disabled, parses when enabled,
//     reads the rate-limit cap, and rejects a non-integer cap at boot.
//  2. A running gateway with signup ON: POST /v1/signup mints a free-plan tenant +
//     its first key, returns the one-time secret, that key authenticates a real
//     tenant call, and the global rate limit yields 429 + Retry-After over the cap.
//  3. A running gateway with signup OFF (the open-core default): the route is 404,
//     indistinguishable from a nonexistent path.
// Hits 127.0.0.1 (the IPv4 bind), matching the other dist smokes.
import { loadConfig, ConfigError } from "../dist/runtime/config.js";
import { createGateway } from "../dist/runtime/gateway.js";

let passed = 0;
function check(label, cond) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
  passed++;
}

// ── 1. Config wiring through dist ────────────────────────────────────────────
{
  const def = loadConfig({});
  check("config: signup defaults to disabled",
    def.signup.enabled === false);
  check("config: signup rate limit defaults to 10/min",
    def.signup.ratePerMinute === 10);

  const c = loadConfig({
    POSTHORN_SIGNUP_ENABLED: "true",
    POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE: "25",
  });
  check("config: signup parses enabled + custom rate cap",
    c.signup.enabled === true && c.signup.ratePerMinute === 25);

  let threw = false;
  try { loadConfig({ POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE: "nope" }); }
  catch (e) { threw = e instanceof ConfigError; }
  check("config: a non-integer rate cap is rejected at boot", threw);

  let threw2 = false;
  try { loadConfig({ POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE: "0" }); }
  catch (e) { threw2 = e instanceof ConfigError; }
  check("config: a rate cap below the 1 floor is rejected at boot", threw2);
}

// ── 2. Running gateway, signup ON: mint a tenant, key works, rate limit bites ──
{
  const config = loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
    POSTHORN_SIGNUP_ENABLED: "true",
    POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE: "2",
  });
  const gw = createGateway(config);
  const { port } = await gw.start();
  const signupUrl = `http://127.0.0.1:${port}/v1/signup`;
  try {
    const res = await fetch(signupUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    const b = await res.json();
    check("gateway(on): signup mints a free-plan tenant (201)",
      res.status === 201 && b.app.name === "Acme" && b.app.plan === "free" &&
      b.app.monthlyMessageQuota === 1000);
    check("gateway(on): returns the one-time secret + first key bound to the tenant",
      typeof b.secret === "string" && b.secret.startsWith("phk_") &&
      b.apiKey.appId === b.app.id);

    // The minted key authenticates a real tenant call end-to-end.
    const probe = await fetch(`http://127.0.0.1:${port}/v1/endpoints`, {
      headers: { authorization: `Bearer ${b.secret}` },
    });
    check("gateway(on): the minted key authenticates GET /v1/endpoints (200)",
      probe.status === 200);

    // Second signup is still inside the cap (2/min) → 201.
    const second = await fetch(signupUrl, { method: "POST" });
    check("gateway(on): a second signup within the cap succeeds (201)",
      second.status === 201);

    // Third signup exceeds the 2/min cap (same wall-clock minute) → 429.
    const limited = await fetch(signupUrl, { method: "POST" });
    const limitedBody = await limited.json();
    check("gateway(on): the global rate limit yields 429 over the cap",
      limited.status === 429 && limitedBody.error.code === "rate_limited");
    check("gateway(on): the 429 carries a Retry-After back-off in seconds",
      Number(limited.headers.get("retry-after")) >= 1);
  } finally {
    await gw.stop();
  }
}

// ── 3. Running gateway, signup OFF (default): the route is 404 ─────────────────
{
  const config = loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
  });
  const gw = createGateway(config);
  const { port } = await gw.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    check("gateway(off): the signup route is 404 when signup is disabled",
      res.status === 404);
  } finally {
    await gw.stop();
  }
}

console.log(`\nSIGNUP_SMOKE_PASS ${passed}/${passed}`);
