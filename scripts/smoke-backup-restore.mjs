// Compiled-dist smoke: `posthorn admin backup` / `restore`, end-to-end through the
// production build against a real FILE-backed gateway.
//
// It boots a real gateway on a temp on-disk data dir (not :memory:), writes tenant state
// through the HTTP API (signup → key; createEndpoint; sendMessage of an *unrouted* event
// type so the message is persisted but matches no endpoint and is never delivered to the
// public internet), then drives the COMPILED runBackupCommand (dist/runtime/backup.js):
//   1. backup  → exit 0, manifest.json + the store snapshots written.
//   2. restore → exit 0 into a fresh, empty dir.
//   3. a NEW gateway booted on the restored dir serves the same data: the same API key
//      still authenticates, the endpoint is listed + fetchable, and the message survived.
// Hits 127.0.0.1 (the IPv4 bind), matching the other dist smokes. Uses a throwaway
// os.tmpdir() workspace that is always cleaned up.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../dist/runtime/config.js";
import { createGateway } from "../dist/runtime/gateway.js";
import { runBackupCommand } from "../dist/runtime/backup.js";
import { PosthornClient } from "../dist/sdk/client.js";

let passed = 0;
function check(label, cond) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
  passed++;
}

const workspace = mkdtempSync(join(tmpdir(), "posthorn-backup-smoke-"));
const dataDir = join(workspace, "data");
const backupDir = join(workspace, "backup");
const restoredDir = join(workspace, "restored");

function bootEnv(dir) {
  return loadConfig({
    POSTHORN_HOST: "127.0.0.1",
    POSTHORN_PORT: "0",
    POSTHORN_DATA_DIR: dir,
    POSTHORN_SIGNUP_ENABLED: "true",
    POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
    POSTHORN_LOG_LEVEL: "silent",
  });
}

function makeSink() {
  const lines = [];
  return { sink: (l) => lines.push(l), text: () => lines.join("\n") };
}

try {
  // ── Gateway #1: write real tenant state to a file-backed data dir ──────────────
  const gw1 = createGateway(bootEnv(dataDir));
  const { port: port1 } = await gw1.start();
  const base1 = `http://127.0.0.1:${port1}`;
  let apiKey;
  let endpointId;
  let messageId;
  try {
    const signup = await fetch(`${base1}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Backup Smoke" }),
    });
    const minted = await signup.json();
    check("signup minted an API key", signup.status === 201 && typeof minted.secret === "string");
    apiKey = minted.secret;

    const client1 = new PosthornClient({ baseUrl: base1, apiKey });
    const ep = await client1.createEndpoint({
      url: "https://example.com/webhook",
      eventTypes: ["kept.event"],
    });
    endpointId = ep.id;
    check("created an endpoint", typeof ep.id === "string" && ep.url === "https://example.com/webhook");

    // Event type matches no endpoint → message is persisted but fans out to nothing, so
    // the worker never makes an outbound request (zero public-internet egress).
    const sent = await client1.sendMessage({ eventType: "unrouted.smoke", payload: { hello: true } });
    messageId = sent.message.id;
    check("accepted a message (unrouted → no delivery)", typeof messageId === "string");
  } finally {
    await gw1.stop();
  }

  // ── Back up the (now-closed) data dir via the compiled command core ────────────
  const bout = makeSink();
  const berr = makeSink();
  const backupCode = await runBackupCommand(["backup", backupDir], {
    dataDir,
    version: "smoke",
    out: bout.sink,
    err: berr.sink,
  });
  check("backup → exit 0", backupCode === 0 && berr.text() === "");
  check(
    "backup wrote manifest.json + apps/endpoints/messages snapshots",
    existsSync(join(backupDir, "manifest.json")) &&
      existsSync(join(backupDir, "apps.db")) &&
      existsSync(join(backupDir, "endpoints.db")) &&
      existsSync(join(backupDir, "messages.db")),
  );

  // ── Restore into a fresh, empty dir (no --force needed; nothing to overwrite) ──
  const rout = makeSink();
  const rerr = makeSink();
  const restoreCode = await runBackupCommand(["restore", backupDir], {
    dataDir: restoredDir,
    version: "smoke",
    out: rout.sink,
    err: rerr.sink,
  });
  check("restore → exit 0 into a fresh dir", restoreCode === 0 && rerr.text() === "");

  // ── Gateway #2 on the restored dir serves the same data ────────────────────────
  const gw2 = createGateway(bootEnv(restoredDir));
  const { port: port2 } = await gw2.start();
  const base2 = `http://127.0.0.1:${port2}`;
  try {
    // Reuse the SAME key minted before the backup — proves apps.db restored intact.
    const client2 = new PosthornClient({ baseUrl: base2, apiKey });
    const eps = await client2.listEndpoints();
    check(
      "restored: same API key authenticates + endpoint present",
      Array.isArray(eps) && eps.some((e) => e.id === endpointId && e.url === "https://example.com/webhook"),
    );
    const got = await client2.getEndpoint(endpointId);
    check("restored: getEndpoint returns it intact", got.id === endpointId);
    const page = await client2.listMessages();
    check(
      "restored: the persisted message survived",
      Array.isArray(page.data) && page.data.some((m) => m.id === messageId),
    );
  } finally {
    await gw2.stop();
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\nBACKUP_RESTORE_SMOKE_PASS ${passed}/${passed}`);
