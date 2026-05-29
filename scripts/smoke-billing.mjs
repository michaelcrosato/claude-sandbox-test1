// Compiled-dist smoke: billing behind flags, through production ESM.
// Proves three things end-to-end on the compiled output:
//  1. The Stripe meter-event encoding + headers the provider emits on an outbound
//     usage push, exercised against a recording mock transport (no live Stripe).
//  2. The env→config wiring: provider "none" (default) vs "stripe", and the
//     fail-fast when a stripe provider has no secret key.
//  3. A running gateway: POST /v1/billing/webhook verifies the Stripe signature
//     (200 with the parsed event), rejects a tampered body / missing header (400),
//     and is 404 when billing is disabled (the open-core default).
// Hits 127.0.0.1 (the IPv4 bind), matching the other dist smokes.
import { createHmac } from "node:crypto";
import {
  StripeBillingProvider,
  signStripeSignatureHeader,
  DEFAULT_STRIPE_API_BASE_URL,
} from "../dist/billing/index.js";
import { loadConfig, ConfigError } from "../dist/runtime/config.js";
import { createGateway } from "../dist/runtime/gateway.js";

const WEBHOOK_SECRET = "whsec_smoke_0123456789abcdef0123456789abcdef";

let passed = 0;
function check(label, cond) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
  passed++;
}

// ── 1. Outbound usage push: compiled meter-event encoding via a mock transport ─
{
  const calls = [];
  const transport = async (req, signal) => { calls.push({ req, signal }); return { status: 200 }; };
  const provider = new StripeBillingProvider({
    secretKey: "sk_test_smoke",
    webhookSecret: WEBHOOK_SECRET,
    meterEventName: "posthorn_messages",
    transport,
  });
  check("provider name is stripe", provider.name === "stripe");
  check("provider reports webhookConfigured with a secret set", provider.webhookConfigured === true);

  await provider.reportUsage({
    appId: "app_smoke",
    customerId: "cus_smoke",
    quantity: 7,
    periodStart: 1_700_000_000_000,
    periodEnd: 1_702_592_000_000,
    timestamp: 1_702_592_000_000,
  });
  check("reportUsage made exactly one transport call", calls.length === 1);
  const { req, signal } = calls[0];
  check("POSTs to the Stripe Meter Events endpoint",
    req.method === "POST" && req.url === `${DEFAULT_STRIPE_API_BASE_URL}/v1/billing/meter_events`);
  check("sends the secret key as a Bearer credential",
    req.headers["authorization"] === "Bearer sk_test_smoke");
  check("sends a form-encoded content type",
    req.headers["content-type"] === "application/x-www-form-urlencoded");
  check("uses an idempotency key over (app, period) so a re-push never double-charges",
    req.headers["idempotency-key"] === "posthorn-usage-app_smoke-1700000000000-1702592000000");
  const form = new URLSearchParams(req.body);
  check("form: event_name", form.get("event_name") === "posthorn_messages");
  check("form: timestamp is epoch-ms → unix seconds",
    form.get("timestamp") === String(Math.floor(1_702_592_000_000 / 1000)));
  check("form: identifier is the appId", form.get("identifier") === "app_smoke");
  check("form: payload[stripe_customer_id]", form.get("payload[stripe_customer_id]") === "cus_smoke");
  check("form: payload[value] is the quantity", form.get("payload[value]") === "7");
  check("the attempt is time-bounded by an AbortSignal", signal instanceof AbortSignal);
}

// ── 2. Config wiring through dist ────────────────────────────────────────────
{
  check("config: billing defaults to the disabled none provider",
    loadConfig({}).billing.provider === "none");

  const c = loadConfig({
    POSTHORN_BILLING_PROVIDER: "stripe",
    POSTHORN_STRIPE_SECRET_KEY: "sk_test_x",
    POSTHORN_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  check("config: stripe provider parses with its secret + webhook secret",
    c.billing.provider === "stripe" &&
    c.billing.stripeSecretKey === "sk_test_x" &&
    c.billing.stripeWebhookSecret === WEBHOOK_SECRET);

  let threw = false;
  try { loadConfig({ POSTHORN_BILLING_PROVIDER: "stripe" }); }
  catch (e) { threw = e instanceof ConfigError; }
  check("config: a stripe provider with no secret key is rejected at boot", threw);

  let threw2 = false;
  try { loadConfig({ POSTHORN_BILLING_PROVIDER: "paddle" }); }
  catch (e) { threw2 = e instanceof ConfigError; }
  check("config: an unrecognized provider is rejected at boot", threw2);
}

// ── 3. Running gateway, billing ON: the webhook route verifies signatures ─────
{
  const config = loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: ":memory:",
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
    POSTHORN_BILLING_PROVIDER: "stripe",
    POSTHORN_STRIPE_SECRET_KEY: "sk_test_smoke",
    POSTHORN_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  const gw = createGateway(config);
  const { port } = await gw.start();
  const url = `http://127.0.0.1:${port}/v1/billing/webhook`;
  try {
    const payload = '{"id":"evt_smoke","type":"invoice.paid"}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStripeSignatureHeader(WEBHOOK_SECRET, { timestamp: ts, payload });

    // Sanity: the compiled signer matches a hand-rolled HMAC over `{ts}.{payload}`,
    // secret used verbatim as the UTF-8 key, hex digest (the Stripe convention).
    const expectedHex = createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${payload}`, "utf8").digest("hex");
    check("signer emits the t=<ts>,v1=<hex> wire format", sig === `t=${ts},v1=${expectedHex}`);

    const ok = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body: payload,
    });
    const okBody = await ok.json();
    check("gateway(on): a validly signed webhook is accepted (200, parsed event)",
      ok.status === 200 && okBody.received === true && okBody.handled === true &&
      okBody.type === "invoice.paid");

    // Tampered body: signature no longer matches → 400.
    const tampered = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body: payload + " ",
    });
    const tamperedBody = await tampered.json();
    check("gateway(on): a tampered body is rejected (400 invalid_request)",
      tampered.status === 400 && tamperedBody.error.code === "invalid_request");

    // No signature header at all → 400.
    const unsigned = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    check("gateway(on): a missing Stripe-Signature header is rejected (400)",
      unsigned.status === 400);
  } finally {
    await gw.stop();
  }
}

// ── 4. Running gateway, billing OFF (default): the webhook route is 404 ────────
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
    const res = await fetch(`http://127.0.0.1:${port}/v1/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"type":"invoice.paid"}',
    });
    check("gateway(off): the webhook route is 404 when billing is disabled",
      res.status === 404);
  } finally {
    await gw.stop();
  }
}

console.log(`\nBILLING_SMOKE_PASS ${passed}/${passed}`);
