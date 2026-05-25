// Compiled-dist smoke: HTTP Strict Transport Security through production ESM.
// Proves the pure header builder + per-surface merge, the env→config validation
// (including the fail-fast preload rules), and — end-to-end on a running gateway —
// that the configured `Strict-Transport-Security` header is stamped on every
// surface over a real socket, and is absent by default. Hits 127.0.0.1 (the IPv4
// bind), matching the other dist smokes.
import { hstsHeaderValue, securityHeadersForPath } from "../dist/http/security-headers.js";
import { loadConfig, ConfigError } from "../dist/runtime/config.js";
import { createGateway } from "../dist/runtime/gateway.js";

let passed = 0;
function check(label, cond) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
  passed++;
}

// ── 1. Pure builder: disabled / enabled / directive ordering ─────────────────
{
  check("builder: max-age 0 → disabled (null)",
    hstsHeaderValue({ maxAgeSeconds: 0, includeSubDomains: true, preload: false }) === null);
  check("builder: bare max-age",
    hstsHeaderValue({ maxAgeSeconds: 31536000, includeSubDomains: false, preload: false })
      === "max-age=31536000");
  check("builder: includeSubDomains then preload, conventional order",
    hstsHeaderValue({ maxAgeSeconds: 31536000, includeSubDomains: true, preload: true })
      === "max-age=31536000; includeSubDomains; preload");
}

// ── 2. Per-surface merge: transport header rides on every surface, or none ───
{
  const sts = "max-age=600; includeSubDomains";
  for (const p of ["/v1/endpoints", "/dashboard", "/portal", "/healthz", "/openapi.json"]) {
    check(`merge: STS stamped on ${p}`,
      securityHeadersForPath(p, sts)["strict-transport-security"] === sts);
    check(`merge: ${p} carries no STS by default`,
      securityHeadersForPath(p)["strict-transport-security"] === undefined);
  }
}

// ── 3. Config validation through dist ────────────────────────────────────────
{
  check("config: default is HSTS off",
    loadConfig({}).hsts.maxAgeSeconds === 0);
  const c = loadConfig({
    POSTHORN_HSTS_MAX_AGE: "31536000",
    POSTHORN_HSTS_INCLUDE_SUBDOMAINS: "true",
    POSTHORN_HSTS_PRELOAD: "true",
  });
  check("config: full preload-valid policy parses",
    c.hsts.maxAgeSeconds === 31536000 && c.hsts.includeSubDomains && c.hsts.preload);

  let threw = false;
  try { loadConfig({ POSTHORN_HSTS_MAX_AGE: "31536000", POSTHORN_HSTS_PRELOAD: "true" }); }
  catch (e) { threw = e instanceof ConfigError; }
  check("config: preload without includeSubDomains is rejected at boot", threw);

  let threw2 = false;
  try { loadConfig({ POSTHORN_HSTS_INCLUDE_SUBDOMAINS: "true" }); }
  catch (e) { threw2 = e instanceof ConfigError; }
  check("config: a modifier without max-age is rejected at boot", threw2);
}

// ── 4. Running gateway, HSTS ON: the header reaches the wire on every surface ─
{
  const config = loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
    POSTHORN_HSTS_MAX_AGE: "31536000",
    POSTHORN_HSTS_INCLUDE_SUBDOMAINS: "true",
  });
  const gw = createGateway(config);
  const { port } = await gw.start();
  try {
    const expected = "max-age=31536000; includeSubDomains";
    // API surface (transport-level: present even though it's JSON, not HTML).
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    check("gateway(on): /healthz carries the configured STS header",
      health.headers.get("strict-transport-security") === expected);
    const api = await fetch(`http://127.0.0.1:${port}/v1/endpoints`); // 401, still stamped
    check("gateway(on): an unauthenticated 401 still carries STS",
      api.status === 401 && api.headers.get("strict-transport-security") === expected);
  } finally {
    await gw.stop();
  }
}

// ── 5. Running gateway, HSTS OFF (default): no header on the wire ─────────────
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
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    check("gateway(off): /healthz carries no STS header by default",
      health.headers.get("strict-transport-security") === null);
  } finally {
    await gw.stop();
  }
}

console.log(`\nHSTS_SMOKE_PASS ${passed}/${passed}`);
