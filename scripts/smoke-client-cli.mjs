// Compiled-dist smoke: the `posthorn client` tenant CLI, end-to-end through
// production ESM against a live in-process gateway.
//
// It drives the *compiled* runClientCommand (dist/runtime/client-cli.js) with a real
// PosthornClient (dist/sdk/client.js) pointed at a running gateway — the exact path
// `posthorn client <verb>` takes, minus only main.ts's env read. It proves:
//   1. help is config-free: a factory that throws is never invoked for `help`.
//   2. create/list/get/delete-endpoint round-trip through the HTTP API and the
//      create result carries the once-shown signing secret.
//   3. a 404 from the gateway becomes exit 1 + an "API error 404 (...)" stderr line
//      (we reuse the just-deleted endpoint id, which also proves the delete took).
//   4. send + list-messages work even with zero matching endpoints (so the smoke
//      makes no outbound delivery to the public internet), and usage reads back.
// Hits 127.0.0.1 (the IPv4 bind), matching the other dist smokes; an API key is
// minted via POST /v1/signup so the smoke needs no store access.
import { loadConfig } from "../dist/runtime/config.js";
import { createGateway } from "../dist/runtime/gateway.js";
import { runClientCommand } from "../dist/runtime/client-cli.js";
import { PosthornClient } from "../dist/sdk/client.js";

let passed = 0;
function check(label, cond) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
  passed++;
}

// ── help is config-free: the factory must never be called ────────────────────
{
  const out = [];
  let built = false;
  const code = await runClientCommand(["help"], {
    makeClient: () => { built = true; throw new Error("should not be called"); },
    out: (l) => out.push(l),
    err: () => {},
  });
  check("cli help → exit 0, client never built, prints usage",
    code === 0 && built === false && out.join("\n").includes("posthorn client"));
}

// ── A live gateway: mint a key, then drive the CLI end-to-end ─────────────────
const config = loadConfig({
  POSTHORN_HOST: "127.0.0.1",
  POSTHORN_PORT: "0",
  POSTHORN_DATA_DIR: ":memory:",
  POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
  POSTHORN_SIGNUP_ENABLED: "true",
});
const gw = createGateway(config);
const { port } = await gw.start();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  // Mint a tenant + first key via the public signup route (no store access needed).
  const signup = await fetch(`${baseUrl}/v1/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "CLI Smoke" }),
  });
  const minted = await signup.json();
  check("signup minted an API key for the smoke", signup.status === 201 && typeof minted.secret === "string");
  const apiKey = minted.secret;

  // Run one CLI verb with fresh capture buffers; returns { code, out, err }.
  async function cli(...args) {
    const out = [];
    const err = [];
    const code = await runClientCommand(args, {
      makeClient: () => new PosthornClient({ baseUrl, apiKey }),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  // health
  let r = await cli("health");
  check("cli health → exit 0 + a string status", r.code === 0 && typeof JSON.parse(r.out).status === "string");

  // create-endpoint (public URL; we delete it before sending so nothing is delivered)
  r = await cli("create-endpoint", "https://example.com/webhook", "user.created");
  const created = JSON.parse(r.out);
  check("cli create-endpoint → exit 0 + once-shown signing secret",
    r.code === 0 && typeof created.secret === "string" && created.url === "https://example.com/webhook");
  const epId = created.id;

  // list-endpoints contains it
  r = await cli("list-endpoints");
  const eps = JSON.parse(r.out);
  check("cli list-endpoints → the new endpoint is present",
    r.code === 0 && Array.isArray(eps) && eps.some((e) => e.id === epId));

  // get-endpoint
  r = await cli("get-endpoint", epId);
  check("cli get-endpoint → exit 0 + matching id", r.code === 0 && JSON.parse(r.out).id === epId);

  // delete-endpoint (confirmation, not JSON)
  r = await cli("delete-endpoint", epId);
  check("cli delete-endpoint → exit 0 + confirmation line",
    r.code === 0 && r.out === `Deleted endpoint ${epId}`);

  // get-endpoint on the deleted id → 404 mapped to exit 1 + an API-error line
  r = await cli("get-endpoint", epId);
  check("cli get-endpoint(deleted) → exit 1 + 'API error 404' on stderr",
    r.code === 1 && /API error 404 \(/.test(r.err));

  // send (zero matching endpoints now → no external delivery)
  r = await cli("send", "user.created", '{"hello":true}');
  const sent = JSON.parse(r.out);
  check("cli send → exit 0 + an accepted message ref",
    r.code === 0 && sent.message && sent.message.eventType === "user.created");

  // list-messages shows the sent message
  r = await cli("list-messages");
  const page = JSON.parse(r.out);
  check("cli list-messages → at least the one message we sent",
    r.code === 0 && Array.isArray(page.data) && page.data.length >= 1);

  // usage reads back
  r = await cli("usage");
  check("cli usage → exit 0 + a JSON object", r.code === 0 && typeof JSON.parse(r.out) === "object");

  // a bad-args path stays local (no client call) and exits 1
  r = await cli("send", "user.created");
  check("cli send (missing payload) → exit 1 + usage on stderr",
    r.code === 1 && r.err.includes("requires a <jsonPayload>"));
} finally {
  await gw.stop();
}

console.log(`\nCLIENT_CLI_SMOKE_PASS ${passed}/${passed}`);
